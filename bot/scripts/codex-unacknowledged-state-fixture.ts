import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'concierge-codex-recovery-state-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION;
const [{db,getSessionById},{createNativeSession,retainSessionInput,enqueueSessionInput,nativeRunId,recordSessionEvent},
  {reserveCodexUnacknowledgedRecovery,codexUnacknowledgedRecovery},{nativeResultEventId},{readRetainedNativeResult}]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/state'),import('../src/native-result-identity'),import('../src/turn-recovery')]);
try{
  const session=createNativeSession('codex',{title:'recovery fixture',summary:undefined,purpose:'verify exact recovery',origin:'native',
    providerRunner:null,model:'gpt-6-astra'});
  db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run('thread-exact',session.id);
  const requestId='open-work-request';
  const original=retainSessionInput({id:`request:${requestId}`,sessionId:session.id,scope:'fixture',actionId:'original',
    kind:'request',origin:'agent',payload:{text:'original work'}}).input;
  enqueueSessionInput(original.id);
  const originalTurn=Number((db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(original.id) as any).turn_id);
  db.query("UPDATE turns SET status='done',provider_input_acknowledged_at=CURRENT_TIMESTAMP,provider_turn_id='prior-work' WHERE id=?").run(originalTurn);
  const report=retainSessionInput({id:`report-back:${requestId}`,sessionId:session.id,scope:'fixture',actionId:'report-back',
    kind:'request',origin:'service',requestId,sourceInputId:original.id,sourceRunId:nativeRunId(originalTurn),payload:{text:'report result'}}).input;
  enqueueSessionInput(report.id);
  const reportTurn=Number((db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(report.id) as any).turn_id),runId=nativeRunId(reportTurn);
  db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({state:'completed',admission:{provider:'codex',inputId:report.id,
    runId,bindingGeneration:session.binding_generation,model:'gpt-6-astra'}}),report.id);
  db.query(`UPDATE turns SET status='done',dispatch_attempt=1,dispatch_failure_class=NULL,agent_text='',
    provider_admission_intended_at=CURRENT_TIMESTAMP,provider_started_at=CURRENT_TIMESTAMP,provider_turn_id='native-one',
    provider_input_acknowledged_at=NULL,outbound_text=NULL,ended_at=CURRENT_TIMESTAMP WHERE id=?`).run(reportTurn);
  db.query('UPDATE sessions SET status=? WHERE id=?').run('idle',session.id);
  recordSessionEvent({eventId:`attention:${report.id}:1`,sessionId:session.id,inputId:report.id,turnId:reportTurn,kind:'attention',payload:{dispatchAttempt:1}});
  recordSessionEvent({eventId:`prompt-cache-identity:${reportTurn}:1`,sessionId:session.id,turnId:reportTurn,
    kind:'prompt_cache_identity',payload:{effort:'xhigh'}});
  const historicalResult={inputId:report.id,sessionId:session.id,turnId:reportTurn,runId,sessionUUID:'thread-exact',
    providerTurnId:'native-one',model:'gpt-6-astra',text:'',toolsUsed:[],dispatchAttempt:1};
  const {inputId:_inputId,sessionId:_sessionId,turnId:_turnId,runId:_runId,dispatchAttempt:_dispatchAttempt,...providerResult}=historicalResult;
  db.query('UPDATE turns SET outbound_text=? WHERE id=?').run(JSON.stringify({version:1,result:providerResult}),reportTurn);
  assert.equal(readRetainedNativeResult(db.query('SELECT id,session_id,agent_text,outbound_text FROM turns WHERE id=?').get(reportTurn) as any).text,'',
    'before reservation, restart reconciliation would consume the historical empty envelope');
  recordSessionEvent({eventId:nativeResultEventId(reportTurn,1),sessionId:session.id,inputId:report.id,turnId:reportTurn,
    kind:'result',payload:historicalResult});
  db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,
    source_root_ts,action_id,target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms,
    source_input_id,target_input_id,status,outcome) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(requestId,'fixture','message',originalTurn,session.id,'root','request-action',session.id,'fixture','root',
      JSON.stringify({requestedEffect:'work'}),'hash',0,0,original.id,original.id,'admitted',null);
  const evidence={threadId:'thread-exact',ownerRunId:runId,attempts:[
    {dispatchAttempt:1,providerTurnId:'native-one',status:'completed',itemCount:0}],unmappedEmptyTurns:0};
  const reservation={sessionId:session.id,inputId:report.id,turnId:reportTurn,requestId,providerThreadId:'thread-exact',
    bindingGeneration:session.binding_generation,proof:evidence,actionId:'first-action',sourceInputId:original.id,sourceRunId:runId,nowMs:1000};
  db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({state:'completed',admission:{provider:'codex',inputId:report.id,
    runId,bindingGeneration:session.binding_generation,model:'gpt-6-astra',reasoningEffort:'high'}}),report.id);
  assert.equal(reserveCodexUnacknowledgedRecovery(reservation),false,'a conflicting explicit admission effort cannot be overridden by prompt evidence');
  db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({state:'completed',admission:{provider:'codex',inputId:report.id,
    runId,bindingGeneration:session.binding_generation,model:'gpt-6-astra'}}),report.id);
  assert.equal(reserveCodexUnacknowledgedRecovery(reservation),true,'valid report-back gets one atomic reservation and queue transition');
  const saved=codexUnacknowledgedRecovery(report.id)!;
  assert.equal(saved.request_id,requestId);
  assert.equal(JSON.parse(saved.proof_json).attempts.length,1,'all historical attempt evidence remains durable');
  const queued=db.query('SELECT status,provider_turn_id,provider_input_acknowledged_at,reasoning_effort,outbound_text FROM turns WHERE id=?').get(reportTurn) as any;
  assert.deepEqual(queued,{status:'queued',provider_turn_id:null,provider_input_acknowledged_at:null,reasoning_effort:'xhigh',outbound_text:null},
    'recovery restores prompt-proven effort and clears the prior attempt delivery envelope before a new attempt');
  assert.throws(()=>readRetainedNativeResult(db.query('SELECT id,session_id,agent_text,outbound_text FROM turns WHERE id=?').get(reportTurn) as any),
    /no retained result envelope/,'after reservation, restart reconciliation cannot consume the historical empty envelope');
  const oldResult=db.query('SELECT event_id,payload_json FROM session_owner_events WHERE event_id=?').get(`result:${reportTurn}`) as any;
  assert.equal(JSON.parse(oldResult.payload_json).text,'','historical empty result identity and payload remain untouched');
  const {claimNextQueuedTurn,markTurnProviderAdmissionIntended,retryRunningTurnAfterProviderFailure,codexRecoveryAttemptBudgetSpent}=await import('../src/state');
  const recoveryClaim=claimNextQueuedTurn('budget-owner');
  assert.equal(recoveryClaim?.turn_id,reportTurn,'the ordinary queue claims the exact retained report-back');
  assert.equal(recoveryClaim?.dispatch_attempt,2);
  assert.equal(markTurnProviderAdmissionIntended(reportTurn,'budget-owner',2),true,'one additional admission consumes the durable reservation');
  assert.equal(codexUnacknowledgedRecovery(report.id)!.additional_dispatch_attempt,2);
  assert.equal(codexUnacknowledgedRecovery(report.id)!.proof_json,saved.proof_json,'consuming the attempt preserves the original proof bytes');
  const reopened=spawnSync(process.execPath,['-e',`const {db,codexRecoveryAttemptBudgetSpent}=await import(${JSON.stringify(join(import.meta.dir,'../src/state.ts'))});
    if(!codexRecoveryAttemptBudgetSpent(${reportTurn}))process.exit(2);db.close();process.exit(0);`],{env:process.env,encoding:'utf8'});
  assert.equal(reopened.status,0,`a fresh process retains the spent budget: ${reopened.stderr}`);
  assert.equal(codexRecoveryAttemptBudgetSpent(reportTurn),true);
  assert.equal(markTurnProviderAdmissionIntended(reportTurn,'budget-owner',2),false,'same-attempt relaunch cannot reuse consumed admission');
  assert.equal(retryRunningTurnAfterProviderFailure({turnId:reportTurn,ownerInstanceId:'budget-owner',dispatchAttempt:2,
    error:'retryable but recovery is spent',nextAttemptMs:4000}),false,'ordinary retry cannot spend another native attempt');
  db.query("UPDATE turns SET status='running',provider_admission_intended_at=NULL,dispatch_attempt=3 WHERE id=?").run(reportTurn);
  assert.equal(markTurnProviderAdmissionIntended(reportTurn,'budget-owner',3),false,'even a forced new claim cannot submit again');
  db.query("UPDATE turns SET status='done',owner_instance_id=NULL WHERE id=?").run(reportTurn);
  const secondResult={...historicalResult,providerTurnId:'native-recovery',text:'Recovered useful answer',dispatchAttempt:2};
  recordSessionEvent({eventId:nativeResultEventId(reportTurn,2),sessionId:session.id,inputId:report.id,turnId:reportTurn,
    kind:'result',payload:secondResult});
  const latest=db.query("SELECT event_id,payload_json FROM session_owner_events WHERE turn_id=? AND kind='result' ORDER BY sequence DESC LIMIT 1")
    .get(reportTurn) as any;
  assert.equal(latest.event_id,`result:${reportTurn}:attempt:2`,'recovery attempt retains a distinct result identity');
  assert.equal(JSON.parse(latest.payload_json).text,'Recovered useful answer','result readers can select the later useful answer');
  db.query('UPDATE codex_unacknowledged_recoveries SET additional_dispatch_attempt=NULL WHERE accepted_input_id=?').run(report.id);
  assert.equal(codexRecoveryAttemptBudgetSpent(reportTurn),true,'legacy reservation with later immutable result cannot gain a fresh budget');
  assert.equal(reserveCodexUnacknowledgedRecovery({...reservation,actionId:'different-action',nowMs:2000}),false,
    'a different action ID cannot reserve the same accepted input twice');
  assert.equal(codexUnacknowledgedRecovery(report.id)!.action_id,'first-action');

  const parkedSession=createNativeSession('codex',{title:'parked Astra work',summary:undefined,purpose:'verify parked recovery',origin:'native',
    providerRunner:null,model:'gpt-6-astra'});
  db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run('thread-parked',parkedSession.id);
  const parkedRequestId='parked-work-request';
  const parkedOriginal=retainSessionInput({id:'parked-human-work',sessionId:parkedSession.id,scope:'fixture',actionId:'parked-original',
    kind:'request',origin:'human',payload:{text:'Do the parked work'}}).input;
  enqueueSessionInput(parkedOriginal.id);
  const parkedOriginalTurn=Number((db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(parkedOriginal.id) as any).turn_id);
  const parkedSourceRun=nativeRunId(parkedOriginalTurn);
  db.query("UPDATE turns SET status='done',provider_input_acknowledged_at=CURRENT_TIMESTAMP,provider_turn_id='parked-parent' WHERE id=?")
    .run(parkedOriginalTurn);
  const parkedReport=retainSessionInput({id:`report-back:${parkedRequestId}`,sessionId:parkedSession.id,scope:'fixture',actionId:'parked-report',
    kind:'request',origin:'service',requestId:parkedRequestId,sourceInputId:parkedOriginal.id,sourceRunId:parkedSourceRun,
    payload:{text:'continue parked report'}}).input;
  enqueueSessionInput(parkedReport.id);
  const parkedTurn=Number((db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(parkedReport.id) as any).turn_id);
  const parkedRun=nativeRunId(parkedTurn);
  const parkedAdmission=(effort?:string)=>({state:'completed',admission:{provider:'codex',inputId:parkedReport.id,
    runId:parkedRun,bindingGeneration:parkedSession.binding_generation,model:'gpt-6-astra',...(effort?{reasoningEffort:effort}:{})}});
  db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify(parkedAdmission()),parkedReport.id);
  db.query(`UPDATE turns SET status='parked',dispatch_failure_class='parked_terminal',dispatch_attempt=1,
    provider_admission_intended_at=CURRENT_TIMESTAMP,provider_started_at=CURRENT_TIMESTAMP,provider_turn_id='native-parked',
    provider_input_acknowledged_at=NULL,agent_text='CODEX_INPUT_NOT_ACKNOWLEDGED: blocked before acknowledgement',outbound_text=NULL,
    ended_at=CURRENT_TIMESTAMP WHERE id=?`).run(parkedTurn);
  db.query("UPDATE sessions SET status='idle' WHERE id=?").run(parkedSession.id);
  recordSessionEvent({eventId:`prompt-cache-identity:${parkedTurn}:1`,sessionId:parkedSession.id,turnId:parkedTurn,
    kind:'prompt_cache_identity',payload:{effort:'xhigh'}});
  recordSessionEvent({eventId:`provider-turn-attempt:${parkedTurn}:1`,sessionId:parkedSession.id,inputId:parkedReport.id,turnId:parkedTurn,
    kind:'provider_turn_attempt',payload:{provider:'codex',providerTurnId:'native-parked',dispatchAttempt:1}});
  db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,
    source_root_ts,action_id,target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms,
    source_input_id,target_input_id,status,outcome) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(parkedRequestId,'fixture','parked-message',parkedOriginalTurn,parkedSession.id,'root','parked-request-action',parkedSession.id,
      'fixture','root',JSON.stringify({requestedEffect:'work'}),'parked-hash',0,0,parkedOriginal.id,parkedOriginal.id,'admitted',null);
  const parkedReservation={sessionId:parkedSession.id,inputId:parkedReport.id,turnId:parkedTurn,requestId:parkedRequestId,
    providerThreadId:'thread-parked',bindingGeneration:parkedSession.binding_generation,proof:evidence,actionId:'parked-action',
    sourceInputId:parkedOriginal.id,sourceRunId:parkedSourceRun,nowMs:3000};
  db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify(parkedAdmission('high')),parkedReport.id);
  assert.equal(reserveCodexUnacknowledgedRecovery(parkedReservation),false,
    'a newly parked turn also refuses an explicitly conflicting effort despite prompt identity evidence');
  db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify(parkedAdmission()),parkedReport.id);
  assert.equal(reserveCodexUnacknowledgedRecovery(parkedReservation),true,
    'a newly parked turn with omitted admission effort is eligible when its exact attempt prompt identity proves xhigh');
  assert.equal(getSessionById(session.id)?.provider_id,'codex');
  console.log('Codex unacknowledged recovery state: legacy/parked effort evidence, stale-envelope clearing, preserved result, and deduplication passed');
}finally{db.close();rmSync(scratch,{recursive:true,force:true});}
