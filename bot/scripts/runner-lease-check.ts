/** Proof of the runner lease engine's invariants (docs/architecture/RUNNERS.md) on a scratch ledger. */
import {strict as assert} from 'node:assert';
import {Database} from 'bun:sqlite';
import {initializeRunnerSchema,RunnerLeases,LEASE_MS} from '../src/runner-leases';
import {lastLaunchedConversationHome} from '../src/session-runner-home';

const db=new Database(':memory:');
initializeRunnerSchema(db);initializeRunnerSchema(db);
let now=1_000_000;
const leases=new RunnerLeases(db,()=>now);
const code=(run:()=>unknown)=>{try{run();}catch(error){return (error as any).code;}return null;};

// A turn job (not replay safe) and a build job (replay safe).
assert.equal(leases.enqueue({jobId:'turn-1',kind:'turn',payload:{t:1}}).created,true);
assert.equal(leases.enqueue({jobId:'turn-1',kind:'turn',payload:{t:2}}).created,false,'The same job id records once.');
leases.enqueue({jobId:'build-1',kind:'build',payload:{},replaySafe:true});
assert.equal(leases.claim('ax41',['other']),null);
const turn=leases.claim('ax41',['turn'])!;
assert.equal(turn.epoch,1);
assert.equal(leases.claim('ax41',['turn']),null,'A leased job is not claimed twice.');
leases.enqueue({jobId:'turn-targeted',kind:'turn',payload:{targetRunner:'ax41'}});
assert.equal(leases.claim('other',['turn']),null,'A different runner cannot claim the bound turn.');
const targeted=leases.claim('ax41',['turn'])!;
assert.equal(targeted.jobId,'turn-targeted');
assert.equal(targeted.payload.targetRunner,'ax41');
leases.finish('ax41',targeted.attemptId,1,'targeted-finish',{ok:true});

// Events: contiguous prefix only, resends store nothing twice, the answer is the durable cursor.
assert.equal(leases.appendEvents('ax41',turn.attemptId,1,[{seq:1,frame:'a'},{seq:2,frame:'b'},{seq:4,frame:'d'}]).ackedSeq,2);
assert.equal(leases.appendEvents('ax41',turn.attemptId,1,[{seq:2,frame:'B'},{seq:3,frame:'c'},{seq:4,frame:'d'}]).ackedSeq,4);
assert.deepEqual(leases.job('turn-1')!.events.map(event=>event.frame),['a','b','c','d']);
assert.deepEqual(leases.job('turn-1',2)!.events.map(event=>event.seq),[3,4]);

// Commands: one per id, handed over on heartbeat until answered; the first result stands.
leases.command('turn-1',{commandId:'stop-1',kind:'signal',body:{signal:'SIGINT'}});
assert.equal(leases.command('turn-1',{commandId:'stop-1',kind:'signal',body:{}}).created,false);
assert.deepEqual(leases.heartbeat('ax41',turn.attemptId,1).commands.map(command=>command.commandId),['stop-1']);
assert.equal(leases.commandResults('ax41',turn.attemptId,1,[{commandId:'stop-1',result:{sent:true}}]).recorded,1);
assert.equal(leases.commandResults('ax41',turn.attemptId,1,[{commandId:'stop-1',result:{sent:false}}]).recorded,0);
assert.deepEqual(leases.heartbeat('ax41',turn.attemptId,1).commands,[]);

// Fencing: a restarted runner reacquires at a new epoch; the old holder and other runners are refused.
const [again]=leases.reacquire('ax41',[turn.attemptId]);
assert.equal(again!.stale,false);assert.equal((again as any).epoch,2);
assert.equal(code(()=>leases.heartbeat('ax41',turn.attemptId,1)),'STALE_EPOCH');
assert.equal(code(()=>leases.appendEvents('ax41',turn.attemptId,1,[{seq:5,frame:'x'}])),'STALE_EPOCH');
assert.equal(code(()=>leases.heartbeat('other',turn.attemptId,2)),'UNKNOWN_ATTEMPT');
assert.equal(leases.reacquire('other',[turn.attemptId])[0]!.stale,true);

