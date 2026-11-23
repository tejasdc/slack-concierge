import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LEGACY_TOPIC_COMPLETION_TEST_AUTHORIZATION} from '../src/test-authorizations';
import {Database} from 'bun:sqlite';
import {ledgerWriteResults} from '../src/ledger-write-results';
import {PreparedTopics} from '../src/prepared-topics';
import {preparedTopicValue} from '../src/prepared-topic-values';
import {unsentRequestStatus,workWithUnsentRequests} from '../src/topic-current-workers';

const scratch=mkdtempSync(join(tmpdir(),'concierge-legacy-topic-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=LEGACY_TOPIC_COMPLETION_TEST_AUTHORIZATION;

const [{db,getSessionById,claimNextQueuedTurn,markTurnProviderAdmissionIntended,acknowledgeTurnProviderInput},
  {SessionOwner},{SessionCommunicationCoordinator},{nativeRunId,updateSessionMetadata,recordSessionEvent,retainSessionInput},
  {topicsCommand,topicPromptContext,invalidateTopicRoots,readTopic,openInboxObligations,postAgentAnswer,keepThreadsCurrent}]=await Promise.all([
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
  const inbox=await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text:'Reconcile retained work'}});
  const inboxId=Number(inbox.session.id.slice(10));updateSessionMetadata(inboxId,{inbox:true});
  const current=run();
  const rootId=current.actor.inputId;
  const area=topicsCommand(current.actor,{verb:'area.create',action_id:'legacy-area',name:'Legacy completion fixture'}).area;
  const created=topicsCommand(current.actor,{verb:'create',action_id:'legacy-topic',title:'Queued message',roots:[rootId],area_ids:[area.id]});
  const topicId=created.topic.topicId;
  const added=topicsCommand(current.actor,{verb:'request.add',topic_id:topicId,action_id:'legacy-request',title:'Explain and resolve the queue',
    sources:[rootId],brief:'Check the queue, recover it if needed, and explain the outcome.'});
  const requestId=added.request.requestId;
  assert.equal(readTopic(topicId).work.kind,'router_queued');
  assert.match(readTopic(topicId).work.text,/recorded but not sent/);
  assert.equal(readTopic(topicId).topic.requests.unsent,1);
  const unsent=openInboxObligations().items.find(item=>item.requestId===requestId)!;
  assert.equal(unsent.dispatchState,'unsent');assert.match(unsent.nextAction!,/exact request/);
  const waitingWorkers=[{sessionId:'concierge:42',title:'A waiting worker'}];
  const mixed=workWithUnsentRequests({kind:'worker_waiting',text:'A waiting worker · waiting for its helper',workers:waitingWorkers},
    unsentRequestStatus([{state:'open',dispatches:[]}]));
  assert.equal(mixed.kind,'router_queued');assert.match(mixed.text,/recorded but not sent.*waiting for its helper/);
  assert.equal(mixed.workers,waitingWorkers);
  for(const kind of ['router_working','router_queued','worker_working']){
    const status=workWithUnsentRequests({kind,text:'Existing activity'},unsentRequestStatus([{state:'open',dispatches:[]}]));
    assert.equal(status.kind,kind);assert.match(status.text,/recorded but not sent.*Existing activity/);
  }
  const returned=workWithUnsentRequests({kind:'result_waiting',text:'An answer came back',returnInputId:'return:exact'},
    unsentRequestStatus([{state:'open',dispatches:[]}]));
  assert.equal(returned.kind,'router_queued');assert.equal(returned.returnInputId,'return:exact');
  assert.match(returned.text,/recorded but not sent.*answer came back/);
  const projection=ledgerWriteResults(new Database(':memory:'));
  try{
    const topics=new PreparedTopics(db,projection);
    projection.exec('CREATE TABLE presentation_messages(generation INTEGER,root_input_id TEXT,event_sequence INTEGER,created_at TEXT,message_id TEXT,input_id TEXT,entry_kind TEXT)');
    projection.exec('CREATE TABLE presentation_topic_events(generation INTEGER,topic_id TEXT,event_sequence INTEGER)');
    const prepared=preparedTopicValue(topics.context(1,inboxId),topicId)!;
    assert.equal(prepared.summary.requests.unsent,1);
    assert.equal(prepared.summary.work.kind,'router_queued');assert.match(prepared.summary.work.text,/recorded but not sent/);
  }finally{projection.close();}

  const target=await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat'});
  const dispatch=await communication.ask({source:current.source,action_id:'legacy-dispatch',address:target.session.address,
    thread:rootId,summary:'Inspect and resolve the queued message',text:'Inspect the queued message and resolve it.',requestedEffect:'informational'});
  await communication.idle();const worker=run();
  communication.reply({source:worker.source,action_id:'legacy-final',request_id:dispatch.request_id,
    text:'The deployment hold released, the message drained, and no change was needed.',final:true});
  await communication.idle();
  const finalEvent=communication.inspect(dispatch.request_id).events.find(event=>event.kind==='final');
  assert.ok(finalEvent);
  // Prompt preparation must read this topic's retained answer after a cold index reset,
  // without waiting for the global history warm-up to finish.
  const returnedId=`return:${finalEvent.event_id}`;
  if(!db.query('SELECT 1 FROM session_inputs WHERE id=?').get(returnedId))retainSessionInput({
    id:returnedId,sessionId:inboxId,scope:`session:${rootId}`,actionId:returnedId,
    kind:'input',origin:'service',sourceInputId:rootId,sourceRunId:current.actor.runId,
    requestId:dispatch.request_id,payload:{text:'The retained worker answer.'},
  });
  recordSessionEvent({eventId:'fixture-accepted-return',sessionId:inboxId,inputId:returnedId,kind:'accepted',payload:{}});
  invalidateTopicRoots();
  const promptContext=topicPromptContext(inboxId,rootId,{});
  const topicContext=JSON.parse(promptContext.match(/<topic>\n([\s\S]*?)\n<\/topic>/)?.[1]??'null');
  assert.equal(topicContext.id,topicId);
  assert.equal(topicContext.unrelayedResult?.inputId,returnedId);
  recordSessionEvent({eventId:'fixture-post-after-return',sessionId:inboxId,inputId:rootId,kind:'post',payload:{text:'Relayed'}});
  invalidateTopicRoots();
  const relayed=JSON.parse(topicPromptContext(inboxId,rootId,{}).match(/<topic>\n([\s\S]*?)\n<\/topic>/)?.[1]??'null');
  assert.equal(relayed.unrelayedResult,undefined);
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
  const typedTarget=await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat'});
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

  // The shared acceptance can fail on a sibling while an earlier repaired request
  // has its own successful installed check. Both final events are required.
  const notice=topicsCommand(current.actor,{verb:'request.add',topic_id:topicId,action_id:'split-notice',
    title:'Repair the notice',sources:[rootId],brief:'Keep the notice clear of Send.'}).request.requestId;
  const steering=topicsCommand(current.actor,{verb:'request.add',topic_id:topicId,action_id:'split-steering',
    title:'Repair attachment steering',sources:[rootId],brief:'Check steering in a running conversation.'}).request.requestId;
  const noticeTarget=await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat'});
  const noticeWork=await communication.ask({source:current.source,action_id:'split-notice-work',address:noticeTarget.session.address,
    thread:rootId,summary:'Repair notice layout',text:'Repair the notice layout.',requestedEffect:'informational'});
  await communication.idle();const noticeWorker=run();
  communication.reply({source:noticeWorker.source,action_id:'split-notice-final',request_id:noticeWork.request_id,
    text:'Notice layout installed; later live check needed.',final:true});
  await communication.idle();
  db.query("UPDATE session_communication_requests SET payload_json=json_set(payload_json,'$.requestedEffect','work') WHERE request_id=?")
    .run(noticeWork.request_id);
  const noticeFinal=communication.inspect(noticeWork.request_id).events.find(event=>event.kind==='final');assert.ok(noticeFinal);
  topicsCommand(current.actor,{verb:'request.link',request_id:notice,action_id:'split-link-notice-work',dispatch:noticeWork.request_id});
  const sharedTarget=await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat'});
  const sharedCheck=await communication.ask({source:current.source,action_id:'split-shared-check',address:sharedTarget.session.address,
    thread:rootId,summary:'Check both repairs',text:'Check notice and steering.',requestedEffect:'work'});
  await communication.idle();const sharedWorker=run();
  communication.reply({source:sharedWorker.source,action_id:'split-shared-final',request_id:sharedCheck.request_id,
    text:'Notice geometry passed in installed browser; attachment steering could not be checked.',final:true,
    workDisposition:'failed',summary:'Steering still unverified'});
  await communication.idle();
  const sharedFinal=communication.inspect(sharedCheck.request_id).events.find(event=>event.kind==='final');assert.ok(sharedFinal);
  topicsCommand(current.actor,{verb:'request.link',request_id:notice,action_id:'split-link-notice-check',dispatch:sharedCheck.request_id});
  topicsCommand(current.actor,{verb:'request.link',request_id:steering,action_id:'split-link-steering-check',dispatch:sharedCheck.request_id});
  assert.throws(()=>topicsCommand(current.actor,{verb:'request.close',request_id:notice,action_id:'split-no-check-evidence',
    disposition:'completed',evidence:[noticeFinal.event_id],reason:'Checked the notice.'}),/has not finished/);
  assert.throws(()=>topicsCommand(current.actor,{verb:'request.close',request_id:steering,action_id:'split-steering-still-open',
    disposition:'completed',evidence:[sharedFinal.event_id],reason:'Steering was checked.'}),/has not finished/);
  const noticeClosed=topicsCommand(current.actor,{verb:'request.close',request_id:notice,action_id:'split-close-notice',
    disposition:'completed',evidence:[noticeFinal.event_id,sharedFinal.event_id],
    reason:'The installed notice check passed; steering remains a separate open request.'});
  assert.equal(noticeClosed.request.state,'closed');
  assert.equal((db.query('SELECT state FROM inbox_requests WHERE request_id=?').get(steering) as {state:string}).state,'open');

  // A recipient can settle its original request during a later return turn. The
  // final event stays attached to the dispatch but retains that turn's source input.
  const returnId=`return:${randomUUID()}`;
  retainSessionInput({id:returnId,sessionId:Number(typedTarget.session.id.slice(10)),scope:`session:${typedWorker.actor.inputId}`,
    actionId:'typed-later-return',kind:'input',origin:'service',payload:{text:'A helper returned the checked result.'},
    sourceInputId:typedWorker.actor.inputId,sourceRunId:typedWorker.actor.runId,requestId:typedDispatch.request_id});
  db.query("UPDATE session_communication_events SET payload_json=json_set(payload_json,'$.source.input_id',?,'$.source.run_id',?) WHERE event_id=?")
    .run(returnId,typedWorker.actor.runId,typedEvent.event_id);
  const later=topicsCommand(current.actor,{verb:'request.add',topic_id:topicId,action_id:'typed-later-request',
    title:'Checked after helper return',sources:[rootId],brief:'Check the retained final for this request.'});
  topicsCommand(current.actor,{verb:'request.link',request_id:later.request.requestId,action_id:'typed-later-link',dispatch:typedDispatch.request_id});
  assert.throws(()=>topicsCommand(current.actor,{verb:'request.close',request_id:later.request.requestId,action_id:'typed-later-wrong-final',
    disposition:'completed',evidence:[finalEvent.event_id],reason:'Checked the retained final.'}),/name the agent answer as evidence/);
  const laterClosed=topicsCommand(current.actor,{verb:'request.close',request_id:later.request.requestId,action_id:'typed-later-exact-final',
    disposition:'completed',evidence:[typedEvent.event_id],reason:'Checked the exact unsuperseded final from the later return turn.'});
  assert.deepEqual(laterClosed.request.closure.evidence,[typedEvent.event_id]);
  assert.equal(answerPosts().n,postsBeforeClosure);

  // An accepted Inbox successor can answer a request retained under its predecessor.
  // The message projection gives SQLite timestamps as "YYYY-MM-DD HH:MM:SSZ"; the
  // completion check must normalize that timestamp before comparing it to the request.
  const inherited=topicsCommand(current.actor,{verb:'request.add',topic_id:topicId,action_id:'inherited-request',
    title:'Answer after Inbox handoff',sources:[rootId],brief:'Answer the existing human request in its thread.'});
  db.query("UPDATE inbox_requests SET created_at=datetime('now','-1 minute') WHERE request_id=?").run(inherited.request.requestId);
  const successor=await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text:'Continue Inbox work'}});
  const successorId=Number(successor.session.id.slice(10));updateSessionMetadata(successorId,{inbox:true});
  const successorTurn=run();
  const wrongPost='post:successor-unrelated';
  recordSessionEvent({eventId:wrongPost,sessionId:successorId,inputId:successorTurn.actor.inputId,
    turnId:successorTurn.actor.turnId,kind:'post',payload:{text:'An unrelated answer',threadRoot:'other-root'}});
  assert.throws(()=>topicsCommand(successorTurn.actor,{verb:'request.close',request_id:inherited.request.requestId,
    action_id:'successor-wrong-thread',disposition:'completed',evidence:[wrongPost],reason:'Checked the answer.'}),
    /exact source message/);
  const siblingSource='human:sibling-source';
  retainSessionInput({id:siblingSource,sessionId:inboxId,scope:`session:${rootId}`,actionId:siblingSource,
    kind:'input',origin:'human',payload:{text:'A separate question in this same thread.'}});
  recordSessionEvent({eventId:'fixture-sibling-accepted',sessionId:inboxId,inputId:siblingSource,kind:'accepted',payload:{}});
  const siblingPost='post:successor-sibling';
  recordSessionEvent({eventId:siblingPost,sessionId:successorId,inputId:rootId,turnId:successorTurn.actor.turnId,kind:'post',
    payload:{text:'A sibling answer.',replyToMessage:{messageId:siblingSource}}});
  assert.throws(()=>topicsCommand(successorTurn.actor,{verb:'request.close',request_id:inherited.request.requestId,
    action_id:'successor-sibling-answer',disposition:'completed',evidence:[siblingPost],reason:'It is in the same thread.'}),/exact source message/);
  const forwardedPost='post:successor-unlinked-dispatch';
  recordSessionEvent({eventId:forwardedPost,sessionId:successorId,inputId:rootId,kind:'post',
    payload:{text:'An unlinked worker answer.',requestId:typedDispatch.request_id,postedBy:'owner-forward',replyToMessage:{messageId:rootId}}});
  assert.throws(()=>topicsCommand(successorTurn.actor,{verb:'request.close',request_id:inherited.request.requestId,
    action_id:'successor-unlinked-answer',disposition:'completed',evidence:[forwardedPost],reason:'The worker answered here.'}),/exact source message/);
  const answerPost='post:successor-inherited-answer';
  recordSessionEvent({eventId:answerPost,sessionId:successorId,inputId:successorTurn.actor.inputId,
    turnId:successorTurn.actor.turnId,kind:'post',payload:{text:'The existing request is answered.',threadRoot:rootId,replyToMessage:{messageId:rootId}}});
  const inheritedClosed=topicsCommand(successorTurn.actor,{verb:'request.close',request_id:inherited.request.requestId,
    action_id:'successor-inherited-close',disposition:'completed',evidence:[answerPost],reason:'Checked the exact answer in the original thread.'});
  assert.equal(inheritedClosed.request.state,'closed');
  assert.deepEqual(inheritedClosed.request.closure.evidence,[answerPost]);
  topicsCommand(successorTurn.actor,{verb:'request.reopen',request_id:inherited.request.requestId,action_id:'reopen-exact',reason:'The source obligation still needs work.'});
  assert.throws(()=>topicsCommand(successorTurn.actor,{verb:'request.close',request_id:inherited.request.requestId,
    action_id:'reopened-generic-answer',disposition:'completed',evidence:[siblingPost],reason:'An answer exists in this topic.'}),/exact source message/);

  // Reopening does not require resending accepted work. A late final from the same
  // latest dispatch can satisfy it, but only its new unsuperseded final is evidence.
  topicsCommand(successorTurn.actor,{verb:'request.reopen',request_id:later.request.requestId,
    action_id:'reopen-late-result',reason:'Reconcile the original accepted work after reopening.'});
  const reopenedAt=(db.query('SELECT reopened_at FROM inbox_requests WHERE request_id=?').get(later.request.requestId) as {reopened_at:string}).reopened_at;
  assert.throws(()=>topicsCommand(successorTurn.actor,{verb:'request.close',request_id:later.request.requestId,
    action_id:'reopened-old-final',disposition:'completed',evidence:[typedEvent.event_id],reason:'The old answer is still retained.'}),/reopened/);
  const lateFinalId='final:late-return-after-reopen';
  const lateTime=Date.parse(reopenedAt)+1000;
  const retainedFinal=db.query('SELECT payload_json FROM session_communication_events WHERE event_id=?').get(typedEvent.event_id) as {payload_json:string};
  db.query('UPDATE session_communication_events SET superseded_by_event_id=? WHERE event_id=?').run(lateFinalId,typedEvent.event_id);
  db.query('INSERT INTO session_communication_events(event_id,request_id,kind,payload_json,created_at_ms) VALUES(?,?,?,?,?)')
    .run(lateFinalId,typedDispatch.request_id,'final',retainedFinal.payload_json,lateTime);
  db.query("UPDATE session_communication_requests SET result_json=json_set(result_json,'$.event_id',?) WHERE request_id=?")
    .run(lateFinalId,typedDispatch.request_id);
  const latePost=`post:forward:${lateFinalId}`;
  recordSessionEvent({eventId:latePost,sessionId:successorId,inputId:rootId,kind:'post',payload:{text:'The late checked result.',
    requestId:typedDispatch.request_id,replyKind:'final',workDisposition:'completed',postedBy:'owner-forward'}});
  db.query('UPDATE session_owner_events SET created_at=? WHERE event_id=?').run(new Date(lateTime).toISOString(),latePost);
  const genericLatePost='post:generic-latest-dispatch';
  recordSessionEvent({eventId:genericLatePost,sessionId:successorId,inputId:rootId,kind:'post',payload:{text:'The same dispatch is mentioned.',
    requestId:typedDispatch.request_id,replyKind:'final',workDisposition:'completed'}});
  db.query('UPDATE session_owner_events SET created_at=? WHERE event_id=?').run(new Date(lateTime).toISOString(),genericLatePost);
  assert.throws(()=>topicsCommand(successorTurn.actor,{verb:'request.close',request_id:later.request.requestId,
    action_id:'reopened-generic-same-dispatch',disposition:'completed',evidence:[genericLatePost],reason:'The dispatch is mentioned.'}),/reopened/);
  assert.throws(()=>topicsCommand(successorTurn.actor,{verb:'request.close',request_id:later.request.requestId,
    action_id:'reopened-superseded-final',disposition:'completed',evidence:[typedEvent.event_id],reason:'The former final is retained.'}),/reopened/);
  const lateClosed=topicsCommand(successorTurn.actor,{verb:'request.close',request_id:later.request.requestId,
    action_id:'reopened-late-exact-final',disposition:'completed',evidence:[latePost],reason:'Checked the new exact final from the already accepted dispatch.'});
  assert.equal(lateClosed.request.state,'closed');
  assert.deepEqual(errors,[]);
  async function continueDecision(label:string,answerQuestion:boolean,check:{checked:string}|{not_checked:string},staleReview=false) {
    const message=(text:string,replyTo?:string,review?:{id:string;revision:number})=>{
      const input=retainSessionInput({sessionId:successorId,scope:'surface:thinkering',actionId:`${label}:${text}`,kind:'input',
        origin:'human',payload:{text,...(replyTo?{replyToMessage:{messageId:replyTo,sessionId:successor.session.id}}:{}),
          ...(review?{review:{questions:[review]}}:{})}}).input;
      recordSessionEvent({eventId:`accepted:${input.id}`,sessionId:successorId,inputId:input.id,kind:'accepted',payload:{}});
      return input.id;
    };
    const command=(verb:string,fields:object)=>topicsCommand(successorTurn.actor,{verb,action_id:`${label}-${verb.replace('.', '-')}`,...fields});
    const root=message('Please finish the fixture work.');
    const topic=command('create',{title:`Decision continuation ${label}`,roots:[root],area_ids:[area.id]}).topic.topicId;
    const request=command('request.add',{topic_id:topic,title:`Finish ${label}`,sources:[root],brief:'Finish and verify the fixture work.'}).request.requestId;
    const firstWorker=await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat'});
    const original=await communication.ask({source:successorTurn.source,action_id:`dispatch-${label}`,address:firstWorker.session.address,
      thread:root,summary:'Work awaiting a decision',text:'Finish the fixture work.',requestedEffect:'work'});
    await communication.idle();
    run();
    command('request.link',{request_id:request,dispatch:original.request_id});
    db.query("UPDATE session_communication_requests SET outcome='decision_needed',status='settled' WHERE request_id=?").run(original.request_id);
    const questionPost=postAgentAnswer({inboxSessionId:successorId,eventId:`fixture-decision:${label}`,requestId:original.request_id,
      root,inboxInputId:root,respondingSessionId:firstWorker.session.id,text:'Which copy is yours?',
      attachments:[],stalled:false,final:true,workDisposition:'needs_decision'});
    assert.ok(questionPost);
    const {question_id:questionId}=db.query("SELECT question_id FROM inbox_questions WHERE topic_id=? AND kind='decision'").get(topic) as {question_id:string};
    // Model a retained decision older than the second-resolution timestamp of the accepted reply.
    db.query("UPDATE inbox_questions SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute') WHERE question_id=?").run(questionId);
    if(staleReview)db.query('UPDATE inbox_questions SET revision=2 WHERE question_id=?').run(questionId);
    const reply=message('Use the newer copy.',answerQuestion?questionPost:root,staleReview?{id:questionId,revision:1}:undefined);
    const nextWorker=await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat'});
    const continuation=communication.forwardReply({inbox:getSessionById(successorId)!,inputId:reply,text:'Use the newer copy.',
      target:{sessionId:nextWorker.session.id,local:Number(nextWorker.session.id.slice(10)),peer:null,title:null,topicId:topic,root}});
    if(!answerQuestion)command('request.link',{action_id:`${label}-link-continuation`,request_id:request,dispatch:continuation});
    await communication.idle();
    const resumed=run();
    const completed=communication.reply({source:resumed.source,action_id:`final-${label}`,request_id:continuation,
      text:'The work on the newer copy is complete.',final:true,workDisposition:'completed',summary:'The copy is ready',
      mine:'Which copy this fixture work uses.',all_done:true,...check});
    const final=completed.result!.event_id;
    const close=()=>command('request.close',{request_id:request,disposition:'completed',evidence:[final],reason:'The checked continuation finished the work.'});
    const state=()=>db.query('SELECT state,answer_json FROM inbox_questions WHERE question_id=?').get(questionId) as
      {state:string;answer_json:string|null};
    return {request,reply,final,continuation,questionId,close,state};
  }

  const checked={checked:'I opened the newer copy and confirmed the result.'};
  const manual=await continueDecision('manual',true,checked);
  manual.close();
  assert.equal(manual.state().state,'answered');
  assert.equal(JSON.parse(manual.state().answer_json!).inputId,manual.reply);
  assert.equal(JSON.parse(manual.state().answer_json!).finalEventId,manual.final);
  await communication.idle();

  const automatic=await continueDecision('upkeep',true,checked);
  const recoveries:{requestId:string;text:string}[]=[];
  for(let pass=0;pass<2;pass++)await keepThreadsCurrent(input=>recoveries.push(input));
  await communication.idle();
  assert.equal(automatic.state().state,'answered');
  assert.equal((db.query('SELECT disposition FROM inbox_requests WHERE request_id=?').get(automatic.request) as {disposition:string}).disposition,'completed');
  assert.equal(recoveries.some(input=>input.requestId===automatic.request),false);
  assert.equal((db.query("SELECT count(*) AS n FROM session_owner_events WHERE kind='post' AND json_extract(payload_json,'$.requestId')=?")
    .get(automatic.continuation) as {n:number}).n,1);

  const unrelated=await continueDecision('unrelated',false,checked);
  assert.throws(unrelated.close,new RegExp(unrelated.questionId));
  assert.equal(unrelated.state().state,'open');
  await communication.idle();
  const stale=await continueDecision('stale-review',true,checked,true);
  assert.throws(stale.close,new RegExp(stale.questionId));
  assert.equal(stale.state().state,'open');
  await communication.idle();
  const unchecked=await continueDecision('unchecked',true,{not_checked:'The fixture result could not be opened.'});
  assert.throws(unchecked.close,/has not finished/);
  await communication.idle();
  await keepThreadsCurrent(input=>recoveries.push(input));
  assert.equal(unchecked.state().state,'open');
  assert.ok(recoveries.some(input=>input.requestId===unchecked.request&&input.text.includes('without a live check')));
  assert.deepEqual(errors,[]);
  console.log('Legacy topic completion fixture passed, including checked continuations and exact decisions.');
} finally {
  await communication.stop();
  rmSync(scratch,{recursive:true,force:true});
}
