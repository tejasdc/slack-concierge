import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

const scratch=mkdtempSync(join(tmpdir(),'concierge-legacy-topic-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';

const [{db,claimNextQueuedTurn,markTurnProviderAdmissionIntended,acknowledgeTurnProviderInput},
  {SessionOwner},{SessionCommunicationCoordinator},{nativeRunId,retainSessionInput,updateSessionMetadata},
  {topicsCommand}]=await Promise.all([
  import('../src/state'),import('../src/session-owner'),import('../src/session-communication'),
  import('../src/session-inputs'),import('../src/session-topics')]);

const errors:unknown[]=[];
const owner=new SessionOwner({available:()=>true,wake:()=>{},stop:async()=>false,steer:()=>false},scratch);
const communication=new SessionCommunicationCoordinator({owner,isOwnerAlive:()=>true,onError:error=>errors.push(error)});
owner.communication=communication;

function run(){
  const claim=claimNextQueuedTurn('legacy-topic-fixture');
  assert.ok(claim);
  assert.equal(markTurnProviderAdmissionIntended(claim.turn_id,'legacy-topic-fixture',claim.dispatch_attempt),true);
  acknowledgeTurnProviderInput(claim.turn_id,'legacy-topic-fixture',claim.dispatch_attempt,[]);
  const runId=nativeRunId(claim.turn_id),inputId=claim.accepted_input_id!;
  return {actor:{sessionId:claim.session_id,turnId:claim.turn_id,inputId,runId},source:{input_id:inputId,run_id:runId}};
}

try {
  communication.start();await communication.idle();
  const inbox=owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text:'Reconcile retained work'}});
  const inboxId=Number(inbox.session.id.slice(10));updateSessionMetadata(inboxId,{inbox:true});
  const current=run();
  const root=retainSessionInput({sessionId:inboxId,scope:'surface:thinkering',actionId:'legacy-human-root',kind:'input',origin:'human',payload:{text:'Check why my message stayed queued.'}}).input;
  const created=topicsCommand(current.actor,{verb:'create',action_id:'legacy-topic',title:'Queued message',roots:[root.id]});
  const topicId=created.topic.topicId;
  const added=topicsCommand(current.actor,{verb:'request.add',request_id:topicId,action_id:'legacy-request',title:'Explain and resolve the queue',
    sources:[root.id],brief:'Check the queue, recover it if needed, and explain the outcome.'});
  const requestId=added.request.requestId;

  const target=owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat'});
  const dispatch=await communication.ask({source:current.source,action_id:'legacy-dispatch',address:target.session.address,
    thread:root.id,text:'Inspect the queued message and resolve it.',requestedEffect:'informational'});
  await communication.idle();const worker=run();
  communication.reply({source:worker.source,action_id:'legacy-final',request_id:dispatch.request_id,
    text:'The deployment hold released, the message drained, and no change was needed.',final:true});
  await communication.idle();
  const finalEvent=communication.inspect(dispatch.request_id).events.find(event=>event.kind==='final');
  assert.ok(finalEvent);
  db.query("UPDATE session_communication_requests SET payload_json=json_set(payload_json,'$.requestedEffect','work') WHERE request_id=?")
    .run(dispatch.request_id);
  topicsCommand(current.actor,{verb:'request.link',request_id:requestId,action_id:'legacy-link',dispatch:dispatch.request_id});

  db.query("UPDATE session_communication_requests SET outcome='undetermined' WHERE request_id=?").run(dispatch.request_id);
  assert.throws(()=>topicsCommand(current.actor,{verb:'request.close',request_id:requestId,action_id:'uncertain-close',disposition:'completed',
    evidence:[finalEvent.event_id],reason:'The retained answer was checked against this request.'}),/has not finished/);

  db.query("UPDATE session_communication_requests SET outcome='answered' WHERE request_id=?").run(dispatch.request_id);
  assert.throws(()=>topicsCommand(current.actor,{verb:'request.close',request_id:requestId,action_id:'wrong-answer-close',disposition:'completed',
    evidence:['different-final'],reason:'The retained answer was checked against this request.'}),/has not finished/);

  const closed=topicsCommand(current.actor,{verb:'request.close',request_id:requestId,action_id:'exact-answer-close',disposition:'completed',
    evidence:[finalEvent.event_id],reason:'The exact retained answer shows the queue drained and no change was needed.'});
  assert.equal(closed.request.requestId,requestId);assert.equal(closed.request.state,'closed');assert.equal(closed.request.disposition,'completed');
  assert.deepEqual(closed.request.closure.evidence,[finalEvent.event_id]);
  const historical=db.query('SELECT outcome,result_json FROM session_communication_requests WHERE request_id=?').get(dispatch.request_id) as {outcome:string;result_json:string};
  assert.equal(historical.outcome,'answered');assert.equal(JSON.parse(historical.result_json).workDisposition,undefined);
  assert.deepEqual(db.query('SELECT count(*) AS n FROM session_communication_requests WHERE request_id=?').get(dispatch.request_id),{n:1});
  assert.deepEqual(errors,[]);
  console.log('Legacy topic completion fixture passed: uncertain and unrelated evidence stayed open; the exact retained final closed once without redispatch.');
} finally {
  await communication.stop();
  rmSync(scratch,{recursive:true,force:true});
}
