// Replays two 2026-11-12 failures offline.
// 1. A Codex account switch released 37 usage-held turns in one instant; they must start a few
//    sessions at a time, Inbox-owed first, and a later release must not collapse the pace.
// 2. A "no confirmed answer" reminder whose asking session was handed off was re-admitted into the
//    successor under the predecessor's identity and refused about three times a minute; it must be
//    read from the successor's copy instead, and reach a successor that has no copy.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HELD_RELEASE_PACING_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'concierge-held-release-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=HELD_RELEASE_PACING_TEST_AUTHORIZATION;

const [{db,claimNextQueuedTurn,retryRunningTurnAfterProviderFailure,releaseScheduledProviderRetries,paceLapsedUsageHolds,
  RELEASE_PACE_HOLD,RELEASE_PACE_SESSIONS,RELEASE_PACE_INTERVAL_MS},
  {SessionOwner},{createNativeSession,retainSessionInput,enqueueSessionInput,getAcceptedSessionInput},
  {deliverRequestReminder}]=await Promise.all([
  import('../src/state'),import('../src/session-owner'),import('../src/session-inputs'),import('../src/request-reminder-carrier')]);
const owner=new SessionOwner({available:()=>true,wake:()=>{},stop:async()=>false,steer:()=>false},scratch);

const OWNER='held-release-fixture';
function usageHeldCodexSession(name:string){
  const session=createNativeSession('codex',{title:name,summary:undefined,purpose:'develop',origin:'native'});
  const input=retainSessionInput({id:name,sessionId:session.id,scope:'fixture',actionId:name,kind:'input',origin:'agent',payload:{text:name}}).input;
  enqueueSessionInput(input.id);
  const claim=claimNextQueuedTurn(OWNER)!;
  assert.equal(retryRunningTurnAfterProviderFailure({turnId:claim.turn_id,ownerInstanceId:OWNER,dispatchAttempt:claim.dispatch_attempt,
    error:'Usage for fixture is cached as exhausted. No request was sent.',nextAttemptMs:Date.now()+86_400_000,usageHold:true}),true);
  return {session,turnId:claim.turn_id};
}
const turn=(id:number)=>db.query('SELECT status,dispatch_hold,dispatch_next_attempt_ms FROM turns WHERE id=?').get(id) as
  {status:string;dispatch_hold:string|null;dispatch_next_attempt_ms:number};

