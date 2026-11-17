import {contentReaderScope,outsideContentReader} from './content-reader-scope';
import {db,getSessionById} from './state';
import {getAcceptedSessionInput,nativeRunId,sessionMetadata,type AcceptedSessionInput} from './session-inputs';
import {parseAgentPrincipalHeader,type AgentPrincipal} from './agent-token-verify';
import {comparisonContext,type ComparisonContext} from './lab-invocation-facts';

type Source={inputId:string;runId:string};
type Authority={agent:boolean;principal?:AgentPrincipal;source?:Source;invalid?:string;expired?:boolean};
type Reader={kind:'trusted'}|{kind:'unknown'}|{kind:'actor';input:AcceptedSessionInput;turn:any;comparison:ComparisonContext|null};
const authority=contentReaderScope as import('node:async_hooks').AsyncLocalStorage<Authority>;
export {outsideContentReader};
export class LabDisclosureError extends Error {
 readonly status=403;constructor(readonly code='LAB_CONTENT_RESTRICTED'){super(code==='AGENT_SOURCE_REQUIRED'?'An exact admitted live source input and run are required for this agent read.':'This content is outside the exact independent Lab response context.');}
}
function sourcePair(value:string|null):Source|undefined {
 if(!value)return undefined;const match=/^(\S+) (\S+)$/.exec(value);if(!match)throw new LabDisclosureError('AGENT_SOURCE_REQUIRED');return {inputId:match[1]!,runId:match[2]!};
}
export function withContentReader<T>(request:Request,work:()=>T):T {
 const principalHeader=request.headers.get('x-concierge-agent-principal'),principal=principalHeader?parseAgentPrincipalHeader(principalHeader):null;
 const declared=request.headers.get('x-concierge-agent-source'),legacy=request.headers.get('x-concierge-verified-agent-source');
 let invalid=principalHeader&&!principal?'AGENT_SOURCE_REQUIRED':declared&&legacy&&declared!==legacy?'AGENT_SOURCE_MISMATCH':undefined;
 let source:Source|undefined;try{source=sourcePair(declared??legacy);}catch{invalid='AGENT_SOURCE_REQUIRED';}
 const agent=!!principalHeader||!!source||!!invalid||request.headers.has('x-concierge-agent-origin')||request.headers.has('x-concierge-agent-test-create');
 if(!agent&&authority.getStore())return work();
 return scoped({agent,...(principal?{principal}:{}),...(source?{source}:{}),...(invalid?{invalid}:{})},work);
}
/** A reader exists only for its own request. Background work the request started (a delivery
 * wake, a timer, a provider run) inherits async context, so the scope expires when the request
 * settles; a streamed body carries its reader explicitly through contentReaderHeaders(). */
function scoped<T>(scope:Authority,work:()=>T):T {
 const result=authority.run(scope,work);
 if(result instanceof Promise)return result.finally(()=>{scope.expired=true;}) as T;
 scope.expired=true;return result;
}
export function trustedContentReader():boolean {const scope=authority.getStore();return !scope||!!scope.expired||!scope.agent&&!scope.invalid;}
/** Called after the communication command has checked its ordinary source contract. */
export function adoptContentSource(source:Source):void {
 const existing=authority.getStore();
 if(existing&&!existing.expired){existing.agent=true;existing.source=source;contentReader();}
}
export function verifiedContentSource(source:Source):{inputId:string;runId:string;sessionId:number} {
 return withContentSource(source,()=>{const reader=contentReader();if(reader.kind!=='actor')throw new LabDisclosureError('AGENT_SOURCE_REQUIRED');return {...source,sessionId:reader.input.session_id};});
}
export function withContentSource<T>(source:Source,work:()=>T):T {
 const existing=authority.getStore();
 return scoped({...existing,agent:true,source,expired:false},()=>{contentReader();return work();});
}
export function contentReader():Reader {
 const scope=authority.getStore();if(!scope||scope.expired)return {kind:'trusted'};if(scope.invalid)throw new LabDisclosureError(scope.invalid);if(!scope.agent)return {kind:'trusted'};
 let input=scope.source?getAcceptedSessionInput(scope.source.inputId):null;
 const turnId=input?.turn_id??(input?.steering_id?(db.query('SELECT turn_id FROM turn_steering_messages WHERE id=?').get(input.steering_id) as any)?.turn_id:null);
 let turn=turnId?db.query('SELECT * FROM turns WHERE id=?').get(turnId) as any:null;
 if(!input&&scope.principal?.kind==='run'){
  turn=db.query('SELECT * FROM turns WHERE id=? AND session_id=?').get(scope.principal.turnId,scope.principal.sessionId) as any;
  input=turn?.accepted_input_id?getAcceptedSessionInput(turn.accepted_input_id):null;
 }
 const live=!!input&&!!turn&&turn.session_id===input.session_id&&turn.status==='running'&&!!turn.provider_admission_intended_at&&!turn.stop_requested_at
  &&(!scope.source||nativeRunId(turn.id)===scope.source.runId);
 if(!live){if(scope.source)throw new LabDisclosureError('AGENT_SOURCE_REQUIRED');return {kind:'unknown'};}
 if(scope.principal?.kind==='run'&&(scope.principal.sessionId!==input!.session_id||scope.principal.turnId!==turn.id))throw new LabDisclosureError('AGENT_SOURCE_MISMATCH');
 let comparison:ComparisonContext|null;
 try{comparison=comparisonContext(input!);}catch{throw new LabDisclosureError('LAB_INVOCATION_UNCONFIRMED');}
 return {kind:'actor',input:input!,turn,comparison};
}
/** A local relay retains the declaration; a peer cannot make its remote actor local authority. */
export function contentReaderHeaders(peer=false):Record<string,string> {
 const scope=authority.getStore();if(!scope?.agent||scope.expired)return {};
 if(peer)return {'x-concierge-agent-origin':'unknown'};
 return {'x-concierge-agent-origin':'agent',...(scope.principal?{'x-concierge-agent-principal':scope.principal.kind==='run'?`run:${scope.principal.sessionId}:${scope.principal.turnId}`:`runner:${scope.principal.runner}`} :{}),
  ...(scope.source?{'x-concierge-agent-source':`${scope.source.inputId} ${scope.source.runId}`}:{})};
}
/** Every disclosure fan-out query is LIMITed so a budgeted agent read is admitted (an unbounded
 * reply query made agent receipt reads answer 503 on 2026-11-17, release fc2ce97a). A set larger
 * than the bound cannot be proven free of Lab provenance, so overflow reads as protected. */
