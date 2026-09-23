import {db,getSessionById,getChannel} from './state';
import {authorCorrection,sessionMetadata,getAcceptedSessionInput,sessionInputProvenance,type AcceptedSessionInput} from './session-inputs';
import type {MessageAuthor} from './provider-history';
import {localSessionNumber,peerRequestMessage,receiveSessionFromPeer} from './peer-identity';

export function authorSession(id:number):MessageAuthor['session'] {
  const session=getSessionById(id);if(!session)return undefined;
  const meta=sessionMetadata(session);
  const retained=!meta.title&&session.slack_channel_id&&session.slack_thread_ts?db.query(`SELECT desired_title AS title FROM slack_agent_session_title_projections WHERE slack_channel_id=? AND slack_thread_ts=?
    UNION ALL SELECT initial_title AS title FROM slack_agent_session_status_projections WHERE slack_channel_id=? AND slack_thread_ts=? AND initial_title IS NOT NULL LIMIT 1`)
    .get(session.slack_channel_id,session.slack_thread_ts,session.slack_channel_id,session.slack_thread_ts) as any:null;
  return {id:`concierge:${id}`,title:meta.title??retained?.title??(session.slack_channel_id?getChannel(session.slack_channel_id)?.name:null)??'Agent session',provider:session.provider_id};
}

/**
 * The author session for any identity: a local one from this ledger, another instance's
 * from this instance's last catalogue of that peer. Every hop resolves identities here, so
 * a Mac session and a cloud session read the same way on both machines.
 */
export function sessionAuthor(id:string):MessageAuthor['session'] {
  const local=localSessionNumber(id);
  if(local!==null)return authorSession(local);
  const colon=id.indexOf(':');
  if(colon<=0)return undefined;
  const peer=id.slice(0,colon),remote=id.slice(colon+1);
  const row=db.query('SELECT view_json FROM session_peer_catalogue WHERE peer=? AND remote_session_id IN (?,?) ORDER BY updated_at_ms DESC LIMIT 1')
    .get(peer,remote,`concierge:${remote}`) as {view_json:string}|null;
  const view=row?JSON.parse(row.view_json):null;
  return {id,title:view?.title??`Session on ${peer}`,provider:view?.provider??'claude-code'};
}

function sourceIdentity(inputId:string|null,runId:string|null):Partial<MessageAuthor> {
  if(!inputId||!runId)return {};
  const source=getAcceptedSessionInput(inputId);
  const turn=source?.turn_id?db.query('SELECT native_run_id FROM turns WHERE id=? AND session_id=?').get(source.turn_id,source.session_id) as any:null;
  if(turn?.native_run_id!==runId)return {};
  return {session:authorSession(source!.session_id),inputId,runId};
}

/**
 * Whether a result carries the answering agent's own words: a sibling's reply written for the
 * turn that held this question, or a dedicated turn's output (`answered`, `undetermined`).
 * Everything else the service wrote itself — overdue notes, "ended without a confirmed
 * answer", failures and cancellations — and stays the service's. Tejas saw finals labelled
 * "Service · Result" while the same session's partial replies were named (2026-09-21).
 */
function resultIsAgentText(payload:any) {
  return typeof payload.answered_by_request_id==='string'||payload.outcome==='answered'||payload.outcome==='undetermined';
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
  if(resultIsAgentText(payload)&&Number.isSafeInteger(payload.output?.turn_id)) {
    // Any turn of the target session, not only the one the request opened: an answer can
    // come from a later run after steering or an interruption.
    const turn=db.query(`SELECT turn.session_id,turn.native_run_id FROM turns turn JOIN session_communication_requests request
      ON request.request_id=? AND request.target_session_id=turn.session_id WHERE turn.id=?`)
      .get(event.request_id,payload.output.turn_id) as any;
    if(turn)return {author:{kind:'agent',session:authorSession(turn.session_id),...(turn.native_run_id?{runId:turn.native_run_id}:{}),...base,communication:'result'},text:payload.text};
  }
  return {author:{kind:'service',...base,communication:event.kind==='overdue'?'overdue':'result'},text:payload.text};
}

/**
 * A delegated message carries its whole retained chain, not only its immediate
 * sender: which of Tejas's own requests it ultimately acts for, and whether it may
 * change anything. The owner already resolves both for the request's receipt, and a
 * reader of the message is owed the same facts. An unknown author gains nothing here.
 */
