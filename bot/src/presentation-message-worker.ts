import {Database} from 'bun:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {inboxRootResolver,sourceMessagePage} from './presentation-message-source';
import {PreparedSearchIndex} from './prepared-search';

const directory=process.env.CONCIERGE_STATE_DIR;
if(!directory)throw new Error('Presentation worker requires CONCIERGE_STATE_DIR.');
const stateDir=realpathSync(directory);
const source=new Database(join(stateDir,'state.db'),{readonly:true});
source.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
const prepared=new Database(join(stateDir,'presentation.db'),{create:true});
prepared.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;
  CREATE TABLE IF NOT EXISTS presentation_message_meta(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation INTEGER NOT NULL,
    event_watermark INTEGER NOT NULL,source_head INTEGER NOT NULL,ready INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO presentation_message_meta VALUES(1,0,0,0,0);
  CREATE TABLE IF NOT EXISTS presentation_worker_lease(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),token TEXT,heartbeat_ms INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO presentation_worker_lease(singleton) VALUES(1);
  CREATE TABLE IF NOT EXISTS presentation_messages(
    generation INTEGER NOT NULL,session_id INTEGER NOT NULL,root_input_id TEXT NOT NULL,
    topic_id TEXT,event_sequence INTEGER NOT NULL,message_id TEXT NOT NULL,input_id TEXT NOT NULL,created_at TEXT NOT NULL,
    PRIMARY KEY(generation,event_sequence)
  );
  CREATE INDEX IF NOT EXISTS presentation_messages_root_page
    ON presentation_messages(generation,session_id,root_input_id,event_sequence DESC);
  CREATE INDEX IF NOT EXISTS presentation_messages_topic_page
    ON presentation_messages(generation,topic_id,event_sequence DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS presentation_messages_exact
    ON presentation_messages(generation,session_id,message_id);
  CREATE TABLE IF NOT EXISTS presentation_topic_events(
    generation INTEGER NOT NULL,topic_id TEXT NOT NULL,event_sequence INTEGER NOT NULL,
    session_id INTEGER NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(generation,event_sequence)
  );
  CREATE INDEX IF NOT EXISTS presentation_topic_events_page
    ON presentation_topic_events(generation,topic_id,event_sequence DESC);
  CREATE TABLE IF NOT EXISTS presentation_owner_messages(
    generation INTEGER NOT NULL,session_id INTEGER NOT NULL,message_id TEXT NOT NULL,
    first_sequence INTEGER NOT NULL,last_sequence INTEGER NOT NULL,
    PRIMARY KEY(generation,session_id,message_id)
  );
  CREATE INDEX IF NOT EXISTS presentation_owner_messages_page
    ON presentation_owner_messages(generation,session_id,first_sequence DESC);
  CREATE TABLE IF NOT EXISTS presentation_owner_message_versions(
    generation INTEGER NOT NULL,session_id INTEGER NOT NULL,message_id TEXT NOT NULL,
    event_sequence INTEGER NOT NULL,event_id TEXT NOT NULL,
    PRIMARY KEY(generation,session_id,message_id,event_sequence)
  );
  CREATE INDEX IF NOT EXISTS presentation_owner_versions_delta
    ON presentation_owner_message_versions(generation,session_id,event_sequence);`);
const search=new PreparedSearchIndex(prepared);
const leaseToken=randomUUID();
const leaseTimeoutMs=10_000;
function claimLease():boolean {
  const now=Date.now();
  return prepared.query(`UPDATE presentation_worker_lease SET token=?,heartbeat_ms=?
    WHERE singleton=1 AND (token IS NULL OR token=? OR heartbeat_ms<?)`)
    .run(leaseToken,now,leaseToken,now-leaseTimeoutMs).changes===1;
}
/** Called inside each prepared write transaction. A former owner cannot publish after takeover. */
function keepLease() {
  if(prepared.query('UPDATE presentation_worker_lease SET heartbeat_ms=? WHERE singleton=1 AND token=?')
    .run(Date.now(),leaseToken).changes!==1)throw new Error('PRESENTATION_LEASE_LOST');
}
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const stable=(value:unknown):string=>JSON.stringify((function order(item:any):any{
  return Array.isArray(item)?item.map(order):item&&typeof item==='object'
    ?Object.fromEntries(Object.keys(item).sort().filter(key=>item[key]!==undefined).map(key=>[key,order(item[key])])):item;
})(value));
const withoutHeader=(text:string)=>{
  if(!text.startsWith('{"type":"concierge-session-input"'))return text;
  const end=text.indexOf('\n\n');return end<0?'':text.slice(end+2);
};

const meta=()=>prepared.query('SELECT generation,event_watermark,source_head,ready FROM presentation_message_meta WHERE singleton=1')
  .get() as {generation:number;event_watermark:number;source_head:number;ready:number};
const head=()=>Number((source.query('SELECT COALESCE(MAX(sequence),0) AS n FROM presentation_change_log').get() as {n:number}).n);
const insert=prepared.query(`INSERT INTO presentation_messages(generation,session_id,root_input_id,topic_id,event_sequence,message_id,input_id,created_at)
  VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(generation,event_sequence) DO UPDATE SET
  root_input_id=excluded.root_input_id,topic_id=excluded.topic_id,message_id=excluded.message_id,input_id=excluded.input_id,created_at=excluded.created_at`);
const insertTopicEvent=prepared.query(`INSERT INTO presentation_topic_events(generation,topic_id,event_sequence,session_id,event_id)
  VALUES(?,?,?,?,?) ON CONFLICT(generation,event_sequence) DO UPDATE SET topic_id=excluded.topic_id`);
const insertOwnerVersion=prepared.query(`INSERT OR IGNORE INTO presentation_owner_message_versions
  (generation,session_id,message_id,event_sequence,event_id) VALUES(?,?,?,?,?)`);
const upsertOwnerMessage=prepared.query(`INSERT INTO presentation_owner_messages
  (generation,session_id,message_id,first_sequence,last_sequence) VALUES(?,?,?,?,?)
  ON CONFLICT(generation,session_id,message_id) DO UPDATE SET
  first_sequence=MIN(first_sequence,excluded.first_sequence),last_sequence=MAX(last_sequence,excluded.last_sequence)`);
function writeOwnerVersion(generation:number,row:{sessionId:number;messageId:string;sequence:number;eventId:string}) {
  insertOwnerVersion.run(generation,row.sessionId,row.messageId,row.sequence,row.eventId);
  upsertOwnerMessage.run(generation,row.sessionId,row.messageId,row.sequence,row.sequence);
  const event=source.query('SELECT payload_json,created_at FROM session_owner_events WHERE sequence=?').get(row.sequence) as
    {payload_json:string;created_at:string}|null;
  const message=event?JSON.parse(event.payload_json)?.message:null;
  if(!message||typeof message.content!=='string'||!['user','assistant','tool'].includes(message.role))return;
  const text=withoutHeader(message.content);
  search.upsert({key:`message:${row.sessionId}:${row.messageId}`,sessionId:row.sessionId,kind:'message',eventId:row.messageId,
    sourceId:`native:${row.sessionId}`,sourceVersion:hash(stable(message)),textHash:hash(message.content),role:message.role,
    text,at:event?.created_at??null,ordinal:row.sequence,...(typeof message.detailKey==='string'?{detailKey:message.detailKey}:{})});
}
function writeInput(inputId:string) {
  const row=source.query('SELECT id,session_id,kind,payload_json,created_at FROM session_inputs WHERE id=?')
    .get(inputId) as {id:string;session_id:number;kind:string;payload_json:string;created_at:string}|null;
  if(!row||!['input','create'].includes(row.kind)){search.remove(`input:${inputId}`);return;}
  const payload=JSON.parse(row.payload_json),written=payload.text??payload.firstInput?.text;
  if(typeof written!=='string'||!written.trim()){search.remove(`input:${inputId}`);return;}
  const text=withoutHeader(written);
  search.upsert({key:`input:${inputId}`,sessionId:row.session_id,kind:'input',eventId:row.id,
    sourceId:`input:${row.id}`,sourceVersion:hash(written),textHash:hash(written),role:'user',text,at:row.created_at,ordinal:0});
}
function writeSession(sessionId:number) {
  const row=source.query('SELECT native_metadata_json FROM sessions WHERE id=?').get(sessionId) as {native_metadata_json:string}|null;
  if(!row){search.remove(`session:${sessionId}`);return;}
  const meta=JSON.parse(row.native_metadata_json||'{}');
  const text=[meta.title,meta.summary,meta.cwd].filter(value=>typeof value==='string').join('\n');
  if(!text){search.remove(`session:${sessionId}`);return;}
  search.upsert({key:`session:${sessionId}`,sessionId,kind:'session',eventId:String(sessionId),sourceId:`session:${sessionId}`,
    sourceVersion:hash(text),textHash:hash(text),role:'session',text,at:null,ordinal:0});
}
function topicOf(root:string):string|null {
  return (source.query('SELECT topic_id FROM inbox_topic_roots WHERE root_input_id=?').get(root) as {topic_id:string}|null)?.topic_id??null;
}
let rebuilding=false;

/** Full re-rooting occurs off the interactive owner. The old generation stays readable until commit. */
async function rebuild() {
  if(rebuilding)return;
  rebuilding=true;
  try {
    const previous=meta(),generation=previous.generation+1,startHead=head();
    prepared.transaction(()=>{
      keepLease();
      prepared.query('DELETE FROM presentation_messages WHERE generation=?').run(generation);
      prepared.query('DELETE FROM presentation_topic_events WHERE generation=?').run(generation);
      prepared.query('DELETE FROM presentation_owner_messages WHERE generation=?').run(generation);
      prepared.query('DELETE FROM presentation_owner_message_versions WHERE generation=?').run(generation);
    })();
    let after=0,more=true;
    const resolveRoot=inboxRootResolver(source);
    while(more) {
      const page=sourceMessagePage(source,after,250,resolveRoot);
      after=page.nextSequence;more=page.hasMore;
      prepared.transaction(()=>{
        keepLease();
        for(const row of page.messages)insert.run(generation,row.sessionId,row.root,topicOf(row.root),row.sequence,row.messageId,row.inputId,row.createdAt);
        for(const row of page.topicEvents)insertTopicEvent.run(generation,row.topicId,row.sequence,row.sessionId,row.eventId);
        for(const row of page.ownerMessages)writeOwnerVersion(generation,row);
      })();
      await Bun.sleep(0);
    }
    let inputAfter=0;
    while(true){
      const rows=source.query('SELECT rowid,id FROM session_inputs WHERE rowid>? ORDER BY rowid LIMIT 20')
        .all(inputAfter) as {rowid:number;id:string}[];
      if(!rows.length)break;
      prepared.transaction(()=>{keepLease();for(const row of rows)writeInput(row.id);})();
      inputAfter=rows.at(-1)!.rowid;
      await Bun.sleep(5);
    }
    let sessionAfter=0;
    while(true){
      const rows=source.query('SELECT id FROM sessions WHERE id>? ORDER BY id LIMIT 50').all(sessionAfter) as {id:number}[];
      if(!rows.length)break;
      prepared.transaction(()=>{keepLease();for(const row of rows)writeSession(row.id);})();
      sessionAfter=rows.at(-1)!.id;
      await Bun.sleep(5);
    }
    prepared.transaction(()=>{
      keepLease();
      prepared.query('UPDATE presentation_message_meta SET generation=?,event_watermark=?,source_head=?,ready=1 WHERE singleton=1')
        .run(generation,after,startHead);
      prepared.query('DELETE FROM presentation_messages WHERE generation<?').run(generation);
      prepared.query('DELETE FROM presentation_topic_events WHERE generation<?').run(generation);
      prepared.query('DELETE FROM presentation_owner_messages WHERE generation<?').run(generation);
      prepared.query('DELETE FROM presentation_owner_message_versions WHERE generation<?').run(generation);
    })();
  } finally {rebuilding=false;}
}

/** Changes to lineage request a new generation. New messages append without rereading history. */
async function catchUp() {
  const current=meta();
  if(!current.ready){await rebuild();return;}
  const changes=source.query(`SELECT sequence,source_table,row_key FROM presentation_change_log
    WHERE sequence>? ORDER BY sequence LIMIT 500`).all(current.source_head) as
      {sequence:number;source_table:string;row_key:string}[];
  if(!changes.length)return;
  const relink=changes.some(change=>change.source_table==='inbox_topic_roots'
    ||change.source_table==='session_owner_events'
    &&(source.query('SELECT kind FROM session_owner_events WHERE sequence=?').get(Number(change.row_key)) as {kind:string}|null)?.kind==='thread_link');
  if(relink){await rebuild();return;}
  const resolveRoot=inboxRootResolver(source);
  let eventAfter=current.event_watermark;
  const newRows=[] as ReturnType<typeof sourceMessagePage>['messages'];
  const newTopicEvents=[] as ReturnType<typeof sourceMessagePage>['topicEvents'];
  const newOwnerMessages=[] as ReturnType<typeof sourceMessagePage>['ownerMessages'];
  // The source event sequence and change sequence are distinct; both advance together at commit.
  while(true){
    const page=sourceMessagePage(source,eventAfter,250,resolveRoot);
    eventAfter=page.nextSequence;newRows.push(...page.messages);newTopicEvents.push(...page.topicEvents);newOwnerMessages.push(...page.ownerMessages);
    if(!page.hasMore)break;
    await Bun.sleep(0);
  }
  prepared.transaction(()=>{
    keepLease();
    for(const row of newRows)insert.run(current.generation,row.sessionId,row.root,topicOf(row.root),row.sequence,row.messageId,row.inputId,row.createdAt);
    for(const row of newTopicEvents)insertTopicEvent.run(current.generation,row.topicId,row.sequence,row.sessionId,row.eventId);
    for(const row of newOwnerMessages)writeOwnerVersion(current.generation,row);
    for(const change of changes){
      if(change.source_table==='session_inputs')writeInput(change.row_key);
      else if(change.source_table==='sessions')writeSession(Number(change.row_key));
    }
    prepared.query('UPDATE presentation_message_meta SET event_watermark=?,source_head=? WHERE singleton=1')
      .run(eventAfter,changes.at(-1)!.sequence);
  })();
}

while(true){
  try {if(claimLease())await catchUp();}
  catch(error){console.error(JSON.stringify({event:'presentation_message_worker_failed',error:String(error)}));}
  // A retained message should appear in a warm thread inside the interactive read budget;
  // the idle check is one indexed change-journal seek in this child, outside the owner loop.
  await Bun.sleep(100);
}
