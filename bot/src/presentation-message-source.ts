import type {Database} from 'bun:sqlite';

export type PreparedInboxMessage={sequence:number;sessionId:number;messageId:string;inputId:string;root:string;createdAt:string};

/** This is the Inbox's retained message predicate, with a bounded event-sequence walk. */
export const inboxMessageSourceSql=`SELECT event.sequence,event.session_id,event.event_id,event.input_id,event.kind,event.created_at,
  json_extract(owner.native_metadata_json,'$.inbox') AS is_inbox,
  json_extract(input.payload_json,'$.capture') IS NOT NULL AS has_capture,
  COALESCE(length(json_extract(event.payload_json,'$.text')),length(turn.agent_text),0)>0 AS has_result_text,
  json_array_length(COALESCE(json_extract(event.payload_json,'$.attachments'),'[]'))>0 AS has_attachments,
  CASE WHEN event.kind IN ('topic','topic_request','topic_question','topic_answer')
    THEN json_extract(event.payload_json,'$.topicId') END AS topic_id,
  CASE WHEN event.kind='message' THEN json_extract(event.payload_json,'$.message.id') END AS owner_message_id
  FROM session_owner_events event
  JOIN sessions owner ON owner.id=event.session_id
  LEFT JOIN session_inputs input ON input.id=event.input_id
  LEFT JOIN turns turn ON turn.id=event.turn_id
  WHERE 1=1`;

type SourceRow={sequence:number;session_id:number;event_id:string;input_id:string|null;kind:string;created_at:string;
  is_inbox:number|null;has_capture:number;has_result_text:number;has_attachments:number;topic_id:string|null;owner_message_id:string|null};
export function sourceMessageId(row:SourceRow):string|null {
  return row.kind==='result'||row.kind==='post'?row.event_id:row.input_id;
}

/** Pure read-only resolver. Its rules mirror the canonical Inbox lineage rule. */
export function inboxRootResolver(db:Database) {
  const memo=new Map<string,string|null>();
  const resolve=(sessionId:number,messageId:string,seen=new Set<string>()):string|null=>{
    const cacheKey=`${sessionId}:${messageId}`;
    if(memo.has(cacheKey))return memo.get(cacheKey)!;
    const row=(db.query(`SELECT event.input_id FROM session_owner_events event
      WHERE event.session_id=? AND event.event_id=? AND event.kind IN ('result','post') ORDER BY event.sequence LIMIT 1`).get(sessionId,messageId)
      ??db.query(`SELECT event.input_id FROM session_owner_events event
      WHERE event.session_id=? AND event.input_id=? AND event.kind NOT IN ('result','post') ORDER BY event.sequence LIMIT 1`).get(sessionId,messageId)) as {input_id:string|null}|null;
    if(!row?.input_id){memo.set(cacheKey,row?.input_id??null);return row?.input_id??null;}
    const inputId=row.input_id;
    if(seen.has(inputId))return inputId;
    seen.add(inputId);
    const link=db.query(`SELECT payload_json FROM session_owner_events WHERE session_id=? AND kind='thread_link' AND input_id=? ORDER BY sequence DESC LIMIT 1`)
      .get(sessionId,inputId) as {payload_json:string}|null;
    if(link){const value=JSON.parse(link.payload_json);if(value.attached!==false&&typeof value.root==='string'){
      memo.set(cacheKey,value.root);return value.root;
    }}
    const own=db.query('SELECT origin,payload_json,request_id FROM session_inputs WHERE id=?').get(inputId) as
      {origin:string;payload_json:string;request_id:string|null}|null;
    if(own?.origin==='human'){
      const replyTo=JSON.parse(own.payload_json)?.replyToMessage;
      if(typeof replyTo?.messageId==='string'&&replyTo.messageId!==inputId){
        const root=resolve(sessionId,replyTo.messageId,seen)??inputId;memo.set(cacheKey,root);return root;
      }
    }
    if(own?.origin==='service'&&own.request_id){
      const request=(db.query('SELECT COALESCE(thread_root_input_id,source_input_id) AS source FROM session_communication_requests WHERE request_id=? AND source_session_id=?').get(own.request_id,sessionId)
        ??db.query('SELECT COALESCE(thread_root_input_id,source_input_id) AS source FROM session_peer_requests WHERE request_id=? AND source_session_id=?').get(own.request_id,sessionId)) as {source:string|null}|null;
      if(request?.source){const root=resolve(sessionId,request.source,seen)??inputId;memo.set(cacheKey,root);return root;}
    }
    memo.set(cacheKey,inputId);return inputId;
  };
  return resolve;
}

export function sourceMessagePage(db:Database,after:number,limit:number,resolveRoot:ReturnType<typeof inboxRootResolver>):{
  messages:PreparedInboxMessage[];topicEvents:{sequence:number;sessionId:number;eventId:string;topicId:string}[];
  ownerMessages:{sequence:number;sessionId:number;messageId:string;eventId:string}[];
  nextSequence:number;hasMore:boolean} {
  const rows=db.query(`${inboxMessageSourceSql} AND event.sequence>? ORDER BY event.sequence LIMIT ?`).all(after,limit) as SourceRow[];
  const messages=rows.flatMap(row=>{
    if(!row.is_inbox)return [];
    if(!(['result','inbox_capture','post'].includes(row.kind)
      ||row.kind==='accepted'&&!row.has_capture))return [];
    if(row.kind==='result'&&!row.has_result_text&&!row.has_attachments)return [];
    const messageId=sourceMessageId(row);
    if(!messageId)return [];
    const root=resolveRoot(row.session_id,messageId);
    return root?[{sequence:row.sequence,sessionId:row.session_id,messageId,inputId:row.input_id??root,root,createdAt:row.created_at}]:[];
  });
  const topicEvents=rows.flatMap(row=>{
    if(!row.is_inbox||!['topic','topic_request','topic_question','topic_answer'].includes(row.kind))return [];
    const topicId=row.topic_id;
    return typeof topicId==='string'?[{sequence:row.sequence,sessionId:row.session_id,eventId:row.event_id,topicId}]:[];
  });
  const ownerMessages=rows.flatMap(row=>{
    if(row.kind!=='message')return [];
    const messageId=row.owner_message_id;
    return typeof messageId==='string'&&messageId?[{sequence:row.sequence,sessionId:row.session_id,messageId,eventId:row.event_id}]:[];
  });
  return {messages,topicEvents,ownerMessages,nextSequence:rows.at(-1)?.sequence??after,hasMore:rows.length===limit};
}
