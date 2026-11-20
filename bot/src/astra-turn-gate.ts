import {db,getSessionById} from './state';
import {getAcceptedSessionInput,humanAuthored,recordSessionEvent,sessionMetadata} from './session-inputs';
import {humanChoseThinkingModel} from './model-escalation-custody';
import {escalationReason} from './model-escalation';
import {CURRENT_ASTRA_MODEL,CURRENT_SOL_MODEL,isAstraModel} from './aliases';

export const ASTRA_MODEL=CURRENT_ASTRA_MODEL;
export const ASTRA_FALLBACK_MODEL=CURRENT_SOL_MODEL;

export type AstraTurnDecision=
  |{allowed:true;basis:'custody'|'human'|'service-continuation'|'escalation-reason'}
  |{allowed:false;message:string};

/**
 * The one decision on whether a turn may run on GPT-6 Astra: explicit human choice, a service
 * continuation of one, a custody-successor placement, or a recorded escalation reason
 * [decision: chatgpt-pro-is-the-big-guns]. The managed prompt hook asks it when Codex is about to
 * start a prompt, and the dispatcher asks it first so Concierge never sends a turn it would refuse.
 */
export function astraAllowedForTurn(input:{sessionId:number;turnId:number;acceptedInputId:string;
    providerSessionId:string;providerAgentId?:string;model?:string}):AstraTurnDecision {
  // A session bound to a retired Astra keeps that exact model; the gate rules are the same for every Astra.
  const model=input.model??ASTRA_MODEL;
  const session=getSessionById(input.sessionId)!;
  const metadata=sessionMetadata(session);
  const accepted=getAcceptedSessionInput(input.acceptedInputId);
  const custody=!input.providerAgentId&&db.query(`SELECT recovery.canonical_input_id,recovery.handoff_id
    FROM codex_custody_successors recovery JOIN session_handoffs handoff ON handoff.id=recovery.handoff_id
    JOIN session_inputs placement ON placement.id=recovery.placement_input_id
    JOIN turns current ON current.session_id=recovery.successor_session_id AND current.accepted_input_id=?
    WHERE recovery.successor_session_id=? AND current.id=?
      AND recovery.native_thread_id=? AND recovery.attempt_spent_at IS NOT NULL
      AND handoff.state='accepted' AND handoff.successor_session_id=recovery.successor_session_id
      AND placement.source_input_id=recovery.canonical_input_id AND placement.turn_id=recovery.placement_turn_id`)
    .get(accepted?.id??'',input.sessionId,input.turnId,input.providerSessionId) as {canonical_input_id:string;handoff_id:string}|null;
  // Key event ids by (turn, dispatch_attempt) so a requeued turn can record its next
  // attempt's gate verdict cleanly. See 2026-11-19 event-identity incident.
  const dispatchAttempt=(db.query('SELECT dispatch_attempt FROM turns WHERE id=?').get(input.turnId) as {dispatch_attempt:number}|null)?.dispatch_attempt??0;
  if(custody&&metadata.reasoningEffort==='medium'){
    recordSessionEvent({eventId:`model-preservation:${input.turnId}:${dispatchAttempt}`,sessionId:input.sessionId,inputId:accepted!.id,turnId:input.turnId,
      kind:'model_preservation',payload:{model,effort:'medium',basis:'codex_successor_custody_v1',
        canonicalInputId:custody.canonical_input_id,handoffId:custody.handoff_id}});
    return {allowed:true,basis:'custody'};
  }
  const serviceContinuation=accepted?.origin==='service'&&!!accepted.source_input_id&&!!accepted.source_run_id
    &&(()=>{
      const source=getAcceptedSessionInput(accepted.source_input_id!);
      const sourceTurn=source?.turn_id?db.query('SELECT session_id,native_run_id FROM turns WHERE id=?').get(source.turn_id) as {session_id:number;native_run_id:string|null}|null:null;
      const workRequest=accepted.request_id?db.query(`SELECT 1 FROM session_communication_requests
        WHERE request_id=? AND target_session_id=? AND outcome IS NULL
          AND json_extract(payload_json,'$.requestedEffect')='work' LIMIT 1`)
        .get(accepted.request_id,input.sessionId):null;
      return !!source&&source.session_id===input.sessionId&&sourceTurn?.session_id===input.sessionId
        &&sourceTurn.native_run_id===accepted.source_run_id&&!!workRequest
        &&(metadata.explicitThinkingModelChoice===model||humanChoseThinkingModel(accepted.id,model));
    })();
  if(accepted&&(humanAuthored(accepted)||serviceContinuation)){
    recordSessionEvent({eventId:`model-continuation:${input.turnId}:${dispatchAttempt}`,sessionId:input.sessionId,inputId:accepted.id,turnId:input.turnId,
      kind:'model_escalation',payload:{model,reason:'explicit human model choice',sourceInputId:accepted.id,continuation:true,
        ...(serviceContinuation?{serviceContinuation:true}:{})}});
    return {allowed:true,basis:serviceContinuation?'service-continuation':'human'};
  }
  const creation=db.query(`SELECT payload_json FROM session_owner_events WHERE session_id=? AND input_id=?
    AND kind='model_escalation' AND json_extract(payload_json,'$.model')=? ORDER BY sequence DESC LIMIT 1`)
    .get(input.sessionId,input.acceptedInputId,model) as {payload_json:string}|null;
  const request=db.query('SELECT payload_json FROM session_communication_requests WHERE target_input_id=? LIMIT 1')
    .get(input.acceptedInputId) as {payload_json:string}|null;
  const reason=(creation?JSON.parse(creation.payload_json).reason:undefined)
    ??(request?JSON.parse(request.payload_json).escalationReason:undefined)
    ??(accepted?JSON.parse(accepted.payload_json).escalationReason:undefined);
  const refusal=escalationReason(model,typeof reason==='string'?reason:undefined,reason==='explicit human model choice'&&!!creation);
  if(refusal)return {allowed:false,message:refusal.replaceAll('cx-sol',ASTRA_FALLBACK_MODEL)};
  if(!creation&&accepted)recordSessionEvent({eventId:`model-continuation:${input.turnId}:${dispatchAttempt}`,sessionId:input.sessionId,
    inputId:accepted.id,turnId:input.turnId,kind:'model_escalation',payload:{model,reason,sourceInputId:accepted.id,continuation:true}});
  return {allowed:true,basis:'escalation-reason'};
}