try{
  // 1. Paced release.
  const held=Array.from({length:5},(_,i)=>usageHeldCodexSession(`held-${i}`));
  const before=Date.now();
  assert.equal(releaseScheduledProviderRetries('codex'),5);
  const slots=held.map(h=>turn(h.turnId));
  assert.ok(slots.every(row=>row.status==='queued'&&row.dispatch_hold===RELEASE_PACE_HOLD),'released turns carry the pace hold');
  const offsets=slots.map(row=>Math.round((row.dispatch_next_attempt_ms-before)/RELEASE_PACE_INTERVAL_MS));
  assert.deepEqual(offsets,[0,0,1,1,2],'two sessions start now, the rest every 15 s, oldest first');
  assert.equal(RELEASE_PACE_SESSIONS,2);
  // Only the first slot is claimable now; the old code made all five claimable at once.
  const now=Date.now()+1_000;
  const first=claimNextQueuedTurn(OWNER,now),second=claimNextQueuedTurn(OWNER,now),third=claimNextQueuedTurn(OWNER,now);
  assert.deepEqual([first?.turn_id,second?.turn_id,third],[held[0]!.turnId,held[1]!.turnId,null]);
  // A later reading's release does not collapse the pace.
  assert.equal(releaseScheduledProviderRetries('codex'),0);
  assert.ok(turn(held[4]!.turnId).dispatch_next_attempt_ms>=before+RELEASE_PACE_INTERVAL_MS);

  // A usage hold that simply runs out at its reset instant joins the same pace.
  const lapsing=Array.from({length:3},(_,i)=>usageHeldCodexSession(`lapsing-${i}`));
  const resetAt=Date.now()-1_000;
  for(const h of lapsing)db.query('UPDATE turns SET dispatch_next_attempt_ms=? WHERE id=?').run(resetAt,h.turnId);
  assert.equal(paceLapsedUsageHolds(),3);
  assert.ok(lapsing.every(h=>turn(h.turnId).dispatch_hold===RELEASE_PACE_HOLD));
  const dueNow=db.query(`SELECT count(DISTINCT session_id) AS n FROM turns WHERE status='queued' AND dispatch_hold=? AND dispatch_next_attempt_ms<=?`)
    .get(RELEASE_PACE_HOLD,Date.now()) as {n:number};
  assert.ok(dueNow.n<=RELEASE_PACE_SESSIONS,'lapsed holds do not all become claimable at once');
  assert.equal(paceLapsedUsageHolds(),0,'nothing lapsed twice');

  // 2. A reminder that followed a handoff.
  const predecessor=createNativeSession('codex',{title:'asker',summary:undefined,purpose:'develop',origin:'native'});
  const successor=createNativeSession('claude-code',{title:'asker continued',summary:undefined,purpose:'develop',origin:'native'});
  retainSessionInput({id:'asker-input',sessionId:predecessor.id,scope:'fixture',actionId:'asker-input',kind:'input',origin:'agent',payload:{text:'ask'}});
  const source={sourceInputId:'asker-input',sourceRunId:'asker-run',requestId:'req-1',text:'This request has no confirmed answer after 15 minutes.'};
  const original=owner.admit({sessionId:predecessor.id,inputId:'request-reminder:evt-1',origin:'service',...source});
  assert.ok(original.turn_id,'the reminder was queued on the predecessor');
  // What an accepted handoff does with a queued reminder: copy it to the successor, cancel the original.
  const clone=retainSessionInput({id:'handoff-input:h1:request-reminder:evt-1',sessionId:successor.id,scope:'handoff:h1',actionId:original.id,
    kind:'input',origin:'service',payload:JSON.parse(original.payload_json),sourceInputId:source.sourceInputId,sourceRunId:source.sourceRunId,requestId:source.requestId}).input;
  enqueueSessionInput(clone.id);
  db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({state:'canceled',movedTo:'x',continuedAs:clone.id}),original.id);
  // The old delivery re-admitted the original identity into the successor: refused, forever.
  assert.throws(()=>owner.admit({sessionId:successor.id,inputId:'request-reminder:evt-1',origin:'service',...source}),/Idempotency conflict/);
  for(const acceptedInputId of [original.id,clone.id,null]){
    const delivered=deliverRequestReminder({eventId:'evt-1',acceptedInputId,sourceSessionId:successor.id,...source,owner});
    assert.equal(delivered.inputId,clone.id,'the successor copy carries the reminder');
    assert.equal(delivered.status,'admitted');
  }
  // A successor with no copy (the original never reached a turn) gets its own, under its own identity.
  const lonely=createNativeSession('codex',{title:'held asker',summary:undefined,purpose:'develop',origin:'native'});
  db.query("UPDATE sessions SET native_metadata_json=json_set(COALESCE(native_metadata_json,'{}'),'$.suspended',1) WHERE id=?").run(lonely.id);
  const unsent=owner.admit({sessionId:lonely.id,inputId:'request-reminder:evt-2',origin:'service',...source});
  assert.equal(unsent.turn_id,null,'a suspended predecessor never queued it');
  const heir=createNativeSession('claude-code',{title:'heir',summary:undefined,purpose:'develop',origin:'native'});
  const moved=deliverRequestReminder({eventId:'evt-2',acceptedInputId:unsent.id,sourceSessionId:heir.id,...source,owner});
  assert.equal(moved.inputId,`request-reminder:evt-2:session:${heir.id}`);
  assert.equal(getAcceptedSessionInput(moved.inputId)!.session_id,heir.id);
  assert.equal(moved.status,'admitted');
  // Delivering again is idempotent.
  assert.deepEqual(deliverRequestReminder({eventId:'evt-2',acceptedInputId:moved.inputId,sourceSessionId:heir.id,...source,owner}),moved);
  console.log('held-release-pacing-fixture: released work is paced; handed-off reminders follow their copy.');
}finally{
  rmSync(scratch,{recursive:true,force:true});
}
