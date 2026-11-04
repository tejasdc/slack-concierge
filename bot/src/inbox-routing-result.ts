import type {Database} from 'bun:sqlite';

/** A router turn that explicitly finished after a handoff has its answer on the routed
 * message's route/request receipt. A turn may accept several inputs: its result belongs to
 * the opening input, while a later input supplied the routed message. Closing prose stays
 * in the agent transcript. Marker-only legacy closes remain visible because they may
 * contain an unclassified answer. */
export const routedTurnResultSql=`event.kind='result' AND input.request_id IS NULL
  AND EXISTS (SELECT 1 FROM session_owner_events declaration
    WHERE declaration.session_id=event.session_id AND declaration.turn_id=event.turn_id
      AND declaration.kind='turn_outcome' AND declaration.event_id GLOB 'turn_outcome:action:*'
      AND json_extract(declaration.payload_json,'$.outcome')='done')
  AND (
  EXISTS (SELECT 1 FROM session_communication_requests handoff
    WHERE handoff.source_session_id=event.session_id AND handoff.source_turn_id=event.turn_id)
  OR EXISTS (SELECT 1 FROM session_peer_requests handoff
    WHERE handoff.source_session_id=event.session_id AND handoff.source_turn_id=event.turn_id)
  OR EXISTS (SELECT 1 FROM session_owner_events route
    WHERE route.session_id=event.session_id AND route.turn_id=event.turn_id
      AND route.kind IN ('topic_route','session_route')))`;

export function turnRoutedInput(database:Database,sessionId:number,turnId:number,inputId:string):boolean {
  const input=database.query('SELECT request_id FROM session_inputs WHERE id=? AND session_id=?')
    .get(inputId,sessionId) as {request_id:string|null}|null;
  if(!input||input.request_id!==null)return false;
  return !!(database.query(`SELECT 1 FROM session_communication_requests
      WHERE source_session_id=? AND source_turn_id=? AND source_input_id=? LIMIT 1`).get(sessionId,turnId,inputId)
    ??database.query(`SELECT 1 FROM session_peer_requests
      WHERE source_session_id=? AND source_turn_id=? AND source_input_id=? LIMIT 1`).get(sessionId,turnId,inputId)
    ??database.query(`SELECT 1 FROM session_owner_events
      WHERE session_id=? AND turn_id=? AND kind IN ('topic_route','session_route')
        AND json_extract(payload_json,'$.sourceMessageId')=? LIMIT 1`).get(sessionId,turnId,inputId));
}
