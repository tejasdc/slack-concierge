import {db} from './state';
import {createHash} from 'node:crypto';
import type {AcceptedSessionInput} from './session-inputs';
import type {ProviderHistoryMessage,ProviderHistoryPage} from './provider-history';
import {sessionMessageMetadataProjection,type SessionMessageMetadataProjection} from './session-message-metadata';
import {acceptedInputAuthor,authorSession,historicalInputAuthor} from './session-message-author';

export function projectAcceptedInput(message:ProviderHistoryMessage,input:AcceptedSessionInput) {
  const body=JSON.parse(input.payload_json),payload=input.kind==='create'?body.firstInput:body;
  if(typeof payload?.text!=='string')return {...message,author:{kind:'unknown' as const}};
  const {author,text}=acceptedInputAuthor(input);
  const attachments=(payload.attachments??[]).flatMap((id:string)=>{
    const attachment=db.query('SELECT id,name,content_type AS contentType FROM session_attachments WHERE id=?').get(id);
    return attachment?[attachment]:[];
  }) as NonNullable<ProviderHistoryMessage['attachments']>;
  return {...message,author,content:typeof text==='string'?text:payload.text,submissionId:input.id,
    ...(attachments.length?{attachments}:{})};
}

export function projectSessionHistoryMessage(sessionId:number,message:ProviderHistoryMessage,metadata:SessionMessageMetadataProjection=sessionMessageMetadataProjection([{sessionId,message}])) {
  message=metadata(sessionId,message);
  if(message.role!=='user')return {message:{...message,author:{kind:'agent' as const,session:authorSession(sessionId)}}};
  message={...message,author:{kind:'unknown'}};
  const chatInputs=db.query(`SELECT DISTINCT input.* FROM session_owner_events event
    JOIN sessions session ON session.id=event.session_id AND session.provider_id='chatgpt'
    JOIN turns turn ON turn.id=event.turn_id AND turn.session_id=event.session_id
    JOIN session_inputs input ON input.id=event.input_id AND input.turn_id=turn.id AND input.session_id=turn.session_id
    WHERE event.session_id=? AND event.kind='message' AND turn.native_run_id=? AND turn.provider_turn_id=?
      AND turn.provider_turn_id=json_extract(event.payload_json,'$.message.id')
      AND json_extract(event.payload_json,'$.message.id')=? AND json_extract(event.payload_json,'$.message.role')='user'
      AND json_extract(event.payload_json,'$.message.content')=?
      AND json_extract(input.receipt_json,'$.admission.promptHash')=?`)
    .all(sessionId,message.submissionId??null,message.turnId??null,message.id,message.content,createHash('sha256').update(message.content).digest('hex')) as AcceptedSessionInput[];
  if(chatInputs.length===1){const projected=projectAcceptedInput(message,chatInputs[0]!);return {inputId:chatInputs[0]!.id,message:{...projected,submissionId:message.submissionId}};}
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
  if(inputs.length===1)return {inputId:inputs[0]!.id,message:projectAcceptedInput(message,inputs[0]!)};
  if(inputs.length>1)return {message};
  // Old history may predate the message observer. Exact retained provider turn and
  // prepared bytes identify it; an observed turn must use the stronger item join above.
  const old=db.query(`WITH candidates AS (
      SELECT turn.id,turn.session_id,turn.provider_turn_id,turn.replay_text,turn.accepted_input_id,turn.slack_user_msg_ts FROM turns turn
      UNION ALL SELECT turn.id,turn.session_id,turn.provider_turn_id,steering.replay_text,steering.accepted_input_id,steering.slack_user_msg_ts
        FROM turns turn JOIN turn_steering_messages steering ON steering.turn_id=turn.id
    ) SELECT candidate.*,session.slack_channel_id FROM candidates candidate JOIN sessions session ON session.id=candidate.session_id
    WHERE candidate.session_id=? AND candidate.provider_turn_id=? AND candidate.replay_text=? AND session.provider_id IN ('codex','claude-code')
      AND (NOT EXISTS(SELECT 1 FROM session_owner_events event WHERE event.session_id=candidate.session_id AND event.turn_id=candidate.id AND event.kind='message')
        OR EXISTS(SELECT 1 FROM session_owner_events event WHERE event.session_id=candidate.session_id AND event.turn_id=candidate.id AND event.kind='message'
          AND json_extract(event.payload_json,'$.message.id')=? AND json_extract(event.payload_json,'$.message.turnId') IS ?
          AND json_extract(event.payload_json,'$.message.role')='user' AND json_extract(event.payload_json,'$.message.content')=?))`)
    .all(sessionId,message.turnId??null,message.content,message.id,message.turnId??null,message.content) as any[];
  if(old.length!==1)return {message};
  const row=old[0],inputId=row.accepted_input_id;
  if(inputId){const input=db.query('SELECT * FROM session_inputs WHERE id=? AND session_id=?').get(inputId,sessionId) as AcceptedSessionInput|null;
    if(input)return {inputId,message:projectAcceptedInput(message,input)};}
  if(!row.slack_channel_id)return {message};
  const projected=historicalInputAuthor(row.slack_channel_id,row.slack_user_msg_ts);
  return {message:{...message,author:projected.author,...(typeof projected.text==='string'?{content:projected.text}:{})}};
}

export function projectSessionHistory(sessionId:number,page:ProviderHistoryPage):ProviderHistoryPage {
  const metadata=sessionMessageMetadataProjection(page.messages.map(message=>({sessionId,message})));
  return {...page,messages:page.messages.map(message=>projectSessionHistoryMessage(sessionId,message,metadata).message)};
}
