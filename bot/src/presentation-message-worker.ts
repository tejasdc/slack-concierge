import {Database} from 'bun:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {inboxRootResolver,sourceMessagePage} from './presentation-message-source';
import {PreparedSearchIndex} from './prepared-search';
import {sessionCatalogueLabels} from './session-labels';
import {preparedInboxDisplay} from './presentation-inbox-display';
import {PreparedSessionCards} from './prepared-session-cards';
import {PreparedReceipts} from './prepared-receipts';
import {PreparedTopics} from './prepared-topics';

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
    entry_kind TEXT NOT NULL DEFAULT 'other',
    PRIMARY KEY(generation,event_sequence)
  );
  CREATE INDEX IF NOT EXISTS presentation_messages_root_page
    ON presentation_messages(generation,session_id,root_input_id,event_sequence DESC);
  CREATE INDEX IF NOT EXISTS presentation_messages_topic_page
    ON presentation_messages(generation,topic_id,event_sequence DESC);
  CREATE INDEX IF NOT EXISTS presentation_messages_input
    ON presentation_messages(generation,session_id,input_id,event_sequence);
  CREATE INDEX IF NOT EXISTS presentation_messages_global_id
    ON presentation_messages(generation,message_id,event_sequence);
  CREATE INDEX IF NOT EXISTS presentation_messages_return_input
    ON presentation_messages(generation,input_id,event_sequence);
  CREATE UNIQUE INDEX IF NOT EXISTS presentation_messages_exact
    ON presentation_messages(generation,session_id,message_id);
  CREATE TABLE IF NOT EXISTS presentation_message_display(
    generation INTEGER NOT NULL,event_sequence INTEGER NOT NULL,display_json TEXT NOT NULL,
    PRIMARY KEY(generation,event_sequence)
  );
  CREATE TABLE IF NOT EXISTS presentation_message_detail_chunks(
    generation INTEGER NOT NULL,event_sequence INTEGER NOT NULL,part INTEGER NOT NULL,content TEXT NOT NULL,
    digest TEXT NOT NULL,
    PRIMARY KEY(generation,event_sequence,part)
  );
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
const hadEntryKind=(prepared.query('PRAGMA table_info(presentation_messages)').all() as {name:string}[])
  .some(column=>column.name==='entry_kind');
if(!hadEntryKind){
  prepared.exec("ALTER TABLE presentation_messages ADD COLUMN entry_kind TEXT NOT NULL DEFAULT 'other'");
  prepared.query('UPDATE presentation_message_meta SET ready=0 WHERE singleton=1').run();
}
prepared.exec(`CREATE INDEX IF NOT EXISTS presentation_messages_root_kind_latest
  ON presentation_messages(generation,root_input_id,entry_kind,event_sequence DESC);`);
const search=new PreparedSearchIndex(prepared);
const cards=new PreparedSessionCards(source,prepared,(db,row)=>sessionCatalogueLabels(db,
  {...row,native_metadata_json:row.native_metadata_json??'{}'}));
const receipts=new PreparedReceipts(source,prepared);
const topics=new PreparedTopics(source,prepared);
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
const insert=prepared.query(`INSERT INTO presentation_messages(generation,session_id,root_input_id,topic_id,event_sequence,message_id,input_id,created_at,entry_kind)
  VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(generation,event_sequence) DO UPDATE SET
  root_input_id=excluded.root_input_id,topic_id=excluded.topic_id,message_id=excluded.message_id,
  input_id=excluded.input_id,created_at=excluded.created_at,entry_kind=excluded.entry_kind`);
const insertDisplay=prepared.query(`INSERT INTO presentation_message_display(generation,event_sequence,display_json) VALUES(?,?,?)
  ON CONFLICT(generation,event_sequence) DO UPDATE SET display_json=excluded.display_json`);
const insertDetailChunk=prepared.query(`INSERT INTO presentation_message_detail_chunks(generation,event_sequence,part,content,digest)
  VALUES(?,?,?,?,?) ON CONFLICT(generation,event_sequence,part) DO UPDATE SET content=excluded.content,digest=excluded.digest`);
