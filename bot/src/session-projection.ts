import {createHash} from 'node:crypto';
import {db,getSessionById,observeTurnFacts} from './state';
import {nativeRunId,recordSessionEvent,recordSessionInputAttention,retainSlackInput,sessionMetadata,updateSessionMetadata} from './session-inputs';
import type {SessionOwner} from './session-owner';
import type {ProviderHistoryMessage} from './provider-history';

export function projectSessionProviderMessage(turnId:number,message:ProviderHistoryMessage) {
  const turn=db.query('SELECT session_id,accepted_input_id,status,provider_turn_id FROM turns WHERE id=?').get(turnId) as any;
  if(!turn||turn.status!=='running')return;
  if(!message.id||message.turnId&&turn.provider_turn_id&&message.turnId!==turn.provider_turn_id)throw new Error('Provider message does not match the active native execution.');
  const payload={message},digest=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  recordSessionEvent({eventId:`message:${turnId}:${digest}`,sessionId:turn.session_id,inputId:turn.accepted_input_id,turnId,kind:'message',payload});
}

/** Projects existing turn facts; it neither admits input nor executes work. */
export function installSessionProjection(owner:SessionOwner) {
  for(const input of db.query(`SELECT input.id FROM session_inputs input LEFT JOIN turns turn ON turn.id=input.turn_id
    WHERE input.steering_id IS NULL AND input.kind IN ('create','input','consultation','fork')
      AND ((turn.turn_kind='native' AND turn.status IN ('error','parked','interrupted','delivery_parked'))
        OR (input.turn_id IS NULL AND json_extract(input.receipt_json,'$.state') IN ('failed','uncertain')))
      AND NOT EXISTS(SELECT 1 FROM session_owner_events event WHERE event.event_id='attention:' || input.id || ':' || COALESCE(turn.dispatch_attempt,0))`).all() as {id:string}[])recordSessionInputAttention(input.id);
  return observeTurnFacts((turnId,kind)=>{
    const turn=db.query('SELECT * FROM turns WHERE id=?').get(turnId) as any;
    if(!turn)return;
    if(turn.turn_kind==='native') {
      if(kind==='terminal'&&turn.accepted_input_id&&['error','parked','interrupted','delivery_parked'].includes(turn.status))recordSessionInputAttention(turn.accepted_input_id);
      return;
    }
    const session=getSessionById(turn.session_id)!;
    if(!session.slack_channel_id)return;
    for(const claim of db.query("SELECT slack_user_msg_ts FROM slack_user_input_claims WHERE turn_id=? AND kind IN ('turn','steering') ORDER BY slack_user_msg_ts").all(turnId) as {slack_user_msg_ts:string}[]) {
      const input=retainSlackInput(session.slack_channel_id,claim.slack_user_msg_ts);
      const existing=db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(`accepted:${input.id}`);
      if(!existing)recordSessionEvent({eventId:`accepted:${input.id}`,sessionId:session.id,inputId:input.id,turnId,kind:'accepted',payload:{origin:input.origin,text:JSON.parse(input.payload_json).text}});
    }
    const inputId=(db.query('SELECT accepted_input_id FROM turns WHERE id=?').get(turnId) as any).accepted_input_id;
    const run=owner.run(nativeRunId(turnId)),payload={run};
    const digest=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    recordSessionEvent({eventId:`run:${turnId}:${digest}`,sessionId:session.id,inputId,turnId,kind:'run',payload});
    if(kind==='terminal') {
      const eventId=`legacy-result:${turnId}`;
      if(!db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(eventId)) {
        recordSessionEvent({eventId,sessionId:session.id,inputId,turnId,kind:'result',payload:{runId:run.id,text:turn.agent_text,state:run.state}});
        updateSessionMetadata(session.id,{generation:(sessionMetadata(getSessionById(session.id)!).generation??0)+1});
      }
    }
  });
}
