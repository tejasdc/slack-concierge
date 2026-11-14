import {createHash} from 'node:crypto';
import {decodeResponse} from './codex-native-history-decoder';
import {nativeSourceValueDigest} from './codex-native-source-values';

export const RETAINED_CAPTURE_INTERPRETATION='native_0162_ordinary_original_capture_v1' as const;
export class RetainedCaptureRefusal extends Error {constructor(readonly code:string){super(code);}}
const fail=(code:string):never=>{throw new RetainedCaptureRefusal(code);};
const sha=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');
const utf8=(text:string)=>typeof text==='string'&&Buffer.from(text,'utf8').toString('utf8')===text;

/** Guardian's root-message capture, distinct from additional-context truncation.
 * The marker consumes the native 900 * 4 byte content budget. */
export function guardianOriginalMessageCapture(text:string){
  if(!utf8(text))fail('RETAINED_CAPTURE_UTF8_INVALID');
  const bytes=Buffer.from(text,'utf8'),truncated=bytes.length>3600;
  if(!truncated)return {text,truncated};
  const marker=`<truncated omitted_approx_tokens="${Math.ceil((bytes.length-3600)/4)}" />`;
  const available=3600-Buffer.byteLength(marker);let left=Math.floor(available/2),right=bytes.length-(available-left);
  while((bytes[left]&0xc0)===0x80)left--;
  while((bytes[right]&0xc0)===0x80)right++;
  return {text:bytes.subarray(0,left).toString('utf8')+marker+bytes.subarray(right).toString('utf8'),truncated};
}

/** Native serde RetainedUserMessage shape (not Ordered and not the source ID).
 * Field order cannot change its byte length; defaults control field omission. */
export function nativeRetainedMessageRecord(entry:any){
  return {turn_id:entry.turn_id,message_id:entry.message_id,text:entry.text,complete:entry.complete,
    ...((entry.origin??'user')==='user'?{}:{origin:entry.origin}),...(entry.phase==null?{}:{phase:entry.phase})};
}
export function nativeRetainedFamilyBytes(entries:any[]):number{
  return Buffer.byteLength(JSON.stringify(entries.map(e=>({revision:e.revision,...(e.inherited===true?{inherited:true}:{}),
    order:e.order,...nativeRetainedMessageRecord(e)}))),'utf8');
}

/** Called only for an original response_item, never replacement-history items.
 * Full envelope/source provenance is retained by the reader independently. */
export function deriveOrdinaryOriginalCapture(p:any,metadata:any){
  decodeResponse(p);
  if(metadata?.inherited_user_message===true)fail('RETAINED_CAPTURE_INHERITED_UNSUPPORTED');
  if(metadata?.delivered_assistant_message!=null)fail('RETAINED_CAPTURE_DELIVERED_UNSUPPORTED');
  if(metadata?.compaction_output===true)fail('RETAINED_CAPTURE_COMPACTION_OUTPUT_EXCLUDED');
  if(p.type!=='message'||!['user','assistant'].includes(p.role))fail('RETAINED_CAPTURE_ORDINARY_MESSAGE_REQUIRED');
  if(!Number.isSafeInteger(metadata?.user_input_order)||metadata.user_input_order<0)
    fail('RETAINED_CAPTURE_LOCAL_ORDER_UNPROVEN');
  const kinds=p.internal_chat_message_metadata_passthrough?.content_item_kinds;
  if(kinds!=null&&!kinds.every(utf8))fail('RETAINED_CAPTURE_UTF8_INVALID');
  const userAuthorization=p.role==='user'&&(kinds==null||kinds.length===0||kinds.length!==p.content.length
    ||kinds.some((k:string)=>k.startsWith('user.')||['','unknown','images.preparation_error','images.unsupported','audio.unsupported'].includes(k)));
  if(p.role!=='assistant'&&!userAuthorization)fail('RETAINED_CAPTURE_NOT_USER_AUTHORIZATION');
  const textItems=p.content.filter((c:any)=>['input_text','output_text'].includes(c.type));
  const originalText=textItems.map((c:any)=>c.text).join('\n');
  const captured=guardianOriginalMessageCapture(originalText);
  const complete=(p.role==='assistant'||Array.isArray(kinds)&&kinds.length===p.content.length
    &&kinds.every((k:string)=>k.startsWith('user.')&&k!=='user.goal.omitted'))
    &&metadata.retained_source?.complete!==false&&textItems.length===p.content.length&&!captured.truncated;
  const origin=p.role==='user'&&kinds?.length===1&&kinds[0]==='user.heartbeat'?'heartbeat':'user';
  if(!utf8(p.id)||!utf8(p.internal_chat_message_metadata_passthrough?.turn_id))fail('RETAINED_CAPTURE_SOURCE_ID_UNSUPPORTED');
  const nativeRecord=nativeRetainedMessageRecord({turn_id:p.internal_chat_message_metadata_passthrough.turn_id,
    message_id:p.id,text:captured.text,complete,origin,phase:p.phase??null});
  const nativeRecordBytes=Buffer.byteLength(JSON.stringify(nativeRecord),'utf8');
  // Bound() clears text/completeness and shortens correlation IDs above this
  // size. Do not pretend that those changed IDs prove the original source join.
  if(nativeRecordBytes>16384)fail('RETAINED_CAPTURE_SERIALIZED_RECORD_BOUND_UNSUPPORTED');
  if(p.role==='assistant'&&complete&&captured.text==='')fail('RETAINED_CAPTURE_EMPTY_ASSISTANT_NOT_RETAINED');
  return {policy:RETAINED_CAPTURE_INTERPRETATION,text:captured.text,captureSha256:sha(captured.text),
    captureBytes:Buffer.byteLength(captured.text),complete,phase:p.phase??null,origin,
    originalTextSha256:sha(originalText),originalTextBytes:Buffer.byteLength(originalText),
    nontextItems:p.content.length-textItems.length,truncated:captured.truncated,nativeRecordBytes,
    contentKindsDigest:nativeSourceValueDigest(kinds??null),
    sourceFlags:{clientAuthored:metadata.client_authored??null,inherited:false,compactionOutput:false,deliveredAssistant:false},
    source:'original_response_item' as const};
}
