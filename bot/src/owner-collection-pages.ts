import type {Database} from 'bun:sqlite';
import {sessionCatalogueLabels} from './session-labels';
import {sessionAddress} from './session-address';
import {savedStartAt} from './saved-start-time';

export const COLLECTION_PAGE=10;
type Mark=Readonly<{at:string;session:number;message:string}>;
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
const decode=(raw:string|null):unknown=>{
 if(!raw)return null;
 if(raw.length>512||!/^[A-Za-z0-9_-]+$/.test(raw))throw new Error('Invalid collection cursor.');
 try{return JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));}catch{throw new Error('Invalid collection cursor.');}
};
const mark=(raw:string|null):Mark|null=>{
 const value=decode(raw);
 if(value===null)return null;
 if(!value||typeof value!=='object')throw new Error('Invalid collection cursor.');
 const item=value as Record<string,unknown>;
 if(typeof item.at!=='string'||!Number.isSafeInteger(item.session)||typeof item.message!=='string')throw new Error('Invalid collection cursor.');
 return {at:item.at,session:item.session as number,message:item.message};
};
export function savedMessagePage(source:Database,kind:'messages'|'followed',cursor:string|null=null,limit=COLLECTION_PAGE){
 const before=mark(cursor),size=Math.min(COLLECTION_PAGE,Math.max(1,limit));
 const table=kind==='messages'?'session_saved_messages':'session_followed_messages';
 const sql=`SELECT session_id,message_id,excerpt,created_at FROM ${table}
  ${before?'WHERE (created_at,session_id,message_id)<(?,?,?)':''}
  ORDER BY created_at DESC,session_id DESC,message_id DESC LIMIT ?`;
 const rows=source.query(sql).all(...(before?[before.at,before.session,before.message]:[]),size+1) as
  {session_id:number;message_id:string;excerpt:string|null;created_at:string}[];
 const items=rows.slice(0,size),last=items.at(-1);
 return {items,nextCursor:rows.length>size&&last?encode({at:last.created_at,session:last.session_id,message:last.message_id}):null};
}
export function savedWorkPage(source:Database,cursor:string|null=null,limit=COLLECTION_PAGE){
 const decoded=decode(cursor),before=decoded===null?null:Number(decoded);
 if(before!==null&&(!Number.isSafeInteger(before)||before<1))throw new Error('Invalid saved-work cursor.');
 const size=Math.min(COLLECTION_PAGE,Math.max(1,limit));
 const rows=source.query(`SELECT * FROM turns WHERE saved_kind IS NOT NULL AND status='queued'
  ${before?'AND id<?':''} ORDER BY id DESC LIMIT ?`).all(...(before?[before]:[]),size+1) as
   {id:number;session_id:number;saved_kind:'scheduled'|'banked';status:string;dispatch_failure_class:string|null;dispatch_next_attempt_ms:number|null;
    saved_at_ms:number;saved_expires_at_ms:number|null;saved_account:string|null;saved_window:string|null;saved_repeat_ms:number|null;saved_sequence:number|null}[];
 const items=rows.slice(0,size),last=items.at(-1);
 return {items,nextCursor:rows.length>size&&last?encode(last.id):null};
}

/** The saved-work list needs a title and control identity, not each session's history. */
export function savedWorkListPage(source:Database,cursor:string|null=null){
 const page=savedWorkPage(source,cursor);
 const ids=[...new Set(page.items.map(turn=>turn.session_id))];
 type SavedWorkSession={id:number;binding_generation:number|null;provider_id:string;native_metadata_json:string|null;
  slack_channel_id:string|null;slack_thread_ts:string|null};
 const sessions=ids.length?source.query(`SELECT id,binding_generation,provider_id,native_metadata_json,slack_channel_id,slack_thread_ts
   FROM sessions WHERE id IN (${ids.map(()=>'?').join(',')}) LIMIT ?`).all(...ids,ids.length) as SavedWorkSession[]:[];
 const byId=new Map(sessions.map(session=>[session.id,session]));
 return {items:page.items.map(turn=>{
   const session=byId.get(turn.session_id);
   if(!session)throw new Error('Saved work session is missing.');
   const labels=sessionCatalogueLabels(source,session);
   return {turnId:turn.id,session:{id:`concierge:${session.id}`,address:sessionAddress(session),
     provider:session.provider_id,title:labels.title,project:labels.project},
    savedWork:{kind:turn.saved_kind,status:turn.status,startsAt:savedStartAt(turn),
      savedAt:new Date(turn.saved_at_ms).toISOString(),
      expiresAt:turn.saved_expires_at_ms?new Date(turn.saved_expires_at_ms).toISOString():null,
      account:turn.saved_account,window:turn.saved_window,repeatEveryMs:turn.saved_repeat_ms,sequence:turn.saved_sequence}};
  }),nextCursor:page.nextCursor,coverage:{complete:true}};
}
