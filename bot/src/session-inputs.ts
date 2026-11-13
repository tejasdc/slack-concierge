import { randomUUID } from 'node:crypto';
import { db, executionChanged, finishTurn, settleTurnDependencies, getSessionById, type ProviderId, type SessionRow } from './state';
import {DEFAULT_CHATGPT_THINKING,DEFAULT_HIS_CHATGPT_THINKING,HIS_CHATGPT_PREFIX,isHisChatGpt,resolveProviderAlias,resolveProviderDefault} from './aliases';
import {purposeLine} from './session-purpose';
import {inputProvenance} from './input-provenance';
import {notificationRequest} from './session-notification-request';
import {armThreadNotification} from './thread-notifications';
import {providerRefusalContinuationReason,type ProviderRefusalContinuationReason} from './provider-failures';
import {topicRouteAnchor} from './inbox-request-root';
import {capturesEnterRouter} from './inbox-producer-sources';
import {log} from './log';
import {claudeAllowanceHeld,CLAUDE_ALLOWANCE_HOLD_MESSAGE} from './claude-allowance-hold';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {projectCoordinates} from './session-projects';

const eventWriteCounts=new Map<string,{writes:number;rootCommits:number}>();
setInterval(()=>{
  if(!eventWriteCounts.size)return;
  const byKind=Object.fromEntries(eventWriteCounts);
  eventWriteCounts.clear();
  log('info','session_event_write_rate',{interval_ms:60_000,by_kind:byKind});
},60_000).unref();

export type AcceptedSessionInput = {
  id:string; session_id:number; scope:string; action_id:string; kind:string;
  origin:'human'|'agent'|'service'; payload_json:string; turn_id:number|null; steering_id:number|null;
  source_input_id:string|null; source_run_id:string|null; request_id:string|null; receipt_json:string|null;
  created_at:string; updated_at:string;
};
/**
 * Who actually wrote an input recorded as Tejas's, when that record was wrong: an agent
 * that reached a human intake (September 23, 2026: test captures shown as his words).
 */
export type AuthorCorrection={authorSessionId:number|null;reason:string;createdAt:string};
export function authorCorrection(inputId:string):AuthorCorrection|null {
  const row=db.query('SELECT author_session_id,reason,created_at FROM session_input_author_corrections WHERE input_id=?').get(inputId) as {author_session_id:number|null;reason:string;created_at:string}|null;
  return row?{authorSessionId:row.author_session_id,reason:row.reason,createdAt:row.created_at}:null;
}
/** Tejas's own words: recorded as human and not corrected to the agent that posted them. */
export const humanAuthored=(input:Pick<AcceptedSessionInput,'id'|'origin'>)=>input.origin==='human'&&!authorCorrection(input.id);
export type NativeSessionMetadata = {
  codexLifecycle?:import('./codex-session-lifecycle').CodexSessionLifecycle;
  title?:string; summary?:string; purpose?:string; cwd?:string; additionalDirs?:string[];
  claudeAccount?:string;
  /** Immutable account and runner that first started this provider conversation; labels only, never machine paths. */
  providerAccount?:string; providerRunner?:string|null;
  claudeCacheCall?:{account:string;conversation:string|null;callId:string;atMs:number;cacheable:boolean};
  claudeSelectionRevision?:number;
  /** Automatic picked this provider, not him: a zero-work refused first turn, and queued work its provider
   * cannot start (held-work-failover.ts), may move to another provider. His model choice clears it. */
  automaticProviderChoice?:boolean;
  automaticSmallTask?:boolean;
  /** The selected thinking model was verified against Tejas's own words or peer-retained choice. */
  explicitThinkingModelChoice?:string;
  /** Automatic provider failover tried this held session and found an input it could not move, or its
   * successor did not accept; it is not proposed again before this instant (held-work-failover.ts). */
  heldFailoverSkipUntil?:number;
  /** Retired 2026-09-29: nothing is said to him about accounts. Written null so old ones clear. */
  claudeAccountNotice?:null;
  /** Every turn runs as the Codex command line in its own unit, started and watched, never driven (outside-codex.ts). */
  outside?:boolean;
  project?:string|null; /** Stable runner identity; the absolute `cwd` remains local presentation metadata. */
  projectName?:string|null; projectPath?:string|null;
  /** The exact machine and account home chosen for this provider conversation. */
  providerRunner?:string|null; providerAccount?:string|null;
  workflowId?:string; model?:string|null; reasoningEffort?:string; inbox?:boolean; inboxRole?:'project-router'; repairAgent?:boolean; standingRole?:import('./standing-agents').StandingAgentRole|null; suspended?:boolean; pinned?:boolean;
  outcome?:'open'|'done'|'shipped'; saved?:boolean; generation?:number; readGeneration?:number; dismissedGeneration?:number;
  needs?:import('./session-turn-outcome').OpenNeed[]; turnOutcome?:import('./session-turn-outcome').TurnOutcomeView;
  withdrawnNeeds?:import('./session-turn-outcome').WithdrawnNeed[];
  origin?:'native'|'imported'|'reconstructed'; source?:any; interactionPolicy?:'consultation-only'; canvasObservation?:boolean; canvasBoardId?:string; nativeBinding?:any;
  lineage?:{boundary:string;sourceVersion:string|null};
  recovery?:{sourceAddress:string;reason:'claude_usage_exhausted'};
  /** Native continuation stays on its owning machine; archive resurrection remains a distinct copy. */
  resurrection?:{peer:string;sessionId:string;address:string;threadId:string;archivedAt:string;archivePath:string;resurrectedAt:string;kind?:'continued-in-place'|'archive-copy'};
};
/** Request outcomes that settle without confirmed success, so dependents wait for the requester. */
export const HOLDING_OUTCOMES=['unanswered','decision_needed','undetermined'];
/**
 * A final the owner wrote itself because a turn ended without a declared answer: `undetermined`
 * from a dedicated turn's retained text, or `unanswered`. It is the owner's inference, so the
 * recipient's own explicit final, arriving later, replaces it and returns. A reply's final
 * carries no `outcome` field; a sibling's answer names the request it answered. Neither is an
 * inference, and neither is failure or cancellation. On September 23, 2026 the owner inferred
 * `undetermined` from "final reply will follow", then discarded the final reply that followed.
 */
