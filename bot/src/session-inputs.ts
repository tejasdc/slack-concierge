import { randomUUID } from 'node:crypto';
import { db, executionChanged, getSessionById, type ProviderId, type SessionRow } from './state';
import {resolveProviderDefault} from './aliases';
import {receiveSessionFromPeer} from './peer-identity';

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
  project?:string|null; workflowId?:string; model?:string|null; reasoningEffort?:string; inbox?:boolean; inboxRole?:'project-router'; suspended?:boolean; pinned?:boolean;
  outcome?:'open'|'done'|'shipped'; saved?:boolean; generation?:number; readGeneration?:number; dismissedGeneration?:number;
  needs?:import('./session-turn-outcome').OpenNeed[]; turnOutcome?:import('./session-turn-outcome').TurnOutcomeView;
  origin?:'native'|'imported'|'reconstructed'; source?:any; interactionPolicy?:'consultation-only'; nativeBinding?:any;
  lineage?:{boundary:string;sourceVersion:string|null};
  /** A new process on this instance continuing a peer session's archived transcript; the original stays parked on its peer. */
  resurrection?:{peer:string;sessionId:string;address:string;threadId:string;archivedAt:string;archivePath:string;resurrectedAt:string};
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
  return JSON.parse(session.native_metadata_json || '{}');
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
 * Whether Tejas named this session himself, with the app's Rename control. His name is the
 * one a session may not write over: everything else a session carries as a name — one it
 * chose earlier, one another agent gave it at creation — is the session's own to correct.
 */
