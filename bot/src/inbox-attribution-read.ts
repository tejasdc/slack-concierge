import type {Database} from 'bun:sqlite';
import {localSessionNumber,peerRequestMessage,receiveSessionFromPeer} from './peer-identity';
import {SERVICE_NOTICE_SCOPE,noticeTime} from './provider-free-notice';
import {sessionCatalogueLabels} from './session-labels';

type Input={id:string;session_id:number;scope:string;action_id:string;kind:string;origin:'human'|'agent'|'service';
  payload_json:string;turn_id:number|null;source_input_id:string|null;source_run_id:string|null;request_id:string|null;created_at:string};
type Author=Record<string,unknown>&{kind:string};
const inputById=(db:Database,id:string)=>db.query('SELECT * FROM session_inputs WHERE id=?').get(id) as Input|null;
const correction=(db:Database,id:string)=>db.query('SELECT author_session_id,reason,created_at FROM session_input_author_corrections WHERE input_id=?')
  .get(id) as {author_session_id:number|null;reason:string;created_at:string}|null;
const human=(db:Database,input:Input)=>input.origin==='human'&&!correction(db,input.id);
const minutesText=(ms:number)=>{const minutes=Math.round(ms/60_000);return minutes>=120?`${Math.round(minutes/60)} hours`:`${minutes} min`;};
const pebbleWait=(source:{kind?:unknown;recordedAt?:unknown}|undefined,acceptedAt:string)=>{
  if(source?.kind!=='pebble'||typeof source.recordedAt!=='string')return null;
  const recorded=Date.parse(source.recordedAt),arrived=Date.parse(acceptedAt.includes('T')?acceptedAt:acceptedAt.replace(' ','T')+'Z');
  return Number.isFinite(recorded)&&Number.isFinite(arrived)&&arrived-recorded>120_000?arrived-recorded:null;
};
const captureDevices:Record<string,string>={'ios-share-extension':'iPhone share','ios-action-button':'iPhone Action Button',
  'apple-watch':'Watch','mac-capture':'Mac quick capture'};

