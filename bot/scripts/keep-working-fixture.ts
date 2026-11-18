// Keep-working mode (docs/plans/2026-11-18-keep-working-mode.md): the shared wake predicate, the Stop-hook
// reminder the owner answers with, the one-wake backstop with its progress guard, and the session view.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {KEEP_WORKING_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'concierge-keep-working-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=KEEP_WORKING_TEST_AUTHORIZATION;

const [{db,finishTurn,getSessionById,claimNextQueuedTurn,markTurnProviderAdmissionIntended,acknowledgeTurnProviderInput},{SessionOwner},{SessionCommunicationCoordinator},{createNativeSession,retainSessionInput,enqueueSessionInput,nativeRunId,acceptedInputForTurn},{sessionWillWake},{KEEP_WORKING_WAKE_PREFIX,keepWorkingState,recordKeepWorking}]=await Promise.all([
  import('../src/state'),import('../src/session-owner'),import('../src/session-communication'),import('../src/session-inputs'),import('../src/request-liveness'),import('../src/keep-working')]);

const errors:unknown[]=[];
const owner=new SessionOwner({available:()=>true,wake:()=>{},stop:async()=>false,steer:()=>false},scratch);
const communication=new SessionCommunicationCoordinator({owner,isOwnerAlive:()=>true,onError:error=>errors.push(error)});
owner.communication=communication;
const c=communication as any;

const make=(title:string)=>createNativeSession('codex',{title,summary:undefined,purpose:'develop',origin:'native'});
let n=0;
function startTurn(sessionId:number,prefix='work'){
  const id=`${prefix}-${sessionId}-${++n}`;
  const input=retainSessionInput({id,sessionId,scope:'fixture',actionId:id,kind:'input',origin:'agent',payload:{text:id}}).input;
  enqueueSessionInput(input.id);
  const turnId=(db.query('SELECT id FROM turns WHERE accepted_input_id=? OR id=(SELECT turn_id FROM session_inputs WHERE id=?)').get(input.id,input.id) as {id:number}).id;
  db.query("UPDATE turns SET status='running' WHERE id=?").run(turnId);
  return {turnId,inputId:input.id};
}
const wakes=(sessionId:number)=>db.query("SELECT id,turn_id FROM session_inputs WHERE session_id=? AND id LIKE ?").all(sessionId,`${KEEP_WORKING_WAKE_PREFIX}%`) as {id:string;turn_id:number|null}[];
const source=(t:{turnId:number;inputId:string})=>({input_id:t.inputId,run_id:nativeRunId(t.turnId)});
const setMode=(s:ReturnType<typeof make>,t:{turnId:number;inputId:string},state:'on'|'off',action:string,reason='Essos backlog')=>
  recordKeepWorking(db,{sessionId:s.id,actionId:action,state,reason,actor:'agent:fixture',sourceInputId:t.inputId,sourceRunId:source(t).run_id,nowMs:Date.now()});

