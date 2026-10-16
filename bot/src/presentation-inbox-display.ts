import type {Database} from 'bun:sqlite';
import {inboxRootResolver} from './presentation-message-source';
import {inboxAttribution} from './inbox-attribution-read';
import {routeTitle} from './inbox-request-root';

const CONTENT_BYTES=8192;
const bounded=(value:string,max=CONTENT_BYTES)=>{
  const bytes=Buffer.byteLength(value);
  if(bytes<=max)return {text:value,bytes,complete:true};
  return {text:Buffer.from(value).subarray(0,max).toString('utf8').replace(/\uFFFD$/,''),bytes,complete:false};
};
const stamp=(value:string)=>value.includes('T')?value:value+'Z';

/** Build a page-ready value in the isolated worker. The full retained row stays behind an exact detail read. */
export function preparedInboxDisplay(database:Database,sessionId:number,sequence:number,messageId:string){
  const row=database.query(`SELECT event.event_id,event.input_id,event.kind,event.payload_json,event.created_at,event.turn_id,
      input.payload_json AS input_json,input.origin,turn.agent_text
    FROM session_owner_events event
    LEFT JOIN session_inputs input ON input.id=event.input_id
    LEFT JOIN turns turn ON turn.id=event.turn_id
    WHERE event.session_id=? AND event.sequence=?`).get(sessionId,sequence) as {
    event_id:string;input_id:string|null;kind:string;payload_json:string;created_at:string;turn_id:number|null;
    input_json:string|null;origin:string|null;agent_text:string|null
  }|null;
  if(!row)return null;
  const input=row.input_json?JSON.parse(row.input_json):{};
  const payload=input.firstInput??input;
  const event=JSON.parse(row.payload_json);
  if(row.kind==='topic_route'){
    const original=database.query('SELECT payload_json,origin,created_at,session_id FROM session_inputs WHERE id=?')
      .get(event.sourceMessageId) as {payload_json:string;origin:string;created_at:string;session_id:number}|null;
    if(!original)return null;
    const source=JSON.parse(original.payload_json),sourcePayload=source.firstInput??source;
    const ids=Array.isArray(sourcePayload.attachments)?sourcePayload.attachments.filter((id:unknown):id is string=>typeof id==='string'):[];
    const attachments=ids.map(id=>database.query('SELECT id,name,content_type AS contentType FROM session_attachments WHERE id=?').get(id)).filter(Boolean);
    const full={id:row.event_id,sourceSessionId:sessionId,role:original.origin==='agent'?'assistant':'user',content:String(sourcePayload.text??''),tool:null,phase:null,
      inputId:row.event_id,submissionId:event.sourceMessageId,attachments,
      ...(original.origin==='agent'?{author:{kind:'agent',outsideAgent:{name:'agent test',label:'Agent test'}}}:{}),
      routedFrom:{sessionId:`concierge:${original.session_id}`,topicId:event.sourceTopicId,root:event.sourceRoot,messageId:event.sourceMessageId,
        title:routeTitle(database,event.sourceTopicId,null)},
      createdAt:stamp(original.created_at.replace(' ','T')),timestampSource:'submitted'};
    if(Buffer.byteLength(JSON.stringify(full))<=8192)return {preview:full,detailJson:null};
    return {preview:{...full,content:bounded(full.content,1024).text,attachments:[],
      contentCoverage:{complete:false,code:'message_preview',bytes:Buffer.byteLength(full.content),attachments:ids.length},
      detailRef:{sessionId:`concierge:${sessionId}`,messageId:row.event_id}},detailJson:JSON.stringify(full)};
  }
  const result=row.kind==='result',post=row.kind==='post',request=row.kind==='request',agent=result||post||request;
  const displayedRoot=post?inboxRootResolver(database)(sessionId,row.event_id)??row.input_id:row.input_id;
  const content=post?event.text??'':result?event.text??row.agent_text??'':payload.text??'';
  const attachmentIds=result||post?event.attachments:payload.attachments;
  const ids=Array.isArray(attachmentIds)?attachmentIds.filter((id:unknown):id is string=>typeof id==='string'):[];
  const attachments=ids.map(id=>database.query(
    'SELECT id,name,content_type AS contentType FROM session_attachments WHERE id=?').get(id)).filter(Boolean);
  const outsideAgent=payload.capture?.source?.kind==='outside-agent'?payload.capture.source.metadata?.outsideAgent:undefined;
  let link:{thread:string;routedBy:unknown;attached:boolean}|null=null;
  if(!agent&&row.input_id){
    const found=database.query(`SELECT payload_json FROM session_owner_events WHERE session_id=? AND kind='thread_link'
      AND input_id=? ORDER BY sequence DESC LIMIT 1`).get(sessionId,row.input_id) as {payload_json:string}|null;
    if(found){const value=JSON.parse(found.payload_json);link={thread:value.thread,routedBy:value.routedBy??null,attached:value.attached!==false};}
  }
  let mixedThreads=false,answeredByPost=false;
  if(result&&row.turn_id!==null){
    const rootOf=inboxRootResolver(database),own=row.input_id?rootOf(sessionId,row.input_id):null;
    const named=new Set<string>();
    for(const table of ['session_communication_requests','session_peer_requests'] as const){
      const roots=database.query(`SELECT COALESCE(thread_root_input_id,source_input_id) AS root FROM ${table}
        WHERE source_turn_id=? AND source_session_id=?`).all(row.turn_id,sessionId) as {root:string|null}[];
      for(const item of roots)if(item.root)named.add(rootOf(sessionId,item.root)??item.root);
    }
    const posts=database.query("SELECT coalesce(json_extract(payload_json,'$.threadRoot'),input_id) AS root FROM session_owner_events WHERE session_id=? AND turn_id=? AND kind='post'")
      .all(sessionId,row.turn_id) as {root:string|null}[];
    for(const item of posts)if(item.root){named.add(item.root);if(item.root===own)answeredByPost=true;}
    mixedThreads=[...named].some(root=>root!==own);
  }
  const quiet=result&&row.turn_id!==null?(database.query(`SELECT json_extract(payload_json,'$.quiet') AS quiet
    FROM session_owner_events WHERE session_id=? AND turn_id=? AND kind='turn_outcome'
      AND json_extract(payload_json,'$.quiet') IS NOT NULL LIMIT 1`).get(sessionId,row.turn_id) as {quiet:string}|null)?.quiet?.trim():null;
  const closing=post?database.query('SELECT payload_json FROM session_owner_events WHERE event_id=?')
    .get(`post:closure:${row.event_id}`) as {payload_json:string}|null:null;
  const closingLine=closing?JSON.parse(closing.payload_json).closingLine:null;
  const routed=row.input_id&&!agent?(database.query("SELECT payload_json FROM session_owner_events WHERE kind IN ('topic_route','session_route') AND json_extract(payload_json,'$.sourceMessageId')=? ORDER BY sequence DESC LIMIT 1")
    .get(row.input_id) as {payload_json:string}|null):null;
  const route=routed?JSON.parse(routed.payload_json):null;
  const peerRoute=route?.requestId?database.query('SELECT delivery_json,outcome FROM session_peer_requests WHERE request_id=?')
    .get(route.requestId) as {delivery_json:string|null;outcome:string|null}|null:null;
  const delivery=peerRoute?.delivery_json?(peerRoute.outcome?'failed':'pending'):'delivered';
  const raw={id:agent?row.event_id:row.input_id,sourceSessionId:sessionId,role:agent?'assistant':'user',
    ...(typeof (post?event.messageThreadRootId:payload.messageThreadRootId)==='string'?{messageThreadRootId:post?event.messageThreadRootId:payload.messageThreadRootId}:{}),
    ...(route?{routedTo:{...(route.topicId?{topicId:route.topicId}:{}),...(route.destinationSessionId?{sessionId:route.destinationSessionId}:{}),messageId:route.destinationMessageId,
      title:routeTitle(database,route.topicId,route.destinationSessionId),delivery}}:{}),
    ...(mixedThreads?{mixedThreads:true}:{}),...(answeredByPost?{answeredByPost:true}:{}),...(quiet?{quiet}:{}),
    ...(typeof closingLine==='string'?{closingLine}:{}),
    ...(post&&event.answersQuestion===true?{answersQuestion:true}:{}),
    content:typeof content==='string'?content:String(content),tool:null,phase:null,...(row.input_id?{inputId:request?row.event_id:displayedRoot}:{}),
    ...(!agent&&typeof outsideAgent==='string'?{author:{kind:'agent',outsideAgent:{name:outsideAgent,label:`Outside agent · ${outsideAgent}`}}}:{}),
    ...(request?{author:{kind:'agent',communication:'request',requestId:event.requestId}}:{}),
    ...(result&&typeof payload.messageThreadRootId==='string'&&row.input_id?{replyToMessage:{kind:'message',sessionId:`concierge:${sessionId}`,messageId:row.input_id}}:{}),
    ...(post?{replyToMessage:displayedRoot!==row.input_id?{kind:'message',sessionId:`concierge:${sessionId}`,messageId:displayedRoot}:event.replyToMessage,author:{kind:event.postedBy==='service'?'service':'agent',communication:'post',
      ...(typeof event.requestId==='string'?{requestId:event.requestId}:{}),
      ...(typeof event.postedBySession==='string'?{fromSession:event.postedBySession}:{})},...(event.relayed?{relayed:true}:{})}:{}),
    ...(link?.attached?{replyToMessage:{kind:'message',sessionId:`concierge:${sessionId}`,messageId:link.thread},routedBy:link.routedBy}:{}),
    ...(agent?(attachments.length?{attachments}:{}):{submissionId:row.input_id,attachments}),
    createdAt:stamp(row.created_at),timestampSource:agent?'received':'submitted',
  };
  const full=inboxAttribution(database)(raw as typeof raw&{id:string});
  const text=bounded(full.content);
  // A caption, filename or routing note can itself be large. Bound the entire prepared row,
  // not only its principal text; the exact retained item remains available by detailRef.
  if(Buffer.byteLength(JSON.stringify(full))<=8192&&text.complete)
    return {preview:full,detailJson:null};
  const author=full.author as Record<string,any>|undefined;
  const preview={id:full.id,sourceSessionId:sessionId,role:full.role,
    content:bounded(full.content,1024).text,tool:null,phase:null,...(full.inputId?{inputId:full.inputId}:{}),
    ...(full.mixedThreads?{mixedThreads:true}:{}),...(full.answeredByPost?{answeredByPost:true}:{}),
    ...(full.answersQuestion?{answersQuestion:true}:{}),
    ...(typeof full.closingLine==='string'?{closingLine:bounded(full.closingLine,512).text}:{}),
    ...(full.replyToMessage?{replyToMessage:full.replyToMessage}:{}),
    ...(full.messageThreadRootId?{messageThreadRootId:full.messageThreadRootId}:{}),
    ...(full.routedBy?{routedBy:full.routedBy}:{}),...(full.routedTo?{routedTo:full.routedTo}:{}),...(full.relayed?{relayed:true}:{}),
    ...(full.quiet?{quiet:bounded(String(full.quiet),160).text}:{}),
    ...(author?{author:{kind:author.kind,...(author.communication?{communication:author.communication}:{}),
      ...(author.requestId?{requestId:author.requestId}:{}),
      ...(author.session?{session:{id:author.session.id,title:bounded(String(author.session.title??''),160).text,
        provider:author.session.provider??null,model:author.session.model??null,reasoningEffort:author.session.reasoningEffort??null,
        agentName:author.session.agentName??null}}:{}),
      ...(author.outsideAgent?{outsideAgent:{name:bounded(String(author.outsideAgent.name??''),100).text,
        label:bounded(String(author.outsideAgent.label??''),140).text}}:{}),
      ...(author.via?{via:bounded(String(author.via),100).text}:{})}}:{}),
    ...(full.submissionId?{submissionId:full.submissionId}:{}),
    createdAt:full.createdAt,timestampSource:full.timestampSource,
    contentCoverage:{complete:false,code:'message_preview',bytes:text.bytes,attachments:ids.length},
    detailRef:{sessionId:`concierge:${sessionId}`,messageId}};
  return {preview,detailJson:JSON.stringify(full)};
}