/** Storage-neutral attribution used by both the owner and the prepared Inbox display worker. */
export function inboxAttribution(db:Database){
  const authorSession=(id:number)=>{
    const row=db.query('SELECT provider_id,native_metadata_json,slack_channel_id,slack_thread_ts FROM sessions WHERE id=?')
      .get(id) as {provider_id:string;native_metadata_json:string|null;slack_channel_id:string|null;slack_thread_ts:string|null}|null;
    if(!row)return undefined;
    return {id:`concierge:${id}`,title:sessionCatalogueLabels(db,row).title,provider:row.provider_id};
  };
  const sessionAuthor=(id:string)=>{
    const local=localSessionNumber(id);
    if(local!==null)return authorSession(local);
    const colon=id.indexOf(':');if(colon<=0)return undefined;
    const peer=id.slice(0,colon),remote=id.slice(colon+1);
    const row=db.query(`SELECT view_json FROM session_peer_catalogue WHERE peer=? AND remote_session_id IN (?,?)
      ORDER BY updated_at_ms DESC LIMIT 1`).get(peer,remote,`concierge:${remote}`) as {view_json:string}|null;
    const view=row?JSON.parse(row.view_json):null;
    return {id,title:view?.title??`Session on ${peer}`,provider:view?.provider??'claude-code'};
  };
  const sourceIdentity=(inputId:string|null,runId:string|null):Record<string,unknown>=>{
    if(!inputId||!runId)return {};
    const source=inputById(db,inputId);
    const turn=source?.turn_id?db.query('SELECT native_run_id FROM turns WHERE id=? AND session_id=?').get(source.turn_id,source.session_id) as {native_run_id:string|null}|null:null;
    return turn?.native_run_id===runId?{session:authorSession(source!.session_id),inputId,runId}:{};
  };
  const peerProvenance=(input:Input)=>{
    const delivery=db.query(`SELECT peer,origin_session_id,origin_input_id,origin_run_id,requested_effect,origin_provenance_json
      FROM session_peer_deliveries WHERE target_input_id=?`).get(input.id) as any;
    if(!delivery)return null;
    const retained=delivery.origin_provenance_json?JSON.parse(delivery.origin_provenance_json):{};
    const effectScope=retained.effectScope==='informational'||delivery.requested_effect!=='work'?'informational':'work';
    const originatingHuman=retained.originatingHuman&&typeof retained.originatingHuman.sessionId==='string'
      ?{...retained.originatingHuman,sessionId:receiveSessionFromPeer(retained.originatingHuman.sessionId,delivery.peer)}:null;
    return {source:{inputId:delivery.origin_input_id,runId:delivery.origin_run_id,
      sessionId:receiveSessionFromPeer(delivery.origin_session_id,delivery.peer),peer:delivery.peer},
      requestId:input.request_id,effectScope,originatingHuman,peer:delivery.peer};
  };
  const provenance=(input:Input)=>{
    if(!input.source_input_id||!input.source_run_id)return peerProvenance(input);
    const seen=new Set<string>();let current:Input|null=input,source:any=null,originatingHuman:any=null;
    let effectScope:'informational'|'work'|null=null;
    while(current?.source_input_id&&current.source_run_id&&!seen.has(current.id)){
      seen.add(current.id);
      const parent=inputById(db,current.source_input_id);
      const turn=parent?.turn_id?db.query('SELECT native_run_id FROM turns WHERE id=? AND session_id=?').get(parent.turn_id,parent.session_id) as {native_run_id:string|null}|null:null;
      if(!parent||turn?.native_run_id!==current.source_run_id)break;
      const identity={inputId:parent.id,runId:current.source_run_id,sessionId:`concierge:${parent.session_id}`};
      source??=identity;
      if(current.origin==='agent'&&['input','create','consultation','request'].includes(current.kind)){
        const request=db.query(`SELECT payload_json FROM session_communication_requests WHERE request_id=?
          AND ((target_input_id=? AND target_session_id=?) OR (?='request' AND source_session_id=?))
          AND source_input_id=? AND source_turn_id=?`).get(current.request_id,current.id,current.session_id,
            current.kind,current.session_id,parent.id,parent.turn_id) as {payload_json:string}|null;
        const peer=request?null:current.kind==='request'?db.query(`SELECT payload_json FROM session_peer_requests
          WHERE request_id=? AND source_session_id=? AND source_input_id=? AND source_turn_id=?`)
          .get(current.request_id,current.session_id,parent.id,parent.turn_id) as {payload_json:string}|null:null;
        if(!request&&!peer)break;
        const effect=JSON.parse((request??peer)!.payload_json).requestedEffect??'informational';
        effectScope=effectScope==='informational'||effect!=='work'?'informational':'work';
      }
      if(human(db,parent)){
        const payload=JSON.parse(parent.payload_json);
        originatingHuman={...identity,...(payload.capture?.id?{captureId:payload.capture.id}:{})};break;
      }
      current=parent;
    }
    const delivered=!originatingHuman&&current?peerProvenance(current):null;
    if(delivered){originatingHuman=delivered.originatingHuman;
      effectScope=effectScope==='informational'||delivered.effectScope!=='work'?'informational':'work';}
    return source?{source,requestId:input.request_id,effectScope,originatingHuman,...(delivered?{peer:delivered.peer}:{})}:null;
  };
  const withProvenance=(input:Input,projected:{author:Author;text?:string})=>{
    if(input.origin==='human'||projected.author.kind==='unknown')return projected;
    const chain=provenance(input);if(!chain)return projected;
    const humanSource=chain.originatingHuman,session=humanSource?sessionAuthor(humanSource.sessionId):undefined;
    return {...projected,author:{...projected.author,
      ...(chain.effectScope?{effectScope:chain.effectScope}:{}),
      ...(humanSource&&session?{originatingHuman:{session,inputId:humanSource.inputId,runId:humanSource.runId,
        ...(humanSource.captureId?{captureId:humanSource.captureId}:{})}}:{})}};
  };
  const agentText=(payload:any)=>typeof payload.answered_by_request_id==='string'||payload.outcome==='answered'||payload.outcome==='undetermined';
  const communicationAuthor=(event:any):{author:Author;text?:string}=>{
    const payload=JSON.parse(event.payload_json),base={requestId:event.request_id};
    if(payload.source&&typeof payload.final==='boolean'){
      let identity:Record<string,unknown>={};
      if(payload.source.input_id)identity=sourceIdentity(payload.source.input_id,payload.source.run_id);
      else if(payload.source.channel_id&&payload.source.message_ts){
        const claims=db.query(`SELECT turn.session_id,turn.native_run_id FROM slack_user_input_claims claim JOIN turns turn ON turn.id=claim.turn_id
          WHERE claim.slack_channel_id=? AND claim.slack_user_msg_ts=?`).all(payload.source.channel_id,payload.source.message_ts) as any[];
        if(claims.length===1)identity={session:authorSession(claims[0].session_id),...(claims[0].native_run_id?{runId:claims[0].native_run_id}:{})};
      }
      if((identity.session as {id:string}|undefined)?.id!==payload.responding_session_id)return {author:{kind:'unknown',...base}};
      return {author:{kind:'agent',...identity,...base,communication:'reply',replyKind:payload.final?'final':'partial'},text:payload.text};
    }
    if(agentText(payload)&&Number.isSafeInteger(payload.output?.turn_id)){
      const turn=db.query(`SELECT turn.session_id,turn.native_run_id FROM turns turn JOIN session_communication_requests request
        ON request.request_id=? AND request.target_session_id=turn.session_id WHERE turn.id=?`)
        .get(event.request_id,payload.output.turn_id) as any;
      if(turn)return {author:{kind:'agent',session:authorSession(turn.session_id),...(turn.native_run_id?{runId:turn.native_run_id}:{}),...base,
        communication:'result'},text:payload.text};
    }
    return {author:{kind:'service',...base,communication:event.kind==='overdue'?'overdue':'result'},text:payload.text};
  };
  const peerAuthor=(event:any):{author:Author;text?:string}=>{
    const payload=JSON.parse(event.payload_json),base={requestId:event.request_id};
    const session=typeof payload.responding_session_id==='string'?sessionAuthor(payload.responding_session_id):undefined;
    if(typeof payload.final==='boolean')return {author:{kind:'agent',...(session?{session}:{}),...base,communication:'reply',
      replyKind:payload.final?'final':'partial'},text:payload.text};
    const agent=!!session&&event.kind!=='overdue'&&agentText(payload);
    return {author:{kind:agent?'agent':'service',...(agent?{session}:{}),...(agent&&typeof payload.output?.run_id==='string'?{runId:payload.output.run_id}:{}),
      ...base,communication:event.kind==='overdue'?'overdue':'result'},text:payload.text};
  };
  const doorOf=(input:Input)=>{
    const payload=JSON.parse(input.payload_json),body=input.kind==='create'?{...payload.firstInput,door:payload.door}:payload;
    if(typeof body?.door==='string')return body.door;
    const capture=body?.capture?.source;
    if(capture?.kind==='pebble'){
      const wait=pebbleWait(capture,input.created_at);
      return wait===null?'Pebble':`Pebble · recorded ${noticeTime(db,Date.parse(capture.recordedAt))}, reached the server ${minutesText(wait)} later`;
    }
    if(capture?.kind==='monologue')return 'Monologue';
    if(capture?.kind==='outside-agent'&&typeof capture.metadata?.outsideAgent==='string')return `Outside agent · ${capture.metadata.outsideAgent}`;
    if(capture?.kind==='session-message')return 'saved from a conversation';
    if(capture?.kind==='thinkering'){
      const metadata=capture.metadata??{};
      if(typeof metadata.producer==='string')return captureDevices[metadata.producer]??'thnkr.ing capture';
      if(metadata.client==='thinkering-bug-report')return 'bug report';
      return 'Send to Inbox';
    }
    if(input.action_id.startsWith('notification-reply:'))return 'notification reply';
    if(input.action_id.startsWith('share-reply:'))return 'quick capture reply';
    if(input.scope.startsWith('slack'))return 'Slack';
    return input.scope==='surface:thinkering'?'thnkr.ing':null;
  };
  const acceptedAuthor=(input:Input):{author:Author;text?:string}=>{
    const external=db.query('SELECT agent_name,text,request_id FROM session_external_requests WHERE target_input_id=?')
      .get(input.id) as {agent_name:string;text:string;request_id:string}|null;
    if(external)return withProvenance(input,{author:{kind:'agent',outsideAgent:{name:external.agent_name,label:`Outside agent · ${external.agent_name}`},
      requestId:external.request_id,communication:'request'},text:external.text});
    const captureSource=JSON.parse(input.payload_json).capture?.source,capture=captureSource?.metadata?.outsideAgent;
    if(captureSource?.kind==='outside-agent'&&typeof capture==='string')return withProvenance(input,
      {author:{kind:'agent',outsideAgent:{name:capture,label:`Outside agent · ${capture}`}}});
    const corrected=input.origin==='human'?correction(db,input.id):null;
    if(corrected)return withProvenance(input,{author:{kind:'agent',...(corrected.author_session_id!==null?{session:authorSession(corrected.author_session_id)}:{}),
      correction:{reason:corrected.reason,at:corrected.created_at}}});
    const events=db.query('SELECT * FROM session_communication_events WHERE accepted_input_id=? AND request_id=?')
      .all(input.id,input.request_id) as any[];
    if(events.length===1)return withProvenance(input,communicationAuthor(events[0]));
    if(events.length>1)return {author:{kind:'unknown'}};
    const peerEvents=db.query('SELECT * FROM session_peer_events WHERE accepted_input_id=? AND request_id=?')
      .all(input.id,input.request_id) as any[];
    if(peerEvents.length===1)return withProvenance(input,peerAuthor(peerEvents[0]));
    if(peerEvents.length>1)return {author:{kind:'unknown'}};
    if(input.scope===SERVICE_NOTICE_SCOPE)return withProvenance(input,{author:{kind:'service',communication:'notice'}});
    const author:Author={kind:input.origin,...(input.request_id?{requestId:input.request_id}:{})};
    if(input.origin==='human'){const via=doorOf(input);if(via)author.via=via;}
    if(input.kind==='inbox-capture'){
      const quoted=JSON.parse(input.payload_json).capture?.source?.metadata?.quoted;
      if(quoted&&quoted.kind!=='human')author.quoted=quoted;
    }
    if(input.origin==='agent')Object.assign(author,sourceIdentity(input.source_input_id,input.source_run_id));
    const request=db.query(`SELECT * FROM session_communication_requests WHERE target_input_id=? AND target_session_id=? AND request_id=?`)
      .get(input.id,input.session_id,input.request_id) as any;
    if(request){author.communication='request';return withProvenance(input,{author,text:JSON.parse(request.payload_json).text});}
    const delivery=db.query('SELECT * FROM session_peer_deliveries WHERE target_input_id=? AND target_session_id=?')
      .get(input.id,input.session_id) as any;
    if(delivery){
      const retained=delivery.origin_provenance_json?JSON.parse(delivery.origin_provenance_json):{};
      const body=JSON.parse(input.payload_json),delivered=(input.kind==='create'?body.firstInput?.text:body.text)??'';
      return withProvenance(input,{author:{kind:'agent',session:sessionAuthor(receiveSessionFromPeer(delivery.origin_session_id,delivery.peer)),
        inputId:delivery.origin_input_id,runId:delivery.origin_run_id,requestId:delivery.request_id,communication:'request'},
        text:typeof retained.message==='string'?retained.message:peerRequestMessage(delivered,delivery.request_id)});
    }
    return withProvenance(input,{author});
  };
  return (message:{sourceSessionId:number;id:string;role:string}&Record<string,any>)=>{
    const {sourceSessionId,...display}=message;
    const input=display.role==='user'?inputById(db,display.id):null;
    if(input?.session_id===sourceSessionId){
      const body=JSON.parse(input.payload_json),payload=input.kind==='create'?body.firstInput:body;
      if(typeof payload?.text!=='string')return {...display,author:{kind:'unknown'}};
      const {author,text}=acceptedAuthor(input);
      const ids=Array.isArray(payload.attachments)?payload.attachments:[];
      const attachments=ids.flatMap((id:string)=>{
        const attachment=db.query('SELECT id,name,content_type AS contentType FROM session_attachments WHERE id=?').get(id);
        return attachment?[attachment]:[];
      });
      return {...display,author,content:typeof text==='string'?text:payload.text,submissionId:input.id,
        ...(attachments.length?{attachments}:{})};
    }
    const kind=display.author?.kind??(display.role==='user'?'unknown':'agent');
    const {fromSession,...author}=display.author??{};
    const named=typeof fromSession==='string'?sessionAuthor(fromSession):undefined;
    return {...display,author:{...author,kind,...(kind==='agent'?{session:named??authorSession(sourceSessionId)}:{})}};
  };
}
