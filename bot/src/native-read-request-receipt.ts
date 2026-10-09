import {db} from './state';
import {getAcceptedSessionInput} from './session-inputs';
import {readInputExecution} from './session-owner';

/** Only the fields a session input receipt derives from an addressed conversation. */
export function readRequestReceipt(requestId:string){
  const local=db.query('SELECT outcome,result_json,target_input_id FROM session_communication_requests WHERE request_id=?')
    .get(requestId) as {outcome:string|null;result_json:string|null;target_input_id:string|null}|null;
  if(local){
    const input=local.target_input_id?getAcceptedSessionInput(local.target_input_id):null;
    const observed=input?readInputExecution(input):null;
    const events=db.query('SELECT event_id,kind,status,error FROM session_communication_events WHERE request_id=? ORDER BY rowid')
      .all(requestId) as Array<{event_id:string;kind:string;status:string;error:string|null}>;
    return {outcome:local.outcome,result:local.result_json?JSON.parse(local.result_json):null,
      execution:observed?.turn?{acknowledged_at:observed.steering?.provider_sent_at??
        (input?.steering_id?null:observed.turn.provider_input_acknowledged_at??null)}:null,events};
  }
  const peer=db.query('SELECT outcome,result_json,remote_status_json FROM session_peer_requests WHERE request_id=?')
    .get(requestId) as {outcome:string|null;result_json:string|null;remote_status_json:string|null}|null;
  if(peer){
    const remote=peer.remote_status_json?JSON.parse(peer.remote_status_json):null;
    const events=db.query('SELECT event_id,kind,status,error FROM session_peer_events WHERE request_id=? ORDER BY rowid')
      .all(requestId) as Array<{event_id:string;kind:string;status:string;error:string|null}>;
    return {outcome:peer.outcome,result:peer.result_json?JSON.parse(peer.result_json):null,
      execution:remote?.execution?{acknowledged_at:remote.execution.acknowledgedAt??null}:null,events};
  }
  const delivery=db.query('SELECT target_input_id FROM session_peer_deliveries WHERE request_id=?')
    .get(requestId) as {target_input_id:string}|null;
  if(delivery){
    const input=getAcceptedSessionInput(delivery.target_input_id);
    const observed=input?readInputExecution(input):null;
    const events=db.query('SELECT event_id,kind,status FROM session_peer_replies WHERE request_id=? ORDER BY rowid')
      .all(requestId) as Array<{event_id:string;kind:string;status:string}>;
    return {outcome:null,result:null,execution:observed?.turn?{acknowledged_at:observed.acknowledgedAt??null}:null,
      events:events.map(event=>({...event,error:null}))};
  }
  return null;
}
