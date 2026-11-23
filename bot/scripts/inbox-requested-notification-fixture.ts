import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {notificationRequest} from '../src/session-notification-request';
import {LEGACY_TOPIC_COMPLETION_TEST_AUTHORIZATION} from '../src/test-authorizations';
for(const words of ['Notify me with the link','What the fuck not is this Notify me with the fucking link where I can go now','Yeah, and I also notify me on, like, on this topic'])assert.equal(notificationRequest(words),'result');
for(const words of ['Why do you notify me with this?','You already notify me about that','Do not notify me with a link','What happened?','Save this note'])assert.equal(notificationRequest(words),null,words);
const scratch=mkdtempSync(join(tmpdir(),'concierge-requested-notification-'));
Object.assign(process.env,{CONCIERGE_STATE_DIR:scratch,CONCIERGE_CAPTURE_STATE_DIR:join(scratch,'capture'),CONCIERGE_TEST_MODE:'1',CONCIERGE_TEST_AUTHORIZATION:LEGACY_TOPIC_COMPLETION_TEST_AUTHORIZATION});
const [{db,claimNextQueuedTurn,markTurnProviderAdmissionIntended,acknowledgeTurnProviderInput},{SessionOwner},{SessionCommunicationCoordinator},
 {nativeRunId,updateSessionMetadata,recordSessionEvent,retainSessionInput},{topicsCommand},{hasPendingThreadNotification}]=await Promise.all([
 import('../src/state'),import('../src/session-owner'),import('../src/session-communication'),import('../src/session-inputs'),import('../src/session-topics'),import('../src/thread-notifications')]);
