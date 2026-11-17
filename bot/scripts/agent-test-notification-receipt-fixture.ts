import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LEGACY_TOPIC_COMPLETION_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'concierge-agent-test-notification-'));
Object.assign(process.env,{CONCIERGE_STATE_DIR:scratch,CONCIERGE_CAPTURE_STATE_DIR:join(scratch,'capture'),CONCIERGE_TEST_MODE:'1',CONCIERGE_TEST_AUTHORIZATION:LEGACY_TOPIC_COMPLETION_TEST_AUTHORIZATION});
const [{db,claimNextQueuedTurn,markTurnProviderAdmissionIntended,acknowledgeTurnProviderInput},{SessionOwner},{nativeRunId}]=await Promise.all([
 import('../src/state'),import('../src/session-owner'),import('../src/session-inputs')]);
const workspace=join(scratch,'workspace');mkdirSync(join(workspace,'slack-inbox','.git'),{recursive:true});
writeFileSync(join(workspace,'slack-inbox','AGENTS.md'),'Disposable Inbox fixture.\n');
const owner=new SessionOwner({available:()=>true,wake:()=>{},steer:()=>false,stop:async()=>false},workspace);
try{
 await owner.create({clientActionId:'marked-source',provider:'codex',purpose:'chat',firstInput:{text:'Exercise marked notification receipts.'}});
 const claim=claimNextQueuedTurn('agent-test-notification-fixture');assert.ok(claim);
 assert.equal(markTurnProviderAdmissionIntended(claim.turn_id,'agent-test-notification-fixture',claim.dispatch_attempt),true);
 acknowledgeTurnProviderInput(claim.turn_id,'agent-test-notification-fixture',claim.dispatch_attempt,[]);
 const agentSource={inputId:claim.accepted_input_id!,runId:nativeRunId(claim.turn_id)};
 const probes=[
  ['Fix the login bug and notify me when it is done','result'],
  ['Fix the login bug, notify me when it is done','result'],
  ['Fix this, and send me a notification when done','result'],
  ['Fix it and ping me once done','result'],
  ['Did you notify me?',null],
 ] as const;
 for(const [index,[text,classification]] of probes.entries()){
  const body={source:{kind:'monologue',id:`probe-${index}`,recordedAt:'2026-11-17T12:00:00.000Z',metadata:{agentSource}},text,files:[]};
  const receipt=owner.acceptInboxCapture(body);
  assert.deepEqual(receipt.agentTest,{notificationRequest:classification,humanNotificationArmed:false});
  assert.equal(receipt.operation.origin,'agent');assert.equal(receipt.operation.humanAuthored,false);
  assert.equal(receipt.operation.notificationRequest,null,'Diagnostic classification never becomes human admission authority');
  const retained=db.query('SELECT * FROM session_inputs WHERE id=?').get(receipt.operation.id) as any;
  assert.equal(retained.origin,'agent');assert.equal(retained.turn_id,null);assert.equal(retained.source_input_id,agentSource.inputId);
  assert.equal(retained.source_run_id,agentSource.runId);assert.equal(Object.hasOwn(JSON.parse(retained.payload_json),'notificationRequest'),false);
  assert.deepEqual(owner.acceptInboxCapture(body).agentTest,receipt.agentTest,'Exact retry returns retained classification');
  assert.throws(()=>owner.acceptInboxCapture({...body,text:'Different words'}),/Idempotency conflict/);
 }
 assert.equal(db.query('SELECT count(*) AS n FROM inbox_thread_notifications').get().n,0,'No marked probe arms phone delivery');
 assert.equal(db.query("SELECT count(*) AS n FROM session_owner_events WHERE kind='needs_you'").get().n,0);
 assert.throws(()=>owner.acceptInboxCapture({source:{kind:'monologue',id:'wrong-source',recordedAt:'2026-11-17T12:00:00.000Z',metadata:{agentSource:{...agentSource,runId:'wrong-run'}}},text:probes[0][0]}),/run that accepted/);
 assert.throws(()=>owner.acceptInboxCapture({source:{kind:'agent-report',id:'report-as-import',title:'Disposable report',recordedAt:'2026-11-17T12:00:00.000Z',metadata:{agentSource}},text:probes[0][0],importOnly:true}),/agent report must enter the Inbox router/);
 const unmarked=owner.acceptInboxCapture({source:{kind:'monologue',id:'unmarked-note',recordedAt:'2026-11-17T12:00:00.000Z'},text:'A retained ordinary note',importOnly:true});
 assert.equal(unmarked.agentTest,undefined,'Unmarked import cannot obtain marked-test annotation');
 assert.equal(unmarked.operation.origin,'human');
 console.log(JSON.stringify({fixture:'agent-test-notification-receipt',probes:probes.length,agentProvenance:true,noHumanMarks:true,noArms:true,invalidSourceRefused:true,exactRetry:true}));
}finally{rmSync(scratch,{recursive:true,force:true});}
