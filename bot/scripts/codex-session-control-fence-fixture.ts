// Proves canonical SessionOwner controls stop accepted Codex fences without releasing native intents.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const scratch=mkdtempSync(join(tmpdir(),'concierge-codex-session-control-fence-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_PEER_NAME='runner-a';
const {CODEX_SWITCH_RECEIPT_TEST_AUTHORIZATION}=await import('../src/test-authorizations');
process.env.CONCIERGE_TEST_AUTHORIZATION=CODEX_SWITCH_RECEIPT_TEST_AUTHORIZATION;
const [{db,globalPauseState,claimNextQueuedTurn,markTurnProviderAdmissionIntended,acknowledgeTurnProviderInput},
  {createNativeSession,retainSessionInput,enqueueSessionInput,nativeRunId},
  {SessionOwner},{initializeCodexMutationFenceSchema,acquireCodexThreadMutationFence,
    grantCodexMutationPermit,consumeCodexMutationPermit,getCodexThreadMutationFence}]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/session-owner'),import('../src/codex-mutation-fence')]);

initializeCodexMutationFenceSchema(db);
const owner=new SessionOwner({available:()=>true,wake:()=>{},stop:async()=>false,steer:()=>false,
  capabilities:()=>({stop:true,models:['gpt-6.1-sol']})} as any,scratch);
function target(label:string){
  const session=createNativeSession('codex',{title:`Codex fence ${label}`,summary:'Verify source-owned controls stop native mutation authority.'});
  const threadId=`codex-thread-${session.id}`;
  const bound=db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run(threadId,session.id);
  assert.equal(bound.changes,1);
  const accepted=retainSessionInput({sessionId:session.id,scope:'fixture',actionId:`accepted-${label}`,kind:'input',origin:'human',
    payload:{text:'No provider call: fixture-only accepted turn.'}}).input;
  enqueueSessionInput(accepted.id);
  const claim=claimNextQueuedTurn(`codex-control-fence-${label}`)!;
  assert.ok(claim,'accepted input is admitted by the real ledger');
  assert.equal(markTurnProviderAdmissionIntended(claim.turn_id,`codex-control-fence-${label}`,claim.dispatch_attempt),true);
  acknowledgeTurnProviderInput(claim.turn_id,`codex-control-fence-${label}`,claim.dispatch_attempt,[]);
  const runId=nativeRunId(claim.turn_id),fenceId=`fence-${label}`;
  const acquired=acquireCodexThreadMutationFence(db,{fenceId,threadId,acceptedInputId:accepted.id,runId,
    dispatchAttempt:claim.dispatch_attempt,bindingDigest:`binding-${label}`,nowMs:Date.now()});
  assert.equal(acquired.acquired,true,'the real mutation ledger grants the fixture fence');
  return {session,threadId,accepted,runId,turnId:claim.turn_id,fenceId,
    mutationOwner:{acceptedInputId:accepted.id,runId,dispatchAttempt:claim.dispatch_attempt,bindingDigest:`binding-${label}`}};
}
function grantRecovery(targetValue:ReturnType<typeof target>,permitId:string){
  return grantCodexMutationPermit(db,{permitId,threadId:targetValue.threadId,owner:targetValue.mutationOwner,
    method:'turn/start',paramsDigest:`params-${permitId}`,purpose:'fenced_recovery',fenceId:targetValue.fenceId,nowMs:Date.now()});
}
function action(targetValue:ReturnType<typeof target>,clientActionId:string,kind:string,value?:string){
  return owner.action(`concierge:${targetValue.session.id}`,{clientActionId,action:{kind,...(value?{value}:{})}});
}
function stopped(targetValue:ReturnType<typeof target>){
  const fence=getCodexThreadMutationFence(db,targetValue.threadId);
  assert.equal(fence,null,'the active reservation is no longer visible after the control commits');
  const row=db.query('SELECT state,stop_action_id FROM codex_thread_mutation_fences WHERE fence_id=?').get(targetValue.fenceId) as any;
  assert.equal(row.state,'stopped');
  return row;
}

