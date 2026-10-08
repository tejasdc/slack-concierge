import {Database} from 'bun:sqlite';
import {existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';

let connection:Database|null=null;
function preparedDb():Database|null {
  const directory=process.env.CONCIERGE_STATE_DIR;
  if(!directory)return null;
  const path=join(realpathSync(directory),'presentation.db');
  if(!existsSync(path))return null;
  if(!connection){connection=new Database(path,{readonly:true});connection.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');}
  return connection;
}

export type PreparedMessageKey={sequence:number;messageId:string};
/** Page-ready values are bounded at projection time; a preview carries an exact detail reference. */
export function preparedInboxDisplays(keys:readonly PreparedMessageKey[]):(unknown|null)[] {
  const database=preparedDb();
  if(!database)return keys.map(()=>null);
  const generation=(database.query('SELECT generation FROM presentation_message_meta WHERE singleton=1').get() as {generation:number}|null)?.generation;
  if(generation===undefined)return keys.map(()=>null);
  const read=database.query('SELECT display_json FROM presentation_message_display WHERE generation=? AND event_sequence=?');
  return keys.map(key=>{
    const row=read.get(generation,key.sequence) as {display_json:string}|null;
    return row?JSON.parse(row.display_json):null;
  });
}
export function preparedInboxDetailPart(sessionId:number,messageId:string,part:number):{
  content:string;nextPart:number|null;complete:boolean;digest:string
}|null {
  if(!Number.isSafeInteger(part)||part<0)throw new Error('INVALID_PRESENTATION_PART');
  const database=preparedDb();if(!database)return null;
  const generation=(database.query('SELECT generation FROM presentation_message_meta WHERE singleton=1').get() as {generation:number}|null)?.generation;
  if(generation===undefined)return null;
  const source=database.query(`SELECT event_sequence AS sequence FROM presentation_messages
    WHERE generation=? AND session_id=? AND message_id=?`).get(generation,sessionId,messageId) as {sequence:number}|null;
  if(!source)return null;
  const rows=database.query(`SELECT part,content,digest FROM presentation_message_detail_chunks
    WHERE generation=? AND event_sequence=? AND part>=? ORDER BY part LIMIT 2`)
    .all(generation,source.sequence,part) as {part:number;content:string;digest:string}[];
  if(!rows.length)return null;
  if(rows[0]!.part!==part)throw new Error('PRESENTATION_DETAIL_GAP');
  return {content:rows[0]!.content,nextPart:rows[1]?.part??null,complete:rows.length===1,digest:rows[0]!.digest};
}
/** Exact prepared lineage lookup; resolving a notification never walks the Inbox history. */
export function preparedThreadRoot(sessionId:number,messageId:string):string|null {
  const database=preparedDb();if(!database)return null;
  const meta=database.query('SELECT generation,ready FROM presentation_message_meta WHERE singleton=1').get() as {generation:number;ready:number}|null;
  if(!meta?.ready)return null;
  const row=database.query('SELECT root_input_id FROM presentation_messages WHERE generation=? AND session_id=? AND message_id=?')
    .get(meta.generation,sessionId,messageId)??database.query('SELECT root_input_id FROM presentation_messages WHERE generation=? AND session_id=? AND input_id=? ORDER BY event_sequence LIMIT 1')
    .get(meta.generation,sessionId,messageId);
  return (row as {root_input_id:string}|null)?.root_input_id??null;
}
export type PreparedTopicEntryKey={sequence:number;messageId?:string;topicEventId?:string};
export type PreparedMessagePage={keys:PreparedMessageKey[];nextCursor:string|null;coverage:{complete:boolean;code?:'presentation_indexing';retryAfterMs?:number;appliedSequence:number}};
export function preparedMessages(sessionId:number,root:string,limit:number,cursor:string|null,sourceHead=0):PreparedMessagePage {
  const database=preparedDb();
  if(!database)return {keys:[],nextCursor:null,coverage:{complete:false,code:'presentation_indexing',retryAfterMs:1000,appliedSequence:0}};
  const meta=database.query('SELECT generation,event_watermark,ready FROM presentation_message_meta WHERE singleton=1')
    .get() as {generation:number;event_watermark:number;ready:number}|null;
  if(!meta?.ready)return {keys:[],nextCursor:null,coverage:{complete:false,code:'presentation_indexing',retryAfterMs:1000,appliedSequence:0}};
  const position=cursor===null?Number.MAX_SAFE_INTEGER:Number(cursor);
  if(!Number.isSafeInteger(position)||position<=0)throw new Error('INVALID_PRESENTATION_CURSOR');
  const rows=database.query(`SELECT event_sequence AS sequence,message_id AS messageId FROM presentation_messages
    WHERE generation=? AND session_id=? AND root_input_id=? AND event_sequence<?
    ORDER BY event_sequence DESC LIMIT ?`).all(meta.generation,sessionId,root,position,limit+1) as PreparedMessageKey[];
  const page=rows.slice(0,limit);
  return {keys:page.slice().reverse(),nextCursor:rows.length>limit?String(page[page.length-1]!.sequence):null,
    coverage:meta.event_watermark>=sourceHead?{complete:true,appliedSequence:meta.event_watermark}
      :{complete:false,code:'presentation_indexing',retryAfterMs:1000,appliedSequence:meta.event_watermark}};
}

export function preparedTopicMessages(topicId:string,limit:number,cursor:string|null):PreparedMessagePage {
  const database=preparedDb();
  if(!database)return {keys:[],nextCursor:null,coverage:{complete:false,code:'presentation_indexing',retryAfterMs:1000,appliedSequence:0}};
  const meta=database.query('SELECT generation,event_watermark,ready FROM presentation_message_meta WHERE singleton=1')
    .get() as {generation:number;event_watermark:number;ready:number}|null;
  if(!meta?.ready)return {keys:[],nextCursor:null,coverage:{complete:false,code:'presentation_indexing',retryAfterMs:1000,appliedSequence:0}};
  const position=cursor===null?Number.MAX_SAFE_INTEGER:Number(cursor);
  if(!Number.isSafeInteger(position)||position<=0)throw new Error('INVALID_PRESENTATION_CURSOR');
  const rows=database.query(`SELECT event_sequence AS sequence,message_id AS messageId FROM presentation_messages
    WHERE generation=? AND topic_id=? AND event_sequence<? ORDER BY event_sequence DESC LIMIT ?`)
    .all(meta.generation,topicId,position,limit+1) as PreparedMessageKey[];
  const page=rows.slice(0,limit);
  return {keys:page.slice().reverse(),nextCursor:rows.length>limit?String(page[page.length-1]!.sequence):null,
    coverage:{complete:true,appliedSequence:meta.event_watermark}};
}

export function preparedTopicEntries(topicId:string,limit:number,cursor:string|null,sourceHead=0):{
  keys:PreparedTopicEntryKey[];nextCursor:string|null;coverage:PreparedMessagePage['coverage']
} {
  const database=preparedDb();
  const incomplete={keys:[],nextCursor:null,coverage:{complete:false as const,code:'presentation_indexing' as const,
    retryAfterMs:1000,appliedSequence:0}};
  if(!database)return incomplete;
  const meta=database.query('SELECT generation,event_watermark,ready FROM presentation_message_meta WHERE singleton=1')
    .get() as {generation:number;event_watermark:number;ready:number}|null;
  if(!meta?.ready)return incomplete;
  const position=cursor===null?Number.MAX_SAFE_INTEGER:Number(cursor);
  if(!Number.isSafeInteger(position)||position<=0)throw new Error('INVALID_PRESENTATION_CURSOR');
  const rows=database.query(`SELECT sequence,messageId,topicEventId FROM (
    SELECT event_sequence AS sequence,message_id AS messageId,NULL AS topicEventId
      FROM presentation_messages WHERE generation=? AND topic_id=? AND event_sequence<?
    UNION ALL
    SELECT event_sequence AS sequence,NULL AS messageId,event_id AS topicEventId
      FROM presentation_topic_events WHERE generation=? AND topic_id=? AND event_sequence<?
  ) ORDER BY sequence DESC LIMIT ?`).all(meta.generation,topicId,position,meta.generation,topicId,position,limit+1) as PreparedTopicEntryKey[];
  const page=rows.slice(0,limit);
  return {keys:page.slice().reverse(),nextCursor:rows.length>limit?String(page[page.length-1]!.sequence):null,
    coverage:meta.event_watermark>=sourceHead?{complete:true,appliedSequence:meta.event_watermark}
      :{complete:false,code:'presentation_indexing',retryAfterMs:1000,appliedSequence:meta.event_watermark}};
}

export type PreparedOwnerMessageVersion={sequence:number;messageId:string;eventId:string};
export function preparedOwnerMessageIds(sessionId:number,afterFirstSequence:number,head:number,limit:number):{
  ids:{messageId:string;firstSequence:number}[];hasMore:boolean;appliedSequence:number;complete:boolean
} {
  const database=preparedDb();
  if(!database)return {ids:[],hasMore:false,appliedSequence:0,complete:false};
  const meta=database.query('SELECT generation,event_watermark,ready FROM presentation_message_meta WHERE singleton=1')
    .get() as {generation:number;event_watermark:number;ready:number}|null;
  if(!meta?.ready)return {ids:[],hasMore:false,appliedSequence:0,complete:false};
  const rows=database.query(`SELECT message_id AS messageId,first_sequence AS firstSequence
    FROM presentation_owner_messages WHERE generation=? AND session_id=?
      AND first_sequence>? AND first_sequence<=? ORDER BY first_sequence LIMIT ?`)
    .all(meta.generation,sessionId,afterFirstSequence,head,limit+1) as {messageId:string;firstSequence:number}[];
  return {ids:rows.slice(0,limit),hasMore:rows.length>limit,
    appliedSequence:meta.event_watermark,complete:meta.event_watermark>=head};
}
/** Stream immutable message versions in ledger order. A fixed head makes replay resumable. */
export function preparedOwnerMessageVersions(sessionId:number,after:number,head:number,limit:number):{
  versions:PreparedOwnerMessageVersion[];hasMore:boolean;appliedSequence:number;complete:boolean
} {
  const database=preparedDb();
  if(!database)return {versions:[],hasMore:false,appliedSequence:0,complete:false};
  const meta=database.query('SELECT generation,event_watermark,ready FROM presentation_message_meta WHERE singleton=1')
    .get() as {generation:number;event_watermark:number;ready:number}|null;
  if(!meta?.ready)return {versions:[],hasMore:false,appliedSequence:0,complete:false};
  const rows=database.query(`SELECT event_sequence AS sequence,message_id AS messageId,event_id AS eventId
    FROM presentation_owner_message_versions WHERE generation=? AND session_id=?
      AND event_sequence>? AND event_sequence<=? ORDER BY event_sequence LIMIT ?`)
    .all(meta.generation,sessionId,after,head,limit+1) as PreparedOwnerMessageVersion[];
  return {versions:rows.slice(0,limit),hasMore:rows.length>limit,
    appliedSequence:meta.event_watermark,complete:meta.event_watermark>=head};
}

/** Exact retained version of one message at an explicit ledger head. */
export function preparedOwnerMessageVersion(sessionId:number,messageId:string,head:number):PreparedOwnerMessageVersion|null {
  const database=preparedDb();
  if(!database)return null;
  const meta=database.query('SELECT generation,ready FROM presentation_message_meta WHERE singleton=1')
    .get() as {generation:number;ready:number}|null;
  if(!meta?.ready)return null;
  return database.query(`SELECT event_sequence AS sequence,message_id AS messageId,event_id AS eventId
    FROM presentation_owner_message_versions WHERE generation=? AND session_id=? AND message_id=? AND event_sequence<=?
    ORDER BY event_sequence DESC LIMIT 1`).get(meta.generation,sessionId,messageId,head) as PreparedOwnerMessageVersion|null;
}
