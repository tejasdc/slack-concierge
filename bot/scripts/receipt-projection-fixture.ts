import {Database} from 'bun:sqlite';
import {readCompactReceipt} from '../src/prepared-receipt-core';
import {PreparedReceipts,readPreparedReceiptChanges,readPreparedReceiptWindow} from '../src/prepared-receipts';
import {receiptAttachmentProjection} from '../src/receipt-attachments';

const db=new Database(':memory:');
db.exec(`CREATE TABLE sessions(id INTEGER PRIMARY KEY,status TEXT,provider_id TEXT,native_metadata_json TEXT);
  CREATE TABLE turns(id INTEGER PRIMARY KEY,session_id INTEGER,status TEXT,native_run_id TEXT,ended_at TEXT,
    provider_input_acknowledged_at TEXT,agent_text TEXT,dispatch_failure_class TEXT,
    dispatch_next_attempt_ms INTEGER,dispatch_attempt INTEGER,saved_kind TEXT,turn_kind TEXT,
    accepted_input_id TEXT,dispatch_hold TEXT);
  CREATE TABLE session_inputs(id TEXT PRIMARY KEY,session_id INTEGER,kind TEXT,origin TEXT,source_input_id TEXT,
    request_id TEXT,turn_id INTEGER,steering_id INTEGER,created_at TEXT,updated_at TEXT,
    payload_json TEXT,receipt_json TEXT);
  CREATE TABLE session_attachments(id TEXT PRIMARY KEY,name TEXT,content_type TEXT,sha256 TEXT);
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
  CREATE TABLE focus_hold(singleton INTEGER PRIMARY KEY,until_ms INTEGER,label TEXT,since_ms INTEGER,action_id TEXT);
  CREATE TABLE turn_dependencies(turn_id INTEGER,satisfied_at TEXT);`);
db.query('INSERT INTO focus_hold(singleton) VALUES(1)').run();
db.exec(`CREATE TABLE session_peer_deliveries(target_input_id TEXT,peer TEXT,origin_session_id TEXT,
  origin_input_id TEXT,origin_run_id TEXT,requested_effect TEXT,origin_provenance_json TEXT);
  CREATE TABLE session_input_author_corrections(input_id TEXT PRIMARY KEY);`);
db.query('INSERT INTO sessions VALUES(1,?,?,?)').run('active','claude-code','{}');
db.query('INSERT INTO session_attachments VALUES(?,?,?,?)')
  .run('attachment-1','held-note.txt','text/plain','a'.repeat(64));
const crowdedAttachmentIds:string[]=[];
for(let index=0;index<20;index++){
  const id=`crowded-${index}`;crowdedAttachmentIds.push(id);
  db.query('INSERT INTO session_attachments VALUES(?,?,?,?)')
    .run(id,`${'long-name-'.repeat(28)}${index}.txt`,'text/plain',String(index).padStart(64,'0'));
}
db.query(`INSERT INTO turns(id,session_id,status,native_run_id,ended_at,provider_input_acknowledged_at,
  agent_text,dispatch_failure_class,dispatch_next_attempt_ms,dispatch_attempt,saved_kind,turn_kind) VALUES(1,1,?,?,?,?,?,?,?,?,?,?)`)
  .run('running','run-1',null,null,null,null,null,1,null,'native');
