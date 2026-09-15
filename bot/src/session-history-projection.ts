import {db} from './state';
import {createHash} from 'node:crypto';
import type {AcceptedSessionInput} from './session-inputs';
import type {ProviderHistoryMessage,ProviderHistoryPage} from './provider-history';
import {sessionMessageMetadataProjection,type SessionMessageMetadataProjection} from './session-message-metadata';

export function projectSessionHistoryMessage(sessionId:number,message:ProviderHistoryMessage,metadata:SessionMessageMetadataProjection=sessionMessageMetadataProjection([{sessionId,message}])) {
  message=metadata(sessionId,message);
  if(message.role!=='user')return {message};
  // Native IDs and exact observed bytes establish provenance; JSON inside user text cannot.
  const inputs=db.query(`SELECT DISTINCT input.* FROM session_owner_events event
    JOIN sessions session ON session.id=event.session_id AND session.provider_id IN ('codex','claude-code')
    JOIN turns turn ON turn.id=event.turn_id AND turn.session_id=event.session_id
    JOIN session_inputs input ON input.turn_id=turn.id AND input.session_id=turn.session_id
    LEFT JOIN turn_steering_messages steering ON steering.id=input.steering_id AND steering.turn_id=turn.id
    WHERE event.session_id=? AND event.kind='message'
      AND json_extract(event.payload_json,'$.message.role')='user'
      AND json_extract(event.payload_json,'$.message.id')=?
      AND json_extract(event.payload_json,'$.message.turnId') IS ?
      AND json_extract(event.payload_json,'$.message.content')=?
      AND CASE WHEN input.steering_id IS NULL THEN
        turn.turn_kind='native' AND turn.accepted_input_id=input.id
          AND (turn.replay_text=? OR json_extract(input.receipt_json,'$.admission.promptHash')=?)
      ELSE steering.slack_user_msg_ts IS NULL AND steering.accepted_input_id=input.id AND steering.replay_text=? END`)
    .all(sessionId,message.id,message.turnId??null,message.content,message.content,
      createHash('sha256').update(message.content).digest('hex'),message.content) as AcceptedSessionInput[];
  if(inputs.length!==1)return {message};
  const input=inputs[0]!,body=JSON.parse(input.payload_json),payload=input.kind==='create'?body.firstInput:body;
  if(typeof payload?.text!=='string')return {message};
  const attachments=(payload.attachments??[]).flatMap((id:string)=>{
    const attachment=db.query('SELECT id,name,content_type AS contentType FROM session_attachments WHERE id=?').get(id);
    return attachment?[attachment]:[];
  }) as NonNullable<ProviderHistoryMessage['attachments']>;
  return {inputId:input.id,message:{...message,content:payload.text,submissionId:input.id,
    ...(attachments.length?{attachments}:{})}};
}

export function projectSessionHistory(sessionId:number,page:ProviderHistoryPage):ProviderHistoryPage {
  const metadata=sessionMessageMetadataProjection(page.messages.map(message=>({sessionId,message})));
  return {...page,messages:page.messages.map(message=>projectSessionHistoryMessage(sessionId,message,metadata).message)};
}
