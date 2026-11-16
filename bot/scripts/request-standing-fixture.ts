// Replays the 2026-11-16 report: threads whose request was open showed "No update yet" and nobody woke
// the holder. Checks each standing state, the thread work value, and the hourly quiet clock.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {REQUEST_STANDING_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'concierge-request-standing-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=REQUEST_STANDING_TEST_AUTHORIZATION;

const [{db,claimNextQueuedTurn,markTurnProviderAdmissionIntended,acknowledgeTurnProviderInput},
  {SessionOwner},{SessionCommunicationCoordinator},{nativeRunId,updateSessionMetadata},{topicsCommand},{requestStanding,heldRequests,workerWork,openRequestStandings,QUIET_WAKE_MS,standingFinder},{REMINDERS_SINCE_MS},{topicCurrentWorkers}]=await Promise.all([
  import('../src/state'),import('../src/session-owner'),import('../src/session-communication'),import('../src/session-inputs'),import('../src/session-topics'),import('../src/request-standing'),import('../src/request-liveness'),import('../src/topic-current-workers')]);

const errors:unknown[]=[];
let clock=Date.now();
const HOUR=QUIET_WAKE_MS;
const owner=new SessionOwner({available:()=>true,wake:()=>{},stop:async()=>false,steer:()=>false},scratch);
const communication=new SessionCommunicationCoordinator({owner,now:()=>clock,isOwnerAlive:()=>true,onError:error=>errors.push(error)});
owner.communication=communication;

function run(){
  const claim=claimNextQueuedTurn('request-standing-fixture');
  assert.ok(claim);
  assert.equal(markTurnProviderAdmissionIntended(claim.turn_id,'request-standing-fixture',claim.dispatch_attempt),true);
  acknowledgeTurnProviderInput(claim.turn_id,'request-standing-fixture',claim.dispatch_attempt,[]);
  const inputId=claim.accepted_input_id!;
  return {turnId:claim.turn_id,sessionId:claim.session_id,source:{input_id:inputId,run_id:nativeRunId(claim.turn_id)}};
}
const quietInputs=(requestId:string)=>(db.query("SELECT id FROM session_inputs WHERE id LIKE ? AND id NOT LIKE '%:session:%' ORDER BY id").all(`request-quiet:${requestId}:%`) as {id:string}[]).map(row=>row.id);
// The owner's own chase (report-back, stall, overdue reminder) is stopped once the requests exist, so only the quiet clock is measured.
const scan=async()=>{
  const live=communication as any;live.stopped=false;
  try{await live.scanQuietRequests();await communication.idle();}finally{live.stopped=true;}
  // The owner's own report-back reminders (a different service) are not the clock under test: withdraw them.
  db.query("UPDATE turns SET status='cancelled' WHERE status='queued' AND session_id<>1 AND id IN (SELECT turn_id FROM session_inputs WHERE id LIKE 'report-back:%' OR id LIKE 'request-reminder:%' OR id LIKE 'return:%')").run();
};
const tick=async(ms:number)=>{clock+=ms;await scan();};
const endTurns=(sessionId:number)=>db.query("UPDATE turns SET status='done',ended_at=CURRENT_TIMESTAMP WHERE session_id=? AND status IN ('queued','running')").run(sessionId);
const standing=(id:string)=>requestStanding(db,id,clock)!;