// Expiry is computed: a turn whose lease passed is unconfirmed (never replayed); a build is queued again.
const build=leases.claim('ax41',['build'])!;
assert.equal(leases.claim('ax41',['build']),null,'Nothing queued and nothing due answers from a read.');
now+=LEASE_MS+1;
assert.equal(leases.job('turn-1')!.state,'unconfirmed','The job view reports a passed lease before anything records it.');
assert.equal((db.query("SELECT state FROM runner_jobs WHERE job_id='turn-1'").get() as any).state,'leased','The view writes nothing.');
assert.equal(leases.job('build-1')!.state,'queued');
assert.equal(code(()=>leases.heartbeat('ax41',turn.attemptId,2)),'STALE_EPOCH');
assert.equal(leases.reacquire('ax41',[turn.attemptId])[0]!.stale,true,'An expired attempt cannot be taken back.');
assert.equal(code(()=>leases.finish('ax41',build.attemptId,1,'op','late')),'STALE_EPOCH');
const rebuilt=leases.claim('ax41',['build'])!;
assert.notEqual(rebuilt.attemptId,build.attemptId);
leases.appendEvents('ax41',rebuilt.attemptId,1,[{seq:1,frame:'second'}]);
assert.equal(leases.job('build-1',3)!.events.length,0,'A cursor names its attempt.');
assert.deepEqual(leases.job('build-1',0,rebuilt.attemptId)!.events.map(event=>event.frame),['second']);
assert.equal(leases.job('build-1')!.eventsAttemptId,rebuilt.attemptId);

// Finish: once per attempt, a repeat with the same operation answers the first, another operation conflicts.
assert.deepEqual(leases.finish('ax41',rebuilt.attemptId,1,'finish-1',{ok:true}),{finished:true,repeated:false,result:{ok:true}});
assert.deepEqual(leases.finish('ax41',rebuilt.attemptId,1,'finish-1',{ok:false}),{finished:true,repeated:true,result:{ok:true}});
assert.equal(code(()=>leases.finish('ax41',rebuilt.attemptId,1,'finish-2',null)),'CONFLICT');
assert.equal(leases.job('build-1')!.state,'finished');
// Owner restarts: a lease is extended from now only while its runner was heard from within a lease,
// so a dead runner's turn cannot be kept open by restarting the owner again and again.
leases.enqueue({jobId:'turn-2',kind:'turn',payload:{}});
const quiet=leases.claim('ax41',['turn'])!;
const lastHeard=now;
for(let restart=1;restart<=5;restart++){now+=LEASE_MS-60_000;leases.extendLiveLeases();}
assert.equal(leases.job('turn-2')!.state,'unconfirmed','Restarts stop extending a runner silent for a lease.');
assert.ok(now-lastHeard<=5*LEASE_MS);
leases.enqueue({jobId:'turn-3',kind:'turn',payload:{}});
const heard=leases.claim('ax41',['turn'])!;
now+=LEASE_MS-60_000;
leases.heartbeat('ax41',heard.attemptId,1);
now+=LEASE_MS-60_000;
assert.equal(leases.extendLiveLeases(),1,'A runner heard from within the lease keeps its lease across a restart.');
assert.equal(leases.job('turn-3')!.state,'leased');
void quiet;

// An unstarted execution intent cannot replace the last host of a bound conversation.
db.exec('CREATE TABLE executions (execution_id TEXT PRIMARY KEY, session_id INTEGER, provider TEXT, supervisor TEXT, unit TEXT, created_at_ms INTEGER)');
const homeLeases=new RunnerLeases(db,()=>now);
homeLeases.enqueue({jobId:'turn:launched',kind:'turn',payload:{}});
homeLeases.claim('ax41',['turn']);
db.query('INSERT INTO executions VALUES (?,?,?,?,?,?)').run('launched',42,'claude-code','runner','concierge-exec-launched',1);
db.query('INSERT INTO executions VALUES (?,?,?,?,?,?)').run('unclaimed',42,'claude-code','runner',null,2);
assert.deepEqual(lastLaunchedConversationHome(db,42,'claude-code'),{supervisor:'runner',runner:'ax41'});
db.query('INSERT INTO executions VALUES (?,?,?,?,?,?)').run('local',42,'claude-code','systemd','concierge-exec-local',3);
db.query('INSERT INTO executions VALUES (?,?,?,?,?,?)').run('unstarted-runner',42,'claude-code','runner',null,4);
assert.deepEqual(lastLaunchedConversationHome(db,42,'claude-code'),{supervisor:'systemd',runner:null},
  'An unstarted runner intent cannot move a conversation that last ran locally.');
db.query('INSERT INTO executions VALUES (?,?,?,?,?,?)').run('unproven-runner',42,'claude-code','runner','concierge-exec-unproven',5);
assert.deepEqual(lastLaunchedConversationHome(db,42,'claude-code'),{supervisor:'runner',runner:null},
  'A launched runner execution with a missing lease must remain unknown, not fall back to an older host.');

console.log('runner leases: claim, contiguous events, commands, epoch fencing, computed expiry, idempotent finish, bounded restart extension and launched conversation home hold');
