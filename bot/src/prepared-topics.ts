import type {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';
import {preparedTopicValue,topicContext,type TopicContext} from './prepared-topic-values';
import {inboxRootResolver} from './presentation-message-source';
import {gram,shortTokens} from './prepared-search';
import {topicEventDisplay} from './topic-event-display';

const PAGE=20,CHUNK_BYTES=16*1024;
type State='open'|'closed'|'background'|'all';
const orderKey=(band:number,at:string,id:string)=>`${band}:${String(9999999999999-Date.parse(at)).padStart(13,'0')}:${id}`;
type Meta={generation:number;source_head:number;ready:number;retained_after:number;inbox_session:number};
const json=(value:unknown)=>JSON.stringify(value);
const cursor=(value:unknown)=>Buffer.from(json(value)).toString('base64url');
const decode=(value:string)=>{try{return JSON.parse(Buffer.from(value,'base64url').toString());}catch{return null;}};
const preview=(text:string,size=240)=>{let result='',count=0;for(const character of text){if(count++===size)break;result+=character;}return result;};
const questionSet=(q:any,state:string)=>state==='open'?q.waiting&&q.kind==='decision'
 :state==='reading'?q.waiting&&q.kind==='reading':state==='checking'?q.readiness==='preparing'&&['open','partial'].includes(q.state)&&q.kind==='decision'
 :state==='deferred'?q.state==='deferred':['answered','declined','withdrawn','superseded','read','expired'].includes(q.state);

/** This derived store owns no canonical mutations. The worker supplies a read-only source.
 * Complete values are retained as immutable chunks, so a large reading item cannot turn a
 * list query into a large response or silently lose its text. */
export class PreparedTopics {
 private retainedBy:{generation:number;owner:string}|null=null;
 private collectAfter='';
 constructor(private source:Database,private prepared:Database){
  const columns=prepared.query('PRAGMA table_info(presentation_topics_meta)').all() as {name:string}[];
  if(columns.length&&!columns.some(column=>column.name==='own_items_only')){
   // These are disposable projections, never source ledger tables or message indexes.
   for(const table of ['presentation_topic_search','presentation_topic_short','presentation_topics_meta','presentation_topics',
    'presentation_topic_roots','presentation_topic_sorting','presentation_topic_chunks','presentation_topic_changes',
    'presentation_topic_questions','presentation_topic_items','presentation_topic_dependencies','presentation_topic_dirty',
    'presentation_topic_sorting_dirty','presentation_topic_request_links','presentation_question_counts',
    'presentation_topic_event_display','presentation_inbox_attention','presentation_inbox_attention_counts','presentation_topic_chunk_refs','presentation_topic_blobs'])prepared.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  prepared.exec(`CREATE TABLE IF NOT EXISTS presentation_topics_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),
   generation INTEGER NOT NULL DEFAULT 0,source_head INTEGER NOT NULL DEFAULT 0,ready INTEGER NOT NULL DEFAULT 0,retained_after INTEGER NOT NULL DEFAULT 0,inbox_session INTEGER NOT NULL DEFAULT 0,own_items_only INTEGER NOT NULL DEFAULT 1);
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
    search_text TEXT NOT NULL,sort_key TEXT NOT NULL,closed_sort_key TEXT NOT NULL,reply_targets_json TEXT NOT NULL,overview_json TEXT NOT NULL,PRIMARY KEY(generation,topic_id));
   CREATE INDEX IF NOT EXISTS presentation_topics_open ON presentation_topics(generation,session_id,state,sort_key);
   CREATE INDEX IF NOT EXISTS presentation_topics_all ON presentation_topics(generation,session_id,sort_key);
   CREATE INDEX IF NOT EXISTS presentation_topics_closed ON presentation_topics(generation,session_id,state,closed_sort_key);
   CREATE INDEX IF NOT EXISTS presentation_topics_background ON presentation_topics(generation,session_id,background,sort_key);
   CREATE TABLE IF NOT EXISTS presentation_topic_chunks(hash TEXT NOT NULL,chunk INTEGER NOT NULL,text TEXT NOT NULL,
    count INTEGER NOT NULL,PRIMARY KEY(hash,chunk));
   CREATE TABLE IF NOT EXISTS presentation_topic_blobs(hash TEXT PRIMARY KEY);
   CREATE TABLE IF NOT EXISTS presentation_topic_chunk_refs(generation INTEGER NOT NULL,owner TEXT NOT NULL,hash TEXT NOT NULL,
    PRIMARY KEY(generation,owner,hash));
   CREATE INDEX IF NOT EXISTS presentation_topic_chunk_ref_hash ON presentation_topic_chunk_refs(hash);
   CREATE TABLE IF NOT EXISTS presentation_topic_changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT,generation INTEGER NOT NULL,
    topic_id TEXT NOT NULL,before_json TEXT,after_json TEXT,created_ms INTEGER NOT NULL DEFAULT(unixepoch()*1000));
   CREATE INDEX IF NOT EXISTS presentation_topic_changes_page ON presentation_topic_changes(generation,sequence);
   CREATE VIRTUAL TABLE IF NOT EXISTS presentation_topic_search USING fts5(text,tokenize='trigram');
   CREATE VIRTUAL TABLE IF NOT EXISTS presentation_topic_short USING fts5(tokens,detail=none);
   CREATE TABLE IF NOT EXISTS presentation_topic_questions(generation INTEGER NOT NULL,topic_id TEXT NOT NULL,
    question_id TEXT NOT NULL,selected TEXT NOT NULL,created_at TEXT NOT NULL,value_json TEXT NOT NULL,
    sort_key TEXT NOT NULL,session_id INTEGER NOT NULL,
    PRIMARY KEY(generation,selected,topic_id,question_id));
   CREATE INDEX IF NOT EXISTS presentation_topic_question_page ON presentation_topic_questions(generation,session_id,selected,sort_key);
   CREATE TABLE IF NOT EXISTS presentation_question_counts(generation INTEGER NOT NULL,session_id INTEGER NOT NULL,selected TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(generation,session_id,selected));
   CREATE TRIGGER IF NOT EXISTS presentation_question_count_add AFTER INSERT ON presentation_topic_questions BEGIN
    INSERT INTO presentation_question_counts VALUES(new.generation,new.session_id,new.selected,1) ON CONFLICT(generation,session_id,selected) DO UPDATE SET count=count+1; END;
   CREATE TRIGGER IF NOT EXISTS presentation_question_count_remove AFTER DELETE ON presentation_topic_questions BEGIN
    UPDATE presentation_question_counts SET count=count-1 WHERE generation=old.generation AND session_id=old.session_id AND selected=old.selected; END;`);
  prepared.exec(`CREATE TABLE IF NOT EXISTS presentation_topic_items(generation INTEGER NOT NULL,topic_id TEXT NOT NULL,
   kind TEXT NOT NULL,item_id TEXT NOT NULL,sort_key TEXT NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(generation,topic_id,kind,item_id));
   CREATE INDEX IF NOT EXISTS presentation_topic_item_page ON presentation_topic_items(generation,topic_id,kind,sort_key);
   CREATE TABLE IF NOT EXISTS presentation_topic_dependencies(generation INTEGER NOT NULL,kind TEXT NOT NULL,dependency TEXT NOT NULL,topic_id TEXT NOT NULL,
    PRIMARY KEY(generation,kind,dependency,topic_id));
   CREATE INDEX IF NOT EXISTS presentation_topic_dependencies_topic ON presentation_topic_dependencies(generation,topic_id);
   CREATE TABLE IF NOT EXISTS presentation_topic_dirty(generation INTEGER NOT NULL,topic_id TEXT NOT NULL,PRIMARY KEY(generation,topic_id));`);
  prepared.exec('CREATE TABLE IF NOT EXISTS presentation_topic_sorting_dirty(generation INTEGER NOT NULL,session_id INTEGER NOT NULL,PRIMARY KEY(generation,session_id))');
  prepared.exec(`CREATE INDEX IF NOT EXISTS presentation_topic_question_topic_page ON presentation_topic_questions(generation,topic_id,selected,created_at DESC,question_id);
   CREATE TABLE IF NOT EXISTS presentation_topic_request_links(generation INTEGER NOT NULL,topic_id TEXT NOT NULL,input_id TEXT NOT NULL,request_id TEXT NOT NULL,
    PRIMARY KEY(generation,topic_id,input_id,request_id));`);
  prepared.exec('CREATE TABLE IF NOT EXISTS presentation_topic_event_display(generation INTEGER NOT NULL,event_sequence INTEGER NOT NULL,display_json TEXT NOT NULL,PRIMARY KEY(generation,event_sequence))');
  prepared.exec(`CREATE TABLE IF NOT EXISTS presentation_inbox_attention(generation INTEGER NOT NULL,scope TEXT NOT NULL,event_id TEXT NOT NULL,
   topic_id TEXT,need_generation INTEGER NOT NULL,order_key TEXT NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(generation,scope,event_id));
   CREATE INDEX IF NOT EXISTS presentation_inbox_attention_page ON presentation_inbox_attention(generation,scope,order_key);
   CREATE INDEX IF NOT EXISTS presentation_inbox_attention_max ON presentation_inbox_attention(generation,scope,need_generation DESC);
   CREATE INDEX IF NOT EXISTS presentation_inbox_attention_topic ON presentation_inbox_attention(generation,topic_id);
   CREATE TABLE IF NOT EXISTS presentation_inbox_attention_counts(generation INTEGER NOT NULL,scope TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(generation,scope));
   CREATE TRIGGER IF NOT EXISTS presentation_inbox_attention_added AFTER INSERT ON presentation_inbox_attention BEGIN
    INSERT INTO presentation_inbox_attention_counts VALUES(new.generation,new.scope,1) ON CONFLICT(generation,scope) DO UPDATE SET count=count+1; END;
   CREATE TRIGGER IF NOT EXISTS presentation_inbox_attention_removed AFTER DELETE ON presentation_inbox_attention BEGIN
    UPDATE presentation_inbox_attention_counts SET count=count-1 WHERE generation=old.generation AND scope=old.scope; END;`);
 }
 isReady(generation:number){const current=meta(this.prepared);return !!current.ready&&current.generation===generation;}
 writeEvent(generation:number,sequence:number){
  const value=topicEventDisplay(this.source,sequence);if(!value)return;
  this.retainedBy={generation,owner:`event:${sequence}`};
  this.prepared.query('DELETE FROM presentation_topic_chunk_refs WHERE generation=? AND owner=?').run(generation,this.retainedBy.owner);
  const display=Buffer.byteLength(json(value))<=4096?value:{...value,content:preview(value.content,800),
   topicEvent:{change:value.topicEvent.change,by:null,reason:preview(value.topicEvent.reason??'',400),revision:value.topicEvent.revision},
   detailRef:this.retain(value),contentCoverage:{complete:false,code:'topic_event_preview'}};
  this.prepared.query('INSERT OR REPLACE INTO presentation_topic_event_display VALUES(?,?,?)').run(generation,sequence,json(display));
 }
 beginRebuild(generation:number){
  for(const table of ['presentation_topic_search','presentation_topic_short'])this.prepared.query(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM presentation_topics WHERE generation=?)`).run(generation);
  for(const table of ['presentation_topics','presentation_topic_questions','presentation_topic_items','presentation_topic_dependencies','presentation_topic_dirty',
   'presentation_topic_request_links','presentation_topic_sorting_dirty','presentation_topic_event_display','presentation_question_counts'])this.prepared.query(`DELETE FROM ${table} WHERE generation=?`).run(generation);
  this.prepared.query('DELETE FROM presentation_topic_roots WHERE generation=?').run(generation);
  this.prepared.query('DELETE FROM presentation_topic_chunk_refs WHERE generation=?').run(generation);
  this.prepared.query('DELETE FROM presentation_inbox_attention WHERE generation=?').run(generation);
 }
 private inboxSession(){return (this.source.query("SELECT id FROM sessions WHERE json_extract(native_metadata_json,'$.inbox')=1 ORDER BY id DESC LIMIT 1").get() as {id:number}|null)?.id??0;}
 context(generation:number,sessionId:number){return {...topicContext(this.source,this.prepared,generation,this.inboxSession()||sessionId),requestedSessionId:sessionId};}
 rebuildRootsPage(generation:number,after='',limit=100){
  const rows=this.prepared.query('SELECT root_input_id AS root FROM presentation_messages WHERE generation=? AND root_input_id>? GROUP BY root_input_id ORDER BY root_input_id LIMIT ?')
   .all(generation,after,limit+1) as {root:string}[];
  for(const row of rows.slice(0,limit))this.updateRoot(generation,row.root);
  return {lastRoot:rows[Math.min(limit,rows.length)-1]?.root??after,hasMore:rows.length>limit};
 }
 /** Enqueue reverse dependencies. A token in an unrelated session names no topic and costs no topic rebuild. */
 apply(generation:number,changes:readonly {source_table:string;row_key:string;session_id:number|null;topic_id?:string|null;input_id?:string|null;request_id?:string|null}[],changedRoots:Iterable<string>){
  const mark=(topic:string)=>this.prepared.query('INSERT OR IGNORE INTO presentation_topic_dirty VALUES(?,?)').run(generation,topic);
  const depend=(kind:string,key:string)=>this.prepared.query(`INSERT OR IGNORE INTO presentation_topic_dirty
   SELECT generation,topic_id FROM presentation_topic_dependencies WHERE generation=? AND kind=? AND dependency=?`).run(generation,kind,key);
  const roots=new Set(changedRoots),resolveRoot=inboxRootResolver(this.source);
  for(const change of changes){
   if(change.topic_id)mark(change.topic_id);
   if(change.request_id)depend('request',change.request_id);
   if(['sessions','turns'].includes(change.source_table)&&change.session_id)depend('session',`concierge:${change.session_id}`);
   if(change.source_table==='session_peer_catalogue')depend('session',change.row_key.replace(':concierge:',':'));
   const inbox=change.session_id?this.source.query("SELECT 1 FROM sessions WHERE id=? AND json_extract(native_metadata_json,'$.inbox')=1").get(change.session_id):null;
   if(!inbox)continue;
   this.prepared.query('INSERT OR IGNORE INTO presentation_topic_sorting_dirty VALUES(?,?)').run(generation,change.session_id);
   if(['session_inputs','turns','inbox_focus'].includes(change.source_table))depend('inbox-work',String(change.session_id));
   if(change.source_table==='sessions'&&this.inboxSession()!==meta(this.prepared).inbox_session)
    this.prepared.query('INSERT OR IGNORE INTO presentation_topic_dirty SELECT generation,topic_id FROM presentation_topics WHERE generation=?').run(generation);
   if(change.input_id){const root=resolveRoot(change.session_id!,change.input_id);if(root)roots.add(root);}
  }
  for(const root of roots){
   depend('root',root);
   const topic=this.source.query('SELECT topic_id FROM inbox_topic_roots WHERE root_input_id=?').get(root) as {topic_id:string}|null;
   if(topic)mark(topic.topic_id);
   this.updateRoot(generation,root);
  }
 }
 /** Each call is finite; caller yields between calls and checkpoints only after hasMore=false. */
 drain(generation:number,limit=20){
  const rows=this.prepared.query('SELECT topic_id FROM presentation_topic_dirty WHERE generation=? ORDER BY topic_id LIMIT ?').all(generation,Math.min(20,limit)+1) as {topic_id:string}[];
  const contexts=new Map<number,TopicContext>();
  for(const row of rows.slice(0,Math.min(20,limit))){
   const topic=this.source.query('SELECT session_id FROM inbox_topics WHERE topic_id=?').get(row.topic_id) as {session_id:number}|null;
   const previous=topic??this.prepared.query('SELECT session_id FROM presentation_topics WHERE generation=? AND topic_id=?').get(generation,row.topic_id) as {session_id:number}|null;
   if(previous){let context=contexts.get(previous.session_id);if(!context){context=this.context(generation,previous.session_id);contexts.set(previous.session_id,context);}this.write(context,row.topic_id);}
   this.prepared.query('DELETE FROM presentation_topic_dirty WHERE generation=? AND topic_id=?').run(generation,row.topic_id);
  }
  for(const context of contexts.values())this.updateSorting(context);
  const sorting=this.prepared.query('SELECT session_id FROM presentation_topic_sorting_dirty WHERE generation=? LIMIT 20').all(generation) as {session_id:number}[];
  for(const row of sorting){if(!contexts.has(row.session_id))this.updateSorting(this.context(generation,row.session_id));
   this.prepared.query('DELETE FROM presentation_topic_sorting_dirty WHERE generation=? AND session_id=?').run(generation,row.session_id);}
  return {hasMore:rows.length>Math.min(20,limit)||sorting.length===20};
 }
 updateRoot(generation:number,root:string){
  const row=this.prepared.query('SELECT session_id,event_sequence,created_at FROM presentation_messages WHERE generation=? AND root_input_id=? ORDER BY event_sequence DESC LIMIT 1')
   .get(generation,root) as {session_id:number;event_sequence:number;created_at:string}|null;
  if(!row){this.prepared.query('DELETE FROM presentation_topic_roots WHERE generation=? AND root_id=?').run(generation,root);return;}
  const topic=this.source.query('SELECT topic_id FROM inbox_topic_roots WHERE root_input_id=?').get(root) as {topic_id:string}|null;
  const input=this.source.query('SELECT payload_json,origin FROM session_inputs WHERE id=?').get(root) as {payload_json:string;origin:string}|null;
  // Only what he sent himself waits to be filed. Agents' requests to the router showed in his Inbox
  // as raw "Session request … agent-authored input" rows, marked Being sorted forever (2026-10-08).
  const his=input?.origin==='human'&&!this.source.query('SELECT 1 FROM session_input_author_corrections WHERE input_id=?').get(root);
  const payload=input?JSON.parse(input.payload_json):{},body=payload.firstInput??payload;
  let text=typeof body.text==='string'?body.text:'';
  if(body.capture?.source?.kind==='thinkering'&&text.startsWith('Thinkering bug report\n')&&text.includes('\nDescription:\n')){
   const diagnostics=text.indexOf('\nComplete diagnostics JSON');if(diagnostics>=0)text=text.slice(0,diagnostics).trimEnd();
  }
  this.prepared.query(`INSERT INTO presentation_topic_roots VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(generation,root_id)
   DO UPDATE SET topic_id=excluded.topic_id,session_id=excluded.session_id,sequence=excluded.sequence,at=excluded.at,text=excluded.text,unfiled=excluded.unfiled`)
   .run(generation,root,topic?.topic_id??null,row.session_id,row.event_sequence,row.created_at.includes('T')?row.created_at:row.created_at.replace(' ','T')+'Z',text.trim().slice(0,120),topic||!his?0:1);
 }
 updateSorting(context:TopicContext){
  const sessionId=context.requestedSessionId??context.sessionId;
  this.retainedBy={generation:context.generation,owner:`sorting:${sessionId}`};
  this.prepared.query('DELETE FROM presentation_topic_chunk_refs WHERE generation=? AND owner=?').run(context.generation,this.retainedBy.owner);
  const row=this.source.query('SELECT native_metadata_json FROM sessions WHERE id=?').get(sessionId) as {native_metadata_json:string};
  const needs=JSON.parse(row.native_metadata_json||'{}').needs??[];
  this.prepared.query('DELETE FROM presentation_inbox_attention WHERE generation=? AND scope=?').run(context.generation,`unfiled:${sessionId}`);
  for(const need of needs)if(!this.source.query('SELECT 1 FROM inbox_questions WHERE legacy_need_event_id=? LIMIT 1').get(need.eventId))
   this.writeAttention(context.generation,`unfiled:${sessionId}`,null,need);
  if(sessionId!==this.inboxSession())return;
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
  const generation=context.generation;
  const owner=(this.source.query('SELECT session_id FROM inbox_topics WHERE topic_id=?').get(topicId) as {session_id:number}|null)?.session_id??context.sessionId;
  this.retainedBy={generation,owner:`topic:${topicId}`};
  this.prepared.query('DELETE FROM presentation_topic_chunk_refs WHERE generation=? AND owner=?').run(generation,this.retainedBy.owner);
  const previous=this.prepared.query('SELECT summary_json,detail_hash,session_id FROM presentation_topics WHERE generation=? AND topic_id=?')
   .get(generation,topicId) as {summary_json:string;detail_hash:string;session_id:number}|null;
  this.prepared.query('DELETE FROM presentation_topic_questions WHERE generation=? AND topic_id=?').run(generation,topicId);
  this.prepared.query('DELETE FROM presentation_topic_items WHERE generation=? AND topic_id=?').run(generation,topicId);
  this.prepared.query('DELETE FROM presentation_topic_dependencies WHERE generation=? AND topic_id=?').run(generation,topicId);
  this.prepared.query('DELETE FROM presentation_topic_request_links WHERE generation=? AND topic_id=?').run(generation,topicId);
  this.prepared.query('DELETE FROM presentation_inbox_attention WHERE generation=? AND topic_id=?').run(generation,topicId);
  const depend=(kind:string,key:string)=>this.prepared.query('INSERT OR IGNORE INTO presentation_topic_dependencies VALUES(?,?,?,?)').run(generation,kind,key,topicId);
  const itemDigest=createHash('sha256');
  const writeItem=(item:any,kind:string,index?:number)=>{
   const id=String(item.id??index),key=kind==='history'?String(index).padStart(8,'0'):`${item.createdAt}:${id}`;
   const compact=this.compactItem(item,kind);itemDigest.update(json(item));
   this.prepared.query('INSERT INTO presentation_topic_items VALUES(?,?,?,?,?,?)').run(generation,topicId,kind,id,key,json(compact));
   return compact;
  };
  const value=preparedTopicValue({...context,boundedReads:true},topicId,{
   question:question=>{
    const compact=writeItem(question,'questions');
    if(question.owner?.sessionId)depend('session',question.owner.sessionId);
    if(question.waiting)this.writeAttention(generation,'questions',topicId,{inputId:question.sources[0]??topicId,
     outcome:question.kind==='reading'?'response':'needs_you',question:question.brief?.decision??'',generation:question.generation??0,
     at:question.createdAt,runId:question.owner?.runId??'',eventId:question.id,...(question.reads.length?{reads:question.reads}:{})});
    for(const selected of ['open','reading','checking','deferred','history'])if(questionSet(question,selected))
     this.prepared.query('INSERT INTO presentation_topic_questions VALUES(?,?,?,?,?,?,?,?)')
      .run(generation,topicId,question.id,selected,question.createdAt,json(compact),orderKey(0,question.createdAt,question.id),owner);
   },
   request:request=>{
    writeItem(request,'requests');
    for(const dispatch of request.dispatches){
     depend('request',String(dispatch.requestId));
     if(dispatch.targetSessionId)depend('session',dispatch.targetSessionId.replace(/^([\w-]+):concierge:/,'$1:'));
     if(dispatch.sourceInputId)this.prepared.query('INSERT OR IGNORE INTO presentation_topic_request_links VALUES(?,?,?,?)').run(generation,topicId,dispatch.sourceInputId,request.id);
    }
    for(const source of request.sources)if(source.inputId)this.prepared.query('INSERT OR IGNORE INTO presentation_topic_request_links VALUES(?,?,?,?)').run(generation,topicId,source.inputId,request.id);
   }
  });
  if(!value){
   for(const table of ['presentation_topic_search','presentation_topic_short'])this.prepared.query(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM presentation_topics WHERE generation=? AND topic_id=?)`).run(generation,topicId);
   this.prepared.query('DELETE FROM presentation_topics WHERE generation=? AND topic_id=?').run(generation,topicId);
   if(previous&&previous.session_id===context.sessionId)this.prepared.query('INSERT INTO presentation_topic_changes(generation,topic_id,before_json,after_json) VALUES(?,?,?,NULL)').run(generation,topicId,previous.summary_json);
   return;}
  value.detail.topic.history.forEach((item,index)=>writeItem(item,'history',index));
  const ref=this.retain({...value.detail,collections:'paged',itemsRevision:itemDigest.digest('hex')});
  const summary=this.compact(value.summary,ref);
  const replyTargets=Buffer.byteLength(json(value.detail.replyTargets))<=4096?value.detail.replyTargets:
   {router:value.detail.replyTargets.router,default:value.detail.replyTargets.default,choices:[],detailRef:this.retain(value.detail.replyTargets),coverage:{complete:false,code:'reply_targets_preview'}};
  const focus=value.detail.focus&&Buffer.byteLength(json(value.detail.focus))>2048?
   {topicId,runId:value.detail.focus.runId,summary:preview(value.detail.focus.summary??''),detailRef:this.retain(value.detail.focus)}:value.detail.focus;
  const questionCounts=value.questionCounts;
  const overview={topic:summary,work:summary.work,focus,replyTargets,questionCounts,requestCount:value.requestCount};
   this.prepared.query(`INSERT INTO presentation_topics VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(generation,topic_id) DO UPDATE SET session_id=excluded.session_id,state=excluded.state,
    background=excluded.background,band=excluded.band,recency=excluded.recency,closed_recency=excluded.closed_recency,
    summary_json=excluded.summary_json,detail_hash=excluded.detail_hash,search_text=excluded.search_text,sort_key=excluded.sort_key,closed_sort_key=excluded.closed_sort_key,reply_targets_json=excluded.reply_targets_json,overview_json=excluded.overview_json`)
   .run(generation,topicId,owner,value.summary.state,
    value.summary.state==='open'&&!value.summary.needsYou.count&&value.summary.work.kind!=='idle'?1:0,
    value.band,value.summary.lastEntryAt,value.summary.closedAt??value.summary.lastEntryAt,json(summary),ref.hash,value.search,orderKey(value.band,value.summary.lastEntryAt,topicId),
    orderKey(0,value.summary.closedAt??value.summary.lastEntryAt,topicId),
    json(replyTargets),json(overview));
  for(const root of value.summary.roots)depend('root',root);
  if(['router_working','router_queued'].includes(value.summary.work.kind))depend('inbox-work',String(value.sessionId));
  for(const target of value.detail.replyTargets.choices)depend('session',target.sessionId);
  if('sessionId' in value.summary.work&&value.summary.work.sessionId)depend('session',value.summary.work.sessionId);
  const searchId=(this.prepared.query('SELECT rowid AS id FROM presentation_topics WHERE generation=? AND topic_id=?').get(generation,topicId) as {id:number}).id;
  this.prepared.query('DELETE FROM presentation_topic_search WHERE rowid=?').run(searchId);
  this.prepared.query('DELETE FROM presentation_topic_short WHERE rowid=?').run(searchId);
  this.prepared.query('INSERT INTO presentation_topic_search(rowid,text) VALUES(?,?)').run(searchId,value.search);
  this.prepared.query('INSERT INTO presentation_topic_short(rowid,tokens) VALUES(?,?)').run(searchId,shortTokens(value.search));
  if(owner===context.sessionId&&(previous?.summary_json!==json(summary)||previous?.detail_hash!==ref.hash))
   this.prepared.query('INSERT INTO presentation_topic_changes(generation,topic_id,before_json,after_json) VALUES(?,?,?,?)')
    .run(generation,topicId,previous?.summary_json??null,json(summary));

 }
 private compactItem(item:any,kind:string):any{
  if(Buffer.byteLength(json(item))<=4096)return item;
  const detailRef=this.retain(item),common={id:item.id,topicId:item.topicId,revision:item.revision,state:item.state,
   createdAt:item.createdAt,updatedAt:item.updatedAt,detailRef,coverage:{complete:false,code:'topic_item_preview'}};
  if(kind==='questions')return {...common,kind:item.kind,waiting:item.waiting,readiness:item.readiness,blocking:item.blocking,optional:item.optional,
   context:item.context,pendingReply:item.pendingReply,brief:{decision:preview(item.brief?.decision??'')},reads:[],sources:[],owner:item.owner?{sessionId:item.owner.sessionId}:null};
  if(kind==='requests')return {...common,title:preview(item.title??''),brief:preview(item.brief??''),disposition:item.disposition,dispatches:[],sources:[]};
  return {change:item.change,at:item.at,reason:preview(item.reason??''),detailRef,coverage:{complete:false,code:'topic_item_preview'}};
 }
 private writeAttention(generation:number,scope:string,topicId:string|null,need:any){
  const value=Buffer.byteLength(json(need))<=4096?need:{...need,question:preview(need.question??''),reads:[],
   detailRef:this.retain(need),coverage:{complete:false,code:'attention_preview'}};
  this.prepared.query('INSERT INTO presentation_inbox_attention VALUES(?,?,?,?,?,?,?)')
   .run(generation,scope,need.eventId,topicId,need.generation??0,`${String(need.generation??0).padStart(16,'0')}:${need.eventId}`,json(value));
 }
 activate(generation:number,sourceHead:number){this.prepared.query('UPDATE presentation_topics_meta SET generation=?,source_head=?,ready=1,retained_after=0,inbox_session=? WHERE singleton=1').run(generation,sourceHead,this.inboxSession());}
 checkpoint(generation:number,sourceHead:number){this.prepared.query('UPDATE presentation_topics_meta SET source_head=?,inbox_session=? WHERE singleton=1 AND generation=?').run(sourceHead,this.inboxSession(),generation);}
 private retain(value:unknown){
  const text=json(value),hash=createHash('sha256').update(text).digest('hex');
  if(!this.retainedBy)throw new Error('Topic detail has no retaining projection');
  this.prepared.query('INSERT OR IGNORE INTO presentation_topic_blobs VALUES(?)').run(hash);
  this.prepared.query('INSERT OR IGNORE INTO presentation_topic_chunk_refs VALUES(?,?,?)').run(this.retainedBy.generation,this.retainedBy.owner,hash);
  const pieces:string[]=[];let part='',bytes=0;
  for(const char of text){const size=Buffer.byteLength(char);if(bytes+size>CHUNK_BYTES){pieces.push(part);part='';bytes=0;}part+=char;bytes+=size;}
  if(part)pieces.push(part);
  for(let i=0;i<pieces.length;i++)this.prepared.query('INSERT OR IGNORE INTO presentation_topic_chunks VALUES(?,?,?,?)').run(hash,i,pieces[i],pieces.length);
  return {hash,chunks:pieces.length,bytes:Buffer.byteLength(text)};
 }
 /** Rebuildable bytes live only while a current projection references them. Old revision
  * cursors get an explicit reset after seven days; canonical history is never deleted. */
 collectPage(now=Date.now()){
  const current=meta(this.prepared);
  this.prepared.query('DELETE FROM presentation_topic_chunk_refs WHERE rowid IN (SELECT rowid FROM presentation_topic_chunk_refs WHERE generation<? LIMIT 100)').run(current.generation);
  const oldTopics=this.prepared.query('SELECT rowid AS id FROM presentation_topics WHERE generation<? LIMIT 100').all(current.generation) as {id:number}[];
  for(const {id} of oldTopics){
   this.prepared.query('DELETE FROM presentation_topic_search WHERE rowid=?').run(id);
   this.prepared.query('DELETE FROM presentation_topic_short WHERE rowid=?').run(id);
   this.prepared.query('DELETE FROM presentation_topics WHERE rowid=?').run(id);
  }
  for(const table of ['presentation_topic_items','presentation_topic_questions','presentation_topic_dependencies','presentation_topic_dirty',
   'presentation_topic_sorting_dirty','presentation_topic_request_links','presentation_topic_roots','presentation_topic_sorting','presentation_question_counts','presentation_topic_event_display',
   'presentation_inbox_attention','presentation_inbox_attention_counts'])
   this.prepared.query(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE generation<? LIMIT 100)`).run(current.generation);
  const blobs=this.prepared.query('SELECT hash FROM presentation_topic_blobs WHERE hash>? ORDER BY hash LIMIT 100').all(this.collectAfter) as {hash:string}[];
  for(const {hash} of blobs)if(!this.prepared.query('SELECT 1 FROM presentation_topic_chunk_refs WHERE hash=? LIMIT 1').get(hash)){
   this.prepared.query('DELETE FROM presentation_topic_chunks WHERE hash=?').run(hash);
   this.prepared.query('DELETE FROM presentation_topic_blobs WHERE hash=?').run(hash);
  }
  this.collectAfter=blobs.length===100?blobs.at(-1)!.hash:'';
  const changes=this.prepared.query('SELECT sequence,generation,created_ms FROM presentation_topic_changes ORDER BY sequence LIMIT 100').all() as {sequence:number;generation:number;created_ms:number}[];
  let retained=current.retained_after;
  for(const change of changes){
   if(change.generation===current.generation&&change.created_ms>=now-7*24*60*60*1000)break;
   this.prepared.query('DELETE FROM presentation_topic_changes WHERE sequence=?').run(change.sequence);
   if(change.generation===current.generation)retained=Math.max(retained,change.sequence);
  }
  this.prepared.query('UPDATE presentation_topics_meta SET retained_after=? WHERE singleton=1').run(retained);
 }
 private compact(summary:any,detailRef:unknown){
  if(Buffer.byteLength(json(summary))<=4096)return {...summary,detailRef};
  return {...summary,title:preview(summary.title),summary:preview(summary.summary??''),aliases:[],roots:[],
   needsYou:{...summary.needsYou,items:[]},toRead:{...summary.toRead,items:[]},
   work:{...summary.work,text:preview(summary.work.text)},setAside:summary.setAside?{...summary.setAside,reason:preview(summary.setAside.reason??'')}:null,
   detailRef,coverage:{complete:false,code:'topic_preview'}};
 }
}

function meta(db:Database){return db.query('SELECT generation,source_head,ready,retained_after,inbox_session FROM presentation_topics_meta WHERE singleton=1').get() as Meta;}
function coverage(current:Meta,head:number){return {complete:!!current.ready&&current.source_head>=head,
 code:!current.ready||current.source_head<head?'presentation_indexing':null,appliedSequence:current.source_head};}
function reset(current:Meta){return {topics:[],nextCursor:null,coverage:{complete:false,code:'reset_required',appliedSequence:current.source_head}};}

export function readPreparedTopics(db:Database,options:{state?:State;query?:string|null;cursor?:string|null;limit?:number;canonicalHead:number}){
 const current=meta(db),state=options.state??'open',limit=Math.min(PAGE,Math.max(1,options.limit??PAGE));
 if(!['open','closed','background','all'].includes(state))throw new Error('Unknown topic state filter');
 if(options.query?.trim())return searchPreparedTopics(db,{...options,state,limit,query:options.query.trim().toLowerCase()});
 const old=options.cursor?decode(options.cursor):null;
 if(options.cursor&&(!old||old.g!==current.generation||old.inbox!==current.inbox_session||old.state!==state||typeof old.key!=='string'))return reset(current);
 const key=state==='closed'?'closed_sort_key':'sort_key';
 const condition=state==='all'?'1=1':state==='background'?'background=1':`state='${state}'`;
 const rows=db.query(`SELECT ${key} AS key,summary_json FROM presentation_topics
  WHERE generation=? AND session_id=? AND ${condition} ${old?`AND ${key}>?`:''} ORDER BY ${key} LIMIT ?`)
  .all(current.generation,current.inbox_session,...(old?[old.key]:[]),limit+1) as {key:string;summary_json:string}[];
 const page=rows.slice(0,limit),last=page.at(-1);
 const sortingRow=db.query('SELECT count,attention_json FROM presentation_topic_sorting WHERE generation=?').get(current.generation) as {count:number;attention_json:string}|null;
 const captures=db.query('SELECT root_id AS inputId,text,at FROM presentation_topic_roots WHERE generation=? AND unfiled=1 ORDER BY sequence DESC,root_id LIMIT 5').all(current.generation);
 const changeHead=(db.query('SELECT COALESCE(MAX(sequence),0) AS n FROM presentation_topic_changes WHERE generation=?').get(current.generation) as {n:number}).n;
 return {topics:page.map(row=>JSON.parse(row.summary_json)),sorting:{count:sortingRow?.count??0,captures,attention:JSON.parse(sortingRow?.attention_json??'[]')},asOf:cursor({g:current.generation,inbox:current.inbox_session,sequence:changeHead}),nextCursor:rows.length>limit&&last?
  cursor({g:current.generation,inbox:current.inbox_session,state,key:last.key}):null,
  coverage:coverage(current,options.canonicalHead)};
}
function searchPreparedTopics(db:Database,options:{state:State;query:string;cursor?:string|null;limit:number;canonicalHead:number}){
 const current=meta(db),old=options.cursor?decode(options.cursor):null;
 if(options.query.length>2000)throw new Error('Topic query is too long');
 if(options.cursor&&(!old||old.g!==current.generation||old.inbox!==current.inbox_session||old.query!==options.query||old.state!==options.state||!Number.isSafeInteger(old.row)))return reset(current);
 const table=[...options.query].length>=3?'presentation_topic_search':'presentation_topic_short';
 const expression='"'+(table==='presentation_topic_short'?gram([...options.query]):options.query).replaceAll('"','""')+'"';
 // A finite postings window prevents a common term from sorting the entire collection.
 // Continuation is explicit even if filtering yields an empty page; no match is silently lost.
 const candidates=db.query(`SELECT rowid AS id FROM ${table} WHERE ${table} MATCH ? AND rowid>? ORDER BY rowid LIMIT 101`)
  .all(expression,old?.row??0) as {id:number}[];
 const topics:any[]=[];let consumed=old?.row??0,examined=0;
 for(const candidate of candidates.slice(0,100)){
  consumed=candidate.id;examined++;
  const row=db.query('SELECT state,background,summary_json FROM presentation_topics WHERE rowid=? AND generation=? AND session_id=?')
   .get(candidate.id,current.generation,current.inbox_session) as {state:string;background:number;summary_json:string}|null;
  if(!row||options.state==='background'&&!row.background||!['all','background'].includes(options.state)&&row.state!==options.state)continue;
  topics.push(JSON.parse(row.summary_json));if(topics.length===options.limit)break;
 }
 const more=candidates.length>examined;
 return {topics,nextCursor:more?cursor({g:current.generation,inbox:current.inbox_session,state:options.state,query:options.query,row:consumed}):null,
  coverage:{...coverage(current,options.canonicalHead),searchOrder:'indexed',examined,more}};
}
export function readPreparedTopicChanges(db:Database,after:string,canonicalHead:number,limit=20){
 const current=meta(db),old=decode(after);
 if(!old||old.g!==current.generation||old.inbox!==current.inbox_session||!Number.isSafeInteger(old.sequence)||old.sequence<current.retained_after)return {...reset(current),changes:[]};
 const rows=db.query('SELECT sequence,topic_id,before_json,after_json FROM presentation_topic_changes WHERE generation=? AND sequence>? ORDER BY sequence LIMIT ?')
  .all(current.generation,old.sequence,Math.min(PAGE,Math.max(1,limit))+1) as any[];
 const page=rows.slice(0,Math.min(PAGE,Math.max(1,limit))),next=cursor({g:current.generation,inbox:current.inbox_session,sequence:page.at(-1)?.sequence??old.sequence});
 return {changes:page.map(row=>({revision:row.sequence,topicId:row.topic_id,before:row.before_json?JSON.parse(row.before_json):null,
  after:row.after_json?JSON.parse(row.after_json):null})),asOf:next,nextCursor:rows.length>page.length?next:null,coverage:coverage(current,canonicalHead)};
}
export function readPreparedTopic(db:Database,topicId:string,canonicalHead:number){
 const current=meta(db);
 const row=db.query('SELECT summary_json,detail_hash,session_id FROM presentation_topics WHERE generation=? AND topic_id=?')
  .get(current.generation,topicId) as {summary_json:string;detail_hash:string;session_id:number}|null;
 return {topic:row?JSON.parse(row.summary_json):null,detailRef:row?{hash:row.detail_hash}:null,coverage:coverage(current,canonicalHead)};
}
export function readPreparedTopicResolution(db:Database,messageId:string,canonicalHead:number){
 const current=meta(db);
 const message=db.query('SELECT root_input_id AS root,topic_id FROM presentation_messages WHERE generation=? AND message_id=? ORDER BY event_sequence LIMIT 1')
  .get(current.generation,messageId) as {root:string;topic_id:string|null}|null;
 const topic=message?.topic_id?readPreparedTopic(db,message.topic_id,canonicalHead).topic:null;
 return {topic,root:message?.root??null,coverage:coverage(current,canonicalHead)};
}
export function readPreparedTopicEvents(db:Database,sequences:readonly number[]){
 if(sequences.length>20)throw new Error('Topic event page must contain at most twenty entries');
 const current=meta(db);
 return sequences.map(sequence=>{
  const row=db.query('SELECT display_json FROM presentation_topic_event_display WHERE generation=? AND event_sequence=?')
   .get(current.generation,sequence) as {display_json:string}|null;
  return row?JSON.parse(row.display_json):null;
 });
}
export function readPreparedTopicItems(db:Database,options:{topicId:string;kind:'requests'|'questions'|'history';filter?:string;inputId?:string;cursor?:string|null;limit?:number;canonicalHead:number}){
 const current=meta(db),limit=Math.min(PAGE,Math.max(1,options.limit??PAGE)),old=options.cursor?decode(options.cursor):null;
 const identity={topic:options.topicId,kind:options.kind,filter:options.filter??'open',input:options.inputId??null};
 if(options.cursor&&(!old||old.g!==current.generation||json(old.identity)!==json(identity)||typeof old.key!=='string'))return {...reset(current),items:[]};
 let rows:{key:string;value_json:string}[];
 if(options.kind==='questions'){
  const filter=options.filter??'open';if(!['open','reading','checking','deferred','history'].includes(filter))throw new Error('Unknown question filter');
  rows=db.query(`SELECT q.question_id AS key,q.value_json FROM presentation_topic_questions q
   WHERE generation=? AND topic_id=? AND selected=? AND question_id>? ORDER BY question_id LIMIT ?`)
   .all(current.generation,options.topicId,filter,old?.key??'',limit+1) as typeof rows;
 }else if(options.kind==='requests'&&options.inputId){
  rows=db.query(`SELECT link.request_id AS key,item.value_json FROM presentation_topic_request_links link
   JOIN presentation_topic_items item ON item.generation=link.generation AND item.topic_id=link.topic_id AND item.kind='requests' AND item.item_id=link.request_id
   WHERE link.generation=? AND link.topic_id=? AND link.input_id=? AND link.request_id>? ORDER BY link.request_id LIMIT ?`)
   .all(current.generation,options.topicId,options.inputId,old?.key??'',limit+1) as typeof rows;
 }else{
  rows=db.query('SELECT sort_key AS key,value_json FROM presentation_topic_items WHERE generation=? AND topic_id=? AND kind=? AND sort_key>? ORDER BY sort_key LIMIT ?')
   .all(current.generation,options.topicId,options.kind,old?.key??'',limit+1) as typeof rows;
 }
 const page=rows.slice(0,limit),last=page.at(-1);
 return {items:page.map(row=>JSON.parse(row.value_json)),nextCursor:rows.length>limit&&last?cursor({g:current.generation,identity,key:last.key}):null,coverage:coverage(current,options.canonicalHead)};
}
export function readPreparedTopicOverview(db:Database,topicId:string,canonicalHead:number,filter='open'){
 const current=meta(db),row=db.query('SELECT overview_json FROM presentation_topics WHERE generation=? AND topic_id=?').get(current.generation,topicId) as {overview_json:string}|null;
 if(!row)return {topic:null,coverage:coverage(current,canonicalHead)};
 const questions=readPreparedTopicItems(db,{topicId,kind:'questions',filter,canonicalHead});
 const requests=readPreparedTopicItems(db,{topicId,kind:'requests',canonicalHead});
 const history=readPreparedTopicItems(db,{topicId,kind:'history',canonicalHead});
 const overview=JSON.parse(row.overview_json);
 return {...overview,topic:{...overview.topic,history:history.items},questions:questions.items,requests:requests.items,
  questionFilter:filter,nextQuestionsCursor:questions.nextCursor,nextRequestsCursor:requests.nextCursor,
  nextHistoryCursor:history.nextCursor,coverage:coverage(current,canonicalHead)};
}
export function readPreparedTopicChunk(db:Database,hash:string,chunk:number){
 if(!/^[a-f0-9]{64}$/.test(hash)||!Number.isSafeInteger(chunk)||chunk<0)throw new Error('Invalid topic detail reference');
 return db.query('SELECT text,count FROM presentation_topic_chunks WHERE hash=? AND chunk=?').get(hash,chunk) as {text:string;count:number}|null;
}
export function readPreparedInboxAttention(db:Database,sessionId:number,canonicalHead:number,after:string|null=null,limit=20){
 const current=meta(db),old=after?decode(after):null,size=Math.min(PAGE,Math.max(1,limit)),scope=`unfiled:${sessionId}`;
 if(after&&(!old||old.g!==current.generation||old.sessionId!==sessionId||typeof old.key!=='string'))
  return {needs:[],needsAttention:null,total:null,maxGeneration:null,nextCursor:null,coverage:{complete:false,code:'reset_required',appliedSequence:current.source_head}};
 const rows=db.query(`SELECT order_key,value_json FROM (
  SELECT * FROM (SELECT order_key,value_json FROM presentation_inbox_attention WHERE generation=? AND scope='questions' AND order_key>? ORDER BY order_key LIMIT ?)
  UNION ALL SELECT * FROM (SELECT order_key,value_json FROM presentation_inbox_attention WHERE generation=? AND scope=? AND order_key>? ORDER BY order_key LIMIT ?)
  ) ORDER BY order_key LIMIT ?`).all(current.generation,old?.key??'',size+1,current.generation,scope,old?.key??'',size+1,size+1) as {order_key:string;value_json:string}[];
 let total=0,maxGeneration=0;
 for(const name of ['questions',scope]){
  total+=(db.query('SELECT count FROM presentation_inbox_attention_counts WHERE generation=? AND scope=?').get(current.generation,name) as {count:number}|null)?.count??0;
  maxGeneration=Math.max(maxGeneration,(db.query('SELECT need_generation FROM presentation_inbox_attention WHERE generation=? AND scope=? ORDER BY need_generation DESC LIMIT 1').get(current.generation,name) as {need_generation:number}|null)?.need_generation??0);
 }
 const page=rows.slice(0,size),last=page.at(-1),covered=coverage(current,canonicalHead);
 return {needs:page.map(row=>JSON.parse(row.value_json)),needsAttention:covered.complete?total>0:null,total,maxGeneration,
  nextCursor:rows.length>size&&last?cursor({g:current.generation,sessionId,key:last.order_key}):null,coverage:covered};
}
export function readPreparedQuestions(db:Database,options:{state:string;cursor?:string|null;limit?:number;canonicalHead:number}){
 const current=meta(db),selected=options.state,limit=Math.min(PAGE,Math.max(1,options.limit??PAGE));
 if(!['open','reading','checking','deferred','history'].includes(selected))throw new Error('Unknown question filter');
 const old=options.cursor?decode(options.cursor):null;
 if(options.cursor&&(!old||old.g!==current.generation||old.inbox!==current.inbox_session||old.state!==selected||typeof old.key!=='string'))return reset(current);
 const rows=db.query(`SELECT topic_id,question_id,sort_key,value_json FROM presentation_topic_questions
  WHERE generation=? AND session_id=? AND selected=? AND sort_key>? ORDER BY sort_key LIMIT ?`).all(current.generation,current.inbox_session,selected,old?.key??'',limit+1) as any[];
 const page=rows.slice(0,limit),last=page.at(-1);
 const groups=new Map<string,{topic:any;questions:any[];replyTargets:any}>();
 for(const row of page){
  let group=groups.get(row.topic_id);
  if(!group){
   const topic=db.query('SELECT summary_json,reply_targets_json FROM presentation_topics WHERE generation=? AND topic_id=?').get(current.generation,row.topic_id) as {summary_json:string;reply_targets_json:string}|null;
   if(!topic)throw new Error('Prepared question topic is missing');
   group={topic:JSON.parse(topic.summary_json),questions:[],replyTargets:JSON.parse(topic.reply_targets_json)};groups.set(row.topic_id,group);
  }
  group.questions.push(JSON.parse(row.value_json));
 }
 const counts={open:0,reading:0,checking:0,deferred:0,history:0};
 for(const row of db.query('SELECT selected,count FROM presentation_question_counts WHERE generation=? AND session_id=? LIMIT 5').all(current.generation,current.inbox_session) as {selected:keyof typeof counts;count:number}[])counts[row.selected]=row.count;
 return {topics:[...groups.values()],questionCounts:counts,nextCursor:rows.length>limit&&last?
  cursor({g:current.generation,inbox:current.inbox_session,state:selected,key:last.sort_key}):null,coverage:coverage(current,options.canonicalHead)};
}
