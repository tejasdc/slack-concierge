import {afterEach,beforeEach,expect,test} from 'bun:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {db,claimNextQueuedTurn,markTurnProviderAdmissionIntended,acknowledgeTurnProviderInput,markTurnSteeringMessageFailed,markTurnSteeringMessageSending,markTurnSteeringMessageSent,markTurnSteeringMessageAmbiguous,finishTurn,getSessionById,upsertChannel,createOrGetSession,claimSlackUserInput,acquireSessionTurn,parkRunningTurnAfterProviderFailure} from '../src/state';
import {SessionOwner} from '../src/session-owner';
import {SessionCommunicationCoordinator} from '../src/session-communication';
import {attachSessionSteering,getAcceptedSessionInput,nativeRunId,recordSessionEvent,retainSessionInput,updateSessionMetadata,sessionInputProvenance} from '../src/session-inputs';
import {acquireDatabaseTestLock} from './db-lock';
import {clearTables} from './clear-tables';
import {backfillResultAnsweredByPost,inboxHistory,inboxHistoryAfter,inboxMessage,markResultAnsweredByPost,postForwardedThreadAnswer} from '../src/session-inbox';
import {preparedInboxDisplay} from '../src/presentation-inbox-display';
import {claimExecutionTurn,retainExecutionIntent} from '../src/executions';
import {chatGptObligationForAttempt} from '../src/chatgpt-obligations';
import {inboxRootResolver,sourceMessagePage} from '../src/presentation-message-source';

let unlock:()=>void,owner:SessionOwner,communication:SessionCommunicationCoordinator;
let steeringMode:'sent'|'pending',errors:unknown[];
const clear=()=>clearTables(db,['session_owner_events','session_communication_events','session_communication_requests','session_inputs','turn_dependencies','routed_requests','routed_input_events','deployment_drain','comparison_requests','fork_requests','slack_thread_statuses','slack_user_input_claims','turn_steering_messages','turn_delivery_chunks','executions','turns','sessions','channels']);
async function build(cwd:string) {
  owner=new SessionOwner({available:()=>true,wake:()=>{},stop:async()=>false,steer:input=>{
    const active=db.query("SELECT id FROM turns WHERE session_id=? AND status='running'").get(input.session_id) as any;
    if(!active)return false;
    const accepted=attachSessionSteering(input.id,active.id);
    if(steeringMode==='sent'){markTurnSteeringMessageSending(accepted.steering_id!);markTurnSteeringMessageSent(accepted.steering_id!);}
    return true;
  }},cwd);
  communication=new SessionCommunicationCoordinator({owner,isOwnerAlive:()=>true,onError:error=>errors.push(error)});
  owner.communication=communication;communication.start();await communication.idle();
}
beforeEach(async()=>{unlock=await acquireDatabaseTestLock();clear();steeringMode='sent';errors=[];await build('/tmp');});
afterEach(async()=>{await communication.stop();clear();unlock();});
function session(){return owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text:'native input'}});}
function run(){
  const claim=claimNextQueuedTurn('fixture-owner')!;
  expect(claim).not.toBeNull();
  expect(markTurnProviderAdmissionIntended(claim.turn_id,'fixture-owner',claim.dispatch_attempt)).toBeTrue();
  acknowledgeTurnProviderInput(claim.turn_id,'fixture-owner',claim.dispatch_attempt,[]);
  return {claim,source:{input_id:claim.accepted_input_id!,run_id:nativeRunId(claim.turn_id)}};
}
test('a historical router post collapses its closing result while retaining both events',async()=>{
  const inbox=session(),inboxId=Number(inbox.session.id.slice(10));
  updateSessionMetadata(inboxId,{inbox:true});
  const {claim,source}=run();
  communication.post({source,action_id:'one-answer',thread:source.input_id,text:'The answer.'});
  recordSessionEvent({eventId:`result:${claim.turn_id}`,sessionId:inboxId,inputId:source.input_id,
    turnId:claim.turn_id,kind:'result',payload:{text:'The answer again.'}});
  expect(await backfillResultAnsweredByPost(()=>false)).toBe(1);
  expect(await backfillResultAnsweredByPost(()=>false)).toBe(0);
  expect(db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(`result:${claim.turn_id}`)).toBeTruthy();
  const direct=inboxHistory(getSessionById(inboxId)!,null,20)!.messages;
  expect(direct.filter(message=>message.content==='The answer.')).toHaveLength(1);
  expect(direct.some(message=>message.id===`result:${claim.turn_id}`)).toBeFalse();
  const head=(db.query('SELECT max(sequence) AS n FROM session_owner_events').get() as {n:number}).n;
  const prepared=sourceMessagePage(db,0,head,100,inboxRootResolver(db)).messages;
  expect(prepared.some(message=>message.messageId===`result:${claim.turn_id}`)).toBeFalse();
  expect(prepared.some(message=>message.messageId.startsWith('post:'))).toBeTrue();
});

test('a router result remains the thread answer when no post was made',()=>{
  const inbox=session(),inboxId=Number(inbox.session.id.slice(10));
  updateSessionMetadata(inboxId,{inbox:true});
  const {claim,source}=run();
  recordSessionEvent({eventId:`result:${claim.turn_id}`,sessionId:inboxId,inputId:source.input_id,
    turnId:claim.turn_id,kind:'result',payload:{text:'The closing answer.'}});
  expect(markResultAnsweredByPost({sessionId:inboxId,turnId:claim.turn_id,inputId:source.input_id})).toBeFalse();
  expect(inboxHistory(getSessionById(inboxId)!,null,20)!.messages.some(message=>message.id===`result:${claim.turn_id}`)).toBeTrue();
  const head=(db.query('SELECT max(sequence) AS n FROM session_owner_events').get() as {n:number}).n;
  expect(sourceMessagePage(db,0,head,100,inboxRootResolver(db)).messages.some(message=>message.messageId===`result:${claim.turn_id}`)).toBeTrue();
});

test('a router reply inside a thread does not show its closing result beside its post',()=>{
  const inbox=session(),inboxId=Number(inbox.session.id.slice(10));
  updateSessionMetadata(inboxId,{inbox:true});
  const {claim,source}=run();
  const root=retainSessionInput({sessionId:inboxId,scope:'surface:thinkering',actionId:'fixture-thread-root',
    kind:'input',origin:'human',payload:{text:'Original question'}}).input;
  recordSessionEvent({eventId:`accepted:${root.id}`,sessionId:inboxId,inputId:root.id,
    kind:'accepted',payload:{text:'Original question'}});
  db.query('UPDATE session_inputs SET payload_json=? WHERE id=?').run(
    JSON.stringify({text:'Reply in the thread',replyToMessage:{kind:'message',sessionId:inbox.session.id,messageId:root.id}}),source.input_id);
  communication.post({source,action_id:'reply-answer',thread:root.id,text:'The answer in this thread.'});
  recordSessionEvent({eventId:`result:${claim.turn_id}`,sessionId:inboxId,inputId:source.input_id,
    turnId:claim.turn_id,kind:'result',payload:{text:'Answered in the thread.'}});
  expect(markResultAnsweredByPost({sessionId:inboxId,turnId:claim.turn_id,inputId:source.input_id})).toBeTrue();
  expect(inboxHistory(getSessionById(inboxId)!,null,20)!.messages.some(message=>message.id===`result:${claim.turn_id}`)).toBeFalse();
  const head=(db.query('SELECT max(sequence) AS n FROM session_owner_events').get() as {n:number}).n;
  expect(sourceMessagePage(db,0,head,100,inboxRootResolver(db)).messages.some(message=>message.messageId===`result:${claim.turn_id}`)).toBeFalse();
});
async function ask(source:any,target:any,action='ask',extra:any={}){return communication.ask({source,action_id:action,address:target.session.address,text:'Exact question',...extra});}

