import {createHash} from 'node:crypto';
import type {Database} from 'bun:sqlite';
import {reconcileCodexMutationIntent} from './codex-mutation-fence';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse=(value:string)=>{try{return JSON.parse(value);}catch{return null;}};
const nativeMethods=['turn/start','turn/steer','turn/interrupt'];
function witness(db:Database,eventId:string){
  const event=db.query('SELECT * FROM session_owner_events WHERE event_id=?').get(eventId) as any;
  if(!event||event.kind!=='codex_native_terminal')return {reason:'NATIVE_TERMINAL_EVENT_MISSING'};
  const p=parse(event.payload_json);
  if(!p||p.observedTerminal!==true||!['completed','failed','interrupted'].includes(p.status)
    ||typeof p.providerThreadId!=='string'||!p.providerThreadId||typeof p.providerTurnId!=='string'||!p.providerTurnId
    ||!Number.isInteger(p.dispatchAttempt)||p.dispatchAttempt<1
    ||eventId!==`codex-native-terminal:${event.turn_id}:${p.dispatchAttempt}`)
    return {reason:'NATIVE_TERMINAL_EVENT_INVALID'};
  const turn=db.query('SELECT * FROM turns WHERE id=?').get(event.turn_id) as any;
  const accepted=db.query('SELECT * FROM session_inputs WHERE id=?').get(p.inputId) as any;
  const session=db.query('SELECT * FROM sessions WHERE id=?').get(event.session_id) as any;
  const admission=accepted&&parse(accepted.receipt_json)?.admission;
  if(!turn||!accepted||!session||event.input_id!==accepted.id||accepted.turn_id!==turn.id
    ||turn.session_id!==session.id||accepted.session_id!==session.id||turn.accepted_input_id!==accepted.id
    ||turn.native_run_id!==p.runId||turn.dispatch_attempt!==p.dispatchAttempt||turn.provider_turn_id!==p.providerTurnId)
    return {reason:'NATIVE_TERMINAL_OWNER_IDENTITY_UNPROVEN'};
  if(session.provider_id!=='codex'||session.agent_session_uuid!==p.providerThreadId
    ||!admission||admission.provider!=='codex'||admission.inputId!==accepted.id||admission.runId!==p.runId
    ||admission.bindingGeneration!==session.binding_generation
    ||(admission.nativeBinding!==null&&admission.nativeBinding?.sessionId!==p.providerThreadId))
    return {reason:'NATIVE_TERMINAL_BINDING_UNPROVEN'};
  return {event,p,evidenceDigest:hash({eventId,eventSessionId:event.session_id,inputId:event.input_id,
    turnId:event.turn_id,kind:event.kind,payloadJson:event.payload_json})};
}

