import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'concierge-provider-admission-history-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION;
const [{db,claimNextQueuedTurn},{createNativeSession,retainSessionInput,enqueueSessionInput,nativeRunId,getAcceptedSessionInput},
  {SessionExecutionHost},{ActiveTurnDispatchRegistry}]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/session-execution-host'),import('../src/turn-dispatch-seams')]);
try{
  const session=createNativeSession('codex',{title:'admission history fixture',purpose:'verify admission history',origin:'native',model:'gpt-6-astra'});
  const input=retainSessionInput({id:'accepted-report-back',sessionId:session.id,scope:'fixture',actionId:'accepted-report-back',
    kind:'request',origin:'service',payload:{text:'Retained exact service work'}}).input;
  enqueueSessionInput(input.id);
  const claim=claimNextQueuedTurn('fixture-owner')!;
  const originalPrompt='Original provider prompt';
  db.query("UPDATE turns SET provider_admission_intended_at=CURRENT_TIMESTAMP WHERE id=? AND owner_instance_id=?").run(claim.turn_id,'fixture-owner');
  const host=new SessionExecutionHost({instanceId:'fixture-owner',registry:new ActiveTurnDispatchRegistry(),providers:{},defaultCwd:scratch,wake:()=>{}});
  const first=(host as any).retainAdmission(claim,input,session,{prompt:originalPrompt,model:'gpt-6-astra'},[]);
  const originalReceipt=JSON.parse(getAcceptedSessionInput(input.id)!.receipt_json!);
  assert.equal(originalReceipt.admission.promptHash,first.promptHash);

  db.query(`UPDATE turns SET dispatch_attempt=2,provider_admission_intended_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='running' AND owner_instance_id=?`).run(claim.turn_id,'fixture-owner');
  const retryPrompt='Retry prompt with changed context';
  const secondClaim={...claim,dispatch_attempt:2};
  const second=(host as any).retainAdmission(secondClaim,input,session,{prompt:retryPrompt,model:'gpt-6-astra'},[]);
  assert.notEqual(second.promptHash,first.promptHash);

  const saved=JSON.parse(getAcceptedSessionInput(input.id)!.receipt_json!);
  assert.deepEqual(saved.admission,originalReceipt.admission,'legacy receipt retains the immutable first admission');
  const eventRows=db.query("SELECT event_id,payload_json FROM session_owner_events WHERE input_id=? AND kind='provider_admission' ORDER BY sequence")
    .all(input.id) as {event_id:string;payload_json:string}[];
  assert.deepEqual(eventRows.map(row=>row.event_id),[`provider_admission:${claim.turn_id}:1`,`provider_admission:${claim.turn_id}:2`]);
  assert.deepEqual(eventRows.map(row=>JSON.parse(row.payload_json).admission.promptHash),[first.promptHash,second.promptHash]);
  const operation=host.owner.receipt(getAcceptedSessionInput(input.id)!);
  assert.equal(operation.admission.promptHash,first.promptHash,'existing operation admission remains backward compatible');
  assert.deepEqual(operation.admissionHistory.map((entry:any)=>[entry.dispatchAttempt,entry.admission.promptHash]),
    [[1,first.promptHash],[2,second.promptHash]],'operation exposes both immutable attempt admissions');

  const chatgpt=createNativeSession('chatgpt',{title:'immutable ChatGPT admission fixture',purpose:'verify ChatGPT guard',origin:'native'});
  const chatInput=retainSessionInput({id:'chatgpt-input',sessionId:chatgpt.id,scope:'fixture',actionId:'chatgpt-input',kind:'input',origin:'human',payload:{text:'Prepared text'}}).input;
  enqueueSessionInput(chatInput.id);
  const chatClaim=claimNextQueuedTurn('fixture-owner')!;
  db.query("UPDATE turns SET provider_admission_intended_at=CURRENT_TIMESTAMP WHERE id=? AND owner_instance_id=?").run(chatClaim.turn_id,'fixture-owner');
  const chatAdmission=(host as any).retainAdmission(chatClaim,chatInput,chatgpt,{prompt:'Prepared text',model:null},[]);
  db.query(`UPDATE turns SET dispatch_attempt=2,provider_admission_intended_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'
    AND owner_instance_id=?`).run(chatClaim.turn_id,'fixture-owner');
  assert.throws(()=> (host as any).retainAdmission({...chatClaim,dispatch_attempt:2},chatInput,chatgpt,{prompt:'Changed prepared text',model:null},[]),
    /immutable provider admission/,'ChatGPT still refuses a changed prepared admission');
  assert.equal((db.query("SELECT count(*) AS count FROM session_owner_events WHERE turn_id=? AND kind='provider_admission'").get(chatClaim.turn_id) as any).count,1,
    'a rejected ChatGPT retry does not create a second admission event');
  console.log('provider admission history fixture: first receipt preserved, retry admission retained by attempt, operation history readable, ChatGPT guard preserved');
}finally{
  db.close();
  rmSync(scratch,{recursive:true,force:true});
}
process.exit(0);
