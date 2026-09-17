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

const messageKey=(sessionId:number,message:ProviderHistoryMessage)=>JSON.stringify([sessionId,message.id,message.turnId??null,message.role]);
export type SessionMessageInputProjection=(sessionId:number,message:ProviderHistoryMessage)=>string|undefined;

/**
 * The owner records which accepted input each message event belongs to when it observes
 * the message, so an agent message names its request exactly rather than by its position
 * in the page. Several retained events for one message must agree; a disagreement stays
 * unknown. One batch per history page or event flush, matching the metadata projection.
 */
export function sessionMessageInputProjection(entries:readonly {sessionId:number;message:ProviderHistoryMessage}[]):SessionMessageInputProjection {
  if(!entries.length)return ()=>undefined;
  const requested=JSON.stringify([...new Map(entries.map(({sessionId,message})=>[messageKey(sessionId,message),
    {sessionId,id:message.id,turnId:message.turnId??null,role:message.role}])).values()]);
  const rows=db.query(`SELECT event.session_id,event.input_id,event.payload_json
    FROM session_owner_events event JOIN json_each(?) requested
      ON event.session_id=json_extract(requested.value,'$.sessionId')
      AND json_extract(event.payload_json,'$.message.id')=json_extract(requested.value,'$.id')
      AND json_extract(event.payload_json,'$.message.turnId') IS json_extract(requested.value,'$.turnId')
      AND json_extract(event.payload_json,'$.message.role')=json_extract(requested.value,'$.role')
    WHERE event.kind='message' AND event.input_id IS NOT NULL ORDER BY event.sequence`).all(requested) as any[];
  const observed=new Map<string,Set<string>>();
  for(const row of rows) {
    const key=messageKey(row.session_id,JSON.parse(row.payload_json).message);
    const inputs=observed.get(key)??new Set<string>();
    inputs.add(row.input_id);observed.set(key,inputs);
  }
  return (sessionId,message)=>{
    const inputs=observed.get(messageKey(sessionId,message));
    return inputs?.size===1?[...inputs][0]:undefined;
  };
}

/**
 * Whatever established a message's accepted input also names it on the message, so a
 * thread is one request plus every message carrying that `inputId`, with no ordering
 * heuristic and no different answer after a reload.
 */
export function projectSessionHistoryMessage(sessionId:number,message:ProviderHistoryMessage,metadata:SessionMessageMetadataProjection=sessionMessageMetadataProjection([{sessionId,message}]),identity:SessionMessageInputProjection=sessionMessageInputProjection([{sessionId,message}])) {
  const projected=projectMessageOrigin(sessionId,message,metadata,identity);
  return projected.inputId?{...projected,message:{...projected.message,inputId:projected.inputId}}:projected;
}

function projectMessageOrigin(sessionId:number,message:ProviderHistoryMessage,metadata:SessionMessageMetadataProjection,identity:SessionMessageInputProjection):{inputId?:string;message:ProviderHistoryMessage} {
  const source=identity(sessionId,message);
  message=metadata(sessionId,message);
  if(message.role!=='user')return {inputId:source,message:{...message,author:{kind:'agent' as const,session:authorSession(sessionId)}}};
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
  // Claude can retain a steering input in its transcript without emitting an
  // owner message event for that item. The exact bytes prepared for this same
  // session identify a unique accepted input even when Claude assigns its own
  // row UUID rather than the steering ID. Never infer identity from the JSON
  // header inside those bytes.
  const retainedSteering=db.query(`SELECT DISTINCT input.* FROM turn_steering_messages steering
    JOIN turns turn ON turn.id=steering.turn_id
    JOIN sessions session ON session.id=turn.session_id AND session.provider_id='claude-code'
    JOIN session_inputs input ON input.id=steering.accepted_input_id AND input.steering_id=steering.id
      AND input.turn_id=turn.id AND input.session_id=turn.session_id
    WHERE turn.session_id=? AND steering.slack_user_msg_ts IS NULL AND steering.replay_text=?`)
    .all(sessionId,message.content) as AcceptedSessionInput[];
  if(retainedSteering.length===1)return {inputId:retainedSteering[0]!.id,message:projectAcceptedInput(message,retainedSteering[0]!)};
  if(retainedSteering.length>1)return {message};
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
  const entries=page.messages.map(message=>({sessionId,message}));
  const metadata=sessionMessageMetadataProjection(entries),identity=sessionMessageInputProjection(entries);
  return {...page,messages:page.messages.map(message=>projectSessionHistoryMessage(sessionId,message,metadata,identity).message)};
}
