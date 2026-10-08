import {Database} from 'bun:sqlite';
import {mkdtempSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'concierge-presentation-check-'));
const source=new Database(join(dir,'state.db'),{create:true});
source.exec(`CREATE TABLE sessions(id INTEGER PRIMARY KEY,native_metadata_json TEXT);
  CREATE TABLE turns(id INTEGER PRIMARY KEY,agent_text TEXT);
  CREATE TABLE session_inputs(id TEXT PRIMARY KEY,session_id INTEGER,kind TEXT,origin TEXT,payload_json TEXT,created_at TEXT,request_id TEXT);
  CREATE TABLE session_owner_events(sequence INTEGER PRIMARY KEY,session_id INTEGER,event_id TEXT,input_id TEXT,kind TEXT,payload_json TEXT,created_at TEXT,turn_id INTEGER);
  CREATE TABLE inbox_topic_roots(root_input_id TEXT PRIMARY KEY,topic_id TEXT);
  CREATE TABLE session_communication_requests(request_id TEXT,source_session_id INTEGER,source_input_id TEXT,thread_root_input_id TEXT);
  CREATE TABLE session_peer_requests(request_id TEXT,source_session_id INTEGER,source_input_id TEXT,thread_root_input_id TEXT);
  CREATE TABLE presentation_change_log(sequence INTEGER PRIMARY KEY,source_table TEXT,row_key TEXT);
  INSERT INTO sessions VALUES(1,'{"inbox":true,"title":"Inbox"}');
  INSERT INTO session_inputs VALUES('i1',1,'input','human','{"text":"A bounded hello"}','2026-10-08T00:00:00Z',NULL);
  INSERT INTO session_owner_events VALUES(1,1,'e1','i1','accepted','{}','2026-10-08T00:00:00Z',NULL);
  INSERT INTO session_owner_events VALUES(2,1,'m1','i1','message','{"message":{"id":"m1","role":"user","content":"A bounded hello"}}','2026-10-08T00:00:01Z',NULL);
  INSERT INTO inbox_topic_roots VALUES('i1','topic1');
  INSERT INTO presentation_change_log VALUES(1,'session_owner_events','1');
  INSERT INTO presentation_change_log VALUES(2,'session_owner_events','2');`);
source.close();
const child=Bun.spawn([process.execPath,join(import.meta.dir,'../src/presentation-message-worker.ts')],
  {env:{...process.env,CONCIERGE_STATE_DIR:dir},stdout:'ignore',stderr:'pipe'});
let result:Database|null=null;
try {
  for(let attempt=0;attempt<50;attempt++){
    await Bun.sleep(100);
    const path=join(dir,'presentation.db');
    if(!existsSync(path))continue;
    const candidate=new Database(path,{readonly:true});
    if(!candidate.query("SELECT 1 FROM sqlite_master WHERE name='presentation_message_meta'").get()){
      candidate.close();continue;
    }
    const meta=candidate.query('SELECT generation,ready FROM presentation_message_meta WHERE singleton=1').get() as {generation:number;ready:number}|null;
    if(meta?.ready){result=candidate;break;}
    candidate.close();
  }
  if(!result)throw new Error('Presentation worker did not publish an indexed generation.');
  const row=result.query('SELECT root_input_id,topic_id FROM presentation_messages WHERE event_sequence=1').get() as
    {root_input_id:string;topic_id:string}|null;
  if(row?.root_input_id!=='i1'||row.topic_id!=='topic1')throw new Error(`Wrong prepared Inbox placement: ${JSON.stringify(row)}`);
  const version=result.query('SELECT message_id FROM presentation_owner_message_versions WHERE event_sequence=2').get() as {message_id:string}|null;
  if(version?.message_id!=='m1')throw new Error('Owner message version was not indexed.');
  const search=result.query("SELECT COUNT(*) AS n FROM prepared_search_documents WHERE kind='input'").get() as {n:number};
  if(search.n!==1)throw new Error('Accepted input was not indexed for search.');
  const reader=Bun.spawn([process.execPath,join(import.meta.dir,'../src/presentation-search-read.ts')],
    {env:{...process.env,CONCIERGE_STATE_DIR:dir},stdin:'pipe',stdout:'pipe',stderr:'pipe'});
  reader.stdin.write(JSON.stringify({query:'bounded',limit:5,includeTools:false}));reader.stdin.end();
  const searchResult=JSON.parse(await new Response(reader.stdout).text());
  if(await reader.exited!==0||searchResult.hits?.[0]?.eventId!=='i1')throw new Error('Isolated search did not find the accepted input.');
  const writer=new Database(join(dir,'state.db'));
  writer.exec(`INSERT INTO session_owner_events VALUES(3,1,'m2','i1','message','{"message":{"id":"m2","role":"assistant","content":"A later answer"}}','2026-10-08T00:00:02Z',NULL);
    INSERT INTO presentation_change_log VALUES(3,'session_owner_events','3');`);
  for(let attempt=0;attempt<50;attempt++){
    const meta=result.query('SELECT event_watermark FROM presentation_message_meta WHERE singleton=1').get() as {event_watermark:number};
    if(meta.event_watermark>=3)break;
    await Bun.sleep(100);
  }
  if(!result.query("SELECT 1 FROM presentation_owner_message_versions WHERE message_id='m2'").get())throw new Error('Live owner version was not appended.');
  writer.exec(`UPDATE inbox_topic_roots SET topic_id='topic2' WHERE root_input_id='i1';
    INSERT INTO presentation_change_log VALUES(4,'inbox_topic_roots','i1');`);
  for(let attempt=0;attempt<50;attempt++){
    const row=result.query('SELECT topic_id FROM presentation_messages WHERE event_sequence=1 AND generation=(SELECT generation FROM presentation_message_meta)').get() as {topic_id:string}|null;
    if(row?.topic_id==='topic2')break;
    await Bun.sleep(100);
  }
  const moved=result.query('SELECT topic_id FROM presentation_messages WHERE event_sequence=1 AND generation=(SELECT generation FROM presentation_message_meta)').get() as {topic_id:string}|null;
  writer.close();
  if(moved?.topic_id!=='topic2')throw new Error('Re-rooting did not publish a new generation.');
  console.log('presentation worker: cold and live messages, owner versions, search and re-root checked');
} finally {
  result?.close();child.kill();await child.exited;
}
