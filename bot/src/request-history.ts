import {readFile,stat} from 'node:fs/promises';
import {db} from './state';
import {log} from './log';
import {meaningIndex} from './meaning-index';

/**
 * What came before: the earlier work on the problem a work request is about, put into the request
 * by Concierge so no agent starts a repair blind. Tejas, 2026-11-04, after his saving and sync
 * failures went to about twenty separate sessions from September to November, each starting from
 * zero: "If there's a bug, if there's a regression, isn't your first job to see what was done
 * before? What came before you? Why do these agents have zero situational awareness?"
 *
 * Three records answer it, best first:
 * - the earlier requests in the same Inbox thread (exact: the same problem by construction),
 *   with what each agent said, what it checked and how each ended;
 * - the earlier sessions closest in meaning to the request, from the same session search agents
 *   use, each with its last request and how it ended;
 * - thnkr.ing's agent failure ledger, the record of failures already diagnosed and repaired.
 * Each earlier session says whether and how it can be asked now. The lookup is bounded so a
 * request is never held up by it: the thread history is a ledger read, and the searches that do
 * not answer in time are named as not consulted instead of being waited on.
 */
export type SessionSearch=(body:{query:string;limit:number})=>Promise<{results?:any[]}>;
/** How an earlier session can be asked now, in the words the receiving agent acts on. */
export type Answerability=(sessionId:number)=>string;
export type EarlierWork={text:string;requests:number;sessions:number;cases:number;omissions:string[]};

const SEARCH_WAIT_MS=2_500;
const MIN_MEANING=0.55;
const MAX_REQUESTS=8,MAX_SESSIONS=6,MAX_CASES=3;
const CLAIM_CHARS=360;
export const FAILURE_LEDGER=process.env.CONCIERGE_FAILURE_LEDGER||'/root/workspace/thinkering/docs/retrospectives/agent-failure-ledger.md';

const oneLine=(text:unknown,max:number)=>{
  const words=String(text??'').replace(/\s+/g,' ').trim();
  return words.length>max?`${words.slice(0,max).replace(/\s+\S*$/,'')}…`:words;
};
const day=(ms:number)=>new Date(ms).toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'America/New_York'});
const within=<T>(promise:Promise<T>,ms:number):Promise<T|'late'>=>
  Promise.race([promise,new Promise<'late'>(resolve=>setTimeout(()=>resolve('late'),ms).unref?.())]);

type RequestRow={request_id:string;target_session_id:number;source_session_id:number;status:string;outcome:string|null;payload_json:string;result_json:string|null;created_at_ms:number};

/** One earlier request: who had it, what was asked, what that agent said, what it checked, how it ended. */
function requestLine(row:RequestRow,titleOf:(id:number)=>string,answerability:Answerability) {
  const asked=JSON.parse(row.payload_json);
  const result=row.result_json?JSON.parse(row.result_json):null;
  const ended=!row.outcome?`still open (${row.status})`:row.outcome;
  // A reply's own words, without the checked line folded into them; a service settlement has only its text.
  const claim=result?oneLine(result.replyBody??result.text,CLAIM_CHARS):'';
  const closing=result?.closingLine??'';
  return `- ${day(row.created_at_ms)}, request ${row.request_id} to “${titleOf(row.target_session_id)}” (${answerability(row.target_session_id)}): `
    +`asked “${oneLine(asked.summary??asked.text,160)}” → ${ended}.${claim?` It said: “${claim}”`:''}${closing?` ${oneLine(closing,200)}`:''}`;
}

/** The latest requests the earlier session itself was given, so its line says what it was asked to fix and how that ended. */
function sessionRequests(sessionId:number,beforeMs:number) {
  return db.query(`SELECT request_id,target_session_id,source_session_id,status,outcome,payload_json,result_json,created_at_ms
    FROM session_communication_requests WHERE target_session_id=? AND created_at_ms<? ORDER BY created_at_ms DESC LIMIT 2`).all(sessionId,beforeMs) as RequestRow[];
}

type FailureCase={id:string;date:string;text:string};
let ledgerCache:{mtime:number;cases:FailureCase[]}|null=null;
/** The failure ledger's cases: heading and opening words, re-read only when the file changes. */
async function failureCases():Promise<FailureCase[]> {
  const mtime=(await stat(FAILURE_LEDGER).catch(()=>null))?.mtimeMs;
  if(mtime===undefined)return [];
  if(ledgerCache?.mtime===mtime)return ledgerCache.cases;
  const body=await readFile(FAILURE_LEDGER,'utf8');
  const cases:FailureCase[]=[];
  for(const section of body.split(/^### Failure-case: /m).slice(1)){
    const heading=/^(\S+)\s*\(([^)]*)\)/.exec(section);
    if(!heading)continue;
    cases.push({id:heading[1]!,date:heading[2]!,text:oneLine(section.slice(heading[0].length).replace(/\*\*/g,''),700)});
  }
  ledgerCache={mtime,cases};
  return cases;
}

