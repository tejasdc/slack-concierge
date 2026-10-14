import type {Database} from 'bun:sqlite';

/** A capture index read needs input rows, never provider transcript pages or attachment bytes. */
export function inboxCapturesPage(database:Database,inboxId:number,cursor:string|null,limit:number){
 const before=cursor===null?null:Number(cursor);
 if(cursor!==null&&(!/^[1-9][0-9]*$/.test(cursor)||!Number.isSafeInteger(before)))
  throw new Error('CAPTURE_CURSOR_INVALID');
 const rows=database.query(`SELECT rowid AS position,id,payload_json,created_at FROM session_inputs
   WHERE session_id=? AND id GLOB 'capture:*' AND json_extract(payload_json,'$.capture') IS NOT NULL ${before===null?'':'AND rowid<?'}
   ORDER BY rowid DESC LIMIT ?`).all(inboxId,...(before===null?[]:[before]),limit+1) as
   {position:number;id:string;payload_json:string;created_at:string}[];
 const page=rows.slice(0,limit);
 return {items:page.map(row=>{
   const body=JSON.parse(row.payload_json),source=body.capture?.source;
   return {id:row.id,text:String(body.text??'').slice(0,4096),at:source?.recordedAt??row.created_at,source,
     attachmentCount:Array.isArray(body.attachments)?body.attachments.length:0};
  }),nextCursor:rows.length>limit?String(page.at(-1)!.position):null};
}
