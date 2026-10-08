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
    generation INTEGER NOT NULL,request_id TEXT NOT NULL,created_at_ms INTEGER NOT NULL,display_json TEXT,
    PRIMARY KEY(generation,request_id));
   CREATE INDEX IF NOT EXISTS presentation_lab_requests_page
    ON presentation_lab_requests(generation,created_at_ms DESC,request_id DESC);
   CREATE TABLE IF NOT EXISTS presentation_lab_session_scope(
    generation INTEGER NOT NULL,session_id INTEGER NOT NULL,space TEXT NOT NULL,
    PRIMARY KEY(generation,session_id));
   CREATE TABLE IF NOT EXISTS presentation_lab_dirty(
    generation INTEGER NOT NULL,session_id INTEGER NOT NULL,source_after TEXT NOT NULL DEFAULT '',target_after TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(generation,session_id));`);
  const hasDisplay=(prepared.query('PRAGMA table_info(presentation_lab_requests)').all() as {name:string}[])
   .some(column=>column.name==='display_json');
  if(!hasDisplay){prepared.exec('ALTER TABLE presentation_lab_requests ADD COLUMN display_json TEXT');
   prepared.query('UPDATE presentation_lab_meta SET ready=0 WHERE singleton=1').run();}
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
  const row=this.source.query(`SELECT request_id,source_session_id,target_session_id,created_at_ms,
    status,outcome,payload_json,result_json FROM session_communication_requests WHERE request_id=?`)
   .get(requestId) as (Request&{status:string;outcome:string|null;payload_json:string;result_json:string|null})|null;
  if(!row||scope(this.source,row.source_session_id)!=='lab'&&scope(this.source,row.target_session_id)!=='lab')
   this.prepared.query('DELETE FROM presentation_lab_requests WHERE generation=? AND request_id=?').run(generation,requestId);
  else {
   const payload=JSON.parse(row.payload_json),result=row.result_json?JSON.parse(row.result_json):null;
   const ended=this.source.query("SELECT created_at_ms AS at,payload_json FROM session_communication_events WHERE request_id=? AND kind='final' AND superseded_by_event_id IS NULL LIMIT 1")
    .get(requestId) as {at:number;payload_json:string}|null;
   const answered=ended?JSON.parse(ended.payload_json):null;
   const text=String(payload.text??''),answer=result?.text?String(result.text):null;
   const line=(summary:unknown,body:string)=>typeof summary==='string'&&summary
    ?{summary:summary.slice(0,200),summaryWritten:true}
    :{summary:body.trim().split('\n')[0]!.slice(0,200),summaryWritten:false};
   const display={requestId,sourceSessionId:row.source_session_id,targetSessionId:row.target_session_id,
    effect:payload.requestedEffect??'informational',...line(payload.summary,text),text:text.slice(0,4000),
    state:row.outcome?'ended':'open',outcome:row.outcome,disposition:result?.workDisposition??null,
    answer:answer?.slice(0,4000)??null,answerSummary:answer?line(answered?.summary,answer):null,
    askedAt:new Date(row.created_at_ms).toISOString(),endedAt:ended?new Date(ended.at).toISOString():null};
   const encoded=JSON.stringify(display);
   if(Buffer.byteLength(encoded)>16*1024)throw new Error('LAB_REQUEST_DISPLAY_EXCEEDS_BOUND');
   this.prepared.query('INSERT OR REPLACE INTO presentation_lab_requests VALUES(?,?,?,?)').run(generation,requestId,row.created_at_ms,encoded);
  }
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
   if(['session_communication_requests','session_communication_events'].includes(change.source_table)&&change.request_id)this.write(generation,change.request_id);
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
 if(!meta?.ready)return {requestIds:[],displays:[],generation:0,nextCursor:null,coverage};
 let old:{g:number;ms:number;id:string}|null=null;
 if(cursor){try{if(cursor.length>512||!/^[A-Za-z0-9_-]+$/.test(cursor))throw 0;old=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
   if(old?.g!==meta.generation||!Number.isSafeInteger(old?.ms)||typeof old?.id!=='string')throw 0;
  }catch{return {requestIds:[],displays:[],generation:meta.generation,nextCursor:null,coverage:{complete:false,code:'reset_required',appliedSequence:meta.source_head}};}}
 const size=Math.min(PAGE,Math.max(1,limit));
 const rows=db.query(`SELECT request_id,created_at_ms,display_json FROM presentation_lab_requests WHERE generation=?
  ${old?'AND (created_at_ms,request_id)<(?,?)':''} ORDER BY created_at_ms DESC,request_id DESC LIMIT ?`)
  .all(meta.generation,...(old?[old.ms,old.id]:[]),size+1) as {request_id:string;created_at_ms:number;display_json:string|null}[];
 const page=rows.slice(0,size),last=page.at(-1);
 return {requestIds:page.map(row=>row.request_id),displays:page.map(row=>row.display_json?JSON.parse(row.display_json):null),generation:meta.generation,
  nextCursor:rows.length>size&&last?encode({g:meta.generation,ms:last.created_at_ms,id:last.request_id}):null,coverage};
}

/** Shared route/fixture assembly. The owner never opens request payload or final-event JSON;
 * only the worker parses them before publishing a bounded display value. */
export function labRequestPageViews(prepared:Database,generation:number,displays:readonly unknown[]){
 const parties=new Map<number,{id:string;title:string|null;lab:boolean}>();
 const party=(id:number)=>{
  const cached=parties.get(id);if(cached)return cached;
  const row=prepared.query('SELECT card_json FROM presentation_session_cards WHERE generation=? AND session_id=? LIMIT 1')
   .get(generation,id) as {card_json:string}|null;
  const card=row?JSON.parse(row.card_json):null;
  const value={id:`concierge:${id}`,title:typeof card?.title==='string'?card.title:null,lab:card?.space==='lab'};
  parties.set(id,value);return value;
 };
 return displays.flatMap(raw=>{
  if(!raw)return [];
  const value=raw as Record<string,any>;
  const {sourceSessionId,targetSessionId,...display}=value;
  return [{...display,from:party(sourceSessionId),to:party(targetSessionId)}];
 });
}