export function isInferredFinal(event:{kind:string;payload_json:string}|null|undefined):boolean {
  if(!event||event.kind!=='final')return false;
  const payload=JSON.parse(event.payload_json);
  return ['undetermined','unanswered'].includes(payload.outcome)&&!payload.output?.answered_by_request_id;
}
export function stablePayload(value:unknown):string {
  const order=(item:any):any=>Array.isArray(item)?item.map(order):item&&typeof item==='object'?Object.fromEntries(Object.keys(item).sort().filter(key=>item[key]!==undefined).map(key=>[key,order(item[key])])):item;
  return JSON.stringify(order(value));
}
export function sessionMetadata(session:SessionRow): NativeSessionMetadata {
  const meta: NativeSessionMetadata = JSON.parse(session.native_metadata_json || '{}');
  if (session.provider_id === 'chatgpt' && meta.origin === 'imported') {
    if (!meta.nativeBinding && meta.source?.nativeId && meta.source?.scope) {
      meta.nativeBinding = { accountScope: meta.source.scope, sessionId: meta.source.nativeId };
    }
    if (!meta.model) {
      meta.model = `${HIS_CHATGPT_PREFIX}${DEFAULT_HIS_CHATGPT_THINKING}`;
    }
  }
  return meta;
}
/** The stable runner chosen when this provider conversation first ran; legacy means unknown. */
export function providerRunnerForSession(session:SessionRow):{status:'bound';runner:string|null}|{status:'legacy'} {
  const metadata=sessionMetadata(session);
  return Object.prototype.hasOwnProperty.call(metadata,'providerRunner')
    ?{status:'bound',runner:metadata.providerRunner??null}:{status:'legacy'};
}
/** The stable provider account label chosen for this conversation; never infer from the current login. */
export function providerAccountForSession(session:SessionRow):{status:'bound';account:string}|{status:'legacy'} {
  const account=sessionMetadata(session).providerAccount;
  return typeof account==='string'&&account.trim()?{status:'bound',account}:{status:'legacy'};
}
export function updateSessionMetadata(sessionId:number, change:Partial<NativeSessionMetadata>) {
  const session = getSessionById(sessionId);
  if (!session) throw new Error('Unknown session.');
  db.query('UPDATE sessions SET native_metadata_json=? WHERE id=?').run(JSON.stringify({...sessionMetadata(session),...change}),sessionId);
  executionChanged();
}
export function normalizeSessionTitle(value:unknown):string|undefined {
  if(value===undefined)return undefined;
  if(typeof value!=='string'||!value.trim()||value.trim().length>120)throw new Error('Session name must contain 1–120 characters.');
  return value.trim();
}
export function initializeSessionTitle(sessionId:number, title:string|undefined) {
  if(title===undefined)return;
  db.transaction(()=>{
    const session=getSessionById(sessionId);
    if(!session)throw new Error('Unknown session.');
    if(sessionMetadata(session).title?.trim())return;
    updateSessionMetadata(sessionId,{title});
    recordSessionEvent({eventId:`session:${sessionId}:initial-title`,sessionId,kind:'title',payload:{title}});
  })();
}
/**
 * ChatGPT has no tools, so it can never run the self-title command every other provider uses:
 * the name it gave its own conversation is the only name that model chose. Adopt it for a
 * session that still has no name — the manually started chats Tejas opens himself — and never
 * over the name a creator or Tejas chose, which `initializeSessionTitle` already protects.
 * An unusable value is ignored rather than refused, because naming a session must never be
 * able to fail a turn ChatGPT already answered; `ChatGPT conversation` is the capability
 * host's own placeholder for a conversation ChatGPT has not titled yet.
 */
export function adoptProviderConversationTitle(sessionId:number, reported:string) {
  const title=reported.trim().replace(/\s+/g,' ').slice(0,120);
  if(!title||title.toLowerCase()==='chatgpt conversation')return;
  initializeSessionTitle(sessionId,title);
}
/**
 * Whether Tejas named this session himself, with the app's Rename control. His name is the
 * one a session may not write over: everything else a session carries as a name — one it
 * chose earlier, one another agent gave it at creation — is the session's own to correct.
 */
export function humanNamedSession(sessionId:number):boolean {
  return !!db.query(`SELECT 1 FROM session_inputs WHERE session_id=? AND kind='action' AND origin='human'
    AND json_extract(payload_json,'$.action.kind')='title' LIMIT 1`).get(sessionId);
}
/**
 * A session exists only with its purpose (`session-purpose.ts`): the type makes every creation
 * path state one. Paths typed loosely (peer resurrection) fall back to their name, which for a
 * continued conversation is its opening words; a session with neither is refused.
 */
export function createNativeSession(provider:ProviderId, metadata:NativeSessionMetadata&{summary:string|undefined}):SessionRow {
  if(provider==='claude-code'&&claudeAllowanceHeld())throw new Error(CLAUDE_ALLOWANCE_HOLD_MESSAGE);
  const summary=purposeLine(metadata.summary)??purposeLine(metadata.title);
  if(!summary)throw new Error('A session needs a purpose: say in one line what it is for.');
  const cwd=metadata.cwd??metadata.project??null;
  // A runner-bound session's project identity was resolved on that runner. Its `cwd` is
  // presentation metadata and may be meaningless on the owner machine, so never infer or
  // overwrite the durable project name from the owner's filesystem.
  const hasStableProjectIdentity=metadata.providerRunner!==undefined
    ||metadata.projectName!==undefined||metadata.projectPath!==undefined;
  const coordinates=!hasStableProjectIdentity&&typeof cwd==='string'
    ?projectCoordinates(process.env.CONCIERGE_WORKSPACE_ROOT?.trim()||join(homedir(),'workspace'),cwd)
    :null;
  const placed=coordinates?{...metadata,projectName:coordinates.projectName,projectPath:coordinates.projectPath}:metadata;
  const result=db.query(`INSERT INTO sessions(slack_channel_id,slack_thread_ts,provider_id,native_metadata_json)
    VALUES(NULL,NULL,?,?)`).run(provider,JSON.stringify({...placed,summary}));
  return getSessionById(Number(result.lastInsertRowid))!;
}
export function bindSessionProvider(sessionId:number, provider:ProviderId, uuid:string) {
  if (!uuid) throw new Error('Provider returned an empty native session identity.');
  const bound = db.query(`UPDATE sessions SET agent_session_uuid=?,
    binding_generation=binding_generation+CASE WHEN agent_session_uuid IS NOT NULL AND agent_session_uuid<>? THEN 1 ELSE 0 END,
    last_turn_at=CURRENT_TIMESTAMP WHERE id=? AND provider_id=?`).run(uuid,uuid,sessionId,provider);
  if (bound.changes !== 1) throw new Error('Provider binding no longer belongs to the admitted session.');
  executionChanged();
}
export function getAcceptedSessionInput(id:string) {
  return db.query('SELECT * FROM session_inputs WHERE id=?').get(id) as AcceptedSessionInput|null;
}
/**
 * A run owes a reply only to a request it was handed: steered into it, or started as its own turn.
 * A request still waiting in the queue, including a scheduled one before its time, belongs to the
 * turn that will carry it. On 2026-11-04 the Inbox router's Stop hook listed a request scheduled
 * for 14:00 as owed during an unrelated 09:53 run, and the router answered it four hours early.
 * A steered request is handed over only once its words reached the provider (or may have: an
 * ambiguous send is treated as reaching it). Attaching it to the running turn happens first and
 * preparing its text takes seconds; on 2026-11-09 concierge:3425's Stop hook demanded a verdict on
 * a request in that gap, twice, and the request's text arrived just after the verdict.
 */