function writeDisplay(generation:number,sequence:number,sessionId:number,messageId:string){
  const result=preparedInboxDisplay(source,sessionId,sequence,messageId);
  if(!result)return;
  insertDisplay.run(generation,sequence,JSON.stringify(result.preview));
  prepared.query('DELETE FROM presentation_message_detail_chunks WHERE generation=? AND event_sequence=?').run(generation,sequence);
  if(result.detailJson){const digest=hash(result.detailJson);
    for(let index=0,part=0;index<result.detailJson.length;index+=4096,part++)
      insertDetailChunk.run(generation,sequence,part,result.detailJson.slice(index,index+4096),digest);
  }
}
function writeInboxMessage(generation:number,row:{sessionId:number;root:string;sequence:number;messageId:string;inputId:string;createdAt:string;entryKind:string}) {
  insert.run(generation,row.sessionId,row.root,topicOf(row.root),row.sequence,row.messageId,row.inputId,row.createdAt,row.entryKind);
  writeDisplay(generation,row.sequence,row.sessionId,row.messageId);
}
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
  const row=source.query('SELECT native_metadata_json,slack_channel_id,slack_thread_ts FROM sessions WHERE id=?')
    .get(sessionId) as {native_metadata_json:string;slack_channel_id:string|null;slack_thread_ts:string|null}|null;
  if(!row){search.remove(`session:${sessionId}`);return;}
  const labels=sessionCatalogueLabels(source,row);
  const text=[labels.title,labels.summary,labels.project].filter(value=>typeof value==='string').join('\n');
  if(!text){search.remove(`session:${sessionId}`);return;}
  search.upsert({key:`session:${sessionId}`,sessionId,kind:'session',eventId:String(sessionId),sourceId:`session:${sessionId}`,
    sourceVersion:hash(text),textHash:hash(text),role:'session',text,at:null,ordinal:0});
}
function topicOf(root:string):string|null {
  return (source.query('SELECT topic_id FROM inbox_topic_roots WHERE root_input_id=?').get(root) as {topic_id:string}|null)?.topic_id??null;
}
async function reassignLinkedInput(generation:number,inputId:string,resolveRoot:ReturnType<typeof inboxRootResolver>) {
  const changedRoots=new Set<string>();
  const roots=prepared.query(`SELECT DISTINCT root_input_id AS root FROM presentation_messages
    WHERE generation=? AND input_id=?`).all(generation,inputId) as {root:string}[];
  for(const {root} of roots){
    changedRoots.add(root);
    let after=0;
    while(true){
      const rows=prepared.query(`SELECT event_sequence AS sequence,session_id AS sessionId,message_id AS messageId,input_id AS inputId
        FROM presentation_messages WHERE generation=? AND root_input_id=? AND event_sequence>?
        ORDER BY event_sequence LIMIT 100`).all(generation,root,after) as
          {sequence:number;sessionId:number;messageId:string;inputId:string}[];
      if(!rows.length)break;
      prepared.transaction(()=>{
        keepLease();
        for(const row of rows){
          const nextRoot=resolveRoot(row.sessionId,row.messageId);
          if(nextRoot&&nextRoot!==root){
            changedRoots.add(nextRoot);
            prepared.query(`UPDATE presentation_messages SET root_input_id=?,topic_id=?
              WHERE generation=? AND event_sequence=?`).run(nextRoot,topicOf(nextRoot),generation,row.sequence);
          }
          if(nextRoot!==root||row.inputId===inputId)writeDisplay(generation,row.sequence,row.sessionId,row.messageId);
        }
      })();
      after=rows.at(-1)!.sequence;
      await Bun.sleep(0);
    }
  }
  return changedRoots;
}
async function relocateRoot(generation:number,root:string){
  const topic=topicOf(root);
  let after=0;
  while(true){
    const rows=prepared.query(`SELECT event_sequence AS sequence FROM presentation_messages
      WHERE generation=? AND root_input_id=? AND event_sequence>? ORDER BY event_sequence LIMIT 100`)
      .all(generation,root,after) as {sequence:number}[];
    if(!rows.length)break;
    prepared.transaction(()=>{
      keepLease();
      for(const row of rows)prepared.query('UPDATE presentation_messages SET topic_id=? WHERE generation=? AND event_sequence=?')
        .run(topic,generation,row.sequence);
    })();
    after=rows.at(-1)!.sequence;
    await Bun.sleep(0);
  }
}
let rebuilding=false;

