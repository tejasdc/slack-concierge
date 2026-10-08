import type {Database} from 'bun:sqlite';
import {spaceForCwd} from './session-space';

type SourceChange={source_table:string;row_key:string;session_id:number|null;request_id:string|null};
const PAGE=20;
function scope(source:Database,id:number){
 const row=source.query('SELECT native_metadata_json FROM sessions WHERE id=?').get(id) as {native_metadata_json:string|null}|null;
 const meta=row?.native_metadata_json?JSON.parse(row.native_metadata_json):{};
 return spaceForCwd(meta.cwd??null);
}
type Request={request_id:string;source_session_id:number;target_session_id:number;created_at_ms:number};
export class PreparedLabRequests{
 constructor(private readonly source:Database,private readonly prepared:Database){
  prepared.exec(`CREATE TABLE IF NOT EXISTS presentation_lab_meta(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation INTEGER NOT NULL DEFAULT 0,
    source_head INTEGER NOT NULL DEFAULT 0,ready INTEGER NOT NULL DEFAULT 0);
   INSERT OR IGNORE INTO presentation_lab_meta(singleton) VALUES(1);
   CREATE TABLE IF NOT EXISTS presentation_lab_requests(
    generation INTEGER NOT NULL,request_id TEXT NOT NULL,created_at_ms INTEGER NOT NULL,
    PRIMARY KEY(generation,request_id));
   CREATE INDEX IF NOT EXISTS presentation_lab_requests_page
    ON presentation_lab_requests(generation,created_at_ms DESC,request_id DESC);
   CREATE TABLE IF NOT EXISTS presentation_lab_session_scope(
    generation INTEGER NOT NULL,session_id INTEGER NOT NULL,space TEXT NOT NULL,
    PRIMARY KEY(generation,session_id));
   CREATE TABLE IF NOT EXISTS presentation_lab_dirty(
    generation INTEGER NOT NULL,session_id INTEGER NOT NULL,source_after TEXT NOT NULL DEFAULT '',target_after TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(generation,session_id));`);
 }
 isReady(generation:number){const row=this.prepared.query('SELECT generation,ready FROM presentation_lab_meta WHERE singleton=1').get() as {generation:number;ready:number};
  return row.ready===1&&row.generation===generation;}
 beginRebuild(generation:number){
  this.prepared.query('DELETE FROM presentation_lab_requests WHERE generation=?').run(generation);
  this.prepared.query('DELETE FROM presentation_lab_session_scope WHERE generation=?').run(generation);
  this.prepared.query('DELETE FROM presentation_lab_dirty WHERE generation=?').run(generation);
 }
 rebuildSession(generation:number,sessionId:number){
  this.prepared.query('INSERT OR REPLACE INTO presentation_lab_session_scope VALUES(?,?,?)').run(generation,sessionId,scope(this.source,sessionId));
 }
 private write(generation:number,requestId:string){
  const row=this.source.query('SELECT request_id,source_session_id,target_session_id,created_at_ms FROM session_communication_requests WHERE request_id=?')
   .get(requestId) as Request|null;
  if(!row||scope(this.source,row.source_session_id)!=='lab'&&scope(this.source,row.target_session_id)!=='lab')
   this.prepared.query('DELETE FROM presentation_lab_requests WHERE generation=? AND request_id=?').run(generation,requestId);
  else this.prepared.query('INSERT OR REPLACE INTO presentation_lab_requests VALUES(?,?,?)').run(generation,requestId,row.created_at_ms);
 }
 rebuildPage(generation:number,after='',limit=PAGE){
  const size=Math.min(PAGE,Math.max(1,limit));
  const rows=this.source.query('SELECT request_id FROM session_communication_requests WHERE request_id>? ORDER BY request_id LIMIT ?')
   .all(after,size+1) as {request_id:string}[];
  for(const row of rows.slice(0,size))this.write(generation,row.request_id);
  return {lastId:rows[Math.min(rows.length,size)-1]?.request_id??after,hasMore:rows.length>size};
 }
 apply(generation:number,changes:readonly SourceChange[]){
  for(const change of changes){
   if(change.source_table==='session_communication_requests'&&change.request_id)this.write(generation,change.request_id);
   if(change.source_table!=='sessions'||!change.session_id)continue;
   const next=scope(this.source,change.session_id);
   const before=this.prepared.query('SELECT space FROM presentation_lab_session_scope WHERE generation=? AND session_id=?')
    .get(generation,change.session_id) as {space:string}|null;
   if(before?.space===next)continue;
   this.prepared.query('INSERT OR REPLACE INTO presentation_lab_session_scope VALUES(?,?,?)').run(generation,change.session_id,next);
   if(before)this.prepared.query('INSERT OR IGNORE INTO presentation_lab_dirty(generation,session_id) VALUES(?,?)').run(generation,change.session_id);
  }
 }
 /** A project move changes the current classification of both ends of every old request.
  * Two indexed 50-row seeks are one worker slice; no owner request performs the rebuild. */
 drain(generation:number){
  const dirty=this.prepared.query('SELECT session_id,source_after,target_after FROM presentation_lab_dirty WHERE generation=? ORDER BY session_id LIMIT 1')
   .get(generation) as {session_id:number;source_after:string;target_after:string}|null;
  if(!dirty)return false;
  const sourceRows=this.source.query(`SELECT request_id FROM session_communication_requests
    WHERE source_session_id=? AND request_id>? ORDER BY request_id LIMIT 50`).all(dirty.session_id,dirty.source_after) as {request_id:string}[];
  const targetRows=this.source.query(`SELECT request_id FROM session_communication_requests
    WHERE target_session_id=? AND request_id>? ORDER BY request_id LIMIT 50`).all(dirty.session_id,dirty.target_after) as {request_id:string}[];
  for(const id of new Set([...sourceRows,...targetRows].map(row=>row.request_id)))this.write(generation,id);
  if(sourceRows.length<50&&targetRows.length<50)this.prepared.query('DELETE FROM presentation_lab_dirty WHERE generation=? AND session_id=?')
   .run(generation,dirty.session_id);
  else this.prepared.query('UPDATE presentation_lab_dirty SET source_after=?,target_after=? WHERE generation=? AND session_id=?')
   .run(sourceRows.at(-1)?.request_id??dirty.source_after,targetRows.at(-1)?.request_id??dirty.target_after,generation,dirty.session_id);
  return true;
 }
 activate(generation:number,sourceHead:number){
  this.prepared.query('UPDATE presentation_lab_meta SET generation=?,source_head=?,ready=1 WHERE singleton=1').run(generation,sourceHead);
  this.cleanup(generation);
 }
 checkpoint(generation:number,sourceHead:number){
  this.prepared.query('UPDATE presentation_lab_meta SET source_head=? WHERE singleton=1 AND generation=? AND ready=1').run(sourceHead,generation);
 }
 private cleanup(generation:number){
  for(const table of ['presentation_lab_requests','presentation_lab_session_scope','presentation_lab_dirty'])
   this.prepared.query(`DELETE FROM ${table} WHERE generation<?`).run(generation);
 }
}
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
export function readPreparedLabRequests(db:Database,cursor:string|null,canonicalHead:number,limit=PAGE){
 const meta=db.query('SELECT generation,source_head,ready FROM presentation_lab_meta WHERE singleton=1')
  .get() as {generation:number;source_head:number;ready:number}|null;
 const coverage={complete:!!meta?.ready&&meta.source_head>=canonicalHead,code:meta?.ready?'complete':'presentation_indexing',appliedSequence:meta?.source_head??0};
 if(!meta?.ready)return {requestIds:[],nextCursor:null,coverage};
 let old:{g:number;ms:number;id:string}|null=null;
 if(cursor){try{if(cursor.length>512||!/^[A-Za-z0-9_-]+$/.test(cursor))throw 0;old=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
   if(old?.g!==meta.generation||!Number.isSafeInteger(old?.ms)||typeof old?.id!=='string')throw 0;
  }catch{return {requestIds:[],nextCursor:null,coverage:{complete:false,code:'reset_required',appliedSequence:meta.source_head}};}}
 const size=Math.min(PAGE,Math.max(1,limit));
 const rows=db.query(`SELECT request_id,created_at_ms FROM presentation_lab_requests WHERE generation=?
  ${old?'AND (created_at_ms,request_id)<(?,?)':''} ORDER BY created_at_ms DESC,request_id DESC LIMIT ?`)
  .all(meta.generation,...(old?[old.ms,old.id]:[]),size+1) as {request_id:string;created_at_ms:number}[];
 const page=rows.slice(0,size),last=page.at(-1);
 return {requestIds:page.map(row=>row.request_id),nextCursor:rows.length>size&&last?encode({g:meta.generation,ms:last.created_at_ms,id:last.request_id}):null,coverage};
}