test('a healthy request rechecks without a ledger deadline write or duplicate reminder after restart',async()=>{
  session();const requester=run(),target=session();run();
  const request=await ask(requester.source,target,'healthy-recheck');
  const queuedTarget=session();
  const other=await ask(requester.source,queuedTarget,'other-due');
  await communication.idle();
  const storedDue=Date.now()-1;
  db.query('UPDATE session_communication_requests SET due_at_ms=? WHERE request_id=?').run(storedDue,request.request_id);
  db.query('UPDATE session_communication_requests SET due_at_ms=? WHERE request_id=?').run(storedDue,other.request_id);
  const scan=(communication as any).scanRows.bind(communication);
  let dueScans=0;
  (communication as any).scanRows=(table:string,sql:string,...args:unknown[])=>{
    if(table==='session_communication_requests'&&sql.includes('request_id NOT IN'))dueScans++;
    return scan(table,sql,...args);
  };
  (communication as any).nextRequestInspectionAt=0;
  communication.wake();await communication.idle();
  expect(dueScans).toBe(1);
  expect(db.query('SELECT due_at_ms FROM session_communication_requests WHERE request_id=?').get(request.request_id)).toEqual({due_at_ms:storedDue});
  expect(communication.inspect(request.request_id)).toMatchObject({overdue_at_ms:null,events:[],due_at_ms:expect.any(Number)});
  expect(communication.inspect(request.request_id).due_at_ms).toBeGreaterThan(storedDue);
  expect(communication.inspect(other.request_id).overdue_at_ms).not.toBeNull();
  communication.wake();await communication.idle();
  expect(dueScans).toBe(1);
  expect(db.query('SELECT due_at_ms FROM session_communication_requests WHERE request_id=?').get(request.request_id)).toEqual({due_at_ms:storedDue});
  await communication.stop();
  await build('/tmp');
  communication.wake();await communication.idle();
  expect(communication.inspect(request.request_id)).toMatchObject({overdue_at_ms:null,events:[]});
  expect(db.query('SELECT due_at_ms FROM session_communication_requests WHERE request_id=?').get(request.request_id)).toEqual({due_at_ms:storedDue});
  expect(errors).toEqual([]);
});

test('a marked agent thread reply retained for a peer advances from its exact forwarding intent',async()=>{
  session();const agent=run();const inbox=session(),inboxId=Number(inbox.session.id.slice(10));
  const target={sessionId:'mac:22',local:null,peer:{peer:'mac',address:'mac/session:fixture'},title:'Mac agent',topicId:'topic:fixture',root:'capture:fixture'};
  const retained=retainSessionInput({sessionId:inboxId,scope:'surface:thinkering',actionId:'marked-peer-reply',kind:'input',origin:'agent',
    sourceInputId:agent.source.input_id,sourceRunId:agent.source.run_id,
    payload:{text:'Marked question',agentSource:{inputId:agent.source.input_id,runId:agent.source.run_id}}}).input;
  db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({state:'waiting',forwardTarget:target}),retained.id);
  const forwarded:any[]=[];const original=owner.communication;
  owner.communication={forwardReply:(value:any)=>{forwarded.push(value);}} as any;
  try {
    communication.wake();await communication.idle();
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({inputId:retained.id,target,text:'Marked question'});
    db.query('UPDATE session_inputs SET payload_json=? WHERE id=?').run(JSON.stringify({text:'Marked question',agentSource:{inputId:agent.source.input_id,runId:'different-run'}}),retained.id);
    owner.recoverAcceptedInput(getAcceptedSessionInput(retained.id)!);
    expect(forwarded).toHaveLength(1);
  } finally {owner.communication=original;}
});

test('a prompt answer followed by a bodyless final keeps one thread post with closing facts',async()=>{
  const inbox=session(),inboxId=Number(inbox.session.id.slice(10));
  updateSessionMetadata(inboxId,{inbox:true});
  const root=(db.query('SELECT id FROM session_inputs WHERE session_id=? ORDER BY rowid LIMIT 1').get(inboxId) as {id:string}).id;
  const answer={inboxSessionId:inboxId,requestId:'fixture-request',root,inboxInputId:root,
    respondingSessionId:'concierge:worker',attachments:[],stalled:false,workDisposition:null,hisInputId:null};
  const first=postForwardedThreadAnswer({...answer,eventId:'fixture-partial',text:'The answer to your question.',final:false,answersQuestion:true});
  const firstSequence=(db.query('SELECT sequence FROM session_owner_events WHERE event_id=?').get(first) as {sequence:number}).sequence;
  const closed=postForwardedThreadAnswer({...answer,eventId:'fixture-final',text:'',final:true,
    workDisposition:'completed',closingLine:'Completed · Checked on the real system: the thread shows one answer.'});
  expect(closed).toBe(first);
  expect(db.query("SELECT count(*) AS n FROM session_owner_events WHERE kind='post' AND json_extract(payload_json,'$.requestId')='fixture-request'").get()).toEqual({n:1});
  const row=db.query('SELECT event.*,input.payload_json AS input_json,input.origin,turn.agent_text FROM session_owner_events event LEFT JOIN session_inputs input ON input.id=event.input_id LEFT JOIN turns turn ON turn.id=event.turn_id WHERE event.event_id=?').get(first) as any;
  expect(inboxMessage(row)).toMatchObject({content:'The answer to your question.',closingLine:'Completed · Checked on the real system: the thread shows one answer.'});
  expect(inboxHistoryAfter(getSessionById(inboxId)!,firstSequence,10)).toEqual([
    expect.objectContaining({id:first,content:'The answer to your question.',closingLine:'Completed · Checked on the real system: the thread shows one answer.'})]);
  expect(preparedInboxDisplay(db,inboxId,firstSequence,first)?.preview.closingLine)
    .toBe('Completed · Checked on the real system: the thread shows one answer.');
});

