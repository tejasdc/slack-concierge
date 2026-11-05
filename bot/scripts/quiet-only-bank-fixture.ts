import {strict as assert} from 'node:assert';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runFixtureChild} from './fixture-child';

async function fixture(){
  const state=await mkdtemp(join(tmpdir(),'concierge-quiet-bank-'));
  try{return await runFixtureChild({command:process.execPath,args:[import.meta.path,'--child'],env:{...process.env,
    CONCIERGE_TEST_MODE:'1',CONCIERGE_TEST_AUTHORIZATION:'quiet-bank-e943db22',
    CONCIERGE_STATE_DIR:state,CONCIERGE_CAPTURE_STATE_DIR:join(state,'capture')},deadlineMs:20_000,fixture:'quiet-only-bank'});
  }finally{await rm(state,{recursive:true,force:true});}
}

async function child(){
  const [{db,claimNextQueuedTurn,finishTurn},{createNativeSession,retainSessionInput,enqueueSessionInput,queueTurnContinuation},
    {saveQueuedTurn,savedTurn,updateSavedTurn},{quietOnlyAdmits}]=await Promise.all([
    import('../src/state'),import('../src/session-inputs'),import('../src/saved-work'),import('../src/quiet-hours')]);
  const {cancelQueuedWithdrawnRequest}=await import('../src/request-liveness');
  const settings={quiet_start_hour:0,quiet_end_hour:6,time_zone:'America/New_York'};
  const afternoon=Date.parse('2026-11-05T14:22:00-05:00');
  const night=Date.parse('2026-11-06T00:30:00-05:00');
  const closing=Date.parse('2026-11-06T05:55:00-05:00');
  assert.equal(quietOnlyAdmits(afternoon,settings),false);
  assert.equal(quietOnlyAdmits(night,settings),true);
  assert.equal(quietOnlyAdmits(closing-1,settings),true);
  assert.equal(quietOnlyAdmits(closing,settings),false,'admission closes before 6 a.m.');
  const make=(name:string,quietOnly:boolean)=>{
    const session=createNativeSession('codex',{title:name});
    const input=retainSessionInput({sessionId:session.id,scope:'quiet-bank-fixture',actionId:name,
      kind:'input',origin:'agent',payload:{text:name}}).input;
    const queued=enqueueSessionInput(input.id);
    assert.ok(queued.turn_id);
    saveQueuedTurn(queued.turn_id,'banked',undefined,undefined,undefined,undefined,undefined,quietOnly);
    db.query('UPDATE turns SET saved_account=?,saved_window=?,saved_boundary_ms=?,dispatch_next_attempt_ms=0 WHERE id=?')
      .run('fixture-account','Weekly',Date.parse('2026-11-07T00:00:00Z'),queued.turn_id);
    return {session,input,turnId:queued.turn_id};
  };
  const phone=make('phone',true);
  assert.equal(savedTurn(phone.turnId)?.saved_quiet_only,1);
  const clock=Date.now;
  try{
    Date.now=()=>afternoon;
    assert.throws(()=>updateSavedTurn(phone.turnId,'start',{clientActionId:'daytime-start'}),/quiet window/);
    assert.equal(savedTurn(phone.turnId)?.saved_manual_start,0);
  }finally{Date.now=clock;}
  assert.equal(claimNextQueuedTurn('fixture',afternoon),null,'phone work must not claim near an afternoon reset');
  const generic=make('generic',false);
  assert.equal(claimNextQueuedTurn('fixture',afternoon)?.turn_id,generic.turnId,'generic bank behavior remains available');
  finishTurn(generic.turnId,'done','Fixture work completed.');
  assert.equal(claimNextQueuedTurn('fixture',closing),null,'a stale eligible row must not claim at the morning cutoff');
  assert.equal(claimNextQueuedTurn('fixture',night)?.turn_id,phone.turnId,'quiet-only work can claim at night');
  finishTurn(phone.turnId,'cancelled','Fixture boundary stop.');
  const next=queueTurnContinuation(phone.turnId,{kind:'boundary',detail:'quiet window ended'});
  assert.ok(next.turn_id);
  assert.equal(savedTurn(next.turn_id)?.saved_quiet_only,1,'continuation retains the quiet-only choice');
  db.query('UPDATE turns SET saved_account=?,saved_window=?,saved_boundary_ms=?,dispatch_next_attempt_ms=0 WHERE id=?')
    .run('fixture-account','Weekly',Date.parse('2026-11-07T00:00:00Z'),next.turn_id);
  assert.equal(claimNextQueuedTurn('fixture',afternoon),null,'boundary continuation cannot claim by day');
  assert.equal(cancelQueuedWithdrawnRequest(phone.input.id),true,'request withdrawal follows the saved continuation');
  assert.equal(savedTurn(next.turn_id)?.status,'cancelled');
  const refused=make('refused',true);
  finishTurn(refused.turnId,'error','Provider usage refused.');
  const retry=queueTurnContinuation(refused.turnId,{kind:'provider_refused',refusal:'usage',detail:'limit',elsewhere:true});
  assert.ok(retry?.turn_id);
  assert.equal(savedTurn(retry.turn_id)?.saved_quiet_only,1,'provider refusal retains the quiet-only choice');
  db.query('UPDATE turns SET saved_account=?,saved_window=?,saved_boundary_ms=?,dispatch_next_attempt_ms=0 WHERE id=?')
    .run('fixture-account','Weekly',Date.parse('2026-11-07T00:00:00Z'),retry.turn_id);
  assert.equal(claimNextQueuedTurn('fixture',afternoon),null,'provider refusal continuation cannot claim by day');
  const withdrawn=make('withdrawn',true);
  assert.equal(cancelQueuedWithdrawnRequest(withdrawn.input.id),true);
  assert.equal(savedTurn(withdrawn.turnId)?.status,'cancelled');
  assert.equal(JSON.parse((db.query('SELECT receipt_json FROM session_inputs WHERE id=?').get(withdrawn.input.id) as {receipt_json:string}).receipt_json).state,'canceled');
  assert.equal(cancelQueuedWithdrawnRequest(withdrawn.input.id),true,'cancellation is idempotent');
  console.log(JSON.stringify({fixture:'quiet-only-bank',afternoonBlocked:true,morningBlocked:true,genericClaimed:true,continuationPreserved:true,savedCancellation:true}));
}

if(import.meta.main){
  if(process.argv[2]==='--child')child().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
  else console.log(JSON.stringify(await fixture()));
}