/** Full re-rooting occurs off the interactive owner. The old generation stays readable until commit. */
async function rebuild() {
  if(rebuilding)return;
  rebuilding=true;
  try {
    const previous=meta(),generation=previous.generation+1,startHead=head();
    const eventHead=(source.query('SELECT COALESCE(MAX(sequence),0) AS n FROM session_owner_events').get() as {n:number}).n;
    prepared.transaction(()=>{
      keepLease();
      prepared.query('DELETE FROM presentation_messages WHERE generation=?').run(generation);
      prepared.query('DELETE FROM presentation_message_display WHERE generation=?').run(generation);
      prepared.query('DELETE FROM presentation_message_detail_chunks WHERE generation=?').run(generation);
      prepared.query('DELETE FROM presentation_topic_events WHERE generation=?').run(generation);
      prepared.query('DELETE FROM presentation_owner_messages WHERE generation=?').run(generation);
      prepared.query('DELETE FROM presentation_owner_message_versions WHERE generation=?').run(generation);
      cards.beginRebuild(generation);
      receipts.beginRebuild(generation);
      topics.beginRebuild(generation);
    })();
    let after=0,more=true;
    const resolveRoot=inboxRootResolver(source);
    while(more) {
      const page=sourceMessagePage(source,after,eventHead,250,resolveRoot);
      after=page.nextSequence;more=page.hasMore;
      prepared.transaction(()=>{
        keepLease();
        for(const row of page.messages)writeInboxMessage(generation,row);
        for(const row of page.topicEvents)insertTopicEvent.run(generation,row.topicId,row.sequence,row.sessionId,row.eventId);
        for(const row of page.ownerMessages)writeOwnerVersion(generation,row);
      })();
      await Bun.sleep(0);
    }
    after=eventHead;
    let inputAfter=0;
    while(true){
      const rows=source.query('SELECT rowid,id FROM session_inputs WHERE rowid>? ORDER BY rowid LIMIT 20')
        .all(inputAfter) as {rowid:number;id:string}[];
      if(!rows.length)break;
      prepared.transaction(()=>{keepLease();for(const row of rows)writeInput(row.id);})();
      prepared.transaction(()=>{keepLease();receipts.rebuildPage(generation,inputAfter,20);})();
      inputAfter=rows.at(-1)!.rowid;
      await Bun.sleep(5);
    }
    let sessionAfter=0;
    while(true){
      const rows=source.query('SELECT id FROM sessions WHERE id>? ORDER BY id LIMIT 50').all(sessionAfter) as {id:number}[];
      if(!rows.length)break;
      prepared.transaction(()=>{keepLease();for(const row of rows)writeSession(row.id);
        cards.rebuildPage(generation,sessionAfter,50);})();
      sessionAfter=rows.at(-1)!.id;
      await Bun.sleep(5);
    }
    let rootAfter='';
    while(true){
      const page=prepared.transaction(()=>{keepLease();return topics.rebuildRootsPage(generation,rootAfter,100);})();
      rootAfter=page.lastRoot;
      if(!page.hasMore)break;
      await Bun.sleep(0);
    }
    const inboxes=source.query("SELECT id FROM sessions WHERE json_extract(native_metadata_json,'$.inbox')=1 ORDER BY id")
      .all() as {id:number}[];
    for(const inbox of inboxes){
      let topicAfter='';
      while(true){
        const page=prepared.transaction(()=>{keepLease();return topics.rebuildPage(generation,inbox.id,topicAfter,20);})();
        topicAfter=page.lastId;
        if(!page.hasMore)break;
        await Bun.sleep(0);
      }
      prepared.transaction(()=>{keepLease();topics.updateSorting(topics.context(generation,inbox.id));})();
      await Bun.sleep(0);
    }
    prepared.transaction(()=>{
      keepLease();
      prepared.query('UPDATE presentation_message_meta SET generation=?,event_watermark=?,source_head=?,ready=1 WHERE singleton=1')
        .run(generation,after,startHead);
      cards.activate(generation,startHead);
      receipts.activate(generation,startHead);
      topics.activate(generation,startHead);
      prepared.query('DELETE FROM presentation_messages WHERE generation<?').run(generation);
      prepared.query('DELETE FROM presentation_message_display WHERE generation<?').run(generation);
      prepared.query('DELETE FROM presentation_message_detail_chunks WHERE generation<?').run(generation);
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
  const changes=source.query(`SELECT sequence,source_table,row_key,session_id,input_id,turn_id,request_id,topic_id,target_session_id,target_input_id FROM presentation_change_log
    WHERE sequence>? ORDER BY sequence LIMIT 500`).all(current.source_head) as
      {sequence:number;source_table:string;row_key:string;session_id:number|null;input_id:string|null;
        turn_id:number|null;request_id:string|null;topic_id:string|null;target_session_id:number|null;
        target_input_id:string|null}[];
  if(!changes.length){
    prepared.transaction(()=>{keepLease();receipts.refreshDue(current.generation);})();
    return;
  }
  const resolveRoot=inboxRootResolver(source);
  const linkedInputs=new Set<string>(),movedRoots=new Set<string>(),turnsToRefresh=new Set<number>();
  const changedReturnEvents=new Set<string>();
  const changedRoots=new Set<string>();
  for(const change of changes){
    if(change.source_table==='inbox_topic_roots')movedRoots.add(change.row_key);
    if(change.source_table==='session_communication_events'||change.source_table==='session_peer_events')
      changedReturnEvents.add(change.row_key);
    else if(change.source_table==='session_owner_events'){
      const row=source.query('SELECT kind,input_id,turn_id FROM session_owner_events WHERE sequence=?').get(Number(change.row_key)) as
        {kind:string;input_id:string|null;turn_id:number|null}|null;
      if(row?.kind==='thread_link'&&row.input_id)linkedInputs.add(row.input_id);
      if(row?.turn_id&&['post','turn_outcome'].includes(row.kind))turnsToRefresh.add(row.turn_id);
    }
  }
  for(const inputId of linkedInputs)for(const root of await reassignLinkedInput(current.generation,inputId,resolveRoot))changedRoots.add(root);
  for(const root of movedRoots){await relocateRoot(current.generation,root);changedRoots.add(root);}
  let eventAfter=current.event_watermark;
  const eventHead=changes.reduce((latest,change)=>change.source_table==='session_owner_events'
    ?Math.max(latest,Number(change.row_key)||0):latest,current.event_watermark);
  const newRows=[] as ReturnType<typeof sourceMessagePage>['messages'];
  const newTopicEvents=[] as ReturnType<typeof sourceMessagePage>['topicEvents'];
  const newOwnerMessages=[] as ReturnType<typeof sourceMessagePage>['ownerMessages'];
  // The source event sequence and change sequence are distinct; both advance together at commit.
  while(eventAfter<eventHead){
    const page=sourceMessagePage(source,eventAfter,eventHead,250,resolveRoot);
    eventAfter=page.nextSequence;newRows.push(...page.messages);newTopicEvents.push(...page.topicEvents);newOwnerMessages.push(...page.ownerMessages);
    if(!page.hasMore)break;
    await Bun.sleep(0);
  }
  eventAfter=eventHead;
  for(const row of newRows)changedRoots.add(row.root);
  prepared.transaction(()=>{
    keepLease();
    for(const row of newRows)writeInboxMessage(current.generation,row);
    for(const eventId of changedReturnEvents){
      const inputId=`return:${eventId}`;
      const event=(source.query('SELECT kind FROM session_communication_events WHERE event_id=?').get(eventId)
        ??source.query('SELECT kind FROM session_peer_events WHERE event_id=?').get(eventId)) as {kind:string}|null;
      const existing=prepared.query(`SELECT DISTINCT root_input_id AS root FROM presentation_messages
        WHERE generation=? AND input_id=?`).all(current.generation,inputId) as {root:string}[];
      for(const row of existing)changedRoots.add(row.root);
      prepared.query(`UPDATE presentation_messages SET entry_kind=? WHERE generation=? AND input_id=?`)
        .run(event?.kind==='final'?'final':'other',current.generation,inputId);
    }
    for(const row of newTopicEvents)insertTopicEvent.run(current.generation,row.topicId,row.sequence,row.sessionId,row.eventId);
    for(const row of newOwnerMessages)writeOwnerVersion(current.generation,row);
    for(const turnId of turnsToRefresh){
      const results=source.query(`SELECT sequence,session_id AS sessionId,event_id AS messageId FROM session_owner_events
        WHERE turn_id=? AND kind='result'`).all(turnId) as {sequence:number;sessionId:number;messageId:string}[];
      for(const row of results){
        if(prepared.query('SELECT 1 FROM presentation_messages WHERE generation=? AND event_sequence=?').get(current.generation,row.sequence))
          writeDisplay(current.generation,row.sequence,row.sessionId,row.messageId);
      }
    }
    for(const change of changes){
      if(change.source_table==='session_inputs')writeInput(change.row_key);
      else if(change.source_table==='sessions'||change.source_table==='slack_agent_session_title_projections'
        ||change.source_table==='slack_agent_session_status_projections'){
        if(change.session_id)writeSession(change.session_id);
      }
    }
    cards.apply(current.generation,changes.map(change=>
      change.session_id&&(change.source_table==='slack_agent_session_title_projections'||change.source_table==='slack_agent_session_status_projections')
        ?{...change,source_table:'sessions',row_key:String(change.session_id)}:change));
    receipts.apply(current.generation,changes);
    receipts.refreshDue(current.generation);
    topics.apply(current.generation,changes,changedRoots);
    // A legacy channel name/path is a fallback label for every session in that channel.
    // Process only affected sessions, in fixed pages; the worker remains off the owner loop.
    for(const channel of new Set(changes.filter(change=>change.source_table==='channels').map(change=>change.row_key))){
      let after=0;
      while(true){
        const rows=source.query(`SELECT id FROM sessions WHERE slack_channel_id=? AND id>?
          ORDER BY id LIMIT 100`).all(channel,after) as {id:number}[];
        if(!rows.length)break;
        for(const row of rows)writeSession(row.id);
        cards.apply(current.generation,rows.map(row=>({source_table:'sessions',row_key:String(row.id),
          session_id:row.id,sequence:changes.at(-1)!.sequence})));
        after=rows.at(-1)!.id;
      }
    }
  })();
  while(true){
    const drained=prepared.transaction(()=>{keepLease();return topics.drain(current.generation,20);})();
    if(!drained.hasMore)break;
    await Bun.sleep(0);
  }
  prepared.transaction(()=>{
    keepLease();
    cards.checkpoint(current.generation,changes.at(-1)!.sequence);
    receipts.checkpoint(current.generation,changes.at(-1)!.sequence);
    topics.checkpoint(current.generation,changes.at(-1)!.sequence);
    prepared.query('UPDATE presentation_message_meta SET event_watermark=?,source_head=? WHERE singleton=1')
      .run(eventAfter,changes.at(-1)!.sequence);
  })();
}

let checkedDisplay=false;
while(true){
  try {if(claimLease()){
    if(!checkedDisplay){
      const current=meta();
      const missing=current.ready&&prepared.query(`SELECT 1 FROM presentation_messages message
        LEFT JOIN presentation_message_display display ON display.generation=message.generation
          AND display.event_sequence=message.event_sequence
        WHERE message.generation=? AND display.event_sequence IS NULL LIMIT 1`).get(current.generation);
      if(missing)prepared.query('UPDATE presentation_message_meta SET ready=0 WHERE singleton=1').run();
      checkedDisplay=true;
    }
    await catchUp();
  }}
  catch(error){console.error(JSON.stringify({event:'presentation_message_worker_failed',error:String(error)}));}
  // A retained message should appear in a warm thread inside the interactive read budget;
  // the idle check is one indexed change-journal seek in this child, outside the owner loop.
  await Bun.sleep(100);
}
