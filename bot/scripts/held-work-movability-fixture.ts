// A Codex input the owner claimed, prepared and then refused by its own cached-usage check never
// reached Codex. It must be movable to another provider; one Codex actually started must not be.
// Replays the Diwali handoff refusal of 2026-11-11 (turn 26398, concierge:7992 → concierge:9328).
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HELD_WORK_MOVABILITY_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'concierge-held-work-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=HELD_WORK_MOVABILITY_TEST_AUTHORIZATION;

const [{db,claimNextQueuedTurn,markTurnProviderAdmissionIntended,retryRunningTurnAfterProviderFailure},
  {SessionOwner},{createNativeSession,retainSessionInput,enqueueSessionInput,getAcceptedSessionInput},
  {safeTurn},{queuedWorkMovable}]=await Promise.all([
  import('../src/state'),import('../src/session-owner'),import('../src/session-inputs'),
  import('../src/provider-exhaustion-recovery'),import('../src/session-handoff')]);
new SessionOwner({available:()=>true,wake:()=>{},stop:async()=>false,steer:()=>false},scratch);

const OWNER='held-work-fixture';
function heldCodexInput(id:string,started:boolean){
  const session=createNativeSession('codex',{title:`held ${id}`,summary:undefined,purpose:'develop',origin:'native',automaticProviderChoice:true});
  const input=retainSessionInput({id,sessionId:session.id,scope:'fixture',actionId:id,kind:'input',origin:'agent',payload:{text:'Avi WhatsApp delta'}}).input;
  // A capture's input carries this marker from admission; it is not a provider fact.
  db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({admissionIntent:'live'}),input.id);
  const queued=enqueueSessionInput(input.id);
  const claim=claimNextQueuedTurn(OWNER)!;
  assert.equal(claim.turn_id,queued.turn_id);
  assert.equal(markTurnProviderAdmissionIntended(claim.turn_id,OWNER,claim.dispatch_attempt),true);
  // What the execution host writes just before handing the prompt to Codex.
  const saved=JSON.parse(getAcceptedSessionInput(input.id)!.receipt_json!);
  db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({...saved,
    admission:{provider:'codex',inputId:input.id,runId:'run',bindingGeneration:1}}),input.id);
  if(started)db.query('UPDATE turns SET provider_started_at=CURRENT_TIMESTAMP WHERE id=?').run(claim.turn_id);
  // The cached-usage refusal: replay safe, held for the account's reset.
  assert.equal(retryRunningTurnAfterProviderFailure({turnId:claim.turn_id,ownerInstanceId:OWNER,dispatchAttempt:claim.dispatch_attempt,
    error:'Usage for fixture is cached as exhausted. No request was sent.',nextAttemptMs:Date.now()+86_400_000,usageHold:!started}),true);
  const turn=db.query(`SELECT id,session_id,accepted_input_id,status,dispatch_attempt,dispatch_hold,provider_admission_intended_at,
    provider_started_at,provider_turn_id,provider_input_acknowledged_at,saved_kind FROM turns WHERE id=?`).get(claim.turn_id) as any;
  return {session,turn,input:getAcceptedSessionInput(input.id)!};
}

try{
  const held=heldCodexInput('fixture-held',false);
  assert.equal(held.turn.dispatch_hold,'usage');
  assert.ok(held.turn.provider_admission_intended_at,'the refusal came after admission intent');
  assert.equal(safeTurn(held.turn,held.input),true,'a Codex input refused before sending moves');
  assert.deepEqual(queuedWorkMovable(held.session.id),{queued:1,movable:true});

  const started=heldCodexInput('fixture-started',true);
  assert.equal(safeTurn(started.turn,started.input),false,'an input Codex may have started stays');
  assert.deepEqual(queuedWorkMovable(started.session.id),{queued:1,movable:false});

  // An admission recorded for a different provider than the session's own is not this session's.
  const foreign={...held.input,receipt_json:JSON.stringify({admission:{provider:'claude-code',inputId:held.input.id}})};
  assert.equal(safeTurn(held.turn,foreign),false);
  console.log('held-work-movability-fixture: Codex refusals before sending move; started work stays.');
}finally{
  rmSync(scratch,{recursive:true,force:true});
}
