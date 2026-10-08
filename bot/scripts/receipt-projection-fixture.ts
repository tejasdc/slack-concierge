import {Database} from 'bun:sqlite';
import {readCompactReceipt} from '../src/prepared-receipt-core';

const db=new Database(':memory:');
db.exec(`CREATE TABLE sessions(id INTEGER PRIMARY KEY,status TEXT,provider_id TEXT,native_metadata_json TEXT);
  CREATE TABLE turns(id INTEGER PRIMARY KEY,session_id INTEGER,status TEXT,native_run_id TEXT,ended_at TEXT,
    provider_input_acknowledged_at TEXT,agent_text TEXT,dispatch_failure_class TEXT,
    dispatch_next_attempt_ms INTEGER,dispatch_attempt INTEGER,saved_kind TEXT,turn_kind TEXT,
    accepted_input_id TEXT,dispatch_hold TEXT);
  CREATE TABLE session_inputs(id TEXT PRIMARY KEY,session_id INTEGER,kind TEXT,origin TEXT,source_input_id TEXT,
    request_id TEXT,turn_id INTEGER,steering_id INTEGER,created_at TEXT,updated_at TEXT,
    payload_json TEXT,receipt_json TEXT);
  CREATE TABLE turn_steering_messages(id INTEGER PRIMARY KEY,status TEXT,provider_sent_at TEXT,error TEXT);
  CREATE TABLE session_communication_requests(request_id TEXT PRIMARY KEY,target_input_id TEXT,payload_json TEXT,
    outcome TEXT,target_session_id INTEGER,source_input_id TEXT,result_json TEXT);
  CREATE TABLE session_peer_requests(request_id TEXT PRIMARY KEY,outcome TEXT,remote_session_id TEXT,
    remote_address TEXT,source_input_id TEXT,result_json TEXT);
  CREATE TABLE provider_outage_offers(turn_id INTEGER PRIMARY KEY,payload_json TEXT,choice TEXT,chosen_at TEXT,rerun_session_id TEXT);
  CREATE TABLE provider_retry_incarnation(singleton INTEGER PRIMARY KEY,incarnation TEXT);
  CREATE TABLE provider_retry_observations(turn_id INTEGER PRIMARY KEY,incarnation TEXT,since_ms INTEGER,
    attempt INTEGER,max_retries INTEGER,status INTEGER,retry_at_ms INTEGER);
  CREATE TABLE session_owner_events(sequence INTEGER PRIMARY KEY,session_id INTEGER,kind TEXT,input_id TEXT,payload_json TEXT);
  CREATE TABLE deployment_drain(singleton INTEGER PRIMARY KEY);
  CREATE TABLE turn_dependencies(turn_id INTEGER,satisfied_at TEXT);`);
db.exec(`CREATE TABLE session_peer_deliveries(target_input_id TEXT,peer TEXT,origin_session_id TEXT,
  origin_input_id TEXT,origin_run_id TEXT,requested_effect TEXT,origin_provenance_json TEXT);
  CREATE TABLE session_input_author_corrections(input_id TEXT PRIMARY KEY);`);
db.query('INSERT INTO sessions VALUES(1,?,?,?)').run('active','claude-code','{}');
db.query(`INSERT INTO turns(id,session_id,status,native_run_id,ended_at,provider_input_acknowledged_at,
  agent_text,dispatch_failure_class,dispatch_next_attempt_ms,dispatch_attempt,saved_kind,turn_kind) VALUES(1,1,?,?,?,?,?,?,?,?,?,?)`)
  .run('running','run-1',null,null,null,null,null,1,null,'native');
db.query('INSERT INTO session_inputs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
  .run('input-1',1,'input','human',null,null,1,null,'2026-10-08T00:00:00Z','2026-10-08T00:00:00Z',
    JSON.stringify({text:'x'.repeat(20000)}),null);
db.query('INSERT INTO provider_retry_incarnation VALUES(1,?)').run('owner-a');
db.query('INSERT INTO provider_retry_observations VALUES(1,?,?,?,?,?,?)')
  .run('owner-a',Date.now(),2,4,529,Date.now()+10000);
const receipt=()=>readCompactReceipt(db,'input-1')!;
const expect=(condition:unknown,description:string)=>{if(!condition)throw new Error(description);};
expect(receipt().statusDetail?.code==='PROVIDER_RETRYING','live retry remains visible');
expect(receipt().statusDetail?.automaticRetry===true,'retry tells the truth about automatic retry');
expect(Buffer.byteLength(JSON.stringify(receipt()))<4096,'retained text remains outside receipt window');
db.query('UPDATE provider_retry_incarnation SET incarnation=? WHERE singleton=1').run('owner-b');
expect(receipt().statusDetail===null,'old owner retry is never shown after restart');
db.query('UPDATE provider_retry_observations SET incarnation=? WHERE turn_id=1').run('owner-b');
expect(receipt().statusDetail?.code==='PROVIDER_RETRYING','new owner retry observation is visible');
db.query('DELETE FROM provider_retry_observations WHERE turn_id=1').run();
expect(receipt().statusDetail===null,'cleared retry disappears');
const later=Date.now()+30000;
db.query("UPDATE turns SET status='queued',dispatch_failure_class='backoff',dispatch_next_attempt_ms=?,agent_text='API Error: 529' WHERE id=1")
  .run(later);
expect(receipt().statusDetail?.code==='RETRY_SCHEDULED'&&receipt().nextRefreshAtMs===later,
  'time-changing backoff explanation names its next refresh');
db.query("UPDATE turns SET status='queued',dispatch_failure_class='auth_wait' WHERE id=1").run();
expect(receipt().statusDetail?.code==='PROVIDER_AUTH_HELD','queued sign-in hold remains visible');
db.query("UPDATE turns SET dispatch_failure_class=NULL WHERE id=1").run();
db.query("UPDATE sessions SET status='archived' WHERE id=1").run();
expect(receipt().statusDetail?.code==='SESSION_PAUSED','paused session remains visible');
db.query('INSERT INTO turns(id,session_id,status,native_run_id,provider_input_acknowledged_at,accepted_input_id) VALUES(2,1,?,?,?,?)')
  .run('done','run-2','2026-10-08T00:01:00Z','input-2');
db.query('INSERT INTO session_inputs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
  .run('input-2',1,'request','agent',null,'request-2',null,null,'2026-10-08T00:00:00Z','2026-10-08T00:00:00Z',
    JSON.stringify({text:'request body'}),null);
db.query('INSERT INTO session_communication_requests VALUES(?,?,?,?,?,?,?)')
  .run('request-2','input-2','{}','answered',1,'input-1',JSON.stringify({text:'answer'}));
const request=readCompactReceipt(db,'input-2')!;
expect(request.state==='completed'&&request.acknowledgedAt==='2026-10-08T00:01:00.000Z',
  'a request keeps its terminal outcome and the recipient acknowledgement');
db.query('INSERT INTO provider_outage_offers VALUES(?,?,?,?,?)')
  .run(1,JSON.stringify({offeredAt:'2026-10-08T00:00:00Z',provider:'claude-code',model:null,status:529,
    incident:{name:'x'.repeat(4000)},alternatives:[]}),null,null,null);
expect(Buffer.byteLength(JSON.stringify(receipt()))<4096,'a large incident title cannot stall the projection');
console.log('receipt-projection: retry set, restart, clear, hold and bounded preview passed');
