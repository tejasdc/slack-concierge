import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LEGACY_TOPIC_COMPLETION_TEST_AUTHORIZATION} from '../src/test-authorizations';
import {askedDispatch,askedAnswerPostIds,askedAnswerStatus,requireAskedAnswer} from '../src/asked-answer';
import {PROMPT_ANSWER_REMINDER_MS,PROMPT_ANSWER_OVERDUE_MS} from '../src/prompt-answer-policy';

const scratch=mkdtempSync(join(tmpdir(),'concierge-asked-answer-'));
Object.assign(process.env,{CONCIERGE_STATE_DIR:scratch,CONCIERGE_CAPTURE_STATE_DIR:join(scratch,'capture'),
 CONCIERGE_TEST_MODE:'1',CONCIERGE_TEST_AUTHORIZATION:LEGACY_TOPIC_COMPLETION_TEST_AUTHORIZATION});
const [{db,claimNextQueuedTurn,markTurnProviderAdmissionIntended,acknowledgeTurnProviderInput},
 {SessionOwner},{SessionCommunicationCoordinator},{SessionPeers},
 {nativeRunId,updateSessionMetadata,recordSessionEvent},{topicsCommand,readTopic}]=await Promise.all([
 import('../src/state'),import('../src/session-owner'),import('../src/session-communication'),import('../src/session-peers'),
 import('../src/session-inputs'),import('../src/session-topics')]);
