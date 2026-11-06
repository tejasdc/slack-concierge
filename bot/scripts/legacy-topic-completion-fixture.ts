import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LEGACY_TOPIC_COMPLETION_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'concierge-legacy-topic-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=LEGACY_TOPIC_COMPLETION_TEST_AUTHORIZATION;

const [{db,claimNextQueuedTurn,markTurnProviderAdmissionIntended,acknowledgeTurnProviderInput},
  {SessionOwner},{SessionCommunicationCoordinator},{nativeRunId,updateSessionMetadata},
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
  const rootId=current.actor.inputId;
  const area=topicsCommand(current.actor,{verb:'area.create',action_id:'legacy-area',name:'Legacy completion fixture'}).area;
  const created=topicsCommand(current.actor,{verb:'create',action_id:'legacy-topic',title:'Queued message',roots:[rootId],area_ids:[area.id]});
  const topicId=created.topic.topicId;
  const added=topicsCommand(current.actor,{verb:'request.add',topic_id:topicId,action_id:'legacy-request',title:'Explain and resolve the queue',
    sources:[rootId],brief:'Check the queue, recover it if needed, and explain the outcome.'});
  const requestId=added.request.requestId;

  const target=owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat'});
  const dispatch=await communication.ask({source:current.source,action_id:'legacy-dispatch',address:target.session.address,
    thread:rootId,summary:'Inspect and resolve the queued message',text:'Inspect the queued message and resolve it.',requestedEffect:'informational'});
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

  // A completed final can be shared by several migrated requests. Each request must cite that
  // one retained final; closure never manufactures another answer post.
  const typedTarget=owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat'});
  const typedDispatch=await communication.ask({source:current.source,action_id:'typed-dispatch',address:typedTarget.session.address,
    thread:rootId,summary:'Repair both parts',text:'Repair both parts and check them.',requestedEffect:'work'});
  await communication.idle();const typedWorker=run();
  communication.reply({source:typedWorker.source,action_id:'typed-final',request_id:typedDispatch.request_id,
    text:'Both parts were repaired and checked.',final:true,workDisposition:'completed',summary:'Both parts repaired',
    all_done:true,checked:'The installed result showed both parts working.'});
  await communication.idle();
  const typedEvent=communication.inspect(typedDispatch.request_id).events.find(event=>event.kind==='final');
  assert.ok(typedEvent);
  const answerPosts=()=>db.query("SELECT count(*) AS n FROM session_owner_events WHERE kind='post' AND json_extract(payload_json,'$.requestId')=?")
    .get(typedDispatch.request_id) as {n:number};
  const postsBeforeClosure=answerPosts().n;
  const sharedIds=['typed-request-a','typed-request-b'].map(action=>{
    const item=topicsCommand(current.actor,{verb:'request.add',topic_id:topicId,action_id:action,title:action,
      sources:[rootId],brief:'Check this part of the repaired work.'});
    topicsCommand(current.actor,{verb:'request.link',request_id:item.request.requestId,action_id:`${action}-link`,dispatch:typedDispatch.request_id});
    return item.request.requestId;
  });
  assert.throws(()=>topicsCommand(current.actor,{verb:'request.close',request_id:sharedIds[0],action_id:'typed-wrong-final',
    disposition:'completed',evidence:[finalEvent.event_id],reason:'Checked the first part.'}),/name the agent answer as evidence/);
  for(const [index,id] of sharedIds.entries()){
    const result=topicsCommand(current.actor,{verb:'request.close',request_id:id,action_id:`typed-close-${index}`,
      disposition:'completed',evidence:[typedEvent.event_id],reason:`Checked part ${index+1} against the retained final.`});
    assert.deepEqual(result.request.closure.evidence,[typedEvent.event_id]);
  }
  assert.equal(answerPosts().n,postsBeforeClosure);
  assert.deepEqual(errors,[]);
  console.log('Legacy topic completion fixture passed: uncertain and unrelated evidence stayed open; exact legacy and typed finals closed without duplicate posts.');
} finally {
  await communication.stop();
  rmSync(scratch,{recursive:true,force:true});
}
