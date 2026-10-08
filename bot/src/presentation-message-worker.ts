import {Database} from 'bun:sqlite';
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {inboxRootResolver,sourceMessagePage} from './presentation-message-source';

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
    let after=0,more=true;
    const resolveRoot=inboxRootResolver(source);
    while(more) {
      const page=sourceMessagePage(source,after,250,resolveRoot);
      after=page.nextSequence;more=page.hasMore;
      prepared.transaction(()=>{
        for(const row of page.messages)insert.run(generation,row.sessionId,row.root,topicOf(row.root),row.sequence,row.messageId,row.inputId,row.createdAt);
        for(const row of page.topicEvents)insertTopicEvent.run(generation,row.topicId,row.sequence,row.sessionId,row.eventId);
        for(const row of page.ownerMessages)writeOwnerVersion(generation,row);
      })();
      await Bun.sleep(0);
    }
    prepared.transaction(()=>{
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
    for(const row of newRows)insert.run(current.generation,row.sessionId,row.root,topicOf(row.root),row.sequence,row.messageId,row.inputId,row.createdAt);
    for(const row of newTopicEvents)insertTopicEvent.run(current.generation,row.topicId,row.sequence,row.sessionId,row.eventId);
    for(const row of newOwnerMessages)writeOwnerVersion(current.generation,row);
    prepared.query('UPDATE presentation_message_meta SET event_watermark=?,source_head=? WHERE singleton=1')
      .run(eventAfter,changes.at(-1)!.sequence);
  })();
}

while(true){
  try {await catchUp();}
  catch(error){console.error(JSON.stringify({event:'presentation_message_worker_failed',error:String(error)}));}
  await Bun.sleep(500);
}