try {
  communication.start();await communication.idle();
  const inbox=await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text:'Standing fixture'}});
  updateSessionMetadata(Number(inbox.session.id.slice(10)),{inbox:true});
  const router=run();
  const root=router.source.input_id;
  const actor={sessionId:router.sessionId,turnId:router.turnId,inputId:root,runId:router.source.run_id};
  const area=topicsCommand(actor,{verb:'area.create',action_id:'area',name:'Standing fixture'}).area;
  topicsCommand(actor,{verb:'create',action_id:'topic',title:'Standing thread',roots:[root],area_ids:[area.id]});
  const create=async()=>{const made=await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat'});return {id:Number(made.session.id.slice(10)),address:made.session.address};};
  const ask=async(label:string,from:{input_id:string;run_id:string},to:{address:string},thread?:string)=>{
    const sent=await communication.ask({source:from,action_id:`standing-${label}`,address:to.address,...(thread?{thread}:{}),summary:`Work ${label}`,text:`Do ${label}.`,requestedEffect:'work'});
    await communication.idle();return sent.request_id as string;
  };

  // Requests. Each claim takes the one queued turn just made, so a holder can ask on.
  const [a,c,d,e,f,g,h,old]=[await create(),await create(),await create(),await create(),await create(),await create(),await create(),await create()];
  const waitingId=await ask('thread',router.source,a,root);
  const aRun=run();assert.equal(aRun.sessionId,a.id);
  const chainId=await ask('chain',router.source,f,root);
  const fRun=run();assert.equal(fRun.sessionId,f.id);
  await ask('chase',aRun.source,c);
  await ask('chain-dep',fRun.source,g);
  const workingId=await ask('working',router.source,d,root);
  const heldId=await ask('held',router.source,e,root);
  const quietId=await ask('quiet',router.source,h,root);
  await communication.stop();
  endTurns(a.id);endTurns(c.id);endTurns(f.id);endTurns(h.id);
  db.query("UPDATE turns SET status='running' WHERE session_id=?").run(d.id);
  db.query("UPDATE turns SET dispatch_hold='usage' WHERE session_id=? AND status='queued'").run(e.id);

  assert.equal(standing(quietId).state,'quiet');

  // Waiting on an agent that is itself idle: exactly one wake per hour of silence.
  const waiting=standing(waitingId);
  assert.equal(waiting.state,'waiting');assert.match(waiting.text,/^Waiting on .* · no word from it$/);
  assert.equal(waiting.holder.sessionId,`concierge:${a.id}`);assert.deepEqual(waiting.movedFrom,[]);
  assert.doesNotMatch(waiting.text,/\d\d:\d\d/,'times travel in since/until, not in the words');
  await tick(0);assert.deepEqual(quietInputs(waitingId),[],'nothing at the start');
  await tick(HOUR-60_000);assert.deepEqual(quietInputs(waitingId),[],'not before an hour');
  await tick(2*60_000);
  assert.deepEqual(quietInputs(waitingId),[`request-quiet:${waitingId}:1`],'one wake after an hour');
  const marked=db.query('SELECT quiet_reminded_at_ms AS at FROM session_communication_requests WHERE request_id=?').get(waitingId) as {at:number};
  assert.equal(marked.at,clock);assert.equal(standing(waitingId).remindedAt,new Date(clock).toISOString());
  assert.equal((db.query("SELECT session_id FROM session_inputs WHERE id=?").get(`request-quiet:${waitingId}:1`) as {session_id:number}).session_id,a.id,'the holder received the wake');
  endTurns(a.id); // the holder acts on the wake without settling the request
  await tick(30*60_000);assert.equal(quietInputs(waitingId).length,1,'not again within the hour');
  await tick(31*60_000);
  assert.deepEqual(quietInputs(waitingId),[`request-quiet:${waitingId}:1`,`request-quiet:${waitingId}:2`],'a second only after another hour');

  // Nothing wakes a holder whose chain is running, or whose next turn is held.
  assert.equal(standing(workingId).state,'working');assert.equal(standing(workingId).text,'Working now');
  const held=standing(heldId);assert.equal(held.state,'held');assert.match(held.text,/usage/);
  const chain=standing(chainId);assert.equal(chain.state,'working');assert.match(chain.text,/^Working through /,'g is queued to run');
  await tick(3*HOUR);
  for(const id of [workingId,heldId,chainId])assert.deepEqual(quietInputs(id),[],`no wake for ${id}`);

  // Every worker has a standing, and a waiting request is not dropped while another one works.
  const routed=topicCurrentWorkers(db,[{sessionId:`concierge:${d.id}`,title:'D',requestId:workingId}],standingFinder(db,new Map(),clock));
  assert.equal(routed[0]!.standing!.state,'working','a routed request that is not a topic dispatch gets a real standing');
  const both=workerWork(routed,openRequestStandings(db,[{state:'open',dispatches:[{requestId:workingId},{requestId:heldId}]}],clock))!;
  assert.equal(both.kind,'worker_working');
  assert.deepEqual(both.workers.map(worker=>worker.requestId).sort(),[heldId,workingId].sort(),'one entry per request, working and waiting together');
  assert.equal(both.workers.find(worker=>worker.requestId===heldId)!.standing!.state,'held');
  assert.equal(both.workers.find(worker=>worker.requestId===workingId)!.standing!.state,'working');

  // Wakes that bring no word stop after three: the fourth time round the request is stalled for the Inbox router.
  endTurns(a.id);await tick(61*60_000);
  assert.equal(quietInputs(waitingId).length,3);endTurns(a.id);
  assert.equal((db.query('SELECT stalled_at_ms FROM session_communication_requests WHERE request_id=?').get(waitingId) as {stalled_at_ms:number|null}).stalled_at_ms,null);
  await tick(61*60_000);
  assert.equal(quietInputs(waitingId).length,3,'no fourth wake');
  assert.equal(standing(waitingId).state,'stalled');assert.match(standing(waitingId).text,/no word after three hourly reminders/);
  // A progress reply starts the count again: quiet request h had one wake; it gets a second, then word, then more than three wakes in all.
  endTurns(h.id);await tick(61*60_000);assert.equal(quietInputs(quietId).length,2);endTurns(h.id);
  db.query("INSERT INTO session_communication_events(event_id,request_id,kind,action_key,payload_json,created_at_ms) VALUES(?,?,'progress',NULL,?,?)").run(randomUUID(),quietId,JSON.stringify({text:'Still on it.'}),clock);
  for(let round=3;round<=5;round++){await tick(61*60_000);assert.equal(quietInputs(quietId).length,round,`wake ${round} after the word`);endTurns(h.id);}
  assert.equal((db.query('SELECT stalled_at_ms FROM session_communication_requests WHERE request_id=?').get(quietId) as {stalled_at_ms:number|null}).stalled_at_ms,null,'word reset the count');

  // Quiet with nothing to wait on gets its wake too; stalled says so.
  assert.equal(quietInputs(quietId)[0],`request-quiet:${quietId}:1`,'a holder with nothing to wait on is woken too');
  db.query('UPDATE session_communication_requests SET stalled_at_ms=? WHERE request_id=?').run(clock,workingId);
  assert.equal(standing(workingId).state,'stalled');assert.match(standing(workingId).text,/^Stopped without finishing/);

  // Moved from the predecessor it was handed off from.
  db.query(`INSERT INTO session_handoffs(id,predecessor_session_id,successor_session_id,state,action_id,caller_session_id,reason,requesting_input_id,requesting_run_id,inventory_json,inventory_digest,accepted_at)
    VALUES('handoff-fixture',?,?,'accepted','a',?,'fixture','i','r','[]','d',CURRENT_TIMESTAMP)`).run(old.id,h.id,old.id);
  db.query("INSERT INTO session_handoff_items(handoff_id,kind,ref,from_session_id,to_session_id) VALUES('handoff-fixture','owed',?,?,?)").run(quietId,old.id,h.id);
  assert.deepEqual(standing(quietId).movedFrom.map(person=>person.sessionId),[`concierge:${old.id}`]);

  // Thread work value, and what each session holds.
  const standings=openRequestStandings(db,[{state:'open',dispatches:[{requestId:workingId},{requestId:heldId}]}],clock);assert.equal(standings.size,2);
  const value=workerWork([],standings)!;
  assert.equal(value.kind,'worker_waiting');assert.ok(value.text.includes(' · '));
  assert.ok(value.workers.every(worker=>worker.requestId&&worker.standing));
  assert.equal(workerWork([],new Map()),null,'no open request is idle');
  const running=workerWork([],openRequestStandings(db,[{state:'open',dispatches:[{requestId:chainId}]}],clock))!;
  assert.equal(running.kind,'worker_working');
  assert.equal(heldRequests(db,h.id)!.count,1);assert.equal(heldRequests(db,router.sessionId),null);
  assert.deepEqual(errors,[]);
  void inbox;
  console.log('request standing fixture passed');
} finally {
  rmSync(scratch,{recursive:true,force:true});
}
process.exit(0);