async function closestCases(query:string):Promise<{found:FailureCase[];omission:string|null}> {
  const index=meaningIndex();
  if(!index?.installed)return {found:[],omission:'The failure ledger was not compared: the meaning index is not installed on this machine.'};
  const cases=await failureCases();
  if(!cases.length)return {found:[],omission:`The failure ledger was not found at ${FAILURE_LEDGER}.`};
  const [vector]=await index.queryVectors([query]);
  const vectors=await index.documentVectors(cases.map(item=>({key:`failure-case:${item.id}`,text:`${item.id}. ${item.text}`})));
  const dot=(a:Float32Array,b:Float32Array)=>{let sum=0;for(let i=0;i<a.length;i++)sum+=a[i]!*b[i]!;return sum;};
  const scored=cases.map(item=>({item,score:vectors.get(`failure-case:${item.id}`)?dot(vector!,vectors.get(`failure-case:${item.id}`)!):0}));
  return {found:scored.filter(entry=>entry.score>=MIN_MEANING).sort((a,b)=>b.score-a.score).slice(0,MAX_CASES).map(entry=>entry.item),omission:null};
}

export async function earlierWorkFor(input:{
  /** The request's one-line summary and words: what the problem is. */
  summary?:string;text:string;
  /** The Inbox thread the request belongs to, when it has one. */
  topicRoot:string|null;
  /** Sessions that are not earlier work: the asker, the recipient, the Inbox router. */
  exclude:number[];
  nowMs:number;
  search:SessionSearch|null;
  titleOf:(sessionId:number)=>string;
  answerability:Answerability;
}):Promise<EarlierWork> {
  const omissions:string[]=[];
  const excluded=new Set(input.exclude);
  const thread=input.topicRoot?db.query(`SELECT request_id,target_session_id,source_session_id,status,outcome,payload_json,result_json,created_at_ms
    FROM session_communication_requests WHERE coalesce(nullif(topic_root_input_id,''),thread_root_input_id)=? AND created_at_ms<?
    ORDER BY created_at_ms DESC LIMIT ?`).all(input.topicRoot,input.nowMs,MAX_REQUESTS) as RequestRow[]:[];
  const inThread=new Set(thread.map(row=>row.target_session_id));
  const query=oneLine(`${input.summary??''} ${input.text}`,600);
  const started=performance.now();
  const sessionsLookup=input.search?within(input.search({query,limit:20}),SEARCH_WAIT_MS):Promise.resolve(null);
  const casesLookup=within(closestCases(query),SEARCH_WAIT_MS);
  const [searched,cases]=await Promise.all([sessionsLookup.catch(error=>{omissions.push(`Session search failed: ${error instanceof Error?error.message:String(error)}.`);return null;}),
    casesLookup.catch(error=>{omissions.push(`The failure ledger could not be compared: ${error instanceof Error?error.message:String(error)}.`);return null;})]);
  if(searched==='late')omissions.push(`Session search did not answer within ${SEARCH_WAIT_MS/1000} s; search yourself with router-actions.sh sessions search.`);
  if(cases==='late')omissions.push(`The failure ledger comparison did not finish within ${SEARCH_WAIT_MS/1000} s; read ${FAILURE_LEDGER} yourself.`);
  else if(cases?.omission)omissions.push(cases.omission);
  const related:{id:number;title:string;at:number|null}[]=[];
  for(const result of searched&&searched!=='late'?searched.results??[]:[]){
    const view=result.session,local=/^concierge:(\d+)$/.exec(String(view?.id??''));
    if(!local||Number(result.match?.meaning)<MIN_MEANING)continue;
    const id=Number(local[1]);
    const created=Date.parse(view.createdAt??'')||null;
    if(excluded.has(id)||inThread.has(id)||(created!==null&&created>=input.nowMs)||related.some(entry=>entry.id===id))continue;
    related.push({id,title:oneLine(String(view.title??'').replace(/<[^>]*>/g,''),90)||'A session',at:created});
    if(related.length>=MAX_SESSIONS)break;
  }
  const failures=cases&&cases!=='late'?cases.found:[];
  log('info','request_history_looked_up',{elapsed_ms:Math.round(performance.now()-started),thread_requests:thread.length,sessions:related.length,cases:failures.length,omissions:omissions.length});
  if(!thread.length&&!related.length&&!failures.length)
    return {text:omissions.length?`What came before: Concierge found no earlier work on this problem. ${omissions.join(' ')}`:'',requests:0,sessions:0,cases:0,omissions};
  const parts=['WHAT CAME BEFORE, found by Concierge from the request ledger, session search and thnkr.ing\'s failure ledger. '
    +'Start from this: read what each earlier agent claimed and checked, ask the ones that can answer (router-actions.sh sessions ask <address> --requested-effect informational), '
    +'and do not repeat a fix that already failed. Your first reply to this request must say what came before and how your approach differs, with --before "<that>".'];
  if(thread.length)parts.push(`Earlier requests in this Inbox thread, newest first:\n${thread.map(row=>requestLine(row,input.titleOf,input.answerability)).join('\n')}`);
  if(related.length)parts.push(`Earlier sessions closest to this problem:\n${related.map(entry=>{
    const last=sessionRequests(entry.id,input.nowMs)[0];
    return `- ${entry.at?`${day(entry.at)}, `:''}“${entry.title}” (${input.answerability(entry.id)})${last?`. Its latest request: ${requestLine(last,input.titleOf,input.answerability).slice(2)}`:''}`;
  }).join('\n')}`);
  if(failures.length)parts.push(`Diagnosed failures in thnkr.ing's failure ledger (${FAILURE_LEDGER}):\n${failures.map(item=>`- ${item.id} (${item.date}): ${oneLine(item.text,300)}`).join('\n')}`);
  if(omissions.length)parts.push(`Not consulted: ${omissions.join(' ')}`);
  return {text:parts.join('\n\n'),requests:thread.length,sessions:related.length,cases:failures.length,omissions};
}