try{
  const pause=target('pause');
  const unused=grantRecovery(pause,'pause-unused');
  assert.equal(unused.granted,true);
  action(pause,'pause-control','pause');
  const pauseStop=stopped(pause);
  assert.match(pauseStop.stop_action_id,/pause-control:codex-fence:/);
  assert.equal((db.query('SELECT state FROM codex_mutation_permits WHERE permit_id=?').get('pause-unused') as any).state,'revoked',
    'pause revokes a granted but not-yet-issued mutation');

  const intentTarget=target('issued-intent');
  const issuedPermit=grantRecovery(intentTarget,'issued-start');
  assert.equal(issuedPermit.granted,true);
  assert.equal(consumeCodexMutationPermit(db,{permitId:'issued-start',intentId:'issued-start-intent',
    paramsDigest:'params-issued-start',nowMs:Date.now()}).forward,true,'fixture records the native start intent before control');
  action(intentTarget,'pause-issued-control','pause');
  stopped(intentTarget);
  action(intentTarget,'continue-issued-control','continue');
  assert.equal(getCodexThreadMutationFence(db,intentTarget.threadId),null,'Continue cannot revive the old fence');
  const blocked=grantCodexMutationPermit(db,{permitId:'ordinary-after-continue',threadId:intentTarget.threadId,
    owner:intentTarget.mutationOwner,method:'turn/steer',paramsDigest:'ordinary-after-continue',purpose:'ordinary',nowMs:Date.now()});
  assert.equal(blocked.granted,false);
  assert.equal(blocked.reason,'thread_fenced','the unresolved issued start remains a blocker after Continue');
  assert.equal((db.query('SELECT state FROM codex_mutation_intents WHERE intent_id=?').get('issued-start-intent') as any).state,'forwarding',
    'control did not falsely settle an issued native effect');

  const archive=target('archive');
  grantRecovery(archive,'archive-unused');
  action(archive,'archive-control','archive');
  assert.match(stopped(archive).stop_action_id,/archive-control:codex-fence:/);
  assert.equal((db.query('SELECT state FROM codex_mutation_permits WHERE permit_id=?').get('archive-unused') as any).state,'revoked');
  action(archive,'restore-control','restore');
  assert.equal(getCodexThreadMutationFence(db,archive.threadId),null,'Restore cannot revive an archived fence');

  const model=target('model');
  grantRecovery(model,'model-unused');
  action(model,'model-control','model','gpt-6.1-sol');
  assert.match(stopped(model).stop_action_id,/model-control:codex-fence:/);
  assert.equal((db.query('SELECT state FROM codex_mutation_permits WHERE permit_id=?').get('model-unused') as any).state,'revoked');

  const exactStop=target('exact-stop');
  grantRecovery(exactStop,'exact-stop-unused');
  const stoppedResult=await owner.stop(`concierge:${exactStop.session.id}`,{clientActionId:'exact-stop-control',runId:exactStop.runId});
  assert.equal(stoppedResult.operation.state,'uncertain','fixture runtime declines to claim native cancellation');
  assert.match(stopped(exactStop).stop_action_id,/exact-stop-control:codex-fence:/);
  assert.equal((db.query('SELECT state FROM codex_mutation_permits WHERE permit_id=?').get('exact-stop-unused') as any).state,'revoked');

  const globalPause=target('global-pause');
  const excepted=target('global-pause-exception');
  grantRecovery(globalPause,'global-unused');grantRecovery(excepted,'exception-unused');
  const pauseStatus=owner.globalPausePeer({paused:true,generation:globalPauseState().generation+1,
    allowedSessionIds:[excepted.session.id],continueSessionIds:[]});
  assert.equal(pauseStatus.paused,true);
  assert.equal(getCodexThreadMutationFence(db,globalPause.threadId),null,'global pause stops eligible local active fences');
  assert.notEqual(getCodexThreadMutationFence(db,excepted.threadId),null,'global pause respects an explicit generation exception');
  assert.equal((db.query('SELECT state FROM codex_mutation_permits WHERE permit_id=?').get('global-unused') as any).state,'revoked');
  const resumed=owner.globalPausePeer({paused:false,generation:globalPauseState().generation+1,
    allowedSessionIds:[],continueSessionIds:[globalPause.session.id]});
  assert.equal(resumed.paused,false,'the source-owned global Continue lifts the pause');
  assert.equal(getCodexThreadMutationFence(db,globalPause.threadId),null,'global Continue cannot revive the stopped old fence');

  console.log('PASS canonical SessionOwner Stop, pause, archive, model, and global pause revoke active Codex fences; unused grants are revoked, issued intents stay blocking, and Continue/restore do not revive old fences.');
}finally{rmSync(scratch,{recursive:true,force:true});}
