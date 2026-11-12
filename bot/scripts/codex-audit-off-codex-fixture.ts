// Replays docs/incidents/2026-11-12-codex-audit-retried-after-session-left-codex.md offline: a Codex
// turn's leftover-process audit was recorded, then a capacity refusal moved the session to another
// provider. The minute sweep must settle that audit once with its cause instead of failing every
// minute. Scratch ledger only; no provider or runner is reached.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CODEX_AUDIT_OFF_CODEX_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'concierge-codex-audit-off-codex-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=CODEX_AUDIT_OFF_CODEX_TEST_AUTHORIZATION;

const [{db,claimNextQueuedTurn},{createNativeSession,retainSessionInput,enqueueSessionInput,recordSessionEvent},
  {SessionExecutionHost},{ActiveTurnDispatchRegistry}]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/session-execution-host'),import('../src/turn-dispatch-seams')]);

try{
  const session=createNativeSession('codex',{title:'moved off codex',summary:undefined,purpose:'develop',origin:'native'});
  const input=retainSessionInput({id:'moved',sessionId:session.id,scope:'fixture',actionId:'moved',kind:'input',origin:'agent',payload:{text:'moved'}}).input;
  enqueueSessionInput(input.id);
  const claim=claimNextQueuedTurn('fixture-owner')!;
  recordSessionEvent({eventId:`codex-process-audit-intent:${claim.turn_id}`,sessionId:session.id,inputId:input.id,turnId:claim.turn_id,kind:'process_audit',payload:{}});
  recordSessionEvent({eventId:`terminal:${claim.turn_id}:${claim.dispatch_attempt}`,sessionId:session.id,inputId:input.id,turnId:claim.turn_id,kind:'run',payload:{}});
  // What a capacity reroute leaves: the session on another provider with no Codex thread, the turn finished there.
  db.query(`UPDATE sessions SET provider_id='claude-code',agent_session_uuid=NULL WHERE id=?`).run(session.id);
  db.query(`UPDATE turns SET status='done',owner_instance_id=NULL WHERE id=?`).run(claim.turn_id);

  const host=new SessionExecutionHost({instanceId:'fixture-owner',registry:new ActiveTurnDispatchRegistry(),providers:{},defaultCwd:scratch,wake:()=>{}});
  await host.reconcileCodexProcessAudits();
  const done=db.query('SELECT payload_json FROM session_owner_events WHERE event_id=?').get(`codex-process-audit-done:${claim.turn_id}`) as {payload_json:string}|null;
  assert.ok(done,'the audit is settled instead of failing again');
  assert.equal(JSON.parse(done.payload_json).reason,'session-left-codex');
  await host.reconcileCodexProcessAudits();
  console.log('codex audit off-codex fixture: an audit whose session left Codex settled once with its cause');
}finally{
  rmSync(scratch,{recursive:true,force:true});
}
process.exit(0);
