import type {Database} from 'bun:sqlite';
import {inboxRootResolver} from './presentation-message-source';
import {inboxAttribution} from './inbox-attribution-read';

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
  const result=row.kind==='result',post=row.kind==='post',agent=result||post;
  const content=post?event.text??'':result?event.text??row.agent_text??'':payload.text??'';
  const attachmentIds=agent?event.attachments:payload.attachments;
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
    const posts=database.query("SELECT input_id FROM session_owner_events WHERE session_id=? AND turn_id=? AND kind='post'")
      .all(sessionId,row.turn_id) as {input_id:string|null}[];
    for(const item of posts)if(item.input_id){named.add(item.input_id);if(item.input_id===own)answeredByPost=true;}
    mixedThreads=[...named].some(root=>root!==own);
  }
  const quiet=result&&row.turn_id!==null?(database.query(`SELECT json_extract(payload_json,'$.quiet') AS quiet
    FROM session_owner_events WHERE session_id=? AND turn_id=? AND kind='turn_outcome'
      AND json_extract(payload_json,'$.quiet') IS NOT NULL LIMIT 1`).get(sessionId,row.turn_id) as {quiet:string}|null)?.quiet?.trim():null;
  const raw={id:agent?row.event_id:row.input_id,sourceSessionId:sessionId,role:agent?'assistant':'user',
    ...(mixedThreads?{mixedThreads:true}:{}),...(answeredByPost?{answeredByPost:true}:{}),...(quiet?{quiet}:{}),
    content:typeof content==='string'?content:String(content),tool:null,phase:null,...(row.input_id?{inputId:row.input_id}:{}),
    ...(!agent&&typeof outsideAgent==='string'?{author:{kind:'agent',outsideAgent:{name:outsideAgent,label:`Outside agent · ${outsideAgent}`}}}:{}),
    ...(post?{replyToMessage:event.replyToMessage,author:{kind:event.postedBy==='service'?'service':'agent',communication:'post',
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
    ...(full.replyToMessage?{replyToMessage:full.replyToMessage}:{}),
    ...(full.routedBy?{routedBy:full.routedBy}:{}),...(full.relayed?{relayed:true}:{}),
    ...(full.quiet?{quiet:bounded(String(full.quiet),160).text}:{}),
    ...(author?{author:{kind:author.kind,...(author.communication?{communication:author.communication}:{}),
      ...(author.requestId?{requestId:author.requestId}:{}),
      ...(author.session?{session:{id:author.session.id,title:bounded(String(author.session.title??''),160).text,
        provider:author.session.provider}}:{}),
      ...(author.outsideAgent?{outsideAgent:{name:bounded(String(author.outsideAgent.name??''),100).text,
        label:bounded(String(author.outsideAgent.label??''),140).text}}:{}),
      ...(author.via?{via:bounded(String(author.via),100).text}:{})}}:{}),
    ...(full.submissionId?{submissionId:full.submissionId}:{}),
    createdAt:full.createdAt,timestampSource:full.timestampSource,
    contentCoverage:{complete:false,code:'message_preview',bytes:text.bytes,attachments:ids.length},
    detailRef:{sessionId:`concierge:${sessionId}`,messageId}};
  return {preview,detailJson:JSON.stringify(full)};
}