db.query('INSERT INTO session_inputs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
  .run('input-1',1,'input','human',null,null,1,null,'2026-10-08T00:00:00Z','2026-10-08T00:00:00Z',
    JSON.stringify({text:'x'.repeat(20000),attachments:['attachment-1']}),null);
db.query('INSERT INTO provider_retry_incarnation VALUES(1,?)').run('owner-a');
db.query('INSERT INTO provider_retry_observations VALUES(1,?,?,?,?,?,?)')
  .run('owner-a',Date.now(),2,4,529,Date.now()+10000);
const receipt=()=>readCompactReceipt(db,'input-1')!;
const expect=(condition:unknown,description:string)=>{if(!condition)throw new Error(description);};
expect(receipt().statusDetail?.code==='PROVIDER_RETRYING','live retry remains visible');
expect(receipt().statusDetail?.automaticRetry===true,'retry tells the truth about automatic retry');
expect(JSON.stringify(receipt().attachments)===JSON.stringify([
  {id:'attachment-1',name:'held-note.txt',contentType:'text/plain',sha256:'a'.repeat(64)}
]),'compact receipt publishes ordered retained attachment metadata');
expect(Buffer.byteLength(JSON.stringify(receipt()))<4096,'retained text remains outside receipt window');
db.query('INSERT INTO session_inputs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
  .run('crowded-input',1,'input','agent',null,null,null,null,'2026-10-08T00:00:30Z','2026-10-08T00:00:30Z',
    JSON.stringify({text:'Many retained files',attachments:crowdedAttachmentIds}),JSON.stringify({state:'waiting'}));
const crowded=readCompactReceipt(db,'crowded-input')!;
expect(crowded.attachmentsCoverage.complete===false&&crowded.attachmentsCoverage.count===crowdedAttachmentIds.length,
  'an unbounded attachment list becomes an explicit bounded prepared prefix');
expect(crowded.attachments.length>0&&crowded.attachments.length<crowdedAttachmentIds.length,
  'the bounded prepared prefix remains useful without pretending to be exhaustive');
expect(Buffer.byteLength(JSON.stringify(crowded))<4096,'many long attachment names cannot overflow a prepared card');
expect(receiptAttachmentProjection(db,'input',{attachments:crowdedAttachmentIds}).attachments.length===crowdedAttachmentIds.length,
  'the exact attachment projection remains exhaustive');
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
db.query("UPDATE sessions SET status='active' WHERE id=1").run();
db.query("UPDATE turns SET status='error',ended_at='2026-10-08T00:02:00Z',agent_text='ChatGptDispatchError: CHATGPT_SEND_FAILED' WHERE id=1").run();
expect(receipt().statusDetail?.code==='CHATGPT_SEND_FAILED','the exact ChatGPT failure stays machine-readable');
expect(receipt().statusDetail?.message==='The ChatGPT send stopped before Send, so no message reached ChatGPT. This input will not be retried automatically.',
  'the ChatGPT send code is translated for a person');
expect(receipt().errorPreview==='ChatGptDispatchError: CHATGPT_SEND_FAILED','the raw ChatGPT failure stays available for diagnosis');
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

db.query('INSERT INTO session_inputs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
  .run('held-input',1,'input','agent',null,null,null,null,'2026-10-08T00:03:00Z','2026-10-08T00:03:00Z',
    JSON.stringify({text:'Held with its file',attachments:['attachment-1']}),JSON.stringify({state:'waiting'}));
const prepared=new Database(':memory:'),projection=new PreparedReceipts(db,prepared),generation=projection.nextGeneration();
projection.beginRebuild(generation);
for(let after=0;;){const page=projection.rebuildPage(generation,after,20);after=page.lastRowid;if(!page.hasMore)break;}
projection.activate(generation,100,'fixture-revision');
const window=readPreparedReceiptWindow(prepared,1,100,null,40),held=window.operations.find(item=>item.operationId==='held-input');
expect(held?.state==='waiting','historical held receipt rebuild preserves its waiting state');
expect(held?.attachments[0]?.id==='attachment-1'&&held.attachments[0]?.sha256==='a'.repeat(64),
  'prepared receipt window carries the retained attachment reference');
const crowdedPrepared=window.operations.find(item=>item.operationId==='crowded-input');
expect(crowdedPrepared?.attachmentsCoverage.complete===false&&crowdedPrepared.attachmentsCoverage.count===20,
  'historical rebuild retains explicit incomplete coverage for an oversized attachment list');
db.query("UPDATE session_inputs SET updated_at='2026-10-08T00:04:00Z' WHERE id='held-input'").run();
projection.apply(generation,[{sequence:101,source_table:'session_inputs',row_key:'held-input',session_id:1,
  input_id:'held-input',target_input_id:null,turn_id:null,request_id:null}]);
projection.checkpoint(generation,101);
const changes=readPreparedReceiptChanges(prepared,1,101,window.asOf,40),changed=changes.operations.find(item=>item.operationId==='held-input');
expect(changed?.attachments[0]?.name==='held-note.txt'&&changed.attachments[0]?.contentType==='text/plain',
  'prepared receipt change page carries the same retained attachment reference');
console.log('receipt-projection: retry set, restart, clear, hold, readable ChatGPT failure and bounded preview passed');