test('a reopened request keeps its new prompt distinct from the old answer address',async()=>{
  const inbox=session(),inboxId=Number(inbox.session.id.slice(10));
  updateSessionMetadata(inboxId,{inbox:true});
  const current=run(),recipient=session();
  db.query('INSERT INTO inbox_topic_roots(root_input_id,topic_id) VALUES(?,?)').run(current.source.input_id,'fixture-topic');
  const old='capture:old-request';
  db.query('INSERT INTO session_inputs(id,session_id,scope,action_id,kind,origin,payload_json,receipt_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(old,inboxId,'fixture','old-request','input','human',JSON.stringify({text:'October request'}),'{}','2026-10-10T00:00:00.000Z');
  const request=await ask(current.source,recipient,'reopen-test',{summary:'Check the unfinished work',requestedEffect:'work',thread:current.source.input_id});
  db.query('UPDATE session_communication_requests SET thread_root_input_id=? WHERE request_id=?').run(old,request.request_id);
  const event=db.query("SELECT sequence,event_id FROM session_owner_events WHERE kind='request' AND json_extract(payload_json,'$.requestId')=?")
    .get(request.request_id) as {sequence:number;event_id:string};
  const display=preparedInboxDisplay(db,inboxId,event.sequence,event.event_id)!.preview;
  expect(display).toMatchObject({promptInputId:current.source.input_id,
    replyToMessage:{messageId:old},author:{communication:'request',requestId:request.request_id}});
});

test('the request owner accepts a bodyless final only after that request has a prompt answer',async()=>{
  session();const requester=run(),target=session(),worker=run();
  const request=await ask(requester.source,target,'prompt-request',{requestedEffect:'work'});
  db.query("UPDATE session_communication_requests SET payload_json=json_set(payload_json,'$.promptAnswer',1) WHERE request_id=?").run(request.request_id);
  await communication.idle();
  const final={source:worker.source,request_id:request.request_id,text:'',final:true,workDisposition:'completed' as const,
    all_done:true,checked:'one answer appeared in the thread'};
  expect(()=>communication.reply({...final,action_id:'early-final'})).toThrow('earlier prompt answer');
  communication.reply({source:worker.source,request_id:request.request_id,action_id:'prompt-answer',text:'The answer.',final:false,answers_question:true});
  communication.reply({...final,action_id:'close-after-answer'});
  expect(communication.inspect(request.request_id)).toMatchObject({outcome:'answered',events:[
    expect.objectContaining({kind:'progress',payload:expect.objectContaining({text:'The answer.',answersQuestion:true})}),
    expect.objectContaining({kind:'final',payload:expect.objectContaining({replyBody:'',closingLine:'Completed · Checked on the real system: one answer appeared in the thread'})})]});
});

test('separate identical answers remain visible unless one command explicitly groups them',async()=>{
  const inbox=session(),inboxId=Number(inbox.session.id.slice(10));
  const root=(db.query('SELECT id FROM session_inputs WHERE session_id=? ORDER BY rowid LIMIT 1').get(inboxId) as {id:string}).id;
  const base={inboxSessionId:inboxId,root,inboxInputId:root,respondingSessionId:'concierge:worker',text:'Done.',
    attachments:[],stalled:false,final:true,workDisposition:'completed'};
  postForwardedThreadAnswer({...base,eventId:'ungrouped-one',requestId:'request-one'});
  postForwardedThreadAnswer({...base,eventId:'ungrouped-two',requestId:'request-two'});
  postForwardedThreadAnswer({...base,eventId:'grouped-one',requestId:'request-three',answerGroup:'one-command'});
  postForwardedThreadAnswer({...base,eventId:'grouped-two',requestId:'request-four',answerGroup:'one-command'});
  expect(db.query("SELECT count(*) AS n FROM session_owner_events WHERE kind='post'").get()).toEqual({n:3});
});

test('separate final replies from one run share a post while retaining each request closure',async()=>{
  const inbox=session(),inboxId=Number(inbox.session.id.slice(10));
  const root=(db.query('SELECT id FROM session_inputs WHERE session_id=? ORDER BY rowid LIMIT 1').get(inboxId) as {id:string}).id;
  const base={inboxSessionId:inboxId,root,inboxInputId:root,respondingSessionId:'concierge:worker',
    text:'The fixture is complete.',attachments:[],stalled:false,final:true,workDisposition:'completed',
    closingLine:'Completed · Checked on the real system: four requests settled.',
    answerSource:{inputId:'request:fixture-control',runId:'one-worker-run'}};
  const posts=['one','two','three','four'].map(id=>postForwardedThreadAnswer({...base,eventId:`final-${id}`,requestId:`request-${id}`}));
  expect(new Set(posts).size).toBe(1);
  expect(db.query("SELECT count(*) AS n FROM session_owner_events WHERE kind='post'").get()).toEqual({n:1});
  expect(db.query("SELECT count(*) AS n FROM session_owner_events WHERE kind='answer_closure'").get()).toEqual({n:4});
  const firstSequence=(db.query('SELECT sequence FROM session_owner_events WHERE event_id=?').get(posts[0]!) as {sequence:number}).sequence;
  expect(preparedInboxDisplay(db,inboxId,firstSequence,posts[0]!)?.preview.closingLine)
    .toBe('Completed · Checked on the real system: four requests settled.');
  const requestIds=(db.query("SELECT json_extract(payload_json,'$.requestId') AS requestId FROM session_owner_events WHERE kind='answer_closure' ORDER BY sequence").all() as {requestId:string}[]).map(row=>row.requestId);
  expect(requestIds).toEqual(['request-one','request-two','request-three','request-four']);
  const different=postForwardedThreadAnswer({...base,eventId:'final-different',requestId:'request-five',
    closingLine:'Failed · Checked on the real system: the fifth request failed.'});
  expect(different).not.toBe(posts[0]);
});

test('one explicit multi-request reply produces one return without comparing answer text',async()=>{
  session();const requester=run(),target=session(),worker=run();
  const first=await ask(requester.source,target,'first-grouped',{requestedEffect:'work'});
  const second=await ask(requester.source,target,'second-grouped',{requestedEffect:'work'});
  await communication.idle();
  const common={source:worker.source,text:'The shared result.',final:true,workDisposition:'completed' as const,
    all_done:true,checked:'the shared result was inspected',answer_group:'explicit-group'};
  communication.reply({...common,action_id:'first-answer',request_id:first.request_id});
  communication.reply({...common,action_id:'second-answer',request_id:second.request_id});
  await communication.idle();
  const a=communication.inspect(first.request_id).events.find(event=>event.kind==='final')!;
  const b=communication.inspect(second.request_id).events.find(event=>event.kind==='final')!;
  expect(a.accepted_input_id).toBe(b.accepted_input_id);
  expect(db.query("SELECT count(*) AS n FROM session_inputs WHERE id LIKE 'return:%'").get()).toEqual({n:1});
});

// A steered request is attached to the running turn before its words are prepared and sent. On
// 2026-11-09 concierge:3425's Stop hook demanded a verdict in that gap, twice, and the request's
// text arrived seconds after the verdict. It is owed only once its text reached the provider.
test('a steered request is owed only once its text was sent to the running turn',async()=>{
  session();const requester=run(),target=session(),worker=run();
  const targetId=Number(target.session.id.slice(10));
  db.query("UPDATE sessions SET agent_session_uuid='owed-after-delivery' WHERE id=?").run(targetId);
  steeringMode='pending';
  const request=await ask(requester.source,target,'steered-unsent');
  await communication.idle();
  const steered=getAcceptedSessionInput('request:'+request.request_id)!;
  expect(steered.turn_id).toBe(worker.claim.turn_id);
  const owed=()=>communication.owed({provider:'codex',provider_session_id:'owed-after-delivery'}).owed.map(one=>one.request_id);
  expect(owed()).not.toContain(request.request_id);
  markTurnSteeringMessageSending(steered.steering_id!);
  expect(owed()).not.toContain(request.request_id);
  markTurnSteeringMessageSent(steered.steering_id!);
  expect(owed()).toContain(request.request_id);
});

// The Inbox sends one request per thread and they routinely steer into one recipient turn, so
// sharing a turn is not evidence of a shared answer. A September rule copied one request's reply
// onto every other request that turn held and closed two unrelated threads on the wrong words
// (docs/incidents/2026-11-04-one-reply-closed-sibling-requests.md). Its acceptance scenario.
test('a final reply to one request leaves another sharing its turn open for its own reply',async()=>{
  session();const requester=run(),target=session(),worker=run();
  const first=await ask(requester.source,target,'first-shared');
  const second=await ask(requester.source,target,'second-shared');
  await communication.idle();
  const opened=getAcceptedSessionInput('request:'+first.request_id)!,steered=getAcceptedSessionInput('request:'+second.request_id)!;
  expect(opened.turn_id).toBe(worker.claim.turn_id);
  expect(steered.turn_id).toBe(worker.claim.turn_id);
  expect(steered.steering_id).not.toBeNull();
  communication.reply({source:worker.source,action_id:'answer-first',request_id:first.request_id,
    text:'The first thread’s answer.',final:true,workDisposition:'completed',all_done:true,checked:'the first thread’s result was inspected'});
  finishTurn(worker.claim.turn_id,'done','Whole-run text that addressed only the first request');
  await communication.idle();
  expect(communication.inspect(first.request_id)).toMatchObject({outcome:'answered',
    result:{text:expect.stringContaining('The first thread’s answer.')}});
  const open=communication.inspect(second.request_id);
  expect(open.outcome).toBeNull();
  expect(open.result).toBeNull();
  expect(open.events).toEqual([]);
  // The turn ending is not an answer either way: the recipient is sent back for what it still owes.
  const reminder=getAcceptedSessionInput(`report-back:${second.request_id}`);
  expect(reminder).toMatchObject({origin:'service',request_id:second.request_id});
  const again=run();
  expect(again.claim.accepted_input_id).toBe(reminder!.id);
  communication.reply({source:again.source,action_id:'answer-second',request_id:second.request_id,
    text:'The second thread’s own answer.',final:true,workDisposition:'completed',all_done:true,checked:'the second thread’s result was inspected'});
  await communication.idle();
  expect(communication.inspect(second.request_id)).toMatchObject({outcome:'answered',
    result:{text:expect.stringContaining('The second thread’s own answer.')}});
  expect(errors).toEqual([]);
});

test('a final body after a prompt answer remains a visible new post',async()=>{
  const inbox=session(),inboxId=Number(inbox.session.id.slice(10));
  const root=(db.query('SELECT id FROM session_inputs WHERE session_id=? ORDER BY rowid LIMIT 1').get(inboxId) as {id:string}).id;
  const base={inboxSessionId:inboxId,requestId:'new-words',root,inboxInputId:root,respondingSessionId:'concierge:worker',
    attachments:[],stalled:false,workDisposition:null};
  postForwardedThreadAnswer({...base,eventId:'first-words',text:'Initial answer.',final:false,answersQuestion:true});
  const final=postForwardedThreadAnswer({...base,eventId:'later-words',text:'A new detail.',final:true,
    workDisposition:'completed',closingLine:'Completed · Checked on the real system: new detail verified.'});
  expect(db.query("SELECT count(*) AS n FROM session_owner_events WHERE kind='post'").get()).toEqual({n:2});
  const posted=db.query('SELECT payload_json FROM session_owner_events WHERE event_id=?').get(final) as {payload_json:string};
  expect(JSON.parse(posted.payload_json).text).toBe('A new detail.');
});

function historicalFixture() {
  const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
  const source={id:'archive:exact-conversation',version:digest('original immutable transcript'),branch:'branch-one',provider:'codex',title:'Historical orchard decision',
    scope:'fixture-scope',nativeId:'fixture-native-orchard',synthetic:false,createdAt:'2026-10-01T00:00:00.000Z',project:null,omissions:[] as string[],
    consultation:{sourceId:'archive:exact-conversation',boundary:'event-2',sourceVersion:digest('original immutable transcript'),packetVersion:'dialogue-v1'},
    messages:[{sourceId:'archive:exact-conversation',sourceVersion:digest('original immutable transcript'),eventId:'event-1',ordinal:0,role:'user',locator:'jsonl:1',text:'The orchard uses six pear trees.',textHash:digest('The orchard uses six pear trees.')}]};
  owner.runtime.capabilities=()=>({consultation:true});
  const calls:any[]=[];
  owner.runtime.sources={search:async()=>({sources:[source],matches:source.messages.map(message=>({...message,branch:source.branch})),complete:true}),
    context:async input=>{calls.push(input);return {source:structuredClone(source),evidence:source.messages,hasMore:false};},import:async()=>{throw new Error('No import write needed');}};
  return {source,calls};
}
test('historical ask atomically creates an agent-origin restricted child and receives only its correlated answer',async()=>{
  session();const current=run(),a={native:current.source,turn:current.claim.turn_id},fixture=historicalFixture(),source=a.native;
  const parent=(await communication.search({source,concepts:['orchard']})).results.find(row=>row.session.origin==='imported')!;
  const before=getSessionById(Number(parent.session.id.slice(10)));
  const input={source,action_id:'historical-question',address:parent.session.address,text:'How many pear trees were selected?',evidence:parent.evidence,requestedEffect:'informational' as const};
  const [first,duplicate]=await Promise.all([communication.ask(input),communication.ask(input)]);
  expect(first.request_id).toBe(duplicate.request_id);
  expect(first.target_session_id).not.toBe(parent.session.id);
  const accepted=getAcceptedSessionInput(first.target_input_id!)!;
  expect(accepted).toMatchObject({kind:'consultation',origin:'agent',source_input_id:a.native.input_id,source_run_id:a.native.run_id,request_id:first.request_id});
  expect(JSON.parse(accepted.payload_json)).toMatchObject({address:parent.session.address,sourceId:fixture.source.id,sourceVersion:fixture.source.version,branch:fixture.source.branch,boundary:fixture.source.consultation.boundary,delivery:'queue'});
  expect(JSON.parse(accepted.payload_json).preparedPrompt).toContain(JSON.stringify({role:'user',eventId:'event-1',locator:'jsonl:1',textHash:fixture.source.messages[0]!.textHash,text:'The orchard uses six pear trees.'}));
  const operation=owner.get(`concierge:${accepted.session_id}`).operations[0]!;
  expect(operation.childSessionId).toBe(first.target_session_id);
  expect(communication.inspect(first.request_id).operation_id).not.toBeNull();
  expect(owner.receipt(getAcceptedSessionInput(first.operation_id!)!)).toMatchObject({kind:'request',origin:'agent',childSessionId:first.target_session_id});
  expect(getSessionById(Number(parent.session.id.slice(10)))).toEqual(before);
  await communication.idle();const b=run();expect(b.claim.accepted_input_id).toBe(accepted.id);
  await expect(communication.ask({source:b.source,action_id:'forbidden-outbound',address:parent.session.address,text:'Do work'})).rejects.toThrow('Consultation-only');
  finishTurn(b.claim.turn_id,'done','Six pear trees, from event-1 (jsonl:1).');await communication.idle();
  const answered=communication.inspect(first.request_id);
  expect(answered).toMatchObject({outcome:'answered',result:{responding_session_id:first.target_session_id,text:'Six pear trees, from event-1 (jsonl:1).'},events:[{kind:'final',status:'received'}]});
  expect(getAcceptedSessionInput('return:'+answered.events[0]!.event_id)).toMatchObject({origin:'service',request_id:first.request_id,source_input_id:a.native.input_id});
  expect((await communication.ask(input)).request_id).toBe(first.request_id);
  expect(db.query('SELECT count(*) AS n FROM sessions').get()).toEqual({n:3});
  expect(db.query('SELECT count(*) AS n FROM routed_requests').get()).toEqual({n:0});
  expect(errors).toEqual([]);
});

test('historical evidence and child acceptance reject changed source, unsupported work and a dead caller without a return obligation or provider input',async()=>{
  session();const current=run(),a={native:current.source,turn:current.claim.turn_id},fixture=historicalFixture();
  const parent=(await communication.search({source:a.native,concepts:['orchard']})).results.find(row=>row.session.origin==='imported')!;
  const input={source:a.native,action_id:'historical-question',address:parent.session.address,text:'Pear trees?'};
  await expect(communication.ask({...input,requestedEffect:'work'})).rejects.toThrow('consultation only');
  await expect(communication.ask({...input,evidence:[{...parent.evidence[0],sourceVersion:'b'.repeat(64)}]})).rejects.toThrow('exact retained dialogue');
  fixture.source.messages[0]!.text='Changed without hash';
  await expect(communication.ask(input)).rejects.toThrow('verification');
  fixture.source.messages[0]!.text='The orchard uses six pear trees.';
  const context=owner.runtime.sources!.context;
  owner.runtime.sources!.context=async value=>{const result=await context(value);finishTurn(a.turn,'done','Source ended during evidence preparation');return result;};
  await expect(communication.ask(input)).rejects.toThrow('exact live run');
  expect(db.query('SELECT count(*) AS n FROM sessions').get()).toEqual({n:2});
  expect(db.query('SELECT count(*) AS n FROM session_communication_requests').get()).toEqual({n:0});
  expect(db.query("SELECT count(*) AS n FROM session_inputs WHERE origin='agent'").get()).toEqual({n:0});
});

test('a source refresh invalidates prior addresses and a request transaction failure rolls back its historical child and packet',async()=>{
  session();const current=run(),a={native:current.source,turn:current.claim.turn_id},fixture=historicalFixture();
  const parent=(await communication.search({source:a.native,concepts:['orchard']})).results.find(row=>row.session.origin==='imported')!.session;
  fixture.source.version='a'.repeat(64);fixture.source.messages[0]!.sourceVersion=fixture.source.version;fixture.source.consultation.sourceVersion=fixture.source.version;
  const refreshed=(await communication.search({source:a.native,concepts:['orchard']})).results.find(row=>row.session.id===parent.id)!.session;
  expect(refreshed.id).toBe(parent.id);expect(refreshed.address).not.toBe(parent.address);
  await expect(communication.ask({source:a.native,action_id:'old',address:parent.address,text:'Question'})).rejects.toThrow('binding changed');
  db.exec("CREATE TEMP TRIGGER fail_historical_request BEFORE INSERT ON session_inputs WHEN NEW.kind='request' BEGIN SELECT RAISE(ABORT,'historical transaction fault'); END");
  try{await expect(communication.ask({source:a.native,action_id:'rollback',address:refreshed.address,text:'Question'})).rejects.toThrow('historical transaction fault');}
  finally{db.exec('DROP TRIGGER fail_historical_request');}
  expect(db.query('SELECT count(*) AS n FROM sessions').get()).toEqual({n:2});
  expect(db.query('SELECT count(*) AS n FROM session_communication_requests').get()).toEqual({n:0});
  expect(db.query("SELECT count(*) AS n FROM session_inputs WHERE origin='agent'").get()).toEqual({n:0});
});

test('native request, immutable metadata and mandatory return are one transaction even when the target replies immediately',async()=>{
  const source=session(),a=run(),target=session(),b=run();
  const input={clientActionId:'http-question',sourceInputId:a.source.input_id,sourceRunId:a.source.run_id,targetAddress:target.session.address,text:'Exact question',requestedEffect:'informational',evidence:[{sourceId:'retained',sourceVersion:'a'.repeat(64),eventId:'exact'}]};
  const response=await owner.handle(new Request('http://owner/sessions/v1/requests',{method:'POST',body:JSON.stringify(input)}));
  expect(response!.status).toBe(202);
  const receipt=(await response!.json()).operation;
  expect(receipt).toMatchObject({kind:'request',origin:'agent',text:'Exact question',request:{requestedEffect:'informational',evidence:input.evidence}});
  expect(getAcceptedSessionInput('request:'+receipt.requestId)?.source_input_id).toBe(a.source.input_id);
  await communication.idle();
  communication.reply({source:b.source,action_id:'immediate-final',request_id:receipt.requestId,text:'The exact answer',final:true,evidence:input.evidence});
  await communication.idle();
  const inspected=await owner.handle(new Request('http://owner/sessions/v1/operations/'+receipt.operationId));
  const final=await inspected!.json();
  expect(final).toMatchObject({settlement:{outcome:'answered'},result:'The exact answer'});
  expect(final.returnDelivery).toEqual([expect.objectContaining({kind:'final',state:'received'})]);
  expect(communication.inspect(receipt.requestId).execution?.acknowledged_at).not.toBeNull();
  expect(db.query('SELECT count(*) AS n FROM session_communication_requests').get()).toEqual({n:1});
  await expect(ask(a.source,target,'http-question',{evidence:[]})).rejects.toThrow('conflict');
  expect(errors).toEqual([]);
});

test('a proven-unsent live return is queued with the same input/event identity and acknowledged after requester idle',async()=>{
  session();const a=run();const target=session(),b=run();
  const request=(await ask(a.source,target,'ask',{requestedEffect:'informational'}));await communication.idle();
  steeringMode='pending';
  communication.reply({source:b.source,action_id:'answer',request_id:request.request_id,text:'retained answer',final:true});
  await communication.idle();
  const event=communication.inspect(request.request_id).events[0]!;
  const original=getAcceptedSessionInput('return:'+event.event_id)!;
  expect(original.steering_id).not.toBeNull();
  markTurnSteeringMessageFailed(original.steering_id!,'Provider closed before send');
  await communication.idle();
  const queued=getAcceptedSessionInput(original.id)!;
  expect(errors).toEqual([]);
  expect(queued.id).toBe(original.id);
  expect(queued.turn_id).not.toBe(original.turn_id);
  expect(queued.steering_id).toBeNull();
  expect(db.query('SELECT status FROM turns WHERE id=?').get(queued.turn_id)).toEqual({status:'queued'});
  finishTurn(a.claim.turn_id,'done','Requester ended before consuming the return');
  const resumed=run();expect(resumed.claim.turn_id).toBe(queued.turn_id);
  await communication.idle();
  expect(communication.inspect(request.request_id).events).toEqual([expect.objectContaining({event_id:event.event_id,status:'received'})]);
  expect(db.query("SELECT count(*) AS n FROM session_inputs WHERE id=?").get(original.id)).toEqual({n:1});
});

test('an ambiguous live return remains attached to its exact execution and never becomes a new provider input',async()=>{
  session();const a=run();const target=session(),b=run();const request=(await ask(a.source,target,'ask',{requestedEffect:'informational'}));await communication.idle();
  steeringMode='pending';communication.reply({source:b.source,action_id:'answer',request_id:request.request_id,text:'retained answer',final:true});await communication.idle();
  const event=communication.inspect(request.request_id).events[0]!,original=getAcceptedSessionInput('return:'+event.event_id)!;
  markTurnSteeringMessageSending(original.steering_id!);markTurnSteeringMessageAmbiguous(original.steering_id!,'Acknowledgement lost');
  await communication.idle();communication.wake();await communication.idle();
  expect(getAcceptedSessionInput(original.id)).toMatchObject({turn_id:a.claim.turn_id,steering_id:original.steering_id});
  expect(db.query("SELECT count(*) AS n FROM turns WHERE session_id=?").get(original.session_id)).toEqual({n:1});
  expect(communication.inspect(request.request_id).events[0]!.status).toBe('uncertain');
  expect(errors).toEqual([]);
});

test('a dependent request stays outside FIFO while its prerequisite return can enter an idle requester',async()=>{
  const source=session(),a=run(),target=session(),b=run();
  const first=(await ask(a.source,target,'first',{requestedEffect:'informational'})),later=(await ask(a.source,target,'later',{after:[first.request_id],requestedEffect:'informational'}));
  await communication.idle();
  expect(getAcceptedSessionInput('request:'+later.request_id)?.turn_id).toBeNull();
  finishTurn(a.claim.turn_id,'done','Independent source work ended');
  communication.reply({source:b.source,action_id:'first-answer',request_id:first.request_id,text:'first result',final:true});
  await communication.idle();
  const next=run();
  expect(next.claim.session_id).toBe(Number(source.session.id.slice(10)));
  expect(getAcceptedSessionInput(next.claim.accepted_input_id!)?.origin).toBe('service');
  expect(getAcceptedSessionInput('request:'+later.request_id)?.turn_id).toBe(b.claim.turn_id);
  expect(errors).toEqual([]);
});

test('native cancellation retries identify the same request and never stop its recipient run',async()=>{
  session();const a=run();const target=session(),b=run();
  const first=(await ask(a.source,target,'first')),second=(await ask(a.source,target,'second'));await communication.idle();
  const cancel={source:a.source,action_id:'cancel-one',request_id:first.request_id};
  expect(communication.cancel(cancel).outcome).toBe('canceled');
  expect(communication.cancel(cancel).outcome).toBe('canceled');
  expect(()=>communication.cancel({...cancel,request_id:second.request_id})).toThrow('conflict');
  expect(communication.inspect(second.request_id).outcome).toBeNull();
  expect(db.query('SELECT status,stop_requested_at FROM turns WHERE id=?').get(b.claim.turn_id)).toEqual({status:'running',stop_requested_at:null});
  expect(db.query("SELECT count(*) AS n FROM session_inputs WHERE kind='cancel'").get()).toEqual({n:1});
  await communication.idle();expect(errors).toEqual([]);
});

test('failure persisting the requester operation rolls back the request and target input together', async () =>{
  session();const a=run(),target=session();run();
  db.exec("CREATE TEMP TRIGGER fail_source_request BEFORE INSERT ON session_inputs WHEN NEW.kind='request' BEGIN SELECT RAISE(ABORT,'source persistence fault'); END");
  try{await expect(ask(a.source,target)).rejects.toThrow('source persistence fault');}finally{db.exec('DROP TRIGGER fail_source_request');}
  expect(db.query('SELECT count(*) AS n FROM session_communication_requests').get()).toEqual({n:0});
  expect(db.query('SELECT count(*) AS n FROM session_inputs WHERE request_id IS NOT NULL').get()).toEqual({n:0});
  expect(db.query("SELECT count(*) AS n FROM session_owner_events WHERE kind='request'").get()).toEqual({n:0});
});

for(const provider of ['codex','chatgpt'] as const)test(`${provider} restricted recipient returns only its exact unsteered acknowledged request through the service`,async()=>{
  session();const a=run();
  const target=owner.create({clientActionId:randomUUID(),provider,purpose:'chat'});
  if(provider==='codex')updateSessionMetadata(Number(target.session.id.slice(10)),{interactionPolicy:'consultation-only'});
  const task=provider==='chatgpt'?{for_task:'direct_input:'+a.source.input_id}:{};
  const first=(await ask(a.source,target,'first',task));await communication.idle();const b=run();
  const second=(await ask(a.source,target,'second',task));await communication.idle();
  expect(getAcceptedSessionInput('request:'+second.request_id)!.turn_id).not.toBe(b.claim.turn_id);
  expect(getAcceptedSessionInput('request:'+second.request_id)!.steering_id).toBeNull();
  finishTurn(b.claim.turn_id,'done','Answer for the first exact input');await communication.idle();
  expect(communication.inspect(first.request_id)).toMatchObject({outcome:'answered',result:{text:'Answer for the first exact input'}});
  expect(communication.inspect(second.request_id).outcome).toBeNull();
  expect(communication.inspect(first.request_id).events).toHaveLength(1);
  expect(db.query('SELECT count(*) AS n FROM session_communication_requests').get()).toEqual({n:2});
  if(provider==='codex')await expect(ask(a.source,target,'write',{requestedEffect:'work'})).rejects.toThrow('consultation only');
  expect(errors).toEqual([]);
});

test('a steered restricted recipient cannot turn whole-run output into an answer to its earlier question',async()=>{
  session();const a=run(),target=session();const existing=run();finishTurn(existing.claim.turn_id,'done','seed');
  updateSessionMetadata(Number(target.session.id.slice(10)),{interactionPolicy:'consultation-only'});
  const request=(await ask(a.source,target));await communication.idle();const b=run();
  owner.submit(target.session.id,{clientActionId:randomUUID(),text:'A different question',delivery:'steer',expectedRunId:b.source.run_id});
  finishTurn(b.claim.turn_id,'done','Response after intervening steering');await communication.idle();
  expect(communication.inspect(request.request_id)).toMatchObject({outcome:null,result:null,events:[],execution:{turn_id:b.claim.turn_id,input_status:'done'}});
  expect(errors).toEqual([]);
});

test('explicit ChatGPT intent creates one agent-authored target and returns its exact answer without Slack',async()=>{
  const requester=session(),a=run();
  const fixtures=await Bun.file(new URL('../../docs/contracts/session-owner-v1/surface.json',import.meta.url)).json();
  const fixture=fixtures.cases.find((value:any)=>value.name==='explicit-chatgpt-agent-request-creates-native-target');
  const body={...fixture.request.body,sourceInputId:a.source.input_id,sourceRunId:a.source.run_id,forTask:`direct_input:${a.source.input_id}`};
  const post=()=>owner.handle(new Request('http://owner/sessions/v1/requests',{method:'POST',body:JSON.stringify(body)}));
  const response=await post();expect(response!.status).toBe(202);
  const accepted=(await response!.json()).operation;
  const request=communication.inspect(accepted.requestId);
  const target=getAcceptedSessionInput(request.target_input_id!)!;
  expect(accepted).toMatchObject({kind:'request',origin:'agent',request:{targetProvider:'chatgpt'}});
  expect(target).toMatchObject({kind:'create',origin:'agent',source_input_id:a.source.input_id,source_run_id:a.source.run_id,request_id:accepted.requestId});
  expect(getSessionById(target.session_id)).toMatchObject({provider_id:'chatgpt',slack_channel_id:null,slack_thread_ts:null,agent_session_uuid:null});
  expect(JSON.parse(target.payload_json).firstInput.text).toContain(body.text);
  expect((await (await post())!.json()).operation.operationId).toBe(accepted.operationId);
  await communication.idle();const b=run();expect(b.claim.session_id).toBe(target.session_id);
  finishTurn(a.claim.turn_id,'done','Requester may end while the exact answer is pending');
  finishTurn(b.claim.turn_id,'done','Ferns tolerate shade.');await communication.idle();
  const answer=communication.inspect(accepted.requestId);
  expect(answer).toMatchObject({outcome:'answered',result:{text:'Ferns tolerate shade.',responding_session_id:`concierge:${target.session_id}`}});
  const returned=getAcceptedSessionInput('return:'+answer.events[0]!.event_id)!;
  expect(returned).toMatchObject({origin:'service',session_id:Number(requester.session.id.slice(10)),request_id:accepted.requestId});
  const resumed=run();expect(resumed.claim.accepted_input_id).toBe(returned.id);await communication.idle();
  expect(communication.inspect(accepted.requestId).events[0]!.status).toBe('received');
  expect(db.query('SELECT count(*) AS n FROM sessions').get()).toEqual({n:2});
  expect(db.query('SELECT count(*) AS n FROM slack_user_input_claims').get()).toEqual({n:0});
  expect(errors).toEqual([]);
});

test('unavailable ChatGPT keeps one failed creation and exact return obligation without fallback or retry',async()=>{
  session();const a=run();let availabilityChecks=0;owner.runtime.available=provider=>provider!=='chatgpt'||++availabilityChecks===1;
  const input={source:a.source,action_id:'unavailable-chatgpt',for_task:'direct_input:'+a.source.input_id,provider:'chatgpt' as const,text:'Ask ChatGPT about shade plants'};
  const first=(await communication.ask(input));await communication.idle();
  const target=getAcceptedSessionInput(first.target_input_id!)!;
  expect(owner.receipt(target)).toMatchObject({kind:'create',origin:'agent',state:'failed',error:{message:'chatgpt start unavailable.'}});
  expect(target.turn_id).toBeNull();
  // A failed ChatGPT attempt no longer settles the request: the exact answer stays owed to the task
  // and the obligation moves to receipt reconciliation (ee3a5ff2).
  expect(communication.inspect(first.request_id)).toMatchObject({outcome:null,result:null});
  expect(chatGptObligationForAttempt(first.request_id)).toMatchObject({state:'reconcile_receipt'});
  expect(JSON.parse((db.query('SELECT payload_json FROM session_owner_events WHERE event_id=?').get(`chatgpt-original-attempt-failed:${first.request_id}`) as any).payload_json).text).toContain('failed before an answer returned: chatgpt start unavailable.');
  owner.runtime.available=()=>true;
  expect((await communication.ask(input)).request_id).toBe(first.request_id);communication.wake();await communication.idle();
  expect(getAcceptedSessionInput(target.id)!.turn_id).toBeNull();
  expect(db.query('SELECT count(*) AS n FROM sessions').get()).toEqual({n:2});
  await expect(communication.ask({...input,text:'Different question'})).rejects.toThrow('conflict');
  expect(errors).toEqual([]);
});

test('an uncertain ChatGPT start returns retained failure evidence and never creates a replacement effect',async()=>{
  session();const a=run();
  const input={source:a.source,action_id:'uncertain-chatgpt',for_task:'direct_input:'+a.source.input_id,provider:'chatgpt' as const,text:'Shade plants?'};
  const accepted=(await communication.ask(input));await communication.idle();
  const claim=claimNextQueuedTurn('fixture-owner')!;
  markTurnProviderAdmissionIntended(claim.turn_id,'fixture-owner',claim.dispatch_attempt);
  expect(parkRunningTurnAfterProviderFailure({turnId:claim.turn_id,ownerInstanceId:'fixture-owner',dispatchAttempt:claim.dispatch_attempt,failureClass:'parked_ambiguous',error:'ChatGPT send uncertain: browser acknowledgement was lost.'})).toBeTrue();
  await communication.idle();
  const receipt=communication.inspect(accepted.request_id);
  expect(receipt).toMatchObject({outcome:null,result:null,execution:{acknowledged_at:null,input_status:'parked'}});
  expect(chatGptObligationForAttempt(accepted.request_id)).toMatchObject({state:'reconcile_receipt'});
  expect(JSON.parse((db.query('SELECT payload_json FROM session_owner_events WHERE event_id=?').get(`chatgpt-original-attempt-failed:${accepted.request_id}`) as any).payload_json).text).toContain('failed before an answer returned');
  expect(owner.receipt(getAcceptedSessionInput(accepted.target_input_id!)!)).toMatchObject({state:'uncertain',error:{message:'ChatGPT send uncertain: browser acknowledgement was lost.'}});
  expect((await communication.ask(input)).request_id).toBe(accepted.request_id);
  communication.wake();await communication.idle();
  expect(db.query('SELECT count(*) AS n FROM turns WHERE session_id=?').get(claim.session_id)).toEqual({n:1});
  expect(communication.inspect(accepted.request_id).events).toHaveLength(0);
  expect(db.query("SELECT count(*) AS n FROM session_owner_events WHERE event_id LIKE 'chatgpt-original-attempt-failed:%'").get()).toEqual({n:1});
  owner.submit(`concierge:${claim.session_id}`,{clientActionId:'later-human-question',text:'Later question'});
  // A parked native turn is history that later input carries as context, not a queue blocker (b7df801b).
  const later=claimNextQueuedTurn('fixture-owner');
  expect(later).toMatchObject({turn_user_text:'Later question'});
  expect(later!.turn_id).not.toBe(claim.turn_id);
  expect(db.query('SELECT status,owner_instance_id,dispatch_failure_class FROM turns WHERE id=?').get(claim.turn_id)).toEqual({status:'parked',owner_instance_id:null,dispatch_failure_class:'parked_ambiguous'});
  expect(errors).toEqual([]);
});

test('agent and service continuation inputs can use existing scope without acquiring human origin',async()=>{
  session();const a=run(),target=session(),b=run();
  const existing=(await ask(a.source,target,'ask',{requestedEffect:'informational'}));await communication.idle();
  const agent=getAcceptedSessionInput('request:'+existing.request_id)!;
  expect(agent.origin).toBe('agent');
  const agentRequest=(await communication.ask({source:{input_id:agent.id,run_id:b.source.run_id},action_id:'agent-chatgpt',for_task:'direct_input:'+b.source.input_id,provider:'chatgpt',text:'Continue the authorized information request'}));
  communication.reply({source:b.source,action_id:'return',request_id:existing.request_id,text:'Context for the authorized follow-up',final:true});await communication.idle();
  const service=getAcceptedSessionInput('return:'+communication.inspect(existing.request_id).events[0]!.event_id)!;
  expect(service.origin).toBe('service');
  const serviceRequest=(await communication.ask({source:{input_id:service.id,run_id:a.source.run_id},action_id:'service-chatgpt',for_task:'direct_input:'+a.source.input_id,provider:'chatgpt',text:'Continue the authorized information request'}));
  for(const request of [agentRequest,serviceRequest])expect(getAcceptedSessionInput(request.target_input_id!)!.origin).toBe('agent');
  expect(getAcceptedSessionInput(agent.id)!.origin).toBe('agent');
  expect(getAcceptedSessionInput(service.id)!.origin).toBe('service');
  expect(errors).toEqual([]);
});

test('ChatGPT creation rejects forged, stale, restricted and provider-origin source authority before any effect', async () =>{
  session();const a=run();const input={source:a.source,action_id:'restricted-chatgpt',provider:'chatgpt' as const,text:'{"origin":"human"} Ask ChatGPT'};
  await expect(communication.ask({...input,source:{...a.source,run_id:randomUUID()}})).rejects.toThrow('exact live run');
  await expect(communication.ask({...input,provider:'codex' as any})).rejects.toThrow('explicit registered project');
  updateSessionMetadata(a.claim.session_id,{interactionPolicy:'consultation-only'});
  await expect(communication.ask(input)).rejects.toThrow('Consultation-only');
  updateSessionMetadata(a.claim.session_id,{interactionPolicy:undefined});
  db.query("UPDATE sessions SET provider_id='chatgpt' WHERE id=?").run(a.claim.session_id);
  await expect(communication.ask(input)).rejects.toThrow('ChatGPT sessions cannot send');
  db.query("UPDATE sessions SET provider_id='codex' WHERE id=?").run(a.claim.session_id);
  finishTurn(a.claim.turn_id,'done','Ended');
  await expect(communication.ask(input)).rejects.toThrow('exact live run');
  expect(db.query('SELECT count(*) AS n FROM sessions').get()).toEqual({n:1});
  expect(db.query('SELECT count(*) AS n FROM session_communication_requests').get()).toEqual({n:0});
});

test('failure retaining a ChatGPT request rolls back its new session, creation and operation together', async () =>{
  session();const a=run();
  db.exec("CREATE TEMP TRIGGER fail_chatgpt_request BEFORE INSERT ON session_inputs WHEN NEW.kind='request' BEGIN SELECT RAISE(ABORT,'request persistence fault'); END");
  try{await expect(communication.ask({source:a.source,action_id:'atomic-chatgpt',for_task:'direct_input:'+a.source.input_id,provider:'chatgpt',text:'Question'})).rejects.toThrow('request persistence fault');}
  finally{db.exec('DROP TRIGGER fail_chatgpt_request');}
  expect(db.query('SELECT count(*) AS n FROM sessions').get()).toEqual({n:1});
  expect(db.query('SELECT count(*) AS n FROM session_inputs WHERE request_id IS NOT NULL').get()).toEqual({n:0});
  expect(db.query('SELECT count(*) AS n FROM session_communication_requests').get()).toEqual({n:0});
});

test('a Slack-born admitted source creates ChatGPT through native ownership without Slack publication',async()=>{
  upsertChannel({slack_channel_id:'CCHATGPT',slack_channel_name:'chatgpt',group_name:null,name:'ChatGPT',vault_path:'/tmp',code_path:'/tmp',provider_default:'codex'});
  const session=createOrGetSession('CCHATGPT','100.000001','codex');
  const claimed=claimSlackUserInput('CCHATGPT','100.000001','chatgpt-source','fixture-owner',{userId:'U1',userText:'Ask ChatGPT about shade plants',replyThreadTs:'100.000001'});
  const turn=acquireSessionTurn(session.id,'100.000001','Ask ChatGPT about shade plants','fixture-owner',claimed.row.claim_token,'100.000001',{userId:'U1'});
  markTurnProviderAdmissionIntended(turn.id,'fixture-owner',turn.dispatchAttempt);
  const source={channel_id:'CCHATGPT',message_ts:'100.000001'};
  const first=(await communication.ask({source,action_id:'chatgpt-slack',for_task:'direct_input:slack:CCHATGPT:100.000001',provider:'chatgpt',text:'Shade plants?'}));
  const target=getAcceptedSessionInput(first.target_input_id!)!;
  expect(target.source_input_id).toBe('slack:CCHATGPT:100.000001');
  expect(target.source_run_id).toBe(nativeRunId(turn.id));
  await communication.idle();const b=run();finishTurn(b.claim.turn_id,'done','Ferns');await communication.idle();
  expect(communication.inspect(first.request_id).outcome).toBe('answered');
  expect(db.query('SELECT count(*) AS n FROM slack_user_input_claims').get()).toEqual({n:1});
  expect(db.query('SELECT count(*) AS n FROM routed_requests').get()).toEqual({n:0});
  expect(errors).toEqual([]);
});

function slackSession(channel:string,timestamp:string) {
  upsertChannel({slack_channel_id:channel,slack_channel_name:channel.toLowerCase(),group_name:null,name:channel,vault_path:'/tmp',code_path:'/tmp',provider_default:'codex'});
  const session=createOrGetSession(channel,timestamp,'codex');
  const claimed=claimSlackUserInput(channel,timestamp,randomUUID(),'fixture-owner',{userId:'U1',userText:'Original human input',replyThreadTs:timestamp});
  const turn=acquireSessionTurn(session.id,timestamp,'Original human input','fixture-owner',claimed.row.claim_token,timestamp,{userId:'U1'});
  markTurnProviderAdmissionIntended(turn.id,'fixture-owner',turn.dispatchAttempt);
  acknowledgeTurnProviderInput(turn.id,'fixture-owner',turn.dispatchAttempt,[]);
  return {session,turn,source:{channel_id:channel,message_ts:timestamp},
    address:'session:'+Buffer.from(JSON.stringify([1,session.id,channel,timestamp])).toString('base64url')};
}

test('historical Slack source and exact destination become native inputs with correlated partial and final returns',async()=>{
  const a=slackSession('CLEGACYA','100.000001'),b=slackSession('CLEGACYB','100.000002');
  const input={source:a.source,action_id:'legacy-address',address:b.address,text:'Actual agent question',requestedEffect:'informational' as const};
  const first=await communication.ask(input);
  expect((await communication.ask(input)).request_id).toBe(first.request_id);
  expect(first.target_address).toBe(owner.view(b.session).address);
  expect(getAcceptedSessionInput(first.target_input_id!)).toMatchObject({origin:'agent',session_id:b.session.id,
    source_input_id:'slack:CLEGACYA:100.000001',source_run_id:nativeRunId(a.turn.id),request_id:first.request_id});
  await communication.idle();
  const partial={source:b.source,action_id:'partial',request_id:first.request_id,text:'Working on it',final:false};
  communication.reply(partial);communication.reply(partial);await communication.idle();
  expect(communication.inspect(first.request_id)).toMatchObject({outcome:null,events:[{kind:'progress',status:'received'}]});
  communication.reply({...partial,action_id:'final',text:'Answer',final:true});await communication.idle();
  expect(communication.inspect(first.request_id)).toMatchObject({outcome:'answered',events:[{kind:'progress',status:'received'},{kind:'final',status:'received'}]});
  expect(db.query('SELECT count(*) AS n FROM routed_requests').get()).toEqual({n:0});
  expect(db.query('SELECT count(*) AS n FROM slack_user_input_claims').get()).toEqual({n:2});
  expect(errors).toEqual([]);
});

test('partial obligation survives recipient completion and only that session can finish it later',async()=>{
  session();const a=run(),target=session(),b=run(),other=session(),c=run();
  const request=await ask(a.source,target,'ask',{requestedEffect:'informational'});await communication.idle();
  communication.reply({source:b.source,action_id:'partial',request_id:request.request_id,text:'Still working',final:false});
  finishTurn(b.claim.turn_id,'done','This turn is ending');await communication.idle();
  expect(communication.inspect(request.request_id).outcome).toBeNull();
  expect(()=>communication.reply({source:c.source,action_id:'wrong-session',request_id:request.request_id,text:'Not mine',final:true})).toThrow('exact recipient');
  owner.submit(target.session.id,{clientActionId:randomUUID(),text:'Continue the pending question',delivery:'queue'});
  const later=run();
  expect(later.claim.session_id).toBe(b.claim.session_id);
  communication.reply({source:later.source,action_id:'later-final',request_id:request.request_id,text:'Final answer',final:true});await communication.idle();
  expect(communication.inspect(request.request_id)).toMatchObject({outcome:'answered',events:[{kind:'progress',status:'received'},{kind:'final',status:'received'}]});
  expect(errors).toEqual([]);
});

for(const control of ['pause','archive'] as const)test(`${control} holds native request admission and return delivery without creating another input`,async()=>{
  const source=session(),a=run(),target=session(),b=run();
  const request=await ask(a.source,target,'ask',{requestedEffect:'informational'});await communication.idle();
  owner.action(source.session.id,{clientActionId:randomUUID(),action:{kind:control}});
  communication.reply({source:b.source,action_id:'final',request_id:request.request_id,text:'Retained result',final:true});await communication.idle();
  const event=communication.inspect(request.request_id).events[0]!;
  expect(event).toMatchObject({kind:'final',status:'held'});
  expect(getAcceptedSessionInput('return:'+event.event_id)).toBeNull();
  await expect(ask(b.source,source,'new-question')).rejects.toThrow('not currently messageable');
  communication.wake();await communication.idle();
  expect(getAcceptedSessionInput('return:'+event.event_id)).toBeNull();
  expect(communication.inspect(request.request_id).outcome).toBe('answered');
  expect(errors).toEqual([]);
});

test('a stopped requester receives a later retained return once as a new service turn',async()=>{
  const source=session(),a=run(),target=session(),b=run();
  const request=await ask(a.source,target,'ask',{requestedEffect:'informational'});await communication.idle();
  await owner.stop(source.session.id,{clientActionId:randomUUID(),runId:a.source.run_id});
  finishTurn(a.claim.turn_id,'cancelled','Native Stop');
  const canceled=db.query('SELECT * FROM turns WHERE id=?').get(a.claim.turn_id);
  communication.reply({source:b.source,action_id:'final-after-stop',request_id:request.request_id,text:'The requested information is retained.',final:true});await communication.idle();
  const event=communication.inspect(request.request_id).events[0]!;
  expect(event.status).toBe('admitted');
  const returned=getAcceptedSessionInput('return:'+event.event_id)!;
  expect(returned).toMatchObject({origin:'service',source_input_id:a.source.input_id,source_run_id:a.source.run_id,steering_id:null});
  const later=run();expect(later.claim.accepted_input_id).toBe(returned.id);expect(later.claim.session_id).toBe(a.claim.session_id);
  communication.wake();await communication.idle();await communication.stop();communication.start();await communication.idle();
  expect(communication.inspect(request.request_id).events[0]!.status).toBe('received');
  expect(db.query('SELECT count(*) AS n FROM turns WHERE session_id=?').get(a.claim.session_id)).toEqual({n:2});
  expect(db.query('SELECT * FROM turns WHERE id=?').get(a.claim.turn_id)).toEqual(canceled);
  expect(errors).toEqual([]);
});

test('delegation retains originating human provenance across agent hops without widening an informational request',async()=>{
  // The Inbox session lives in the registered slack-inbox project, which the shared '/tmp' owner has not got.
  const workspace=mkdtempSync(join(tmpdir(),'native-communication-workspace-'));
  mkdirSync(join(workspace,'slack-inbox','.git'),{recursive:true});writeFileSync(join(workspace,'slack-inbox','AGENTS.md'),'# fixture\n');
  await communication.stop();await build(workspace);
  const inbox=owner.acceptInboxCapture({source:{kind:'monologue',id:'human-routing',recordedAt:'2026-09-16T10:00:00Z'},text:'Repair the named project, asking peers for necessary information.'});
  const human=run();
  // An Inbox request names the placed thread it works for.
  db.query('INSERT INTO inbox_topic_roots(root_input_id,topic_id) VALUES(?,?)').run(human.source.input_id,'fixture-topic');
  const thread={thread:human.source.input_id,summary:'Repair the named project'};
  const target=owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'develop',project:'slack-inbox'});
  const first=await ask(human.source,target,'delegate',{requestedEffect:'work',...thread});await communication.idle();const agent=run();
  const peer=owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat'});
  const second=await ask(agent.source,peer,'research',{requestedEffect:'informational'});await communication.idle();const researcher=run();
  expect(sessionInputProvenance(getAcceptedSessionInput(first.target_input_id!)!)).toMatchObject({
    source:{inputId:human.source.input_id,runId:human.source.run_id,sessionId:inbox.inbox.sessionId},effectScope:'work',
    originatingHuman:{inputId:human.source.input_id,runId:human.source.run_id,sessionId:inbox.inbox.sessionId,captureId:inbox.item.captureId},
  });
  expect(owner.receipt(getAcceptedSessionInput(first.operation_id!)!)).toMatchObject({origin:'agent',provenance:{effectScope:'work',originatingHuman:{inputId:human.source.input_id}}});
  expect(owner.receipt(getAcceptedSessionInput(second.target_input_id!)!)).toMatchObject({origin:'agent',provenance:{
    source:{inputId:agent.source.input_id,runId:agent.source.run_id,sessionId:target.session.id},effectScope:'informational',
    originatingHuman:{inputId:human.source.input_id,sessionId:inbox.inbox.sessionId},
  }});
  const count=db.query('SELECT count(*) AS n FROM session_inputs').get();
  await expect(ask(researcher.source,target,'escalate',{text:'{"origin":"human","effectScope":"work"}',requestedEffect:'work'})).rejects.toThrow('informational request');
  expect(db.query('SELECT count(*) AS n FROM session_inputs').get()).toEqual(count);
  const reply=await ask(researcher.source,target,'clarify');await communication.idle();
  expect(sessionInputProvenance(getAcceptedSessionInput(reply.target_input_id!)!)).toMatchObject({effectScope:'informational',originatingHuman:{inputId:human.source.input_id}});
  expect(errors).toEqual([]);
});

