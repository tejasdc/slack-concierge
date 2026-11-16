import {spawn} from 'node:child_process';
import {thinkeringRequest} from './thinkering-capability-target';
import {awaitingOutside} from './storage-observation';

/**
 * Concierge's half of the requirement record (Tejas, 2026-11-16, [decision:
 * every-feature-requirement-is-recorded-and-verified]): "The agent who is shipping it has to go
 * back, look through the requirements, verify that all of them actually were delivered, and only
 * then close it or say the task is done." thnkr.ing owns the record (requirement-records design in
 * its docs/architecture); this module reads and writes it over the same capability route the to-dos
 * use (a local socket on the server, ssh remote-box from the Mac), shows a request's builder the
 * record verbatim, and decides whether a completed reply may be accepted. It decides nothing about
 * what counts as delivered: thnkr.ing's `closable` is the one verdict, so there is no second copy
 * of the rule here to drift.
 */
export type RecordCatalogue={
  id:string;title:string;link?:string|null;path?:string|null;closable:boolean;
  counts:{open:number;delivered:number;'not-delivered':number;withdrawn:number};
  unreconciled:string[];
  sources:{id:string;source?:string;sourceAt?:string|null;filedBy?:string|null;reconciled?:unknown;text?:string}[];
  items:{id:string;words:string;state:string;source?:string|null;sourceAt?:string|null;checked?:string|null;why?:string|null}[];
};
export type RequirementState={available:true;records:RecordCatalogue[]}|{available:false;reason:string};

const SOCKET=process.env.THINKERING_SESSION_CAPABILITY_SOCKET||'/run/thinkering/session-capabilities.sock';
const CALL_MS=10_000,MAC_MS=15_000,LIMIT=16_777_216;
const SAFE_HEADER=/^[A-Za-z0-9:_.-]+$/;

export type AgentIdentity={inputId:string;runId:string}|null;
export type RequirementAnswer={status:number;body:any};

function agentHeader(agent:AgentIdentity):Record<string,string>{
  if(!agent||!SAFE_HEADER.test(agent.inputId)||!SAFE_HEADER.test(agent.runId))return {};
  return {'x-concierge-agent-source':`${agent.inputId} ${agent.runId}`};
}
function parse(text:string,status:number):RequirementAnswer{
  try{return {status,body:text.trim()?JSON.parse(text):{}};}catch{return {status,body:{error:{code:'BAD_ANSWER',message:`thnkr.ing answered with something that is not JSON (HTTP ${status}).`}}};}
}
function overSocket(method:'GET'|'POST',path:string,body:unknown,agent:AgentIdentity):Promise<RequirementAnswer>{
  return new Promise((resolve,reject)=>{
    const payload=body===undefined?null:Buffer.from(JSON.stringify(body));
    const request=thinkeringRequest(path,{method,timeout:CALL_MS,headers:{...agentHeader(agent),...(payload?{'content-type':'application/json','content-length':String(payload.length)}:{})}},response=>{
      const chunks:Buffer[]=[];let size=0;
      response.on('data',chunk=>{const part=Buffer.from(chunk as Uint8Array);size+=part.length;if(size>LIMIT)response.destroy(new Error('too large'));else chunks.push(part);});
      response.once('error',reject);
      response.once('end',()=>resolve(parse(Buffer.concat(chunks).toString('utf8'),response.statusCode??0)));
    });
    request.once('timeout',()=>request.destroy(new Error('timeout')));
    request.once('error',reject);
    if(payload)request.write(payload);
    request.end();
  });
}
function overSsh(method:'GET'|'POST',path:string,body:unknown,agent:AgentIdentity):Promise<RequirementAnswer>{
  return new Promise((resolve,reject)=>{
    const headers=Object.entries({...agentHeader(agent),...(body!==undefined?{'content-type':'application/json'}:{})}).map(([k,v])=>`-H '${k}: ${v}'`).join(' ');
    const command=`curl -s --max-time 12 -w '\\n%{http_code}' --unix-socket ${SOCKET} -X ${method} ${headers} ${body!==undefined?'--data-binary @- ':''}'http://x${path}'`;
    const child=spawn('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=4','remote-box',command],{stdio:['pipe','pipe','ignore']});
    const chunks:Buffer[]=[];let size=0;
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('timeout'));},MAC_MS);
    child.stdout.on('data',chunk=>{const part=Buffer.from(chunk as Uint8Array);size+=part.length;if(size<=LIMIT)chunks.push(part);});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',code=>{
      clearTimeout(timer);
      if(code!==0)return reject(new Error(`exit ${code}`));
      const text=Buffer.concat(chunks).toString('utf8'),cut=text.lastIndexOf('\n');
      resolve(parse(text.slice(0,cut<0?0:cut),Number(text.slice(cut+1))||0));
    });
    if(body!==undefined)child.stdin.end(JSON.stringify(body));else child.stdin.end();
  });
}

