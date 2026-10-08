import {createHash} from 'node:crypto';
import type {ProviderHistoryMessage} from './provider-history';

const PREVIEW_BYTES=4096;
const MESSAGE_BYTES=8192;
export const HISTORY_DETAIL_PART_BYTES=4096;

export type HistoryContentDetail={digest:string;bytes:number;parts:number};
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const byteLength=(text:string)=>Buffer.byteLength(text,'utf8');
function prefix(text:string,maxBytes:number):string {
  const bytes=Buffer.from(text,'utf8');
  if(bytes.length<=maxBytes)return text;
  let end=maxBytes;
  while(end>0&&(bytes[end]!&0xc0)===0x80)end--;
  return bytes.subarray(0,end).toString('utf8');
}

/** The digest covers both ordinary and structured words; source.text is the same full body. */
export function historyContent(message:Pick<ProviderHistoryMessage,'content'|'richContent'>):string {
  return JSON.stringify({content:message.content,...(message.richContent===undefined?{}:{richContent:message.richContent})});
}

export function historyContentDetail(message:Pick<ProviderHistoryMessage,'content'|'richContent'>):HistoryContentDetail {
  const full=historyContent(message),bytes=byteLength(full);
  return {digest:digest(full),bytes,parts:Math.ceil(bytes/HISTORY_DETAIL_PART_BYTES)};
}

/** Never let one provider answer or imported evidence make the list response grow with its body. */
export function previewHistoryMessage<T extends ProviderHistoryMessage>(message:T):T&{contentDetail?:HistoryContentDetail} {
  const source=message as T&{source?:Record<string,unknown>};
  const normal={...message,...(source.source?{source:{...source.source,text:undefined}}:{}),richContent:undefined};
  const full=historyContent(message);
  if(byteLength(full)<=MESSAGE_BYTES&&byteLength(JSON.stringify(message))<=MESSAGE_BYTES)return message;
  const detail=historyContentDetail(message);
  const preview={...normal,content:prefix(message.content,PREVIEW_BYTES),contentDetail:detail};
  if(byteLength(JSON.stringify(preview))<=MESSAGE_BYTES)return preview;
  // Untrusted provider metadata may itself be large. The detail retains all fields, while
  // the list keeps exact identity and the attribution needed for actions and navigation.
  const compact={id:message.id,role:message.role,content:prefix(message.content,1024),tool:message.tool,
    phase:message.phase,turnId:message.turnId,inputId:message.inputId,submissionId:message.submissionId,
    createdAt:message.createdAt,timestampSource:message.timestampSource,author:message.author,
    detailKey:message.detailKey,contentDetail:detail,
    ...((source.source&&typeof source.source==='object')?{source:{sourceId:source.source.sourceId,
      sourceVersion:source.source.sourceVersion,eventId:source.source.eventId,
      ordinal:source.source.ordinal,role:source.source.role,locator:source.source.locator,
      textHash:source.source.textHash}}:{})};
  if(byteLength(JSON.stringify(compact))<=MESSAGE_BYTES)return compact as T&{contentDetail:HistoryContentDetail};
  const minimal={id:message.id,role:message.role,content:prefix(message.content,256),tool:message.tool,
    phase:message.phase,turnId:message.turnId,inputId:message.inputId,submissionId:message.submissionId,
    author:{kind:message.author?.kind??'unknown'},contentDetail:detail,
    ...((source.source&&typeof source.source==='object')?{source:{sourceId:source.source.sourceId,
      sourceVersion:source.source.sourceVersion,eventId:source.source.eventId}}:{})};
  if(byteLength(JSON.stringify(minimal))>MESSAGE_BYTES)throw new Error('HISTORY_MESSAGE_IDENTITY_TOO_LARGE');
  return minimal as T&{contentDetail:HistoryContentDetail};
}

export function historyDetailPart(full:string,part:number):{content:string;digest:string;bytes:number;part:number;nextPart:number|null} {
  if(!Number.isSafeInteger(part)||part<0)throw new Error('INVALID_HISTORY_DETAIL_PART');
  const bytes=Buffer.from(full,'utf8');
  const parts=Math.ceil(bytes.length/HISTORY_DETAIL_PART_BYTES);
  if(part>=parts)throw new Error('HISTORY_DETAIL_PART_NOT_FOUND');
  const boundary=(offset:number)=>{
    let at=Math.min(bytes.length,offset);
    if(at<bytes.length)while(at>0&&(bytes[at]!&0xc0)===0x80)at--;
    return at;
  };
  const start=boundary(part*HISTORY_DETAIL_PART_BYTES);
  const end=boundary((part+1)*HISTORY_DETAIL_PART_BYTES);
  if(start>=end)throw new Error('HISTORY_DETAIL_PART_GAP');
  return {content:bytes.subarray(start,end).toString('utf8'),digest:digest(full),bytes:bytes.length,
    part,nextPart:part+1<parts?part+1:null};
}
