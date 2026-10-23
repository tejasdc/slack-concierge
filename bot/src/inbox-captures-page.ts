import type {Database} from 'bun:sqlite';

/** A capture index read needs input rows, never provider transcript pages or attachment bytes. */
export function inboxCapturesPage(database:Database,inboxId:number,cursor:string|null,limit:number,heldOnly=false){
 const before=cursor===null?null:Number(cursor);
 if(cursor!==null&&(!/^[1-9][0-9]*$/.test(cursor)||!Number.isSafeInteger(before)))
  throw new Error('CAPTURE_CURSOR_INVALID');
 const fields=`input.rowid AS position,input.id,input.session_id,
   substr(json_extract(input.payload_json,'$.text'),1,4096) AS text,
   COALESCE(json_extract(input.payload_json,'$.capture.source'),
     CASE WHEN input.action_id GLOB 'share-reply:*' THEN json_object('kind','thinkering','id',input.action_id,'recordedAt',input.created_at,'title','Addressed capture reply') END) AS source_json,
   json_array_length(json_extract(input.payload_json,'$.attachments')) AS attachment_count,
   input.created_at,held.capture_id AS held_capture_id`;
 const rows=database.query(heldOnly?`SELECT ${fields} FROM focus_held_captures held
   JOIN session_inputs input ON input.id=held.input_id
   WHERE held.released_at_ms IS NULL ${before===null?'':'AND held.input_position<?'}
   ORDER BY held.input_position DESC LIMIT ?`:`SELECT ${fields} FROM session_inputs input
   LEFT JOIN focus_held_captures held ON held.input_id=input.id AND held.released_at_ms IS NULL
   WHERE input.session_id=? AND input.id GLOB 'capture:*' AND json_extract(input.payload_json,'$.capture') IS NOT NULL ${before===null?'':'AND input.rowid<?'}
   ORDER BY input.rowid DESC LIMIT ?`).all(...(heldOnly?[]:[inboxId]),...(before===null?[]:[before]),limit+1) as
   {position:number;id:string;session_id:number;text:string|null;source_json:string|null;attachment_count:number|null;created_at:string;held_capture_id:string|null}[];
 const page=rows.slice(0,limit);
 return {items:page.map(row=>{
   const source=row.source_json?JSON.parse(row.source_json):null;
   return {id:row.id,captureId:row.held_capture_id??row.id.replace(/^capture:/,''),sessionId:`concierge:${row.session_id}`,
     text:row.text??'',at:source?.recordedAt??row.created_at,source,
     attachmentCount:row.attachment_count??0,held:row.held_capture_id!==null};
  }),nextCursor:rows.length>limit?String(page.at(-1)!.position):null};
}
