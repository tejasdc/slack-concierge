import {createHash} from 'node:crypto';
import {db,getSessionById} from './state';
import {getAcceptedSessionInput,providerRunnerForSession,sessionMetadata,stablePayload} from './session-inputs';

const digest=(value:unknown)=>createHash('sha256').update(stablePayload(value)).digest('hex');

/** Diagnostic only: neither this snapshot nor its digest is an admission capability.
 * In particular, a ledger snapshot does not fence native activity across dispatch. */
export function inspectCodexRecovery(input:{sessionId:number;inputId:string;requestId:string}) {
  return db.transaction(()=>{
    const session=getSessionById(input.sessionId),accepted=getAcceptedSessionInput(input.inputId);
    if(!session||session.provider_id!=='codex'||!accepted||accepted.session_id!==session.id
      ||accepted.id!==`report-back:${input.requestId}`||accepted.origin!=='service'||accepted.request_id!==input.requestId)
      throw new Error('Exact Codex recovery inspection needs the retained service report-back and its bound conversation.');
    const request=db.query('SELECT * FROM session_communication_requests WHERE request_id=?').get(input.requestId) as any;
    if(!request||request.target_session_id!==session.id||request.outcome!==null
      ||JSON.parse(request.payload_json).requestedEffect!=='work'||request.target_input_id===accepted.id)
      throw new Error('Exact Codex recovery inspection requires the current open work request.');
    const metadata=sessionMetadata(session);
    const turn=accepted.turn_id===null?null:db.query('SELECT * FROM turns WHERE id=? AND accepted_input_id=? AND session_id=?')
      .get(accepted.turn_id,accepted.id,session.id) as any;
    const source=accepted.source_input_id?getAcceptedSessionInput(accepted.source_input_id):null;
    const sourceTurn=source?.turn_id?db.query('SELECT * FROM turns WHERE id=?').get(source.turn_id) as any:null;
    const creation=db.query("SELECT * FROM session_inputs WHERE session_id=? AND kind='create' ORDER BY rowid LIMIT 1")
      .get(session.id) as any;
    const creationPayload=creation?JSON.parse(creation.payload_json):null;
    const creationAdmission=creation?.receipt_json?JSON.parse(creation.receipt_json).admission:null;
    const creationTurn=creation?.turn_id?db.query('SELECT * FROM turns WHERE id=?').get(creation.turn_id) as any:null;
    const admission=accepted.receipt_json?JSON.parse(accepted.receipt_json).admission:null;
    const effortEvent=turn?db.query("SELECT event_id,payload_json FROM session_owner_events WHERE event_id=? AND session_id=? AND turn_id=? AND kind='prompt_cache_identity'")
      .get(`prompt-cache-identity:${turn.id}:${turn.dispatch_attempt}`,session.id,turn.id) as any:null;
    const attemptEffort=effortEvent?JSON.parse(effortEvent.payload_json).effort:null;
    const reasons:Array<{code:string;evidence:string[];missingAbility?:string}>=[];
    const refuse=(code:string,evidence:string[],missingAbility?:string)=>reasons.push({code,evidence,...(missingAbility?{missingAbility}:{})});
    if(!session.agent_session_uuid||metadata.outside||metadata.suspended||metadata.interactionPolicy==='consultation-only'
      ||session.status==='archived'||turn?.stop_requested_at)
      refuse('SEND_CONTROLS_REFUSE',[accepted.id]);
    if(!turn||!['done','parked'].includes(turn.status)||turn.provider_input_acknowledged_at!==null)
      refuse('SELECTED_ATTEMPT_NOT_UNACKNOWLEDGED_TERMINAL',[accepted.id]);
    if(!source||source.id!==request.target_input_id||source.session_id!==session.id
      ||sourceTurn?.session_id!==session.id||sourceTurn?.native_run_id!==accepted.source_run_id
      ||!sourceTurn?.provider_input_acknowledged_at)
      refuse('ACKNOWLEDGED_SOURCE_CUSTODY_NOT_PROVEN',[accepted.id,request.target_input_id]);
    const creationModelEffortMatches=!!creation&&creationPayload?.provider==='codex'&&creationPayload.model===metadata.model
      &&creationPayload.reasoningEffort===metadata.reasoningEffort&&!!metadata.reasoningEffort
      &&creationAdmission?.provider==='codex'&&creationAdmission.model===metadata.model
      &&creationAdmission.inputId===creation.id&&creationAdmission.runId===creationTurn?.native_run_id
      &&creationAdmission.bindingGeneration===session.binding_generation
      &&creationTurn?.session_id===session.id&&!!creationTurn?.provider_input_acknowledged_at;
    if(!creationModelEffortMatches)refuse('ACCEPTED_CREATION_MODEL_EFFORT_NOT_PROVEN',creation?[creation.id]:[]);
    if(!admission||admission.inputId!==accepted.id||admission.runId!==turn?.native_run_id
      ||admission.provider!=='codex'||admission.model!==metadata.model
      ||admission.bindingGeneration!==session.binding_generation||attemptEffort!==metadata.reasoningEffort
      ||admission.reasoningEffort!==undefined&&admission.reasoningEffort!==attemptEffort)
      refuse('SELECTED_MODEL_EFFORT_NOT_PROVEN',[accepted.id,...(effortEvent?[effortEvent.event_id]:[])]);

    // Capture every retained input, including controls and inputs never assigned a turn.
    // Receipt and payload bytes participate in the digest but never leave this boundary.
    const selectedOrdinal=(db.query('SELECT rowid AS ordinal FROM session_inputs WHERE id=?').get(accepted.id) as any).ordinal;
    const inputs=db.query('SELECT rowid AS ordinal,* FROM session_inputs WHERE session_id=? AND rowid>=? ORDER BY rowid')
      .all(session.id,selectedOrdinal) as any[];
    const turns=db.query('SELECT * FROM turns WHERE session_id=? AND id>=? ORDER BY id')
      .all(session.id,turn?.id??0) as any[];
    const steering=db.query(`SELECT steering.* FROM turn_steering_messages steering JOIN turns turn ON turn.id=steering.turn_id
      WHERE turn.session_id=? AND turn.id>=? ORDER BY steering.id`).all(session.id,turn?.id??0);
    const predecessors=db.query(`SELECT id FROM turns WHERE session_id=? AND id<?
      AND status IN ('queued','running','delivering') ORDER BY id`).all(session.id,turn?.id??0) as {id:number}[];
    if(predecessors.length)refuse('EARLIER_NONTERMINAL_TURN_PRESENT',predecessors.map(row=>`turn:${row.id}`));
    const handoffs=db.query("SELECT id,state,successor_session_id FROM session_handoffs WHERE predecessor_session_id=? AND state IN ('proposed','accepted') ORDER BY id")
      .all(session.id) as any[];
    if(handoffs.length)refuse('HANDOFF_REQUIRES_RECONCILIATION',handoffs.map(row=>row.id));
    const selectedSequence=(db.query('SELECT MIN(sequence) AS sequence FROM session_owner_events WHERE session_id=? AND input_id=?')
      .get(session.id,accepted.id) as any).sequence;
    if(selectedSequence===null)refuse('ACCEPTED_EVENT_WATERMARK_UNAVAILABLE',[accepted.id]);
    const events=selectedSequence===null?[]:db.query(`SELECT sequence,event_id,input_id,turn_id,kind,payload_json FROM session_owner_events
      WHERE session_id=? AND sequence>=? ORDER BY sequence`).all(session.id,selectedSequence) as any[];
    const eventWatermark=events.at(-1)?.sequence??0;
    // No history scan or provider probe is performed by inspection. Missing native proof
    // stays explicit, even when the owner-side witnesses all match.
    refuse('NATIVE_INTERVAL_NOT_PROVEN',[accepted.id],
      'Complete exact attempt-to-native-item coverage, including independently identified compaction.');
    refuse('NATIVE_ACTIVITY_BOUNDARY_NOT_FENCED',[accepted.id],
      'A receiver-side boundary that remains valid through reservation and the actual native start.');
    const reservation=db.query('SELECT * FROM codex_unacknowledged_recoveries WHERE accepted_input_id=?').get(accepted.id) as any;
    return {status:'ineligible' as const,eligible:false as const,diagnosticOnly:true as const,requestId:input.requestId,
      acceptedInputId:accepted.id,runId:turn?.native_run_id??null,turnId:turn?.id??null,
      binding:{sessionId:session.id,threadId:session.agent_session_uuid,generation:session.binding_generation,
        model:metadata.model??null,effort:metadata.reasoningEffort??null,runner:providerRunnerForSession(session)},
      continuation:{basis:'accepted_binding_continuation' as const,authorized:false as const,
        creationInputId:creation?.id??null,sourceInputId:accepted.source_input_id,sourceRunId:accepted.source_run_id,
        creationModelEffortMatches,effortEvidenceId:effortEvent?.event_id??null},
      interval:{acceptedWatermark:inputs.at(-1)?.ordinal??selectedOrdinal,eventWatermark,inputCount:inputs.length,
        acceptedWithoutTurnCount:inputs.filter(row=>row.turn_id===null&&row.steering_id===null).length,
        earlierNonterminalTurnCount:predecessors.length,
        digest:digest({session,inputs,turns,steering,request,handoffs,events})},
      progress:{usefulWork:'not_assessed',...(reservation?{reserved:true,attempt:turn?.dispatch_attempt??null,
        reservedDispatchAttempt:reservation.additional_dispatch_attempt??null,
        inputAcknowledged:!!turn?.provider_input_acknowledged_at,state:turn?.status??null}: {reserved:false})},
      reasons};
  })();
}