try{
  communication.start();await communication.idle();

  // The real command path: an exact live run turns the mode on for itself, then off for another session by address.
  await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text:'Caller'}});
  const claim=claimNextQueuedTurn('keep-working-fixture')!;
  assert.equal(markTurnProviderAdmissionIntended(claim.turn_id,'keep-working-fixture',claim.dispatch_attempt),true);
  acknowledgeTurnProviderInput(claim.turn_id,'keep-working-fixture',claim.dispatch_attempt,[]);
  const caller={input_id:claim.accepted_input_id!,run_id:nativeRunId(claim.turn_id)};
  const callerSession=(db.query('SELECT session_id FROM turns WHERE id=?').get(claim.turn_id) as {session_id:number}).session_id;
  const viaApi=c.keepWorking({source:caller,action_id:'api-on',state:'on',reason:'API backlog'});
  assert.equal(viaApi.status,'keeping-working');assert.equal(keepWorkingState(db,callerSession).on!.reason,'API backlog');
  assert.equal(c.keepWorking({source:caller,action_id:'api-on',state:'on',reason:'API backlog'}).duplicate,true);
  assert.throws(()=>c.keepWorking({source:caller,action_id:'api-empty',state:'on',reason:' '}),/Say what queue/);
  c.keepWorking({source:caller,action_id:'api-off',state:'off',reason:'queue empty'});assert.equal(keepWorkingState(db,callerSession).on,null);

  // Mode state: idempotent, durable history, shown in the view.
  const s=make('orchestrator');const t1=startTurn(s.id);
  assert.equal((owner.view(getSessionById(s.id)!) as any).keepWorking,null);
  setMode(s,t1,'on','on-1');assert.equal(setMode(s,t1,'on','on-1').duplicate,true);
  assert.throws(()=>setMode(s,t1,'off','on-1'),/Idempotency conflict/);
  const shown=(owner.view(getSessionById(s.id)!) as any);
  assert.equal(shown.keepWorking.reason,'Essos backlog');assert.equal(typeof shown.keepWorking.since,'string');

  // Predicate: this run alone is not a wake condition; each real one is.
  assert.equal(sessionWillWake(s.id,t1.turnId),false,'running turn ignored: idle');
  const sibling=make('other');const other=startTurn(sibling.id);
  assert.equal(sessionWillWake(s.id,0),true,'with the run counted, a running turn is a wake condition');
  const queuedTurn=startTurn(s.id);db.query("UPDATE turns SET status='queued' WHERE id=?").run(queuedTurn.turnId);
  assert.equal(sessionWillWake(s.id,t1.turnId),true,'a queued (scheduled/snoozed) turn wakes it');
  db.query("UPDATE turns SET status='done' WHERE id=?").run(queuedTurn.turnId);
  assert.equal(sessionWillWake(s.id,t1.turnId),false);
  db.query(`INSERT INTO watches(watch_id,session_id,origin_input_id,origin_run_id,action_id,request_hash,kind,condition_json,baseline_json,baseline_mode,deadline_ms,state,gaps_json,created_at_ms)
    VALUES('w1',?,?,?,'a','h','file','{}','{}','none',?, 'observing','[]',?)`).run(s.id,t1.inputId,source(t1).run_id,Date.now()+3_600_000,Date.now());
  assert.equal(sessionWillWake(s.id,t1.turnId),true,'a live watch wakes it');
  db.query("UPDATE watches SET state='cancelled' WHERE watch_id='w1'").run();
  assert.equal(sessionWillWake(s.id,t1.turnId),false);

  // Stop hook answer: reminder with nothing in flight; none once a returning request exists; none for a session not in the mode.
  const reminder=(sessionId:number,t:{turnId:number})=>c.keepWorkingReminder({session_id:sessionId,turn_id:t.turnId,accepted_input_id:null});
  assert.deepEqual(reminder(s.id,t1),{reason:'Essos backlog'});
  const plain=make('plain');const pt=startTurn(plain.id);assert.equal(reminder(plain.id,pt),null,'not in the mode: passes');
  retainSessionInput({id:'ret',sessionId:s.id,scope:'fixture',actionId:'ret',kind:'input',origin:'agent',payload:{text:'x'}});
  db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,source_root_ts,action_id,target_session_id,target_channel,target_root_ts,payload_json,payload_hash,created_at_ms,source_input_id,target_input_id,due_at_ms)
    VALUES('req1','c','1',?,?,'1','a',?,'c','1','{}','h',?,?,?,?)`).run(t1.turnId,s.id,sibling.id,Date.now(),t1.inputId,other.inputId,Date.now()+3_600_000);
  assert.equal(reminder(s.id,t1),null,'a sent request that returns to it is a wake condition: passes');
  db.query("DELETE FROM session_communication_requests WHERE request_id='req1'").run();
  db.query("UPDATE turns SET status='done' WHERE id=?").run(other.turnId);

  // Backstop: an idle ending queues exactly one wake; a second idle ending turns the mode off.
  finishTurn(t1.turnId,'done','finished');await new Promise(r=>setTimeout(r,20));
  assert.equal(wakes(s.id).length,1,'exactly one wake after an idle keep-working turn ends');
  assert.ok(wakes(s.id)[0].turn_id,'the wake is a queued turn');
  c.keepWorkingBackstop(t1.turnId);assert.equal(wakes(s.id).length,1,'repeating the check for the same turn queues nothing more');
  const wakeTurnId=wakes(s.id)[0].turn_id!;
  assert.equal(acceptedInputForTurn(wakeTurnId)!.origin,'service');
  db.query("UPDATE turns SET status='running' WHERE id=?").run(wakeTurnId);
  finishTurn(wakeTurnId,'done','still nothing');await new Promise(r=>setTimeout(r,20));
  assert.equal(wakes(s.id).length,1,'no second wake');
  const after=keepWorkingState(db,s.id);assert.equal(after.on,null);
  assert.match(after.lastOff!.reason,/Woke once with nothing dispatched/);assert.equal(after.lastOff!.actor,'owner');
  assert.equal((owner.view(getSessionById(s.id)!) as any).keepWorkingLastOff.by,'owner');

  // A human Stop queues nothing; an agent's own off ends the mode before the turn ends.
  const stopped=make('stopped');const st=startTurn(stopped.id);setMode(stopped,st,'on','on-s');
  db.query("UPDATE turns SET stop_requested_at=CURRENT_TIMESTAMP WHERE id=?").run(st.turnId);
  finishTurn(st.turnId,'cancelled','stopped');await new Promise(r=>setTimeout(r,20));
  assert.equal(wakes(stopped.id).length,0,'a human Stop wakes nothing');
  const rested=make('rested');const rt=startTurn(rested.id);setMode(rested,rt,'on','on-r');setMode(rested,rt,'off','off-r','backlog empty');
  finishTurn(rt.turnId,'done','done');await new Promise(r=>setTimeout(r,20));
  assert.equal(wakes(rested.id).length,0,'mode off: nothing queued');
  const withWork=make('has work');const wt=startTurn(withWork.id);setMode(withWork,wt,'on','on-w');
  const next=startTurn(withWork.id);db.query("UPDATE turns SET status='queued' WHERE id=?").run(next.turnId);
  finishTurn(wt.turnId,'done','done');await new Promise(r=>setTimeout(r,20));
  assert.equal(wakes(withWork.id).length,0,'something else is queued: no wake needed');
  assert.deepEqual(errors,[]);
  console.log('keep-working fixture passed');
}finally{
  await communication.stop();
  rmSync(scratch,{recursive:true,force:true});
}
