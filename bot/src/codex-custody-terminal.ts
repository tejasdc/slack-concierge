import {db} from './state';
import {recordSessionEvent} from './session-inputs';

/** Provider terminal observation is separate from the owner's cancellation/error status. */
export function recordCustodyNativeTerminal(turnId:number,ownerInstanceId:string,dispatchAttempt:number) {
  const row=db.query(`SELECT turn.session_id,turn.accepted_input_id,turn.provider_turn_id,
      session.agent_session_uuid,relation.canonical_input_id
    FROM turns turn JOIN sessions session ON session.id=turn.session_id
    JOIN codex_custody_successors relation ON relation.placement_turn_id=turn.id
    WHERE turn.id=? AND turn.status='running' AND turn.owner_instance_id=? AND turn.dispatch_attempt=?
      AND relation.dispatch_attempt=turn.dispatch_attempt AND relation.native_turn_id=turn.provider_turn_id
      AND relation.native_thread_id=session.agent_session_uuid AND relation.attempt_spent_at IS NOT NULL`)
    .get(turnId,ownerInstanceId,dispatchAttempt) as any;
  if(!row)return;
  recordSessionEvent({eventId:`custody-native-terminal:${turnId}:${dispatchAttempt}`,sessionId:row.session_id,
    inputId:row.accepted_input_id,turnId,kind:'custody_native_terminal',payload:{canonicalInputId:row.canonical_input_id,
      providerThreadId:row.agent_session_uuid,providerTurnId:row.provider_turn_id,dispatchAttempt}});
}

export function custodySelectedTerminalConfirmed(canonicalInputId:string):boolean {
  return !!db.query(`SELECT 1 FROM codex_custody_successors relation JOIN turns turn ON turn.id=relation.placement_turn_id
    JOIN session_owner_events terminal ON terminal.event_id='custody-native-terminal:'||turn.id||':'||turn.dispatch_attempt
      AND terminal.session_id=relation.successor_session_id AND terminal.turn_id=turn.id
      AND terminal.input_id=relation.placement_input_id AND terminal.kind='custody_native_terminal'
    WHERE relation.canonical_input_id=? AND turn.session_id=relation.successor_session_id
      AND turn.accepted_input_id=relation.placement_input_id AND turn.status IN ('done','error','cancelled')
      AND relation.attempt_spent_at IS NOT NULL AND relation.acknowledged_at IS NOT NULL
      AND turn.provider_input_acknowledged_at IS NOT NULL AND relation.dispatch_attempt=turn.dispatch_attempt
      AND relation.native_turn_id=turn.provider_turn_id
      AND json_extract(terminal.payload_json,'$.canonicalInputId')=relation.canonical_input_id
      AND json_extract(terminal.payload_json,'$.providerThreadId')=relation.native_thread_id
      AND json_extract(terminal.payload_json,'$.providerTurnId')=relation.native_turn_id
      AND json_extract(terminal.payload_json,'$.dispatchAttempt')=relation.dispatch_attempt`).get(canonicalInputId);
}
