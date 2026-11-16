import type {Database} from 'bun:sqlite';
import type {AcceptedSessionInput} from './session-inputs';
import type {MessageAuthor} from './provider-history';
import {createHash} from 'node:crypto';

export function retainedMaterialText(database:Database,input:AcceptedSessionInput):string {
  const body=JSON.parse(input.payload_json),payload=body.firstInput??body;
  const attachmentId=payload.capture?.originalTextAttachmentId;
  if(typeof attachmentId==='string'){
    const file=database.query('SELECT bytes,sha256 FROM session_attachments WHERE id=?').get(attachmentId) as {bytes:Uint8Array;sha256:string}|null;
    if(!file||createHash('sha256').update(file.bytes).digest('hex')!==file.sha256)throw new Error('Original retained capture bytes are unavailable or failed verification.');
    return Buffer.from(file.bytes).toString('utf8');
  }
  return payload.routedFrom?.originalText??(typeof payload.text==='string'?payload.text:'');
}

/** Resolve the material's author separately from the agent that copied it. A local
 * reference is proof only when both its exact session and retained words agree. */
export function routedMaterialSource(database:Database,input:AcceptedSessionInput):{
  record:AcceptedSessionInput|null;reference:Record<string,any>|null;text:string;author?:MessageAuthor;
} {
  let current=input,reference:Record<string,any>|null=null;
  const seen=new Set<string>();
  while(!seen.has(current.id)){
    seen.add(current.id);
    const body=JSON.parse(current.payload_json),payload=body.firstInput??body;
    const route=payload.routedFrom;
    if(!route||typeof route.originalText!=='string')return {record:current,reference,text:retainedMaterialText(database,current)};
    reference=route;
    const original=typeof route.messageId==='string'?database.query('SELECT * FROM session_inputs WHERE id=?').get(route.messageId) as AcceptedSessionInput|null:null;
    if(!original||route.sessionId!==`concierge:${original.session_id}`){
      const kind=['human','agent','service','unknown'].includes(route.authorKind)?route.authorKind:'unknown';
      return {record:null,reference,text:route.originalText,author:route.author?.kind===kind?route.author:{kind:'unknown'}};
    }
    if(retainedMaterialText(database,original)!==route.originalText)
      return {record:null,reference,text:route.originalText,author:{kind:'unknown'}};
    current=original;
  }
  return {record:null,reference,text:reference?.originalText??'',author:{kind:'unknown'}};
}
