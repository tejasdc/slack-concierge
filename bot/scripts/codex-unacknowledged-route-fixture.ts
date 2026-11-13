import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'concierge-codex-recovery-route-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION;
const [{db},{createNativeSession,retainSessionInput,enqueueSessionInput,nativeRunId,recordSessionEvent},
  {SessionCommunicationCoordinator},{reserveCodexUnacknowledgedRecovery,codexUnacknowledgedRecovery}]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/session-communication'),import('../src/state')]);
try{
  const target=createNativeSession('codex',{title:'exact Astra work',summary:'Continue the retained work',purpose:'continue exact work',origin:'native',model:'gpt-6-astra'});
  db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run('thread-exact',target.id);
  const original=retainSessionInput({id:'human-exact-model-choice',sessionId:target.id,scope:'fixture',actionId:'human-choice',
    kind:'request',origin:'human',payload:{text:'Use explicit commands to start GPT-6 Astra on extra high for this work.'}}).input;
  enqueueSessionInput(original.id);
  const originalTurn=Number((db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(original.id) as any).turn_id);
  db.query("UPDATE turns SET status='done',provider_input_acknowledged_at=CURRENT_TIMESTAMP,provider_turn_id='prior-work' WHERE id=?").run(originalTurn);
  const requestId='open-work-request';
  const report=retainSessionInput({id:`report-back:${requestId}`,sessionId:target.id,scope:'fixture',actionId:'report-back',
    kind:'request',origin:'service',requestId,sourceInputId:original.id,sourceRunId:nativeRunId(originalTurn),payload:{text:'report result'}}).input;
  enqueueSessionInput(report.id);
  const targetTurn=Number((db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(report.id) as any).turn_id),targetRun=nativeRunId(targetTurn);
  const providerResult={sessionUUID:'thread-exact',providerTurnId:'native-empty',model:'gpt-6-astra',text:'',toolsUsed:[]};
  db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({state:'completed',admission:{provider:'codex',inputId:report.id,
    runId:targetRun,bindingGeneration:target.binding_generation,model:'gpt-6-astra',reasoningEffort:'xhigh'}}),report.id);
  db.query("UPDATE turns SET status='done',dispatch_attempt=1,provider_admission_intended_at=CURRENT_TIMESTAMP,provider_started_at=CURRENT_TIMESTAMP,provider_turn_id='native-empty',outbound_text=?,ended_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(JSON.stringify({version:1,result:providerResult}),targetTurn);
  db.query("UPDATE sessions SET status='idle' WHERE id=?").run(target.id);
  recordSessionEvent({eventId:`attention:${report.id}:1`,sessionId:target.id,inputId:report.id,turnId:targetTurn,kind:'attention',payload:{dispatchAttempt:1}});
  recordSessionEvent({eventId:`prompt-cache-identity:${targetTurn}:1`,sessionId:target.id,turnId:targetTurn,kind:'prompt_cache_identity',payload:{effort:'xhigh'}});
  recordSessionEvent({eventId:`result:${targetTurn}`,sessionId:target.id,inputId:report.id,turnId:targetTurn,kind:'result',
    payload:{inputId:report.id,sessionId:target.id,turnId:targetTurn,runId:targetRun,...providerResult,dispatchAttempt:1}});

  const source=createNativeSession('codex',{title:'recovery caller',summary:'Exercise the exact recovery action',purpose:'exercise exact recovery',origin:'native'});
  const actorInput=retainSessionInput({id:'human-recovery-authorization',sessionId:source.id,scope:'fixture',actionId:'recovery-authorization',
    kind:'request',origin:'human',payload:{text:'Recover the exact unacknowledged report-back.'}}).input;
  enqueueSessionInput(actorInput.id);
  const actorTurn=Number((db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(actorInput.id) as any).turn_id),actorRun=nativeRunId(actorTurn);
  db.query("UPDATE turns SET status='running',provider_admission_intended_at=CURRENT_TIMESTAMP,provider_started_at=CURRENT_TIMESTAMP WHERE id=?").run(actorTurn);
  const actionRequest={requestId,sourceChannel:'fixture',sourceMessage:'message',sourceTurn:actorTurn,sourceSession:source.id,
    sourceInput:actorInput.id,targetSession:target.id,targetInput:original.id};
  db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,
    source_root_ts,action_id,target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms,
    source_input_id,target_input_id,status,outcome) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(requestId,actionRequest.sourceChannel,actionRequest.sourceMessage,actionRequest.sourceTurn,actionRequest.sourceSession,'root','request-action',
      actionRequest.targetSession,'fixture','root',JSON.stringify({requestedEffect:'work'}),'hash',0,0,actionRequest.sourceInput,actionRequest.targetInput,'admitted',null);

  let ownerReservations=0;
  const fakeOwner={requeueProvenUnacknowledgedCodex:async(sessionId:number,inputId:string,args:any)=>{
    ownerReservations++;
    const reserved=reserveCodexUnacknowledgedRecovery({sessionId,inputId,turnId:targetTurn,requestId,providerThreadId:'thread-exact',
      bindingGeneration:target.binding_generation,proof:{threadId:'thread-exact',ownerRunId:targetRun,attempts:[{dispatchAttempt:1,providerTurnId:'native-empty',status:'completed',itemCount:0}],unmappedEmptyTurns:0},
      actionId:args.actionId,sourceInputId:args.sourceInputId,sourceRunId:args.sourceRunId,nowMs:1000});
    if(!reserved){const saved=codexUnacknowledgedRecovery(inputId);if(saved?.request_id===requestId)return {status:'already_recovered',runId:targetRun,providerTurnIds:['native-empty']};
      throw new Error('fixture reservation refused');}
    return {status:'requeued',runId:targetRun,providerTurnIds:['native-empty']};
  }};
  const coordinator=new SessionCommunicationCoordinator({owner:fakeOwner as any,isOwnerAlive:()=>true,onError:error=>{throw error;}} as any);
  (coordinator as any).stopped=false;
  (coordinator as any).wake=()=>{};
  const sourceAuth={input_id:actorInput.id,run_id:actorRun};
  const first=await coordinator.recoverCodexNeverAcknowledged({source:sourceAuth,action_id:'recover-action-one',request_id:requestId});
  assert.equal(first.status,'requeued');
  assert.equal(ownerReservations,1,'first route call makes one reservation');
  const actionRow=db.query("SELECT id FROM session_inputs WHERE session_id=? AND scope=? AND action_id=?").get(source.id,`communication:${actorInput.id}`,'recover-action-one') as any;
  db.query('UPDATE session_inputs SET receipt_json=NULL WHERE id=?').run(actionRow.id);
  const sameAction=await coordinator.recoverCodexNeverAcknowledged({source:sourceAuth,action_id:'recover-action-one',request_id:requestId});
  assert.equal(sameAction.status,'already_recovered','retry after lost control receipt returns original durable reservation');
  assert.equal(ownerReservations,1,'same action retry never inspects a changed queued turn or requeues twice');
  const differentAction=await coordinator.recoverCodexNeverAcknowledged({source:sourceAuth,action_id:'recover-action-two',request_id:requestId});
  assert.equal(differentAction.status,'already_recovered','a new action ID receives the retained target reservation');
  assert.equal(ownerReservations,1,'cross-action retry is deduplicated by the accepted report-back');
  assert.equal(codexUnacknowledgedRecovery(report.id)?.action_id,'recover-action-one');
  const infoSource=createNativeSession('codex',{title:'informational caller',summary:'Must remain informational',purpose:'verify scope fence',origin:'native'});
  const infoParent=retainSessionInput({id:'human-informational-question',sessionId:infoSource.id,scope:'fixture',actionId:'question',
    kind:'request',origin:'human',payload:{text:'What happened?'}}).input;
  enqueueSessionInput(infoParent.id);
  const infoParentTurn=Number((db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(infoParent.id) as any).turn_id),infoParentRun=nativeRunId(infoParentTurn);
  db.query("UPDATE turns SET status='done',provider_input_acknowledged_at=CURRENT_TIMESTAMP,provider_turn_id='question-answer' WHERE id=?").run(infoParentTurn);
  const infoRequestId='informational-only-request';
  const infoChild=retainSessionInput({id:`request:${infoRequestId}`,sessionId:infoSource.id,scope:'fixture',actionId:'info-child',kind:'request',
    origin:'agent',requestId:infoRequestId,sourceInputId:infoParent.id,sourceRunId:infoParentRun,payload:{text:'Investigate this question'}}).input;
  enqueueSessionInput(infoChild.id);
  const infoTurn=Number((db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(infoChild.id) as any).turn_id),infoRun=nativeRunId(infoTurn);
  db.query("UPDATE turns SET status='running',provider_admission_intended_at=CURRENT_TIMESTAMP,provider_started_at=CURRENT_TIMESTAMP WHERE id=?").run(infoTurn);
  db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,
    source_root_ts,action_id,target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms,
    source_input_id,target_input_id,status,outcome) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(infoRequestId,'fixture','info-message',infoParentTurn,infoSource.id,'root','info-action',infoSource.id,'fixture','info-root',
      JSON.stringify({requestedEffect:'informational'}),'info-hash',0,0,infoParent.id,infoChild.id,'admitted',null);
  await assert.rejects(()=>coordinator.recoverCodexNeverAcknowledged({source:{input_id:infoChild.id,run_id:infoRun},
    action_id:'unauthorized-info-recovery',request_id:requestId}),/requires work authority/);
  assert.equal(ownerReservations,1,'informational authority cannot invoke the executable recovery route');
  console.log('Codex unacknowledged recovery route: exact human model custody, work authority, lost-receipt retry and cross-action deduplication passed');
}finally{(await import('../src/state')).db.close();rmSync(scratch,{recursive:true,force:true});}
