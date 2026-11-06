import type {Database} from 'bun:sqlite';

export type ReceiptAttachment=Readonly<{id:string;name:string;contentType:string;sha256:string}>;
export type ReceiptAttachmentProjection=Readonly<{attachments:readonly ReceiptAttachment[];count:number}>;

/** Publish immutable custody metadata in the same order as the accepted request. Bytes and
 * source authority remain behind the attachment read; a receipt never becomes another store. */
export function receiptAttachmentProjection(database:Database,kind:string,payload:unknown):ReceiptAttachmentProjection{
  if(!payload||typeof payload!=='object')return {attachments:[],count:0};
  const body=kind==='create'&&(payload as any).firstInput&&typeof (payload as any).firstInput==='object'
    ?(payload as any).firstInput:payload as any;
  const ids=Array.isArray(body.attachments)
    ?body.attachments.filter((id:unknown):id is string=>typeof id==='string')
    :[];
  if(!ids.length)return {attachments:[],count:0};
  const attachments=database.query(`SELECT attachment.id,attachment.name,attachment.content_type AS contentType,attachment.sha256
    FROM json_each(?) reference JOIN session_attachments attachment ON attachment.id=reference.value
    ORDER BY CAST(reference.key AS INTEGER)`).all(JSON.stringify(ids)) as ReceiptAttachment[];
  return {attachments,count:ids.length};
}
