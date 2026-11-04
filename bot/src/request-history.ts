import {readFile,stat} from 'node:fs/promises';
import {db} from './state';
import {log} from './log';
import {meaningIndex,type MeaningIndex} from './meaning-index';

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
 * - the earlier sessions closest in meaning to the request, from the owner's meaning index (the
 *   index session search uses, read directly so a request never retains archive sources or runs a
 *   word search), each with its latest request and how it ended;
 * - thnkr.ing's agent failure ledger, the record of failures already diagnosed and repaired.
 * Each earlier session says whether and how it can be asked now. The lookup never fails a request
 * and never holds it long: the thread history is an indexed ledger read, the meaning comparisons
 * that do not answer in time are named as not consulted, and any error becomes an omission line.
 */
/** How an earlier session can be asked now, in the words a receiving agent acts on. */
export type Answerability=(sessionId:number)=>string;
export type EarlierWork={text:string;requests:number;sessions:number;cases:number;omissions:string[]};

/**
 * One question embedding, at search priority, serves both comparisons. Measured on the server
 * 2026-11-04: the meaning search's embedding takes 1.3 s at the median and 4.5-7 s while the index
 * catches up after a restart; 1.5 s and then 4 s bounds missed the live tests. Ten seconds is
 * unnoticeable beside an agent run of minutes, and a later answer is named as not consulted.
 */
const MEANING_WAIT_MS=10_000;
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
const parsed=(json:string|null)=>{if(!json)return null;try{return JSON.parse(json);}catch{return null;}};

type RequestRow={request_id:string;target_session_id:number;source_turn_id:number|null;status:string;outcome:string|null;payload_json:string;result_json:string|null;created_at_ms:number};
const COLUMNS='request_id,target_session_id,source_turn_id,status,outcome,payload_json,result_json,created_at_ms';

/** One earlier request: who had it, what was asked, what that agent said, what it checked, how it ended. */
function requestLine(row:RequestRow,titleOf:(id:number)=>string,answerability:Answerability) {
  const asked=parsed(row.payload_json)??{};
  const result=parsed(row.result_json);
  const ended=row.outcome??`still open (${row.status})`;
  // A reply's own words, without the checked line folded into them; a service settlement has only its text.
  const claim=result?oneLine(result.replyBody??result.text,CLAIM_CHARS):'';
  const closing=result?.closingLine?oneLine(result.closingLine,200):'';
  return `${day(row.created_at_ms)}, request ${row.request_id} to “${titleOf(row.target_session_id)}” (${answerability(row.target_session_id)}): `
    +`asked “${oneLine(asked.summary??asked.text,160)}” → ${ended}.${claim?` It said: “${claim}”`:''}${closing?` ${closing}`:''}`;
}

/**
 * Earlier requests in this Inbox thread, newest first: the thread's own requests and the work
 * started from its messages, each read through its index. The recipient's own requests are left
 * out (it already has them), and so are requests sent in the same turn as this one, which are its
 * siblings in a fan-out, not earlier work.
 */
function threadRequests(topicRoot:string,beforeMs:number,recipient:number|null,sameTurn:number|null):RequestRow[] {
  const rows=[
    ...db.query(`SELECT ${COLUMNS} FROM session_communication_requests WHERE thread_root_input_id=? AND created_at_ms<? ORDER BY created_at_ms DESC LIMIT 40`).all(topicRoot,beforeMs),
    ...db.query(`SELECT ${COLUMNS} FROM session_communication_requests WHERE topic_root_input_id=? AND thread_root_input_id IS NULL AND created_at_ms<? ORDER BY created_at_ms DESC LIMIT 40`).all(topicRoot,beforeMs),
  ] as RequestRow[];
  return rows.filter(row=>row.target_session_id!==recipient&&(sameTurn===null||row.source_turn_id!==sameTurn))
    .sort((a,b)=>b.created_at_ms-a.created_at_ms).slice(0,MAX_REQUESTS);
}