export const DISCLOSURE_FANOUT_LIMIT=64;
type Walk={seen:Set<string>;invocations:Set<string>;overflow:boolean};
function boundedRows<T>(walk:{overflow:boolean},sql:string,...args:any[]):T[] {
 const rows=db.query(`${sql} LIMIT ${DISCLOSURE_FANOUT_LIMIT+1}`).all(...args) as T[];
 if(rows.length>DISCLOSURE_FANOUT_LIMIT){walk.overflow=true;return rows.slice(0,DISCLOSURE_FANOUT_LIMIT);}
 return rows;
}
const REPLY_SOURCES="SELECT source_input_id FROM session_inputs WHERE request_id=? AND kind='reply' ORDER BY rowid";
function origins(input:AcceptedSessionInput,walk:Walk):Set<string> {
 const {seen,invocations}=walk;
 const threads=new Set<string>();if(seen.has(input.id))return threads;seen.add(input.id);
 const payload=JSON.parse(input.payload_json);
 if(input.scope==='lab:invocation'&&typeof payload.labInvocation?.thread==='string'){threads.add(payload.labInvocation.thread);invocations.add(input.id);}
 if(['lab-conversation','lab-roster','lab-activation','lab-membership','lab-binding'].includes(input.kind)){
  const thread=payload.thread??payload.binding?.thread;if(typeof thread==='string')threads.add(thread);
 }
 if(input.source_input_id){const source=getAcceptedSessionInput(input.source_input_id);if(source)for(const thread of origins(source,walk))threads.add(thread);}
 if(input.request_id){
  const request=db.query('SELECT source_input_id,target_input_id FROM session_communication_requests WHERE request_id=?').get(input.request_id) as any;
  const replies=boundedRows<{source_input_id:string|null}>(walk,REPLY_SOURCES,input.request_id);
  for(const id of [request?.source_input_id,request?.target_input_id,...replies.map(value=>value.source_input_id)]){const linked=id?getAcceptedSessionInput(id):null;if(linked)for(const thread of origins(linked,walk))threads.add(thread);}
 }
 return threads;
}
export function restrictedLabThread(thread:string):boolean {
 const reader=contentReader();return reader.kind==='unknown'||reader.kind==='actor'&&reader.comparison?.openingOnly===true&&reader.comparison.thread===thread;
}
export function inputContentVisible(input:AcceptedSessionInput):boolean {
 const reader=contentReader();if(reader.kind==='trusted'||reader.kind==='actor'&&!reader.comparison?.openingOnly)return true;
 const walk:Walk={seen:new Set(),invocations:new Set(),overflow:false},invocations=walk.invocations,threads=origins(input,walk);
 if(walk.overflow)return false;if(!threads.size)return true;
 if(reader.kind==='unknown')return false;
 if(!reader.comparison?.openingOnly||!threads.has(reader.comparison.thread))return true;
 if(input.id===reader.turn.accepted_input_id)return true;
 const original=reader.turn.accepted_input_id;
 return input.scope!=='lab:invocation'&&!['lab-conversation','lab-roster','lab-activation','lab-membership','lab-binding'].includes(input.kind)&&invocations.size===1&&invocations.has(original);
}
export function assertInputContent(input:AcceptedSessionInput):void {if(!inputContentVisible(input))throw new LabDisclosureError();}
function sessionThreads(sessionId:number,walk:{overflow:boolean}={overflow:false}):Set<string> {
 const session=getSessionById(sessionId),nativeId=session?sessionMetadata(session).source?.nativeId:null;
 const local=nativeId?(db.query('SELECT id FROM sessions WHERE agent_session_uuid=? AND id<>? ORDER BY id LIMIT 1').get(nativeId,sessionId) as {id:number}|null)?.id:null;
 const rows=boundedRows<{payload_json:string}>(walk,"SELECT payload_json FROM session_inputs WHERE session_id=? AND scope='lab:invocation' ORDER BY rowid",sessionId);
 const result=new Set(rows.flatMap(row=>{const thread=JSON.parse(row.payload_json).labInvocation?.thread;return typeof thread==='string'?[thread]:[];}));
 if(local)for(const thread of sessionThreads(local,walk))result.add(thread);return result;
}
export function opaqueSessionProtected(sessionId:number):boolean {
 const reader=contentReader();if(reader.kind==='trusted'||reader.kind==='actor'&&!reader.comparison?.openingOnly)return false;
 const walk={overflow:false},threads=sessionThreads(sessionId,walk);if(walk.overflow)return true;return reader.kind==='unknown'?threads.size>0:reader.comparison?.openingOnly===true&&threads.has(reader.comparison.thread);
}
export function assertOpaqueSession(sessionId:number):void {if(opaqueSessionProtected(sessionId))throw new LabDisclosureError('LAB_CONTENT_PROVENANCE_REQUIRED');}
export function messageContentVisible(sessionId:number,message:any):boolean {
 const reader=contentReader();if(reader.kind==='trusted'||reader.kind==='actor'&&!reader.comparison?.openingOnly)return true;
 let id:string|null=null;
 const walk={overflow:false},rows=boundedRows<any>(walk,"SELECT DISTINCT input_id,turn_id FROM session_owner_events WHERE session_id=? AND kind='message' AND json_extract(payload_json,'$.message.id')=?",sessionId,message.id);
 // Overflow leaves the message's input ambiguous; it falls to the session-level opaque check below.
 const ids=walk.overflow?new Set<string>():new Set(rows.flatMap(row=>{const value=row.input_id??(row.turn_id?(db.query('SELECT accepted_input_id FROM turns WHERE id=?').get(row.turn_id) as any)?.accepted_input_id:null);return value?[value]:[];}));
 if(ids.size===1)id=[...ids][0] as string;
 if(!id){const turn=/^(?:input|output):([1-9][0-9]*)$/.exec(message.id??'');if(turn)id=(db.query('SELECT accepted_input_id FROM turns WHERE id=? AND session_id=?').get(Number(turn[1]),sessionId) as any)?.accepted_input_id;}
 if(id){const input=getAcceptedSessionInput(id);if(input)return inputContentVisible(input);}
 assertOpaqueSession(sessionId);return true;
}
export function assertMessageContent(sessionId:number,message:any):void {if(!messageContentVisible(sessionId,message))throw new LabDisclosureError();}
export function evidenceContentVisible(sessionId:number,item:any):boolean {
 if(trustedContentReader())return true;
 if(typeof item.sourceId==='string'&&item.sourceId.startsWith('input:')){const input=getAcceptedSessionInput(item.sourceId.slice(6));if(input)return inputContentVisible(input);}
 try{return messageContentVisible(sessionId,{...item,id:item.eventId??item.id});}catch(error){if(error instanceof LabDisclosureError)return false;throw error;}
}
export function assertCommunicationContent(requestId:string):void {
 const row=db.query('SELECT source_input_id,target_input_id FROM session_communication_requests WHERE request_id=?').get(requestId) as any;
 if(trustedContentReader())return;
 const walk={overflow:false},replies=boundedRows<{source_input_id:string|null}>(walk,REPLY_SOURCES,requestId);
 if(walk.overflow){const reader=contentReader();if(reader.kind==='unknown'||reader.kind==='actor'&&reader.comparison?.openingOnly)throw new LabDisclosureError();}
 for(const id of [row?.source_input_id,row?.target_input_id,...replies.map(value=>value.source_input_id)]){const input=id?getAcceptedSessionInput(id):null;if(input)assertInputContent(input);}
}
