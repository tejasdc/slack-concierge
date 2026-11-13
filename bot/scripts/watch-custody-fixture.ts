import assert from 'node:assert/strict';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeWatchCustody,inspectWatchPair,reconcileWatchPair} from '../src/watch-custody';
import {parseRouterSessionsArgs as parseSessionArgs} from './router-sessions';

// Native SQLite fixture, no provider, account, production ledger or watched path access.
const scratch=mkdtempSync(join(tmpdir(),'watch-custody-'));
const path=join(scratch,'fixture.db');
let db=new Database(path);
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL');
const source={sessionId:9661,inputId:'implementation',runId:'impl-run'};
const pair={oldWatchId:'old',newWatchId:'new'};
function reset(){
  db.exec(`DROP TABLE IF EXISTS watch_custody_operations; DROP TABLE IF EXISTS watches;
    DROP TABLE IF EXISTS session_inputs; DROP TABLE IF EXISTS turns;
    DROP TABLE IF EXISTS session_communication_requests; DROP TABLE IF EXISTS provider_recovery_sessions;
    DROP TABLE IF EXISTS provider_recovery_inputs; DROP TABLE IF EXISTS session_input_author_corrections;
    CREATE TABLE watches(watch_id TEXT PRIMARY KEY,session_id INTEGER,origin_input_id TEXT,origin_run_id TEXT,action_id TEXT,
      kind TEXT,condition_json TEXT,runner TEXT,state TEXT,baseline_json TEXT,baseline_mode TEXT,deadline_ms INTEGER,
      renew_ms INTEGER,series_id TEXT,created_at_ms INTEGER,terminal_event TEXT,terminal_at_ms INTEGER,
      delivery_state TEXT,delivery_input_id TEXT,message_text TEXT,observation_json TEXT);
    CREATE TABLE session_inputs(id TEXT PRIMARY KEY,session_id INTEGER,origin TEXT,kind TEXT,source_input_id TEXT,
      source_run_id TEXT,request_id TEXT,turn_id INTEGER,steering_id INTEGER,receipt_json TEXT,payload_json TEXT,scope TEXT DEFAULT 'fixture');
    CREATE TABLE turns(id INTEGER PRIMARY KEY,session_id INTEGER,native_run_id TEXT,status TEXT);
    CREATE TABLE session_communication_requests(request_id TEXT,target_input_id TEXT,target_session_id INTEGER,
      source_input_id TEXT,source_session_id INTEGER,source_turn_id INTEGER,payload_json TEXT);
    CREATE TABLE provider_recovery_sessions(source_session_id INTEGER,successor_session_id INTEGER,generation INTEGER);
    CREATE TABLE provider_recovery_inputs(source_input_id TEXT,source_turn_id INTEGER,source_session_id INTEGER,
      successor_input_id TEXT,successor_turn_id INTEGER,successor_session_id INTEGER);
    CREATE TABLE session_input_author_corrections(input_id TEXT);
    INSERT INTO provider_recovery_sessions VALUES(9527,9654,1);
    INSERT INTO provider_recovery_inputs VALUES('original-assignment',2,9527,'recovered-assignment',3,9654);`);
  initializeWatchCustody(db);
  const input=(id:string,session:number,turn:number,run:string,origin:string,parent:string|null=null,parentRun:string|null=null,request:string|null=null)=>{
    db.query("INSERT INTO session_inputs VALUES(?,?,?,?,?,?,?,?,NULL,NULL,?,'fixture')")
      .run(id,session,origin,'input',parent,parentRun,request,turn,JSON.stringify({text:'private dialogue never returned'}));
    db.query("INSERT INTO turns VALUES(?,?,?,'running')").run(turn,session,run);
  };
  input('current-human',9606,1,'human-run','human');
  input('original-assignment',9527,2,'old-run','agent','current-human','human-run','a');
  input('recovered-assignment',9654,3,'recovery-run','agent','current-human','human-run','a');
  db.exec("UPDATE session_inputs SET scope='provider-recovery:9527' WHERE id='recovered-assignment'");
  input('inbox-work',9606,4,'inbox-run','agent','recovered-assignment','recovery-run','b');
  input('designer',9660,5,'designer-run','agent','inbox-work','inbox-run','c');
  input('implementation',9661,6,'impl-run','agent','designer','designer-run','d');
  const request=(id:string,target:string,to:number,parent:string,from:number,turn:number)=>
    db.query('INSERT INTO session_communication_requests VALUES(?,?,?,?,?,?,?)').run(id,target,to,parent,from,turn,JSON.stringify({requestedEffect:'work'}));
  request('a','original-assignment',9527,'current-human',9606,1);
  // Exhaustion recovery retargets the canonical request to the successor input/session.
  db.exec("UPDATE session_communication_requests SET target_input_id='recovered-assignment',target_session_id=9654 WHERE request_id='a'");
  request('b','inbox-work',9606,'recovered-assignment',9654,3);
  request('c','designer',9660,'inbox-work',9606,4);
  request('d','implementation',9661,'designer',9660,5);
  // The predecessor watch predates the current human task. Shared human roots are deliberately absent.
  input('yesterday-human',9527,7,'yesterday-run','human');
  for(const [id,session,origin,renew] of [['old',9527,'yesterday-human',null],['new',9654,'recovered-assignment',1000]] as const){
    db.query(`INSERT INTO watches(watch_id,session_id,origin_input_id,origin_run_id,action_id,kind,condition_json,state,
      baseline_json,baseline_mode,deadline_ms,renew_ms,created_at_ms) VALUES(?,?,?,?,?,'file',?,'accepted',?,'content-hash',10000,?,0)`)
      .run(id,session,origin,session===9527?'yesterday-run':'recovery-run',`register-${id}`,JSON.stringify({path:'/not-read/credentials.json'}),JSON.stringify({digest:'private-baseline'}),renew);
  }
}
const inspect=()=>inspectWatchPair(db,source,pair);
const reconcile=(action='retire',inspection=inspect().inspection)=>reconcileWatchPair(db,source,pair,action,inspection,500);
const rows=(table:string)=>db.query(`SELECT * FROM ${table} ORDER BY rowid`).all();
const unchanged=(table:string,run:()=>void)=>{const before=rows(table);run();assert.deepEqual(rows(table),before);};
let checks=0;
try{
  reset();
  const cli=['watch','inspect-pair','--old','old','--new','new','--source-input',source.inputId,'--source-run',source.runId];
  assert.equal(parseSessionArgs(cli).operation,'watch');
  assert.throws(()=>parseSessionArgs([...cli,'--until','1d']));
  const first=inspect();
  assert.equal(first.lineage.humanInputId,'current-human');
  assert.equal(first.lineage.edges.filter((e:any)=>e.kind==='work').length,4);
  assert.equal(first.old.originInputId,'yesterday-human');
  assert(!JSON.stringify(first).includes('private-baseline'));
  assert(!JSON.stringify(first).includes('private dialogue'));
  checks++;
  reset();db.exec("UPDATE session_communication_requests SET target_input_id='original-assignment',target_session_id=9527 WHERE request_id='a'");
  assert.equal(inspect().lineage.humanInputId,'current-human'); // Retained older target shape also remains valid.
  reset();db.exec(`DELETE FROM provider_recovery_sessions; DELETE FROM provider_recovery_inputs;
    INSERT INTO provider_recovery_sessions VALUES(9527,9600,1),(9600,9654,1);
    INSERT INTO turns VALUES(10,9600,'mid-run','done');
    INSERT INTO session_inputs VALUES('mid-assignment',9600,'agent','input','current-human','human-run','a',10,NULL,NULL,'{}','provider-recovery:9527');
    INSERT INTO provider_recovery_inputs VALUES('original-assignment',2,9527,'mid-assignment',10,9600),('mid-assignment',10,9600,'recovered-assignment',3,9654);`);
  assert.equal(inspect().lineage.edges.filter((e:any)=>e.kind==='recovery').length,2);
  reset();
  // Exact retained delegation through Inbox succeeds; an unrelated actor or informational hop cannot.
  assert.throws(()=>inspectWatchPair(db,{...source,sessionId:999},pair),/custody/);
  db.exec(`INSERT INTO session_inputs VALUES('unrelated',777,'agent','input','current-human','human-run','unrelated-ask',9,NULL,NULL,'{}','fixture');
    INSERT INTO turns VALUES(9,777,'unrelated-run','running');
    INSERT INTO session_communication_requests VALUES('unrelated-ask','unrelated',777,'current-human',9606,1,'{"requestedEffect":"work"}');`);
  assert.throws(()=>inspectWatchPair(db,{sessionId:777,inputId:'unrelated',runId:'unrelated-run'},pair),/custody/);
  db.query("UPDATE session_communication_requests SET payload_json=? WHERE request_id='b'").run(JSON.stringify({requestedEffect:'informational'}));
  assert.throws(inspect,/custody/);
  reset();db.query("DELETE FROM provider_recovery_inputs").run();assert.throws(inspect,/custody/);
  reset();db.query("DELETE FROM provider_recovery_sessions").run();assert.throws(inspect,/custody/);
  reset();db.exec("INSERT INTO provider_recovery_sessions VALUES(9527,777,2); UPDATE watches SET session_id=777 WHERE watch_id='old'");
  assert.throws(inspect,/custody/); // Sibling continuation is not an ancestor.
  reset();db.query("UPDATE session_inputs SET source_run_id='forged' WHERE id='designer'").run();assert.throws(inspect,/custody/);
  reset();db.query("UPDATE session_inputs SET source_input_id='implementation' WHERE id='designer'").run();assert.throws(inspect,/custody/);
  checks++;
  for(const update of ["kind='command'","condition_json='{}'","runner='mac'"]){
    reset();db.exec(`UPDATE watches SET ${update} WHERE watch_id='old'`);assert.throws(inspect,/same condition and machine/);
  }
  reset();const stale=inspect().inspection;db.exec("UPDATE watches SET deadline_ms=11000 WHERE watch_id='new'");
  assert.throws(()=>reconcile('stale',stale),/changed/);checks++;
  reset();const next=rows('watches')[1],inputs=rows('session_inputs'),token=inspect().inspection;
  const result=reconcile('retire',token);
  assert.equal(result.retiredWatchId,'old');assert.equal(result.after.activeMatches.length,1);
  assert.equal(result.after.activeMatches[0]!.id,'new');assert.deepEqual(rows('watches')[1],next);
  assert.deepEqual(rows('session_inputs'),inputs);
  const retired=rows('watches')[0] as any;assert.equal(retired.delivery_state,null);assert.equal(retired.delivery_input_id,null);
  assert.equal(retired.message_text,null);assert.equal(retired.renew_ms,null);
  db.close();db=new Database(path); // Response lost, process restarted; return the durable receipt verbatim.
  assert.deepEqual(reconcile('retire',token),result);
  assert.equal(rows('watch_custody_operations').length,1);
  assert.throws(()=>reconcile('retire','changed-inspection'),/Idempotency conflict/);checks++;
  for(const delivery of ['pending','accepted']){
    reset();db.query(`UPDATE watches SET state='fired',terminal_event='fired',terminal_at_ms=100,delivery_state=?,
      delivery_input_id='watch:old:fired',message_text='accepted original firing',observation_json='{"original":true}' WHERE watch_id='old'`).run(delivery);
    db.query(`INSERT INTO session_inputs VALUES('watch:old:fired',9527,'service','input','yesterday-human','yesterday-run','watch:old:fired',8,NULL,?,?,'fixture')`)
      .run(JSON.stringify({state:delivery,text:'secret receipt field'}),JSON.stringify({text:'accepted firing payload'}));
    db.exec("INSERT INTO turns VALUES(8,9527,'firing-run','queued')");
    unchanged('watches',()=>unchanged('session_inputs',()=>{
      const receipt=reconcile();assert.equal(receipt.retiredWatchId,null);assert.equal(receipt.after.acceptedInputs.length,1);
      assert(!JSON.stringify(receipt).includes('secret receipt field'));
    }));
  }
  checks++;
  // An old renewing series may have fired; retire only its still-active successor, keeping the firing.
  reset();db.exec("UPDATE watches SET state='fired',terminal_event='fired',delivery_state='pending',renew_ms=1000 WHERE watch_id='old'");
  db.exec("INSERT INTO watches SELECT 'old-successor',session_id,origin_input_id,origin_run_id,'renew:old',kind,condition_json,runner,'accepted',baseline_json,baseline_mode,deadline_ms,renew_ms,'old',1,NULL,NULL,NULL,NULL,NULL,NULL FROM watches WHERE watch_id='old'");
  const terminal=rows('watches')[0];assert.equal(reconcile().retiredWatchId,'old-successor');assert.deepEqual(rows('watches')[0],terminal);checks++;
  // A receipt failure rolls the retirement back. No custom fault hook enters production code.
  reset();const before=rows('watches');db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON watch_custody_operations BEGIN SELECT RAISE(ABORT,'receipt failure'); END");
  assert.throws(()=>reconcile(),/receipt failure/);assert.deepEqual(rows('watches'),before);assert.equal(rows('watch_custody_operations').length,0);checks++;
  reset();db.exec("UPDATE watches SET renew_ms=NULL WHERE watch_id='new'");assert.throws(()=>reconcile(),/active renewing/);
  reset();db.exec("UPDATE watches SET state='fired' WHERE watch_id='new'");assert.throws(()=>reconcile(),/active renewing/);checks++;
  reset();db.exec("INSERT INTO watches SELECT 'additional',session_id,origin_input_id,origin_run_id,'another',kind,condition_json,runner,state,baseline_json,baseline_mode,deadline_ms,NULL,NULL,2,NULL,NULL,NULL,NULL,NULL,NULL FROM watches WHERE watch_id='old'");
  assert.throws(()=>reconcile(),/Additional active matches/);checks++;
  console.log(JSON.stringify({check:'source-bound-watch-custody',status:'passed',groups:checks,
    productionAccess:false,terminalHistoryPreserved:true,responseLossReceiptRecovered:true,atomicRollback:true}));
}finally{db.close();rmSync(scratch,{recursive:true,force:true});}
