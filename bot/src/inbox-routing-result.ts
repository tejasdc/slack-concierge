import type {Database} from 'bun:sqlite';

/** A router turn that handed its human input onward has its answer on the source message's
 * route/request receipt. Closing prose is retained in the agent transcript, not a second
 * conversation reply. An intentional answer to Tejas is a post in the thread. */
export const routedHumanResultSql=`event.kind='result' AND input.request_id IS NULL
  AND EXISTS (SELECT 1 FROM session_owner_events declaration
    WHERE declaration.session_id=event.session_id AND declaration.turn_id=event.turn_id
      AND declaration.kind='turn_outcome' AND json_extract(declaration.payload_json,'$.outcome')='done')
  AND (
  EXISTS (SELECT 1 FROM session_communication_requests handoff
    WHERE handoff.source_session_id=event.session_id AND handoff.source_turn_id=event.turn_id
      AND handoff.source_input_id=event.input_id)
  OR EXISTS (SELECT 1 FROM session_peer_requests handoff
    WHERE handoff.source_session_id=event.session_id AND handoff.source_turn_id=event.turn_id
      AND handoff.source_input_id=event.input_id)
  OR EXISTS (SELECT 1 FROM session_owner_events route
    WHERE route.session_id=event.session_id AND route.turn_id=event.turn_id
      AND route.kind IN ('topic_route','session_route')
      AND json_extract(route.payload_json,'$.sourceMessageId')=event.input_id))`;

export function turnRoutedHumanInput(database:Database,sessionId:number,turnId:number,inputId:string):boolean {
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
