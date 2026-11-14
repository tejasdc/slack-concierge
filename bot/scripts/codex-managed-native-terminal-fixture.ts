import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION} from '../src/test-authorizations';
const scratch=mkdtempSync(join(tmpdir(),'codex-native-terminal-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION;
const [{db},inputs,fence,terminal,{beginCodexDaemonLifecycle}]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/codex-mutation-fence'),
  import('../src/codex-managed-native-terminal'),import('../src/codex-daemon-lifecycle')]);
try{
  const session=inputs.createNativeSession('codex',{title:'ordinary terminal',origin:'native',
    model:'gpt-6-astra',reasoningEffort:'medium',providerRunner:null} as any);
  db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run('thread',session.id);
  const accepted=inputs.retainSessionInput({id:'accepted',sessionId:session.id,scope:'fixture',actionId:'accepted',
    kind:'create',origin:'agent',payload:{provider:'codex',model:'gpt-6-astra',reasoningEffort:'medium',firstInput:{text:'preserved'}}}).input;
  const turnId=inputs.enqueueSessionInput(accepted.id).turn_id!;
  const runId=inputs.nativeRunId(turnId);
  db.query("UPDATE turns SET dispatch_attempt=1,provider_turn_id='T',status='running' WHERE id=?").run(turnId);
  db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({admission:{provider:'codex',
    inputId:accepted.id,runId,bindingGeneration:1,model:'gpt-6-astra',nativeBinding:null}}),accepted.id);
  const originalPayload=db.query('SELECT payload_json FROM session_inputs WHERE id=?').get(accepted.id).payload_json;
  const issue=(id:string,method:string,target?:string)=>{
    assert.equal(fence.grantCodexMutationPermit(db,{permitId:id,threadId:'thread',owner:{acceptedInputId:'managed:connection',
      runId:'connection',dispatchAttempt:1},method,paramsDigest:id,purpose:'ordinary',nativeTurnId:target,nowMs:1}).granted,true);
    assert.equal(fence.consumeCodexMutationPermit(db,{permitId:id,intentId:id,paramsDigest:id,nowMs:2}).forward,true);
  };
  const row=(id:string)=>db.query('SELECT * FROM codex_mutation_intents WHERE intent_id=?').get(id) as any;
  issue('start','turn/start');issue('steer','turn/steer','T');issue('interrupt','turn/interrupt','T');issue('other','turn/start');
  fence.recordCodexMutationResponse(db,{intentId:'other',kind:'rpc_error',providerTurnId:'different',responseDigest:'error',nowMs:3});
  assert.equal(terminal.reconcileManagedCodexMutationFromRetainedTerminal(db,{intentId:'start',nowMs:4}).reason,'NATIVE_TURN_IDENTITY_MISSING');
  assert.equal(beginCodexDaemonLifecycle(db,{operationId:'blocked',paramsDigest:'a'.repeat(64),nowMs:4}).forward,false);
  const eventId=`codex-native-terminal:${turnId}:1`;
  assert.equal(terminal.reconcileManagedCodexNativeTerminal(db,{eventId,nowMs:4}).reconciled,false);
  inputs.recordSessionEvent({eventId,sessionId:session.id,inputId:accepted.id,turnId,kind:'codex_native_terminal',payload:{
    providerThreadId:'thread',providerTurnId:'T',status:'completed',inputId:accepted.id,runId,dispatchAttempt:1,observedTerminal:true}});
  db.query('UPDATE sessions SET binding_generation=2 WHERE id=?').run(session.id);
  assert.equal(terminal.reconcileManagedCodexNativeTerminal(db,{eventId,nowMs:5}).reason,'NATIVE_TERMINAL_BINDING_UNPROVEN');
  db.query('UPDATE sessions SET binding_generation=1 WHERE id=?').run(session.id);
  const settled=terminal.reconcileManagedCodexNativeTerminal(db,{eventId,nowMs:6});
  assert.equal(settled.results.length,2);assert.equal(settled.reconciled,true);
  assert.equal(row('start').state,'forwarding');assert.equal(row('other').state,'response_received');
  const terminalDigest=row('steer').terminal_evidence_digest;
  fence.recordCodexMutationResponse(db,{intentId:'steer',kind:'accepted',responseDigest:'late',providerTurnId:'T',nowMs:7});
  assert.equal(row('steer').state,'reconciled_applied');assert.equal(row('steer').terminal_evidence_digest,terminalDigest);
  assert.throws(()=>fence.recordCodexMutationResponse(db,{intentId:'steer',kind:'accepted',responseDigest:'conflict',providerTurnId:'T',nowMs:8}));
  assert.throws(()=>fence.recordCodexMutationResponse(db,{intentId:'interrupt',kind:'accepted',responseDigest:'bad',providerTurnId:'wrong',nowMs:8}));
  fence.recordCodexMutationResponse(db,{intentId:'start',kind:'accepted',responseDigest:'late-start',providerTurnId:'T',nowMs:8});
  assert.equal(terminal.reconcileManagedCodexMutationFromRetainedTerminal(db,{intentId:'start',nowMs:9}).reconciled,true);
  assert.equal(terminal.reconcileManagedCodexNativeTerminal(db,{eventId,nowMs:10}).reconciled,false);
  assert.equal(beginCodexDaemonLifecycle(db,{operationId:'still-blocked',paramsDigest:'a'.repeat(64),nowMs:10}).forward,false,
    'unrelated uncertain native turn remains held');
  assert.equal(db.query('SELECT provider_input_acknowledged_at FROM turns WHERE id=?').get(turnId).provider_input_acknowledged_at,null);
  assert.equal(db.query('SELECT payload_json FROM session_inputs WHERE id=?').get(accepted.id).payload_json,originalPayload);
  console.log('Ordinary managed native terminal: exact callback/owner/binding, target cancellation, delayed start receipt, immutable late responses and unrelated uncertainty passed');
}finally{db.close();rmSync(scratch,{recursive:true,force:true});}
