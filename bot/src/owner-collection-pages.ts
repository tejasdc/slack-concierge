import type {Database} from 'bun:sqlite';

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
