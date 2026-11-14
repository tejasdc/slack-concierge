import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'concierge-continuation-inspection-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION;
const [{db},{createNativeSession,retainSessionInput,enqueueSessionInput,nativeRunId,recordSessionEvent},
  {inspectCodexRecovery},{SessionCommunicationCoordinator},{parseRouterSessionsArgs}]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/codex-recovery-inspection'),
  import('../src/session-communication'),import('./router-sessions')]);
try {
  const target=createNativeSession('codex',{title:'retained writing',purpose:'continue accepted work',origin:'native',
    model:'gpt-6-astra',reasoningEffort:'medium',providerRunner:null});
  db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run('retained-native-thread',target.id);
  const create=retainSessionInput({id:'request:create-legacy',sessionId:target.id,scope:'fixture',actionId:'create',kind:'create',origin:'agent',
    payload:{provider:'codex',model:'gpt-6-astra',reasoningEffort:'medium',project:'/fixture/writing',firstInput:{text:'original words'}}}).input;
  const createTurn=enqueueSessionInput(create.id).turn_id!;
  const admission=(id:string,turnId:number)=>({provider:'codex',inputId:id,runId:nativeRunId(turnId),bindingGeneration:1,
    model:'gpt-6-astra',nativeBinding:null});
  db.query("UPDATE turns SET status='done',provider_input_acknowledged_at=CURRENT_TIMESTAMP WHERE id=?").run(createTurn);
  db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({admission:admission(create.id,createTurn)}),create.id);
  const requestId='selected-work';
  const source=retainSessionInput({id:`request:${requestId}`,sessionId:target.id,scope:'fixture',actionId:'source',kind:'request',origin:'agent',
    requestId,payload:{text:'continue four retained obligations; do not infer transfers'}}).input;
  const sourceTurn=enqueueSessionInput(source.id).turn_id!,sourceRun=nativeRunId(sourceTurn);
  db.query("UPDATE turns SET status='done',provider_input_acknowledged_at=CURRENT_TIMESTAMP WHERE id=?").run(sourceTurn);
  const report=retainSessionInput({id:`report-back:${requestId}`,sessionId:target.id,scope:'fixture',actionId:'report',kind:'request',origin:'service',
    requestId,sourceInputId:source.id,sourceRunId:sourceRun,payload:{text:'exact retained reminder',attachments:['retained-attachment']}}).input;
  const turnId=enqueueSessionInput(report.id).turn_id!;
  db.query("UPDATE turns SET status='done',dispatch_attempt=1,reasoning_effort='medium',provider_turn_id='native-empty' WHERE id=?").run(turnId);
  db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({admission:admission(report.id,turnId)}),report.id);
  recordSessionEvent({eventId:`prompt-cache-identity:${turnId}:1`,sessionId:target.id,turnId,kind:'prompt_cache_identity',payload:{effort:'medium'}});
  db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,
    source_root_ts,action_id,target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms,
    source_input_id,target_input_id,status,outcome) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(requestId,'fixture','source',sourceTurn,target.id,'root','work',target.id,'fixture','root',
      JSON.stringify({requestedEffect:'work'}),'hash',0,0,source.id,source.id,'admitted',null);
  const late=retainSessionInput({id:'request:closed-info',sessionId:target.id,scope:'fixture',actionId:'info',kind:'request',origin:'agent',
    payload:{text:'later informational input'}}).input;
  db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({state:'failed'}),late.id);
  // A held accepted input has no turn; every inspection must include it in its interval.
  assert.equal(late.turn_id,null);
  const inspect=()=>inspectCodexRecovery({sessionId:target.id,inputId:report.id,requestId});
  const retained=()=>JSON.stringify({inputs:db.query('SELECT * FROM session_inputs ORDER BY rowid').all(),
    turns:db.query('SELECT * FROM turns ORDER BY id').all(),requests:db.query('SELECT * FROM session_communication_requests').all(),
    events:db.query('SELECT * FROM session_owner_events ORDER BY sequence').all(),reservations:db.query('SELECT * FROM codex_unacknowledged_recoveries').all()});
  const before=retained(),first=inspect();
  assert.equal(retained(),before,'inspection writes no input, result, request, reservation or audit event');
  assert.equal(first.continuation.creationModelEffortMatches,true,'legacy omitted admission effort uses exact create shape');
  assert.equal(first.binding.effort,'medium');
  assert.equal(first.continuation.authorized,false);
  assert.equal(first.eligible,false,'owner witnesses alone never authorize native execution');
  assert.deepEqual(first.reasons.map(reason=>reason.code),['NATIVE_INTERVAL_NOT_PROVEN','NATIVE_ACTIVITY_BOUNDARY_NOT_FENCED',
    'LEGACY_NATIVE_ISSUED_SEND_DRAIN_UNPROVEN','COLD_RESUME_HOOK_CONFIGURATION_UNPROVEN',
    'NATIVE_ORIGINAL_EFFECT_HISTORY_COVERAGE_UNPROVEN']);
  assert.equal(first.interval.acceptedWithoutTurnCount,1);
  assert.equal(inspect().interval.digest,first.interval.digest,'unchanged snapshot has a stable digest');
  retainSessionInput({sessionId:target.id,scope:'fixture',actionId:'control',kind:'action',origin:'human',payload:{action:'pause'}});
  assert.notEqual(inspect().interval.digest,first.interval.digest,'accepted control without admission changes the interval');
  assert.ok(inspect().interval.acceptedWatermark>first.interval.acceptedWatermark);
  db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({admission:{...admission(report.id,turnId),reasoningEffort:'xhigh'}}),report.id);
  assert.ok(inspect().reasons.some(reason=>reason.code==='SELECTED_MODEL_EFFORT_NOT_PROVEN'),'conflicting receipt effort refuses');
  db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({admission:admission(report.id,turnId)}),report.id);
  db.query('UPDATE turns SET provider_input_acknowledged_at=NULL WHERE id=?').run(sourceTurn);
  assert.ok(inspect().reasons.some(reason=>reason.code==='ACKNOWLEDGED_SOURCE_CUSTODY_NOT_PROVEN'));
  db.query('UPDATE turns SET provider_input_acknowledged_at=CURRENT_TIMESTAMP WHERE id=?').run(sourceTurn);
  db.query("UPDATE turns SET status='running',dispatch_attempt=2 WHERE id=?").run(turnId);
  const coordinator=new SessionCommunicationCoordinator({owner:{} as any,isOwnerAlive:()=>true,onError:error=>{throw error;}} as any);
  const refused=coordinator.modelStartGate({providerSessionId:'retained-native-thread',providerTurnId:'native-empty',model:'gpt-6-astra'});
  assert.equal(refused.allowed,false,'diagnostic continuation candidate cannot bypass the actual guard');
  const guard=db.query("SELECT payload_json FROM session_owner_events WHERE kind='model_start_guard' ORDER BY sequence DESC LIMIT 1").get() as any;
  const evidence=JSON.parse(guard.payload_json);
  assert.equal(evidence.allowed,false);assert.equal(evidence.inputId,report.id);
  assert.equal(evidence.runId,nativeRunId(turnId));assert.equal(evidence.dispatchAttempt,2);
  assert.equal(evidence.requestedEffort,'medium');assert.equal(evidence.effectiveEffort,null);
  assert.equal(evidence.basis,'existing_model_start_policy');
  assert.ok(!guard.payload_json.includes('exact retained reminder'),'audit retains identities without prompt text');
  db.query('UPDATE turns SET status=? WHERE id=?').run('done',turnId);
  const mismatch=coordinator.modelStartGate({providerSessionId:'retained-native-thread',model:'other-model'});
  assert.equal(mismatch.allowed,false,'conflicting model still refuses');
  const ordinary=createNativeSession('codex',{title:'ordinary guard',purpose:'audit existing allow',origin:'native',model:'gpt-6-luna',reasoningEffort:'medium'});
  db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run('ordinary-thread',ordinary.id);
  const ordinaryInput=retainSessionInput({sessionId:ordinary.id,scope:'fixture',actionId:'ordinary',kind:'input',origin:'human',payload:{text:'private ordinary words'}}).input;
  const ordinaryTurn=enqueueSessionInput(ordinaryInput.id).turn_id!;
  db.query("UPDATE turns SET status='running',dispatch_attempt=1,reasoning_effort=NULL WHERE id=?").run(ordinaryTurn);
  assert.equal(coordinator.modelStartGate({providerSessionId:'ordinary-thread',providerTurnId:'ordinary-native',model:'gpt-6-luna'}).allowed,true);
  const allowEvidence=JSON.parse((db.query("SELECT payload_json FROM session_owner_events WHERE kind='model_start_guard' ORDER BY sequence DESC LIMIT 1").get() as any).payload_json);
  assert.equal(allowEvidence.allowed,true);assert.equal(allowEvidence.effectiveEffort,null,'missing actual effort is not guessed from session metadata');
  assert.equal(allowEvidence.bindingEffort,'medium');assert.equal(allowEvidence.effortEvidence,'not_observed_by_hook');
  db.exec("CREATE TEMP TRIGGER fail_model_start_audit BEFORE INSERT ON session_owner_events WHEN NEW.kind='model_start_guard' BEGIN SELECT RAISE(ABORT,'fixture audit unavailable'); END");
  const noAudit=coordinator.modelStartGate({providerSessionId:'ordinary-thread',providerTurnId:'ordinary-native',model:'gpt-6-luna'});
  assert.equal(noAudit.allowed,false,'failure to retain owned decision cannot silently allow a provider start');
  assert.match(noAudit.message??'',/could not retain/);
  db.exec('DROP TRIGGER fail_model_start_audit');
  const command=parseRouterSessionsArgs(['codex-recover',requestId,'--inspect','--source-input',source.id,'--source-run',sourceRun,'--action-id','inspect']);
  assert.equal(command.operation,'codex-recover');
  if(command.operation==='codex-recover')assert.equal(command.body.inspect,true);
  assert.throws(()=>parseRouterSessionsArgs(['codex-recover',requestId,'--inspect','--inspect']));
  assert.equal(db.query('SELECT COUNT(*) AS count FROM codex_unacknowledged_recoveries').get().count,0);
  console.log('Codex continuation inspection: legacy Medium witnesses, held/control interval, immutable custody, refusal and owned guard audit passed');
} finally {db.close();rmSync(scratch,{recursive:true,force:true});}
