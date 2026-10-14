import type {Database} from 'bun:sqlite';

/** A capture index read needs input rows, never provider transcript pages or attachment bytes. */
export function inboxCapturesPage(database:Database,inboxId:number,cursor:string|null,limit:number){
 const before=cursor===null?null:Number(cursor);
 if(cursor!==null&&(!/^[1-9][0-9]*$/.test(cursor)||!Number.isSafeInteger(before)))
  throw new Error('CAPTURE_CURSOR_INVALID');
 const rows=database.query(`SELECT rowid AS position,id,
   substr(json_extract(payload_json,'$.text'),1,4096) AS text,
   json_extract(payload_json,'$.capture.source') AS source_json,
   json_array_length(json_extract(payload_json,'$.attachments')) AS attachment_count,
   created_at FROM session_inputs
   WHERE session_id=? AND id GLOB 'capture:*' AND json_extract(payload_json,'$.capture') IS NOT NULL ${before===null?'':'AND rowid<?'}
   ORDER BY rowid DESC LIMIT ?`).all(inboxId,...(before===null?[]:[before]),limit+1) as
   {position:number;id:string;text:string|null;source_json:string|null;attachment_count:number|null;created_at:string}[];
 const page=rows.slice(0,limit);
 return {items:page.map(row=>{
   const source=row.source_json?JSON.parse(row.source_json):null;
   return {id:row.id,text:row.text??'',at:source?.recordedAt??row.created_at,source,
     attachmentCount:row.attachment_count??0};
  }),nextCursor:rows.length>limit?String(page.at(-1)!.position):null};
}
