import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,existsSync,mkdirSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename,join} from 'node:path';
import {PeerCatalogueSync} from './peer-catalogue-sync';
import {sessionProject} from './session-projects';
import {parseProviderSelector,resolveProviderSelector} from './aliases';
import {humanChoseTopModel} from './model-escalation-custody';
import {AWAITING_INSPECTION,PROMPT_ANSWER_REMINDER_MS,PROMPT_ANSWER_OVERDUE_MS,REMINDERS_SINCE_MS,STILL_WAITING_AFTER_MS,STILL_WAITING_MINUTES,updateDraining,replyCommand,stalledNotice,strandedStep,tellWorkerCanceled,cancelQueuedWithdrawnRequest,waitingOnDependency,type OwedRequest} from './request-liveness';
import {REQUEST_PROTOCOL_POINTER} from './request-protocol';
import {OWNER_READ_RESPONSE_MS} from './owner-transport-policy';
import {db,getSessionById,SETTLED_EXECUTION_SQL} from './state';
import {meaningIndex} from './meaning-index';
import {acceptedInputForTurn,carryingTurn,enqueueSessionInput,getAcceptedSessionInput,handedToARun, withdrawUnstartedServiceInput,humanAuthored,isInferredFinal,nativeRunId,recordSessionEvent,recoverUnsentSteeredInput,retainSessionInput,sessionInputProvenance,sessionMetadata,updateSessionMetadata} from './session-inputs';
import {heldRequestNotice,inputHold,readInputExecution,resolveSessionAddress,sessionAddress,SessionOwnerError,type SessionOwner} from './session-owner';
import {log,errorFields} from './log';
import {expireQuestionsForFinalReply,filePeerWorkerNeedInThread,linkForwardedReplyWork,linkInboxDispatchWork,postAgentAnswer,recordSessionMessageRoute,topicOfRoot} from './session-topics';
import {presentSessionForPeer,receiveSessionFromPeer} from './peer-identity';
import {followForwardedReply,messageRouteForSource} from './session-inbox';
import {inboxRequestRoot,returnsToRequester} from './inbox-request-root';
import {topicRootFor} from './session-fit';
import {clearRetryBreaker,recordRetryFailure} from './retry-breaker';
import {withRetry,RetryBudgetExhaustedError,retryDelayMs} from './retry';
import {cancelledWithoutHisStopText,stoppedByTejas,stoppedByTejasText} from './stopped-by-tejas';
import {noticeTime} from './provider-free-notice';
import {answerNotice,requestLabel,unresolvedRequestReminder} from './session-notices';
import {recordRequesterDecisionReturn} from './session-turn-outcome';
import {sessionAuthor} from './session-message-author';
import {admitChatGptAttachmentCorrection,admitChatGptContextFollowUp,admitChatGptObligation,bindChatGptPeerTarget,bindDirectChatGptTaskSource,chatGptObligationForAttempt,holdChatGptPeerVersion,openChatGptObligations,recordChatGptAttemptResult,withdrawCanceledChatGptAttempt,
  recordChatGptReturnReceipt,requireChatGptTaskDisposition,requireChatGptTaskResolved,resolveChatGptTask,parseChatGptTask,type ChatGptTask} from './chatgpt-obligations';
import {RETRY_POLICIES,PEER_REPLY_SCHEMA_MISMATCH_ATTEMPTS,PEER_REQUEST_ORPHAN_GRACE_MS} from './retry-policies';
import {ledgerDurable} from './ledger-durability-barrier';
import {parseMachineNeed,type MachineNeed} from './machine-need';
import {AUTHORIZED_PAGE,AUTHORIZED_WEB_APP,AUTHORIZING_HUMAN_INPUT,CANVAS_AUTHORIZING_HUMAN_INPUT} from './mac-surface-policy';
import {endedWorkInPlainWords} from './provider-failures';

/** Follow owner-recorded continuations back to the work request that forwarded a human reply. */
export function forwardedHumanWorkInput(actor:PeerActor,sourceInput:ReturnType<typeof getAcceptedSessionInput>) {
  let current=sourceInput;
  const seen=new Set<string>();
  while(current&&current.session_id===actor.session&&!seen.has(current.id)) {
    seen.add(current.id);
    if(current.kind==='input'&&current.origin==='agent'&&!current.source_run_id)return current;
    if(current.origin!=='service'||!current.source_input_id||!current.source_run_id)return null;
    const parent=getAcceptedSessionInput(current.source_input_id);
    if(!parent||parent.session_id!==actor.session||!parent.turn_id||nativeRunId(parent.turn_id)!==current.source_run_id)return null;
    if(current.id.startsWith('watch:')) {
      const watch=db.query(`SELECT 1 FROM watches WHERE delivery_input_id=? AND session_id=?
        AND origin_input_id=? AND origin_run_id=? AND state='fired'`).get(current.id,actor.session,parent.id,current.source_run_id);
      if(!watch)return null;
    } else if(current.id.startsWith('return:')) {
      const peerEvent=db.query(`SELECT 1 FROM session_peer_events event
        JOIN session_peer_requests request ON request.request_id=event.request_id
        WHERE event.event_id=? AND event.kind='final' AND event.accepted_input_id=? AND request.request_id=?
          AND request.source_session_id=? AND request.source_input_id=? AND request.source_turn_id=?
          AND json_extract(request.payload_json,'$.requestedEffect')='work'`)
        .get(current.id.slice('return:'.length),current.id,current.request_id,actor.session,parent.id,parent.turn_id);
      const localEvent=peerEvent?null:db.query(`SELECT 1 FROM session_communication_events event
        JOIN session_communication_requests request ON request.request_id=event.request_id
        WHERE event.event_id=? AND event.kind='final' AND event.accepted_input_id=? AND request.request_id=?
          AND request.source_session_id=? AND request.source_input_id=? AND request.source_turn_id=?
          AND json_extract(request.payload_json,'$.requestedEffect')='work'`)
        .get(current.id.slice('return:'.length),current.id,current.request_id,actor.session,parent.id,parent.turn_id);
      if(!peerEvent&&!localEvent)return null;
    } else return null;
    current=parent;
  }
  return null;
}

/** The original human grant survives a physical-device reply only within its recorded task. */
function continuedWebAppAuthorization(actor:PeerActor,sourceInput:ReturnType<typeof getAcceptedSessionInput>,provenance:ReturnType<typeof sessionInputProvenance>,input:{peer:string;address?:string;machineNeed?:MachineNeed}) {
  const need=input.machineNeed;
  if(input.peer!=='mac'||!input.address||need?.kind!=='mac-app'||!need.why.includes(AUTHORIZED_WEB_APP)||!need.why.includes(AUTHORIZED_PAGE)
    ||!sourceInput||!provenance?.originatingHuman)return null;
  const forwardedInput=forwardedHumanWorkInput(actor,sourceInput);
  if(!forwardedInput)return null;
  const forwarded=db.query(`SELECT source_input_id,source_session_id,thread_root_input_id,payload_json FROM session_communication_requests
    WHERE target_input_id=? AND target_session_id=? AND source_input_id=?`).get(forwardedInput.id,actor.session,forwardedInput.source_input_id) as
    {source_input_id:string;source_session_id:number;thread_root_input_id:string|null;payload_json:string}|null;
  const humanReply=forwarded?getAcceptedSessionInput(forwarded.source_input_id):null;
  if(!forwarded||!humanReply||!humanAuthored(humanReply)||humanReply.session_id!==forwarded.source_session_id
    ||provenance.originatingHuman.inputId!==humanReply.id
    ||JSON.parse(forwarded.payload_json)?.forwardedReply?.inboxInputId!==humanReply.id)return null;
  const currentTopic=forwarded.thread_root_input_id?topicOfRoot(forwarded.thread_root_input_id):null;
  const canvas=getAcceptedSessionInput(CANVAS_AUTHORIZING_HUMAN_INPUT);
  const replyTo=JSON.parse(humanReply.payload_json)?.replyToMessage?.messageId;
  if(canvas&&humanAuthored(canvas)&&canvas.session_id===humanReply.session_id
    &&replyTo===canvas.id&&forwarded.thread_root_input_id===canvas.id
    &&currentTopic!==null&&currentTopic===topicOfRoot(canvas.id)) {
    // The original Canvas work was handed back for the physical prerequisite; this reply
    // resumes that retained request, rather than authorizing a new app task by its text alone.
    const dispatch=db.query(`SELECT 1 FROM session_communication_requests request
      JOIN session_inputs target ON target.id=request.target_input_id AND target.session_id=request.target_session_id
      WHERE request.source_input_id=? AND request.source_session_id=? AND request.target_session_id=?
        AND request.outcome='decision_needed'
        AND json_extract(request.payload_json,'$.requestedEffect')='work' LIMIT 1`)
      .get(canvas.id,canvas.session_id,actor.session);
    if(dispatch){
      const payload=JSON.parse(canvas.payload_json);
      return {inputId:canvas.id,runId:canvas.turn_id?nativeRunId(canvas.turn_id):'',sessionId:`concierge:${canvas.session_id}`,
        ...(payload.capture?.id?{captureId:payload.capture.id}:{})};
    }
  }
  const original=getAcceptedSessionInput(AUTHORIZING_HUMAN_INPUT);
  if(!original||!humanAuthored(original)||original.session_id!==actor.session)return null;
  const task=currentTopic&&original.turn_id?db.query(`SELECT 1 FROM turns run
    JOIN session_communication_requests request ON request.target_input_id=run.accepted_input_id
    JOIN inbox_requests topic ON topic.topic_id=?
    JOIN json_each(topic.dispatches_json) dispatch ON json_extract(dispatch.value,'$.requestId')=request.request_id
    WHERE run.id=? AND run.session_id=? AND request.target_session_id=? LIMIT 1`)
    .get(currentTopic,original.turn_id,actor.session,actor.session):null;
  if(!task)return null;
  const payload=JSON.parse(original.payload_json);
  return {inputId:original.id,runId:original.turn_id?nativeRunId(original.turn_id):'',sessionId:`concierge:${original.session_id}`,
    ...(payload.capture?.id?{captureId:payload.capture.id}:{})};
}

/**
 * A second Concierge instance is a peer: its own ledger, FIFO and recovery on another
 * machine, reached over the tailnet with one shared bearer token. A peer request is the
 * existing `sessions ask` with the target session living in the peer's ledger, so the
 * origin keeps the request and its selected result destination while the peer keeps the target's
 * execution. Neither side ever writes the other's database.
 */
/** `paths` are the peer's home prefixes: an archived transcript under one of them belongs to that peer. */
export type PeerSettings={self:string|null;peers:{name:string;url:string;paths:string[];archives:string[]}[];listen:{hostname:string;port:number}|null;token:string|null};
const NAME=/^[a-z][a-z0-9-]{0,31}$/;
export function peerSettings(env:NodeJS.ProcessEnv=process.env):PeerSettings {
  const self=env.CONCIERGE_PEER_NAME?.trim()||null;
  const peers=env.CONCIERGE_PEERS?.trim()?JSON.parse(env.CONCIERGE_PEERS) as unknown:[];
  const listen=env.CONCIERGE_PEER_LISTEN?.trim()||null;
  const tokenPath=env.CONCIERGE_PEER_TOKEN_FILE?.trim()||null;
  if(!self&&!listen&&!tokenPath&&!(Array.isArray(peers)&&peers.length))return {self:null,peers:[],listen:null,token:null};
  if(!self||!NAME.test(self))throw new Error('CONCIERGE_PEER_NAME must name this instance (lowercase letters, digits, dashes).');
  if(!Array.isArray(peers)||peers.some(peer=>typeof peer!=='object'||!peer||!NAME.test((peer as any).name)||typeof (peer as any).url!=='string'||!/^https?:\/\/[^/\s]+$/.test((peer as any).url)
      ||['paths','archives'].some(key=>(peer as any)[key]!==undefined&&(!Array.isArray((peer as any)[key])||(peer as any)[key].some((path:unknown)=>typeof path!=='string'||!path.startsWith('/'))))))
    throw new Error('CONCIERGE_PEERS must be a JSON array of {name,url,paths?,archives?} with an origin-only http(s) URL and absolute paths.');
  if(peers.some(peer=>(peer as any).name===self))throw new Error('CONCIERGE_PEERS cannot list this instance.');
  if(!tokenPath)throw new Error('CONCIERGE_PEER_TOKEN_FILE is required when peers are configured.');
  const token=readFileSync(tokenPath,'utf8').trim();
  if(token.length<32)throw new Error('The peer token must contain at least 32 characters.');
  let bound:{hostname:string;port:number}|null=null;
  if(listen){
    const match=listen.match(/^(.+):(\d{2,5})$/);
    if(!match)throw new Error('CONCIERGE_PEER_LISTEN must be host:port.');
    bound={hostname:match[1]!,port:Number(match[2])};
    if(bound.hostname==='0.0.0.0'||bound.hostname==='::'||bound.hostname==='')throw new Error('CONCIERGE_PEER_LISTEN must bind one tailnet address, never every interface.');
  }
  return {self,peers:(peers as {name:string;url:string;paths?:string[];archives?:string[]}[]).map(peer=>({name:peer.name,url:peer.url,paths:peer.paths??[],archives:peer.archives??[]})),listen:bound,token};
}