export function handedToARun(id:string) {
  return !!db.query(`SELECT 1 FROM session_inputs input JOIN turns turn ON turn.id=input.turn_id
    LEFT JOIN turn_steering_messages steering ON steering.id=input.steering_id
    WHERE input.id=? AND turn.status<>'queued'
      AND (input.steering_id IS NULL OR steering.status IN ('sent','ambiguous'))`).get(id);
}
/** The owner's full record of who stands behind an input; the receipt list calls the same walk. */
export function sessionInputProvenance(input:AcceptedSessionInput) {
  return inputProvenance(db,input,nativeRunId);
}
export function acceptedInputForTurn(turnId:number) {
  return db.query("SELECT * FROM session_inputs WHERE turn_id=? AND steering_id IS NULL AND kind IN ('input','create','consultation','comparison','fork') ORDER BY rowid LIMIT 1").get(turnId) as AcceptedSessionInput|null;
}
export function nativeRunId(turnId:number):string {
  const existing=db.query('SELECT native_run_id FROM turns WHERE id=?').get(turnId) as {native_run_id:string|null}|null;
  if(!existing)throw new Error('Unknown execution.');
  if(existing.native_run_id)return existing.native_run_id;
  const row=db.query('UPDATE turns SET native_run_id=COALESCE(native_run_id,?) WHERE id=? RETURNING native_run_id').get(randomUUID(),turnId) as {native_run_id:string}|null;
  if (!row) throw new Error('Unknown execution.');
  return row.native_run_id;
}
export function recordSessionEvent(input:{eventId:string;sessionId:number;inputId?:string|null;turnId?:number|null;kind:string;payload:unknown}) {
  const routeAnchorInputId=input.inputId?.startsWith('topic-change:')
    ?topicRouteAnchor(db,input.sessionId,input.inputId):null;
  const inputId=routeAnchorInputId??input.inputId??null;
  const payload = JSON.stringify(routeAnchorInputId&&input.payload&&typeof input.payload==='object'&&!Array.isArray(input.payload)
    ?{...input.payload,threadRoot:input.inputId}:input.payload);
  const previous = db.query('SELECT session_id,input_id,turn_id,kind,payload_json FROM session_owner_events WHERE event_id=?').get(input.eventId) as any;
  if (previous) {
    if (previous.session_id!==input.sessionId || previous.input_id!==inputId || previous.turn_id!==(input.turnId??null) || previous.kind!==input.kind || previous.payload_json!==payload) throw new Error('Event identity conflict.');
    return;
  }
  const rootCommit=!db.inTransaction;
  db.transaction(()=>{
    db.query('INSERT INTO session_owner_events(event_id,session_id,input_id,turn_id,kind,payload_json) VALUES(?,?,?,?,?,?)')
      .run(input.eventId,input.sessionId,inputId,input.turnId??null,input.kind,payload);
  })();
  const count=eventWriteCounts.get(input.kind)??{writes:0,rootCommits:0};
  count.writes++;
  if(rootCommit)count.rootCommits++;
  eventWriteCounts.set(input.kind,count);
  executionChanged();
}
/**
 * A surface input can be durably retained while its session is paused, archived or otherwise
 * unable to admit a provider turn. That changes the operation receipt even though no `accepted`
 * execution event exists. Publish the exact input as a receipt delta without claiming queue or
 * provider admission; the deterministic identity makes retries and startup repair harmless.
 */
export function recordHeldInputReceiptEvent(input:AcceptedSessionInput) {
  if(input.kind!=='input'||input.turn_id!==null||input.steering_id!==null||input.request_id!==null
    ||input.scope!=='surface:thinkering')return false;
  const eventId=`receipt:${input.id}:retained`;
  const existing=db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(eventId);
  if(existing)return false;
  recordSessionEvent({eventId,sessionId:input.session_id,inputId:input.id,kind:'receipt',payload:{change:'retained'}});
  return true;
}
/**
 * Releases can meet inputs retained by the previous owner. Seek only unresolved surface inputs
 * and publish the missing receipt delta; Focus-review captures and settled inputs carry a state
 * and remain intentionally hidden until their own release path records its event.
 */