let now=Date.now();const errors:unknown[]=[];
const owner=new SessionOwner({available:()=>true,wake:()=>{},steer:()=>false,stop:async()=>false},scratch);
const communication=new SessionCommunicationCoordinator({owner,now:()=>now,arm:()=>()=>{},isOwnerAlive:()=>true,onError:error=>errors.push(error)});
owner.communication=communication;
function run(){
 const claim=claimNextQueuedTurn('asked-answer-fixture');assert.ok(claim);
 assert.equal(markTurnProviderAdmissionIntended(claim.turn_id,'asked-answer-fixture',claim.dispatch_attempt),true);
 acknowledgeTurnProviderInput(claim.turn_id,'asked-answer-fixture',claim.dispatch_attempt,[]);
 const runId=nativeRunId(claim.turn_id),inputId=claim.accepted_input_id!;
 return {actor:{sessionId:claim.session_id,turnId:claim.turn_id,inputId,runId},source:{input_id:inputId,run_id:runId}};
}
try{
 communication.start();await communication.idle();
 const inbox=await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text:'Synthetic question: what happened to the answer?'}});
 const inboxId=Number(inbox.session.id.slice(10));updateSessionMetadata(inboxId,{inbox:true});
 const asker=run(),root=asker.actor.inputId;
 const area=topicsCommand(asker.actor,{verb:'area.create',action_id:'asked-area',name:'Synthetic question checks'}).area;
 const created=topicsCommand(asker.actor,{verb:'create',action_id:'asked-topic',title:'Synthetic asked-answer check',roots:[root],area_ids:[area.id]});
 const topicId=created.topic.topicId;
 const obligation=topicsCommand(asker.actor,{verb:'request.add',topic_id:topicId,action_id:'asked-request',title:'Answer this exact question',sources:[root],brief:'Answer while the work continues.'}).request;
 const target=await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat'});
 const dispatched=await communication.ask({source:asker.source,action_id:'asked-dispatch',address:target.session.address,thread:root,
  summary:'Answer the exact retained question',text:'Give a prompt answer, then continue working.',requestedEffect:'work'});
 await communication.idle();const worker=run();
 const row=()=>db.query('SELECT * FROM session_communication_requests WHERE request_id=?').get(dispatched.request_id) as any;
 assert.equal(JSON.parse(row().payload_json).promptAnswer,undefined,'A thread address alone does not classify passive notes as questions');
 communication.topics({source:asker.source,verb:'request.link',request_id:obligation.requestId,action_id:'asked-link',dispatch:dispatched.request_id});
 const declaration=communication.topics({source:asker.source,verb:'questions',topic_id:topicId,action_id:'asked-question',questions:[{
  kind:'asked',context:'agent_checking',decision:'What happened to the answer?',sources:[root],
  owner:{sessionId:target.session.id,dispatchRequestId:dispatched.request_id}}]});
 await communication.idle();
 const question=readTopic(topicId).questions.find((q:any)=>q.kind==='asked')!;
 assert.ok(question);assert.equal(JSON.parse(row().payload_json).promptAnswer,1);
 assert.equal(row().due_at_ms,row().created_at_ms+PROMPT_ANSWER_REMINDER_MS);
 const questionRecord={...question,questionId:question.id};
 assert.equal(requireAskedAnswer(db,questionRecord),false,'Recognizing the same obligation twice does not reset its clock');
 const postsBefore=(db.query("SELECT count(*) AS n FROM session_owner_events WHERE kind IN ('post','needs_you')").get() as any).n;
 now=row().created_at_ms+PROMPT_ANSWER_REMINDER_MS;communication.wake();await communication.idle();
 assert.equal((db.query('SELECT count(*) AS n FROM session_inputs WHERE id=?').get(`question-reminder:${dispatched.request_id}`) as any).n,1);
 now=row().created_at_ms+PROMPT_ANSWER_OVERDUE_MS;communication.wake();await communication.idle();
 assert.ok(row().overdue_at_ms);assert.equal(askedAnswerStatus(db,questionRecord,false)?.delayed,true);
 assert.equal((db.query("SELECT count(*) AS n FROM session_owner_events WHERE kind IN ('post','needs_you')").get() as any).n,postsBefore,'Timer transitions do not post or notify Tejas');
 communication.reply({source:worker.source,action_id:'asked-progress',request_id:dispatched.request_id,text:'I am still checking.',final:false});
 await communication.idle();assert.equal(row().prompt_answered_at_ms,null);
 communication.reply({source:worker.source,action_id:'asked-answer',request_id:dispatched.request_id,text:'The answer was retained in its original thread; the repair continues.',final:false,answers_question:true});
 await communication.idle();assert.equal(row().prompt_answered_at_ms,now);assert.equal(row().outcome,null);
 assert.equal(askedAnswerPostIds(db,questionRecord,[inboxId]).length,1);
 const legacy={kind:'asked',topicId,sources:[root],owner:null};
 assert.equal(askedDispatch(db,legacy),dispatched.request_id,'A legacy question may use one exact source-to-obligation-to-dispatch link');
 assert.equal(askedAnswerPostIds(db,legacy,[inboxId]).length,1);
 assert.equal(askedAnswerStatus(db,questionRecord,true)?.text,'Answered');
 // Before asked declarations armed clocks, an answering partial could already exist.
 // Replay that retained state: its original answer time must win over recognition time.
 db.query("UPDATE session_communication_requests SET payload_json=json_remove(payload_json,'$.promptAnswer'),prompt_answered_at_ms=NULL WHERE request_id=?")
  .run(dispatched.request_id);
 now+=60_000;
 assert.equal(requireAskedAnswer(db,questionRecord),true);
 assert.equal(row().prompt_answered_at_ms,now-60_000,'Late recognition preserves the existing answering partial timestamp');
 assert.equal(row().outcome,null,'Recognizing an existing answer does not finish the remaining work');
 const restarted=new SessionCommunicationCoordinator({owner,now:()=>now,arm:()=>()=>{},isOwnerAlive:()=>true,onError:error=>errors.push(error)});
 communication.stop();owner.communication=restarted;restarted.start();await restarted.idle();
 assert.equal((db.query('SELECT count(*) AS n FROM session_inputs WHERE id=?').get(`question-reminder:${dispatched.request_id}`) as any).n,1);
 restarted.stop();
 // A real peer recipient adds only the clock to an already accepted exact delivery.
 const peers=new SessionPeers({self:'mac',clients:new Map(),owner,now:()=>now,onError:error=>errors.push(error),isOwnerAlive:()=>true});
 const peerId=randomUUID();
 db.query(`INSERT INTO session_peer_deliveries(request_id,peer,origin_session_id,origin_input_id,origin_run_id,
  target_session_id,target_input_id,requested_effect,origin_provenance_json,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)`)
  .run(peerId,'cloud',`concierge:${inboxId}`,root,asker.actor.runId,Number(target.session.id.slice(10)),`request:${dispatched.request_id}`,'work','{}',now-180_000);
 const clock={originSessionId:`concierge:${inboxId}`,originInputId:root,originRunId:asker.actor.runId,questionId:question.id,createdAtMs:now-180_000};
 assert.throws(()=>peers.requirePromptAnswer(peerId,{...clock,originInputId:'unrelated'}),/original source/);
 peers.requirePromptAnswer(peerId,clock);peers.requirePromptAnswer(peerId,clock);
 assert.equal((db.query('SELECT count(*) AS n FROM session_inputs WHERE id=?').get(`question-reminder:${peerId}`) as any).n,1);
 const peerCommunication=new SessionCommunicationCoordinator({owner,peers,now:()=>now,arm:()=>()=>{},isOwnerAlive:()=>true,onError:error=>errors.push(error)});
 owner.communication=peerCommunication;
 const peerRequest=(body:any,verified=false)=>owner.handle(new Request(`http://fixture/sessions/v1/peers/requests/${peerId}/prompt-answer`,{
  method:'POST',headers:{'content-type':'application/json',...(verified?{'x-concierge-verified-peer':'1'}:{})},body:JSON.stringify(body)}));
 assert.equal((await peerRequest(clock))?.status,403,'An ordinary caller cannot impersonate a peer clock update');
 assert.equal((await peerRequest({...clock,originRunId:'other'},true))?.status,409,'A peer must retain the exact original run');
 const acceptedClock=await peerRequest(clock,true);assert.equal(acceptedClock?.status,202);
 assert.equal((await acceptedClock!.json() as any).recorded,true);
 peerCommunication.stop();
 peers.stop();
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({fixture:'asked-answer',exactClock:true,semanticPartial:true,quietTimers:true,legacyExactLink:true,restartIdempotence:true,peerExactClock:true}));
}finally{communication.stop();rmSync(scratch,{recursive:true,force:true});}
