/**
 * A planned banked pause is carried on by its continuation: the request it served must not read
 * the cancellation as the work being stopped (2026-11-12, turns 28657 and 28672,
 * docs/incidents/2026-11-12-banked-pause-closed-its-request.md).
 */
import {strict as assert} from 'node:assert';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runFixtureChild} from './fixture-child';

async function fixture(){
  const state=await mkdtemp(join(tmpdir(),'concierge-banked-yield-'));
  try{return await runFixtureChild({command:process.execPath,args:[import.meta.path,'--child'],env:{...process.env,
    CONCIERGE_TEST_MODE:'1',CONCIERGE_TEST_AUTHORIZATION:'quiet-bank-e943db22',
    CONCIERGE_STATE_DIR:state,CONCIERGE_CAPTURE_STATE_DIR:join(state,'capture')},deadlineMs:20_000,fixture:'banked-yield-request'});
  }finally{await rm(state,{recursive:true,force:true});}
}

async function child(){
  const [{db,claimNextQueuedTurn,finishTurn},{createNativeSession,retainSessionInput,enqueueSessionInput,carryingTurn,awaitingBankedContinuation},
    {saveQueuedTurn,resumeBankedAfterYield,savedTurn}]=await Promise.all([
    import('../src/state'),import('../src/session-inputs'),import('../src/saved-work')]);
  const night=Date.parse('2026-11-06T00:30:00-05:00');
  const make=(name:string)=>{
    const session=createNativeSession('claude-code',{title:name});
    const input=retainSessionInput({sessionId:session.id,scope:'banked-yield-fixture',actionId:name,
      kind:'input',origin:'agent',payload:{text:name}}).input;
    const turnId=enqueueSessionInput(input.id).turn_id!;
    saveQueuedTurn(turnId,'banked',undefined,undefined,undefined,undefined,undefined,true);
    db.query('UPDATE turns SET saved_account=?,saved_window=?,saved_boundary_ms=?,dispatch_next_attempt_ms=0 WHERE id=?')
      .run('fixture-account','Weekly',Date.parse('2026-11-07T00:00:00Z'),turnId);
    return {session,input,turnId};
  };
  const paused=make('paused');
  assert.equal(claimNextQueuedTurn('fixture',night)?.turn_id,paused.turnId);
  // The upkeep records the planned pause before cancelling the run.
  db.query("UPDATE turns SET saved_yield_reason='deployment_boundary' WHERE id=?").run(paused.turnId);
  finishTurn(paused.turnId,'cancelled',null);
  assert.equal(awaitingBankedContinuation(paused.turnId),true,'the request waits for the continuation');
  assert.equal(carryingTurn(paused.turnId)?.status,'cancelled','no continuation yet');
  assert.equal(resumeBankedAfterYield(paused.turnId,'deployment_boundary'),true);
  assert.equal(awaitingBankedContinuation(paused.turnId),false);
  const carried=carryingTurn(paused.turnId)!;
  assert.notEqual(carried.id,paused.turnId,'the continuation carries the request');
  assert.equal(carried.status,'queued');
  assert.equal(savedTurn(carried.id)?.saved_quiet_only,1,'the continuation stays quiet-only banked work');

  // A cancellation that is not a planned pause still ends at itself.
  const stopped=make('stopped');
  assert.equal(claimNextQueuedTurn('fixture',night)?.turn_id,stopped.turnId);
  finishTurn(stopped.turnId,'cancelled',null);
  assert.equal(awaitingBankedContinuation(stopped.turnId),false);
  assert.equal(carryingTurn(stopped.turnId)?.id,stopped.turnId,'an ordinary cancellation settles its request');

  // A pause that cannot continue (the request was withdrawn) releases the request.
  const withdrawn=make('withdrawn');
  assert.equal(claimNextQueuedTurn('fixture',night)?.turn_id,withdrawn.turnId);
  db.query("UPDATE turns SET saved_yield_reason='quiet_boundary',stop_requested_at=CURRENT_TIMESTAMP WHERE id=?").run(withdrawn.turnId);
  finishTurn(withdrawn.turnId,'cancelled',null);
  resumeBankedAfterYield(withdrawn.turnId,'quiet_boundary');
  assert.equal(awaitingBankedContinuation(withdrawn.turnId),false,'a refused continuation does not hold the request');
  assert.equal(carryingTurn(withdrawn.turnId)?.id,withdrawn.turnId);
  console.log(JSON.stringify({fixture:'banked-yield-request',pauseCarried:true,ordinaryCancelSettles:true,refusedPauseReleases:true}));
}

if(import.meta.main){
  if(process.argv[2]==='--child')child().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
  else console.log(JSON.stringify(await fixture()));
}