export class PeerError extends Error {
  constructor(message:string,readonly kind:'unreachable'|'unauthorized'|'refused',readonly status:number|null=null,readonly code:string|null=null){super(message);}
}
class PeerReplyContractError extends Error {}
/** Bun names a refused connection `ConnectionRefused`; Node names it `ECONNREFUSED`. */
const peerAnsweredRefused=(error:unknown)=>['ConnectionRefused','ECONNREFUSED'].includes(String((error as {code?:unknown})?.code??''));
/** Longer than an update's restart and start-up, shorter than an outage worth a repair agent's turn. */
const PEER_DOWN_ANNOUNCE_AFTER_MS=3*60_000;
export class PeerClient {
  private refusedSince:number|null=null;
  constructor(readonly name:string,readonly url:string,private readonly token:string,readonly paths:string[]=[],readonly archives:string[]=[]){}
  async request<T=any>(method:'GET'|'POST',path:string,body?:unknown,timeoutMs=OWNER_READ_RESPONSE_MS,trackAvailability=true,signal?:AbortSignal):Promise<T> {
    let response:Response;
    // A request to the peer carries ledger facts (its request, its answer); they reach the disk first.
    if(method==='POST')await ledgerDurable();
    try {
      response=await fetch(this.url+path,{method,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs),headers:{authorization:`Bearer ${this.token}`,accept:'application/json',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    } catch(error) {
      if(signal?.aborted)throw error;
      // A peer that sleeps is normal, so its unreachability is never a notice to Tejas: it
      // flickered awake and asleep in his bag and produced one notice and one "running again"
      // per flicker (2026-09-27). Work waiting on it reports to its requester instead.
      // A sleeping machine never answers, so the connection times out. A refused connection is
      // the machine itself answering that nothing listens: it is awake and its Concierge is down.
      // That is a real outage and is announced (to the repair agent first): on 2026-10-10 the
      // Mac's Concierge failed to restart for two hours while he used the Mac, and was treated
      // as asleep the whole time.
      // An update restarts the peer's Concierge in seconds, and every request in flight is refused
      // at once: fifteen refusals in under four seconds tripped this breaker and filed a "not
      // running" notice for a routine update twice in one night (2026-10-16, 11:54 PM and 1:16 AM).
      // So a refusal is announced only after the peer has kept refusing for a few minutes.
      const awake=peerAnsweredRefused(error);
      const now=Date.now();
      this.refusedSince=awake?this.refusedSince??now:null;
      const downLongEnough=awake&&now-this.refusedSince!>=PEER_DOWN_ANNOUNCE_AFTER_MS;
      if(trackAvailability)recordRetryFailure({key:`peer:${this.name}`,site:'peer',what:`Requests to ${this.name}`,announce:downLongEnough,
        failure:{kind:'unknown',reason:awake?`${this.name} is awake and answering, but its Concierge is not running, so work sent to it is waiting.`:`Peer ${this.name} is unreachable.`,
          waitForSignal:`${this.name} next contacts this instance`,restartSignal:`${this.name} next contacts this instance`}});
      throw new PeerError(`Peer ${this.name} is unreachable.`,'unreachable',null,'PEER_UNREACHABLE');
    }
    this.refusedSince=null;
    let value:any=null;
    try {value=await response.json();} catch {value=null;}
    if(response.status===401||response.status===403)throw new PeerError(`Peer ${this.name} refused this instance's token.`,'unauthorized',response.status,'PEER_UNAUTHORIZED');
    if(!response.ok){
      const message=typeof value?.error==='string'?value.error:value?.error?.message??`Peer ${this.name} answered ${response.status}.`;
      throw new PeerError(message,'refused',response.status,value?.error?.code??'PEER_REFUSED');
    }
    if(trackAvailability)clearRetryBreaker(`peer:${this.name}`);
    return value as T;
  }
}

type PeerRequestRow={request_id:string;peer:string;source_session_id:number;source_turn_id:number;source_input_id:string;action_id:string;payload_json:string;payload_hash:string;
  remote_session_id:string;remote_address:string;remote_operation_id:string;remote_status_json:string|null;delivery_json:string|null;status:string;outcome:string|null;result_json:string|null;due_at_ms:number;overdue_at_ms:number|null;prompt_reminded_at_ms:number|null;prompt_answered_at_ms:number|null;stalled_at_ms:number|null;created_at_ms:number;thread_root_input_id:string|null};
type CatalogueRow={peer:string;remote_session_id:string;address:string;runtime_thread_id:string|null;view_json:string;updated_at_ms:number};
const OFFLINE_MS=60_000;
const evidenceTime=(result:any):string|null=>{const times=(result.evidence??[]).map((item:any)=>item.at).filter((at:unknown)=>typeof at==='string');return times.length?times.sort().pop():null;};
export const offlineNote=(peer:string)=>`${peer} is offline — its sessions come from the transcript archive and its last catalogue and cannot resume until ${peer} is back.`;
type PeerEventRow={event_id:string;request_id:string;kind:'progress'|'final'|'overdue';payload_json:string;status:string;error:string|null;accepted_input_id:string|null;created_at_ms:number};
type DeliveryRow={request_id:string;peer:string;origin_session_id:string;origin_input_id:string;origin_run_id:string;target_session_id:number;target_input_id:string;requested_effect:string;origin_provenance_json:string|null;notified_fingerprint:string|null;closed_at_ms:number|null;reminded_at_ms:number|null;reminded_via:string|null;prompt_reminded_at_ms:number|null;stalled_at_ms:number|null;stalled_reason:string|null;created_at_ms:number};
type ReplyRow={event_id:string;request_id:string;action_key:string|null;kind:'progress'|'final';payload_json:string;status:string;error:string|null;created_at_ms:number};
export type PeerActor={session:number;turn:number;inputId:string};
type WorkDisposition='completed'|'failed'|'needs_decision';
type Dependencies={self:string;clients:Map<string,PeerClient>;owner:SessionOwner;now?:()=>number;onError:(error:unknown)=>void;isOwnerAlive:(owner:string)=>boolean;onWake?:()=>void;hasPendingOperations?:()=>boolean};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const object=(value:unknown):Record<string,any>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new SessionOwnerError('A JSON object is required.');return value as Record<string,any>;};
const DUE_MS=STILL_WAITING_AFTER_MS;
/** The request ID is a function of the source input and action, so a retry after a lost response reaches the same peer row. */
export const requestIdFor=(sourceInputId:string,actionId:string)=>{const h=hash(`peer-request:${sourceInputId}:${actionId}`);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};

export class SessionPeers {
  private readonly tasks=new Map<string,Promise<void>>();
  private readonly again=new Set<string>();
  private reconciliation:Promise<void>|null=null;
  private reconciliationDirty=false;
  private stopped=true;
  private peerReadController=new AbortController();
  private disarm:(()=>void)|null=null;
  private readonly now:()=>number;
  private readonly unreachable=new Map<string,number>();
  constructor(private readonly dependencies:Dependencies){this.now=dependencies.now??Date.now;}
  get self(){return this.dependencies.self;}
  inventory(){return {self:this.self,peers:[...this.dependencies.clients.values()].map(client=>({name:client.name,url:client.url,lastUnreachableAt:this.unreachable.get(client.name)??null,catalogue:this.catalogueSync.status(client.name)}))};}
  async inventoryWithReachability() {
    return {self:this.self,peers:await Promise.all([...this.dependencies.clients.values()].map(async client=>{
      try {const status=await client.request('GET','/sessions/v1/status',undefined,5_000);return {name:client.name,url:client.url,reachable:true,status};}
      catch(error) {return {name:client.name,url:client.url,reachable:false,error:error instanceof Error?error.message:String(error)};}
    }))};
  }
  client(name:unknown):PeerClient {
    if(typeof name!=='string'||!this.dependencies.clients.has(name))throw new SessionOwnerError(`Unknown peer instance${typeof name==='string'?` ${name}`:''}; see sessions peers.`,404,'PEER_UNKNOWN');
    return this.dependencies.clients.get(name)!;
  }
  private note(peer:string,error:unknown) {
    if(error instanceof PeerError&&error.kind==='unreachable'){this.unreachable.set(peer,this.now());return;}
    this.unreachable.delete(peer);
  }
  /** Seen unreachable within the last minute; a probe decides otherwise. */
  offline(peer:string){const at=this.unreachable.get(peer);return at!==undefined&&this.now()-at<OFFLINE_MS;}
  availability(peer:string,state:'live'|'archived-only'=this.offline(peer)?'archived-only':'live'){return this.offline(peer)?{state:'archived-only' as const,reachable:false,note:offlineNote(peer)}:{state,reachable:true,note:null};}
  private readonly catalogueRefreshedAt=new Map<string,number>();
  private readonly catalogueSync=new PeerCatalogueSync(db,()=>this.now());
  private readonly catalogueTasks=new Map<string,{promise:Promise<void>;controller:AbortController}>();
  /** Retain what a peer said about its sessions, so they stay addressable while it is offline. */
  remember(peer:string,views:unknown[]) {
    const now=this.now();
    db.transaction(()=>{
      for(const view of views){
        const item=view as any;
        if(!item||typeof item!=='object'||typeof item.id!=='string'||typeof item.address!=='string')continue;
        const remote=item.id.startsWith(`${peer}:`)?`concierge:${item.id.slice(peer.length+1)}`:item.id;
        if(db.query('SELECT 1 FROM session_peer_catalogue_tombstones WHERE peer=? AND remote_session_id=?').get(peer,remote))continue;
        const address=item.address.startsWith(`${peer}/`)?item.address.slice(peer.length+1):item.address;
        if(!/^concierge:[1-9][0-9]*$/.test(remote)||!/^session:/.test(address))continue;
        db.query(`INSERT INTO session_peer_catalogue(peer,remote_session_id,address,runtime_thread_id,view_json,updated_at_ms) VALUES(?,?,?,?,?,?)
          ON CONFLICT(peer,remote_session_id) DO UPDATE SET address=excluded.address,runtime_thread_id=excluded.runtime_thread_id,view_json=excluded.view_json,updated_at_ms=excluded.updated_at_ms`)
          .run(peer,remote,address,typeof item.runtimeThreadId==='string'?item.runtimeThreadId:null,JSON.stringify(item),now);
      }
    })();
  }
  async refreshCatalogue(peer:string) {
    const active=this.catalogueTasks.get(peer);if(active)return active.promise;
    const client=this.dependencies.clients.get(peer);
    const lastAttempt=this.catalogueRefreshedAt.get(peer);
    if(!client||lastAttempt!==undefined&&this.now()-lastAttempt<OFFLINE_MS)return;
    this.catalogueRefreshedAt.set(peer,this.now());
    const controller=new AbortController();let more=false;
    const promise=(async()=>{
      try{
        const result=await this.catalogueSync.refresh(peer,(path,signal)=>client.request('GET',path,undefined,10_000,true,signal),controller.signal);
        if(!controller.signal.aborted){more=result.more;this.unreachable.delete(peer);}
      }catch(error){
        if(!controller.signal.aborted){this.note(peer,error);log('warn','session_peer_catalogue_refresh_failed',{peer,...errorFields(error)});}
      }finally{
        this.catalogueTasks.delete(peer);
        if(more&&!controller.signal.aborted){this.catalogueRefreshedAt.delete(peer);this.wake();}
      }
    })();
    this.catalogueTasks.set(peer,{promise,controller});
    return promise;
  }
  private cachedView(peer:string,remote:string):any|null {
    const row=db.query('SELECT * FROM session_peer_catalogue WHERE peer=? AND remote_session_id=?').get(peer,remote) as CatalogueRow|null;
    return row?{...JSON.parse(row.view_json),peer,availability:this.availability(peer),lastSeenAt:new Date(row.updated_at_ms).toISOString()}:null;
  }
  private cachedByThread(threadId:string):{peer:string;view:any}|null {
    const row=db.query('SELECT * FROM session_peer_catalogue WHERE runtime_thread_id=? ORDER BY updated_at_ms DESC LIMIT 1').get(threadId) as CatalogueRow|null;
    return row?{peer:row.peer,view:this.cachedView(row.peer,row.remote_session_id)}:null;
  }
  private peerForPath(path:unknown):string|null {
    if(typeof path!=='string')return null;
    for(const client of this.dependencies.clients.values())if(client.paths.some(prefix=>path.startsWith(prefix)))return client.name;
    return null;
  }
  /** Which peer's home holds this absolute path, or null when no peer claims it. */
  instanceForPath(path:string):string|null{return this.peerForPath(path);}
  /** Read a Markdown file from the machine that holds it. The peer applies its own workspace boundary. */
  async readFile(peer:string,path:string){return this.client(peer).request('GET','/sessions/v1/files?'+new URLSearchParams({path,machine:peer}),undefined,20_000);}
  /** List one registered project folder on the peer that owns it. */
  async projectFiles(peer:string,project:string,path:string){return this.client(peer).request('GET','/sessions/v1/projects/'+encodeURIComponent(project)+'/files?'+new URLSearchParams({path,machine:peer}),undefined,20_000);}
  /** Configured peers in the order they were given, for surfaces that show every machine. */
  names():string[]{return [...this.dependencies.clients.keys()];}
  /**
   * A peer's own provider accounts and the logins that change them. The login itself runs on
   * the peer, under the peer's own Concierge, which is the only place allowed to write that
   * machine's credentials.
   *
   * The read names the peer as its own machine so it answers locally instead of fanning out
   * to its own peers and back here; that is the same recursion guard `readFile` uses. A
   * change needs no guard — arriving without a machine already means "this one" — so it is
   * forwarded exactly as the route has always accepted it, and a peer still running an older
   * build signs itself in rather than rejecting a field it has never heard of.
   */
  async authProviders(peer:string,fresh=false){return this.client(peer).request('GET','/sessions/v1/auth/providers?'+new URLSearchParams({machine:peer,...(fresh?{fresh:'1'}:{})}),undefined,fresh?30_000:8_000);}
  async authAction(peer:string,path:string,body:Record<string,unknown>,timeoutMs:number){return this.client(peer).request('POST',`/sessions/v1/auth/${path}`,body,timeoutMs);}
  async projects(peer:string){return this.client(peer).request('GET','/sessions/v1/projects');}
  async search(peer:string,concepts:string[],limit?:number):Promise<any>{return this.qualify(peer,await this.client(peer).request('POST','/sessions/v1/search',{query:concepts.join(' '),...(limit===undefined?{}:{limit})},8_000));}
  /**
   * The peer to search through when this machine has no meaning index of its own (the Mac): the
   * machine that keeps the archive, which is any peer whose archive is not kept here. A peer known
   * to be unreachable is skipped, so a laptop off the network searches on its own at once.
   */
  meaningHub():string|null {
    if(meaningIndex()?.installed)return null;
    const hub=[...this.dependencies.clients.values()].find(client=>!client.archives?.length);
    return hub&&!this.offline(hub.name)?hub.name:null;
  }
  /**
   * The machine that runs ChatGPT for this one: the always-on peer whose archive is not kept
   * here (the server), where thnkr.ing's signed-in Chrome lives. Unlike search there is no local
   * fallback, so a sleeping or unreachable server still gets the request, queued until it answers.
   */
  chatGptHost():string|null {
    return [...this.dependencies.clients.values()].find(client=>!client.archives?.length)?.name??null;
  }
  /**
   * Run the whole search on `peer` and read its answer from here: its own sessions become
   * `<peer>:<n>`, and sessions it found on this machine (named `<self>:<n>` there) are this
   * machine's own, shown with this machine's current view of them.
   */
  async searchThrough(peer:string,concepts:string[],limit?:number):Promise<any> {
    let value:any;
    try{value=await this.client(peer).request<any>('POST','/sessions/v1/search',{query:concepts.join(' '),everywhere:true,...(limit===undefined?{}:{limit})},20_000);this.unreachable.delete(peer);}
    catch(error){this.note(peer,error);throw error;}
    const self=this.self;
    const own=(item:string)=>self&&item.startsWith(`${self}:`)&&/^\d+$/.test(item.slice(self.length+1))?`concierge:${item.slice(self.length+1)}`
      :self&&item.startsWith(`${self}/session:`)?item.slice(self.length+1):null;
    const walk=(item:unknown):unknown=>{
      if(typeof item==='string')return own(item)??(/^concierge:[1-9][0-9]*$/.test(item)?`${peer}:${item.slice(10)}`:/^session:[A-Za-z0-9_-]+$/.test(item)?`${peer}/${item}`:item);
      if(Array.isArray(item))return item.map(walk);
      if(item&&typeof item==='object'){const out:Record<string,unknown>={};for(const [key,child] of Object.entries(item as Record<string,unknown>))out[key]=walk(child);return out;}
      return item;
    };
    const answer=walk(value) as any;
    const results=(answer.results??[]).map((result:any)=>{
      const local=typeof result.session?.id==='string'?/^concierge:(\d+)$/.exec(result.session.id):null;
      const row=local?getSessionById(Number(local[1])):null;
      if(row)return {...result,session:this.dependencies.owner.view(row)};
      return typeof result.session?.id==='string'&&result.session.id.startsWith(`${peer}:`)?{...result,session:{...result.session,peer}}:result;
    });
    this.remember(peer,results.map((result:any)=>result.session).filter((session:any)=>session?.peer===peer));
    log('info','session_search_through_peer',{peer,results:results.length});
    return {...answer,results,coverage:{...answer.coverage,searchedOn:peer}};
  }
  async context(peer:string,address:string):Promise<any>{return this.qualify(peer,await this.client(peer).request('POST','/sessions/v1/context',{address},8_000));}
  /** A peer's answer names its sessions as `<peer>:<n>` and its addresses as `<peer>/session:…`, so an agent can use them directly. */
  private qualify(peer:string,value:unknown):unknown {
    const walk=(item:unknown):unknown=>{
      if(typeof item==='string')return /^concierge:[1-9][0-9]*$/.test(item)?`${peer}:${item.slice(10)}`:/^session:[A-Za-z0-9_-]+$/.test(item)?`${peer}/${item}`:item;
      if(Array.isArray(item))return item.map(walk);
      if(item&&typeof item==='object'){const out:Record<string,unknown>={};for(const [key,child] of Object.entries(item as Record<string,unknown>))out[key]=walk(child);if('address' in out&&'id' in out)out.peer=peer;return out;}
      return item;
    };
    return walk(value);
  }
  /**
   * Every session the agent can reach, wherever it lives. The transcript archive on this
   * instance is the primary index — it holds both machines' history and answers whether a
   * peer is on or off — so an archived transcript that belongs to a peer session is shown
   * as that session, marked offline when the peer does not answer. A live peer answer only
   * adds sessions the archive has not seen yet and says which are running now.
   */
  async federatedSearch(local:()=>Promise<any>,concepts:string[],limit?:number) {
    const [own,...peers]=await Promise.all([local(),...[...this.dependencies.clients.keys()].map(async name=>{
      // A sleeping laptop answers no faster for being asked again: reaching it costs seconds of
      // connect timeout, and every search paid them. Within the offline window this reads the
      // same as a failed probe — archived-only, catalogue matches kept — and the window expiring
      // probes again, so the peer is found on its own once it is back. meaningHub() skips alike.
      if(this.offline(name))return {name,value:null,error:offlineNote(name)};
      try{const value=await this.search(name,concepts,limit);this.unreachable.delete(name);this.remember(name,(value?.results??[]).map((result:any)=>result.session));return {name,value,error:null};}
      catch(error){this.note(name,error);return {name,value:null,error:error instanceof Error?error.message:String(error)};}
    })]);
    const merged=new Map<string,any>();
    const add=(result:any)=>{const id=result.session?.id;const prior=id?merged.get(id):null;
      if(prior){prior.evidence=[...prior.evidence,...(result.evidence??[])];if(result.session.execution)prior.session={...prior.session,...result.session};}
      else merged.set(id??`local:${merged.size}`,{...result,evidence:[...(result.evidence??[])]});};
    for(const result of own.results as any[]){
      const session=result.session;
      if(session?.origin==='imported'){
        let threadId:string|null=null;
        try{const key=JSON.parse(session.nativeKey??'null');threadId=Array.isArray(key)?String(key[key.length-1]):null;}catch{}
        const cached=threadId?this.cachedByThread(threadId):null;
        if(cached?.view){
          // The archive transcript is this peer session's own history; present the session, keep the passages.
          // Until the live peer confirms it below, the archive alone vouches for it.
          add({...result,session:{...cached.view,availability:{...cached.view.availability,state:'archived-only'}},archive:{sessionId:session.id,address:session.address,archivedAt:evidenceTime(result)},evidence:(result.evidence??[]).map((item:any)=>({...item,sessionId:cached.view.id}))});
          continue;
        }
        const peer=this.peerForPath(session.project);
        if(peer){add({...result,session:{...session,peer,archived:true,availability:{...this.availability(peer),note:this.offline(peer)?offlineNote(peer):`Transcript archived from ${peer}; not a Concierge session there.`}}});continue;}
      }
      add(result);
    }
    const omissions=[...(own.coverage?.omissions??[])];let complete=own.coverage?.complete!==false;const availability:Record<string,{state:'live'|'archived-only';reachable:boolean;note:string|null}>={};
    for(const peer of peers){
      availability[peer.name]=peer.error?{state:'archived-only',reachable:false,note:offlineNote(peer.name)}:{state:'live',reachable:true,note:null};
      if(peer.error){complete=false;omissions.push(offlineNote(peer.name));continue;}
      for(const result of (peer.value?.results??[]) as any[])add({...result,session:{...result.session,availability:{state:'live',reachable:true,note:null}}});
      if(peer.value?.coverage?.complete===false)complete=false;
      omissions.push(...((peer.value?.coverage?.omissions??[]) as string[]).map(item=>`${peer.name}: ${item}`));
    }
    // A peer that did not answer may hold sessions newer than the archive's last push; its
    // last catalogue still names them. A catalogue-only match carries no dialogue evidence.
    const needles=concepts.map(concept=>concept.toLowerCase());
    for(const [name,state] of Object.entries(availability)){
      if(state.reachable)continue;
      for(const row of db.query('SELECT * FROM session_peer_catalogue WHERE peer=? ORDER BY updated_at_ms DESC LIMIT 500').all(name) as CatalogueRow[]){
        const view=JSON.parse(row.view_json);
        const haystack=`${view.title??''} ${view.summary??''} ${view.project??''}`.toLowerCase();
        if(!needles.some(needle=>haystack.includes(needle)))continue;
        if(merged.has(view.id))continue;
        add({session:{...view,peer:name,availability:{...state,state:'archived-only'},lastSeenAt:new Date(row.updated_at_ms).toISOString()},evidence:[],catalogueOnly:true});
      }
    }
    const results=[...merged.values()].slice(0,limit&&limit>0?Math.max(limit,own.results.length):undefined);
    log('info','session_peer_search',{local:own.results.length,merged:results.length,offline:Object.entries(availability).filter(([,value])=>!value.reachable).map(([name])=>name),
      peerSessions:results.filter((result:any)=>result.session?.peer).map((result:any)=>`${result.session.id}${result.archive?'@archive':result.catalogueOnly?'@catalogue':result.session.archived?'@archived':'@live'}`).slice(0,12)});
    return {...own,results,coverage:{...own.coverage,complete,omissions,peers:availability,sources:(own.coverage?.sources??0)+peers.reduce((sum,peer)=>sum+Number(peer.value?.coverage?.sources??0),0)}};
  }
  /** Where a peer session's transcript sits in this instance's archive, if it has been pushed here. */
  archivedTranscript(peer:string,threadId:string):{path:string;archivedAt:string}|null {
    const client=this.dependencies.clients.get(peer);
    if(!client||!/^[0-9a-f-]{36}$/i.test(threadId))return null;
    const matches=(root:string):string[]=>{
      let out:string[]=[];
      let entries:import('node:fs').Dirent[];
      try{entries=readdirSync(root,{withFileTypes:true});}catch{return out;}
      for(const entry of entries){
        const path=join(root,entry.name);
        if(entry.isDirectory())out=out.concat(matches(path));
        else if(entry.isFile()&&entry.name.endsWith('.jsonl')&&entry.name.includes(threadId))out.push(path);
      }
      return out;
    };
    const found=client.archives.flatMap(matches).map(path=>({path,mtime:statSync(path).mtimeMs})).sort((a,b)=>b.mtime-a.mtime)[0];
    return found?{path:found.path,archivedAt:new Date(found.mtime).toISOString()}:null;
  }
  /**
   * A new process on this instance continuing a peer session's archived transcript: the
   * provider's own resume by session UUID, fed the transcript copied into its local store.
   * The peer's session stays parked; this is a distinct session with `resurrection` lineage.
   */
  resurrect(peer:string,address:string,options:{createSession:(provider:'claude-code'|'codex',metadata:Record<string,unknown>)=>{id:number};bind:(sessionId:number,provider:'claude-code'|'codex',uuid:string)=>void;defaultCwd:string}) {
    this.client(peer);
    let tuple:any=null;try{tuple=JSON.parse(Buffer.from(address.slice(8),'base64url').toString());}catch{}
    const remote=Array.isArray(tuple)&&Number.isSafeInteger(tuple[1])?`concierge:${tuple[1]}`:null;
    const view=remote?this.cachedView(peer,remote):null;
    if(!view)throw new SessionOwnerError(`This ${peer} session has not been seen by this instance yet, so there is nothing to resurrect from.`,404,'PEER_SESSION_UNKNOWN');
    const provider=view.provider;
    if(provider!=='claude-code'&&provider!=='codex')throw new SessionOwnerError('Only Claude and Codex sessions can be resurrected from a transcript.',409,'CAPABILITY_UNAVAILABLE');
    const threadId=view.runtimeThreadId;
    if(typeof threadId!=='string'||!threadId)throw new SessionOwnerError('This session never bound a provider transcript, so there is nothing to resurrect.',409,'CAPABILITY_UNAVAILABLE');
    const presented=this.presentedSession(peer,remote!);
    const existing=db.query("SELECT id FROM sessions WHERE status<>'archived' AND json_extract(native_metadata_json,'$.resurrection.sessionId')=? AND json_extract(native_metadata_json,'$.resurrection.threadId')=?").get(presented,threadId) as {id:number}|null;
    if(existing)return {sessionId:existing.id,reused:true};
    const archived=this.archivedTranscript(peer,threadId);
    if(!archived)throw new SessionOwnerError(`${peer}'s transcript for this session has not reached this instance's archive yet (it is pushed every few minutes); try again shortly or wait for ${peer}.`,409,'ARCHIVE_NOT_YET_SYNCED');
    if(view.projectNameTruncated||view.projectTruncated&&typeof view.projectName!=='string')throw new SessionOwnerError('The exact project identity has not reached this instance yet. Refresh this peer before resurrecting the session.',409,'PEER_PROJECT_IDENTITY_INCOMPLETE');
    const projectName=typeof view.projectName==='string'?view.projectName:typeof view.project==='string'?basename(view.project.replace(/\/+$/,'')):null;
    const project=projectName?sessionProject(options.defaultCwd,projectName):null;
    if(!project)throw new SessionOwnerError(`This instance has no registered project folder named ${projectName??'(unknown)'} to resurrect into.`,409,'PROJECT_UNAVAILABLE');
    // Place the transcript where the provider's own resume finds it for this cwd.
    let destination:string;
    if(provider==='claude-code'){
      const slug=project.cwd.replace(/[\/.]/g,'-');
      destination=join(homedir(),'.claude','projects',slug,`${threadId}.jsonl`);
    } else {
      const day=archived.archivedAt.slice(0,10).split('-');
      destination=join(homedir(),'.codex','sessions',day[0]!,day[1]!,day[2]!,basename(archived.path));
    }
    if(!existsSync(destination)){mkdirSync(join(destination,'..'),{recursive:true,mode:0o700});copyFileSync(archived.path,destination);}
    const created=options.createSession(provider,{origin:'reconstructed',purpose:view.purpose??'chat',title:`${view.title} (resurrected from ${peer})`,cwd:project.cwd,project:project.cwd,
      ...(view.model?{model:view.model}:{}),...(view.reasoningEffort?{reasoningEffort:view.reasoningEffort}:{}),
      resurrection:{peer,sessionId:presented,address:`${peer}/${address}`,threadId,archivedAt:archived.archivedAt,archivePath:archived.path,resurrectedAt:new Date(this.now()).toISOString()}});
    options.bind(created.id,provider,threadId);
    log('info','session_peer_resurrected',{peer,remote_session:presented,session_id:created.id,provider});
    return {sessionId:created.id,reused:false};
  }
  /** Context for a peer session while the peer is offline: its last catalogue view plus its archived transcript here. */
  async offlineContext(peer:string,address:string,localContext:(address:string)=>Promise<any>) {
    let tuple:any=null;try{tuple=JSON.parse(Buffer.from(address.slice(8),'base64url').toString());}catch{}
    const remote=Array.isArray(tuple)&&Number.isSafeInteger(tuple[1])?`concierge:${tuple[1]}`:null;
    const view=remote?this.cachedView(peer,remote):null;
    if(!view)throw new SessionOwnerError(`${offlineNote(peer)} This session has not been seen by this instance yet.`,503,'PEER_UNREACHABLE');
    const threadId=view.runtimeThreadId;
    const archived=threadId?db.query("SELECT id,binding_generation FROM sessions WHERE json_extract(native_metadata_json,'$.origin')='imported' AND json_extract(native_metadata_json,'$.source.nativeId')=? ORDER BY id DESC LIMIT 1").get(threadId) as {id:number}|null:null;
    if(!archived)return {session:view,evidence:[],hasMore:false,offline:true,note:`${offlineNote(peer)} No archived transcript of this session is indexed here yet.`};
    const context=await localContext(sessionAddress(getSessionById(archived.id)!));
    return {...context,session:view,archive:context.session,offline:true,note:`${offlineNote(peer)} Dialogue below comes from the archived transcript.`};
  }
  /** `<peer>/session:…` names a session on that peer; anything else is local. */
  splitAddress(address:unknown):{peer:string;address:string}|null {
    if(typeof address!=='string')return null;
    const match=address.match(/^([a-z][a-z0-9-]{0,31})\/(session:[A-Za-z0-9_-]+)$/);
    return match&&this.dependencies.clients.has(match[1]!)?{peer:match[1]!,address:match[2]!}:null;
  }