export function backfillHeldInputReceiptEvents() {
  const rows=db.query(`SELECT input.* FROM session_inputs input INDEXED BY session_inputs_surface_recovery
    WHERE input.scope='surface:thinkering' AND input.kind='input'
      AND input.turn_id IS NULL AND input.steering_id IS NULL AND input.request_id IS NULL
      AND json_extract(input.receipt_json,'$.admissionIntent')='queue'
      AND json_extract(input.receipt_json,'$.state') IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM session_owner_events event
        WHERE event.input_id=input.id AND event.kind IN ('accepted','inbox_capture','receipt')
      ) ORDER BY input.rowid`).all() as AcceptedSessionInput[];
  let recorded=0;
  db.transaction(()=>{for(const input of rows)if(recordHeldInputReceiptEvent(input))recorded++;})();
  return recorded;
}
export function recordSessionInputAttention(inputId:string) {
  return db.transaction(()=>{
    const input=getAcceptedSessionInput(inputId);
    if(!input)throw new Error('Attention requires an exact accepted input.');
    const turn=input.turn_id===null?null:db.query('SELECT session_id,dispatch_attempt FROM turns WHERE id=?').get(input.turn_id) as {session_id:number;dispatch_attempt:number}|null;
    if(input.turn_id!==null&&(!turn||turn.session_id!==input.session_id))throw new Error('Attention input and execution no longer match.');
    const attempt=turn?.dispatch_attempt??0,eventId=`attention:${input.id}:${attempt}`;
    if(db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(eventId))return false;
    // Older result events already advanced attention before attempt markers existed.
    const resultNotified=input.turn_id!==null&&db.query("SELECT 1 FROM session_owner_events WHERE turn_id=? AND input_id=? AND session_id=? AND kind='result' LIMIT 1")
      .get(input.turn_id,input.id,input.session_id);
    if(!resultNotified) {
      const session=getSessionById(input.session_id)!;
      updateSessionMetadata(session.id,{generation:(sessionMetadata(session).generation??0)+1});
    }
    recordSessionEvent({eventId,sessionId:input.session_id,inputId:input.id,turnId:input.turn_id,kind:'attention',payload:{dispatchAttempt:attempt}});
    return !resultNotified;
  })();
}
/** A recovered answer is a new arrival even if parking already raised attention for this attempt. */
export function recordRecoveredResultAttention(inputId:string,turnId:number) {
  const input=getAcceptedSessionInput(inputId);
  if(!input||input.turn_id!==turnId)throw new Error('Recovered attention requires the exact accepted run.');
  const eventId=`attention:recovered-result:${turnId}`;
  if(db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(eventId))return;
  const session=getSessionById(input.session_id)!;
  updateSessionMetadata(session.id,{generation:(sessionMetadata(session).generation??0)+1});
  recordSessionEvent({eventId,sessionId:input.session_id,inputId,turnId,kind:'attention',payload:{recoveredResult:true}});
}
export type RetainInputTiming={serializeMs:number;existingMs:number;cancellationMs:number;insertMs:number;readbackMs:number;transactionOtherMs:number};
export function retainSessionInput(input:{id?:string;sessionId:number;scope:string;actionId:string;kind:string;origin:AcceptedSessionInput['origin'];payload:unknown;sourceInputId?:string;sourceRunId?:string;requestId?:string;timing?:RetainInputTiming}) {
 const started=performance.now();
 let entered=0,exited=0;
 const timed=<T>(key:keyof Omit<RetainInputTiming,'transactionOtherMs'>,work:()=>T):T=>{
  if(!input.timing)return work();
  const began=performance.now();
  try{return work();}finally{input.timing[key]+=performance.now()-began;}
 };
 try{return db.transaction(()=>{
  entered=performance.now();
  try {
  const target=getSessionById(input.sessionId);
  if(target&&sessionMetadata(target).canvasObservation){
    const action=input.payload&&typeof input.payload==='object'&&'action' in input.payload
      ?(input.payload as {action?:unknown}).action:null;
    const control=action&&typeof action==='object'&&'kind' in action
      ?(action as {kind?:unknown}).kind:null;
    const ownCreate=input.scope==='surface:canvas-observation'&&input.kind==='create';
    const safeControl=input.scope==='surface:thinkering'&&input.origin==='human'&&(
      input.kind==='action'&&['title','summary','outcome','read','dismiss','archive','restore','pin','save'].includes(String(control))
      ||input.kind==='message-action'&&['reaction','save','follow'].includes(String(control)));
    if(!ownCreate&&!safeControl)throw new Error('CANVAS_OBSERVATION_ONLY');
  }
  if (!input.actionId || input.actionId.length>200) throw new Error('Stable client action identity required.');
  const rawPayload=timed('serializeMs',()=>stablePayload(input.payload));
  const value=JSON.parse(rawPayload);
  if(value&&typeof value==='object')delete value.notificationRequest;
  const words=value?.firstInput?.text??value?.text;
  const ownWords=!(value?.capture?.importOnly&&
    (value.capture.source?.metadata?.quoted?.kind!=='human'||value.capture.source?.metadata?.intent!=='action'));
  const classifiable=input.origin==='human'&&['input','create','inbox-capture'].includes(input.kind);
  const mark=classifiable&&ownWords
    ?notificationRequest(typeof words==='string'?words:''):null;
  const payload=timed('serializeMs',()=>stablePayload(classifiable&&value&&typeof value==='object'?{...value,notificationRequest:mark}:value));
  const old=timed('existingMs',()=>db.query('SELECT * FROM session_inputs WHERE scope=? AND action_id=?').get(input.scope,input.actionId)) as AcceptedSessionInput|null;
  if (old) {
    if (old.session_id!==input.sessionId || ![rawPayload,payload].includes(stablePayload(JSON.parse(old.payload_json))) || old.origin!==input.origin || old.kind!==input.kind
      || old.source_input_id!==(input.sourceInputId??null) || old.source_run_id!==(input.sourceRunId??null) || old.request_id!==(input.requestId??null)) throw new Error('Idempotency conflict: accepted action payload changed.');
    return {input:old,duplicate:true};
  }
  const id=input.id??randomUUID();
  const cancellation=timed('cancellationMs',()=>db.query('SELECT session_id,canceled_by_input_id FROM session_input_cancellations WHERE scope=? AND action_id=?')
    .get(input.scope,input.actionId)) as {session_id:number;canceled_by_input_id:string}|null;
  if(cancellation&&(cancellation.session_id!==input.sessionId||input.origin!=='human'||!['input','create'].includes(input.kind)))
    throw new Error('Idempotency conflict: canceled action identity belongs to a different input.');
  timed('insertMs',()=>db.query(`INSERT INTO session_inputs(id,session_id,scope,action_id,kind,origin,payload_json,source_input_id,source_run_id,request_id)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,input.sessionId,input.scope,input.actionId,input.kind,input.origin,payload,input.sourceInputId??null,input.sourceRunId??null,input.requestId??null));
  armThreadNotification({id,sessionId:input.sessionId,kind:input.kind,origin:input.origin,payload:value,mark});
  if(cancellation)db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?')
    .run(JSON.stringify({state:'canceled',canceledBy:cancellation.canceled_by_input_id}),id);
  return {input:timed('readbackMs',()=>getAcceptedSessionInput(id))!,duplicate:false};
  } finally {exited=performance.now();}
 })();}
 finally {if(input.timing)input.timing.transactionOtherMs+=Math.max(0,performance.now()-started-(exited-entered));}
}
function reopenDoneSessionForExecutableInput(session:SessionRow,input:AcceptedSessionInput,turnId:number) {
  const metadata=sessionMetadata(session);
  if(!['human','agent'].includes(input.origin)||metadata.outcome!=='done')return;
  updateSessionMetadata(session.id,{outcome:'open'});
  recordSessionEvent({eventId:`reopened:${input.id}`,sessionId:session.id,inputId:input.id,turnId,kind:'outcome',
    payload:{outcome:'open',previousOutcome:'done',reason:'executable_input_admitted'}});
}
export function enqueueSessionInput(inputId:string) {
  return db.transaction(() => {
    const input=getAcceptedSessionInput(inputId);
    if (!input) throw new Error('Accepted input does not exist.');
    if (input.turn_id!==null) return input;
    if (input.receipt_json&&JSON.parse(input.receipt_json).state) return input;
    const session=getSessionById(input.session_id);
    if (!session) throw new Error('Accepted session does not exist.');
    if (sessionMetadata(session).canvasObservation) throw new Error('CANVAS_OBSERVATION_ONLY');
    if (session.status==='archived' || sessionMetadata(session).suspended) return input;
    const value=JSON.parse(input.payload_json);
    const payload=input.kind==='create'?value.firstInput:value;
    const text=input.kind==='fork'?'':payload.text;
    const attachments=payload.attachments;
    if (input.kind!=='fork' && (typeof text!=='string' || (!text.trim()&&(!Array.isArray(attachments)||!attachments.length)))) throw new Error('An executable input needs text or an attachment.');
    if(input.origin==='human'||input.origin==='agent')discardQueuedTurnContinuations(session.id,'new_input');
    const metadata=sessionMetadata(session);
    const defaultChatGptModel = isHisChatGpt({ origin: metadata.origin, model: metadata.model, effort: metadata.reasoningEffort })
      ? `${HIS_CHATGPT_PREFIX}${DEFAULT_HIS_CHATGPT_THINKING}`
      : DEFAULT_CHATGPT_THINKING;
    const currentDefault=session.provider_id==='codex'?resolveProviderDefault('codex'):
      session.provider_id==='antigravity'?resolveProviderAlias('google'):
      session.provider_id==='chatgpt'?{model:defaultChatGptModel,reasoning_effort:null}:null;
    const inserted=db.query(`INSERT INTO turns(session_id,slack_user_msg_ts,user_text,status,turn_kind,accepted_input_id,
      requested_by_user_id,provider_model,reasoning_effort,replay_text,queue_priority)
      VALUES(?,NULL,?,'queued','native',?,?,?,?,?,?)`).run(input.session_id,text,input.id,input.origin,
        metadata.model??currentDefault?.model??null,metadata.reasoningEffort??currentDefault?.reasoning_effort??null,text,
        ['data-loss','medication'].includes(value.capture?.urgency)?1:0);
    const turnId=Number(inserted.lastInsertRowid);
    nativeRunId(turnId);
    db.query('UPDATE session_inputs SET turn_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND turn_id IS NULL').run(turnId,input.id);
    reopenDoneSessionForExecutableInput(session,input,turnId);
    recordSessionEvent({eventId:`queued:${input.id}:${turnId}`,sessionId:input.session_id,inputId:input.id,turnId,kind:'accepted',payload:{origin:input.origin,text:input.kind==='fork'?null:text}});
    return getAcceptedSessionInput(input.id)!;
  })();
}

export type TurnContinuationReason =
  | ProviderRefusalContinuationReason
  | {kind:'boundary'; detail:string; waitUntilMs?:number|null}
  /** The run was cut off from outside it: the Codex app server restarted itself (its own
   * updater, 2026-10-01 00:01 UTC) or the run went silent for the no-activity limit (a Mac whose
   * lid closed mid-run, 01:15 UTC). One continuation; a continuation that is cut off again is not
   * continued, so a run that keeps dying cannot loop. Claude's confirmed process exit
   * without a terminal result uses the same budget. */
  | {kind:'interrupted'; detail:string; waitUntilMs?:number|null};

/**
 * The turn now carrying a refused turn's work: follow each `turn-continuation:<id>` while the
 * turn before it ended in error, and return the last one. A turn that never failed carries itself.
 * One answer for every reader of a request's progress, local or on a peer: the Mac's report
 * followed only the first turn, so a request the server would have kept open for its continuation
 * closed as failed on 2026-11-02.
 */
export function carryingTurn(turnId:number):{id:number;status:string}|null {
  // A turn is carried on by its continuation when the provider refused it (error) or when it was
  // stopped at a planned banked boundary (saved_yield_reason), the 2026-11-12 case where a
  // paused quiet-only job's request was closed as cancelled while its continuation finished it.
  const turn=db.query('SELECT id,status,saved_yield_reason FROM turns WHERE id=?').get(turnId) as {id:number;status:string;saved_yield_reason:string|null}|null;
  if(!turn)return null;
  const continuationOf=(id:number)=>db.query("SELECT t.id,t.status,t.saved_yield_reason FROM session_inputs i JOIN turns t ON t.id=i.turn_id WHERE i.id=?")
    .get(`turn-continuation:${id}`) as {id:number;status:string;saved_yield_reason:string|null}|null;
  let current=turn;
  const seen=new Set<number>([turn.id]);
  while(current.status==='error'||current.status==='cancelled'&&current.saved_yield_reason!==null){
    const next=continuationOf(current.id);
    if(!next||seen.has(next.id))break;
    seen.add(next.id);
    current=next;
  }
  return {id:current.id,status:current.status};
}

/** A cancelled turn whose planned banked continuation has not been queued yet. */
export function awaitingBankedContinuation(turnId:number):boolean {
  return !!db.query(`SELECT 1 FROM turns t WHERE t.id=? AND t.status='cancelled' AND t.saved_yield_reason IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM session_inputs i WHERE i.id='turn-continuation:'||t.id)`).get(turnId);
}

/**
 * One continuation for one interrupted turn. The failed turn stays immutable; this is
 * new service-authored guidance in its own run. Call inside the failure transaction so
 * a crash cannot retain a failure without its owed continuation.
 */
export function queueTurnContinuation(sourceTurnId:number,reason:TurnContinuationReason):AcceptedSessionInput|null {
  return db.transaction(()=>{
    const source=db.query(`SELECT id,session_id,status,accepted_input_id,native_run_id,ended_at,stop_requested_at,saved_quiet_only
      FROM turns WHERE id=?`).get(sourceTurnId) as {id:number;session_id:number;status:string;accepted_input_id:string|null;
        native_run_id:string|null;ended_at:string|null;stop_requested_at:string|null;saved_quiet_only:number}|null;
    // A person's Stop is stop_requested_at, never the status: the system cancelling its own
    // work at a boundary it chose ends as cancelled too, and that work is owed a continuation.
    if(!source || source.stop_requested_at || !source.ended_at
      || (reason.kind==='provider_refused'?source.status!=='error':!['done','error','cancelled'].includes(source.status)))return null;
    // A crash after the agent declared its result is not unfinished work. Preserve that
    // declaration, including a question waiting for him, rather than restarting it.
    if(reason.kind==='interrupted'&&db.query(`SELECT 1 FROM session_owner_events
      WHERE turn_id=? AND kind='turn_outcome' AND json_extract(payload_json,'$.outcome')
        IN ('done','response','needs_you','failed') LIMIT 1`).get(sourceTurnId))return null;
    // A request may be withdrawn after its first turn ended but before a boundary creates
    // another one. Service inputs can name themselves as their source, so visit each
    // ancestry row once; UNION ALL would recurse forever on those valid inputs.
    if(source.accepted_input_id&&db.query(`WITH RECURSIVE ancestry(id,source_input_id) AS (
        SELECT id,source_input_id FROM session_inputs WHERE id=?
        UNION
        SELECT parent.id,parent.source_input_id FROM session_inputs parent
          JOIN ancestry child ON parent.id=child.source_input_id
      ) SELECT 1 FROM ancestry JOIN session_communication_requests request
        ON request.target_input_id=ancestry.id WHERE request.outcome='canceled'
          OR (?='interrupted' AND request.target_input_id=? AND request.outcome IS NOT NULL) LIMIT 1`)
      .get(source.accepted_input_id,reason.kind,source.accepted_input_id))return null;
    const session=getSessionById(source.session_id);
    if(!session || session.status==='archived' || sessionMetadata(session).suspended)return null;
    // A provider refusal stopped one account, not the work: the request that turn served is still
    // owed, and a newer input (often another requester's, steered into a busy session) does not
    // answer it. Dropping it settled a lab agent's request as failed at 2:54 AM on 2026-10-08
    // while the other account had room. Other continuations still yield to newer input.
    const refused=reason.kind==='provider_refused';
    if(!refused&&db.query(`SELECT 1 FROM turns WHERE session_id=? AND id>? LIMIT 1`).get(source.session_id,sourceTurnId))return null;
    if(!refused&&db.query(`SELECT 1 FROM session_inputs WHERE session_id=? AND origin IN ('human','agent')
      AND turn_id IS NULL AND created_at>=? LIMIT 1`).get(source.session_id,source.ended_at))return null;
    const id=`turn-continuation:${sourceTurnId}`;
    const prior=getAcceptedSessionInput(id);
    if(prior)return prior;
    const when=source.ended_at.endsWith('Z')?source.ended_at:`${source.ended_at} UTC`;
    if(reason.kind==='interrupted'&&source.accepted_input_id?.startsWith('turn-continuation:'))return null;
    const cause=reason.kind==='boundary'?`work stopped on purpose at a boundary: ${reason.detail}`
      :reason.kind==='interrupted'?`the run was cut off from outside: ${reason.detail}`
      :`the provider refused further work (${reason.refusal}): ${reason.detail}`;
    const text=`Your previous turn was cut off at ${when} because ${cause}. Continue the original request from that point. First check what you already did in your transcript above, git status, git log, and the remote where relevant before doing anything again. Do not replay the original input or repeat an effect whose outcome is uncertain. Any requests you owed remain owed; answer them through the request protocol.`;
    const saved=retainSessionInput({id,sessionId:source.session_id,scope:'turn-continuation',actionId:String(sourceTurnId),
      kind:'input',origin:'service',payload:{text,delivery:'queue',continuation:{sourceTurnId,reason}},
      ...(source.accepted_input_id?{sourceInputId:source.accepted_input_id}:{}),
      ...(source.native_run_id?{sourceRunId:source.native_run_id}:{})}).input;
    const queued=enqueueSessionInput(saved.id);
    if(queued.turn_id!==null){
      if(source.saved_quiet_only){
        // Every continuation entry point must carry the opt-in choice before a runner can
        // claim it. Provider refusals, background releases and startup recovery all use this path.
        const now=Date.now();
        const settings=db.query('SELECT wait_days FROM saved_work_settings WHERE singleton=1').get() as {wait_days:number};
        db.query(`UPDATE turns SET saved_kind='banked',saved_at_ms=?,saved_expires_at_ms=?,saved_quiet_only=1,
          dispatch_failure_class=NULL,dispatch_next_attempt_ms=NULL,dispatch_hold=NULL
          WHERE id=? AND status='queued'`).run(now,now+settings.wait_days*24*60*60_000,queued.turn_id);
        executionChanged();
        return queued;
      }
      // A usage wall on one account is no reason to wait while another has room: it runs now and the
      // account choice sends it there.
      const elsewhere=reason.kind==='provider_refused'&&reason.refusal==='usage'&&reason.elsewhere===true;
      const wait=!elsewhere&&reason.waitUntilMs && reason.waitUntilMs>Date.now()?reason.waitUntilMs:0;
      const hold=reason.kind==='provider_refused'&&reason.refusal==='sign_in'?'auth_wait'
        :elsewhere?null
        :reason.kind==='provider_refused'&&reason.refusal==='usage'&&!wait?'usage_wait'
        :reason.kind==='boundary'&&wait?'chosen_time':'backoff';
      db.query(`UPDATE turns SET dispatch_failure_class=?,dispatch_next_attempt_ms=?,dispatch_hold=? WHERE id=? AND status='queued'`)
        .run(hold,hold==='auth_wait'||hold==='usage_wait'?null:wait,
          reason.kind==='provider_refused'&&reason.refusal==='usage'&&!elsewhere?'usage':null,queued.turn_id);
    }
    return queued;
  })();
}

/** A newer addressed request takes over; the old continuation never runs beside it. A continuation owed
 * because a provider refused (one account out) is not superseded by new input; only pause and archive end it. */
export function discardQueuedTurnContinuations(sessionId:number,why:'new_input'|'pause'|'archive'):number {
  return db.transaction(()=>{
    const rows=db.query(`SELECT turns.id FROM turns JOIN session_inputs ON session_inputs.id=turns.accepted_input_id
      WHERE turns.session_id=? AND turns.status='queued' AND session_inputs.scope='turn-continuation'
        AND (?<>'new_input' OR COALESCE(json_extract(session_inputs.payload_json,'$.continuation.reason.kind'),'')<>'provider_refused')`).all(sessionId,why) as {id:number}[];
    for(const row of rows){
      finishTurn(row.id,'cancelled',`Continuation superseded by ${why}.`);
      recordSessionEvent({eventId:`continuation-discarded:${row.id}`,sessionId,turnId:row.id,kind:'continuation_discarded',payload:{why}});
    }
    return rows.length;
  })();
}

/** One startup pass for recent provider refusals that predate automatic continuation. */
export function recoverProviderRefusalContinuations():Array<{turnId:number;provider:'codex'|'claude-code';reason:TurnContinuationReason}>{
  const rows=db.query(`SELECT turn.id,turn.agent_text,turn.ended_at,turn.dispatch_attempt,
      session.provider_id AS provider
    FROM turns turn JOIN sessions session ON session.id=turn.session_id
    WHERE turn.status='error' AND turn.ended_at>=datetime('now','-24 hours')
      AND turn.stop_requested_at IS NULL AND session.provider_id IN ('codex','claude-code')
      AND session.status<>'archived' AND COALESCE(json_extract(session.native_metadata_json,'$.suspended'),0)=0
      AND turn.id=(SELECT max(later.id) FROM turns later WHERE later.session_id=turn.session_id)
      AND EXISTS(SELECT 1 FROM session_owner_events event WHERE event.turn_id=turn.id
        AND event.kind='message' AND json_extract(event.payload_json,'$.message.role') IN ('assistant','tool'))
      AND NOT EXISTS(SELECT 1 FROM session_inputs later WHERE later.session_id=turn.session_id
        AND later.origin IN ('human','agent') AND later.created_at>turn.ended_at)
      AND NOT EXISTS(SELECT 1 FROM session_inputs waiting WHERE waiting.session_id=turn.session_id
        AND waiting.turn_id IS NULL AND waiting.kind='input' AND waiting.receipt_json IS NULL)
  `).all() as {id:number;agent_text:string|null;ended_at:string;dispatch_attempt:number;provider:'codex'|'claude-code'}[];
  const created:Array<{turnId:number;provider:'codex'|'claude-code';reason:TurnContinuationReason}>=[];
  for(const row of rows){
    const message=row.agent_text??'';
    const reset=Date.parse(message.match(/Usage resets at (\d{4}-\d\d-\d\dT[^.\s]+(?:\.\d+)?Z)/)?.[1]??'');
    const ended=Date.parse(row.ended_at.replace(' ','T')+'Z');
    const reason=providerRefusalContinuationReason(message,Number.isFinite(reset)?reset:null,
      Number.isFinite(ended)?ended:Date.now(),row.dispatch_attempt);
    if(!reason)continue;
    const input=queueTurnContinuation(row.id,reason);
    if(input?.turn_id!==null && input?.turn_id!==undefined)created.push({turnId:input.turn_id,provider:row.provider,reason});
  }
  return created;
}
/**
 * Whether an earlier live hand-off of this message could have reached the provider: sent, being
 * sent or uncertain. Only such an attempt stands in the way of another. A failed attempt with no
 * send time is the owner's own proof nothing was written, the same proof that returned it to the
 * queue, so the message may join the next live run. Treating it as a permanent barrier left his
 * thread reply waiting 87 minutes behind a 2h20m turn while later messages went straight in
 * (docs/incidents/2026-11-02-reply-queued-after-restart-missed-handoff.md).
 */
const STEERING_MAY_HAVE_REACHED_PROVIDER="NOT (status='failed' AND provider_sent_at IS NULL)";
export function steeringMayHaveReachedProvider(inputId:string):boolean {
  return !!db.query(`SELECT 1 FROM turn_steering_messages WHERE accepted_input_id=? AND ${STEERING_MAY_HAVE_REACHED_PROVIDER} LIMIT 1`).get(inputId);
}
/**
 * A message's first hand-off keeps its plain record names; a later attempt, which may join another
 * run, gets its own, because a recorded event never changes turn. Reusing the names refused the
 * second attempt and stranded two reminders after a restart (2026-11-02).
 */
export function steeringAttemptEventId(base:string,inputId:string,steeringId:number):string {
  const earlier=db.query('SELECT 1 FROM turn_steering_messages WHERE accepted_input_id=? AND id<? LIMIT 1').get(inputId,steeringId);
  return earlier?`${base}:attempt:${steeringId}`:base;
}
export function attachSessionSteering(inputId:string,turnId:number) {
  return db.transaction(() => {
    const input=getAcceptedSessionInput(inputId);
    if (!input) throw new Error('Unknown accepted input.');
    if (input.steering_id!==null) return input;
    // Every attempt keeps its row as history; one that may have reached the provider is never repeated.
    if(steeringMayHaveReachedProvider(input.id))return input;
    if (input.turn_id!==null) {
      // An explicit Inbox "work together" action can move a never-received
      // queued capture into this run without replacing its accepted identity.
      const queued=db.query(`SELECT id FROM turns WHERE id=? AND session_id=? AND status='queued'
        AND accepted_input_id=? AND owner_instance_id IS NULL
        AND provider_admission_intended_at IS NULL AND provider_started_at IS NULL
        AND provider_turn_id IS NULL AND provider_input_acknowledged_at IS NULL
        AND saved_kind IS NULL`).get(input.turn_id,input.session_id,input.id) as {id:number}|null;
      const capture=JSON.parse(input.payload_json).capture;
      if(!queued||!sessionMetadata(getSessionById(input.session_id)!).inbox
        ||!capturesEnterRouter(input.origin,capture?.source?.kind))
        throw new Error('Only a never-received Inbox capture can join a running turn.');
      db.query("UPDATE turns SET accepted_input_id=NULL WHERE id=? AND status='queued'").run(queued.id);
      finishTurn(queued.id,'cancelled','Joined the current Inbox work.');
      settleTurnDependencies(queued.id);
      db.query('UPDATE session_inputs SET turn_id=NULL WHERE id=? AND turn_id=?').run(input.id,queued.id);
    }
    const active=db.query("SELECT session_id FROM turns WHERE id=? AND status='running' AND stop_requested_at IS NULL").get(turnId) as {session_id:number}|null;
    if (!active || active.session_id!==input.session_id) throw new Error('Active execution no longer matches the accepted input.');
    if(input.origin==='human'||input.origin==='agent')discardQueuedTurnContinuations(input.session_id,'new_input');
    const value=JSON.parse(input.payload_json);
    const {text}=input.kind==='create'?value.firstInput:value;
    const added=db.query(`INSERT INTO turn_steering_messages(turn_id,slack_user_msg_ts,user_text,replay_text,accepted_input_id)
      VALUES(?,NULL,?,?,?)`).run(turnId,text,text,input.id);
    const steeringId=Number(added.lastInsertRowid);
    db.query('UPDATE session_inputs SET turn_id=?,steering_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(turnId,steeringId,input.id);
    reopenDoneSessionForExecutableInput(getSessionById(input.session_id)!,input,turnId);
    recordSessionEvent({eventId:steeringAttemptEventId(`input:${input.id}`,input.id,steeringId),sessionId:input.session_id,inputId:input.id,turnId,kind:'accepted',payload:{origin:input.origin,text}});
    return getAcceptedSessionInput(input.id)!;
  })();
}
/**
 * Unselected messages reach the agent in accepted order. When one joins the running
 * work, earlier unselected messages in that session still waiting for their own turns
 * come with it, oldest first: their waiting turns are withdrawn and the caller
 * delivers them into the run ahead of the later one. Without this a message recorded into a
 * conversation sat queued behind the run while the next one he typed went straight in and was
 * answered (concierge:4081, 2026-10-08 23:42). A message he explicitly queued stays queued: that
 * was his choice of "after this work". Older pages and routes that wrote Queue without
 * a choice marker did not prove that choice. Saved work retains its chosen time.
 *
 * Only a message the run will actually take is released. `canJoin` is the caller's own
 * admission rule for that run, asked before the waiting turn is withdrawn, so a message the run
 * refuses keeps its queue place untouched. Withdrawing first and refusing afterwards put every
 * refused message back in a new turn on every later send: a Canvas think-aloud run takes only
 * speech from its own page, and twelve agent returns waiting behind it were cancelled and
 * re-queued on each of his speech segments, ~170 ledger statements each, until a send cost 1 s
 * of the owner's thread (docs/incidents/2026-11-02-think-aloud-send-requeued-every-waiting-return.md).
 */
export function releaseEarlierWaitingInputs(sessionId:number,laterInputId:string,canJoin:(input:AcceptedSessionInput)=>boolean=()=>true):AcceptedSessionInput[] {
  const later=getAcceptedSessionInput(laterInputId);
  if(!later)return [];
  const laterBody=JSON.parse(later.payload_json);
  if(laterBody.delivery==='queue'&&laterBody.queueChosen===true)return [];
  return releaseWaiting(sessionId,laterInputId,canJoin);
}
/**
 * The same messages, when a run taken back after a restart can accept messages again. A restart
 * discards the run's not-yet-sent hand-offs and returns them to the queue; without this they waited
 * for the next message to the session, or for the whole turn to end (2026-11-02).
 */
export function releaseWaitingInputs(sessionId:number,canJoin:(input:AcceptedSessionInput)=>boolean=()=>true):AcceptedSessionInput[] {
  return releaseWaiting(sessionId,null,canJoin);
}
function releaseWaiting(sessionId:number,laterInputId:string|null,canJoin:(input:AcceptedSessionInput)=>boolean):AcceptedSessionInput[] {
  return db.transaction(()=>{
    const rows=db.query(`SELECT input.id AS id,turn.id AS turn_id FROM session_inputs input JOIN turns turn ON turn.id=input.turn_id
      WHERE input.session_id=? AND (? IS NULL OR input.id<>?) AND input.kind='input' AND input.steering_id IS NULL
        AND json_extract(input.receipt_json,'$.state') IS NULL
        AND json_extract(input.receipt_json,'$.forwardTarget') IS NULL
        AND (json_extract(input.payload_json,'$.delivery') IS NULL
          OR json_extract(input.payload_json,'$.delivery')='queue'
            AND json_extract(input.payload_json,'$.queueChosen') IS NULL
            AND (input.origin='human' OR input.origin='agent' AND (input.scope LIKE 'external:%' OR input.scope LIKE 'capture:%')))
        AND turn.status='queued' AND turn.accepted_input_id=input.id AND turn.saved_kind IS NULL
        AND turn.owner_instance_id IS NULL AND turn.provider_started_at IS NULL
        AND turn.provider_admission_intended_at IS NULL AND turn.provider_turn_id IS NULL
        AND turn.provider_input_acknowledged_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM turn_steering_messages prior WHERE prior.accepted_input_id=input.id
          AND ${STEERING_MAY_HAVE_REACHED_PROVIDER})
        AND NOT EXISTS (SELECT 1 FROM turn_dependencies dependency WHERE dependency.turn_id=turn.id)
        AND (? IS NULL OR input.rowid<(SELECT rowid FROM session_inputs WHERE id=?))
      ORDER BY input.rowid`).all(sessionId,laterInputId,laterInputId,laterInputId,laterInputId) as {id:string;turn_id:number}[];
    // Ask before withdrawing: a refused message keeps its queued turn and is not touched again.
    const joining=rows.filter(row=>{const input=getAcceptedSessionInput(row.id);return !!input&&canJoin(input);});
    for(const row of joining) {
      db.query("UPDATE turns SET accepted_input_id=NULL WHERE id=? AND status='queued'").run(row.turn_id);
      finishTurn(row.turn_id,'cancelled','Joined the running work with his next message.');
      db.query('UPDATE session_inputs SET turn_id=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND turn_id=?').run(row.id,row.turn_id);
    }
    return joining.map(row=>getAcceptedSessionInput(row.id)!);
  })();
}
/** Withdraw a redundant service copy only while no provider can have received it. */
export function withdrawUnstartedServiceInput(inputId:string,reason:string):boolean {
  return db.transaction(()=>{
    const input=getAcceptedSessionInput(inputId);
    if(!input||input.origin!=='service'||input.steering_id!==null)return false;
    const receipt=JSON.parse(input.receipt_json??'{}');
    if(receipt.state)return false;
    if(input.turn_id!==null){
      const turn=db.query(`SELECT * FROM turns WHERE id=? AND status='queued' AND owner_instance_id IS NULL
        AND provider_admission_intended_at IS NULL AND provider_started_at IS NULL
        AND provider_turn_id IS NULL AND provider_input_acknowledged_at IS NULL`).get(input.turn_id);
      if(!turn)return false;
      finishTurn(input.turn_id,'cancelled',reason);
      settleTurnDependencies(input.turn_id);
    }
    db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(JSON.stringify({...receipt,state:'canceled',reason}),inputId);
    return true;
  })();
}
/**
 * A live input the provider provably never received is not failed work. The
 * coordinator chose that live delivery, so its refusal returns the input to the
 * session's own queue, where it runs when the session can next receive it.
 * A busy recipient is never a refusal; only a caller-pinned live delivery, an
 * acknowledged or ambiguous send, a Slack-provenance steering message, or a
 * session that cannot accept input at all stays terminal.
 */
function continueUnsentAfterHandoff(input:AcceptedSessionInput):AcceptedSessionInput|null {
  const session=getSessionById(input.session_id);
  // An independent command may finish after a handoff; an earlier Google release can also
  // prove a follow-up never reached the provider after its obligations have changed hands.
  if(!session||!sessionMetadata(session).suspended
    ||!(sessionMetadata(session).outside&&input.origin==='human'||session.provider_id==='antigravity'))return null;
  let destination=input.session_id;
  const visited=new Set<number>();
  while(true){
    if(visited.has(destination))return null;
    visited.add(destination);
    const handoff=db.query("SELECT successor_session_id FROM session_handoffs WHERE predecessor_session_id=? AND state='accepted' ORDER BY accepted_at DESC LIMIT 1")
      .get(destination) as {successor_session_id:number}|null;
    if(!handoff)break;
    destination=handoff.successor_session_id;
  }
  if(destination===input.session_id)return null;
  const successor=getSessionById(destination);
  if(!successor||successor.status==='archived'||sessionMetadata(successor).suspended)return null;
  const payload=JSON.parse(input.payload_json);
  delete payload.delivery;delete payload.expectedRunId;delete payload.steerChosen;delete payload.queueChosen;
  const continued=retainSessionInput({id:`handoff-unsent:${input.id}`,sessionId:destination,
    scope:'handoff-unsent',actionId:input.id,kind:'input',origin:input.origin,payload,
    sourceInputId:input.id,sourceRunId:input.source_run_id??undefined,requestId:input.request_id??undefined}).input;
  const queued=enqueueSessionInput(continued.id);
  if(queued.turn_id===null)return null;
  db.query('UPDATE session_communication_requests SET target_input_id=?,target_turn_id=? WHERE target_session_id=? AND outcome IS NULL AND (target_input_id=? OR request_id=?)')
    .run(continued.id,queued.turn_id,destination,input.id,input.request_id??'');
  db.query('UPDATE session_external_requests SET target_input_id=? WHERE target_session_id=? AND outcome IS NULL AND (target_input_id=? OR request_id=?)')
    .run(continued.id,destination,input.id,input.request_id??'');
  db.query('UPDATE session_peer_deliveries SET target_input_id=? WHERE target_session_id=? AND closed_at_ms IS NULL AND (target_input_id=? OR request_id=?)')
    .run(continued.id,destination,input.id,input.request_id??'');
  db.query(`UPDATE session_inputs SET receipt_json=json_set(COALESCE(receipt_json,'{}'),
    '$.state','canceled','$.movedTo',?,'$.continuedAs',?),updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND json_extract(receipt_json,'$.state') IS NULL`)
    .run(`concierge:${destination}`,continued.id,input.id);
  return getAcceptedSessionInput(continued.id)!;
}
export function recoverUnsentSteeredInput(inputId:string) {
  return db.transaction(()=>{
    const input=getAcceptedSessionInput(inputId);
    if(!input)return input;
    // A message can have several attempts; the latest decides where it stands.
    const prior=db.query(`SELECT id,turn_id,status,provider_sent_at,slack_user_msg_ts FROM turn_steering_messages
      WHERE accepted_input_id=? ORDER BY id DESC LIMIT 1`).get(input.id) as {id:number;turn_id:number;status:string;provider_sent_at:string|null;slack_user_msg_ts:string|null}|null;
    if(input.steering_id===null){
      // A previous recovery may have detached the failed attempt before it could
      // put the same accepted input in the queue. Finish that durable next step.
      if(prior?.status==='failed'&&!prior.provider_sent_at&&input.turn_id===null
        &&!(input.receipt_json&&JSON.parse(input.receipt_json).state)
        &&!(input.origin==='service'&&JSON.parse(input.payload_json).delivery==='steer'))
        return (prior.slack_user_msg_ts===null?continueUnsentAfterHandoff(input):null)??enqueueSessionInput(input.id);
      if(prior&&!(prior.status==='failed'&&!prior.provider_sent_at)&&input.turn_id===null){
        db.query('UPDATE session_inputs SET turn_id=?,steering_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND turn_id IS NULL AND steering_id IS NULL')
          .run(prior.turn_id,prior.id,input.id);
        return getAcceptedSessionInput(input.id)!;
      }
      return input;
    }
    // A settled receipt is immutable history, and an input the queue would
    // refuse must stay attached to its evidence rather than become orphaned.
    if(input.receipt_json&&JSON.parse(input.receipt_json).state)return input;
    // Only a service's exact-run delivery refuses; his own message that missed its piece of work is
    // his next message (2026-10-08, two messages to concierge:4168 lost this way).
    if(JSON.parse(input.payload_json).delivery==='steer'&&input.origin==='service')return input;
    const steering=db.query(`SELECT status,provider_sent_at FROM turn_steering_messages
      WHERE id=? AND accepted_input_id=? AND slack_user_msg_ts IS NULL`).get(input.steering_id,input.id) as {status:string;provider_sent_at:string|null}|null;
    if(steering?.status!=='failed'||steering.provider_sent_at)return input;
    const session=getSessionById(input.session_id);
    if(!session||session.status==='archived')return input;
    if(sessionMetadata(session).suspended)return continueUnsentAfterHandoff(input)??input;
    db.query('UPDATE session_inputs SET turn_id=NULL,steering_id=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND steering_id=?').run(input.id,input.steering_id);
    // Queue in the same transaction as detaching. Dispatch must not see the
    // unattached input and attempt another steering insert with this identity.
    return enqueueSessionInput(input.id);
  })();
}
/**
 * Antigravity once advertised live steering even though its serial CLI could leave accepted
 * messages behind the current answer. A restart proved which attempts were never written. Move
 * only those inputs to the durable FIFO, keeping their original identity and accepted order.
 */
export function recoverUnsentAntigravityInputs() {
  const rows=db.query(`SELECT input.id,input.request_id FROM session_inputs input
    JOIN sessions session ON session.id=input.session_id
    JOIN turn_steering_messages steering ON steering.accepted_input_id=input.id
      AND steering.id=(SELECT MAX(latest.id) FROM turn_steering_messages latest WHERE latest.accepted_input_id=input.id)
    WHERE session.provider_id='antigravity'
      AND steering.status='failed' AND steering.provider_sent_at IS NULL
      AND json_extract(input.receipt_json,'$.state') IS NULL
      AND (input.steering_id=steering.id OR input.steering_id IS NULL AND input.turn_id IS NULL)
    ORDER BY input.rowid`).all() as {id:string;request_id:string|null}[];
  let queued=0;
  for(const row of rows) {
    // A later answer or cancellation already settled this exact obligation. A closed Inbox
    // request has no thread upkeep left to perform; neither should consume another model turn.
    if(row.request_id&&db.query('SELECT 1 FROM session_communication_requests WHERE request_id=? AND outcome IS NOT NULL').get(row.request_id))continue;
    if(row.request_id&&db.query('SELECT 1 FROM session_external_requests WHERE request_id=? AND outcome IS NOT NULL').get(row.request_id))continue;
    if(row.request_id&&db.query('SELECT 1 FROM session_peer_deliveries WHERE request_id=? AND closed_at_ms IS NOT NULL').get(row.request_id))continue;
    if(row.id.startsWith('thread-upkeep:')&&row.request_id
      &&db.query("SELECT 1 FROM inbox_requests WHERE request_id=? AND state='closed'").get(row.request_id))continue;
    const recovered=recoverUnsentSteeredInput(row.id);
    if(recovered?.turn_id!==null&&recovered?.steering_id===null)queued++;
  }
  return queued;
}
export function retainSlackInput(channel:string,messageTs:string) {
  return db.transaction(() => {
    const claim=db.query(`SELECT claim.*,turn.session_id,turn.turn_kind,turn.user_text AS turn_user_text,turn.slack_reply_thread_ts FROM slack_user_input_claims claim JOIN turns turn ON turn.id=claim.turn_id
      WHERE claim.slack_channel_id=? AND claim.slack_user_msg_ts=? AND claim.kind IN ('turn','steering')`).get(channel,messageTs) as any;
    if (!claim) throw new Error('Slack source is not an accepted session input.');
    const id=`slack:${channel}:${messageTs}`;
    const existing=getAcceptedSessionInput(id);
    if (existing) return existing;
    const peer=db.query('SELECT 1 FROM routed_requests WHERE channel_id=? AND message_ts=?').get(channel,messageTs);
    const steering=claim.kind==='steering'?db.query('SELECT id FROM turn_steering_messages WHERE turn_id=? AND slack_user_msg_ts=?').get(claim.turn_id,messageTs) as {id:number}|null:null;
    const steeringText=steering?(db.query('SELECT user_text FROM turn_steering_messages WHERE id=?').get(steering.id) as {user_text:string}).user_text:null;
    const saved=retainSessionInput({id,sessionId:claim.session_id,scope:`slack:${channel}`,actionId:messageTs,kind:'input',origin:peer?'agent':'human',payload:{text:claim.user_text??steeringText??claim.turn_user_text,slack:{channel,messageTs,rootTs:claim.reply_thread_ts??claim.slack_reply_thread_ts}}}).input;
    db.query('UPDATE session_inputs SET turn_id=?,steering_id=? WHERE id=?').run(claim.turn_id,steering?.id??null,saved.id);
    const table=steering?'turn_steering_messages':'turns';
    db.query(`UPDATE ${table} SET accepted_input_id=? WHERE id=?`).run(saved.id,steering?.id??claim.turn_id);
    return getAcceptedSessionInput(saved.id)!;
  })();
}