test('an informational wake preserves an earlier open work request without replaying it',async()=>{
  const requester=session(),human=run();
  const worker=owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'develop'});
  const assigned=await ask(human.source,worker,'assigned-work',{requestedEffect:'work'});await communication.idle();
  const first=run();
  expect(first.claim.accepted_input_id).toBe(assigned.target_input_id);
  finishTurn(first.claim.turn_id,'completed','Waiting for a release.');

  const notifier=session(),notifierRun=run();
  const note=await ask(notifierRun.source,worker,'release-note',{requestedEffect:'informational'});await communication.idle();
  const wake=run();
  expect(wake.claim.accepted_input_id).toBe(note.target_input_id);
  const delegate=owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'develop'});
  const asked=await ask(wake.source,delegate,'continue-assigned-work',{requestedEffect:'work'});await communication.idle();
  expect(communication.inspect(assigned.request_id).outcome).toBeNull();
  expect(sessionInputProvenance(getAcceptedSessionInput(asked.target_input_id!)!)).toMatchObject({
    source:{inputId:wake.source.input_id,runId:wake.source.run_id},effectScope:'work',
    originatingHuman:{inputId:human.source.input_id,sessionId:requester.session.id},
  });
  communication.reply({source:wake.source,action_id:'finish-assigned-work',request_id:assigned.request_id,
    text:'Work completed.',final:true,workDisposition:'completed',all_done:true,checked:'The assigned work was checked.'});
  expect(communication.inspect(assigned.request_id).outcome).toBe('answered');
  await expect(ask(wake.source,delegate,'unrelated-work',{requestedEffect:'work'})).rejects.toThrow('informational request');
  expect(errors).toEqual([]);
});