/** Earlier sessions close in meaning, from the index alone: imported transcripts count only when Concierge already holds them. */
function closestSessions(index:MeaningIndex,vector:Float32Array):{found:{id:number;score:number}[];omission:string|null} {
  const answer=index.searchVector(vector,30);
  if(!answer.available)return {found:[],omission:`Earlier sessions were not compared: ${answer.reason??'the meaning index is unavailable'}.`};
  const best=new Map<number,number>();
  const keep=(id:number,score:number)=>{if((best.get(id)??0)<score)best.set(id,score);};
  const strong=answer.hits.filter(hit=>hit.score>=MIN_MEANING);
  for(const hit of strong)if(hit.target.kind==='session')keep(hit.target.sessionId,hit.score);
  // Imported transcripts Concierge already holds, found in one read rather than one scan per match.
  const sources=[...new Set(strong.flatMap(hit=>hit.target.kind==='archive'?[hit.target.sourceId]:[]))].slice(0,30);
  if(sources.length){
    const rows=db.query(`SELECT id,json_extract(native_metadata_json,'$.source.id') AS source FROM sessions
      WHERE json_extract(native_metadata_json,'$.origin')='imported' AND json_extract(native_metadata_json,'$.source.id') IN (${sources.map(()=>'?').join(',')})`).all(...sources) as {id:number;source:string}[];
    const bySource=new Map(rows.map(row=>[row.source,row.id]));
    for(const hit of strong)if(hit.target.kind==='archive'){const id=bySource.get(hit.target.sourceId);if(id!==undefined)keep(id,hit.score);}
  }
  return {found:[...best.entries()].map(([id,score])=>({id,score})).sort((a,b)=>b.score-a.score),omission:null};
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

async function closestCases(index:MeaningIndex,vector:Float32Array):Promise<{found:FailureCase[];omission:string|null}> {
  const cases=await failureCases();
  if(!cases.length)return {found:[],omission:`The failure ledger was not found at ${FAILURE_LEDGER}.`};
  const vectors=await index.documentVectors(cases.map(item=>({key:`failure-case:${item.id}`,text:`${item.id}. ${item.text}`})));
  const dot=(a:Float32Array,b:Float32Array)=>{let sum=0;for(let i=0;i<a.length;i++)sum+=a[i]!*b[i]!;return sum;};
  const scored=cases.map(item=>{const other=vectors.get(`failure-case:${item.id}`);return {item,score:other?dot(vector!,other):0};});
  return {found:scored.filter(entry=>entry.score>=MIN_MEANING).sort((a,b)=>b.score-a.score).slice(0,MAX_CASES).map(entry=>entry.item),omission:null};
}

export async function earlierWorkFor(input:{
  /** The request's one-line summary and words: what the problem is. */
  summary?:string;text:string;
  /** The Inbox thread the request belongs to, when it has one. */
  topicRoot:string|null;
  /** The recipient, when it already exists; its own work is not "before" for it. */
  recipient:number|null;
  /** The turn sending this request; requests it sent alongside are siblings, not history. */
  sendingTurn:number|null;
  /** Sessions that are not earlier work: the asker, the recipient, the Inbox router. */
  exclude:number[];
  nowMs:number;
  titleOf:(sessionId:number)=>string;
  answerability:Answerability;
}):Promise<EarlierWork> {
  const started=performance.now();
  try {
    return await lookUp(input);
  } catch(error) {
    const reason=error instanceof Error?error.message:String(error);
    log('warn','request_history_failed',{elapsed_ms:Math.round(performance.now()-started),error:reason});
    return {text:`What came before: Concierge's lookup of earlier work failed (${oneLine(reason,200)}); search for it yourself with router-actions.sh sessions search.`,requests:0,sessions:0,cases:0,omissions:[reason]};
  }
}

async function lookUp(input:Parameters<typeof earlierWorkFor>[0]):Promise<EarlierWork> {
  const started=performance.now();
  const omissions:string[]=[];
  const excluded=new Set(input.exclude);
  // Sessions the sender gave work to in this same turn are its siblings, not earlier work: in the
  // 2026-11-04 live test the sender's own earlier test sessions were two of the six "earlier" ones.
  if(input.sendingTurn!==null)for(const row of db.query('SELECT DISTINCT target_session_id AS id FROM session_communication_requests WHERE source_turn_id=?').all(input.sendingTurn) as {id:number}[])excluded.add(row.id);
  const thread=input.topicRoot?threadRequests(input.topicRoot,input.nowMs,input.recipient,input.sendingTurn):[];
  const inThread=new Set(thread.map(row=>row.target_session_id));
  const query=oneLine(`${input.summary??''} ${input.text}`,600);
  type Compared={sessions:ReturnType<typeof closestSessions>;cases:Awaited<ReturnType<typeof closestCases>>};
  const compare=async():Promise<Compared|null>=>{
    const index=meaningIndex();
    if(!index?.installed){omissions.push('Earlier sessions and the failure ledger were not compared: the meaning index is not installed on this machine.');return null;}
    const vector=await index.questionVector(query);
    // One index for the question and both comparisons, so they always share an embedding model.
    return {sessions:closestSessions(index,vector!),cases:await closestCases(index,vector!)};
  };
  const compared=await within(compare(),MEANING_WAIT_MS).catch(error=>{omissions.push(`Earlier sessions and the failure ledger could not be compared: ${error instanceof Error?error.message:String(error)}.`);return null;});
  if(compared==='late')omissions.push(`Earlier sessions and the failure ledger were not compared within ${MEANING_WAIT_MS/1000} s; search yourself with router-actions.sh sessions search and read ${FAILURE_LEDGER}.`);
  const sessions=compared&&compared!=='late'?compared.sessions:null;
  const cases=compared&&compared!=='late'?compared.cases:null;
  if(sessions?.omission)omissions.push(sessions.omission);
  if(cases?.omission)omissions.push(cases.omission);
  const created=db.query("SELECT CAST(strftime('%s',created_at) AS INTEGER)*1000 AS ms FROM sessions WHERE id=?");
  // Through the recipient index, newest by time; only the chosen row's words are read.
  const times=db.query('SELECT request_id,created_at_ms FROM session_communication_requests WHERE target_session_id=? AND created_at_ms<?');
  const row=db.query(`SELECT ${COLUMNS} FROM session_communication_requests WHERE request_id=?`);
  const related:{id:number;at:number|null;last:RequestRow|null}[]=[];
  for(const {id} of sessions?.found??[]){
    if(excluded.has(id)||inThread.has(id))continue;
    const at=(created.get(id) as {ms:number|null}|null)?.ms??null;
    if(at!==null&&at>=input.nowMs)continue;
    const newest=(times.all(id,input.nowMs) as {request_id:string;created_at_ms:number}[]).sort((a,b)=>b.created_at_ms-a.created_at_ms)[0];
    const last=newest?row.get(newest.request_id) as RequestRow:null;
    related.push({id,at,last});
    if(related.length>=MAX_SESSIONS)break;
  }
  const failures=cases?.found??[];
  log('info','request_history_looked_up',{elapsed_ms:Math.round(performance.now()-started),thread_requests:thread.length,sessions:related.length,cases:failures.length,omissions:omissions.length});
  if(!thread.length&&!related.length&&!failures.length)
    return {text:omissions.length?`What came before: Concierge found no earlier work on this problem. Not consulted: ${omissions.join(' ')}`:'',requests:0,sessions:0,cases:0,omissions};
  const parts=['WHAT CAME BEFORE, found by Concierge from the request ledger, session search and thnkr.ing\'s failure ledger. '
    +'Start from this: read what each earlier agent claimed and checked, ask the ones that can answer (router-actions.sh sessions ask <address> --requested-effect informational), '
    +'and do not repeat a fix that already failed. Your first reply to this request must say what came before and how your approach differs, with --before "<that>".'];
  if(thread.length)parts.push(`Earlier requests in this Inbox thread, newest first:\n${thread.map(row=>`- ${requestLine(row,input.titleOf,input.answerability)}`).join('\n')}`);
  if(related.length)parts.push(`Earlier sessions closest to this problem:\n${related.map(entry=>
    `- ${entry.at?`${day(entry.at)}, `:''}“${input.titleOf(entry.id)}” (${input.answerability(entry.id)})${entry.last?`. Its latest request: ${requestLine(entry.last,input.titleOf,input.answerability)}`:''}`).join('\n')}`);
  if(failures.length)parts.push(`Diagnosed failures in thnkr.ing's failure ledger (${FAILURE_LEDGER}):\n${failures.map(item=>`- ${item.id} (${item.date}): ${oneLine(item.text,300)}`).join('\n')}`);
  if(omissions.length)parts.push(`Not consulted: ${omissions.join(' ')}`);
  return {text:parts.join('\n\n'),requests:thread.length,sessions:related.length,cases:failures.length,omissions};
}
