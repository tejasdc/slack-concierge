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
  const [a,c,d,e,f,g,h,old,j]=[await create(),await create(),await create(),await create(),await create(),await create(),await create(),await create(),await create()];
  const waitingId=await ask('thread',router.source,a,root);
  const aRun=run();assert.equal(aRun.sessionId,a.id);
  const chainId=await ask('chain',router.source,f,root);
  const fRun=run();assert.equal(fRun.sessionId,f.id);
  await ask('chase',aRun.source,c);
  await ask('chain-dep',fRun.source,g);
  const workingId=await ask('working',router.source,d,root);
  const heldId=await ask('held',router.source,e,root);
  const quietId=await ask('quiet',router.source,h,root);
  const resetId=await ask('reset',router.source,j,root);
  await communication.stop();
  endTurns(a.id);endTurns(c.id);endTurns(f.id);endTurns(h.id);endTurns(j.id);
  db.query("UPDATE turns SET status='running' WHERE session_id=?").run(d.id);
  db.query("UPDATE turns SET dispatch_hold='usage' WHERE session_id=? AND status='queued'").run(e.id);

  assert.equal(standing(quietId).state,'quiet');

  const progress=(requestId:string,text='Still waiting.')=>db.query("INSERT INTO session_communication_events(event_id,request_id,kind,action_key,payload_json,created_at_ms) VALUES(?,?,'progress',NULL,?,?)").run(randomUUID(),requestId,JSON.stringify({text}),clock);
  const stalledAt=(id:string)=>(db.query('SELECT stalled_at_ms FROM session_communication_requests WHERE request_id=?').get(id) as {stalled_at_ms:number|null}).stalled_at_ms;

  // Waiting on an agent that is itself idle is stuck at once: no hour to wait. Wakes are spaced, answered or not, and stop after three.
  const waiting=standing(waitingId);
  assert.equal(waiting.state,'waiting');assert.match(waiting.text,/^Waiting on .* · no word from it$/);
  assert.equal(waiting.holder.sessionId,`concierge:${a.id}`);assert.deepEqual(waiting.movedFrom,[]);
  assert.doesNotMatch(waiting.text,/\d\d:\d\d/,'times travel in since/until, not in the words');
  await tick(0);assert.deepEqual(quietInputs(waitingId),[`request-quiet:${waitingId}:1`],'woken at once: what it waits on is stuck');
  const marked=db.query('SELECT quiet_reminded_at_ms AS at FROM session_communication_requests WHERE request_id=?').get(waitingId) as {at:number};
  assert.equal(marked.at,clock);assert.equal(standing(waitingId).remindedAt,new Date(clock).toISOString());
  assert.equal((db.query("SELECT session_id FROM session_inputs WHERE id=?").get(`request-quiet:${waitingId}:1`) as {session_id:number}).session_id,a.id,'the holder received the wake');
  endTurns(a.id);progress(waitingId); // the holder answers each wake with a waiting partial
  await tick(5*60_000);assert.equal(quietInputs(waitingId).length,1,'not again within 15 minutes');
  await tick(11*60_000);assert.equal(quietInputs(waitingId).length,2,'a second after the spacing');
  endTurns(a.id);progress(waitingId);
  await tick(16*60_000);assert.equal(quietInputs(waitingId).length,3);
  endTurns(a.id);progress(waitingId);assert.equal(stalledAt(waitingId),null);
  await tick(16*60_000);
  assert.equal(quietInputs(waitingId).length,3,'no fourth wake: three answered by a partial still stall');
  assert.equal(standing(waitingId).state,'stalled');assert.match(standing(waitingId).text,/no word after three hourly reminders/);

  // A holder with nothing it waits on keeps the hour.
  assert.deepEqual(quietInputs(quietId),[],'under an hour');
  await tick(14*60_000);
  assert.deepEqual(quietInputs(quietId),[`request-quiet:${quietId}:1`],'one wake after an hour');
  endTurns(h.id);

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
  assert.equal(both.kind,'worker_working');assert.equal(both.text,'1 held · 1 working');
  assert.deepEqual(both.workers.map(worker=>worker.requestId).sort(),[heldId,workingId].sort(),'one entry per request, working and waiting together');
  assert.equal(both.workers.find(worker=>worker.requestId===heldId)!.standing!.state,'held');
  assert.equal(both.workers.find(worker=>worker.requestId===workingId)!.standing!.state,'working');

  // The quiet request, answered by a partial after every wake, also stops after three; no wake is counted as a continuation.
  endTurns(h.id);progress(quietId);
  await tick(61*60_000);endTurns(h.id);progress(quietId);
  assert.ok(quietInputs(quietId).length>=3);
  await tick(61*60_000);
  assert.ok(stalledAt(quietId)!==null,'three wakes answered by a partial stall the next time round');

  // Seeing the request work for real starts the count again; the wake's own turn does not.
  await tick(61*60_000);endTurns(j.id);assert.equal(quietInputs(resetId).length,1);
  await tick(61*60_000);endTurns(j.id);assert.equal(quietInputs(resetId).length,2);
  const streakOf=()=>db.query('SELECT quiet_streak_count AS count FROM session_communication_requests WHERE request_id=?').get(resetId) as {count:number};
  assert.equal(streakOf().count,2);
  db.query("UPDATE turns SET status='running' WHERE id=(SELECT i.turn_id FROM session_inputs i JOIN session_communication_requests r ON r.target_input_id=i.id WHERE r.request_id=?)").run(resetId);
  await tick(61*60_000);
  assert.equal(streakOf().count,0,'the holder was seen working on it: the count starts again');
  endTurns(j.id);await tick(61*60_000);
  assert.equal(streakOf().count,1);assert.equal(stalledAt(resetId),null);

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
  assert.equal(value.kind,'worker_waiting');assert.equal(value.text,'1 stopped · 1 held','mixed states are counted, stopped first');
  const three=workerWork([],openRequestStandings(db,[{state:'open',dispatches:[{requestId:workingId},{requestId:heldId},{requestId:chainId}]}],clock))!;
  assert.equal(three.kind,'worker_working');assert.equal(three.text,'1 stopped · 1 held · 1 working','a stopped request is not hidden behind a working one');
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
