import { randomUUID } from 'node:crypto';
import { db, executionChanged, getSessionById, getAgentSessionDashboardUserForTurn, type ProviderId, type SessionRow } from './state';

export type AcceptedSessionInput = {
  id:string; session_id:number; scope:string; action_id:string; kind:string;
  origin:'human'|'agent'|'service'; payload_json:string; turn_id:number|null; steering_id:number|null;
  source_input_id:string|null; source_run_id:string|null; request_id:string|null; receipt_json:string|null;
  created_at:string; updated_at:string;
};
export type NativeSessionMetadata = {
  title?:string; summary?:string; purpose?:string; cwd?:string; additionalDirs?:string[];
  project?:string|null; workflowId?:string; model?:string|null; suspended?:boolean; pinned?:boolean;
  outcome?:'open'|'done'|'shipped'; generation?:number; readGeneration?:number; dismissedGeneration?:number; attentionGeneration?:number;
  origin?:'native'|'imported'|'reconstructed'; source?:any; interactionPolicy?:'consultation-only'; nativeBinding?:any;
};
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
export function acceptedInputForTurn(turnId:number) {
  return db.query("SELECT * FROM session_inputs WHERE turn_id=? AND steering_id IS NULL AND kind IN ('input','create','consultation','fork') ORDER BY rowid LIMIT 1").get(turnId) as AcceptedSessionInput|null;
}
export function nativeRunId(turnId:number):string {
  const existing=db.query('SELECT native_run_id FROM turns WHERE id=?').get(turnId) as {native_run_id:string|null}|null;
  if(!existing)throw new Error('Unknown execution.');
  if(existing.native_run_id)return existing.native_run_id;
  const row=db.query('UPDATE turns SET native_run_id=COALESCE(native_run_id,?) WHERE id=? RETURNING native_run_id').get(randomUUID(),turnId) as {native_run_id:string}|null;
  if (!row) throw new Error('Unknown execution.');
  return row.native_run_id;
}
export function mentionsSessionOwner(text:string,turnId?:number|null):boolean {
  const prose=text.replace(/```[\s\S]*?(?:```|$)/g,'').replace(/`[^`\n]*`/g,'').replace(/^\s*>.*$/gm,'');
  if(/(^|[^\w@])@tejas\b/i.test(prose))return true;
  const ownerId=turnId?getAgentSessionDashboardUserForTurn(turnId):null;
  return !!ownerId&&/^U[A-Z0-9]+$/.test(ownerId)&&prose.includes(`<@${ownerId}>`);
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
    const body=input.payload as any;
    const message=input.kind==='message'&&body?.message?.role==='assistant'?body.message:null;
    const text=message?.content??(input.kind==='result'?body?.text:null);
    if(typeof text!=='string'||!mentionsSessionOwner(text,input.turnId))return;
    const mentionId=message?`mention:${input.sessionId}:${message.turnId??input.turnId??''}:${message.id}`:`mention:result:${input.eventId}`;
    if(db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(mentionId))return;
    if(!message&&input.turnId&&db.query("SELECT 1 FROM session_owner_events WHERE session_id=? AND turn_id=? AND kind='mention'").get(input.sessionId,input.turnId))return;
    const session=getSessionById(input.sessionId)!;
    const generation=(sessionMetadata(session).generation??0)+1;
    updateSessionMetadata(session.id,{generation,attentionGeneration:generation});
    db.query('INSERT INTO session_owner_events(event_id,session_id,input_id,turn_id,kind,payload_json) VALUES(?,?,?,?,?,?)')
      .run(mentionId,input.sessionId,input.inputId??null,input.turnId??null,'mention',JSON.stringify({generation,messageId:message?.id??null}));
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
    if (input.kind!=='fork' && (typeof text!=='string' || !text.trim())) throw new Error('An executable input needs text.');
    const inserted=db.query(`INSERT INTO turns(session_id,slack_user_msg_ts,user_text,status,turn_kind,accepted_input_id,
      requested_by_user_id,provider_model,replay_text)
      VALUES(?,NULL,?,'queued','native',?,?,?,?)`).run(input.session_id,text,input.id,input.origin,sessionMetadata(session).model??null,text);
    const turnId=Number(inserted.lastInsertRowid);
    nativeRunId(turnId);
    db.query('UPDATE session_inputs SET turn_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND turn_id IS NULL').run(turnId,input.id);
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
    recordSessionEvent({eventId:`input:${input.id}`,sessionId:input.session_id,inputId:input.id,turnId,kind:'accepted',payload:{origin:input.origin,text}});
    return getAcceptedSessionInput(input.id)!;
  })();
}
export function recoverUnsentSessionReturn(inputId:string) {
  return db.transaction(()=>{
    const input=getAcceptedSessionInput(inputId);
    if(!input||input.origin!=='service'||!input.request_id||input.steering_id===null)return input;
    const steering=db.query('SELECT status,provider_sent_at FROM turn_steering_messages WHERE id=? AND accepted_input_id=?').get(input.steering_id,input.id) as any;
    if(steering?.status!=='failed'||steering.provider_sent_at)return input;
    db.query('UPDATE session_inputs SET turn_id=NULL,steering_id=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND steering_id=?').run(input.id,input.steering_id);
    // A proven-unsent return becomes ordinary queued work, preserving its event identity.
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
