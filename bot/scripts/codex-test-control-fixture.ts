// Replays source, target, one-time operation and agent Stop custody on an isolated owner ledger.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const scratch=mkdtempSync(join(tmpdir(),'concierge-codex-test-control-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION='native-attribution-5eaa0768';
const [{db},{createNativeSession,retainSessionInput,enqueueSessionInput,nativeRunId},{claimQueuedTurnWithSavedWork},{SessionOwner}]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/saved-work'),import('../src/session-owner')]);
const sourceSession=createNativeSession('claude-code',{title:'controller source'});
const sourceInput=retainSessionInput({sessionId:sourceSession.id,scope:'fixture',actionId:'controller-source',kind:'input',origin:'agent',payload:{text:'controller'}}).input;
enqueueSessionInput(sourceInput.id);const sourceClaim=claimQueuedTurnWithSavedWork('controller-source-runner',[])!;
const sourceRun=nativeRunId(sourceClaim.turn_id);
const source={inputId:sourceInput.id,runId:sourceRun};
let stopCalls=0,cutCalls=0;
const owner=new SessionOwner({wake(){},steer(){return false;},async stop(){stopCalls++;return true;},
  async codexTestConnectionLoss(){cutCalls++;return 'observed';},available(){return true;},
  capabilities(){return {stop:true};}} as any,process.cwd());
function target(title:string,creatorSource=source){
  const session=createNativeSession('codex',{title});
  const uuid='12345678-1234-4234-8234-'+String(session.id).padStart(12,'0');
  const created=retainSessionInput({id:`request:${uuid}`,sessionId:session.id,scope:'fixture-create',actionId:`create-${session.id}`,
    kind:'create',origin:'agent',payload:{firstInput:{text:'disposable target'}},sourceInputId:creatorSource.inputId,sourceRunId:creatorSource.runId,requestId:uuid}).input;
  enqueueSessionInput(created.id);const claim=claimQueuedTurnWithSavedWork('target-runner',[])!;
  return {session,created,runId:nativeRunId(claim.turn_id)};
}
function call(targetSessionId:number,path:'stop'|'connection-loss',createInputId:string,runId:string,actionId:string,agentSource=source){
  return (owner as any).handleRequest(new Request(`http://owner/sessions/v1/agent-test/sessions/concierge%3A${targetSessionId}/${path}`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientActionId:actionId,runId,createInputId,agentSource})}));
}
try{
  const selected=target('selected');
  const stopped=await call(selected.session.id,'stop',selected.created.id,selected.runId,'stop-once');
  assert.equal(stopped.status,200);
  const stopBody=await stopped.json() as any;
  const retained=db.query('SELECT origin,source_input_id,source_run_id,kind FROM session_inputs WHERE id=?').get(stopBody.operation.operationId) as any;
  assert.deepEqual(retained,{origin:'agent',source_input_id:source.inputId,source_run_id:source.runId,kind:'stop'});
  await call(selected.session.id,'stop',selected.created.id,selected.runId,'stop-once');
  assert.equal(stopCalls,1,'same Stop action reaches normal exact-run cancellation once');

  const cut=await call(selected.session.id,'connection-loss',selected.created.id,selected.runId,'cut-once');
  assert.equal(cut.status,200);
  assert.equal(cutCalls,1,'the bound owner callback receives the exact target once');
  await call(selected.session.id,'connection-loss',selected.created.id,selected.runId,'cut-once');
  assert.equal(cutCalls,1,'same cut action returns its retained receipt');
  const secondCut=await call(selected.session.id,'connection-loss',selected.created.id,selected.runId,'cut-twice');
  assert.equal(secondCut.status,409,'a different action cannot spend a second cut');
  assert.equal(cutCalls,1);

  const foreign=target('foreign');
  retainSessionInput({sessionId:foreign.session.id,scope:'surface:thinkering',actionId:'foreign-human',kind:'input',origin:'human',payload:{text:'foreign'}});
  const foreignResponse=await call(foreign.session.id,'connection-loss',foreign.created.id,foreign.runId,'foreign-cut');
  assert.equal(foreignResponse.status,403,'other authorship closes the disposable test entrance');
  const wrongSource=await call(selected.session.id,'connection-loss',selected.created.id,selected.runId,'wrong-source',
    {inputId:source.inputId,runId:'another-run'});
  assert.equal(wrongSource.status,403,'a mismatched source run is refused');
  assert.equal(cutCalls,1,'source refusal happens before the runtime control');
  const mismatched=await call(foreign.session.id,'stop',selected.created.id,foreign.runId,'wrong-target');
  assert.equal(mismatched.status,403,'a creation request cannot authorize another session');
  console.log('Codex test control fixture: exact source and created target retained agent Stop; retries were idempotent; second cuts, foreign authorship and target mismatch were refused');
}finally{rmSync(scratch,{recursive:true,force:true});}
