// Deterministic disposable-owner acceptance for tool-read ChatGPT answer handling.
// The ChatGPT final is seeded as a provider precondition; the test exercises only Concierge ownership.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CHATGPT_TOOL_READ_ACCEPTANCE_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'concierge-chatgpt-tool-read-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=CHATGPT_TOOL_READ_ACCEPTANCE_TEST_AUTHORIZATION;

const [{db,claimNextQueuedTurn,markTurnProviderAdmissionIntended,acknowledgeTurnProviderInput,finishTurn},{SessionOwner},
  {SessionCommunicationCoordinator},{nativeRunId,retainSessionInput,enqueueSessionInput},
  {admitChatGptObligation,recordChatGptAttemptResult}]=await Promise.all([
  import('../src/state'),import('../src/session-owner'),import('../src/session-communication'),import('../src/session-inputs'),import('../src/chatgpt-obligations')]);

const errors:unknown[]=[];
const owner=new SessionOwner({available:()=>true,wake:()=>{},stop:async()=>false,steer:()=>false},scratch);
const communication=new SessionCommunicationCoordinator({owner,isOwnerAlive:()=>true,onError:error=>errors.push(error)});
owner.communication=communication;

function run(expectedSession:number,excluded:number[]=[]){
  const claim=claimNextQueuedTurn('chatgpt-tool-read-acceptance',Date.now(),excluded);
  assert.ok(claim);
  assert.equal(claim.session_id,expectedSession);
  assert.equal(markTurnProviderAdmissionIntended(claim.turn_id,'chatgpt-tool-read-acceptance',claim.dispatch_attempt),true);
  acknowledgeTurnProviderInput(claim.turn_id,'chatgpt-tool-read-acceptance',claim.dispatch_attempt,[]);
  return {source:{input_id:claim.accepted_input_id!,run_id:nativeRunId(claim.turn_id)},inputId:claim.accepted_input_id!,turnId:claim.turn_id};
}