/**
 * The model a dispatched turn runs on. A turn bound to Astra that the rule refuses runs on Sol for
 * this turn only, on the same thread; the session's stored model is untouched, so a later turn he
 * explicitly gives Astra still gets it. Concierge asks first because the prompt hook's refusal makes
 * Codex end the turn without recording the input.
 */
export function dispatchModelForTurn(input:{sessionId:number;turnId:number;inputId:string;model:string|undefined;providerSessionId:string;dispatchAttempt:number}):string|undefined {
  if(!isAstraModel(input.model))return input.model;
  // A custody successor's own plan fixes its model and effort; the hook still guards it.
  if(db.query('SELECT 1 FROM codex_custody_successors WHERE successor_session_id=? LIMIT 1').get(input.sessionId))return input.model;
  const decision=astraAllowedForTurn({sessionId:input.sessionId,turnId:input.turnId,acceptedInputId:input.inputId,providerSessionId:input.providerSessionId,model:input.model});
  if(decision.allowed)return input.model;
  recordSessionEvent({eventId:`model-substitution:${input.turnId}:${input.dispatchAttempt}`,sessionId:input.sessionId,inputId:input.inputId,
    turnId:input.turnId,kind:'model_substitution',
    payload:{turnId:input.turnId,inputId:input.inputId,from:input.model,to:ASTRA_FALLBACK_MODEL,reason:decision.message}});
  return ASTRA_FALLBACK_MODEL;
}