  // ---- origin side: a request this instance sent to a peer ----
  private row(id:string):PeerRequestRow {
    const row=db.query('SELECT * FROM session_peer_requests WHERE request_id=?').get(id) as PeerRequestRow|null;
    if(!row)throw new SessionOwnerError('Unknown session request.',404);
    return row;
  }
  owns(requestId:string){return !!db.query('SELECT 1 FROM session_peer_requests WHERE request_id=?').get(requestId);}
  hasDelivery(requestId:string){return !!db.query('SELECT 1 FROM session_peer_deliveries WHERE request_id=?').get(requestId);}
  private presentedSession(peer:string,remote:string){return receiveSessionFromPeer(remote,peer,this.self);}
  private presentedAddress(peer:string,address:string){return address.startsWith('session:')?`${peer}/${address}`:address;}
  async ask(actor:PeerActor,input:{peer:string;action_id:string;address?:string;provider?:string;effort?:string;escalationReason?:string;project?:string;title?:string;summary?:string;text:string;
    forTask?:string;recoveryOf?:string;correctionOf?:string;
    machineNeed?:MachineNeed;
    requestedEffect?:'informational'|'work';files?:{name:string;contentType:string;base64:string}[];attachments?:string[];captureId?:string;evidence?:unknown[];threadRoot?:string|null;threadSourceMessageId?:string;returnToRequester?:boolean;
    routedFrom?:{sessionId:string;messageId:string;topicId:string;root:string;title:string;originalText:string;originalCreatedAt:string;authorKind:'human'|'agent'};
    /** The words the recipient reads instead of the standard agent-request framing (his thread reply), and the thread message it answers so its replies post there. */
    framing?:(id:string)=>string;forwardedReply?:{inboxInputId:string;topicId:string;authorKind?:'human'|'agent';messageThreadRootId?:string;messageThreadRequestId?:string}}) {
    if(this.stopped)throw new Error('Session communication is not accepting requests.');
    const client=this.client(input.peer);
    const effect=input.requestedEffect??'informational';
    const prior=()=>db.query('SELECT * FROM session_peer_requests WHERE source_input_id=? AND action_id=?').get(actor.inputId,input.action_id) as PeerRequestRow|null;
    const encode=(taskRef:ChatGptTask|null)=>JSON.stringify({peer:input.peer,answerGuaranteeVersion:1,...(input.provider?{provider:input.provider}:{address:input.address}),...(input.title===undefined?{}:{title:input.title}),...(input.summary===undefined?{}:{summary:input.summary}),text:input.text,
      ...(input.effort===undefined?{}:{effort:input.effort}),...(input.escalationReason===undefined?{}:{escalationReason:input.escalationReason}),...(input.project===undefined?{}:{project:input.project}),...(input.files===undefined?{}:{files:input.files}),
      ...(input.captureId===undefined?{}:{captureId:input.captureId}),...(input.attachments?{attachments:input.attachments}:{}),...(input.evidence?{evidence:input.evidence}:{}),...(input.machineNeed?{machineNeed:input.machineNeed}:{}),requestedEffect:effect,...(input.threadRoot?{thread:input.threadRoot}:{}),...(input.returnToRequester?{returnToRequester:true}:{}),
      ...(input.forwardedReply?{forwardedReply:input.forwardedReply,promptAnswer:true}:{}),...(input.routedFrom?{routedMessage:{sourceInputId:input.routedFrom.messageId},routedFrom:input.routedFrom}:{}),
      ...(taskRef?{taskRef}:{}),...(input.recoveryOf?{recoveryOf:input.recoveryOf}:{}),...(input.correctionOf?{correctionOf:input.correctionOf}:{})});
    const existingCorrection=input.correctionOf?prior():null;
    if(existingCorrection){
      const taskRef=input.forTask?parseChatGptTask(input.forTask):null;
      if(existingCorrection.payload_hash!==hash(encode(taskRef)))throw new Error('Idempotency conflict: this source/action already names a different request.');
      return this.receipt(existingCorrection);
    }
    let addressedRemote:string|null=null;
    let addressedProvider:string|null=null;
    if(input.address){
      let tuple:any=null;try{tuple=JSON.parse(Buffer.from(input.address.slice(8),'base64url').toString());}catch{}
      addressedRemote=Array.isArray(tuple)&&Number.isSafeInteger(tuple[1])?`concierge:${tuple[1]}`:null;
      const admitted=addressedRemote?db.query(`SELECT json_extract(payload_json,'$.provider') AS provider FROM session_peer_requests
        WHERE peer=? AND remote_session_id=? AND json_extract(payload_json,'$.provider') IS NOT NULL ORDER BY created_at_ms DESC LIMIT 1`)
        .get(input.peer,addressedRemote) as {provider:string}|null:null;
      addressedProvider=addressedRemote?this.cachedView(input.peer,addressedRemote)?.provider??admitted?.provider??null:null;
      if(addressedRemote&&!addressedProvider){
        try{
          const exact=await client.request<any>('GET',`/sessions/v1/sessions/${encodeURIComponent(addressedRemote)}/view`,undefined,8_000);
          const view=exact?.session;
          if(view?.id===addressedRemote&&view.address===input.address&&typeof view.provider==='string'&&view.provider){
            this.remember(input.peer,[view]);
            addressedProvider=view.provider;
          }
        }catch(error){this.note(input.peer,error);}
      }
      // An unknown addressed target could be ChatGPT. Before retaining the ask we need
      // its exact provider, but a missing catalogue cache alone is not a refusal.
      if(!addressedRemote||!addressedProvider)throw new Error('The addressed peer session needs a current discovered provider identity before this ask.');
    }
    const toChatGpt=input.provider==='chatgpt'||addressedProvider==='chatgpt';
    if((input.forTask||input.recoveryOf||input.correctionOf)&&!toChatGpt)throw new Error('--for-task, --recovery-of and --correction-of belong to a ChatGPT question.');
    if(toChatGpt&&input.threadRoot&&!input.returnToRequester)
      throw new Error('A ChatGPT question for a named thread must also return to its asking agent; add --return-to-requester.');
    const task:ChatGptTask|null=toChatGpt?resolveChatGptTask(actor.session,actor.inputId,input.forTask):null;
    if(input.correctionOf){
      if(input.recoveryOf||input.provider||!input.address||!input.forTask||!input.files?.length||input.attachments?.length||input.captureId)
        throw new Error('Peer attachment correction needs the original ChatGPT address, exact task and corrected --file.');
      const originalCorrection=this.row(input.correctionOf);
      const old=JSON.parse(originalCorrection.payload_json);
      const obligation=chatGptObligationForAttempt(input.correctionOf);
      if(originalCorrection.peer!==input.peer||originalCorrection.source_session_id!==actor.session
        ||originalCorrection.remote_session_id!==addressedRemote||originalCorrection.remote_address!==input.address
        ||originalCorrection.outcome!=='failed'||old.text!==input.text||old.taskRef?.kind!==task?.kind||old.taskRef?.id!==task?.id
        ||obligation?.obligation_id!==input.correctionOf||obligation.active_request_id!==input.correctionOf
        ||obligation.state!=='reconcile_receipt'||obligation.asker_session_id!==actor.session
        ||obligation.target_session_id!==`${input.peer}/${addressedRemote}`||obligation.question_text!==input.text)
        throw new Error('The original peer request does not own this failed ChatGPT question, task and target.');
      const oldHashes=new Set((old.files??[]).map((file:any)=>file.sha256));
      if(!input.files.some(file=>!oldHashes.has(createHash('sha256').update(Buffer.from(file.base64,'base64')).digest('hex'))))
        throw new Error('The correction needs at least one attached file with changed bytes.');
    }
    const encoded=encode(task);
    const digest=hash(encoded);
    const previous=prior();
    if(previous){if(previous.payload_hash!==digest)throw new Error('Idempotency conflict: this source/action already names a different request.');return this.receipt(previous);}
    const id=requestIdFor(actor.inputId,input.action_id);
    const owner=this.dependencies.owner;
    const captured=input.captureId?owner.inboxCaptureAttachments(input.captureId):[];
    const files=[...(input.files??[]),...[...(input.attachments??[]),...captured].map(attachmentId=>owner.attachment(attachmentId))]
      .map(({name,contentType,base64})=>({name,contentType,base64}));
    const sourceInput=getAcceptedSessionInput(actor.inputId)!;
    const provenance=sessionInputProvenance(sourceInput);
    const runId=nativeRunId(actor.turn);
    const continuedGrant=continuedWebAppAuthorization(actor,sourceInput,provenance,input);
    // A human message asking directly is its own originating human; a local walk would find it as the parent.
    const routedOriginal=input.routedFrom?.authorKind==='human'?getAcceptedSessionInput(input.routedFrom.messageId):null;
    const known=routedOriginal&&humanAuthored(routedOriginal)
      ?{inputId:routedOriginal.id,runId:routedOriginal.turn_id?nativeRunId(routedOriginal.turn_id):'',sessionId:`concierge:${routedOriginal.session_id}`,
        ...(JSON.parse(routedOriginal.payload_json).capture?.id?{captureId:JSON.parse(routedOriginal.payload_json).capture.id}:{})}
      :continuedGrant??provenance?.originatingHuman??(humanAuthored(sourceInput)
      ?{inputId:sourceInput.id,runId,sessionId:`concierge:${actor.session}`,...(JSON.parse(sourceInput.payload_json).capture?.id?{captureId:JSON.parse(sourceInput.payload_json).capture.id}:{})}:null);
    // Every identity leaving this instance is named by it (peer-identity.ts).
    const originatingHuman=known?{...known,sessionId:presentSessionForPeer(known.sessionId,this.self)}:null;
    const humanModelChoices=known?(['claude-fable-5-1','gpt-6-astra'] as const).filter(model=>
      humanChoseTopModel(known.inputId,model)
      ||(provenance?.originatingHuman?.inputId===known.inputId&&humanChoseTopModel(actor.inputId,model))):[];
    const providerSelector=parseProviderSelector(input.provider);
    const selectedModel=providerSelector?resolveProviderSelector(providerSelector).model:undefined;
    const humanModelChoice=!!selectedModel&&humanModelChoices.includes(selectedModel as 'claude-fable-5-1'|'gpt-6-astra');
    const text=input.framing?input.framing(id):`Session request ${id} from ${this.self}/concierge:${actor.session}, a session on the ${this.self} Concierge instance. ${input.routedFrom?`This carries Tejas’s exact Inbox message ${input.routedFrom.messageId} into this session. Reply to this request; the answer appears under that message in its original thread.`:'This is agent-authored input within the originating human task, not a new human message.'} Requested effect: ${effect}. Close it with sessions reply ${id}${effect==='work'?' --work-disposition completed|failed|needs_decision':''} --summary "<one line>". ${REQUEST_PROTOCOL_POINTER}\n\n${input.text}`;
    const delivery={requestId:id,answerGuaranteeVersion:1,
      ...(task?{answerObligation:{id:input.correctionOf??input.recoveryOf??id,task,attemptId:id}}:{}),
      origin:{peer:this.self,sessionId:`concierge:${actor.session}`,inputId:actor.inputId,runId,originatingHuman,effectScope:provenance?.effectScope??null},
      ...(humanModelChoices.length?{humanModelChoices}:{}),
      ...(input.provider?{provider:input.provider,...(input.effort===undefined?{}:{effort:input.effort}),...(input.escalationReason===undefined?{}:{escalationReason:input.escalationReason}),...(humanModelChoice?{humanModelChoice:selectedModel}:{}),...(input.project===undefined?{}:{project:input.project}),...(input.title===undefined?{}:{title:input.title}),...(input.summary===undefined?{}:{summary:input.summary})}:{address:input.address}),
      text,message:input.text,requestedEffect:effect,...(input.machineNeed?{machineNeed:input.machineNeed}:{}),...(input.forwardedReply?{forwardedReply:input.forwardedReply,promptAnswer:true}:{}),
      ...(input.routedFrom?{routedFrom:input.routedFrom}:{}) ,...(input.correctionOf?{correctionOf:input.correctionOf}:{}),...(files.length?{files}:{})};
    const retain=(accepted:{sessionId:string;address:string;operationId:string},queued:boolean)=>db.transaction(()=>{
      const raced=prior();
      if(raced){if(raced.payload_hash!==digest)throw new Error('Idempotency conflict: this source/action already names a different request.');return;}
      const now=this.now();
      db.query(`INSERT INTO session_peer_requests(request_id,peer,source_session_id,source_turn_id,source_input_id,action_id,payload_json,payload_hash,remote_session_id,remote_address,remote_operation_id,delivery_json,status,due_at_ms,created_at_ms,thread_root_input_id,topic_root_input_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.peer,actor.session,actor.turn,actor.inputId,input.action_id,JSON.stringify({...JSON.parse(encoded),files:files.map(({name,contentType,base64})=>({name,contentType,sha256:createHash('sha256').update(Buffer.from(base64,'base64')).digest('hex')}))}),digest,accepted.sessionId,accepted.address,accepted.operationId,queued?JSON.stringify(delivery):null,queued?'queued_offline':'recorded',now+(input.forwardedReply?PROMPT_ANSWER_REMINDER_MS:DUE_MS),now,input.threadRoot??null,input.routedFrom?.root??topicRootFor(input.threadRoot,actor.inputId)??'');
      if(task){
        bindDirectChatGptTaskSource(task,actor.inputId,actor.session);
        const targetSessionId=addressedRemote?`${input.peer}/${addressedRemote}`:`${input.peer}/request:${id}`;
        // A correction retains its new request while the original duty stays active.
        // The target's exact proof and acceptance activate its replacement attempt.
        if(input.recoveryOf)admitChatGptContextFollowUp({requestId:id,obligationId:input.recoveryOf,task,
          askerSessionId:actor.session,targetSessionId,now});
        else if(!input.correctionOf)admitChatGptObligation({requestId:id,task,askerSessionId:actor.session,question:input.text,targetSessionId,now});
      }
      const operation=retainSessionInput({sessionId:actor.session,scope:`communication:${actor.inputId}`,actionId:input.action_id,kind:'request',origin:'agent',
        payload:{text:input.text,sourceInputId:actor.inputId,sourceRunId:runId,peer:input.peer,targetSessionId:this.presentedSession(input.peer,accepted.sessionId),targetAddress:accepted.address,
          ...(input.provider?{targetProvider:input.provider}:{}),...(input.title===undefined?{}:{title:input.title}),afterRequestIds:[],requestedEffect:effect,...(input.evidence?{evidence:input.evidence}:{}),...(queued?{queuedOffline:true}:{})},
        sourceInputId:actor.inputId,sourceRunId:runId,requestId:id}).input;
      recordSessionEvent({eventId:`request:${id}`,sessionId:actor.session,inputId:operation.id,turnId:actor.turn,kind:'request',payload:{requestId:id,peer:input.peer,targetSessionId:this.presentedSession(input.peer,accepted.sessionId),...(input.threadRoot?{threadSourceMessageId:input.threadSourceMessageId}:{})}});
      if(input.routedFrom){
        recordSessionMessageRoute({sourceMessageId:input.routedFrom.messageId,
          destinationSessionId:this.presentedSession(input.peer,accepted.sessionId),destinationMessageId:`request:${id}`,requestId:id,
          actor:{sessionId:actor.session,turnId:actor.turn,inputId:actor.inputId,runId}});
        if(effect==='work')linkInboxDispatchWork({topicId:input.routedFrom.topicId,sourceMessageId:input.routedFrom.messageId,
          dispatchId:id,targetSessionId:this.presentedSession(input.peer,accepted.sessionId),summary:input.summary??input.routedFrom.title,
          brief:input.routedFrom.originalText});
      }
      if(input.forwardedReply?.authorKind==='human')linkForwardedReplyWork(input.forwardedReply.topicId,id);
    })();
    const queuedAddress=()=>{
      // An addressed session is known before its peer wakes; a new session is not.
      let tuple:any=null;try{tuple=JSON.parse(Buffer.from((input.address??'').slice(8),'base64url').toString());}catch{}
      return {sessionId:Array.isArray(tuple)&&Number.isSafeInteger(tuple[1])?`concierge:${tuple[1]}`:'',address:input.address??'',operationId:`request:${id}`};
    };
    // The owner retains every peer ask, including the exact ChatGPT obligation, before
    // network contact. A crash or lost HTTP response can only replay this same request ID.
    retain(queuedAddress(),true);
    this.wake();
    return this.receipt(this.row(id));
  }
  receipt(row:PeerRequestRow) {
    const remote=row.remote_status_json?JSON.parse(row.remote_status_json):null;
    const execution=remote?.execution;
    const queued=row.status==='queued_offline';
    return {request_id:row.request_id,status:row.status,outcome:row.outcome,peer:row.peer,source_session_id:`concierge:${row.source_session_id}`,
      availability:queued?{...this.availability(row.peer),note:`This ask is retained here for dispatch to ${row.peer}; no peer receipt is confirmed yet.`}:this.availability(row.peer),
      target_address:row.remote_address?this.presentedAddress(row.peer,row.remote_address):null,target:row.remote_session_id?this.cachedView(row.peer,row.remote_session_id):null,target_session_id:row.remote_session_id?this.presentedSession(row.peer,row.remote_session_id):null,target_input_id:row.remote_operation_id,
      operation_id:(db.query("SELECT id FROM session_inputs WHERE request_id=? AND kind='request' ORDER BY rowid LIMIT 1").get(row.request_id) as {id:string}|null)?.id??null,
      routed_request_id:null,target_turn_id:null,due_at_ms:row.due_at_ms,overdue_at_ms:row.overdue_at_ms,result:row.result_json?JSON.parse(row.result_json):null,
      remote:remote?{inputState:remote.inputState,inputError:remote.inputError??null,stillWorking:remote.stillWorking,observedAt:remote.observedAt}:null,
      execution:execution?{turn_id:execution.turnId,run_id:execution.runId,input_kind:execution.steeringStatus?'steering':'turn',input_status:execution.steeringStatus??execution.status,acknowledged_at:execution.acknowledgedAt??null,provider_turn_id:null,peer:row.peer}:null,
      events:(db.query('SELECT * FROM session_peer_events WHERE request_id=? ORDER BY rowid').all(row.request_id) as PeerEventRow[])
        .map(event=>({event_id:event.event_id,kind:event.kind,status:event.status,error:event.error,payload:JSON.parse(event.payload_json),routed_request_id:null}))};
  }
  inspect(requestId:string){return this.receipt(this.row(requestId));}
  get(actor:PeerActor,requestId:string) {
    if(this.owns(requestId)){const row=this.row(requestId);if(row.source_session_id!==actor.session)throw new Error('Request is outside this session.');return this.receipt(row);}
    const delivery=this.delivery(requestId);
    if(delivery.target_session_id!==actor.session)throw new Error('Request is outside this session.');
    return this.deliveryReceipt(delivery);
  }
  cancel(actor:PeerActor,requestId:string,actionId:string,reason?:string) {
    const row=this.row(requestId);
    if(row.source_session_id!==actor.session)throw new Error('Only the requesting session can cancel this request.');
    db.transaction(()=>{
      const retained=retainSessionInput({sessionId:actor.session,scope:`communication:${actor.inputId}`,actionId,kind:'cancel',origin:'agent',
        payload:{requestId,sourceInputId:actor.inputId,sourceRunId:nativeRunId(actor.turn),...(reason?{reason}:{})},sourceInputId:actor.inputId,sourceRunId:nativeRunId(actor.turn),requestId});
      if(retained.duplicate)return;
      db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({state:'completed'}),retained.input.id);
      if(!row.outcome)this.settle(row,'canceled','The requesting session canceled this request. The worker on the peer is told to stop.');
      withdrawCanceledChatGptAttempt(requestId,this.now());
    })();
    // The peer may still be accepting a queued-offline delivery. Keep revocation owed
    // until that acceptance is recorded and the peer acknowledges cancellation.
    if(!row.outcome)this.schedule(`cancel:${requestId}`,()=>this.revokeCanceledRemote(requestId));
    return this.receipt(this.row(requestId));
  }
  private async revokeCanceledRemote(requestId:string) {
    const row=this.row(requestId);
    if(row.outcome!=='canceled'||!row.remote_operation_id
      ||JSON.parse(row.remote_status_json??'{}').cancellationAcknowledged)return;
    const acknowledge=()=>{
      db.query(`UPDATE session_peer_requests SET remote_status_json=json_set(coalesce(remote_status_json,'{}'),'$.cancellationAcknowledged',1)
        WHERE request_id=? AND outcome='canceled'`).run(requestId);
    };
    const client=this.dependencies.clients.get(row.peer);
    if(!client)return;
    try {
      await client.request('POST',`/sessions/v1/peers/requests/${encodeURIComponent(requestId)}/cancel`,{});
      acknowledge();
    } catch(error) {
      // A peer that explicitly has no delivery has no execution authority left to
      // revoke. This is different from the origin's own final cancellation event.
      if(error instanceof PeerError&&error.status===404&&error.message==='Unknown session request.'){
        acknowledge();
        log('info','session_peer_cancel_absent',{request_id:requestId,peer:row.peer});
        return;
      }
      log('warn','session_peer_cancel_unsent',{request_id:requestId,peer:row.peer,...errorFields(error)});
    }
  }
  private event(row:PeerRequestRow,kind:PeerEventRow['kind'],payload:unknown,eventId=randomUUID()) {
    if(db.query('SELECT 1 FROM session_peer_events WHERE event_id=?').get(eventId))return eventId;
    db.query('INSERT INTO session_peer_events(event_id,request_id,kind,payload_json,created_at_ms) VALUES(?,?,?,?,?)').run(eventId,row.request_id,kind,JSON.stringify(payload),this.now());
    recordSessionEvent({eventId,sessionId:row.source_session_id,inputId:row.source_input_id,kind:'response',payload:{requestId:row.request_id,kind,...payload as object}});
    const session=getSessionById(row.source_session_id)!;
    updateSessionMetadata(session.id,{generation:(sessionMetadata(session).generation??0)+1});
    // Commit the thread post beside the reply, before any requester can run.
    const event=db.query('SELECT * FROM session_peer_events WHERE event_id=?').get(eventId) as PeerEventRow;
    if((kind==='overdue'||this.postThreadEvent(row,event,JSON.parse(event.payload_json)))&&!returnsToRequester(row,event))
      db.query("UPDATE session_peer_events SET status='received',error=NULL WHERE event_id=?").run(eventId);
    return eventId;
  }
  private settle(row:PeerRequestRow,outcome:string,text:string,output:unknown=null,disposition:WorkDisposition|null=null) {
    const requestPayload=JSON.parse(row.payload_json);
    if(requestPayload.answerGuaranteeVersion===1&&requestPayload.requestedEffect==='work'&&row.status!=='queued_offline'){
      const remote=row.remote_status_json?JSON.parse(row.remote_status_json):null;
      if(remote?.answerGuaranteeVersion!==1||remote.answerTaskReady!==true){
        const eventId=`peer-answer-settlement-hold:${row.request_id}`;
        if(!db.query('SELECT 1 FROM session_peer_events WHERE event_id=?').get(eventId))
          this.event(row,'overdue',{text:`The ${row.peer} work request ${row.request_id} cannot close as ${outcome} until that peer confirms its exact task has no unresolved ChatGPT answers. Its failed attempt and original request remain held for recovery.`,
            health:'peer task answer reconciliation',agentReminder:true},eventId);
        return false;
      }
    }
    db.transaction(()=>{
      if(this.row(row.request_id).outcome)return;
      const payload={outcome,text,output,responding_session_id:this.presentedSession(row.peer,row.remote_session_id),...(disposition?{workDisposition:disposition}:{})};
      const final=this.currentFinal(row.request_id);
      if(final){
        const declared=JSON.parse(final.payload_json);
        if(declared.workDisposition!=='completed')throw new Error('A final reply already exists for this request.');
        // The result keeps the files that reply carried.
        db.query("UPDATE session_peer_requests SET status='settled',outcome=?,result_json=? WHERE request_id=?").run(outcome,JSON.stringify({...payload,...(declared.attachments?.length?{attachments:declared.attachments}:{}),event_id:final.event_id,declaredDisposition:'completed'}),row.request_id);
        recordChatGptAttemptResult({requestId:row.request_id,outcome,answerEventId:final.event_id,now:this.now(),reason:text});
        return;
      }
      const event_id=this.event(row,'final',payload);
      db.query("UPDATE session_peer_requests SET status='settled',outcome=?,result_json=? WHERE request_id=?").run(outcome,JSON.stringify({...payload,event_id}),row.request_id);
      recordChatGptAttemptResult({requestId:row.request_id,outcome,answerEventId:event_id,now:this.now(),reason:text});
    })();
    this.wake();
    return true;
  }
  /** A reply the peer's recipient forwarded here; the peer's own reply ledger already holds it. */
  receiveReply(requestId:string,body:unknown) {
    const input=object(body);
    const row=this.row(requestId);
    if(input.responder?.peer!==row.peer)throw new SessionOwnerError('This reply does not come from the request’s peer.',403,'PEER_MISMATCH');
    const recorded=this.recordReply(row,input);
    this.wake();
    // The recipient marks its reply forwarded only on this event-specific answer; a reply this
    // instance refused used to be acknowledged with the request's outcome and was lost silently.
    return {outcome:this.row(requestId).outcome,eventId:input.eventId,...recorded};
  }
  /** Whether this instance now holds the reply: recorded, already held, or refused with the reason. */
  private recordReply(row:PeerRequestRow,input:Record<string,any>):{recorded:'recorded'|'duplicate'|'refused';reason?:string} {
    const requestId=row.request_id;
    if(input.turnOutcome==='needs_you'){
      if(typeof input.eventId!=='string'||!input.eventId.startsWith('turn_outcome:action:')||input.kind!=='progress'
        ||typeof input.text!=='string'||!input.text.trim()||input.files!==undefined
        ||input.responder?.sessionId!==row.remote_session_id||typeof input.responder?.runId!=='string'||!input.responder.runId
        ||typeof input.responder?.inputId!=='string'||!input.responder.inputId)
        throw new SessionOwnerError('A peer turn question needs its exact outcome, session, input and run.');
      return db.transaction(()=>{
        if(db.query('SELECT 1 FROM session_peer_events WHERE event_id=?').get(input.eventId))return {recorded:'duplicate' as const};
        this.event(row,'progress',{text:input.text.trim().slice(0,2000),turnOutcome:'needs_you',
          source:{peer:row.peer,input_id:input.responder.inputId,run_id:input.responder.runId},
          responding_session_id:this.presentedSession(row.peer,row.remote_session_id)},input.eventId);
        return {recorded:'recorded' as const};
      })();
    }
    if(input.files!==undefined&&(!Array.isArray(input.files)||input.files.some((file:any)=>typeof file?.name!=='string'||typeof file?.contentType!=='string'||typeof file?.base64!=='string')))throw new SessionOwnerError('Files must contain named attachment bytes.');
    // A reply carrying files is a message even without words.
    if(typeof input.eventId!=='string'||!input.eventId||!['progress','final'].includes(input.kind)||typeof input.text!=='string'||(!input.text.trim()&&!input.files?.length&&!(input.kind==='final'&&input.replyBody==='')))throw new SessionOwnerError('A reply needs an event ID, kind and either text or a file.');
    const final=input.kind==='final';
    const disposition:WorkDisposition|undefined=input.workDisposition;
    if(final&&JSON.parse(row.payload_json).answerGuaranteeVersion===1){
      const proof=input.settlementProof;
      const remote=row.remote_status_json?JSON.parse(row.remote_status_json):null;
      const preUpgradeReceipt=remote?.answerGuaranteeVersion===1&&remote.acceptedAnswerGuaranteeVersion===null
        &&remote.answerTaskReady===true&&remote.requestId===requestId&&remote.sessionId===row.remote_session_id;
      const citedOpen=Array.isArray(proof?.openObligationIds)&&proof.openObligationIds.length>0
        &&proof.openObligationIds.every((id:unknown)=>typeof id==='string'&&id.length>0)
        &&new Set(proof.openObligationIds).size===proof.openObligationIds.length
        &&proof.unresolvedObligations===proof.openObligationIds.length
        &&(disposition==='failed'||disposition==='needs_decision');
      if(!preUpgradeReceipt&&(proof?.version!==1||proof.requestId!==requestId||proof.recipientPeer!==row.peer
        ||proof.targetSessionId!==row.remote_session_id||!(proof.unresolvedObligations===0||citedOpen)))
        return {recorded:'refused',reason:'The peer final did not prove its exact task has no unresolved ChatGPT answers.'};
    }
    const requestPayload=JSON.parse(row.payload_json);
    const requestedEffect=requestPayload.requestedEffect;
    if(input.alsoMainThread&&!requestPayload.forwardedReply?.messageThreadRootId)
      throw new SessionOwnerError('--also-main-thread belongs to a reply inside one agent message thread.');
    if(input.alsoMainThread&&final&&input.replyBody===''&&!input.files?.length)
      throw new SessionOwnerError('--also-main-thread needs new answer words or a file to copy into the main thread.');
    if(input.notify){
      const root=inboxRequestRoot(db,row.request_id,row.thread_root_input_id);
      const inbox=getSessionById(row.source_session_id);
      if(!root||!inbox||!sessionMetadata(inbox).inbox||!topicOfRoot(root))
        throw new SessionOwnerError('--notify requires a reply that posts into an Inbox thread.');
    }
    const promptAnswer=!!requestPayload.promptAnswer;
    if(final&&input.replyBody===''&&!input.files?.length){
      const answer=db.query(`SELECT json_extract(payload_json,'$.answersQuestion') AS marked,json_extract(payload_json,'$.text') AS text FROM session_peer_events
        WHERE request_id=? AND kind='progress' AND (json_extract(payload_json,'$.answersQuestion')=1 OR json_extract(payload_json,'$.answerMarkDropped')=1)
        ORDER BY rowid DESC LIMIT 1`).get(requestId) as {marked:number|null;text:string|null}|null;
      if(!answer)throw new SessionOwnerError('A final reply without a body needs an earlier prompt answer to this request.');
      // The Mac accepted this bodyless final because its own copy of the answer kept the mark this
      // origin dropped; the answer's words become the final's body so the requester still reads them.
      if(answer.marked!==1)input={...input,replyBody:String(answer.text??'')};
    }
    // An answer is never refused for its mark: one that has no thread to answer in is kept as
    // ordinary progress. Refusing it here would lose the Mac agent's reply altogether.
    let answerMarkDropped=false;
    if(input.answersQuestion&&(final||!input.text.trim()||!promptAnswer&&!this.answersInThread(row))){
      log('info','session_peer_answer_mark_dropped',{request_id:requestId,peer:row.peer,event_id:input.eventId});
      input={...input,answersQuestion:false};
      answerMarkDropped=!final;
    }
    if(disposition!==undefined&&(!final||requestedEffect!=='work'||!['completed','failed','needs_decision'].includes(disposition)))throw new SessionOwnerError('A work disposition requires a final reply to a work request.');
    const result=db.transaction(():{recorded:'recorded'|'duplicate'|'refused';reason?:string}=>{
      if(db.query('SELECT 1 FROM session_peer_events WHERE event_id=?').get(input.eventId))return {recorded:'duplicate'};
      // The owner's own inference from a finished turn is not the recipient's word: a recipient
      // still working past it can answer, and that answer returns to the requester.
      const current=this.currentFinal(requestId);
      const inferred=isInferredFinal(current)?current:null;
      if(this.row(requestId).outcome&&!inferred)return {recorded:'refused',reason:`This request already has a final disposition (${this.row(requestId).outcome}).`};
      if(final&&current&&!inferred)return {recorded:'refused',reason:'This request already has a final reply.'};
      // The peer's bytes become this instance's own custody, keyed by request, event and
      // position, so a re-forward of the same reply reuses it instead of duplicating it.
      const attachments=((input.files??[]) as {name:string;contentType:string;base64:string}[])
        .map((file,index)=>this.dependencies.owner.upload({name:file.name,contentType:file.contentType,base64:file.base64,
          clientActionId:`peer-reply-file:${requestId}:${input.eventId}:${index}`}).attachment.id);
      const payload={text:input.text,final,source:{peer:row.peer,input_id:input.responder?.inputId,run_id:input.responder?.runId},responding_session_id:this.presentedSession(row.peer,input.responder?.sessionId??row.remote_session_id),
        ...(final?{settlementProof:input.settlementProof}:{}),
        ...(input.replyBody!==undefined?{replyBody:input.replyBody}:{}),...(input.closingLine?{closingLine:input.closingLine}:{}),...(input.answerGroup?{answerGroup:input.answerGroup}:{}),
        ...(input.answersQuestion?{answersQuestion:true}:{}),...(answerMarkDropped?{answerMarkDropped:true}:{}),...(input.notify?{notify:true}:{}),...(input.alsoMainThread?{alsoMainThread:true}:{}),
        ...(attachments.length?{attachments}:{}),
        ...(disposition?{workDisposition:disposition,completionTurnId:input.completionTurnId??null}:{}),...(input.evidence?{evidence:input.evidence}:{}),
        ...(typeof input.handBack==='string'&&input.handBack?{handBack:input.handBack}:{}),
        ...(disposition==='completed'&&typeof input.quiet==='string'&&input.quiet.trim()?{quiet:input.quiet.trim().slice(0,2000)}:{})};
      if(final&&inferred)db.query('UPDATE session_peer_events SET superseded_by_event_id=? WHERE event_id=?').run(input.eventId,inferred.event_id);
      const id=this.event(row,final?'final':'progress',payload,input.eventId);
      if(promptAnswer&&(final||input.answersQuestion))db.query('UPDATE session_peer_requests SET prompt_answered_at_ms=?,due_at_ms=? WHERE request_id=? AND prompt_answered_at_ms IS NULL')
        .run(this.now(),this.now()+DUE_MS,requestId);
      if(final){
        // Declared completion settles when the reply arrives, not when the peer's run ends.
        const outcome=disposition==='failed'?'failed':disposition==='needs_decision'?'decision_needed':disposition==='completed'?'answered':requestedEffect==='work'?'undetermined':'answered';
        db.query('UPDATE session_peer_requests SET outcome=?,status=?,result_json=? WHERE request_id=?').run(outcome,'settled',JSON.stringify({...payload,event_id:id}),requestId);
        // As for a server agent: its final reply ends the questions it asked for this work.
        if(disposition)expireQuestionsForFinalReply({workerSessionId:payload.responding_session_id,requestId,disposition,reason:String(input.text).trim().slice(0,200)});
      }
      log('info','session_peer_reply_recorded',{request_id:requestId,peer:row.peer,kind:input.kind,event_id:input.eventId,...(final&&inferred?{superseded_event_id:inferred.event_id}:{})});
      return {recorded:'recorded'};
    })();
    if(result.recorded==='refused')log('warn','session_peer_reply_refused',{request_id:requestId,peer:row.peer,kind:input.kind,event_id:input.eventId,reason:result.reason});
    return result;
  }
  /**
   * Record a reply read from the peer's status. A reply with files is fetched whole first, because
   * recording its event ID from the summary would make the later full push a duplicate and lose
   * the files. When that fetch fails the event stays unrecorded: an ordinary pull leaves it to the
   * peer's push, and historical recovery (whose replies the peer will never push again) throws so
   * the peer stays in `unrecovered` and the whole reply is fetched on a later attempt.
   */
  private async pullReply(client:PeerClient,row:PeerRequestRow,reply:any,historical:boolean) {
    const responder={peer:row.peer,sessionId:row.remote_session_id,inputId:reply.sourceInputId??null,runId:reply.sourceRunId??null};
    if(!reply.files)return this.recordReply(this.row(row.request_id),{eventId:reply.eventId,kind:reply.kind,text:reply.text,turnOutcome:reply.turnOutcome,replyBody:reply.replyBody,closingLine:reply.closingLine,answerGroup:reply.answerGroup,answersQuestion:reply.answersQuestion??undefined,notify:reply.notify===true,alsoMainThread:reply.alsoMainThread===true,workDisposition:reply.workDisposition??undefined,settlementProof:reply.settlementProof,completionTurnId:reply.completionTurnId??null,evidence:reply.evidence??undefined,handBack:reply.handBack??undefined,quiet:reply.quiet??undefined,responder});
    let whole:any;
    try {whole=await client.request<any>('GET',`/sessions/v1/peers/requests/${encodeURIComponent(row.request_id)}/replies/${encodeURIComponent(reply.eventId)}`,undefined,OWNER_READ_RESPONSE_MS,true,this.peerReadController.signal);}
    catch(error) {
      if(this.stopped)return null;
      log('warn','session_peer_reply_fetch_failed',{request_id:row.request_id,peer:row.peer,event_id:reply.eventId,historical,...errorFields(error)});
      if(historical)throw error;
      return null;
    }
    if(this.stopped)return null;
    return this.recordReply(this.row(row.request_id),whole);
  }
  /** The request's final that still stands; a superseded inference is history. */
  private currentFinal(requestId:string){
    return db.query("SELECT * FROM session_peer_events WHERE request_id=? AND kind='final' AND superseded_by_event_id IS NULL").get(requestId) as PeerEventRow|null;
  }
  async notified(requestId:string) {
    const row=this.row(requestId);
    await this.dispatch(row);
    return {outcome:this.row(requestId).outcome};
  }
  private activatePeerAttachmentCorrection(row:PeerRequestRow,accepted:any) {
    const payload=JSON.parse(row.payload_json);
    const originalId=payload.correctionOf;
    if(!originalId)return;
    if(accepted?.attachmentCorrectionVersion!==1||accepted.correctionOf!==originalId
      ||accepted.answerGuaranteeVersion!==1||typeof accepted.originalRunId!=='string'||!accepted.originalRunId
      ||typeof accepted.reason!=='string'||!accepted.reason.startsWith('CHATGPT_ATTACHMENT_REJECTED:'))
      throw new Error('The peer did not prove its original pre-Send attachment rejection for this correction.');
    const original=this.row(originalId);
    if(original.remote_session_id!==accepted.sessionId||original.remote_address!==accepted.address)
      throw new Error('The peer correction target changed from the original request.');
    admitChatGptAttachmentCorrection({requestId:row.request_id,obligationId:originalId,task:payload.taskRef,
      askerSessionId:row.source_session_id,targetSessionId:`${row.peer}/${accepted.sessionId}`,question:payload.text,
      originalRunId:accepted.originalRunId,reason:accepted.reason,now:this.now()});
    // A fast peer answer may have been recorded while this admission response was in flight.
    // Reapply its exact retained result after the new attempt mapping exists.
    const current=this.row(row.request_id);
    if(current.outcome){
      const result=current.result_json?JSON.parse(current.result_json):{};
      recordChatGptAttemptResult({requestId:row.request_id,outcome:current.outcome,
        answerEventId:typeof result.event_id==='string'?result.event_id:undefined,now:this.now()});
      if(typeof result.event_id==='string'){
        const event=db.query('SELECT accepted_input_id,status FROM session_peer_events WHERE event_id=?').get(result.event_id) as {accepted_input_id:string|null;status:string}|null;
        if(event?.status==='received'&&event.accepted_input_id)
          recordChatGptReturnReceipt({eventId:result.event_id,returnInputId:event.accepted_input_id,now:this.now()});
      }
    }
  }
  private async dispatch(row:PeerRequestRow) {
    if(row.outcome||this.stopped)return;
    const client=this.dependencies.clients.get(row.peer);
    if(!client){if(row.status!=='version_hold')this.settle(row,'failed',`Peer ${row.peer} is no longer configured on this instance.`);return;}
    // Reconcile the original request ID after a peer upgrade. The old acceptance is never
    // replayed; the upgraded receiver checks the exact retained task, including legacy asks.
    if(row.status==='version_hold'){
      try{
        const remote=await client.request<any>('GET',`/sessions/v1/peers/requests/${encodeURIComponent(row.request_id)}`,undefined,OWNER_READ_RESPONSE_MS,true,this.peerReadController.signal);
        if(this.stopped)return;
        if(remote?.answerGuaranteeVersion!==1)return;
        db.transaction(()=>{
          db.query("UPDATE session_peer_requests SET status='recorded',remote_status_json=?,delivery_json=NULL WHERE request_id=? AND status='version_hold'")
            .run(JSON.stringify(remote),row.request_id);
          bindChatGptPeerTarget(row.request_id,`${row.peer}/${remote.sessionId}`,this.now());
        })();
        row=this.row(row.request_id);
      }catch(error){if(!this.stopped)this.note(row.peer,error);return;}
    }
    if(row.status==='queued_offline'){
      if(!row.delivery_json){this.settle(row,'failed','The queued delivery body is missing.');return;}
      const queuedDelivery=JSON.parse(row.delivery_json);
      if(queuedDelivery.correctionOf){
        const original=chatGptObligationForAttempt(queuedDelivery.correctionOf);
        if(!original||original.state==='withdrawn_by_tejas'||original.state==='resolved'){
          if(row.remote_status_json===null){
            this.settle(row,'canceled','The original ChatGPT answer duty is no longer open, so this corrected request was not sent.');
            return;
          }
          // A prior POST may have reached the peer despite a lost response. Inspect that
          // same request ID; never issue another corrected browser send after withdrawal.
          try{
            const remote=await client.request<any>('GET',`/sessions/v1/peers/requests/${encodeURIComponent(row.request_id)}`,undefined,OWNER_READ_RESPONSE_MS,true,this.peerReadController.signal);
            if(this.stopped)return;
            if(remote?.requestId===row.request_id&&typeof remote.sessionId==='string'){
              this.settle(row,'canceled','The original answer duty ended after this exact corrected request may have reached the peer.');
              db.query('UPDATE session_peer_requests SET remote_session_id=?,remote_address=?,remote_status_json=?,delivery_json=NULL WHERE request_id=?')
                .run(remote.sessionId,remote.address??row.remote_address,JSON.stringify(remote),row.request_id);
              await this.revokeCanceledRemote(row.request_id);
              return;
            }
          }catch(error){if(this.stopped)return;this.note(row.peer,error);}
          const eventId=`peer-correction-withdrawn-uncertain:${row.request_id}`;
          if(!db.query('SELECT 1 FROM session_peer_events WHERE event_id=?').get(eventId))
            this.event(row,'overdue',{text:`The original ChatGPT duty ended while corrected request ${row.request_id} had an uncertain peer admission. Its exact receipt still needs reconciliation; no replacement send will occur.`,
              health:'peer correction admission uncertain',agentReminder:true},eventId);
          return;
        }
        db.query("UPDATE session_peer_requests SET remote_status_json=coalesce(remote_status_json,?) WHERE request_id=? AND status='queued_offline'")
          .run(JSON.stringify({admissionAttemptedAtMs:this.now()}),row.request_id);
        row=this.row(row.request_id);
      }
      let accepted:any;
      try{
        const delivery=queuedDelivery;
        accepted=await client.request('POST',delivery.correctionOf?'/sessions/v1/peers/requests/corrected-attachment':'/sessions/v1/peers/requests',delivery);
        if(delivery.correctionOf)this.activatePeerAttachmentCorrection(row,accepted);
        this.unreachable.delete(row.peer);
      }
      catch(error){
        this.note(row.peer,error);
        // A rejected or interrupted HTTP exchange is not proof that the receiver did not
        // retain this request. Keep its original ID and body for idempotent reconciliation.
        if(error instanceof PeerError&&error.kind!=='unreachable'){
          const eventId=`peer-admission-uncertain:${row.request_id}`;
          if(!db.query('SELECT 1 FROM session_peer_events WHERE event_id=?').get(eventId))
            this.event(row,'overdue',{text:`The ${row.peer} admission for request ${row.request_id} returned an error. Its exact request is retained for reconciliation; no new request identity will be sent. ${error.message}`,
              health:'peer admission uncertain',agentReminder:true},eventId);
        }
        return;
      }
      if(typeof accepted?.sessionId!=='string'||typeof accepted.address!=='string'||typeof accepted.operationId!=='string')
        throw new Error('The peer did not return the exact accepted session and operation.');
      if(accepted.answerGuaranteeVersion!==1){
        db.transaction(()=>{
          db.query("UPDATE session_peer_requests SET remote_session_id=?,remote_address=?,remote_operation_id=?,status='version_hold' WHERE request_id=? AND status='queued_offline'")
            .run(accepted.sessionId,accepted.address,accepted.operationId,row.request_id);
          holdChatGptPeerVersion(row.request_id,this.now());
          this.event(row,'overdue',{text:`${row.peer} accepted request ${row.request_id} without the answer-obligation version. The request remains open for exact receipt reconciliation after that peer upgrades; it will not be sent again.`,
            health:'peer answer guarantee unconfirmed',agentReminder:true});
        })();
        this.wake();
        return;
      }
      db.transaction(()=>{
        db.query("UPDATE session_peer_requests SET remote_session_id=?,remote_address=?,remote_operation_id=?,delivery_json=NULL,status='recorded' WHERE request_id=? AND status='queued_offline'")
          .run(accepted.sessionId,accepted.address,accepted.operationId,row.request_id);
        bindChatGptPeerTarget(row.request_id,`${row.peer}/${accepted.sessionId}`,this.now());
        recordSessionEvent({eventId:`peer-delivered:${row.request_id}`,sessionId:row.source_session_id,inputId:row.source_input_id,kind:'response',
          payload:{requestId:row.request_id,kind:'progress',text:`${row.peer} is back; the queued request was delivered to ${this.presentedSession(row.peer,accepted.sessionId)}.`}});
      })();
      log('info','session_peer_request_delivered_late',{request_id:row.request_id,peer:row.peer});
      // His thread reply the Mac has now taken: its message stops saying it is queued.
      if(JSON.parse(row.payload_json).forwardedReply)db.query("UPDATE session_inputs SET receipt_json=json_remove(receipt_json,'$.statusDetail'),updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.source_input_id);
      row=this.row(row.request_id);
      if(row.outcome==='canceled'){
        await this.revokeCanceledRemote(row.request_id);
        return;
      }
    }
    let remote:any;
    try {remote=await client.request('GET',`/sessions/v1/peers/requests/${encodeURIComponent(row.request_id)}`,undefined,OWNER_READ_RESPONSE_MS,true,this.peerReadController.signal);this.unreachable.delete(row.peer);}
    catch(error) {
      if(this.stopped)return;
      this.note(row.peer,error);
      if(error instanceof PeerError&&error.kind==='refused'&&error.status===404){this.settle(row,'failed','The peer no longer holds this request; its target session was not found.');return;}
      log('warn','session_peer_request_unavailable',{request_id:row.request_id,peer:row.peer,...errorFields(error)});
      return;
    }
    if(this.stopped)return;
    remote={...remote,observedAt:new Date(this.now()).toISOString()};
    if(JSON.parse(row.payload_json).answerGuaranteeVersion===1&&remote.answerGuaranteeVersion!==1){
      db.transaction(()=>{
        db.query("UPDATE session_peer_requests SET status='version_hold',remote_status_json=? WHERE request_id=? AND outcome IS NULL")
          .run(JSON.stringify(remote),row.request_id);
        holdChatGptPeerVersion(row.request_id,this.now());
        this.event(row,'overdue',{text:`${row.peer} reported request ${row.request_id} without the answer-obligation version. Its exact effect is held for reconciliation; no replacement send is made.`,
          health:'peer answer guarantee unconfirmed',agentReminder:true});
      })();
      this.wake();
      return;
    }
    void this.refreshCatalogue(row.peer);
    // Polled on every wake: rewrite only what changed, ignoring the poll's own timestamp, so an
    // unchanged peer request is not a commit the database's other writers queue behind.
    db.query(`UPDATE session_peer_requests SET remote_status_json=?1,status=?2 WHERE request_id=?3 AND outcome IS NULL
      AND (status IS NOT ?2 OR remote_status_json IS NULL OR json_remove(remote_status_json,'$.observedAt') IS NOT json_remove(?1,'$.observedAt'))`)
      .run(JSON.stringify(remote),remote.execution?'admitted':remote.inputState==='failed'?'failed':'recorded',row.request_id);
    // His thread reply on a Mac agent says what that agent is doing with it, as a server agent's does.
    if(JSON.parse(row.payload_json).forwardedReply)followForwardedReply(row.source_input_id,{sessionId:this.presentedSession(row.peer,row.remote_session_id),requestId:row.request_id},
      {working:!!remote.execution?.acknowledged||['running','delivering'].includes(remote.execution?.status??''),hold:remote.hold??null});
    // A reply the peer retained but could not push yet lands here by the same event ID, so
    // push and pull never produce two records for one reply.
    for(const reply of (remote.replies as any[])??[]){
      // A legacy peer can record the reply while answering with the old acknowledgement
      // shape. The exact retained event is stronger evidence than the sender's timeout.
      if(db.query('SELECT 1 FROM session_peer_events WHERE event_id=?').get(reply.eventId))continue;
      // A reply the peer gave up pushing is still the peer's answer, and this poll carries it:
      // take it. Writing the request off lost a finished Mac answer whose single push met the
      // server mid-restart (2026-10-04, request c5a8444f). Fail only if it cannot be fetched.
      const pulled=await this.pullReply(client,row,reply,false);
      if(this.stopped)return;
      if(!pulled&&(reply.status==='failed_deadline'||reply.status==='failed_budget')){
        this.settle(row,'failed',`The peer could not return its answer: ${reply.status==='failed_deadline'?'delivery reached its deadline':'delivery exhausted its retry budget'}, and fetching it failed. ${reply.eventId}`);
        return;
      }
    }
    row=this.row(row.request_id);
    if(row.outcome)return;
    const effect=JSON.parse(row.payload_json).requestedEffect;
    const execution=remote.execution;
    const output=execution?{turn_id:execution.turnId,session_id:this.presentedSession(row.peer,row.remote_session_id),run_id:execution.runId,input_id:row.remote_operation_id,sha256:execution.sha256??null,
      ...(execution.text?{text:execution.text}:{}),...(execution.error?{error:execution.error}:{})}:null;
    // A run that started and then failed is not a request the peer could not receive: say what
    // stopped it. Two Mac runs of over an hour were reported as "could not receive" (2026-09-30).
    if(remote.inputState==='failed'){this.settle(row,'failed',remote.inputError?.message??(typeof remote.inputError==='string'?remote.inputError:null)
      ??(execution?.acknowledged?`The run on ${row.peer} started but stopped before it finished${execution.error?`: ${execution.error}`:'.'}`:null)
      ??'The peer target could not receive this request.');return;}
    if(this.closeStranded(row))return;
    // The worker's machine says the request stalled: tell the requester once. It stays open.
    if(remote.stalled&&row.stalled_at_ms===null){
      db.transaction(()=>{
        const current=this.row(row.request_id);
        if(current.outcome||current.stalled_at_ms!==null)return;
        const partial=db.query("SELECT payload_json FROM session_peer_events WHERE request_id=? AND kind='progress' ORDER BY rowid DESC LIMIT 1").get(row.request_id) as {payload_json:string}|null;
        this.event(row,'overdue',{text:stalledNotice(remote.stalled.reason,partial?JSON.parse(partial.payload_json).text:null),stalled:true,
          reason:remote.stalled.reason,noticeGroup:`stalled:${row.peer}:${row.remote_session_id}:${remote.execution?.turnId??remote.stalled.atMs}`});
        db.query('UPDATE session_peer_requests SET stalled_at_ms=? WHERE request_id=?').run(this.now(),row.request_id);
      })();
      log('warn','session_peer_request_stalled',{request_id:row.request_id,peer:row.peer,reason:remote.stalled.reason});
      this.wake();
    }
    if(!execution)return;
    if(execution.steeringStatus==='failed'){this.settle(row,'failed','The peer provider did not accept this live request.');return;}
    if(!execution.settled)return;
    // A request closes only through the recipient's reply, the requester's cancel or a failed
    // execution; a turn ending is none of those, however its text is worded. Reading that text
    // as the answer closed this request on "final reply will follow" and discarded the real
    // answer that followed (September 23, 2026). The exception is a recipient with no reply
    // command (ChatGPT, consultation-only), whose dedicated turn is its reply.
    if(execution.status==='done'){
      if(execution.answersWithTurn&&execution.dedicated&&execution.text)this.settle(row,effect==='work'?'undetermined':'answered',execution.text,output);
      return;
    }
    if(execution.status==='cancelled'){
      const at=typeof execution.stoppedByTejasAtMs==='number'?execution.stoppedByTejasAtMs:null;
      this.settle(row,'canceled',at!==null?stoppedByTejasText(at,` on ${row.peer}`):cancelledWithoutHisStopText(` on ${row.peer}`),
        {...output,...(at!==null?{stoppedBy:'tejas',stoppedAtMs:at}:{stoppedBy:'not-tejas'})});
      return;
    }
    this.settle(row,'failed',endedWorkInPlainWords(execution.error,` on ${row.peer}`),
      {...output,...(execution.error?{providerError:String(execution.error).slice(0,2000)}:{})});
  }
  private async deliver(event:PeerEventRow) {
    if(this.stopped)return;
    const row=this.row(event.request_id);
    const declared=JSON.parse(event.payload_json);
    if(declared.turnOutcome==='needs_you'){
      filePeerWorkerNeedInThread({requestId:row.request_id,inboxSessionId:row.source_session_id,
        threadRootInputId:row.thread_root_input_id,sourceInputId:row.source_input_id,
        respondingSessionId:declared.responding_session_id,runId:declared.source?.run_id,
        eventId:event.event_id,text:declared.text});
      db.query("UPDATE session_peer_events SET status='received',error=NULL WHERE event_id=?").run(event.event_id);
      return;
    }
    const requestPayload=JSON.parse(row.payload_json);
    const routedMessage=requestPayload.routedMessage;
    const forwardedRoute=requestPayload.forwardedReply?.inboxInputId?messageRouteForSource(requestPayload.forwardedReply.inboxInputId):null;
    if(event.kind==='overdue'&&(declared.promptAnswerOverdue?row.prompt_answered_at_ms!==null:!!row.outcome)){
            withdrawUnstartedServiceInput(`return:${event.event_id}`,"Answered before this notice was delivered.");
            withdrawUnstartedServiceInput(`question-overdue:${row.request_id}`,"Answered before this notice was delivered.");
      db.query("UPDATE session_peer_events SET status='received',error='Answered before this notice was delivered; not sent.' WHERE event_id=? AND status IS NOT 'received'").run(event.event_id);
      return;
    }
    const legacyAgentReminder=event.kind==='overdue'&&/^(This request has no confirmed answer after|The other machine has not answered for) \d+ minutes[.;]/.test(String(declared.text??''));
    if(event.kind==='overdue'&&(declared.agentReminder||legacyAgentReminder||declared.held)){
      const source=getSessionById(row.source_session_id);
      if(!source||!this.dependencies.owner.canSend(source)){
        db.query("UPDATE session_peer_events SET status='held',error='Asking agent is unavailable; reminder retained.' WHERE event_id=?").run(event.event_id);
        return;
      }
      const inputId=`request-reminder:${event.event_id}`;
      const text=legacyAgentReminder?unresolvedRequestReminder(row.payload_json,STILL_WAITING_MINUTES,
        'Inspect the recipient’s status and follow up or cancel if the work can no longer wait.')
        :declared.held&&!declared.agentReminder?`${requestLabel(row.payload_json)} is waiting: ${String(declared.text)}`:String(declared.text);
      const accepted=this.dependencies.owner.admit({sessionId:source.id,inputId,origin:'service',sourceInputId:row.source_input_id,sourceRunId:nativeRunId(row.source_turn_id),requestId:row.request_id,text});
      const observed=readInputExecution(accepted);
      const received=observed.acknowledgedAt||observed.turn?.input_context_received_by_turn_id;
      db.query('UPDATE session_peer_events SET accepted_input_id=?,status=?,error=NULL WHERE event_id=?')
        .run(inputId,received?'received':accepted.turn_id?'admitted':'held',event.event_id);
      return;
    }
    const returnToRequester=returnsToRequester(row,event);
    // The peer's timing event stays in the request ledger and agent return path.
    // It never becomes a Service post in Tejas's thread.
    if(event.kind==='overdue'&&!returnToRequester){
      db.query("UPDATE session_peer_events SET status='received',error=NULL WHERE event_id=? AND status IS NOT 'received'").run(event.event_id);
      return;
    }
    const directPost=this.postThreadEvent(row,event,declared);
    // A progress note wakes nobody, from a peer as from this machine (see the coordinator's deliver).
    if(event.kind==='progress'){db.query("UPDATE session_peer_events SET status='received',error=NULL WHERE event_id=? AND status IS NOT 'received'").run(event.event_id);return;}
    if(routedMessage||(forwardedRoute&&'sessionId' in forwardedRoute)){
      if(routedMessage&&event.kind==='final'&&declared.output?.stoppedBy!=='tejas'&&!directPost)
        throw new Error('The routed message has no answer in its Inbox thread.');
      withdrawUnstartedServiceInput(`return:${event.event_id}`,routedMessage?'Answer posted in the source Inbox thread.':'Answer retained in the destination session.');
      db.query("UPDATE session_peer_events SET status='received',error=NULL WHERE event_id=? AND status IS NOT 'received'").run(event.event_id);
      return;
    }
    if(!returnToRequester){
            if(!directPost)throw new Error("The named thread has not received this reply.");
            withdrawUnstartedServiceInput(`return:${event.event_id}`,"Delivered directly to its Inbox thread.");
            withdrawUnstartedServiceInput(`question-overdue:${row.request_id}`,"The overdue notice belongs to its Inbox thread.");
      db.query("UPDATE session_peer_events SET status='received',error=NULL WHERE event_id=? AND status IS NOT 'received'").run(event.event_id);
      return;
    }
    const source=getSessionById(row.source_session_id);
    if(!source||!this.dependencies.owner.canSend(source)){
      db.query("UPDATE session_peer_events SET status='held',error='Requester is unavailable, paused or archived; the result is retained.' WHERE event_id=?").run(event.event_id);
      return;
    }
    const payload=declared.workDisposition==='completed'&&row.outcome!=='answered'?JSON.parse(row.result_json!):declared;
    // Historical returns already carried by another event keep their delivery state.
    const current=db.query('SELECT * FROM session_peer_events WHERE event_id=?').get(event.event_id) as PeerEventRow;
    if(current.accepted_input_id&&current.accepted_input_id!==`return:${event.event_id}`){this.followReturn(current.event_id,current.accepted_input_id);return;}
    const group=current.accepted_input_id?{carriedBy:null as string|null,joining:[] as PeerEventRow[]}:this.explicitAnswerGroup(current,row.source_session_id);
    if(group.carriedBy){
      db.query('UPDATE session_peer_events SET accepted_input_id=? WHERE event_id=?').run(group.carriedBy,event.event_id);
      this.followReturn(event.event_id,group.carriedBy);
      return;
    }
    recoverUnsentSteeredInput(`return:${event.event_id}`);
    const existing=getAcceptedSessionInput(`return:${event.event_id}`);
    const accepted=existing?this.dependencies.owner.dispatch(existing):this.dependencies.owner.admit({sessionId:source.id,inputId:`return:${event.event_id}`,origin:'service',sourceInputId:row.source_input_id,sourceRunId:nativeRunId(row.source_turn_id),requestId:row.request_id,
      text:answerNotice({responder:(()=>{const catalogue=db.query('SELECT view_json FROM session_peer_catalogue WHERE peer=? AND remote_session_id=?').get(row.peer,row.remote_session_id) as {view_json:string}|null;
          const title=catalogue?JSON.parse(catalogue.view_json)?.title:null;return title?`“${title}” on the ${row.peer}`:`the session on the ${row.peer}`;})(),
        labels:[row,...group.joining.map(joined=>this.row(joined.request_id))].map(item=>requestLabel(item.payload_json)),kind:event.kind,stalled:!!declared.stalled,
        body:String(payload.text??''),outcome:payload.outcome??null,workDisposition:payload.workDisposition??null,
        deliveryNote:directPost?'Already posted in the named Inbox thread. This is your copy; do not relay it.':payload.output?.delivery_note??null,
        files:Array.isArray(payload.attachments)?payload.attachments.length:0,followUp:null}),
      // The peer's files are already in this instance's custody; the return carries them.
      ...(Array.isArray(payload.attachments)&&payload.attachments.length?{attachments:payload.attachments as string[]}:{}),
      ...(directPost?{alreadyPostedInThread:true}:{})});
    if(event.kind==='final'&&payload.workDisposition==='needs_decision'&&!sessionMetadata(source).inbox){
      const author=sessionAuthor(receiveSessionFromPeer(row.remote_session_id,row.peer,this.self));
      recordRequesterDecisionReturn({sessionId:source.id,returnInputId:accepted.id,requestId:row.request_id,
        question:String(payload.text??''),agentName:author?.agentName,taskTitle:author?.title});
    }
    for(const joined of group.joining)db.query('UPDATE session_peer_events SET accepted_input_id=? WHERE event_id=? AND accepted_input_id IS NULL').run(`return:${event.event_id}`,joined.event_id);
    const observed=readInputExecution(accepted);
    const received=observed.acknowledgedAt||observed.turn?.input_context_received_by_turn_id;
    const unacknowledged=observed.steering?.status==='ambiguous'&&!observed.steering.provider_sent_at;
    const status=received?'received':unacknowledged?'uncertain':['failed','uncertain','canceled'].includes(observed.state)?observed.state:accepted.turn_id?'admitted':'held';
    const error=unacknowledged?'The provider did not acknowledge this specific return; its linked turn outcome does not prove receipt.':observed.steering?.error??null;
    db.query('UPDATE session_peer_events SET status=?,error=? WHERE accepted_input_id=?').run(status,received?null:error,accepted.id);
    db.query('UPDATE session_peer_events SET accepted_input_id=?,status=?,error=? WHERE event_id=?').run(accepted.id,status,received?null:error,event.event_id);
    if(received){
      if(event.kind==='final')recordChatGptReturnReceipt({eventId:event.event_id,returnInputId:accepted.id,now:this.now()});
      for(const joined of group.joining)recordChatGptReturnReceipt({eventId:joined.event_id,returnInputId:accepted.id,now:this.now()});
    }
  }
  /** Whether this request's agent replies post into an Inbox thread, by the rule postThreadEvent applies. */
  private answersInThread(row:PeerRequestRow):boolean {
    const requestPayload=JSON.parse(row.payload_json);
    const forwarded=requestPayload.forwardedReply;
    const route=forwarded?.inboxInputId?messageRouteForSource(forwarded.inboxInputId):null;
    if(route&&'sessionId' in route)return false;
    if(forwarded&&typeof forwarded.inboxInputId==='string')return true;
    const inbox=getSessionById(row.source_session_id);
    const root=inboxRequestRoot(db,row.request_id,row.thread_root_input_id??requestPayload.routedFrom?.root??null);
    return !!root&&!!inbox&&!!sessionMetadata(inbox).inbox&&!!topicOfRoot(root);
  }
  private postThreadEvent(row:PeerRequestRow,event:PeerEventRow,declared:any):boolean {
    if(event.kind==='overdue')return false;
    // A named thread receives the peer's own reply; requester delivery needs its own choice.
    const requestPayload=JSON.parse(row.payload_json);
    const forwarded=requestPayload.forwardedReply;
    const route=forwarded?.inboxInputId?messageRouteForSource(forwarded.inboxInputId):null;
    if(route&&'sessionId' in route)return false;
    const inbox=getSessionById(row.source_session_id);
    const answerRoot=route&&'topicId' in route?route.messageId:inboxRequestRoot(db,row.request_id,row.thread_root_input_id??requestPayload.routedFrom?.root??null);
    const routed=!forwarded&&((event.kind==='progress'&&!!declared.source)||event.kind==='final'||event.kind==='overdue')&&!!answerRoot
      &&!!inbox&&!!sessionMetadata(inbox).inbox&&!!topicOfRoot(answerRoot);
    const threadReply=(forwarded&&typeof forwarded.inboxInputId==='string')||routed;
    const directPost=threadReply&&declared.output?.stoppedBy!=='tejas';
    if(directPost){
      const catalogue=db.query('SELECT view_json FROM session_peer_catalogue WHERE peer=? AND remote_session_id=?').get(row.peer,row.remote_session_id) as {view_json:string}|null;
      const root=answerRoot??row.source_input_id;
      postAgentAnswer({inboxSessionId:row.source_session_id,eventId:event.event_id,requestId:row.request_id,root,
        inboxInputId:routed?requestPayload.routedFrom?.messageId??root:forwarded.inboxInputId,respondingSessionId:this.presentedSession(row.peer,row.remote_session_id),
        respondingTitle:catalogue?JSON.parse(catalogue.view_json)?.title??null:null,text:String(declared.replyBody??declared.text??''),todoId:typeof declared.todoId==='string'?declared.todoId:null,
        attachments:Array.isArray(declared.attachments)?declared.attachments as string[]:[],
        stalled:event.kind==='overdue'||!!declared.stalled||(!declared.source&&declared.outcome!=='answered'),final:event.kind==='final',
        answersQuestion:declared.answersQuestion===true,workDisposition:declared.workDisposition??null,closingLine:declared.closingLine??null,
        answerGroup:declared.answerGroup??null,summary:typeof declared.summary==='string'?declared.summary:null,
        answerSource:declared.source?.input_id&&declared.source?.run_id
          ?{inputId:declared.source.input_id,runId:declared.source.run_id}:null,
        noticeGroup:typeof declared.noticeGroup==='string'?declared.noticeGroup:null,
        hisInputId:routed?null:row.source_input_id,quiet:typeof declared.quiet==='string'?declared.quiet:null,notify:declared.notify===true,
        messageThreadRootId:typeof forwarded?.messageThreadRootId==='string'?forwarded.messageThreadRootId:null,
        alsoMainThread:declared.alsoMainThread===true,
        informational:JSON.parse(row.payload_json).requestedEffect==='informational'});
    }
    let stoppedPost=false;
    if(declared.output?.stoppedBy==='tejas'&&typeof declared.output.stoppedAtMs==='number'){
      const root=route&&'topicId' in route?route.messageId:inboxRequestRoot(db,row.request_id,row.thread_root_input_id??requestPayload.routedFrom?.root??(forwarded?row.source_input_id:null));
      if(root&&inbox&&sessionMetadata(inbox).inbox&&topicOfRoot(root)){
        const catalogue=db.query('SELECT view_json FROM session_peer_catalogue WHERE peer=? AND remote_session_id=?').get(row.peer,row.remote_session_id) as {view_json:string}|null;
        const title=catalogue?JSON.parse(catalogue.view_json)?.title??null:null;
        postAgentAnswer({inboxSessionId:row.source_session_id,eventId:event.event_id,requestId:row.request_id,root,inboxInputId:forwarded?.inboxInputId??requestPayload.routedFrom?.messageId??root,
          respondingSessionId:this.presentedSession(row.peer,row.remote_session_id),respondingTitle:title,
          text:`You stopped ${title?`“${title}”`:'this agent'} on ${row.peer} at ${noticeTime(db,declared.output.stoppedAtMs)}; its work on this ended there.`,
          attachments:[],stalled:true,final:true,workDisposition:null,hisInputId:null,quiet:'Stopped by Tejas',
          messageThreadRootId:typeof forwarded?.messageThreadRootId==='string'?forwarded.messageThreadRootId:null});
        if(forwarded?.inboxInputId)db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
          .run(JSON.stringify({state:'canceled',stoppedBy:'tejas'}),forwarded.inboxInputId);
        log('info','his_stop_posted_to_thread',{request_id:row.request_id,thread:root,peer:row.peer});
        stoppedPost=true;
      }
    }
    return !!directPost||stoppedPost;
  }
  private explicitAnswerGroup(event:PeerEventRow,requesterSessionId:number):{carriedBy:string|null;joining:PeerEventRow[]} {
    if(event.kind!=='final')return {carriedBy:null,joining:[]};
    const group=JSON.parse(event.payload_json).answerGroup;
    if(typeof group!=='string'||!group)return {carriedBy:null,joining:[]};
    const candidates=db.query(`SELECT event.* FROM session_peer_events event JOIN session_peer_requests request ON request.request_id=event.request_id
      WHERE request.source_session_id=? AND event.kind='final' AND event.event_id<>?
        AND json_extract(event.payload_json,'$.answerGroup')=? ORDER BY event.rowid`)
      .all(requesterSessionId,event.event_id,group) as PeerEventRow[];
    const carrier=candidates.filter(candidate=>returnsToRequester(this.row(candidate.request_id),candidate)).find(candidate=>candidate.accepted_input_id===`return:${candidate.event_id}`);
    return carrier?{carriedBy:carrier.accepted_input_id,joining:[]}:{carriedBy:null,joining:candidates.filter(candidate=>!candidate.accepted_input_id&&returnsToRequester(this.row(candidate.request_id),candidate))};
  }
  private followReturn(eventId:string,inputId:string) {
    const input=getAcceptedSessionInput(inputId);
    if(!input)return;
    const observed=readInputExecution(input);
    const received=observed.acknowledgedAt||observed.turn?.input_context_received_by_turn_id;
    db.query('UPDATE session_peer_events SET status=? WHERE event_id=?').run(received?'received':['failed','uncertain','canceled'].includes(observed.state)?observed.state:input.turn_id?'admitted':'held',eventId);
    if(received)recordChatGptReturnReceipt({eventId,returnInputId:inputId,now:this.now()});
  }
  /**
   * A request whose work on the peer has ended without a final reply, with nothing there still
   * working on it, is closed as stalled once it is past its due time or the peer reports it
   * stalled. Kept open, it was polled on every wake for as long as it existed: eighteen such
   * requests from September 18–23 were still being asked about on September 27, and their burst
   * of failures while the Mac slept is what tripped the connection notices. It closes as
   * `unanswered`, which holds dependents like any unanswered request and is superseded by a final
   * the worker sends later, so a late answer still returns. Nothing is re-run. The words are the
   * same for every request one worker left this way, so a requester gets one return for all of
   * them; each request's own last text is kept in its output.
   */
  private closeStranded(row:PeerRequestRow):boolean {
    if(row.outcome||!row.remote_status_json||this.currentFinal(row.request_id))return false;
    if(JSON.parse(row.payload_json).promptAnswer&&row.prompt_answered_at_ms===null&&row.overdue_at_ms===null)return false;
    const remote=JSON.parse(row.remote_status_json);
    const execution=remote.execution;
    if(!execution||remote.stillWorking||['running','queued'].includes(execution.status))return false;
    // Failed and cancelled executions, and recipients that answer with their turn, close in dispatch.
    if(execution.settled&&execution.status!=='done')return false;
    if(execution.status==='done'&&execution.answersWithTurn&&execution.dedicated&&execution.text)return false;
    if(row.overdue_at_ms===null&&row.stalled_at_ms===null&&!remote.stalled&&row.due_at_ms>this.now())return false;
    const partial=db.query("SELECT payload_json FROM session_peer_events WHERE request_id=? AND kind='progress' ORDER BY rowid DESC LIMIT 1").get(row.request_id) as {payload_json:string}|null;
    const lastText=(partial?JSON.parse(partial.payload_json).text:null)??execution.text??null;
    const worker=this.presentedSession(row.peer,row.remote_session_id);
    const closed=this.settle(row,'unanswered',`${worker} on ${row.peer} ended its work without sending a final reply, and nothing there is still working on it, so this is closed as stalled. Nothing was re-run. Its last text, if any, is in this result's output; a final reply it sends later still returns here.`,
      {session_id:worker,turn_id:execution.turnId??null,run_id:execution.runId??null,execution_status:execution.status,stalled:true,last_text:lastText});
    if(!closed)return false;
    log('info','session_peer_request_closed_stalled',{request_id:row.request_id,peer:row.peer,execution_status:execution.status});
    return true;
  }
  /** A request the peer holds and will not start soon tells its sender now, as a local one does. */
  private inspectHold(row:PeerRequestRow) {
      const hold=JSON.parse(row.remote_status_json!).hold;
      const forwarded=!!JSON.parse(row.payload_json).forwardedReply;
      db.transaction(()=>{
        if(this.row(row.request_id).outcome||this.row(row.request_id).overdue_at_ms!==null)return;
        if(!forwarded)this.event(row,'overdue',{text:`${requestLabel(row.payload_json)} is waiting: ${heldRequestNotice(hold)}`,
          health:`held: ${hold.code}`,held:hold.code,agentReminder:true});
        db.query('UPDATE session_peer_requests SET overdue_at_ms=? WHERE request_id=?').run(this.now(),row.request_id);
      })();
  }
  private inspectOverdueRequest(row:PeerRequestRow) {
    const now=this.now();
      if(JSON.parse(row.payload_json).promptAnswer&&row.prompt_answered_at_ms===null){
        const human=getAcceptedSessionInput(row.source_input_id)?.origin==='human';
        db.transaction(()=>{
          const current=this.row(row.request_id);
          if(current.outcome||current.prompt_answered_at_ms!==null||current.overdue_at_ms!==null)return;
          if(current.prompt_reminded_at_ms===null){
            db.query('UPDATE session_peer_requests SET prompt_reminded_at_ms=?,due_at_ms=? WHERE request_id=?')
              .run(now,current.created_at_ms+PROMPT_ANSWER_OVERDUE_MS,current.request_id);
          } else {
            const remote=JSON.parse(current.remote_status_json??'{}');
            this.event(current,'overdue',{text:`No answer to this ${human?'question':'marked test question'} arrived within three minutes. The agent has been reminded if its machine is awake. The request remains open, and its answer will still appear here when it arrives.`,promptAnswerOverdue:true,
              noticeGroup:`prompt-overdue:${current.peer}:${current.remote_session_id}:${remote.execution?.turnId??current.remote_operation_id}`});
            db.query('UPDATE session_peer_requests SET overdue_at_ms=? WHERE request_id=?').run(now,current.request_id);
          }
        })();
        return;
      }
      const remote=row.remote_status_json?JSON.parse(row.remote_status_json):null;
      // A peer mid-update holds its work for a few minutes; that is waiting, not a stall.
      const healthy=remote?.execution?.status==='running'&&!remote.execution.stopped||remote?.execution?.status==='done'&&remote.stillWorking||remote?.updating===true;
      if(healthy){db.query('UPDATE session_peer_requests SET due_at_ms=? WHERE request_id=? AND outcome IS NULL AND overdue_at_ms IS NULL').run(now+DUE_MS,row.request_id);return;}
      const asleep=row.status==='queued_offline'||this.unreachable.has(row.peer);
      if(asleep){
        // The machine being asleep is not a notice to Tejas; the agent that asked decides whether
        // this work matters to him now (his decision, 2026-09-27).
        db.transaction(()=>{
          if(this.row(row.request_id).outcome||this.row(row.request_id).overdue_at_ms!==null)return;
          this.event(row,'overdue',{text:unresolvedRequestReminder(row.payload_json,STILL_WAITING_MINUTES,
            `The ${row.peer} may be asleep or offline. ${row.status==='queued_offline'?'Delivery will resume':'Its status will be checked again'} when it reconnects; inspect it then if an answer is still needed.`),health:`${row.peer} unreachable`,agentReminder:true});
          db.query('UPDATE session_peer_requests SET overdue_at_ms=? WHERE request_id=?').run(now,row.request_id);
        })();
        return;
      }
      const health=remote?.execution?.stopped?'deliberately stopped'
        :remote?.execution?.status==='done'?`${this.presentedSession(row.peer,row.remote_session_id)} ended its turn without a final reply; the request stays open until that session replies or you cancel it`
        :remote?.execution?.status??remote?.inputState??'waiting for admission on the peer';
      db.transaction(()=>{
        if(this.row(row.request_id).outcome||this.row(row.request_id).overdue_at_ms!==null)return;
        this.event(row,'overdue',{text:unresolvedRequestReminder(row.payload_json,STILL_WAITING_MINUTES,
          'Inspect the recipient’s status and follow up or cancel if the work can no longer wait.'),health,agentReminder:true});
        db.query('UPDATE session_peer_requests SET overdue_at_ms=? WHERE request_id=?').run(now,row.request_id);
      })();
  }

  // ---- target side: a request a peer delivered to this instance ----
  private delivery(requestId:string):DeliveryRow {
    const row=db.query('SELECT * FROM session_peer_deliveries WHERE request_id=?').get(requestId) as DeliveryRow|null;
    if(!row)throw new SessionOwnerError('Unknown session request.',404);
    return row;
  }
  deliveryFor(inputId:string){return db.query('SELECT * FROM session_peer_deliveries WHERE target_input_id=?').get(inputId) as DeliveryRow|null;}
  async accept(body:unknown,correctedAttachmentRoute=false) {
    const input=object(body);
    const requestId=input.requestId;
    if(typeof requestId!=='string'||!/^[0-9a-f-]{36}$/.test(requestId))throw new SessionOwnerError('A peer request needs its UUID.');
    const origin=object(input.origin);
    if(typeof origin.peer!=='string'||!this.dependencies.clients.has(origin.peer))throw new SessionOwnerError('Unknown peer instance.',403,'PEER_UNKNOWN');
    if(typeof origin.sessionId!=='string'||typeof origin.inputId!=='string'||typeof origin.runId!=='string')throw new SessionOwnerError('A peer request names its origin session, input and run.');
    if(origin.originatingHuman!==undefined&&origin.originatingHuman!==null
      &&(typeof origin.originatingHuman?.inputId!=='string'||typeof origin.originatingHuman?.runId!=='string'||typeof origin.originatingHuman?.sessionId!=='string'))
      throw new SessionOwnerError('A peer human source needs its exact session, input and run.',400,'PEER_HUMAN_SOURCE_INVALID');
    if(input.humanModelChoices!==undefined&&(!Array.isArray(input.humanModelChoices)||input.humanModelChoices.length>2
      ||input.humanModelChoices.some((model:unknown)=>model!=='claude-fable-5-1'&&model!=='gpt-6-astra')))
      throw new SessionOwnerError('A peer model choice must name a supported top model.',400,'PEER_MODEL_CHOICE_INVALID');
    if(input.humanModelChoice!==undefined&&typeof input.humanModelChoice!=='string')
      throw new SessionOwnerError('A peer model choice must name its selected model.',400,'PEER_MODEL_CHOICE_INVALID');
    if(typeof input.text!=='string'||!input.text.trim())throw new SessionOwnerError('Nonempty request text required.');
    if(correctedAttachmentRoute!==!!input.correctionOf)
      throw new SessionOwnerError('Attachment corrections use only the dedicated peer correction route.',409,'PEER_CORRECTION_ROUTE');
    const targetProvider=typeof input.provider==='string'?input.provider
      :typeof input.address==='string'?resolveSessionAddress(input.address).provider_id:null;
    if(input.answerGuaranteeVersion!==undefined&&input.answerGuaranteeVersion!==1)
      throw new SessionOwnerError('Unsupported peer answer-obligation version.',409,'ANSWER_GUARANTEE_VERSION');
    if(targetProvider==='chatgpt'){
      const claim=input.answerObligation;
      if(input.answerGuaranteeVersion!==1||!claim||claim.attemptId!==requestId
        ||typeof claim.id!=='string'||!claim.id||!claim.task||typeof claim.task.kind!=='string'||typeof claim.task.id!=='string')
        throw new SessionOwnerError('A peer ChatGPT ask needs its exact versioned task and question obligation.',409,'ANSWER_GUARANTEE_REQUIRED');
    }else if(input.answerObligation!==undefined)
      throw new SessionOwnerError('Only a ChatGPT request can carry an answer obligation.',409,'ANSWER_GUARANTEE_TARGET');
    let machineNeed:MachineNeed|undefined;
    if(this.self==='mac'&&(typeof input.provider==='string'||input.requestedEffect==='work'&&!input.forwardedReply)) {
      try { machineNeed=input.machineNeed?.kind==='provider-renewal'
        && typeof origin.inputId==='string' && /^repair-notice:(?:claude|codex)-signin:/.test(origin.inputId)
        && typeof input.address==='string' && input.address==='session:WzIsMTAwLDFd'
          ? {kind:'provider-renewal',why:'Concierge provider sign-in repair request'}
          : parseMachineNeed(typeof input.machineNeed?.kind==='string'&&typeof input.machineNeed?.why==='string'
            ? `${input.machineNeed.kind}:${input.machineNeed.why}`:undefined,input.machineNeed?.serverAttempt); }
      catch(error) { throw new SessionOwnerError(error instanceof Error?error.message:'Mac-only need required.',400,'MACHINE_NEED_REQUIRED'); }
    }
    if(input.forwardedReply!==undefined&&(typeof input.forwardedReply?.inboxInputId!=='string'||typeof input.forwardedReply?.topicId!=='string'||(input.forwardedReply.authorKind!==undefined&&!['human','agent'].includes(input.forwardedReply.authorKind))
      ||(input.forwardedReply.messageThreadRootId!==undefined&&typeof input.forwardedReply.messageThreadRootId!=='string')
      ||(input.forwardedReply.messageThreadRequestId!==undefined&&typeof input.forwardedReply.messageThreadRequestId!=='string')))
      throw new SessionOwnerError('A forwarded thread reply needs its exact source input and topic.');
    if(input.routedFrom!==undefined&&(typeof input.routedFrom?.messageId!=='string'||typeof input.routedFrom?.topicId!=='string'||typeof input.routedFrom?.originalText!=='string'||typeof input.routedFrom?.originalCreatedAt!=='string'||!['human','agent'].includes(input.routedFrom?.authorKind)))
      throw new SessionOwnerError('A routed message needs its exact source and original words.');
    if(input.files!==undefined&&(!Array.isArray(input.files)||input.files.some((file:any)=>typeof file?.name!=='string'||typeof file.contentType!=='string'||typeof file.base64!=='string')))throw new SessionOwnerError('Files must contain named attachment bytes.');
    if(input.summary!==undefined&&(typeof input.summary!=='string'||!input.summary.trim()||input.summary.includes('\n')||input.summary.length>200))throw new SessionOwnerError('A session description is one line of at most 200 characters.');
    const effect=input.requestedEffect??'informational';
    if(!['informational','work'].includes(effect))throw new SessionOwnerError('Requested effect must be informational or work.');
    const owner=this.dependencies.owner;
    const forwardedIntent=input.forwardedReply?{forwardedReply:input.forwardedReply,promptAnswer:input.promptAnswer===true,address:input.address,text:input.text,message:input.message,
      files:(input.files??[]).map((file:{name:string;contentType:string;base64:string})=>({name:file.name,contentType:file.contentType,
        sha256:createHash('sha256').update(Buffer.from(file.base64,'base64')).digest('hex')}))}:null;
    const existing=db.query('SELECT * FROM session_peer_deliveries WHERE request_id=?').get(requestId) as DeliveryRow|null;
    if(existing){
      const retained=existing.origin_provenance_json?JSON.parse(existing.origin_provenance_json):{};
      if((retained.correctionOf??null)!==(input.correctionOf??null))
        throw new SessionOwnerError('Idempotency conflict: peer correction identity changed.',409);
      if(correctedAttachmentRoute&&retained.correctionPayloadHash!==hash(JSON.stringify(input)))
        throw new SessionOwnerError('Idempotency conflict: corrected peer request bytes changed.',409,'PEER_CORRECTION_CHANGED');
      if(retained.answerGuaranteeVersion!==input.answerGuaranteeVersion
        ||JSON.stringify(retained.answerObligation??null)!==JSON.stringify(input.answerObligation??null))
        throw new SessionOwnerError('Idempotency conflict: peer guarantee changed.',409);
      if(retained.forwardedIntent&&JSON.stringify(retained.forwardedIntent)!==JSON.stringify(forwardedIntent))
        throw new SessionOwnerError('Idempotency conflict: forwarded request payload changed.',409);
      if(JSON.stringify(retained.routedFrom??null)!==JSON.stringify(input.routedFrom??null))
        throw new SessionOwnerError('Idempotency conflict: routed message changed.',409);
      if(JSON.stringify(retained.machineNeed??null)!==JSON.stringify(machineNeed??null))
        throw new SessionOwnerError('Idempotency conflict: Mac need changed.',409);
      const target=getAcceptedSessionInput(existing.target_input_id)!;
      if(target.turn_id===null)this.dependencies.owner.dispatch(target);
      return this.accepted(existing);
    }
    let correctionProof:{runId:string;reason:string;attachmentHashes:string[]}|null=null;
    if(correctedAttachmentRoute){
      if(targetProvider!=='chatgpt'||typeof input.address!=='string'||typeof input.correctionOf!=='string'
        ||!input.files?.length||input.provider!==undefined||input.answerGuaranteeVersion!==1
        ||input.answerObligation?.id!==input.correctionOf)
        throw new SessionOwnerError('Peer attachment correction needs an exact original ChatGPT request and corrected files.',409,'PEER_CORRECTION_INVALID');
      const original=db.query('SELECT * FROM session_peer_deliveries WHERE request_id=?').get(input.correctionOf) as DeliveryRow|null;
      const prior=original?.origin_provenance_json?JSON.parse(original.origin_provenance_json):null;
      const target=resolveSessionAddress(input.address);
      if(!original||original.peer!==origin.peer||original.origin_session_id!==origin.sessionId
        ||original.target_session_id!==target.id||original.target_input_id!==`request:${input.correctionOf}`
        ||prior?.answerObligation?.id!==input.correctionOf
        ||JSON.stringify(prior.answerObligation.task)!==JSON.stringify(input.answerObligation.task)
        ||prior.message!==input.message
        ||db.query("SELECT 1 FROM session_peer_replies WHERE request_id=? AND kind='final' LIMIT 1").get(input.correctionOf))
        throw new SessionOwnerError('The original peer delivery does not own this exact question, task and ChatGPT target.',409,'PEER_CORRECTION_CUSTODY');
      correctionProof=await owner.proveRejectedChatGptAttachment(target.id,original.target_input_id);
      const hashes=new Set(correctionProof.attachmentHashes);
      if(!input.files.some((file:{base64:string})=>!hashes.has(createHash('sha256').update(Buffer.from(file.base64,'base64')).digest('hex'))))
        throw new SessionOwnerError('The corrected peer attachment must have changed bytes.',409,'PEER_CORRECTION_UNCHANGED');
    }
    // The sender's own words stay beside the delivery text its preamble wraps for the provider.
    const humanModelChoices=origin.originatingHuman?Array.from(new Set([...(input.humanModelChoices??[]),input.humanModelChoice].filter((model:unknown)=>model==='claude-fable-5-1'||model==='gpt-6-astra'))):[];
    const provenance={origin:{peer:origin.peer,sessionId:origin.sessionId,inputId:origin.inputId,runId:origin.runId},originatingHuman:origin.originatingHuman??null,effectScope:origin.effectScope??null,
      ...(humanModelChoices.length?{humanModelChoices}:{}),
      ...(input.answerGuaranteeVersion===1?{answerGuaranteeVersion:1}:{}),...(input.answerObligation?{answerObligation:input.answerObligation}:{}),
      ...(correctionProof?{correctionOf:input.correctionOf,correctionPayloadHash:hash(JSON.stringify(input)),
        correctionProof:{runId:correctionProof.runId,reason:correctionProof.reason}}:{}),
      ...(machineNeed?{machineNeed}:{}),
      ...(typeof input.message==='string'&&input.message.trim()?{message:input.message}:{}),...(forwardedIntent?{forwardedIntent}:{}),
      ...(input.routedFrom?{routedFrom:input.routedFrom}:{})};
    const created=db.transaction(()=>{
      const attachments=((input.files??[]) as {name:string;contentType:string;base64:string}[]).map((file,index)=>owner.upload({name:file.name,contentType:file.contentType,base64:file.base64,clientActionId:`peer-file:${requestId}:${index}`}).attachment.id);
      const scope=`peer:${origin.peer}:${origin.inputId}`;
      let sessionId:number;
      if(typeof input.provider==='string'){
        const operation=owner.createRequestTarget({scope,requestId,provider:input.provider,effort:input.effort,escalationReason:typeof input.escalationReason==='string'?input.escalationReason:undefined,attestedHumanModel:humanModelChoices.includes(input.humanModelChoice)?input.humanModelChoice:undefined,project:input.project,title:input.title,summary:typeof input.summary==='string'?input.summary:undefined,
          firstInput:{text:input.text,...(machineNeed?{machineNeed}:{}),...(attachments.length?{attachments}:{})}});
        sessionId=operation.session_id;
      } else {
        if(typeof input.address!=='string')throw new SessionOwnerError('Choose an exact session address or a provider for a new session.');
        const target=resolveSessionAddress(input.address);
        if(sessionMetadata(target).interactionPolicy==='consultation-only'&&effect==='work')throw new SessionOwnerError('This session accepts consultation only — information, no actions.',409);
        if(!owner.canSend(target))throw new SessionOwnerError('The exact session is not currently messageable.',409,'CAPABILITY_UNAVAILABLE');
        owner.attachments(attachments);
        retainSessionInput({id:`request:${requestId}`,sessionId:target.id,scope,actionId:`request:${requestId}`,kind:'input',origin:'agent',
          payload:{text:input.text,...(machineNeed?{machineNeed}:{}),...(attachments.length?{attachments}:{}),...(input.routedFrom?{routedFrom:input.routedFrom}:{}),
            ...(target.provider_id==='chatgpt'||sessionMetadata(target).interactionPolicy==='consultation-only'?{delivery:'queue'}:{})},requestId});
        sessionId=target.id;
      }
      db.query(`INSERT INTO session_peer_deliveries(request_id,peer,origin_session_id,origin_input_id,origin_run_id,target_session_id,target_input_id,requested_effect,origin_provenance_json,created_at_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(requestId,origin.peer,origin.sessionId,origin.inputId,origin.runId,sessionId,`request:${requestId}`,effect,JSON.stringify(provenance),this.now());
      return this.delivery(requestId);
    })();
    owner.dispatch(getAcceptedSessionInput(created.target_input_id)!);
    this.wake();
    return this.accepted(created);
  }
  private accepted(row:DeliveryRow){const session=getSessionById(row.target_session_id)!;
    const provenance=JSON.parse(row.origin_provenance_json??'{}');
    const version=provenance.answerGuaranteeVersion;
    return {sessionId:`concierge:${session.id}`,address:sessionAddress(session),operationId:row.target_input_id,
      ...(provenance.correctionProof?{attachmentCorrectionVersion:1,correctionOf:provenance.correctionOf,
        originalRunId:provenance.correctionProof.runId,reason:provenance.correctionProof.reason}:{}),
      ...(version===1?{answerGuaranteeVersion:1}:{})};}
  /** What the origin needs to settle its request: the exact execution facts, never an outcome guessed here. */
  status(requestId:string) {
    const row=this.delivery(requestId);
    const acceptedAnswerGuaranteeVersion=JSON.parse(row.origin_provenance_json??'{}').answerGuaranteeVersion;
    const input=getAcceptedSessionInput(row.target_input_id);
    if(!input)throw new SessionOwnerError('Accepted request input is missing.',404);
    const observed=readInputExecution(input);
    const saved=input.receipt_json?JSON.parse(input.receipt_json):{};
    // A refused turn's work goes on in its continuation, so the origin is told about that turn: it
    // keeps the request open while the continuation waits or runs, exactly as a local request does.
    const carrying=observed.turn?carryingTurn(observed.turn.id):null;
    const carriedInput=carrying&&carrying.id!==observed.turn.id?acceptedInputForTurn(carrying.id):null;
    const current=carriedInput?{input:carriedInput,observed:readInputExecution(carriedInput),
      saved:carriedInput.receipt_json?JSON.parse(carriedInput.receipt_json):{}}:{input,observed,saved};
    const turn=carrying?db.query(`SELECT prerequisite.*,(${SETTLED_EXECUTION_SQL}) AS settled FROM turns prerequisite WHERE id=?`).get(carrying.id) as any:null;
    const steeringCount=turn?(db.query("SELECT count(*) AS count FROM turn_steering_messages WHERE turn_id=? AND status<>'failed'").get(turn.id) as any).count:0;
    const shared=turn?(db.query(`SELECT count(*) AS count FROM session_inputs WHERE turn_id=? AND (id IN (SELECT target_input_id FROM session_peer_deliveries) OR id IN (SELECT target_input_id FROM session_communication_requests WHERE target_input_id IS NOT NULL))`).get(turn.id) as any).count:0;
    const dedicated=!!turn&&turn.accepted_input_id===input.id&&!!turn.provider_input_acknowledged_at&&!input.steering_id&&shared===1&&steeringCount===0;
    const session=getSessionById(row.target_session_id)!;
    const execution=this.dependencies.owner.executionState(session);
    // A recipient with no reply command answers with its turn; every other one answers only by replying.
    const answersWithTurn=session.provider_id==='chatgpt'||sessionMetadata(session).interactionPolicy==='consultation-only';
    const replies=(db.query('SELECT * FROM session_peer_replies WHERE request_id=? ORDER BY rowid').all(requestId) as ReplyRow[]).map(reply=>{
      const payload=JSON.parse(reply.payload_json);
      const completionTurn=payload.completionTurnId?db.query(`SELECT prerequisite.status,prerequisite.provider_input_acknowledged_at,prerequisite.stop_requested_at,(${SETTLED_EXECUTION_SQL}) AS settled FROM turns prerequisite WHERE id=?`).get(payload.completionTurnId) as any:null;
      return {eventId:reply.event_id,kind:reply.kind,status:reply.status,text:payload.text,turnOutcome:payload.turnOutcome??null,replyBody:payload.replyBody,closingLine:payload.closingLine,answerGroup:payload.answerGroup,answersQuestion:payload.answersQuestion??false,notify:payload.notify===true,alsoMainThread:payload.alsoMainThread===true,workDisposition:payload.workDisposition??null,settlementProof:payload.settlementProof??null,createdAtMs:reply.created_at_ms,files:payload.attachments?.length??0,
        completionTurnId:payload.completionTurnId??null,sourceInputId:payload.source?.input_id??null,sourceRunId:payload.source?.run_id??null,...(payload.handBack?{handBack:payload.handBack}:{}),...(payload.quiet?{quiet:payload.quiet}:{}),
        completion:completionTurn?{settled:!!completionTurn.settled,status:completionTurn.status,completed:completionTurn.status==='done'&&!!completionTurn.provider_input_acknowledged_at&&!completionTurn.stop_requested_at}:null};
    });
    const answerTask={kind:'peer_delivery' as const,id:`${row.peer}:${requestId}`};
    let answerTaskReady=false;
    try{requireChatGptTaskResolved(answerTask);answerTaskReady=true;}catch{}
    return {requestId,answerGuaranteeVersion:1,acceptedAnswerGuaranteeVersion:acceptedAnswerGuaranteeVersion===1?1:null,
      answerTaskReady,unresolvedChatGptObligations:openChatGptObligations(answerTask).length,
      sessionId:`concierge:${session.id}`,address:sessionAddress(session),inputState:current.saved.state??current.observed.state,inputError:current.saved.error??null,stillWorking:['running','queued'].includes(execution),
      execution:turn?{turnId:turn.id,runId:nativeRunId(turn.id),status:turn.status,settled:!!turn.settled,acknowledged:!!turn.provider_input_acknowledged_at,acknowledgedAt:observed.acknowledgedAt??null,stopped:!!turn.stop_requested_at,stoppedByTejasAtMs:turn.status==='cancelled'?stoppedByTejas(turn.id)?.atMs??null:null,dedicated,answersWithTurn,
        steeringStatus:observed.steering?.status??null,text:turn.status==='done'?turn.agent_text||null:null,error:turn.status!=='done'?turn.agent_text??null:null,sha256:turn.agent_text?hash(turn.agent_text):null}:null,
      // A continuation held for a sign-in or a reset is this request's hold, told to its sender.
      hold:inputHold(current.input),updating:updateDraining(),
      replies,stalled:row.stalled_at_ms===null?null:{atMs:row.stalled_at_ms,reason:row.stalled_reason??'the worker sent no final reply after one reminder'}};
  }
  private deliveryReceipt(row:DeliveryRow) {
    const status=this.status(row.request_id);
    return {request_id:row.request_id,status:row.closed_at_ms?'settled':'delivered',outcome:null,peer:row.peer,role:'recipient',source_session_id:receiveSessionFromPeer(row.origin_session_id,row.peer,this.self),
      target_session_id:status.sessionId,target_address:status.address,target_input_id:row.target_input_id,operation_id:row.target_input_id,routed_request_id:null,target_turn_id:status.execution?.turnId??null,
      due_at_ms:null,overdue_at_ms:null,result:null,execution:status.execution?{turn_id:status.execution.turnId,input_kind:status.execution.steeringStatus?'steering':'turn',input_status:status.execution.steeringStatus??status.execution.status,acknowledged_at:status.execution.acknowledgedAt,provider_turn_id:null}:null,
      events:status.replies.map(reply=>({event_id:reply.eventId,kind:reply.kind,status:reply.status,error:null,payload:{text:reply.text,final:reply.kind==='final',workDisposition:reply.workDisposition},routed_request_id:null}))};
  }
  /**
   * The worker lives on this instance, so this instance takes the stranded steps for it
   * (request-liveness.ts): a stall the origin reads from status() and returns to its requester. It
   * does not close the request.
   */
  private chaseStranded(row:DeliveryRow,status:ReturnType<SessionPeers['status']>) {
    const execution=status.execution;
    if(!execution||execution.status!=='done'||!execution.settled||execution.answersWithTurn)return;
    if(status.replies.some(reply=>reply.kind==='final'))return;
    const owner=this.dependencies.owner;
    const next=strandedStep(owner,{requestId:row.request_id,workerSessionId:row.target_session_id,createdAtMs:row.created_at_ms,remindedAtMs:row.reminded_at_ms,remindedVia:row.reminded_via,stalledAtMs:row.stalled_at_ms});
    if(next.step==='stall'){
      db.query('UPDATE session_peer_deliveries SET stalled_at_ms=?,stalled_reason=? WHERE request_id=? AND stalled_at_ms IS NULL').run(this.now(),next.reason,row.request_id);
      log('warn','session_request_stalled',{request_id:row.request_id,peer:row.peer,worker_session_id:`concierge:${row.target_session_id}`,reason:next.reason});
    }
  }
  /**
   * One reply exactly as the origin must record it. The origin has no access to this instance's
   * custody, so the reply's exact bytes travel with it; push and the origin's pull both use this.
   */
  private replyBody(row:DeliveryRow,reply:ReplyRow) {
    const payload=JSON.parse(reply.payload_json);
    const files=payload.attachments?.length
      ?this.dependencies.owner.attachments(payload.attachments).map(({name,contentType,base64})=>({name,contentType,base64}))
      :null;
    return {eventId:reply.event_id,kind:reply.kind,text:payload.text,turnOutcome:payload.turnOutcome,replyBody:payload.replyBody,closingLine:payload.closingLine,answerGroup:payload.answerGroup,answersQuestion:payload.answersQuestion??false,notify:payload.notify===true,alsoMainThread:payload.alsoMainThread===true,workDisposition:payload.workDisposition,evidence:payload.evidence,completionTurnId:payload.completionTurnId??null,
      ...(payload.settlementProof?{settlementProof:payload.settlementProof}:{}),
      ...(payload.handBack?{handBack:payload.handBack}:{}),...(payload.quiet?{quiet:payload.quiet}:{}),...(files?{files}:{}),
      responder:{peer:this.self,sessionId:`concierge:${row.target_session_id}`,inputId:payload.source.input_id,runId:payload.source.run_id}};
  }
  /** GET …/requests/:id/replies/:eventId — a reply with its files, for an origin that pulls. */
  fullReply(requestId:string,eventId:string) {
    const row=this.delivery(requestId);
    const reply=db.query('SELECT * FROM session_peer_replies WHERE request_id=? AND event_id=?').get(requestId,eventId) as ReplyRow|null;
    if(!reply)throw new SessionOwnerError('Unknown reply.',404);
    return this.replyBody(row,reply);
  }
  private remindPromptAnswer(row:DeliveryRow) {
    if(row.closed_at_ms!==null||row.prompt_reminded_at_ms!==null||!JSON.parse(row.origin_provenance_json??'{}').forwardedIntent?.promptAnswer)return;
    if(db.query("SELECT 1 FROM session_peer_replies WHERE request_id=? AND (kind='final' OR json_extract(payload_json,'$.answersQuestion')=1) LIMIT 1").get(row.request_id)){
      db.query('UPDATE session_peer_deliveries SET prompt_reminded_at_ms=? WHERE request_id=? AND prompt_reminded_at_ms IS NULL').run(this.now(),row.request_id);
      return;
    }
    const target=getAcceptedSessionInput(row.target_input_id);
    this.dependencies.owner.admit({sessionId:row.target_session_id,inputId:`question-reminder:${row.request_id}`,
      origin:'service',sourceInputId:row.target_input_id,sourceRunId:target?.turn_id?nativeRunId(target.turn_id):row.origin_run_id,requestId:row.request_id,
      text:`${JSON.parse(row.origin_provenance_json??'{}').forwardedIntent?.forwardedReply?.authorKind==='agent'?'The marked agent test':'Tejas'} is still waiting for an answer to the question in request ${row.request_id}. Answer in the Inbox thread now with sessions reply ${row.request_id} --partial --answers-question, even if the rest of the work continues. A progress-only reply does not answer it.`});
    db.query('UPDATE session_peer_deliveries SET prompt_reminded_at_ms=? WHERE request_id=? AND prompt_reminded_at_ms IS NULL').run(this.now(),row.request_id);
  }
  /** Deliveries from a peer that this session holds without a final reply (see the coordinator's owed). */
  owedDeliveries(sessionId:number,runId:string,mark:{offer:string[];remind:boolean}):OwedRequest[] {
    const owed:OwedRequest[]=[];
    for(const row of db.query(`SELECT * FROM session_peer_deliveries WHERE target_session_id=? AND closed_at_ms IS NULL AND stalled_at_ms IS NULL AND created_at_ms>=? ORDER BY rowid`).all(sessionId,REMINDERS_SINCE_MS) as DeliveryRow[]) {
      if(!handedToARun(row.target_input_id))continue;
      if(db.query("SELECT 1 FROM session_peer_replies WHERE request_id=? AND kind='final'").get(row.request_id))continue;
      if(waitingOnDependency(sessionId,row.request_id,row.created_at_ms))continue;
      if(mark.offer.includes(row.request_id))db.query('UPDATE session_peer_deliveries SET hook_offered_run=? WHERE request_id=?').run(runId,row.request_id);
      if(mark.remind)db.query("UPDATE session_peer_deliveries SET reminded_at_ms=?,reminded_via='hook' WHERE request_id=? AND reminded_at_ms IS NULL AND hook_offered_run=?").run(this.now(),row.request_id,runId);
      owed.push({request_id:row.request_id,requester:`${row.peer}/${row.origin_session_id}`,requested_effect:row.requested_effect,command:replyCommand(row.request_id,row.requested_effect)});
    }
    return owed;
  }
  /** The origin canceled a request this instance delivered: close the delivery and tell its worker. */
  canceledByOrigin(requestId:string) {
    const row=this.delivery(requestId);
    const noticeAlreadyRetained=!!db.query('SELECT 1 FROM session_inputs WHERE id=?').get(`canceled:${requestId}`);
    const stopped=db.transaction(()=>{
      db.query('UPDATE session_peer_deliveries SET closed_at_ms=coalesce(closed_at_ms,?) WHERE request_id=?').run(this.now(),requestId);
      const stopped=cancelQueuedWithdrawnRequest(row.target_input_id);
      if(stopped)withdrawUnstartedServiceInput(`canceled:${requestId}`,'The request was withdrawn before its worker began.');
      return stopped;
    })();
    if(!stopped&&!noticeAlreadyRetained&&!db.query("SELECT 1 FROM session_peer_replies WHERE request_id=? AND kind='final'").get(requestId))
      tellWorkerCanceled(this.dependencies.owner,{requestId,workerSessionId:row.target_session_id,targetInputId:row.target_input_id,requester:`a session on the ${row.peer}`});
    return {canceled:true};
  }
  inspectDelivery(requestId:string){return this.deliveryReceipt(this.delivery(requestId));}
  /** A Mac turn outcome is retained beside its request and travels through the reply channel. */
  recordTurnNeed(actor:PeerActor,eventId:string,text:string) {
    const input=acceptedInputForTurn(actor.turn)??getAcceptedSessionInput(actor.inputId);
    const provenance=input?sessionInputProvenance(input):null;
    if(!provenance?.requestId||!provenance.peer||!provenance.originatingHuman)return;
    const row=db.query('SELECT * FROM session_peer_deliveries WHERE request_id=? AND target_session_id=?')
      .get(provenance.requestId,actor.session) as DeliveryRow|null;
    if(!row||row.peer!==provenance.peer)return;
    const key=`turn-need:${eventId}`;
    if(db.query('SELECT 1 FROM session_peer_replies WHERE action_key=?').get(key))return;
    db.query(`INSERT INTO session_peer_replies(event_id,request_id,action_key,kind,payload_json,created_at_ms)
      VALUES(?,?,?,'progress',?,?)`).run(eventId,row.request_id,key,JSON.stringify({text,turnOutcome:'needs_you',
        source:{input_id:actor.inputId,run_id:nativeRunId(actor.turn)},responding_session_id:`concierge:${actor.session}`}),this.now());
    this.wake();
  }
  reply(actor:PeerActor,input:{action_id:string;request_id:string;text:string;replyBody?:string;closingLine?:string;answerGroup?:string;final:boolean;answersQuestion?:boolean;waitingOnWatch?:string;notify?:boolean;alsoMainThread?:boolean;workDisposition?:WorkDisposition;openChatGptIds?:string[];evidence?:unknown[];attachments?:string[];handBack?:string;quiet?:string}) {
    if(this.stopped)throw new Error('Session communication is not accepting replies.');
    const row=this.delivery(input.request_id);
    if(row.target_session_id!==actor.session)throw new Error('Only the exact recipient session/conversation can reply.');
    if(input.workDisposition!==undefined&&(!input.final||row.requested_effect!=='work'||!['completed','failed','needs_decision'].includes(input.workDisposition)))throw new Error('A work disposition requires a final reply to a work request.');
    if(input.final&&row.requested_effect==='work'&&input.workDisposition===undefined)throw new Error('A final reply to a work request needs --work-disposition completed, failed or needs_decision.');
    // Whether there is a thread question to answer is the origin's to judge: it holds the thread.
    if(input.final&&input.replyBody===''&&!input.attachments?.length&&!db.query("SELECT 1 FROM session_peer_replies WHERE request_id=? AND kind='progress' AND json_extract(payload_json,'$.answersQuestion')=1").get(row.request_id))
      throw new Error('A final reply without a body needs an earlier prompt answer to this request.');
    if(input.notify&&(!input.text.trim()||input.final&&input.replyBody===''))throw new Error('--notify requires a new reply message with words.');
    if(input.alsoMainThread&&!JSON.parse(row.origin_provenance_json??'{}').forwardedIntent?.forwardedReply?.messageThreadRootId)
      throw new Error('--also-main-thread belongs to a reply inside one agent message thread.');
    if(input.alsoMainThread&&input.final&&input.replyBody===''&&!input.attachments?.length)
      throw new Error('--also-main-thread needs new answer words or a file to copy into the main thread.');
    const target=getAcceptedSessionInput(row.target_input_id);
    if(!target?.turn_id)throw new Error('This request has not been delivered to this session yet.');
    const key=JSON.stringify(['input',actor.inputId,input.action_id]);
    const version=JSON.parse(row.origin_provenance_json??'{}').answerGuaranteeVersion;
    const openIds=openChatGptObligations({kind:'peer_delivery',id:`${row.peer}:${row.request_id}`}).map(obligation=>obligation.obligation_id);
    const payload={text:input.text,final:input.final,source:{input_id:actor.inputId,run_id:nativeRunId(actor.turn)},responding_session_id:`concierge:${actor.session}`,
      ...(input.final&&version===1?{settlementProof:{version:1,requestId:row.request_id,recipientPeer:this.self,
        targetSessionId:`concierge:${row.target_session_id}`,unresolvedObligations:openIds.length,
        ...(openIds.length?{openObligationIds:openIds}:{})}}:{}),
      ...(input.replyBody!==undefined?{replyBody:input.replyBody}:{}),...(input.closingLine?{closingLine:input.closingLine}:{}),...(input.answerGroup?{answerGroup:input.answerGroup}:{}),
      ...(input.answersQuestion?{answersQuestion:true}:{}),...(input.waitingOnWatch?{waitingOnWatch:input.waitingOnWatch}:{}),...(input.notify?{notify:true}:{}),...(input.alsoMainThread?{alsoMainThread:true}:{}),
      // Custody on this instance; the forward reads these exact bytes for the origin.
      ...(input.attachments?.length?{attachments:input.attachments}:{}),
      ...(input.workDisposition?{workDisposition:input.workDisposition,completionTurnId:actor.turn}:{}),...(input.evidence?{evidence:input.evidence}:{}),
      // A hand-back is the router's to act on, so the origin keeps it on the router's road.
      ...(input.handBack?{handBack:input.handBack}:{}),
      // Why he need not read this completed answer; the origin files it for nobody.
      ...(input.quiet&&input.workDisposition==='completed'?{quiet:input.quiet}:{})};
    const prior=db.query('SELECT * FROM session_peer_replies WHERE action_key=?').get(key) as ReplyRow|null;
    if(prior){if(prior.request_id!==row.request_id||prior.payload_json!==JSON.stringify(payload))throw new Error('Idempotency conflict: reply action has a different payload.');return this.deliveryReceipt(row);}
    db.transaction(()=>{
      if(input.final)requireChatGptTaskDisposition({kind:'peer_delivery',id:`${row.peer}:${row.request_id}`},input.workDisposition,input.openChatGptIds??[]);
      if(input.final&&db.query("SELECT 1 FROM session_peer_replies WHERE request_id=? AND kind='final'").get(row.request_id))throw new Error('This request already has a final reply awaiting the peer’s confirmation.');
      const eventId=randomUUID();
      db.query('INSERT INTO session_peer_replies(event_id,request_id,action_key,kind,payload_json,created_at_ms) VALUES(?,?,?,?,?,?)').run(eventId,row.request_id,key,input.final?'final':'progress',JSON.stringify(payload),this.now());
      const operation=retainSessionInput({sessionId:actor.session,scope:`communication:${actor.inputId}`,actionId:input.action_id,kind:'reply',origin:'agent',
        payload:{text:input.text,sourceInputId:actor.inputId,sourceRunId:nativeRunId(actor.turn),kind:input.final?'final':'partial',workDisposition:input.workDisposition,evidence:input.evidence,peer:row.peer,...(input.attachments?.length?{attachments:input.attachments}:{})},
        sourceInputId:actor.inputId,sourceRunId:nativeRunId(actor.turn),requestId:row.request_id}).input;
      db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({state:'completed',eventId}),operation.id);
    })();
    this.wake();
    return this.deliveryReceipt(row);
  }
  /** Forward a recipient's replies and execution changes to the origin; both are retried until the origin has them. */
  private async report(row:DeliveryRow) {
    if(this.stopped)return;
    const client=this.dependencies.clients.get(row.peer);
    if(!client)return;
    for(const reply of db.query("SELECT * FROM session_peer_replies WHERE request_id=? AND status='pending' ORDER BY rowid").all(row.request_id) as ReplyRow[]) {
      const turnNeed=JSON.parse(reply.payload_json).turnOutcome==='needs_you';
      try {
        const answer=await withRetry({operation:'peer-reply',key:reply.event_id,policy:RETRY_POLICIES.peerReply,
          // A final reply may already have closed the origin's request, so it will not poll
          // this status again. Keep a turn question eligible for later bounded retry windows.
          startedAtMs:turnNeed?this.now():reply.created_at_ms,
          run:async()=>{
            const response=await client.request<{eventId?:string;recorded?:string;reason?:string}>('POST',`/sessions/v1/peers/requests/${encodeURIComponent(row.request_id)}/replies`,this.replyBody(row,reply),undefined,false);
            if(response?.eventId!==reply.event_id||!['recorded','duplicate','refused'].includes(response.recorded??''))
              throw new PeerReplyContractError('The peer answered, but did not confirm this reply by event ID and recorded status.');
            return response;
          },
          classifyError:(error,attempt)=>error instanceof PeerReplyContractError
            ?attempt>=PEER_REPLY_SCHEMA_MISMATCH_ATTEMPTS?'permanent':'unknown'
            :error instanceof PeerError&&error.kind==='refused'&&error.status!==null&&error.status<500?'permanent':'transient',
        });
        // Forwarded means the origin confirmed it holds this exact event. A refusal is recorded as
        // one; any other answer (an origin from before confirmations) leaves it pending and resent.
        // A plain success used to count as delivery while the origin discarded the reply.
        if(answer?.eventId===reply.event_id&&answer.recorded==='refused'){
          db.query("UPDATE session_peer_replies SET status='refused',error=? WHERE event_id=?").run(answer.reason??'The origin refused this reply.',reply.event_id);
          log('warn','session_peer_reply_refused_by_origin',{request_id:row.request_id,peer:row.peer,event_id:reply.event_id,kind:reply.kind,reason:answer.reason??null});
          continue;
        }
        db.query("UPDATE session_peer_replies SET status='forwarded',error=NULL WHERE event_id=?").run(reply.event_id);
        this.unreachable.delete(row.peer);
        log('info','session_peer_reply_forwarded',{request_id:row.request_id,peer:row.peer,event_id:reply.event_id,kind:reply.kind});
      } catch(error) {
        this.note(row.peer,error);
        if(turnNeed){
          log('warn','session_peer_turn_need_retry_later',{request_id:row.request_id,peer:row.peer,event_id:reply.event_id,...errorFields(error)});
          continue;
        }
        const deadline=error instanceof RetryBudgetExhaustedError&&error.reason==='deadline';
        const status=deadline?'failed_deadline':'failed_budget';
        db.query('UPDATE session_peer_replies SET status=?,error=? WHERE event_id=?').run(status,error instanceof Error?error.message:String(error),reply.event_id);
        log('error',deadline?'session_peer_reply_deadline_exhausted':'session_peer_reply_budget_exhausted',
          {request_id:row.request_id,peer:row.peer,event_id:reply.event_id,attempts:error instanceof RetryBudgetExhaustedError?error.attempts:null,...errorFields(error)});
      }
    }
    if(row.closed_at_ms)return;
    this.chaseStranded(row,this.status(row.request_id));
    row=this.delivery(row.request_id);
    const status=this.status(row.request_id);
    const fingerprint=JSON.stringify([status.hold?.code??null,status.inputState,status.execution?.status??null,status.execution?.settled??null,status.stillWorking,status.replies.map(reply=>reply.eventId+':'+reply.status),status.stalled?.atMs??null]);
    // A withdrawn origin may have changed while this queued peer turn did not.
    // Poll the origin once after each reconciliation even with the same local
    // fingerprint; otherwise an offline Mac learns of cancellation only at reset.
    const target=getAcceptedSessionInput(row.target_input_id);
    const queued=target?.turn_id!==null&&target?.turn_id!==undefined
      &&!!db.query("SELECT 1 FROM turns WHERE id=? AND status='queued'").get(target.turn_id);
    const unchanged=fingerprint===row.notified_fingerprint;
    if(unchanged&&!queued)return;
    try {
      const notify=()=>client.request<{outcome:string|null}>('POST',`/sessions/v1/peers/requests/${encodeURIComponent(row.request_id)}/notify`,{},undefined,false);
      // An unchanged queued target only needs one origin check after reconnect.
      // Reopening the full retry budget each interval would produce repeated
      // retry-stopped repair notices while the origin is offline.
      const answer=unchanged?await notify():await withRetry({operation:'peer-notify',key:`${row.request_id}:${fingerprint}`,
        policy:RETRY_POLICIES.peerNotify,run:notify,
        classifyError:(error)=>error instanceof PeerError&&error.kind==='refused'
          &&!(error.status===404&&this.now()-row.created_at_ms<=PEER_REQUEST_ORPHAN_GRACE_MS)?'permanent':'transient',
      });
      this.unreachable.delete(row.peer);
      db.query('UPDATE session_peer_deliveries SET notified_fingerprint=?,closed_at_ms=CASE WHEN ? THEN ? ELSE closed_at_ms END WHERE request_id=?').run(fingerprint,answer?.outcome?1:0,this.now(),row.request_id);
      if(answer?.outcome==='canceled'&&!db.query("SELECT 1 FROM session_peer_replies WHERE request_id=? AND kind='final'").get(row.request_id))
        this.canceledByOrigin(row.request_id);
    } catch(error) {
      this.note(row.peer,error);
      // The origin commits its request only after this instance accepted it, so a 404 within
      // the first minutes is a race, not an orphan; an old delivery the origin never learned of is.
      const orphan=error instanceof PeerError&&error.kind==='refused'&&error.status===404&&this.now()-row.created_at_ms>PEER_REQUEST_ORPHAN_GRACE_MS;
      if(orphan)db.query('UPDATE session_peer_deliveries SET closed_at_ms=? WHERE request_id=?').run(this.now(),row.request_id);
      else {
        // This exact status projection is exhausted. A later state change has a new fingerprint;
        // the origin can also pull the retained request without a push notification.
        db.query('UPDATE session_peer_deliveries SET notified_fingerprint=? WHERE request_id=?').run(fingerprint,row.request_id);
        log('warn','session_peer_notify_failed',{request_id:row.request_id,peer:row.peer,status:error instanceof PeerError?error.status:null,...errorFields(error)});
      }
    }
  }

  // ---- scheduling, shared with the coordinator's wake ----
  private incidentScanTraceRemaining=200;
  private async scanRows<T>(table:string,sql:string,visit:(row:T)=>void,...args:(number|string)[]) {
    if(this.incidentScanTraceRemaining-- > 0)
      log('warn','incident_reconciliation_scan',{table,sql:sql.replace(/\s+/g,' ').slice(0,400)});
    const query=db.query(sql);
    const highWater=(db.query(`SELECT max(rowid) AS value FROM ${table}`).get() as {value:number|null}).value??0;
    let cursor=0;
    while(!this.stopped){
      const row=query.get(...args,highWater,cursor) as (T&{reconciliation_rowid:number})|null;
      if(!row)return;
      cursor=row.reconciliation_rowid;
      visit(row);
      await new Promise<void>(resolve=>setImmediate(resolve));
    }
  }
  private async reconcile() {
    while(this.reconciliationDirty&&!this.stopped){
      this.reconciliationDirty=false;
      // Catalogue refreshes have their own task owner and bounded interval.
      for(const name of this.dependencies.clients.keys())void this.refreshCatalogue(name);
      // Each scan names its partial index: Bun's SQLite otherwise walked the whole table by rowid,
      // stored payloads included, on every wake (about three times a second on 2026-11-03).
      await this.scanRows<PeerRequestRow>('session_peer_requests','SELECT rowid AS reconciliation_rowid,* FROM session_peer_requests INDEXED BY session_peer_open_reconcile WHERE outcome IS NULL AND rowid<=? AND rowid>? ORDER BY rowid LIMIT 1',
        row=>this.closeStranded(row));
      await this.scanRows<PeerRequestRow>('session_peer_requests',`SELECT rowid AS reconciliation_rowid,* FROM session_peer_requests INDEXED BY session_peer_requests_canceled
          WHERE outcome='canceled' AND remote_operation_id IS NOT NULL
            AND coalesce(json_extract(remote_status_json,'$.cancellationAcknowledged'),0)=0
            AND rowid<=? AND rowid>? ORDER BY rowid LIMIT 1`,
        row=>this.schedule(`cancel:${row.request_id}`,()=>this.revokeCanceledRemote(row.request_id)));
      await this.scanRows<PeerRequestRow>('session_peer_requests',"SELECT rowid AS reconciliation_rowid,* FROM session_peer_requests INDEXED BY session_peer_open_reconcile WHERE outcome IS NULL AND overdue_at_ms IS NULL AND json_extract(remote_status_json,'$.hold.code') IS NOT NULL AND rowid<=? AND rowid>? ORDER BY rowid LIMIT 1",
        row=>this.inspectHold(row));
      await this.scanRows<PeerRequestRow>('session_peer_requests',`SELECT rowid AS reconciliation_rowid,* FROM session_peer_requests INDEXED BY session_peer_open_reconcile WHERE ${AWAITING_INSPECTION} AND due_at_ms<=? AND rowid<=? AND rowid>? ORDER BY rowid LIMIT 1`,
        row=>this.inspectOverdueRequest(row),this.now());
      if(this.unrecovered.size)this.schedule('recover-discarded-replies',()=>this.recoverDiscardedReplies());
      // A cancellation could have been admitted by an older release without revoking its
      // held turn. The cancellation instruction itself can then sit behind that same hold.
      await this.scanRows<DeliveryRow>('session_peer_deliveries',`SELECT d.rowid AS reconciliation_rowid,d.* FROM session_peer_deliveries d
          JOIN session_inputs notice ON notice.id='canceled:'||d.request_id
          JOIN session_inputs target ON target.id=d.target_input_id
          JOIN turns turn ON turn.id=target.turn_id
          WHERE d.closed_at_ms IS NOT NULL AND turn.status='queued' AND turn.saved_kind IS NULL
            AND d.rowid<=? AND d.rowid>? ORDER BY d.rowid LIMIT 1`,
        row=>this.canceledByOrigin(row.request_id));
      await this.scanRows<PeerRequestRow>('session_peer_requests','SELECT rowid AS reconciliation_rowid,* FROM session_peer_requests INDEXED BY session_peer_open_reconcile WHERE outcome IS NULL AND rowid<=? AND rowid>? ORDER BY rowid LIMIT 1',
        row=>this.schedule(`ask:${row.request_id}`,()=>this.dispatch(this.row(row.request_id))));
      await this.scanRows<PeerEventRow>('session_peer_events',"SELECT rowid AS reconciliation_rowid,* FROM session_peer_events INDEXED BY session_peer_events_undelivered WHERE status NOT IN ('received','retained') AND rowid<=? AND rowid>? ORDER BY rowid LIMIT 1",
        event=>this.schedule(`event:${event.event_id}`,()=>this.deliver(event)));
      await this.scanRows<DeliveryRow>('session_peer_deliveries',`SELECT rowid AS reconciliation_rowid,* FROM session_peer_deliveries WHERE (closed_at_ms IS NULL
          OR request_id IN (SELECT request_id FROM session_peer_replies WHERE status='pending')) AND rowid<=? AND rowid>? ORDER BY rowid LIMIT 1`,
        row=>{
          if(row.closed_at_ms===null){
            const target=getAcceptedSessionInput(row.target_input_id)!;
            if(target.turn_id===null)this.dependencies.owner.dispatch(target);
          }
          this.schedule(`report:${row.request_id}`,()=>this.report(this.delivery(row.request_id)));
        });
      await this.scanRows<DeliveryRow>('session_peer_deliveries',`SELECT rowid AS reconciliation_rowid,* FROM session_peer_deliveries WHERE closed_at_ms IS NULL AND prompt_reminded_at_ms IS NULL
          AND json_extract(origin_provenance_json,'$.forwardedIntent.promptAnswer')=1 AND created_at_ms<=? AND rowid<=? AND rowid>? ORDER BY rowid LIMIT 1`,
        row=>this.remindPromptAnswer(row),this.now()-PROMPT_ANSWER_REMINDER_MS);
      if(!this.stopped)this.arm();
    }
  }
  wake() {
    if(this.stopped)return;
    this.reconciliationDirty=true;
    if(this.reconciliation)return;
    this.dependencies.onWake?.();
    this.reconciliation=new Promise<void>(resolve=>setImmediate(resolve))
      .then(()=>this.reconcile())
      .catch(error=>{this.reconciliationDirty=false;this.disarm?.();this.disarm=null;this.dependencies.onError(error);})
      .finally(()=>{this.reconciliation=null;if(this.reconciliationDirty&&!this.stopped)this.wake();});
  }
  private schedule(key:string,work:()=>Promise<void>) {
    if(this.tasks.has(key)){this.again.add(key);return;}
    const task=Promise.resolve().then(work);
    this.tasks.set(key,task);
    void task.catch(this.dependencies.onError).finally(()=>{this.tasks.delete(key);if(this.again.delete(key)&&!this.stopped)this.schedule(key,work);});
  }
  /** Retry an unreachable peer on a bounded timer while something is still owed; nothing runs when nothing is owed. */
  private arm() {
    this.disarm?.();this.disarm=null;
    if(this.stopped)return;
    const owed=this.dependencies.hasPendingOperations?.()||this.unrecovered.size>0||(db.query("SELECT 1 FROM inbox_notification_promises WHERE target_session IS NOT NULL AND target_session NOT LIKE 'concierge:%' AND state='pending' LIMIT 1").get()
      ||db.query("SELECT 1 FROM session_peer_requests WHERE outcome IS NULL LIMIT 1").get()
      ||db.query("SELECT 1 FROM session_peer_replies WHERE status='pending' LIMIT 1").get()
      ||db.query('SELECT 1 FROM session_peer_deliveries WHERE closed_at_ms IS NULL LIMIT 1').get())!==null;
    const due=(db.query(`SELECT min(due_at_ms) AS due FROM session_peer_requests WHERE ${AWAITING_INSPECTION}`).get() as {due:number|null}).due;
    const reminder=(db.query(`SELECT min(created_at_ms)+? AS due FROM session_peer_deliveries WHERE closed_at_ms IS NULL AND prompt_reminded_at_ms IS NULL
      AND json_extract(origin_provenance_json,'$.forwardedIntent.promptAnswer')=1`).get(PROMPT_ANSWER_REMINDER_MS) as {due:number|null}).due;
    const delays=[...(owed?[retryDelayMs(RETRY_POLICIES.peerRequest,RETRY_POLICIES.peerRequest.maxAttempts)]:[]),...(due===null?[]:[Math.max(0,due-this.now())]),...(reminder===null?[]:[Math.max(0,reminder-this.now())])];
    if(!delays.length)return;
    const timer=setTimeout(()=>this.wake(),Math.min(24*60*60_000,...delays));
    timer.unref();
    this.disarm=()=>clearTimeout(timer);
  }
  start(){if(!this.stopped)return;this.peerReadController=new AbortController();this.stopped=false;this.unrecovered=new Set(this.dependencies.clients.keys());this.wake();}
  /**
   * Before September 23, 2026 this instance closed peer requests by inference from a finished
   * turn and then discarded the recipient's later replies while telling the peer they arrived,
   * so the peer never sent them again. Its own reply record still holds them: read it once per
   * start for the recent inferred closures and record what is missing, which supersedes the
   * inference and returns it. Event IDs make this idempotent. A peer that does not answer stays
   * in `unrecovered` and is retried on the minute retry timer until every read succeeds.
   */
  private unrecovered=new Set<string>();
  private async recoverDiscardedReplies() {
    const since=this.now()-14*24*60*60*1000;
    const failed=new Set<string>();
    const highWater=(db.query('SELECT max(rowid) AS value FROM session_peer_requests').get() as {value:number|null}).value??0;
    const query=db.query('SELECT rowid AS reconciliation_rowid,* FROM session_peer_requests WHERE outcome IS NOT NULL AND created_at_ms>=? AND rowid<=? AND rowid>? ORDER BY rowid LIMIT 1');
    let cursor=0;
    while(!this.stopped) {
      const row=query.get(since,highWater,cursor) as (PeerRequestRow&{reconciliation_rowid:number})|null;
      if(!row)break;
      cursor=row.reconciliation_rowid;
      await new Promise<void>(resolve=>setImmediate(resolve));
      if(this.stopped)return;
      if(!this.unrecovered.has(row.peer)||failed.has(row.peer))continue;
      if(!isInferredFinal(this.currentFinal(row.request_id)))continue;
      const client=this.dependencies.clients.get(row.peer);
      if(!client)continue;
      try {
        const remote=await client.request<any>('GET',`/sessions/v1/peers/requests/${encodeURIComponent(row.request_id)}`,undefined,OWNER_READ_RESPONSE_MS,true,this.peerReadController.signal);
        if(this.stopped)return;
        for(const reply of (remote.replies as any[])??[])if(!db.query('SELECT 1 FROM session_peer_events WHERE event_id=?').get(reply.eventId)){
          const result=await this.pullReply(client,row,reply,true);
          log('info','session_peer_discarded_reply_recovered',{request_id:row.request_id,peer:row.peer,event_id:reply.eventId,kind:reply.kind,recorded:result?.recorded??'left for push'});
        }
      } catch(error) {if(this.stopped)return;failed.add(row.peer);log('warn','session_peer_discarded_reply_recovery_failed',{request_id:row.request_id,peer:row.peer,...errorFields(error)});}
    }
    if(this.stopped)return;
    for(const peer of [...this.unrecovered])if(!failed.has(peer))this.unrecovered.delete(peer);
  }
  async stop(){this.stopped=true;this.peerReadController.abort();this.reconciliationDirty=false;this.disarm?.();this.disarm=null;for(const job of this.catalogueTasks.values())job.controller.abort();await this.reconciliation;await Promise.allSettled([...this.tasks.values(),...[...this.catalogueTasks.values()].map(job=>job.promise)]);}
}