/** One call to thnkr.ing's requirement routes; throws only when thnkr.ing cannot be reached. */
export async function requirementCall(method:'GET'|'POST',path:string,body?:unknown,agent:AgentIdentity=null):Promise<RequirementAnswer>{
  // thnkr.ing answers in its own process: waiting on it is outside time, never owner time.
  return awaitingOutside(()=>process.platform==='darwin'?overSsh(method,path,body,agent):overSocket(method,path,body,agent));
}

function errorWords(answer:RequirementAnswer):string{
  const error=answer.body?.error;
  return typeof error?.message==='string'?error.message:`thnkr.ing refused with HTTP ${answer.status}.`;
}

/** One record read now by id or name; throws with thnkr.ing's own instruction when it cannot be read. */
export async function readRecord(idOrName:string):Promise<RecordCatalogue>{
  const answer=await requirementCall('GET',`/requirements/${encodeURIComponent(idOrName)}`);
  if(answer.status!==200||typeof answer.body?.id!=='string')throw new Error(`Requirement record "${idOrName}": ${errorWords(answer)}`);
  return answer.body as RecordCatalogue;
}

/** Every record tied to an Inbox thread, read now. */
export async function readTopicRecords(topic:string):Promise<RecordCatalogue[]>{
  const answer=await requirementCall('GET',`/requirements?topic=${encodeURIComponent(topic)}`);
  // A thnkr.ing that has not installed the requirement routes answers with the web framework's own
  // "Route not found" (its error is a string); its real refusals are {error:{code,message}}. No route
  // means no records exist for this thread, so work is not blocked on a feature that is not there:
  // the 2026-11-16 release refused every completed reply on any thread request until thnkr.ing shipped.
  if(answer.status===404&&typeof answer.body?.error==='string')return [];
  if(answer.status!==200||!Array.isArray(answer.body?.records))throw new Error(`Requirement records for thread ${topic}: ${errorWords(answer)}`);
  return answer.body.records as RecordCatalogue[];
}

/** The records a request carries: the ones it names plus every record of its Inbox thread, deduplicated, read fresh. */
export async function readRequestRecords(ids:string[],topic:string|null):Promise<RecordCatalogue[]>{
  const found=new Map<string,RecordCatalogue>();
  for(const id of ids){const record=await readRecord(id);found.set(record.id,record);}
  if(topic)for(const record of await readTopicRecords(topic))if(!found.has(record.id))found.set(record.id,record);
  return [...found.values()];
}

/** Reads a request's records for the reply check: thnkr.ing being unreachable is a state, never a pass. */
export async function readRequirementState(ids:string[],topic:string|null):Promise<RequirementState|null>{
  if(!ids.length&&!topic)return null;
  try{
    const records=await readRequestRecords(ids,topic);
    return records.length?{available:true,records}:null;
  }catch(error){return {available:false,reason:error instanceof Error?error.message:'thnkr.ing could not be read'};}
}

const first=(words:string)=>{const one=words.replace(/\s+/g,' ').trim();return one.length>90?`${one.slice(0,90)}…`:one;};
const linkOf=(record:RecordCatalogue)=>record.link||record.path||record.id;

