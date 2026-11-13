// Replays explicit disposable selection, exact Stop/loss ordering, deadlines and durable idempotency.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const scratch=mkdtempSync(join(tmpdir(),'concierge-codex-test-control-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION='native-attribution-5eaa0768';
const [{db,finishTurn,getSessionById},{createNativeSession,retainSessionInput,enqueueSessionInput,nativeRunId},{claimQueuedTurnWithSavedWork},{SessionOwner},{DedicatedCodexTestClients,agentCreatedCodexTestInput,codexTestFaultBindingMatches},{ProviderDispatchError}]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/saved-work'),import('../src/session-owner'),import('../src/session-execution-host'),import('../src/provider-failures')]);
const {parseRouterSessionsArgs}=await import('./router-sessions');
const sourceSession=createNativeSession('claude-code',{title:'controller source'});
const sourceInput=retainSessionInput({sessionId:sourceSession.id,scope:'fixture',actionId:'controller-source',kind:'input',origin:'agent',payload:{text:'controller'}}).input;
enqueueSessionInput(sourceInput.id);const sourceClaim=claimQueuedTurnWithSavedWork('controller-source-runner',[])!;
const sourceRun=nativeRunId(sourceClaim.turn_id);
const source={inputId:sourceInput.id,runId:sourceRun};
let stopCalls=0,cutCalls=0,allowBinding=true,cutOutcome:'observed'|'stale'|'throw'='observed',stopError:Error|null=null;
const binding={executionId:'execution-fixture',dispatchAttempt:1,generation:7,faultDeadlineMs:Date.now()+60_000};
const owner=new SessionOwner({wake(){},steer(){return false;},async stop(){stopCalls++;if(stopError)throw stopError;return true;},
  prepareCodexTestConnectionLoss(){return allowBinding?binding:null;},
  async codexTestConnectionLoss(_session:number,_turn:number,expected:typeof binding){
    assert.deepEqual(expected,binding,'the retained exact execution, attempt, generation and deadline reach the final host check');
    cutCalls++;if(cutOutcome==='throw')throw new Error('disconnect intent was accepted but observation was lost');
    return cutOutcome;
  },available(){return true;},capabilities(){return {stop:true};}} as any,process.cwd());