try{
  communication.start();await communication.idle();
  const asker=await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text:'Tool-read acceptance asker'}});
  const askerId=Number(asker.session.id.slice(10));
  const active=run(askerId);
  const unrelated=await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text:'Wrong actor control'}});
  const unrelatedId=Number(unrelated.session.id.slice(10));
  const other=run(unrelatedId);

  const parentRequest='tool-read-parent-request';
  const unrelatedTask='tool-read-unrelated-task';
  let requestSequence=0;
  const insertRequest=(id:string,sourceSession:number,targetSession:number,sourceTurn:number,targetInput:string,actionId:string)=>{
    requestSequence++;
    const sourceInput=(db.query('SELECT accepted_input_id FROM turns WHERE id=?').get(sourceTurn) as {accepted_input_id:string}).accepted_input_id;
    db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,
      source_root_ts,action_id,target_session_id,target_channel,target_root_ts,payload_json,payload_hash,source_input_id,target_input_id,due_at_ms,created_at_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,'fixture',`fixture-${requestSequence}`,sourceTurn,sourceSession,'fixture-root',actionId,targetSession,
        'fixture','fixture-root',JSON.stringify({text:id,after:[],requestedEffect:'work'}),createHash('sha256').update(id).digest('hex'),
        sourceInput,targetInput,Date.now()+60_000,Date.now());
  };
  insertRequest(parentRequest,unrelatedId,askerId,other.turnId,active.inputId,'parent-work');
  insertRequest(unrelatedTask,unrelatedId,askerId,other.turnId,active.inputId,'unrelated-work');
  db.query('UPDATE session_inputs SET request_id=? WHERE id=?').run(parentRequest,active.inputId);
  const task={kind:'local_request' as const,id:parentRequest};
  const otherTask={kind:'local_request' as const,id:unrelatedTask};

  const addAnswer=(requestId:string,eventId:string)=>{
    insertRequest(requestId,askerId,unrelatedId,active.turnId,other.inputId,`chatgpt-${requestId}`);
    const payload=JSON.stringify({text:`Exact ChatGPT answer bytes for ${requestId}`});
    db.query(`INSERT INTO session_communication_events(event_id,request_id,kind,payload_json,status,created_at_ms)
      VALUES(?,?, 'final',?,'recorded',?)`).run(eventId,requestId,payload,'2026-11-13T00:00:00Z');
    db.query(`UPDATE session_communication_requests SET status='settled',outcome='answered',result_json=?,due_at_ms=0 WHERE request_id=?`)
      .run(JSON.stringify({event_id:eventId,outcome:'answered'}),requestId);
    admitChatGptObligation({requestId,task,askerSessionId:askerId,question:`Question ${requestId}`,targetSessionId:'chatgpt:fixture',now:Date.now()});
    recordChatGptAttemptResult({requestId,outcome:'answered',answerEventId:eventId,now:Date.now()});
  };
  addAnswer('tool-read-chatgpt-request','tool-read-chatgpt-event');
  admitChatGptObligation({requestId:'unrelated-open-answer',task:otherTask,askerSessionId:askerId,
    question:'A different task still has an answer open',targetSessionId:'chatgpt:fixture',now:Date.now()});

  const queued=retainSessionInput({sessionId:askerId,scope:'fixture:queued-chatgpt-return',actionId:'queued-chatgpt-return',
    kind:'input',origin:'service',payload:{text:'Original native ChatGPT return'},sourceInputId:active.inputId,
    sourceRunId:active.source.run_id,requestId:'tool-read-chatgpt-request'}).input;
  const queuedTurn=enqueueSessionInput(queued.id);
  const before=db.query('SELECT status,accepted_input_id FROM turns WHERE id=?').get(queuedTurn.turn_id);
  const beforeReturn=db.query('SELECT status,accepted_input_id FROM session_communication_events WHERE event_id=?').get('tool-read-chatgpt-event');
  assert.equal((before as any).status,'queued');

  const result=communication.get({source:active.source,request_id:'tool-read-chatgpt-request'}) as any;
  const read=result.tool_read_receipt;
  assert.ok(read?.readReceiptId,'the asker gets an opaque retained receipt only from its exact supported get');
  assert.equal(read.answerEventId,'tool-read-chatgpt-event');
  assert.deepEqual(db.query('SELECT state,answer_return_input_id FROM session_chatgpt_obligations WHERE obligation_id=?').get('tool-read-chatgpt-request'),
    {state:'return_pending',answer_return_input_id:null},'reading does not claim provider acknowledgement');
  assert.deepEqual(db.query('SELECT status,accepted_input_id FROM session_communication_events WHERE event_id=?').get('tool-read-chatgpt-event'),beforeReturn);
  assert.deepEqual(db.query('SELECT status,accepted_input_id FROM turns WHERE id=?').get(queuedTurn.turn_id),before,'queued return turn stays held');
  const repeatedRead=(communication.get({source:active.source,request_id:'tool-read-chatgpt-request'}) as any).tool_read_receipt;
  assert.equal(repeatedRead.readReceiptId,read.readReceiptId,'retrying get in the same accepted run returns the same opaque receipt');
  assert.throws(()=>communication.reply({source:active.source,action_id:'premature-complete',request_id:parentRequest,text:'Too early.',
    final:true,workDisposition:'completed',summary:'Original task completion attempt',all_done:true,checked:'No explicit answer handling yet.'}),
    'reading alone cannot close the original work request');
  const wrongRun={...active.source,run_id:'another-native-run'};
  assert.throws(()=>communication.get({source:wrongRun,request_id:'tool-read-chatgpt-request'}));
  db.query('UPDATE session_inputs SET request_id=? WHERE id=?').run(unrelatedTask,active.inputId);
  assert.equal((communication.get({source:active.source,request_id:'tool-read-chatgpt-request'}) as any).tool_read_receipt,undefined,
    'the same session cannot read a receipt through a source bound to a different task');
  db.query('UPDATE session_inputs SET request_id=? WHERE id=?').run(parentRequest,active.inputId);

  const answer=(actionId:string,source:any,requestId:string,eventId:string,readReceiptId?:string,handling:'used'|'superseded'='used')=>communication.handleChatGptAnswer({
    source,action_id:actionId,obligation_id:requestId,answer_event_id:eventId,handling,
    ...(handling==='superseded'?{successor_request_id:'unused-successor'}:{}),...(readReceiptId?{read_receipt_id:readReceiptId}:{})});
  assert.throws(()=>answer('wrong-event',active.source,'tool-read-chatgpt-request','other-event',read.readReceiptId));
  assert.throws(()=>answer('wrong-actor',other.source,'tool-read-chatgpt-request','tool-read-chatgpt-event',read.readReceiptId));
  assert.throws(()=>answer('wrong-token',active.source,'tool-read-chatgpt-request','tool-read-chatgpt-event','guessed-receipt'));
  assert.throws(()=>answer('unsupported-superseded',active.source,'tool-read-chatgpt-request','tool-read-chatgpt-event',read.readReceiptId,'superseded'),
    /only valid when handling the answer as used or scoped/);
  const originalPayload=(db.query('SELECT payload_json FROM session_communication_events WHERE event_id=?').get('tool-read-chatgpt-event') as {payload_json:string}).payload_json;
  db.query('UPDATE session_communication_events SET payload_json=? WHERE event_id=?').run(JSON.stringify({text:'changed'}),'tool-read-chatgpt-event');
  assert.throws(()=>answer('changed-bytes',active.source,'tool-read-chatgpt-request','tool-read-chatgpt-event',read.readReceiptId));
  db.query('UPDATE session_communication_events SET payload_json=? WHERE event_id=?').run(originalPayload,'tool-read-chatgpt-event');

  answer('confirm-tool-read',active.source,'tool-read-chatgpt-request','tool-read-chatgpt-event',read.readReceiptId);
  assert.equal(answer('confirm-tool-read',active.source,'tool-read-chatgpt-request','tool-read-chatgpt-event',read.readReceiptId).duplicate,true,
    'retrying explicit confirmation returns the retained disposition');
  assert.throws(()=>answer('confirm-tool-read',active.source,'tool-read-chatgpt-request','tool-read-chatgpt-event','changed-receipt'),
    'a retry cannot change the confirmed receipt');
  const nativeSession=await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text:'Native return control'} });
  const nativeSessionId=Number(nativeSession.session.id.slice(10));
  const nativeActive=run(nativeSessionId);
  const nativeParent='native-return-parent-task';
  insertRequest(nativeParent,unrelatedId,nativeSessionId,other.turnId,nativeActive.inputId,'native-parent-work');
  db.query('UPDATE session_inputs SET request_id=? WHERE id=?').run(nativeParent,nativeActive.inputId);
  const nativeTask={kind:'local_request' as const,id:nativeParent};
  insertRequest('native-chatgpt-request',nativeSessionId,unrelatedId,nativeActive.turnId,other.inputId,'chatgpt-native-chatgpt-request');
  db.query(`INSERT INTO session_communication_events(event_id,request_id,kind,payload_json,status,created_at_ms)
    VALUES(?,?,'final',?,'recorded',?)`).run('native-chatgpt-event','native-chatgpt-request',JSON.stringify({text:'Exact native answer'}),new Date().toISOString());
  db.query(`UPDATE session_communication_requests SET status='settled',outcome='answered',result_json=?,due_at_ms=0 WHERE request_id=?`)
    .run(JSON.stringify({event_id:'native-chatgpt-event',outcome:'answered'}),'native-chatgpt-request');
  admitChatGptObligation({requestId:'native-chatgpt-request',task:nativeTask,askerSessionId:nativeSessionId,
    question:'Native control question',targetSessionId:'chatgpt:fixture',now:Date.now()});
  recordChatGptAttemptResult({requestId:'native-chatgpt-request',outcome:'answered',answerEventId:'native-chatgpt-event',now:Date.now()});
  finishTurn(nativeActive.turnId,'done','Native asker turn ended before its return.');
  await communication.idle();
  const nativeEventBefore=db.query('SELECT status,accepted_input_id FROM session_communication_events WHERE event_id=?').get('native-chatgpt-event') as any;
  assert.ok(nativeEventBefore.accepted_input_id,'coordinator admitted the ordinary native return');
  const nativeReturnRun=run(nativeSessionId,[askerId]);
  await communication.idle();
  assert.deepEqual(db.query('SELECT status,accepted_input_id FROM session_communication_events WHERE event_id=?').get('native-chatgpt-event'),
    {status:'received',accepted_input_id:nativeEventBefore.accepted_input_id},'native provider acknowledgement follows the public queued return lifecycle');
  answer('confirm-native-return',nativeReturnRun.source,'native-chatgpt-request','native-chatgpt-event');
  const final=communication.reply({source:active.source,action_id:'complete-original-task',request_id:parentRequest,text:'Completed the original work.',
    final:true,workDisposition:'completed',summary:'Original requested work is complete',all_done:true,checked:'Exercised the native get, exact answer handling, and original completed reply in this disposable owner ledger.'});
  assert.equal(final.status,'settled');
  assert.deepEqual(db.query('SELECT state,answer_return_input_id FROM session_chatgpt_obligations WHERE obligation_id=?').get('tool-read-chatgpt-request'),
    {state:'resolved',answer_return_input_id:null});
  assert.deepEqual(db.query('SELECT state,answer_return_input_id FROM session_chatgpt_obligations WHERE obligation_id=?').get('native-chatgpt-request'),
    {state:'resolved',answer_return_input_id:nativeEventBefore.accepted_input_id});
  assert.deepEqual(db.query('SELECT state FROM session_chatgpt_obligations WHERE obligation_id=?').get('unrelated-open-answer'),{state:'awaiting_answer'});
  assert.deepEqual(db.query('SELECT status,accepted_input_id FROM turns WHERE id=?').get(queuedTurn.turn_id),before);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({fixture:'chatgpt-tool-read-acceptance',status:'passed',toolReadHandled:true,
    providerReturnStillUnacknowledged:true,nativeReturnPreserved:true,wrongActorEventAndBytesRefused:true,
    originalTaskCompleted:true,unrelatedObligationOpen:true,queuedReturnUnchanged:true}));
}finally{
  communication.stop();
  db.close();
  rmSync(scratch,{recursive:true,force:true});
}
