import {Database} from 'bun:sqlite';
import {mkdtempSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'concierge-presentation-check-'));
const source=new Database(join(dir,'state.db'),{create:true});
source.exec(`CREATE TABLE channels(slack_channel_id TEXT PRIMARY KEY,name TEXT,code_path TEXT);
  CREATE TABLE slack_agent_session_title_projections(slack_channel_id TEXT,slack_thread_ts TEXT,desired_title TEXT);
  CREATE TABLE slack_agent_session_status_projections(slack_channel_id TEXT,slack_thread_ts TEXT,initial_title TEXT);
  CREATE TABLE sessions(id INTEGER PRIMARY KEY,native_metadata_json TEXT,slack_channel_id TEXT,slack_thread_ts TEXT,
    provider_id TEXT DEFAULT 'claude-code',status TEXT DEFAULT 'active',agent_session_uuid TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,last_turn_at TEXT);
  CREATE TABLE turns(id INTEGER PRIMARY KEY,agent_text TEXT,session_id INTEGER,status TEXT,started_at TEXT,provider_turn_id TEXT);
  CREATE TABLE session_inputs(id TEXT PRIMARY KEY,session_id INTEGER,kind TEXT,origin TEXT,payload_json TEXT,created_at TEXT,request_id TEXT,
    scope TEXT DEFAULT 'surface:thinkering',action_id TEXT DEFAULT 'test',turn_id INTEGER,source_input_id TEXT,source_run_id TEXT);
  CREATE TABLE session_owner_events(sequence INTEGER PRIMARY KEY,session_id INTEGER,event_id TEXT,input_id TEXT,kind TEXT,payload_json TEXT,created_at TEXT,turn_id INTEGER);
  CREATE TABLE inbox_topic_roots(root_input_id TEXT PRIMARY KEY,topic_id TEXT);
  CREATE TABLE session_communication_requests(request_id TEXT,source_session_id INTEGER,source_turn_id INTEGER,source_input_id TEXT,thread_root_input_id TEXT,target_input_id TEXT,target_session_id INTEGER,payload_json TEXT);
  CREATE TABLE session_peer_requests(request_id TEXT,source_session_id INTEGER,source_turn_id INTEGER,source_input_id TEXT,thread_root_input_id TEXT);
  CREATE TABLE session_external_requests(target_input_id TEXT,agent_name TEXT,text TEXT,request_id TEXT);
  CREATE TABLE session_input_author_corrections(input_id TEXT,author_session_id INTEGER,reason TEXT,created_at TEXT);
  CREATE TABLE session_communication_events(accepted_input_id TEXT,request_id TEXT,payload_json TEXT);
  CREATE TABLE session_peer_events(accepted_input_id TEXT,request_id TEXT,payload_json TEXT);
  CREATE TABLE session_peer_deliveries(target_input_id TEXT,target_session_id INTEGER);
  CREATE TABLE session_attachments(id TEXT PRIMARY KEY,name TEXT,content_type TEXT);
  CREATE TABLE presentation_change_log(sequence INTEGER PRIMARY KEY,source_table TEXT,row_key TEXT,session_id INTEGER,target_session_id INTEGER);
  INSERT INTO sessions(id,native_metadata_json,slack_channel_id,slack_thread_ts) VALUES(1,'{"inbox":true,"title":"Inbox"}',NULL,NULL);
  INSERT INTO session_inputs(id,session_id,kind,origin,payload_json,created_at,request_id) VALUES('i1',1,'input','human','{"text":"A bounded hello"}','2026-10-08T00:00:00Z',NULL);
  INSERT INTO session_owner_events VALUES(1,1,'e1','i1','accepted','{}','2026-10-08T00:00:00Z',NULL);
  INSERT INTO session_owner_events VALUES(2,1,'m1','i1','message','{"message":{"id":"m1","role":"user","content":"A bounded hello"}}','2026-10-08T00:00:01Z',NULL);
  INSERT INTO inbox_topic_roots VALUES('i1','topic1');
  INSERT INTO presentation_change_log(sequence,source_table,row_key) VALUES(1,'session_owner_events','1');
  INSERT INTO presentation_change_log(sequence,source_table,row_key) VALUES(2,'session_owner_events','2');`);
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
  const attributed=JSON.parse((result.query('SELECT display_json FROM presentation_message_display WHERE event_sequence=1')
    .get() as {display_json:string}).display_json);
  if(attributed.author?.kind!=='human'||attributed.author?.via!=='thnkr.ing'||attributed.content!=='A bounded hello')
    throw new Error(`Prepared author/text disagrees with accepted input: ${JSON.stringify(attributed)}`);
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
    INSERT INTO presentation_change_log(sequence,source_table,row_key) VALUES(3,'session_owner_events','3');`);
  for(let attempt=0;attempt<50;attempt++){
    const meta=result.query('SELECT event_watermark FROM presentation_message_meta WHERE singleton=1').get() as {event_watermark:number};
    if(meta.event_watermark>=3)break;
    await Bun.sleep(100);
  }
  if(!result.query("SELECT 1 FROM presentation_owner_message_versions WHERE message_id='m2'").get())throw new Error('Live owner version was not appended.');
  writer.exec(`UPDATE inbox_topic_roots SET topic_id='topic2' WHERE root_input_id='i1';
    INSERT INTO presentation_change_log(sequence,source_table,row_key) VALUES(4,'inbox_topic_roots','i1');`);
  for(let attempt=0;attempt<50;attempt++){
    const row=result.query('SELECT topic_id FROM presentation_messages WHERE event_sequence=1 AND generation=(SELECT generation FROM presentation_message_meta)').get() as {topic_id:string}|null;
    if(row?.topic_id==='topic2')break;
    await Bun.sleep(100);
  }
  const moved=result.query('SELECT topic_id FROM presentation_messages WHERE event_sequence=1 AND generation=(SELECT generation FROM presentation_message_meta)').get() as {topic_id:string}|null;
  const generation=result.query('SELECT generation FROM presentation_message_meta WHERE singleton=1').get() as {generation:number};
  writer.exec(`INSERT INTO session_inputs(id,session_id,kind,origin,payload_json,created_at,request_id) VALUES('i2',1,'input','human','{"text":"Another thread"}','2026-10-08T00:00:03Z',NULL);
    INSERT INTO session_owner_events VALUES(4,1,'e2','i2','accepted','{}','2026-10-08T00:00:03Z',NULL);
    INSERT INTO session_owner_events VALUES(5,1,'link1','i1','thread_link','{"root":"i2","thread":"i2","attached":true}','2026-10-08T00:00:04Z',NULL);
    INSERT INTO inbox_topic_roots VALUES('i2','topic3');
    INSERT INTO presentation_change_log(sequence,source_table,row_key) VALUES(5,'session_inputs','i2');
    INSERT INTO presentation_change_log(sequence,source_table,row_key) VALUES(6,'session_owner_events','4');
    INSERT INTO presentation_change_log(sequence,source_table,row_key) VALUES(7,'session_owner_events','5');
    INSERT INTO presentation_change_log(sequence,source_table,row_key) VALUES(8,'inbox_topic_roots','i2');`);
  for(let attempt=0;attempt<50;attempt++){
    const row=result.query('SELECT root_input_id,topic_id FROM presentation_messages WHERE event_sequence=1 AND generation=1')
      .get() as {root_input_id:string;topic_id:string}|null;
    if(row?.root_input_id==='i2'&&row.topic_id==='topic3')break;
    await Bun.sleep(100);
  }
  const linked=result.query('SELECT root_input_id,topic_id FROM presentation_messages WHERE event_sequence=1 AND generation=1')
    .get() as {root_input_id:string;topic_id:string}|null;
  const linkedDisplay=JSON.parse((result.query('SELECT display_json FROM presentation_message_display WHERE generation=1 AND event_sequence=1')
    .get() as {display_json:string}).display_json);
  if(moved?.topic_id!=='topic2')throw new Error('Re-rooting did not publish a new generation.');
  if(generation.generation!==1)throw new Error('One topic move rebuilt unrelated history.');
  if(linked?.root_input_id!=='i2'||linked.topic_id!=='topic3')throw new Error('Thread-link move was not isolated to the affected root.');
  if(linkedDisplay.replyToMessage?.messageId!=='i2')throw new Error(`Moved message display did not refresh its reply target: ${JSON.stringify(linkedDisplay)}`);
  const longText='long text '.repeat(10_000);
  writer.query(`INSERT INTO session_owner_events(sequence,session_id,event_id,input_id,kind,payload_json,created_at,turn_id)
    VALUES(?,?,?,?,?,?,?,?)`).run(6,1,'long-answer','i1','post',JSON.stringify({text:longText}),
      '2026-10-08T00:00:05Z',null);
  writer.query('INSERT INTO presentation_change_log(sequence,source_table,row_key) VALUES(?,?,?)').run(9,'session_owner_events','6');
  for(let attempt=0;attempt<50;attempt++){
    if(result.query('SELECT 1 FROM presentation_message_display WHERE generation=1 AND event_sequence=6').get())break;
    await Bun.sleep(100);
  }
  const display=result.query('SELECT display_json FROM presentation_message_display WHERE generation=1 AND event_sequence=6')
    .get() as {display_json:string}|null;
  if(!display||Buffer.byteLength(display.display_json)>16_384)throw new Error('Page-ready message exceeded its byte budget.');
  const preview=JSON.parse(display.display_json);
  if(preview.contentCoverage?.code!=='message_preview'||preview.detailRef?.messageId!=='long-answer')
    throw new Error('Oversized message did not preserve an exact detail reference.');
  const chunks=result.query('SELECT part,content,digest FROM presentation_message_detail_chunks WHERE generation=1 AND event_sequence=6 ORDER BY part')
    .all() as {part:number;content:string;digest:string}[];
  if(chunks.length<2||new Set(chunks.map(chunk=>chunk.digest)).size!==1
    ||JSON.parse(chunks.map(chunk=>chunk.content).join('')).content!==longText)
    throw new Error('Exact retained detail did not survive bounded chunks.');
  writer.close();
  console.log('presentation worker: cold and live messages, owner versions, search and re-root checked');
} finally {
  result?.close();child.kill();await child.exited;
}
