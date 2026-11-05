import {afterEach,beforeEach,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {acquireDatabaseTestLock} from './db-lock';
import {db,claimNextQueuedTurn,markTurnProviderAdmissionIntended,requeueOrphanedPreAdmissionTurn,
  requeueWithdrawnRunnerTurn} from '../src/state';
import {createNativeSession,enqueueSessionInput,retainSessionInput} from '../src/session-inputs';
import {retainExecutionIntent} from '../src/executions';
import {beginRunnerTurnDrain,RunnerHostAccess,turnJobId} from '../src/runner-host-access';
import {runnerLedger} from '../src/runner-ledger';
import {HostNotStartedError} from '../src/execution-host-client';
import {CLAUDE_ALLOWANCE_HOLD_UNTIL_MS} from '../src/claude-allowance-hold';

const claimTime=()=>Math.max(Date.now(),CLAUDE_ALLOWANCE_HOLD_UNTIL_MS+1);

let unlock:()=>void;
beforeEach(async()=>{unlock=await acquireDatabaseTestLock();});
afterEach(()=>{
  for(const table of ['runner_events','runner_commands','runner_attempts','runner_jobs','executions',
    'session_owner_events','session_inputs','turn_steering_messages','turn_delivery_chunks','turns','sessions'])
    db.query(`DELETE FROM ${table}`).run();
  unlock();
});

function turn(provider:'claude-code'|'codex',owner:string) {
  const session=createNativeSession(provider,{summary:'Test runner drain custody'});
  const accepted=retainSessionInput({sessionId:session.id,scope:'runner-drain-test',actionId:randomUUID(),
    kind:'input',origin:'human',payload:{text:'Keep this exact request'}}).input;
  enqueueSessionInput(accepted.id);
  const claim=claimNextQueuedTurn(owner,claimTime())!;
  expect(claim?.accepted_input_id).toBe(accepted.id);
  return claim;
}

function runnerIntent(claim:ReturnType<typeof turn>,owner:string) {
  const executionId=randomUUID();
  expect(markTurnProviderAdmissionIntended(claim.turn_id,owner,claim.dispatch_attempt)).toBe(true);
  retainExecutionIntent({executionId,turnId:claim.turn_id,dispatchAttempt:claim.dispatch_attempt,
    sessionId:claim.session_id,provider:'claude-code',directory:'',processor:{},coordinatorInstanceId:owner,
    supervisor:'runner'});
  runnerLedger().enqueue({jobId:turnJobId(executionId),kind:'turn',payload:{executionId},replaySafe:false});
  return executionId;
}

test('drain withdraws unclaimed runner launches and returns their exact turns unsent; claimed custody stays',async()=>{
  const owner='runner-drain-owner';
  const queued=turn('claude-code',owner),queuedExecution=runnerIntent(queued,owner);
  const claimed=turn('claude-code',owner),claimedExecution=runnerIntent(claimed,owner);
  expect(runnerLedger().claim('ax41',['turn'])?.jobId).toBe(turnJobId(queuedExecution));
  // The first job is claimed. A later queued one is the only withdrawal candidate.
  expect(beginRunnerTurnDrain(owner)).toBe(1);
  expect(runnerLedger().job(turnJobId(claimedExecution),10)?.result).toEqual({withdrawn:'owner drained before a runner claimed the turn'});
  expect(runnerLedger().job(turnJobId(queuedExecution),10)?.state).toBe('leased');
  expect(requeueWithdrawnRunnerTurn(queued.turn_id,owner,queued.dispatch_attempt)).toBe(false);
  const access=new RunnerHostAccess(claimedExecution,owner);
  await expect(access.launch({executable:'claude',args:[],cwd:'/tmp',environment:{},
    inheritEnvironment:true,initialInput:'Keep this exact request'})).rejects.toBeInstanceOf(HostNotStartedError);
  expect(requeueWithdrawnRunnerTurn(claimed.turn_id,owner,claimed.dispatch_attempt)).toBe(true);
  expect(db.query('SELECT status,owner_instance_id,provider_admission_intended_at FROM turns WHERE id=?')
    .get(claimed.turn_id)).toEqual({status:'queued',owner_instance_id:null,provider_admission_intended_at:null});
  expect(db.query('SELECT state FROM executions WHERE execution_id=?').get(claimedExecution)).toEqual({state:'lost'});
  expect(claimNextQueuedTurn('next-owner',claimTime())?.turn_id).toBe(claimed.turn_id);
  expect(db.query('SELECT status FROM turns WHERE id=?').get(queued.turn_id)).toEqual({status:'running'});
  // A launch that resumes after the first drain sweep must withdraw its own new job.
  const late=turn('claude-code',owner);
  const lateExecution=randomUUID();
  expect(markTurnProviderAdmissionIntended(late.turn_id,owner,late.dispatch_attempt)).toBe(true);
  retainExecutionIntent({executionId:lateExecution,turnId:late.turn_id,dispatchAttempt:late.dispatch_attempt,
    sessionId:late.session_id,provider:'claude-code',directory:'',processor:{},coordinatorInstanceId:owner,
    supervisor:'runner'});
  await expect(new RunnerHostAccess(lateExecution,owner).launch({executable:'claude',args:[],cwd:'/tmp',
    environment:{},inheritEnvironment:true,initialInput:'Keep this exact request'}))
    .rejects.toBeInstanceOf(HostNotStartedError);
  expect(runnerLedger().job(turnJobId(lateExecution))?.result).toEqual({withdrawn:'owner drained before a runner claimed the turn'});
  expect(requeueWithdrawnRunnerTurn(late.turn_id,owner,late.dispatch_attempt)).toBe(true);
});

test('Codex readiness drain requeues only before admission intent',()=>{
  const claim=turn('codex','codex-waiting-owner');
  expect(db.query('SELECT 1 FROM executions WHERE turn_id=?').get(claim.turn_id)).toBeNull();
  expect(requeueOrphanedPreAdmissionTurn(claim.turn_id,'codex-waiting-owner')).toBe(true);
  expect(claimNextQueuedTurn('next-owner',claimTime())?.turn_id).toBe(claim.turn_id);
  const intended=turn('codex','codex-intended-owner');
  expect(markTurnProviderAdmissionIntended(intended.turn_id,'codex-intended-owner',intended.dispatch_attempt)).toBe(true);
  expect(requeueOrphanedPreAdmissionTurn(intended.turn_id,'codex-intended-owner')).toBe(false);
});

test('ordinary runner claim timeout does not take the owner-drain requeue path',()=>{
  const owner='runner-claim-timeout-owner';
  const claim=turn('claude-code',owner),executionId=runnerIntent(claim,owner);
  expect(runnerLedger().withdraw(turnJobId(executionId),'no runner claimed the turn in time')).toBe(true);
  expect(requeueWithdrawnRunnerTurn(claim.turn_id,owner,claim.dispatch_attempt)).toBe(false);
  expect(db.query('SELECT status FROM turns WHERE id=?').get(claim.turn_id)).toEqual({status:'running'});
});