function settle(db:Database,w:ReturnType<typeof witness>,intent:any,nowMs:number){
  if(!('event' in w)||!w.event||!w.p)return {reconciled:false,reason:w.reason};
  const permit=db.query('SELECT purpose FROM codex_mutation_permits WHERE permit_id=?').get(intent.permit_id) as any;
  if(permit?.purpose!=='ordinary'||intent.fence_id||!nativeMethods.includes(intent.method))
    return {reconciled:false,reason:'ORDINARY_NATIVE_INTENT_REQUIRED'};
  const nativeId=intent.provider_turn_id??intent.target_native_turn_id;
  if(intent.thread_id!==w.p.providerThreadId||nativeId!==w.p.providerTurnId
    ||(intent.provider_turn_id&&intent.target_native_turn_id&&intent.provider_turn_id!==intent.target_native_turn_id))
    return {reconciled:false,reason:'NATIVE_TERMINAL_INTENT_IDENTITY_UNPROVEN'};
  const auditId=`codex-managed-native-intent-terminal:${intent.intent_id}`;
  const payload=JSON.stringify({intentId:intent.intent_id,terminalEventId:w.event.event_id,
    terminalEvidenceDigest:w.evidenceDigest,providerThreadId:w.p.providerThreadId,providerTurnId:w.p.providerTurnId,
    inputId:w.p.inputId,runId:w.p.runId,dispatchAttempt:w.p.dispatchAttempt,status:w.p.status,
    nativeTerminalConfirmed:true,inputAcknowledgement:'not_assessed',usefulWork:'not_assessed'});
  const prior=db.query('SELECT * FROM session_owner_events WHERE event_id=?').get(auditId) as any;
  if(prior&&(prior.payload_json!==payload||prior.session_id!==w.event.session_id||prior.input_id!==w.event.input_id
    ||prior.turn_id!==w.event.turn_id||prior.kind!=='codex_managed_native_intent_terminal'))throw new Error('ordinary native terminal audit conflict');
  const result=reconcileCodexMutationIntent(db,{intentId:intent.intent_id,outcome:'applied',
    evidenceDigest:w.evidenceDigest!,nowMs});
  if(!prior)db.query(`INSERT INTO session_owner_events(event_id,session_id,input_id,turn_id,kind,payload_json)
    VALUES(?,?,?,?,'codex_managed_native_intent_terminal',?)`).run(auditId,w.event.session_id,w.event.input_id,w.event.turn_id,payload);
  return {...result,nativeTerminalConfirmed:true,terminalEventId:w.event.event_id,auditEventId:auditId,
    inputAcknowledgement:'not_assessed',usefulWork:'not_assessed'};
}

/** Only the immutable actual-provider callback event is accepted as terminal evidence.
 * Terminal settlement clears possible future native effects; it makes no claim that
 * the input or a steering message was consumed or its work completed. */
export function reconcileManagedCodexNativeTerminal(db:Database,input:{eventId:string;nowMs:number}){
  return db.transaction(()=>{
    const w=witness(db,input.eventId);
    if(!('event' in w)||!w.event||!w.p)return {reconciled:false,reason:w.reason,results:[]};
    const intents=db.query(`SELECT i.* FROM codex_mutation_intents i JOIN codex_mutation_permits p ON p.permit_id=i.permit_id
      WHERE p.purpose='ordinary' AND i.fence_id IS NULL AND i.thread_id=?
      AND (i.provider_turn_id=? OR i.target_native_turn_id=?) ORDER BY i.thread_revision`)
      .all(w.p.providerThreadId,w.p.providerTurnId,w.p.providerTurnId) as any[];
    const results=intents.map(intent=>settle(db,w,intent,input.nowMs));
    return {reconciled:results.some(result=>result.reconciled),nativeTerminalConfirmed:true,eventId:input.eventId,results};
  }).immediate();
}

/** After a late start response supplies its native identity, use the same retained
 * witness. No receipt, elapsed time, RPC error or caller assertion substitutes for it. */
export function reconcileManagedCodexMutationFromRetainedTerminal(db:Database,input:{intentId:string;nowMs:number}){
  return db.transaction(()=>{
    const intent=db.query('SELECT * FROM codex_mutation_intents WHERE intent_id=?').get(input.intentId) as any;
    if(!intent)return {reconciled:false,reason:'MUTATION_INTENT_MISSING'};
    const nativeId=intent.provider_turn_id??intent.target_native_turn_id;
    if(!nativeId)return {reconciled:false,reason:'NATIVE_TURN_IDENTITY_MISSING'};
    const events=db.query(`SELECT event_id FROM session_owner_events WHERE kind='codex_native_terminal'
      AND json_extract(payload_json,'$.providerThreadId')=? AND json_extract(payload_json,'$.providerTurnId')=? ORDER BY sequence`)
      .all(intent.thread_id,nativeId) as {event_id:string}[];
    if(events.length!==1)return {reconciled:false,reason:events.length?'NATIVE_TERMINAL_WITNESS_CONFLICT':'NATIVE_TERMINAL_EVENT_MISSING'};
    return settle(db,witness(db,events[0]!.event_id),intent,input.nowMs);
  }).immediate();
}
