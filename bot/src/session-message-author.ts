import {db,getSessionById,getChannel} from './state';
import {sessionMetadata,getAcceptedSessionInput,type AcceptedSessionInput} from './session-inputs';
import type {MessageAuthor} from './provider-history';

export function authorSession(id:number):MessageAuthor['session'] {
  const session=getSessionById(id);if(!session)return undefined;
  const meta=sessionMetadata(session);
  const retained=!meta.title&&session.slack_channel_id&&session.slack_thread_ts?db.query(`SELECT desired_title AS title FROM slack_agent_session_title_projections WHERE slack_channel_id=? AND slack_thread_ts=?
    UNION ALL SELECT initial_title AS title FROM slack_agent_session_status_projections WHERE slack_channel_id=? AND slack_thread_ts=? AND initial_title IS NOT NULL LIMIT 1`)
    .get(session.slack_channel_id,session.slack_thread_ts,session.slack_channel_id,session.slack_thread_ts) as any:null;
  return {id:`concierge:${id}`,title:meta.title??retained?.title??(session.slack_channel_id?getChannel(session.slack_channel_id)?.name:null)??'Agent session',provider:session.provider_id};
}

function sourceIdentity(inputId:string|null,runId:string|null):Partial<MessageAuthor> {
  if(!inputId||!runId)return {};
  const source=getAcceptedSessionInput(inputId);
  const turn=source?.turn_id?db.query('SELECT native_run_id FROM turns WHERE id=? AND session_id=?').get(source.turn_id,source.session_id) as any:null;
  if(turn?.native_run_id!==runId)return {};
  return {session:authorSession(source!.session_id),inputId,runId};
}

export function communicationEventAuthor(event:any):{author:MessageAuthor;text?:string} {
  const payload=JSON.parse(event.payload_json),base={requestId:event.request_id};
  if(payload.source&&typeof payload.final==='boolean') {
    let identity:Partial<MessageAuthor>={};
    if(payload.source.input_id)identity=sourceIdentity(payload.source.input_id,payload.source.run_id);
    else if(payload.source.channel_id&&payload.source.message_ts) {
      const claims=db.query(`SELECT turn.session_id,turn.native_run_id FROM slack_user_input_claims claim JOIN turns turn ON turn.id=claim.turn_id
        WHERE claim.slack_channel_id=? AND claim.slack_user_msg_ts=?`).all(payload.source.channel_id,payload.source.message_ts) as any[];
      if(claims.length===1)identity={session:authorSession(claims[0].session_id),...(claims[0].native_run_id?{runId:claims[0].native_run_id}:{})};
    }
    if(identity.session?.id!==payload.responding_session_id)return {author:{kind:'unknown',...base}};
    return {author:{kind:'agent',...identity,...base,communication:'reply',replyKind:payload.final?'final':'partial'},text:payload.text};
  }
  if(payload.outcome==='answered'&&Number.isSafeInteger(payload.output?.turn_id)) {
    const turn=db.query(`SELECT turn.session_id,turn.native_run_id FROM turns turn JOIN session_communication_requests request
      ON request.request_id=? AND request.target_session_id=turn.session_id AND request.target_turn_id=turn.id WHERE turn.id=?`)
      .get(event.request_id,payload.output.turn_id) as any;
    if(turn)return {author:{kind:'agent',session:authorSession(turn.session_id),...(turn.native_run_id?{runId:turn.native_run_id}:{}),...base,communication:'result'},text:payload.text};
  }
  return {author:{kind:'service',...base,communication:event.kind==='overdue'?'overdue':'result'},text:payload.text};
}

/** Retained return identity takes precedence over its delivery envelope's service origin. */
export function acceptedInputAuthor(input:AcceptedSessionInput):{author:MessageAuthor;text?:string} {
  const events=db.query('SELECT * FROM session_communication_events WHERE accepted_input_id=? AND request_id=?').all(input.id,input.request_id) as any[];
  if(events.length===1)return communicationEventAuthor(events[0]);
  if(events.length>1)return {author:{kind:'unknown'}};
  const author:MessageAuthor={kind:input.origin,...(input.request_id?{requestId:input.request_id}:{})};
  if(input.origin==='agent')Object.assign(author,sourceIdentity(input.source_input_id,input.source_run_id));
  const request=db.query('SELECT * FROM session_communication_requests WHERE target_input_id=? AND target_session_id=? AND request_id=?').get(input.id,input.session_id,input.request_id) as any;
  if(request){author.communication='request';return {author,text:JSON.parse(request.payload_json).text};}
  return {author};
}

/** Historical transport data is evidence only. An agent-posted Slack message is never a human. */
export function historicalInputAuthor(channel:string,ts:string):{author:MessageAuthor;text?:string} {
  const routed=db.query('SELECT * FROM routed_requests WHERE channel_id=? AND message_ts=?').all(channel,ts) as any[];
  if(routed.length>1)return {author:{kind:'unknown'}};
  if(routed.length===1) {
    const events=db.query('SELECT * FROM session_communication_events WHERE routed_request_id=?').all(routed[0].request_id) as any[];
    if(events.length===1)return communicationEventAuthor(events[0]);
    const requests=db.query('SELECT * FROM session_communication_requests WHERE routed_request_id=?').all(routed[0].request_id) as any[];
    if(requests.length===1){const request=requests[0];return {author:{kind:'agent',session:authorSession(request.source_session_id),requestId:request.request_id,communication:'request'},text:JSON.parse(request.payload_json).text};}
    const claims=db.query(`SELECT turn.session_id FROM slack_user_input_claims claim JOIN turns turn ON turn.id=claim.turn_id
      WHERE claim.slack_channel_id=? AND claim.slack_user_msg_ts=?`).all(routed[0].source_channel,routed[0].source_message_ts) as any[];
    return {author:{kind:'agent',...(claims.length===1?{session:authorSession(claims[0].session_id)}:{})}};
  }
  // A claim alone did not distinguish a real human from legacy user-token agent posting.
  return {author:{kind:'unknown'}};
}