export function humanNamedSession(sessionId:number):boolean {
  return !!db.query(`SELECT 1 FROM session_inputs WHERE session_id=? AND kind='action' AND origin='human'
    AND json_extract(payload_json,'$.action.kind')='title' LIMIT 1`).get(sessionId);
}
export function createNativeSession(provider:ProviderId, metadata:NativeSessionMetadata):SessionRow {
  const result=db.query(`INSERT INTO sessions(slack_channel_id,slack_thread_ts,provider_id,native_metadata_json)
    VALUES(NULL,NULL,?,?)`).run(provider,JSON.stringify(metadata));
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
/** Resolve retained delegation links, never actor/provenance claims inside message text. */
/** A request a peer instance delivered here: its source lives in the peer's ledger, retained on the delivery row. */
function peerDeliveryProvenance(input:AcceptedSessionInput) {
  const delivery=db.query('SELECT peer,origin_session_id,origin_input_id,origin_run_id,requested_effect,origin_provenance_json FROM session_peer_deliveries WHERE target_input_id=?').get(input.id) as
    {peer:string;origin_session_id:string;origin_input_id:string;origin_run_id:string;requested_effect:string;origin_provenance_json:string|null}|null;
  if(!delivery)return null;
  const retained=delivery.origin_provenance_json?JSON.parse(delivery.origin_provenance_json):{};
  const effectScope:'informational'|'work'=retained.effectScope==='informational'||delivery.requested_effect!=='work'?'informational':'work';
  // Identities arrive named by the sender; see peer-identity.ts for the rule.
  const human=retained.originatingHuman&&typeof retained.originatingHuman.sessionId==='string'
    ?{...retained.originatingHuman,sessionId:receiveSessionFromPeer(retained.originatingHuman.sessionId,delivery.peer)}:null;
  return {source:{inputId:delivery.origin_input_id,runId:delivery.origin_run_id,sessionId:receiveSessionFromPeer(delivery.origin_session_id,delivery.peer),peer:delivery.peer},
    requestId:input.request_id,effectScope,originatingHuman:human as {inputId:string;runId:string;sessionId:string;captureId?:string}|null,peer:delivery.peer};
}
export function sessionInputProvenance(input:AcceptedSessionInput) {
  if(!input.source_input_id||!input.source_run_id)return peerDeliveryProvenance(input);
  const seen=new Set<string>();
  let current:AcceptedSessionInput|null=input;
  let source:{inputId:string;runId:string;sessionId:string}|null=null;
  let human:({inputId:string;runId:string;sessionId:string;captureId?:string})|null=null;
  let effectScope:'informational'|'work'|null=null;
  while(current?.source_input_id&&current.source_run_id&&!seen.has(current.id)) {
    seen.add(current.id);
    const parent=getAcceptedSessionInput(current.source_input_id);
    const turn=parent?.turn_id?db.query('SELECT native_run_id FROM turns WHERE id=? AND session_id=?').get(parent.turn_id,parent.session_id) as {native_run_id:string|null}|null:null;
    if(!parent||turn?.native_run_id!==current.source_run_id)break;
    const identity={inputId:parent.id,runId:current.source_run_id,sessionId:`concierge:${parent.session_id}`};
    source??=identity;
    if(current.origin==='agent'&&['input','create','consultation','request'].includes(current.kind)) {
      const request=db.query(`SELECT payload_json FROM session_communication_requests WHERE request_id=?
        AND ((target_input_id=? AND target_session_id=?) OR (?='request' AND source_session_id=?))
        AND source_input_id=? AND source_turn_id=?`).get(current.request_id,current.id,current.session_id,current.kind,current.session_id,parent.id,parent.turn_id) as {payload_json:string}|null;
      const peer=request?null:current.kind==='request'?db.query('SELECT payload_json FROM session_peer_requests WHERE request_id=? AND source_session_id=? AND source_input_id=? AND source_turn_id=?')
        .get(current.request_id,current.session_id,parent.id,parent.turn_id) as {payload_json:string}|null:null;
      if(!request&&!peer)break;
      const effect=JSON.parse((request??peer)!.payload_json).requestedEffect??'informational';
      effectScope=effectScope==='informational'||effect!=='work'?'informational':'work';
    }
    if(humanAuthored(parent)) {
      const payload=JSON.parse(parent.payload_json);
      human={...identity,...(payload.capture?.id?{captureId:payload.capture.id}:{})};
      break;
    }
    current=parent;
  }
  // A chain that ends at a peer-delivered input continues in the peer's ledger; its retained provenance supplies the human.
  const delivered=!human&&current?peerDeliveryProvenance(current):null;
  if(delivered){human=delivered.originatingHuman;effectScope=effectScope==='informational'||delivered.effectScope!=='work'?'informational':'work';}
  return source?{source,requestId:input.request_id,effectScope,originatingHuman:human,...(delivered?{peer:delivered.peer}:{})}:null;
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
  const payload = JSON.stringify(input.payload);
  const previous = db.query('SELECT session_id,input_id,turn_id,kind,payload_json FROM session_owner_events WHERE event_id=?').get(input.eventId) as any;
  if (previous) {
    if (previous.session_id!==input.sessionId || previous.input_id!==(input.inputId??null) || previous.turn_id!==(input.turnId??null) || previous.kind!==input.kind || previous.payload_json!==payload) throw new Error('Event identity conflict.');
    return;
  }
  db.transaction(()=>{
    db.query('INSERT INTO session_owner_events(event_id,session_id,input_id,turn_id,kind,payload_json) VALUES(?,?,?,?,?,?)')
      .run(input.eventId,input.sessionId,input.inputId??null,input.turnId??null,input.kind,payload);
  })();
  executionChanged();
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
    const resultNotified=input.turn_id!==null&&db.query('SELECT 1 FROM session_owner_events WHERE event_id=? AND input_id=? AND session_id=?').get(`result:${input.turn_id}`,input.id,input.session_id);
    if(!resultNotified) {
      const session=getSessionById(input.session_id)!;
      updateSessionMetadata(session.id,{generation:(sessionMetadata(session).generation??0)+1});
    }
    recordSessionEvent({eventId,sessionId:input.session_id,inputId:input.id,turnId:input.turn_id,kind:'attention',payload:{dispatchAttempt:attempt}});
    return !resultNotified;
  })();
}
export function retainSessionInput(input:{id?:string;sessionId:number;scope:string;actionId:string;kind:string;origin:AcceptedSessionInput['origin'];payload:unknown;sourceInputId?:string;sourceRunId?:string;requestId?:string}) {
  if (!input.actionId || input.actionId.length>200) throw new Error('Stable client action identity required.');
  const payload=stablePayload(input.payload);
  const old=db.query('SELECT * FROM session_inputs WHERE scope=? AND action_id=?').get(input.scope,input.actionId) as AcceptedSessionInput|null;
  if (old) {
    if (old.session_id!==input.sessionId || stablePayload(JSON.parse(old.payload_json))!==payload || old.origin!==input.origin || old.kind!==input.kind
      || old.source_input_id!==(input.sourceInputId??null) || old.source_run_id!==(input.sourceRunId??null) || old.request_id!==(input.requestId??null)) throw new Error('Idempotency conflict: accepted action payload changed.');
    return {input:old,duplicate:true};
  }
  const id=input.id??randomUUID();
  db.query(`INSERT INTO session_inputs(id,session_id,scope,action_id,kind,origin,payload_json,source_input_id,source_run_id,request_id)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,input.sessionId,input.scope,input.actionId,input.kind,input.origin,payload,input.sourceInputId??null,input.sourceRunId??null,input.requestId??null);
  return {input:getAcceptedSessionInput(id)!,duplicate:false};
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
    if (session.status==='archived' || sessionMetadata(session).suspended) return input;
    const value=JSON.parse(input.payload_json);
    const payload=input.kind==='create'?value.firstInput:value;
    const text=input.kind==='fork'?'':payload.text;
    const attachments=payload.attachments;
    if (input.kind!=='fork' && (typeof text!=='string' || (!text.trim()&&(!Array.isArray(attachments)||!attachments.length)))) throw new Error('An executable input needs text or an attachment.');
    const metadata=sessionMetadata(session);
    const currentDefault=session.provider_id==='codex'?resolveProviderDefault('codex'):null;
    const inserted=db.query(`INSERT INTO turns(session_id,slack_user_msg_ts,user_text,status,turn_kind,accepted_input_id,
      requested_by_user_id,provider_model,reasoning_effort,replay_text)
      VALUES(?,NULL,?,'queued','native',?,?,?,?,?)`).run(input.session_id,text,input.id,input.origin,
        metadata.model??currentDefault?.model??null,metadata.reasoningEffort??currentDefault?.reasoning_effort??null,text);
    const turnId=Number(inserted.lastInsertRowid);
    nativeRunId(turnId);
    db.query('UPDATE session_inputs SET turn_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND turn_id IS NULL').run(turnId,input.id);
    reopenDoneSessionForExecutableInput(session,input,turnId);
    recordSessionEvent({eventId:`queued:${input.id}:${turnId}`,sessionId:input.session_id,inputId:input.id,turnId,kind:'accepted',payload:{origin:input.origin,text:input.kind==='fork'?null:text}});
    return getAcceptedSessionInput(input.id)!;
  })();
}
export function attachSessionSteering(inputId:string,turnId:number) {
  return db.transaction(() => {
    const input=getAcceptedSessionInput(inputId);
    if (!input) throw new Error('Unknown accepted input.');
    if (input.turn_id!==null) return input;
    const active=db.query("SELECT session_id FROM turns WHERE id=? AND status='running' AND stop_requested_at IS NULL").get(turnId) as {session_id:number}|null;
    if (!active || active.session_id!==input.session_id) throw new Error('Active execution no longer matches the accepted input.');
    const value=JSON.parse(input.payload_json);
    const {text}=input.kind==='create'?value.firstInput:value;
    const added=db.query(`INSERT INTO turn_steering_messages(turn_id,slack_user_msg_ts,user_text,replay_text,accepted_input_id)
      VALUES(?,NULL,?,?,?)`).run(turnId,text,text,input.id);
    const steeringId=Number(added.lastInsertRowid);
    db.query('UPDATE session_inputs SET turn_id=?,steering_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(turnId,steeringId,input.id);
    reopenDoneSessionForExecutableInput(getSessionById(input.session_id)!,input,turnId);
    recordSessionEvent({eventId:`input:${input.id}`,sessionId:input.session_id,inputId:input.id,turnId,kind:'accepted',payload:{origin:input.origin,text}});
    return getAcceptedSessionInput(input.id)!;
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
export function recoverUnsentSteeredInput(inputId:string) {
  return db.transaction(()=>{
    const input=getAcceptedSessionInput(inputId);
    if(!input||input.steering_id===null)return input;
    // A settled receipt is immutable history, and an input the queue would
    // refuse must stay attached to its evidence rather than become orphaned.
    if(input.receipt_json&&JSON.parse(input.receipt_json).state)return input;
    // A pinned human live delivery names one exact run; it refuses rather than
    // silently becoming a later queued turn.
    if(JSON.parse(input.payload_json).delivery==='steer')return input;
    const steering=db.query(`SELECT status,provider_sent_at FROM turn_steering_messages
      WHERE id=? AND accepted_input_id=? AND slack_user_msg_ts IS NULL`).get(input.steering_id,input.id) as {status:string;provider_sent_at:string|null}|null;
    if(steering?.status!=='failed'||steering.provider_sent_at)return input;
    const session=getSessionById(input.session_id);
    if(!session||session.status==='archived'||sessionMetadata(session).suspended)return input;
    db.query('UPDATE session_inputs SET turn_id=NULL,steering_id=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND steering_id=?').run(input.id,input.steering_id);
    // The failed steering row remains evidence; this placement has its own
    // observation identity while the accepted input keeps its event identity.
    return enqueueSessionInput(input.id);
  })();
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