function withProvenance(input:AcceptedSessionInput,projected:{author:MessageAuthor;text?:string}) {
  if(input.origin==='human'||projected.author.kind==='unknown')return projected;
  const provenance=sessionInputProvenance(input);
  if(!provenance)return projected;
  const human=provenance.originatingHuman,humanSession=human?sessionAuthor(human.sessionId):undefined;
  return {...projected,author:{...projected.author,
    ...(provenance.effectScope?{effectScope:provenance.effectScope}:{}),
    ...(human&&humanSession?{originatingHuman:{session:humanSession,inputId:human.inputId,runId:human.runId,
      ...(human.captureId?{captureId:human.captureId}:{})}}:{})}};
}

/** Retained return identity takes precedence over its delivery envelope's service origin. */
export function acceptedInputAuthor(input:AcceptedSessionInput):{author:MessageAuthor;text?:string} {
  return withProvenance(input,acceptedInputAuthorWithoutProvenance(input));
}

/**
 * A return from a peer instance (the Mac) is recorded in the peer ledger, not the local
 * one, but it is the same kind of message and projects the same way: the answering
 * session as author, the request it answers, and the answer text rather than its
 * delivery envelope. The answering session lives on the peer, so its title comes from
 * this instance's last catalogue of that peer.
 */
function peerEventAuthor(event:any):{author:MessageAuthor;text?:string} {
  const payload=JSON.parse(event.payload_json),base={requestId:event.request_id};
  const session=typeof payload.responding_session_id==='string'?sessionAuthor(payload.responding_session_id):undefined;
  if(typeof payload.final==='boolean')
    return {author:{kind:'agent',...(session?{session}:{}),...base,communication:'reply',replyKind:payload.final?'final':'partial'},text:payload.text};
  const agent=!!session&&event.kind!=='overdue'&&resultIsAgentText(payload);
  return {author:{kind:agent?'agent':'service',...(agent?{session}:{}),...(agent&&typeof payload.output?.run_id==='string'?{runId:payload.output.run_id}:{}),...base,
    communication:event.kind==='overdue'?'overdue':'result'},text:payload.text};
}

function acceptedInputAuthorWithoutProvenance(input:AcceptedSessionInput):{author:MessageAuthor;text?:string} {
  const corrected=input.origin==='human'?authorCorrection(input.id):null;
  if(corrected){
    const session=corrected.authorSessionId===null?undefined:authorSession(corrected.authorSessionId);
    return {author:{kind:'agent',...(session?{session}:{}),correction:{reason:corrected.reason,at:corrected.createdAt}}};
  }
  const events=db.query('SELECT * FROM session_communication_events WHERE accepted_input_id=? AND request_id=?').all(input.id,input.request_id) as any[];
  if(events.length===1)return communicationEventAuthor(events[0]);
  if(events.length>1)return {author:{kind:'unknown'}};
  const peerEvents=db.query('SELECT * FROM session_peer_events WHERE accepted_input_id=? AND request_id=?').all(input.id,input.request_id) as any[];
  if(peerEvents.length===1)return peerEventAuthor(peerEvents[0]);
  if(peerEvents.length>1)return {author:{kind:'unknown'}};
  const author:MessageAuthor={kind:input.origin,...(input.request_id?{requestId:input.request_id}:{})};
  if(input.kind==='inbox-capture'){
    const quoted=JSON.parse(input.payload_json).capture?.source?.metadata?.quoted;
    if(quoted&&quoted.kind!=='human')author.quoted=quoted;
  }
  if(input.origin==='agent')Object.assign(author,sourceIdentity(input.source_input_id,input.source_run_id));
  const request=db.query('SELECT * FROM session_communication_requests WHERE target_input_id=? AND target_session_id=? AND request_id=?').get(input.id,input.session_id,input.request_id) as any;
  if(request){author.communication='request';return {author,text:JSON.parse(request.payload_json).text};}
  // A request another instance delivered: the same sender, request and message a local one shows.
  const delivery=db.query('SELECT * FROM session_peer_deliveries WHERE target_input_id=? AND target_session_id=?').get(input.id,input.session_id) as any;
  if(delivery){
    const retained=delivery.origin_provenance_json?JSON.parse(delivery.origin_provenance_json):{};
    const body=JSON.parse(input.payload_json),delivered=(input.kind==='create'?body.firstInput?.text:body.text)??'';
    return {author:{kind:'agent',session:sessionAuthor(receiveSessionFromPeer(delivery.origin_session_id,delivery.peer)),inputId:delivery.origin_input_id,runId:delivery.origin_run_id,
      requestId:delivery.request_id,communication:'request'},text:typeof retained.message==='string'?retained.message:peerRequestMessage(delivered,delivery.request_id)};
  }
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
