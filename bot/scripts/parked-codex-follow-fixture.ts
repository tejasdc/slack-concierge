// Replays docs/incidents/2026-11-12-codex-connection-loss-parked-unsent-turns.md offline: Codex turns
// that parked as "outcome unknown" while Concierge kept running had their run record released at
// once, so the minute sweep never took them back and they waited for an agent to notice. The sweep
// must now take back a recently parked Codex turn without anyone touching it, two per sweep, and
// stop after a few tries. Scratch ledger only.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PARKED_CODEX_FOLLOW_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'concierge-parked-codex-follow-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=PARKED_CODEX_FOLLOW_TEST_AUTHORIZATION;

const [{db,claimNextQueuedTurn,parkRunningTurnAfterProviderFailure},{createNativeSession,retainSessionInput,enqueueSessionInput},
  {retainExecutionIntent,releaseExecution,claimAdoptableExecutions,PARKED_CODEX_PER_SWEEP,PARKED_CODEX_FOLLOW_LIMIT}]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/executions')]);

const OWNER='parked-codex-follow-fixture';
async function parkedCodexTurn(name:string){
  const session=createNativeSession('codex',{title:name,summary:undefined,purpose:'develop',origin:'native'});
  db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run(`thread-${name}`,session.id);
  const input=retainSessionInput({id:name,sessionId:session.id,scope:'fixture',actionId:name,kind:'input',origin:'agent',payload:{text:name}}).input;
  enqueueSessionInput(input.id);
  const claim=claimNextQueuedTurn(OWNER)!;
  db.query('UPDATE turns SET provider_admission_intended_at=CURRENT_TIMESTAMP WHERE id=?').run(claim.turn_id);
  const executionId=`execution-${name}`;
  retainExecutionIntent({executionId,turnId:claim.turn_id,dispatchAttempt:claim.dispatch_attempt,sessionId:session.id,provider:'codex',
    directory:'',coordinatorInstanceId:OWNER,supervisor:'codex-daemon',processor:{run:{}}});
  // What the 2026-11-12 turns did: the connection closed, the turn parked as possibly sent, and its
  // run record was released when the run returned.
  assert.equal(parkRunningTurnAfterProviderFailure({turnId:claim.turn_id,ownerInstanceId:OWNER,dispatchAttempt:claim.dispatch_attempt,
    failureClass:'parked_ambiguous',error:'Codex app-server WebSocket closed.'}),true);
  await releaseExecution(db.query('SELECT * FROM executions WHERE execution_id=?').get(executionId) as any);
  return {turnId:claim.turn_id,executionId};
}
const sweep=()=>claimAdoptableExecutions({instanceId:'sweeper',isOwnerAlive:()=>false,onlyParked:true});

try{
  const stopped=await parkedCodexTurn('stopped');
  db.query('UPDATE turns SET stop_requested_at=CURRENT_TIMESTAMP WHERE id=?').run(stopped.turnId);
  const parked=await Promise.all(['a','b','c'].map(parkedCodexTurn));
  const first=await sweep();
  assert.equal(PARKED_CODEX_PER_SWEEP,2);
  assert.deepEqual(first.adopted.map(a=>a.claim.turn_id),[parked[0]!.turnId,parked[1]!.turnId],'two per sweep, oldest first');
  for(const {turnId,executionId} of parked.slice(0,2)){
    assert.equal((db.query('SELECT status FROM turns WHERE id=?').get(turnId) as any).status,'running','taken back without anyone touching it');
    assert.equal((db.query('SELECT state FROM executions WHERE execution_id=?').get(executionId) as any).state,'live');
  }
  const second=await sweep();
  assert.deepEqual(second.adopted.map(a=>a.claim.turn_id),[parked[2]!.turnId],'the rest on the next sweep');
  assert.equal((db.query('SELECT status FROM turns WHERE id=?').get(stopped.turnId) as any).status,'parked','a turn he stopped stays parked');

  // A turn that keeps parking is taken back only a few times, then stays visibly parked.
  const {turnId,executionId}=parked[0]!;
  for(let tries=1;tries<=PARKED_CODEX_FOLLOW_LIMIT+1;tries++){
    const attempt=(db.query('SELECT dispatch_attempt FROM turns WHERE id=?').get(turnId) as any).dispatch_attempt;
    if((db.query('SELECT status FROM turns WHERE id=?').get(turnId) as any).status==='running'){
      assert.equal(parkRunningTurnAfterProviderFailure({turnId,ownerInstanceId:'sweeper',dispatchAttempt:attempt,
        failureClass:'parked_ambiguous',error:'still unknown'}),true);
      await releaseExecution(db.query('SELECT * FROM executions WHERE execution_id=?').get(executionId) as any);
    }
    const found=(await sweep()).adopted.map(a=>a.claim.turn_id).includes(turnId);
    assert.equal(found,tries<PARKED_CODEX_FOLLOW_LIMIT,`try ${tries}`);
  }
  console.log('parked codex follow fixture: parked Codex turns were taken back two per sweep and given up after a few tries');
}finally{
  rmSync(scratch,{recursive:true,force:true});
}
process.exit(0);