function target(title:string,creatorSource=source,selected=true,deadline=binding.faultDeadlineMs){
  const session=createNativeSession('codex',{title});
  const uuid='12345678-1234-4234-8234-'+String(session.id).padStart(12,'0');
  const created=retainSessionInput({id:`request:${uuid}`,sessionId:session.id,scope:'fixture-create',actionId:`create-${session.id}`,
    kind:'create',origin:'agent',payload:{firstInput:{text:'disposable target'},...(selected?{codexNativeTestFaultDeadlineMs:deadline}:{})},
    sourceInputId:creatorSource.inputId,sourceRunId:creatorSource.runId,requestId:uuid}).input;
  enqueueSessionInput(created.id);const claim=claimQueuedTurnWithSavedWork('target-runner',[])!;
  return {session,created,turnId:claim.turn_id,runId:nativeRunId(claim.turn_id)};
}
function call(targetSessionId:number,path:'stop'|'connection-loss',createInputId:string,runId:string,actionId:string,agentSource=source){
  return (owner as any).handleRequest(new Request(`http://owner/sessions/v1/agent-test/sessions/concierge%3A${targetSessionId}/${path}`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientActionId:actionId,runId,createInputId,agentSource})}));
}
try{
  const deadlineIso=new Date(Date.now()+60_000).toISOString();
  const parsedOptIn=parseRouterSessionsArgs(['ask','--provider','cx-sol','--project','slack-concierge','--session-name','target',
    '--summary','target summary','--codex-native-test-until',deadlineIso,'--source-input',source.inputId,'--source-run',source.runId,'--action-id','create-target','--','prompt']);
  assert.equal(parsedOptIn.operation,'ask');
  assert.equal((parsedOptIn as any).body.codexNativeTestFaultDeadlineMs,Date.parse(deadlineIso),
    'the supported command carries the controller-selected finite deadline');
  assert.throws(()=>parseRouterSessionsArgs(['ask','--provider','auto','--project','slack-concierge','--session-name','target',
    '--summary','target summary','--codex-native-test-until',deadlineIso,'--source-input',source.inputId,'--source-run',source.runId,'--action-id','create-auto','--','prompt']),
    /codex-native-test-until/,'Automatic provider selection cannot silently opt into the fault client');

  const clients=new DedicatedCodexTestClients();let oldClosed=0,newClosed=0;
  const oldClient={close:async()=>{oldClosed++;}} as any,newClient={close:async()=>{newClosed++;}} as any;
  await clients.replace(99,{executionId:'old',dispatchAttempt:1,faultDeadlineMs:binding.faultDeadlineMs,client:oldClient});
  await clients.replace(99,{executionId:'replacement',dispatchAttempt:2,faultDeadlineMs:binding.faultDeadlineMs,client:newClient});
  assert.equal(oldClosed,1,'durable replacement closes the superseded dedicated connection');
  assert.equal(clients.get(99)?.executionId,'replacement');
  assert.equal(await clients.closeIfTerminal(99,'error'),true,'canonical error terminal closes the actual retained client');
  assert.equal(newClosed,1);
  assert.equal(clients.get(99),undefined);
  let uncertainCloseCalls=0;
  const uncertainCloseClient={close:async()=>{if(++uncertainCloseCalls===1)throw new Error('close observation uncertain');}} as any;
  await clients.replace(100,{executionId:'close-old',dispatchAttempt:1,faultDeadlineMs:binding.faultDeadlineMs,client:uncertainCloseClient});
  await assert.rejects(()=>clients.replace(100,{executionId:'close-new',dispatchAttempt:2,faultDeadlineMs:binding.faultDeadlineMs,client:{close:async()=>{}} as any}));
  await clients.closeIfTerminal(100,'error');
  assert.equal(uncertainCloseCalls,2,'a failed close remains owned and is retried at terminal cleanup');

  const ordinary=target('ordinary',source,false);
  assert.equal(agentCreatedCodexTestInput(ordinary.created,getSessionById(ordinary.session.id)!),false,
    'ordinary agent-created Codex work retains its shared-client route');
  const ordinaryRefusal=await call(ordinary.session.id,'connection-loss',ordinary.created.id,ordinary.runId,'ordinary-cut');
  assert.equal(ordinaryRefusal.status,403,'ordinary agent-created Codex work has no fault capability');
  const ordinaryStop=await call(ordinary.session.id,'stop',ordinary.created.id,ordinary.runId,'ordinary-stop');
  assert.equal(ordinaryStop.status,403,'the disposable test entrance also refuses unmarked ordinary work');

  const stopped=target('stopped');
  const stopResponse=await call(stopped.session.id,'stop',stopped.created.id,stopped.runId,'stop-once');
  assert.equal(stopResponse.status,200,'selected test work uses normal exact-run Stop');
  assert.equal(stopCalls,1);
  const afterStop=await call(stopped.session.id,'connection-loss',stopped.created.id,stopped.runId,'cut-after-stop');
  assert.equal(afterStop.status,409,'a retained Stop vetoes a later generation loss');
  assert.equal(codexTestFaultBindingMatches(binding,null),false,'the final host boundary refuses when a fresh read sees Stop or lost ownership');
  assert.equal(codexTestFaultBindingMatches(binding,{...binding,generation:binding.generation+1}),false,
    'the final host boundary cannot cut a replacement generation');
  assert.equal(cutCalls,0,'Stop veto is enforced before runtime disruption');

  const selected=target('selected');
  assert.equal(agentCreatedCodexTestInput(selected.created,getSessionById(selected.session.id)!),true,
    'only explicit future-deadline creation opts into the dedicated client');
  allowBinding=false;
  const noEffect=await call(selected.session.id,'connection-loss',selected.created.id,selected.runId,'no-generation-yet');
  assert.equal(noEffect.status,409,'missing exact generation is a proven no-effect refusal');
  assert.equal(cutCalls,0);
  allowBinding=true;
  const cut=await call(selected.session.id,'connection-loss',selected.created.id,selected.runId,'cut-once');
  assert.equal(cut.status,200);
  const cutBody=await cut.json() as any;
  const storedIntent=db.query('SELECT receipt_json FROM session_inputs WHERE id=?').get(cutBody.operation.operationId) as {receipt_json:string};
  const intent=JSON.parse(storedIntent.receipt_json) as any;
  assert.deepEqual({executionId:intent.executionId,dispatchAttempt:intent.dispatchAttempt,generation:intent.generation,faultDeadlineMs:intent.faultDeadlineMs},binding,
    'the durable fault intent names its exact execution, attempt, connection and expiry');
  assert.equal(cutCalls,1);
  finishTurn(selected.turnId,'done','fixture terminal');
  const lateDuplicate=await call(selected.session.id,'connection-loss',selected.created.id,selected.runId,'cut-once');
  assert.equal(lateDuplicate.status,200,'the same action returns its receipt after terminal settlement');
  assert.equal((await lateDuplicate.json() as any).operation.operationId,cutBody.operation.operationId);
  assert.equal(cutCalls,1,'late idempotent replay never cuts a replacement generation');

  const expired=target('expired',source,true,Date.now()-1);
  const expiredLoss=await call(expired.session.id,'connection-loss',expired.created.id,expired.runId,'expired-cut');
  assert.equal(expiredLoss.status,409,'expired fault permission cannot cut');
  assert.equal(cutCalls,1);
  const expiredStop=await call(expired.session.id,'stop',expired.created.id,expired.runId,'expired-stop');
  assert.equal(expiredStop.status,200,'ordinary owner Stop remains available after fault expiry');

  const uncertainStopTarget=target('uncertain-stop');
  stopError=new ProviderDispatchError({message:'fixture provider history has no terminal turn',terminalConfirmed:false,toolsUsed:[]});
  const uncertainStopResponse=await call(uncertainStopTarget.session.id,'stop',uncertainStopTarget.created.id,uncertainStopTarget.runId,'uncertain-stop');
  assert.equal(uncertainStopResponse.status,200);
  assert.equal((await uncertainStopResponse.json() as any).operation.state,'uncertain',
    'an unconfirmed adopted provider outcome remains uncertain in the retained Stop receipt');
  stopError=null;

  const uncertain=target('uncertain');cutOutcome='throw';
  const uncertainResult=await call(uncertain.session.id,'connection-loss',uncertain.created.id,uncertain.runId,'uncertain-cut');
  assert.equal(uncertainResult.status,200);
  const uncertainBody=await uncertainResult.json() as any;
  assert.equal(uncertainBody.operation.state,'uncertain','lost observation stays uncertain');
  const uncertainReplay=await call(uncertain.session.id,'connection-loss',uncertain.created.id,uncertain.runId,'uncertain-cut');
  assert.equal((await uncertainReplay.json() as any).operation.operationId,uncertainBody.operation.operationId);
  const rearm=await call(uncertain.session.id,'connection-loss',uncertain.created.id,uncertain.runId,'uncertain-rearm');
  assert.equal(rearm.status,409,'ambiguous attempted loss consumes the one-cut budget');

  const foreign=target('foreign');
  retainSessionInput({sessionId:foreign.session.id,scope:'surface:thinkering',actionId:'foreign-human',kind:'input',origin:'human',payload:{text:'foreign'}});
  const foreignResponse=await call(foreign.session.id,'connection-loss',foreign.created.id,foreign.runId,'foreign-cut');
  assert.equal(foreignResponse.status,403,'other authorship closes the disposable test entrance');
  const wrongSource=await call(selected.session.id,'connection-loss',selected.created.id,selected.runId,'wrong-source',
    {inputId:source.inputId,runId:'another-run'});
  assert.equal(wrongSource.status,403,'a mismatched source run is refused');
  const mismatched=await call(foreign.session.id,'stop',selected.created.id,foreign.runId,'wrong-target');
  assert.equal(mismatched.status,403,'a creation request cannot authorize another session');
  console.log('Codex test control fixture: explicit opt-in, deadline, exact binding, Stop veto, no-effect refusal, late duplicate, uncertainty and source/target refusals passed');
}finally{rmSync(scratch,{recursive:true,force:true});}