test('unresolved legacy requests and returns stay visibly uncertain without settlement, replay or deadline wake',async()=>{
  const source=session(),a=run(),target=session(),b=run(),requestId=randomUUID(),eventId=randomUUID();
  db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,source_root_ts,action_id,
    target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(requestId,'COLD','100.000001',a.claim.turn_id,a.claim.session_id,'100.000001','old-action',b.claim.session_id,'COTHER','100.000002',JSON.stringify({text:'Uncertain old question',after:[]}), 'retained-hash',1,1);
  db.query('INSERT INTO session_communication_events(event_id,request_id,kind,payload_json,created_at_ms) VALUES(?,?,?,?,?)')
    .run(eventId,requestId,'final',JSON.stringify({text:'Uncertain old return'}),1);
  const turns=db.query('SELECT count(*) AS n FROM turns').get(),inputs=db.query('SELECT count(*) AS n FROM session_inputs').get();
  communication.wake();await communication.idle();communication.wake();await communication.idle();
  expect(communication.inspect(requestId)).toMatchObject({status:'uncertain',outcome:null,overdue_at_ms:null,error:expect.stringContaining('reconciliation'),events:[{event_id:eventId,status:'uncertain'}]});
  expect(db.query('SELECT count(*) AS n FROM turns').get()).toEqual(turns);
  expect(db.query('SELECT count(*) AS n FROM session_inputs').get()).toEqual(inputs);
  expect(db.query('SELECT count(*) AS n FROM routed_requests').get()).toEqual({n:0});
  expect(errors).toEqual([]);
});