/** What the builder reads at delivery: the record itself, verbatim, and what closing it takes. */
export function deliveryBlock(records:RecordCatalogue[]):string{
  const lines=['REQUIREMENT RECORDS this work carries. These are Tejas\'s own words for this feature, read from thnkr.ing now; build to them, not to a summary. Your own checks do not close this work: the record does.'];
  for(const record of records){
    lines.push('',`Record "${record.title}" (${record.id}) · ${linkOf(record)}`);
    if(record.items.length){
      lines.push('Requirements, verbatim:');
      for(const item of record.items)lines.push(`- ${item.id} [${item.state}]${item.source?` (source ${item.source})`:''}: ${item.words}`);
    }else lines.push('No requirement is filed on this record yet.');
    if(record.sources.length){
      lines.push('Kept captures (his whole words):');
      for(const source of record.sources)lines.push(`- ${source.id}${source.sourceAt?` · ${source.sourceAt}`:''}${source.reconciled?' · reconciled':' · NOT yet reconciled'} — print it whole: router-actions.sh requirements show ${record.id} --source ${source.id}`);
    }
  }
  lines.push('',
    'Before you reply completed:',
    '1. Read every kept capture in full (the print command beside it). File any requirement the record is missing as his exact words: router-actions.sh requirements file <record> --source <capture id> --words "<his exact words>". Then reconcile it: router-actions.sh requirements reconcile --source <kept source id>. A capture must be reconciled by a session other than the one that kept it: ask another session to read it if you kept it.',
    '2. Judge every requirement against the real system: router-actions.sh requirements judge --item <id> --state delivered --checked "<what you ran on the real system and saw>" (or --state not-delivered --why "<what is missing>", which means the work is not done).',
    '3. Your completed reply is refused until every record is closable (nothing open or not-delivered, every kept capture reconciled). Failed, needs_decision and partial replies are never refused.');
  return lines.join('\n');
}

/** The refusal a completed reply gets, or null when every record is closable. */
export function closingRefusal(state:RequirementState):string|null{
  if(!state.available)
    return `This request carries requirement records and thnkr.ing cannot be read, so the work cannot be closed as completed (${state.reason}). Nothing was recorded. Retry when thnkr.ing answers, or reply failed or needs_decision if it stays unreachable.`;
  const parts:string[]=[];
  for(const record of state.records){
    if(record.closable)continue;
    const part:string[]=[`Requirement record "${record.title}" (${record.id}) is not closable: ${linkOf(record)}`];
    const open=record.items.filter(item=>item.state==='open'),notDelivered=record.items.filter(item=>item.state==='not-delivered');
    if(open.length)part.push(`Open, not yet judged (judge each against the real system): ${open.map(item=>`${item.id} "${first(item.words)}"`).join('; ')}. Command: router-actions.sh requirements judge --item <id> --state delivered --checked "<what you ran on the real system and saw>".`);
    if(notDelivered.length)part.push(`Not delivered: ${notDelivered.map(item=>`${item.id} "${first(item.words)}"${item.why?` (${item.why})`:''}`).join('; ')}. Not delivered means the work is not done: deliver it and judge it delivered, or reply failed or needs_decision.`);
    if(record.unreconciled.length)part.push(`Kept captures not reconciled by a second reader: ${record.unreconciled.join(', ')}. Read each whole (router-actions.sh requirements show ${record.id} --source <id>), file anything the record is missing, then router-actions.sh requirements reconcile --source <id>; a different session than the one that kept it must reconcile.`);
    if(part.length===1)part.push('thnkr.ing reports it not closable without naming why; read it with router-actions.sh requirements show '+record.id+'.');
    parts.push(part.join('\n'));
  }
  return parts.length?`Not closed: ${parts.length===1?'a requirement record':'requirement records'} on this work still need${parts.length===1?'s':''} attention. Nothing was recorded.\n\n${parts.join('\n\n')}`:null;
}

/** One line per record on an accepted completed reply, for his thread. */
export function outcomeLines(state:RequirementState):string{
  if(!state.available)return '';
  return state.records.map(record=>`Requirements: ${record.counts.delivered} delivered, ${record.counts.withdrawn} withdrawn · ${linkOf(record)}`).join('\n');
}