const errors:unknown[]=[];
const owner=new SessionOwner({available:()=>true,wake:()=>{},steer:()=>false,stop:async()=>false},scratch);
const communication=new SessionCommunicationCoordinator({owner,isOwnerAlive:()=>true,onError:error=>errors.push(error)});owner.communication=communication;
function run(){
 const claim=claimNextQueuedTurn('requested-notification-fixture');assert.ok(claim);
 assert.equal(markTurnProviderAdmissionIntended(claim.turn_id,'requested-notification-fixture',claim.dispatch_attempt),true);
 acknowledgeTurnProviderInput(claim.turn_id,'requested-notification-fixture',claim.dispatch_attempt,[]);
 const runId=nativeRunId(claim.turn_id),inputId=claim.accepted_input_id!;
 return {actor:{sessionId:claim.session_id,turnId:claim.turn_id,inputId,runId},source:{input_id:inputId,run_id:runId}};
}
try{
 communication.start();await communication.idle();
 const inbox=await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text:'Disposable notification check'}});
 const inboxId=Number(inbox.session.id.slice(10));updateSessionMetadata(inboxId,{inbox:true});const router=run();
 const area=topicsCommand(router.actor,{verb:'area.create',action_id:'area',name:'Question notification checks'}).area;
 const capture=(text:string,origin:'human'|'agent'='human')=>{
  const id=randomUUID();retainSessionInput({id,sessionId:inboxId,scope:'surface:thinkering',actionId:id,kind:'input',origin,payload:{text}});
  recordSessionEvent({eventId:`admitted:${id}`,sessionId:inboxId,inputId:id,kind:'inbox_capture',payload:{}});return id;
 };
 const root=capture('Notify me when the answer is ready.');
 const topic=topicsCommand(router.actor,{verb:'create',action_id:'topic',title:'Answer delivery',roots:[root],area_ids:[area.id]}).topic.topicId;
 const place=(id:string)=>topicsCommand(router.actor,{verb:'place',action_id:`place:${id}`,topic_id:topic,roots:[id]});
 assert.equal(hasPendingThreadNotification(inboxId,root),true,'Explicit human request arms delivery');
 const note=capture('Keep this note');place(note);
 const ordinaryQuestion=capture('Why did it stop?');place(ordinaryQuestion);
 assert.equal(db.query('SELECT 1 FROM inbox_thread_notifications WHERE input_id=?').get(ordinaryQuestion),null,'Questions alone never arm');
 const agent=capture('Why did it stop?','agent');place(agent);
 assert.equal(db.query('SELECT 1 FROM inbox_thread_notifications WHERE input_id=?').get(note),null);
 assert.equal(db.query('SELECT 1 FROM inbox_thread_notifications WHERE input_id=?').get(agent),null);
 const target=await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat'});
 const request=await communication.ask({source:router.source,action_id:'dispatch',address:target.session.address,thread:root,summary:'Answer the question',text:'Answer the retained question while repairing the issue.',requestedEffect:'work'});
 await communication.idle();const worker=run();
 const rings=()=>db.query("SELECT event_id,created_at,payload_json FROM session_owner_events WHERE kind='needs_you' AND json_extract(payload_json,'$.requestedNotification')=1 ORDER BY sequence")
   .all().map((row:any)=>({...JSON.parse(row.payload_json),eventId:row.event_id,createdAtUtc:row.created_at}));
 communication.post({source:router.source,action_id:'acknowledgement',thread:root,text:'I have sent this to the working agent.'});
 assert.equal(rings().length,0,'Router acknowledgement leaves pending dispatched result quiet');
 assert.equal(hasPendingThreadNotification(inboxId,root),true);
 const progress={source:worker.source,action_id:"progress",request_id:request.request_id,text:"Still investigating.",final:false};
 const progressCount=()=>db.query("SELECT count(*) AS count FROM session_communication_events WHERE request_id=? AND kind='progress'").get(request.request_id).count;
 const beforeProgress=progressCount();
 assert.throws(()=>communication.reply({...progress,notify:true}),/Progress-only --partial --notify was refused/);
 assert.equal(progressCount(),beforeProgress,"Refusal leaves no progress event");
 communication.reply(progress);
 // Older releases normalized the notified partial to this same quiet event before retaining it.
 communication.reply({...progress,notify:true});await communication.idle();
 assert.equal(progressCount(),beforeProgress+1,"An exact historical replay creates no second event");
 assert.throws(()=>communication.reply({...progress,notify:true,text:"Changed words."}),/Idempotency conflict/);
 assert.equal(rings().length,0);assert.equal(hasPendingThreadNotification(inboxId,root),true);
 communication.reply({source:worker.source,action_id:'answer',request_id:request.request_id,text:'The answer stopped during handoff; the repair continues.',final:false,answers_question:true});await communication.idle();
 assert.equal(rings().length,1,'Prompt answer rings by default');assert.equal(rings()[0].question,'The answer stopped during handoff; the repair continues.');
 assert.equal(hasPendingThreadNotification(inboxId,root),false);assert.equal(communication.inspect(request.request_id).outcome,null);
 const followup=capture('Notify me once recovery is explained.');place(followup);
 // A second exact question in the same run is a new arm, not a duplicate of its first answer.
 const second=await communication.ask({source:router.source,action_id:'dispatch-second',address:target.session.address,thread:followup,summary:'Explain recovery',text:'Explain recovery.',requestedEffect:'work'});await communication.idle();
 communication.reply({source:worker.source,action_id:'explicit-answer',request_id:second.request_id,text:'The retained input will recover through its existing request.',final:false,answers_question:true,notify:true});await communication.idle();
 assert.equal(rings().length,2);assert.equal(hasPendingThreadNotification(inboxId,root),false);
 communication.reply({source:worker.source,action_id:'close',request_id:request.request_id,text:'',final:true,workDisposition:'completed',summary:'The repair is complete',all_done:true,checked:'Disposable owner entrance exercised.'});await communication.idle();assert.equal(rings().length,2,'Bodyless final never rings the same answer twice');
 communication.reply({source:worker.source,action_id:'close-second',request_id:second.request_id,text:'Recovery is now verified.',final:true,workDisposition:'completed',summary:'Recovery verified',all_done:true,checked:'Disposable recovery exercised.',notify:true});await communication.idle();
 assert.equal(rings().length,2,'Final notify after prompt answer in the same worker run does not ring twice');
 const unrelated=capture('Notify me about the other answer.');place(unrelated);
 const quiet=capture('Notify me when the send is confirmed.');place(quiet);
 const quietRequest=await communication.ask({source:router.source,action_id:'dispatch-quiet',address:target.session.address,thread:quiet,summary:'Check the send',text:'Check the send.',requestedEffect:'work'});await communication.idle();
 communication.reply({source:worker.source,action_id:'quiet-close',request_id:quietRequest.request_id,text:'The send was accepted.',final:true,workDisposition:'completed',summary:'Send accepted',all_done:true,checked:'Disposable send receipt.',quiet_because:'The send went exactly as requested.'});await communication.idle();
 assert.equal(rings().length,3);
 assert.equal(rings()[2].notificationInputId,quiet,'Explicit human request overrides a quiet completion');
 assert.equal(db.query('SELECT consumed_by_message_id FROM inbox_thread_notifications WHERE input_id=?').get(quiet).consumed_by_message_id,rings()[2].postId);
 assert.equal(db.query('SELECT consumed_by_message_id FROM inbox_thread_notifications WHERE input_id=?').get(unrelated).consumed_by_message_id,null,'Quiet completion cannot consume another request in the same topic');
 const direct=capture('Notify me when you have explained the result.');place(direct);
 communication.post({source:router.source,action_id:'direct-answer',thread:direct,text:'The result is retained and verified.'});
 assert.equal(rings().length,4,'Router answer consumes explicit human arm without notify flag');
 assert.equal(rings()[3].question,'The result is retained and verified.');
 const {recordTurnOutcome}=await import('../src/session-turn-outcome');
 const response=capture('Notify me with the explanation when it is ready.');place(response);
 communication.post({source:router.source,action_id:'response-answer',thread:response,text:'The explanation is now complete.',keep_working:true});
 assert.equal(rings().length,4,'A keep-working post does not consume the arm');
 recordTurnOutcome({eventId:'outcome:response',sessionId:inboxId,turnId:router.actor.turnId,inputId:response,outcome:'response',text:'Read the explanation'});
 assert.equal(rings().length,5,'Response outcome consumes a later explicit arm in the same router run');
 assert.equal(rings()[4].question,'The explanation is now complete.');
 const quietOutcome=capture('Notify me with the receipt.');place(quietOutcome);
 communication.post({source:router.source,action_id:'quiet-outcome-answer',thread:quietOutcome,text:'The receipt is retained.',keep_working:true});
 recordTurnOutcome({eventId:'outcome:quiet',sessionId:inboxId,turnId:router.actor.turnId,inputId:quietOutcome,outcome:'done',text:null,quiet:'The send went as requested.'});
 assert.equal(rings().length,6);assert.equal(hasPendingThreadNotification(inboxId,quietOutcome),false);
 assert.equal(rings()[5].question,'The receipt is retained.','Quiet router outcome delivers his explicit request');
 const noticeRoot=capture("Check the direct notices.");
 const noticeTopic=topicsCommand(router.actor,{verb:"create",action_id:"notice-topic",title:"Direct notices",roots:[noticeRoot],area_ids:[area.id]}).topic.topicId;
 const parentTarget=await owner.create({clientActionId:randomUUID(),provider:"codex",purpose:"chat"});
 const parent=await communication.ask({source:router.source,action_id:"dispatch-notice-work",address:parentTarget.session.address,routeMessageId:noticeRoot,summary:"Check direct notices",requestedEffect:"work"});
 await communication.idle();const parentRun=run();
 const childTarget=await owner.create({clientActionId:randomUUID(),provider:"codex",purpose:"chat"});
 const child=await communication.ask({source:parentRun.source,action_id:"delegate-notice-work",address:childTarget.session.address,summary:"Check a delegated notice",text:"Post and notify in the marked test thread.",requestedEffect:"work"});
 await communication.idle();const childRun=run();
 assert.equal(childRun.source.input_id,`request:${child.request_id}`);
 const notice={thread:noticeRoot,topic:noticeTopic,text:"Please check the test now. I will reply here.",keep_working:true,notify:true};
 const parentPost=communication.post({...notice,source:parentRun.source,action_id:"parent-notice",promise_request:parent.request_id});
 assert.equal(parentPost.duplicate,false,"An exact linked dispatch ID is a valid promise reference");
 let usableRequest="";
 assert.throws(()=>communication.post({...notice,source:childRun.source,action_id:"child-notice",promise_request:"invalid-reference"}),error=>{
   usableRequest=String(error).match(/Use --promise-request (req:\S+)/)?.[1]??"";
   return !!usableRequest;
 });
 const explicitChild=communication.post({...notice,source:childRun.source,action_id:"explicit-child-notice",promise_request:usableRequest,notify:false});
 assert.equal(explicitChild.duplicate,false,"The suggested Inbox request is accepted from the delegated worker");
 const childPost=communication.post({...notice,source:childRun.source,action_id:"child-notice"});
 assert.equal(childPost.duplicate,false,"A worker can post through its parent’s linked work");
 assert.equal(communication.post({...notice,source:childRun.source,action_id:"child-notice"}).duplicate,true);
 const directRings=rings().slice(6);
 assert.deepEqual(directRings.map(ring=>ring.postId),[parentPost.post.messageId,childPost.post.messageId]);
 assert.throws(()=>communication.post({...notice,source:worker.source,action_id:"foreign-promise",promise_request:parent.request_id}),error=>/without a matching open Inbox request/.test(String(error))&&!String(error).includes(usableRequest));
 assert.equal(communication.inspect(parent.request_id).outcome,null);
 assert.equal(communication.inspect(child.request_id).outcome,null);
 const finalCheck=async(label:string,words:string,effect:'informational'|'work')=>{
   const root=capture(words);
   const key=label.toLowerCase().replaceAll(' ','-');
   topicsCommand(router.actor,{verb:'create',action_id:`topic-${key}`,title:label,roots:[root],area_ids:[area.id]});
   const dispatch=await communication.ask({source:router.source,action_id:`dispatch-${key}`,address:target.session.address,
     thread:root,summary:'Answer this question',text:'Answer this question.',requestedEffect:effect});
   await communication.idle();
   return {root,request_id:dispatch.request_id,source:worker.source,action_id:`reply-${key}`,final:true,summary:'Here is the answer'};
 };
 const explicit=await finalCheck('Plain informational answer','How does this work?','informational');
 const informationRings=rings().length;
 const explicitReply={...explicit,text:'The answer was already in the retained report.',notify:true};
 communication.reply(explicitReply);await communication.idle();
 assert.equal(rings().length,informationRings+1,'Explicit notify on a completed informational final rings');
 assert.equal(rings().at(-1).question,explicitReply.text);
 communication.reply(explicitReply);await communication.idle();
 assert.equal(rings().length,informationRings+1,'Exact retry cannot duplicate an informational answer notice');
 const armed=await finalCheck('Requested informational answer','What happened? Notify me.','informational');
 communication.reply({...armed,text:'The notification came from the retained post.'});await communication.idle();
 assert.equal(rings().length,informationRings+2);
 assert.equal(rings().at(-1).notificationInputId,armed.root,'Informational filing honors the human arm');
 const unchecked=await finalCheck('Unchecked work answer','What does the report say?','work');
 communication.reply({...unchecked,text:'The stored report has the answer.',notify:true,workDisposition:'completed',
   all_done:true,not_checked:'This only explains the retained report.'});await communication.idle();
 assert.equal(rings().length,informationRings+3,'A completed work final with unchecked evidence rings');
 assert.match(communication.inspect(unchecked.request_id).result.closingLine,/^Completed · Not checked live:/);
 const failed=await finalCheck('Failed answer','Notify me when the answer is ready.','work');
 communication.reply({...failed,action_id:'progress-before-failure',final:false,text:'I am still looking.'});await communication.idle();
 const afterFailureProgress=rings().length;
 assert.equal(afterFailureProgress,informationRings+3,'Progress never produces a requested push');
 communication.reply({...failed,text:'I could not find the answer.',notify:true,workDisposition:'failed'});await communication.idle();
 const afterFailedFinal=rings().length;
 assert.equal(afterFailedFinal,afterFailureProgress,'Failure never produces a requested push');
 assert.equal(hasPendingThreadNotification(inboxId,failed.root),true,'Failure leaves the arm for an actual answer');
 const quietUnarmed=await finalCheck('Quiet unrequested answer','What was sent?','work');
 communication.reply({...quietUnarmed,text:'The send went as requested.',workDisposition:'completed',all_done:true,
   checked:'The stored send receipt matches the request.',quiet_because:'The send went as requested.'});await communication.idle();
 assert.equal(rings().length,informationRings+3,'An unrequested quiet completion stays quiet');

 const crossSessionRoot=randomUUID();
 retainSessionInput({id:crossSessionRoot,sessionId:worker.actor.sessionId,scope:'surface:thinkering',
   actionId:crossSessionRoot,kind:'input',origin:'human',payload:{text:'A discussion started in another session.'}});
 recordSessionEvent({eventId:`admitted:${crossSessionRoot}`,sessionId:worker.actor.sessionId,inputId:crossSessionRoot,kind:'accepted',payload:{}});
 const filedPost={source:router.source,action_id:'filed-root-post',thread:crossSessionRoot,text:'Reply to the filed discussion.',keep_working:true};
 assert.throws(()=>communication.post(filedPost),/not a filed root or message/);
 const filedTopic=topicsCommand(router.actor,{verb:'create',action_id:'filed-topic',title:'Filed discussion',
   roots:[crossSessionRoot],area_ids:[area.id]}).topic.topicId;
 const filed=communication.post(filedPost).post;
 assert.equal(filed.topicId,filedTopic);
 assert.equal(filed.inputId,crossSessionRoot);

 const created=topicsCommand(worker.actor,{verb:'create',action_id:'worker-topic',title:'Worker discussion',area_ids:[area.id]}).topic.topicId;
 const opening={source:worker.source,action_id:'worker-topic-first-post',thread:created,text:'First post from the worker.'};
 assert.throws(()=>communication.post({...opening,topic:filedTopic}),/does not belong/);
 const first=communication.post(opening).post;
 const follow=communication.post({source:router.source,action_id:'worker-topic-followup',thread:first.messageId,text:'A reply to the first post.'}).post;
 assert.equal(follow.inputId,first.inputId);
 assert.equal(follow.topicId,created);
 topicsCommand(router.actor,{verb:'merge',action_id:'merge-worker-topic',topic_id:created,into:filedTopic,reason:'Consolidate the same discussion.'});
 assert.deepEqual(communication.post(opening),{post:first,duplicate:true});
 assert.throws(()=>communication.post({...opening,text:'Changed words.'}),/Idempotency conflict/);
 const {inboxRootResolver}=await import('../src/presentation-message-source');
 const {preparedInboxDisplay}=await import('../src/presentation-inbox-display');
 for(const post of [filed,first,follow]){
   const event=db.query('SELECT sequence FROM session_owner_events WHERE event_id=?').get(post.messageId) as {sequence:number};
   assert.equal(inboxRootResolver(db)(inboxId,post.messageId),post.inputId);
   assert.equal(db.query('SELECT topic_id FROM inbox_topic_roots WHERE root_input_id=?').get(post.inputId).topic_id,filedTopic);
   const display=preparedInboxDisplay(db,inboxId,event.sequence,post.messageId)?.preview;
   assert.equal(display?.id,post.messageId);
   assert.equal(display?.author?.kind,'agent');
   if(post===first){
     assert.equal(display?.replyToMessage,undefined);
     assert.equal((display?.author as {inputId?:string}|undefined)?.inputId,worker.source.input_id);
   }
 }
 assert.deepEqual(errors,[]);
 const results=rings();
 const receipt=(ring:any)=>({eventId:ring.eventId,postId:ring.postId,createdAtUtc:ring.createdAtUtc,
   ...(ring.notificationInputId?{armedInputId:ring.notificationInputId,consumedByPostId:db.query(
     'SELECT consumed_by_message_id FROM inbox_thread_notifications WHERE input_id=?').get(ring.notificationInputId).consumed_by_message_id}:{})});
 const failureEvents=db.query("SELECT event_id,kind FROM session_communication_events WHERE request_id=? AND kind IN ('progress','final') ORDER BY rowid")
   .all(failed.request_id);
 console.log(JSON.stringify({fixture:'inbox-requested-notification',explicitHumanRequest:true,progressQuiet:true,promptAnswer:true,explicitPartial:true,bodylessFinal:true,quietHonorsArm:true,informationalFinal:true,failedFinalQuiet:true,
   evidence:{explicitInformational:receipt(results[informationRings]),armedInformational:receipt(results[informationRings+1]),
     explicitUncheckedWork:receipt(results[informationRings+2]),armedQuietWork:receipt(results[2]),armedQuietRouter:receipt(results[5]),
     progressAndFailure:{requestId:failed.request_id,acceptedEvents:failureEvents,armedInputId:failed.root,armPending:hasPendingThreadNotification(inboxId,failed.root),
       requestedEventsFromProgress:afterFailureProgress-(informationRings+3),requestedEventsFromFailure:afterFailedFinal-afterFailureProgress},
     quietUnrequested:{requestId:quietUnarmed.request_id,requestedEvents:results.length-afterFailedFinal}}}));
}finally{await communication.stop();rmSync(scratch,{recursive:true,force:true});}