test('a parked native execution with its original host is reclaimed without a second dispatch attempt',()=>{
  const created=session(),{claim,source}=run();
  const sessionId=Number(created.session.id.slice(10));
  const executionId=randomUUID().replaceAll('-','').slice(0,16);
  retainExecutionIntent({executionId,turnId:claim.turn_id,dispatchAttempt:claim.dispatch_attempt,
    sessionId,provider:'claude-code',directory:'/tmp/parked-fixture',processor:{},coordinatorInstanceId:'fixture-owner'});
  db.query("UPDATE executions SET state='live' WHERE execution_id=?").run(executionId);
  expect(parkRunningTurnAfterProviderFailure({turnId:claim.turn_id,ownerInstanceId:'fixture-owner',
    dispatchAttempt:claim.dispatch_attempt,failureClass:'parked_ambiguous',error:'adoption lost the CLI'})).toBeTrue();
  recordSessionEvent({eventId:`terminal:${claim.turn_id}:${claim.dispatch_attempt}`,sessionId,
    inputId:source.input_id,turnId:claim.turn_id,kind:'run',payload:{run:{status:'uncertain'}}});
  const execution=db.query('SELECT * FROM executions WHERE execution_id=?').get(executionId) as any;
  expect(claimExecutionTurn(execution,null,'new-owner',true)).toBeTrue();
  expect(db.query('SELECT status,owner_instance_id,dispatch_attempt FROM turns WHERE id=?').get(claim.turn_id))
    .toEqual({status:'running',owner_instance_id:'new-owner',dispatch_attempt:claim.dispatch_attempt});
  expect(db.query('SELECT status FROM sessions WHERE id=?').get(sessionId)).toEqual({status:'running'});
  recordSessionEvent({eventId:`recovered-terminal:${claim.turn_id}:${claim.dispatch_attempt}:${execution.adoptions+1}`,sessionId,
    inputId:source.input_id,turnId:claim.turn_id,kind:'run',payload:{run:{status:'succeeded'}}});
  expect(db.query("SELECT count(*) AS n FROM session_owner_events WHERE turn_id=? AND kind='run' AND event_id LIKE '%terminal:%'").get(claim.turn_id))
    .toEqual({n:2});
  expect(claimExecutionTurn(execution,null,'another-owner',true)).toBeFalse();
});
