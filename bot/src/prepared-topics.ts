import type {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';
import {preparedTopicValue,topicContext,type TopicContext} from './prepared-topic-values';

const PAGE=20,CHUNK_BYTES=16*1024;
type State='open'|'closed'|'background'|'all';
const orderKey=(band:number,at:string,id:string)=>`${band}:${String(9999999999999-Date.parse(at)).padStart(13,'0')}:${id}`;
type Meta={generation:number;source_head:number;ready:number};
const json=(value:unknown)=>JSON.stringify(value);
const cursor=(value:unknown)=>Buffer.from(json(value)).toString('base64url');
const decode=(value:string)=>{try{return JSON.parse(Buffer.from(value,'base64url').toString());}catch{return null;}};
const preview=(text:string,size=240)=>Array.from(text).slice(0,size).join('');
const questionSet=(q:any,state:string)=>state==='open'?q.waiting&&q.kind==='decision'
 :state==='reading'?q.waiting&&q.kind==='reading':state==='checking'?q.readiness==='preparing'&&['open','partial'].includes(q.state)&&q.kind==='decision'
 :state==='deferred'?q.state==='deferred':['answered','declined','withdrawn','superseded','read','expired'].includes(q.state);

/** This derived store owns no canonical mutations. The worker supplies a read-only source.
 * Complete values are retained as immutable chunks, so a large reading item cannot turn a
 * list query into a large response or silently lose its text. */
export class PreparedTopics {
 constructor(private source:Database,private prepared:Database){
  prepared.exec(`CREATE TABLE IF NOT EXISTS presentation_topics_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),
   generation INTEGER NOT NULL DEFAULT 0,source_head INTEGER NOT NULL DEFAULT 0,ready INTEGER NOT NULL DEFAULT 0);
   INSERT OR IGNORE INTO presentation_topics_meta(singleton) VALUES(1);
   CREATE TABLE IF NOT EXISTS presentation_topic_roots(generation INTEGER NOT NULL,root_id TEXT NOT NULL,topic_id TEXT,
    session_id INTEGER NOT NULL,sequence INTEGER NOT NULL,at TEXT NOT NULL,text TEXT NOT NULL,unfiled INTEGER NOT NULL,
    PRIMARY KEY(generation,root_id));
   CREATE INDEX IF NOT EXISTS presentation_topic_unfiled ON presentation_topic_roots(generation,unfiled,sequence DESC,root_id);
   CREATE TABLE IF NOT EXISTS presentation_topic_sorting(generation INTEGER PRIMARY KEY,count INTEGER NOT NULL DEFAULT 0,attention_json TEXT NOT NULL DEFAULT '[]');
   CREATE TRIGGER IF NOT EXISTS presentation_topic_unfiled_added AFTER INSERT ON presentation_topic_roots BEGIN
    INSERT INTO presentation_topic_sorting(generation,count) VALUES(new.generation,new.unfiled)
     ON CONFLICT(generation) DO UPDATE SET count=count+new.unfiled; END;
   CREATE TRIGGER IF NOT EXISTS presentation_topic_unfiled_changed AFTER UPDATE OF unfiled ON presentation_topic_roots BEGIN
    UPDATE presentation_topic_sorting SET count=count+new.unfiled-old.unfiled WHERE generation=new.generation; END;
   CREATE TRIGGER IF NOT EXISTS presentation_topic_unfiled_removed AFTER DELETE ON presentation_topic_roots BEGIN
    UPDATE presentation_topic_sorting SET count=count-old.unfiled WHERE generation=old.generation; END;
   CREATE TABLE IF NOT EXISTS presentation_topics(generation INTEGER NOT NULL,topic_id TEXT NOT NULL,
    session_id INTEGER NOT NULL,state TEXT NOT NULL,background INTEGER NOT NULL,band INTEGER NOT NULL,
    recency TEXT NOT NULL,closed_recency TEXT NOT NULL,summary_json TEXT NOT NULL,detail_hash TEXT NOT NULL,
    search_text TEXT NOT NULL,sort_key TEXT NOT NULL,closed_sort_key TEXT NOT NULL,PRIMARY KEY(generation,topic_id));
   CREATE INDEX IF NOT EXISTS presentation_topics_open ON presentation_topics(generation,state,sort_key);
   CREATE INDEX IF NOT EXISTS presentation_topics_all ON presentation_topics(generation,sort_key);
   CREATE INDEX IF NOT EXISTS presentation_topics_closed ON presentation_topics(generation,state,closed_sort_key);
   CREATE INDEX IF NOT EXISTS presentation_topics_background ON presentation_topics(generation,background,sort_key);
   CREATE TABLE IF NOT EXISTS presentation_topic_chunks(hash TEXT NOT NULL,chunk INTEGER NOT NULL,text TEXT NOT NULL,
    count INTEGER NOT NULL,PRIMARY KEY(hash,chunk));
   CREATE TABLE IF NOT EXISTS presentation_topic_changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT,generation INTEGER NOT NULL,
    topic_id TEXT NOT NULL,before_json TEXT,after_json TEXT);
   CREATE INDEX IF NOT EXISTS presentation_topic_changes_page ON presentation_topic_changes(generation,sequence);
   CREATE TABLE IF NOT EXISTS presentation_topic_questions(generation INTEGER NOT NULL,topic_id TEXT NOT NULL,
    question_id TEXT NOT NULL,selected TEXT NOT NULL,created_at TEXT NOT NULL,value_json TEXT NOT NULL,
    PRIMARY KEY(generation,selected,topic_id,question_id));
   CREATE INDEX IF NOT EXISTS presentation_topic_question_page ON presentation_topic_questions(generation,selected,created_at DESC,question_id);`);
 }
 beginRebuild(generation:number){
  for(const table of ['presentation_topics','presentation_topic_questions'])this.prepared.query(`DELETE FROM ${table} WHERE generation=?`).run(generation);
 }
 context(generation:number,sessionId:number){return topicContext(this.source,this.prepared,generation,sessionId);}
 updateRoot(generation:number,root:string){
  const row=this.prepared.query('SELECT session_id,event_sequence,created_at FROM presentation_messages WHERE generation=? AND root_input_id=? ORDER BY event_sequence DESC LIMIT 1')
   .get(generation,root) as {session_id:number;event_sequence:number;created_at:string}|null;
  if(!row){this.prepared.query('DELETE FROM presentation_topic_roots WHERE generation=? AND root_id=?').run(generation,root);return;}
  const topic=this.source.query('SELECT topic_id FROM inbox_topic_roots WHERE root_input_id=?').get(root) as {topic_id:string}|null;
  const input=this.source.query('SELECT payload_json FROM session_inputs WHERE id=?').get(root) as {payload_json:string}|null;
  const payload=input?JSON.parse(input.payload_json):{},body=payload.firstInput??payload;
  let text=typeof body.text==='string'?body.text:'';
  if(body.capture?.source?.kind==='thinkering'&&text.startsWith('Thinkering bug report\n')&&text.includes('\nDescription:\n')){
   const diagnostics=text.indexOf('\nComplete diagnostics JSON');if(diagnostics>=0)text=text.slice(0,diagnostics).trimEnd();
  }
  this.prepared.query(`INSERT INTO presentation_topic_roots VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(generation,root_id)
   DO UPDATE SET topic_id=excluded.topic_id,session_id=excluded.session_id,sequence=excluded.sequence,at=excluded.at,text=excluded.text,unfiled=excluded.unfiled`)
   .run(generation,root,topic?.topic_id??null,row.session_id,row.event_sequence,row.created_at.includes('T')?row.created_at:row.created_at.replace(' ','T')+'Z',text.trim().slice(0,120),topic?0:1);
 }
 updateSorting(context:TopicContext){
  const row=this.source.query('SELECT native_metadata_json FROM sessions WHERE id=?').get(context.sessionId) as {native_metadata_json:string};
  const needs=JSON.parse(row.native_metadata_json||'{}').needs??[];
  const attention=needs.filter((need:any)=>!this.source.query('SELECT 1 FROM inbox_questions WHERE legacy_need_event_id=? LIMIT 1').get(need.eventId))
   .map((need:any)=>{const root=context.root(context.sessionId,need.inputId)??need.inputId;
    const topic=this.source.query('SELECT t.topic_id,t.title FROM inbox_topic_roots r JOIN inbox_topics t ON t.topic_id=r.topic_id WHERE r.root_input_id=?').get(root) as any;
    return {eventId:need.eventId,inputId:need.inputId,kind:need.outcome==='response'?'reading':'decision',outcome:need.outcome??'needs_you',
     text:need.question,at:need.at,generation:need.generation,startedFrom:topic?{id:topic.topic_id,title:topic.title}:null};});
  // Large attention is available through exact chunks; the first response never hydrates it all.
  const value=Buffer.byteLength(json(attention))<=4096?attention:{count:attention.length,detailRef:this.retain(attention)};
  this.prepared.query('INSERT INTO presentation_topic_sorting(generation,attention_json) VALUES(?,?) ON CONFLICT(generation) DO UPDATE SET attention_json=excluded.attention_json')
   .run(context.generation,json(value));
 }
 rebuildPage(generation:number,sessionId:number,after='',limit=20){
  const rows=this.source.query('SELECT topic_id FROM inbox_topics WHERE session_id=? AND topic_id>? ORDER BY topic_id LIMIT ?')
   .all(sessionId,after,limit+1) as {topic_id:string}[];
  const context=this.context(generation,sessionId);
  for(const row of rows.slice(0,limit))this.write(context,row.topic_id);
  return {lastId:rows[Math.min(limit,rows.length)-1]?.topic_id??after,hasMore:rows.length>limit};
 }
 write(context:TopicContext,topicId:string){
  const value=preparedTopicValue(context,topicId),generation=context.generation;
  const previous=this.prepared.query('SELECT summary_json,detail_hash FROM presentation_topics WHERE generation=? AND topic_id=?')
   .get(generation,topicId) as {summary_json:string;detail_hash:string}|null;
  this.prepared.query('DELETE FROM presentation_topic_questions WHERE generation=? AND topic_id=?').run(generation,topicId);
  if(!value){this.prepared.query('DELETE FROM presentation_topics WHERE generation=? AND topic_id=?').run(generation,topicId);
   if(previous)this.prepared.query('INSERT INTO presentation_topic_changes(generation,topic_id,before_json,after_json) VALUES(?,?,?,NULL)').run(generation,topicId,previous.summary_json);
   return;}
  const ref=this.retain(value.detail);
  const summary=this.compact(value.summary,ref);
  this.prepared.query(`INSERT INTO presentation_topics VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(generation,topic_id) DO UPDATE SET session_id=excluded.session_id,state=excluded.state,
    background=excluded.background,band=excluded.band,recency=excluded.recency,closed_recency=excluded.closed_recency,
    summary_json=excluded.summary_json,detail_hash=excluded.detail_hash,search_text=excluded.search_text,sort_key=excluded.sort_key,closed_sort_key=excluded.closed_sort_key`)
   .run(generation,topicId,value.sessionId,value.summary.state,
    value.summary.state==='open'&&!value.summary.needsYou.count&&value.summary.work.kind!=='idle'?1:0,
    value.band,value.summary.lastEntryAt,value.summary.closedAt??value.summary.lastEntryAt,json(summary),ref.hash,value.search,orderKey(value.band,value.summary.lastEntryAt,topicId),
    orderKey(0,value.summary.closedAt??value.summary.lastEntryAt,topicId));
  if(previous?.summary_json!==json(summary)||previous?.detail_hash!==ref.hash)
   this.prepared.query('INSERT INTO presentation_topic_changes(generation,topic_id,before_json,after_json) VALUES(?,?,?,?)')
    .run(generation,topicId,previous?.summary_json??null,json(summary));
  for(const question of value.detail.questions)for(const selected of ['open','reading','checking','deferred','history'])if(questionSet(question,selected)){
   const questionRef=this.retain(question);
   const compact=json(question).length<=4096?question:{id:question.id,topicId,revision:question.revision,state:question.state,
    kind:question.kind,waiting:question.waiting,readiness:question.readiness,brief:{decision:preview(question.brief?.decision??'')},
    createdAt:question.createdAt,updatedAt:question.updatedAt,detailRef:questionRef,coverage:{complete:false,code:'question_preview'}};
   this.prepared.query('INSERT INTO presentation_topic_questions VALUES(?,?,?,?,?,?)')
    .run(generation,topicId,question.id,selected,question.createdAt,json(compact));
  }
 }
 activate(generation:number,sourceHead:number){this.prepared.query('UPDATE presentation_topics_meta SET generation=?,source_head=?,ready=1 WHERE singleton=1').run(generation,sourceHead);}
 checkpoint(generation:number,sourceHead:number){this.prepared.query('UPDATE presentation_topics_meta SET source_head=? WHERE singleton=1 AND generation=?').run(sourceHead,generation);}
 private retain(value:unknown){
  const text=json(value),hash=createHash('sha256').update(text).digest('hex');
  const pieces:string[]=[];let part='',bytes=0;
  for(const char of text){const size=Buffer.byteLength(char);if(bytes+size>CHUNK_BYTES){pieces.push(part);part='';bytes=0;}part+=char;bytes+=size;}
  if(part)pieces.push(part);
  for(let i=0;i<pieces.length;i++)this.prepared.query('INSERT OR IGNORE INTO presentation_topic_chunks VALUES(?,?,?,?)').run(hash,i,pieces[i],pieces.length);
  return {hash,chunks:pieces.length,bytes:Buffer.byteLength(text)};
 }
 private compact(summary:any,detailRef:unknown){
  if(Buffer.byteLength(json(summary))<=4096)return {...summary,detailRef};
  return {...summary,title:preview(summary.title),summary:preview(summary.summary??''),aliases:[],roots:[],
   needsYou:{...summary.needsYou,items:[]},toRead:{...summary.toRead,items:[]},
   work:{...summary.work,text:preview(summary.work.text)},setAside:summary.setAside?{...summary.setAside,reason:preview(summary.setAside.reason??'')}:null,
   detailRef,coverage:{complete:false,code:'topic_preview'}};
 }
}

function meta(db:Database){return db.query('SELECT generation,source_head,ready FROM presentation_topics_meta WHERE singleton=1').get() as Meta;}
function coverage(current:Meta,head:number){return {complete:!!current.ready&&current.source_head>=head,
 code:!current.ready||current.source_head<head?'presentation_indexing':null,appliedSequence:current.source_head};}
function reset(current:Meta){return {topics:[],nextCursor:null,coverage:{complete:false,code:'reset_required',appliedSequence:current.source_head}};}

export function readPreparedTopics(db:Database,options:{state?:State;cursor?:string|null;limit?:number;canonicalHead:number}){
 const current=meta(db),state=options.state??'open',limit=Math.min(PAGE,Math.max(1,options.limit??PAGE));
 if(!['open','closed','background','all'].includes(state))throw new Error('Unknown topic state filter');
 const old=options.cursor?decode(options.cursor):null;
 if(options.cursor&&(!old||old.g!==current.generation||old.state!==state||typeof old.key!=='string'))return reset(current);
 const key=state==='closed'?'closed_sort_key':'sort_key';
 const condition=state==='all'?'1=1':state==='background'?'background=1':`state='${state}'`;
 const rows=db.query(`SELECT ${key} AS key,summary_json FROM presentation_topics
  WHERE generation=? AND ${condition} ${old?`AND ${key}>?`:''} ORDER BY ${key} LIMIT ?`)
  .all(current.generation,...(old?[old.key]:[]),limit+1) as {key:string;summary_json:string}[];
 const page=rows.slice(0,limit),last=page.at(-1);
 const sortingRow=db.query('SELECT count,attention_json FROM presentation_topic_sorting WHERE generation=?').get(current.generation) as {count:number;attention_json:string}|null;
 const captures=db.query('SELECT root_id AS inputId,text,at FROM presentation_topic_roots WHERE generation=? AND unfiled=1 ORDER BY sequence DESC,root_id LIMIT 5').all(current.generation);
 const changeHead=(db.query('SELECT COALESCE(MAX(sequence),0) AS n FROM presentation_topic_changes WHERE generation=?').get(current.generation) as {n:number}).n;
 return {topics:page.map(row=>JSON.parse(row.summary_json)),sorting:{count:sortingRow?.count??0,captures,attention:JSON.parse(sortingRow?.attention_json??'[]')},asOf:cursor({g:current.generation,sequence:changeHead}),nextCursor:rows.length>limit&&last?
  cursor({g:current.generation,state,key:last.key}):null,
  coverage:coverage(current,options.canonicalHead)};
}
export function readPreparedTopicChanges(db:Database,after:string,canonicalHead:number,limit=20){
 const current=meta(db),old=decode(after);
 if(!old||old.g!==current.generation||!Number.isSafeInteger(old.sequence)||old.sequence<0)return {...reset(current),changes:[]};
 const rows=db.query('SELECT sequence,topic_id,before_json,after_json FROM presentation_topic_changes WHERE generation=? AND sequence>? ORDER BY sequence LIMIT ?')
  .all(current.generation,old.sequence,Math.min(PAGE,Math.max(1,limit))+1) as any[];
 const page=rows.slice(0,Math.min(PAGE,Math.max(1,limit))),next=cursor({g:current.generation,sequence:page.at(-1)?.sequence??old.sequence});
 return {changes:page.map(row=>({revision:row.sequence,topicId:row.topic_id,before:row.before_json?JSON.parse(row.before_json):null,
  after:row.after_json?JSON.parse(row.after_json):null})),asOf:next,nextCursor:rows.length>page.length?next:null,coverage:coverage(current,canonicalHead)};
}
export function readPreparedTopic(db:Database,topicId:string,canonicalHead:number){
 const current=meta(db);
 const row=db.query('SELECT summary_json,detail_hash FROM presentation_topics WHERE generation=? AND topic_id=?')
  .get(current.generation,topicId) as {summary_json:string;detail_hash:string}|null;
 return {topic:row?JSON.parse(row.summary_json):null,detailRef:row?{hash:row.detail_hash}:null,coverage:coverage(current,canonicalHead)};
}
export function readPreparedTopicChunk(db:Database,hash:string,chunk:number){
 if(!/^[a-f0-9]{64}$/.test(hash)||!Number.isSafeInteger(chunk)||chunk<0)throw new Error('Invalid topic detail reference');
 return db.query('SELECT text,count FROM presentation_topic_chunks WHERE hash=? AND chunk=?').get(hash,chunk) as {text:string;count:number}|null;
}
export function readPreparedQuestions(db:Database,options:{state:string;cursor?:string|null;limit?:number;canonicalHead:number}){
 const current=meta(db),selected=options.state,limit=Math.min(PAGE,Math.max(1,options.limit??PAGE));
 if(!['open','reading','checking','deferred','history'].includes(selected))throw new Error('Unknown question filter');
 const old=options.cursor?decode(options.cursor):null;
 if(options.cursor&&(!old||old.g!==current.generation||old.state!==selected||typeof old.at!=='string'||typeof old.id!=='string'))return reset(current);
 const rows=db.query(`SELECT topic_id,question_id,created_at,value_json FROM presentation_topic_questions
  WHERE generation=? AND selected=? ${old?'AND (created_at<? OR (created_at=? AND question_id>?))':''}
  ORDER BY created_at DESC,question_id LIMIT ?`).all(current.generation,selected,...(old?[old.at,old.at,old.id]:[]),limit+1) as any[];
 const page=rows.slice(0,limit),last=page.at(-1);
 return {questions:page.map(row=>JSON.parse(row.value_json)),nextCursor:rows.length>limit&&last?
  cursor({g:current.generation,state:selected,at:last.created_at,id:last.question_id}):null,coverage:coverage(current,options.canonicalHead)};
}
