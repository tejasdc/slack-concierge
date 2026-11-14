import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Database} from 'bun:sqlite';
import {IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION} from '../src/test-authorizations';
import {createFixtureOriginalHistory} from './codex-original-history-fixture-helper';
import {fixtureColdConstruction} from './codex-cold-construction-fixture-helper';
import {validateCodexColdResume} from '../src/codex-cold-construction';
const scratch=mkdtempSync(join(tmpdir(),'concierge-recovery-authorization-'));
process.env.CONCIERGE_STATE_DIR=scratch;process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';process.env.CONCIERGE_TEST_AUTHORIZATION=IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION;
const [{db},inputs,{inspectAcceptedBindingContinuation},{proveCodexContinuationNativeInterval},fences,auth,{acceptedBindingSnapshotDigest:digest}]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/codex-accepted-binding-snapshot'),
  import('../src/codex-continuation-native-interval'),import('../src/codex-mutation-fence'),
  import('../src/codex-recovery-dispatch-authorization'),import('../src/codex-accepted-binding-continuation')]);
const {createNativeSession,retainSessionInput,enqueueSessionInput,nativeRunId,recordSessionEvent}=inputs;
fences.initializeCodexMutationFenceSchema(db);auth.initializeCodexRecoveryAuthorizationSchema(db);
let serial=0;
async function seed(options:{retainColdInputs?:boolean}={}){
  const suffix=++serial,session=createNativeSession('codex',{title:'exact retained work',purpose:'recovery fixture',origin:'native',
    model:'gpt-6-astra',reasoningEffort:'medium',providerRunner:null} as any),threadId=`thread:${suffix}`;
  db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run(threadId,session.id);
  const requestId=`work:${suffix}`;
  const save=(id:string,kind:any,origin:any,payload:any,extra:any={})=>retainSessionInput({id,sessionId:session.id,
    scope:'fixture',actionId:id,kind,origin,payload,...extra}).input;
  const create=save(`create:${suffix}`,'create','agent',{provider:'codex',model:'gpt-6-astra',reasoningEffort:'medium',firstInput:{text:'original accepted work'}});
  const createTurn=enqueueSessionInput(create.id).turn_id!;
  const source=save(`request:${requestId}`,'input','agent',{text:'accepted same work'},{requestId});
  const sourceTurn=enqueueSessionInput(source.id).turn_id!;
  const report=save(`report-back:${requestId}`,'input','service',{text:'private retained reminder'},
    {requestId,sourceInputId:source.id,sourceRunId:nativeRunId(sourceTurn)});
  const reportTurn=enqueueSessionInput(report.id).turn_id!;
  for(const [id,turnId] of [[create.id,createTurn],[source.id,sourceTurn],[report.id,reportTurn]] as const){
    const providerResult={text:'',sessionUUID:threadId,toolsUsed:[],providerTurnId:`native:${turnId}:1`,model:'gpt-6-astra',durationMs:5};
    db.query("UPDATE turns SET status='done',dispatch_attempt=1,provider_turn_id=?,outbound_text=? WHERE id=?")
      .run(providerResult.providerTurnId,JSON.stringify({version:1,result:providerResult}),turnId);
    const admission={provider:'codex',inputId:id,runId:nativeRunId(turnId),bindingGeneration:1,model:'gpt-6-astra',nativeBinding:null};
    db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({admission}),id);
    recordSessionEvent({eventId:`result:${turnId}`,sessionId:session.id,inputId:id,turnId,kind:'result',
      payload:{...providerResult,runId:nativeRunId(turnId),turnId,sessionId:session.id,inputId:id}});
    recordSessionEvent({eventId:`attention:${id}:1`,sessionId:session.id,inputId:id,turnId,kind:'attention',payload:{dispatchAttempt:1}});
    recordSessionEvent({eventId:`prompt-cache-identity:${turnId}:1`,sessionId:session.id,turnId,kind:'prompt_cache_identity',payload:{effort:'medium'}});
  }
  db.query('UPDATE turns SET provider_input_acknowledged_at=CURRENT_TIMESTAMP WHERE id IN (?,?)').run(createTurn,sourceTurn);
  db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,
    source_root_ts,action_id,target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms,
    source_input_id,target_input_id,status,outcome) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(requestId,'fixture','source',sourceTurn,session.id,'root',requestId,session.id,'fixture','root',
      JSON.stringify({requestedEffect:'work'}),'hash',0,0,source.id,source.id,'admitted',null);
  const inspection=inspectAcceptedBindingContinuation({sessionId:session.id,inputId:report.id,requestId,includeSnapshot:true});
  assert.equal(inspection.proven,true,JSON.stringify(inspection.reasons));
  assert.ok('snapshot' in inspection&&inspection.snapshot);
  const projectedNative=await proveCodexContinuationNativeInterval({snapshot:inspection.snapshot,client:{async request(method,params){
    return method==='thread/turns/list'?{data:[{id:`native:${reportTurn}:1`,status:'completed',error:null}],nextCursor:null}
      :{data:[],nextCursor:null};
  }}});
  assert.equal(projectedNative.proven,true,JSON.stringify(projectedNative.reasons));
  if(!projectedNative.proven)throw new Error('fixture native proof missing');
  const history=await createFixtureOriginalHistory({root:scratch,binding:inspection.identity.binding,selectedInputId:report.id,nativeProof:projectedNative});
  const native=history.nativeWithOriginalHistory;
  const {snapshot:_private,...continuation}=inspection;
  const proof={attempts:native.attempts.filter(attempt=>attempt.inputId===report.id).map(attempt=>({dispatchAttempt:attempt.dispatchAttempt,providerTurnId:attempt.providerTurnId})),
    dispatchAttemptCount:1,continuation,native};
  const fenceId=`recovery-fence:${suffix}`,runId=nativeRunId(reportTurn);
  const fence=fences.acquireCodexThreadMutationFence(db,{fenceId,threadId,acceptedInputId:report.id,runId,dispatchAttempt:2,
    bindingDigest:digest(inspection.identity.binding),nowMs:1});assert.equal(fence.acquired,true);
  const coldOwner={fenceId,threadId,acceptedInputId:report.id,runId,dispatchAttempt:2,bindingDigest:digest(inspection.identity.binding)};
  const configSecret=`fixture-private-config-${suffix}`;
  const construction=await fixtureColdConstruction({db,owner:coldOwner,binding:inspection.identity.binding,sourcePath:history.sourcePath,configSecret});
  db.query(`INSERT INTO codex_unacknowledged_recoveries(accepted_input_id,request_id,turn_id,provider_thread_id,
    proof_json,action_id,source_input_id,source_run_id,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(report.id,requestId,reportTurn,threadId,JSON.stringify({...proof,coldResume:{construction}}),`reserve:${suffix}`,source.id,nativeRunId(sourceTurn),1);
  db.query("UPDATE turns SET status='queued',provider_turn_id=NULL,outbound_text=NULL,reasoning_effort='medium' WHERE id=?").run(reportTurn);
  const granted=auth.grantCodexRecoveryAuthorization(db,{acceptedInputId:report.id,fenceId,nowMs:2});
  assert.equal(granted.allowed,true,JSON.stringify(granted));if(!granted.allowed||!('authorizationId' in granted))throw new Error('grant missing');
  const authorizationId=granted.authorizationId;
  db.query("UPDATE turns SET status='running',owner_instance_id='fixture-owner',dispatch_attempt=2 WHERE id=?").run(reportTurn);
  db.query('UPDATE session_inputs SET receipt_json=json_set(receipt_json,\'$.state\',\'running\'),updated_at=CURRENT_TIMESTAMP WHERE id=?').run(report.id);
  const claim=auth.claimCodexRecoveryDispatchCapability(db,{authorizationId,turnId:reportTurn,runId,dispatchAttempt:2,nowMs:3});
  assert.equal(claim.allowed,true,JSON.stringify(claim));if(!claim.allowed||!('capability' in claim))throw new Error('claim missing');
  const capability=claim.capability;
  const privatePrompt=`prepared private prompt ${suffix}`,preparedPromptDigest=createHash('sha256').update(privatePrompt).digest('hex');
  const startParams={threadId,model:'gpt-6-astra',effort:'medium',input:[{type:'text',text:privatePrompt}],
    clientUserMessageId:`slack-concierge:turn:${reportTurn}:attempt:2`};
  const resumeParams={threadId,cwd:'/fixture',model:'gpt-6-astra',excludeTurns:true,config:{model_reasoning_effort:'medium',features:{hooks:true}}};
  const recaptured=await fixtureColdConstruction({db,owner:coldOwner,binding:inspection.identity.binding,sourcePath:history.sourcePath,
    loaded:['unrelated-loaded-thread'],configSecret});
  const retainColdInputs=()=>auth.retainCodexRecoveryColdInputs(db,{authorizationId,witness:recaptured,paramsDigest:digest(resumeParams),nowMs:4});
  if(options.retainColdInputs!==false)assert.equal(retainColdInputs().allowed,true);
  const resumeResponse={thread:{id:threadId,cwd:'/fixture',path:history.sourcePath,sessionId:threadId,historyMode:'legacy'},
    model:'gpt-6-astra',reasoningEffort:'medium'};
  const prepare=(method:string,params:any,permitId:string)=>auth.prepareCodexRecoveryMutation(db,{authorizationId,capability,
    permitId,method,params,preparedPromptDigest,nowMs:4});
  const consume=(params:any,permitId:string)=>auth.consumeCodexRecoveryMutation(db,{authorizationId,capability,permitId,intentId:permitId,params,nowMs:5});
  const startPermit=`start:${suffix}`,resumePermit=`resume:${suffix}`;
  const spend=()=>{
    db.query('UPDATE codex_unacknowledged_recoveries SET additional_dispatch_attempt=2 WHERE accepted_input_id=?').run(report.id);
    db.query('UPDATE turns SET provider_admission_intended_at=CURRENT_TIMESTAMP WHERE id=?').run(reportTurn);
  };
  const hook=(patch:any={})=>auth.codexRecoveryPromptGate(db,{providerSessionId:threadId,providerTurnId:`native:${reportTurn}:2`,
    invocationId:`hook:${suffix}`,promptDigest:preparedPromptDigest,model:'gpt-6-astra',nowMs:7,...patch});
  const constructionReceipt=()=>{
    const validated=validateCodexColdResume({db,authorizationId,intentId:resumePermit,witness:recaptured,params:resumeParams,responseResult:resumeResponse});
    assert.equal(validated.allowed,true,JSON.stringify(validated));if(!validated.allowed)throw new Error('fixture construction receipt missing');
    return validated.receipt;
  };
  const checkpointAfterResume=async(options:{retainConstruction?:boolean}={})=>{
    if(options.retainConstruction!==false)assert.equal(auth.retainCodexRecoveryColdConstruction(db,{authorizationId,receipt:constructionReceipt(),nowMs:6}).allowed,true);
    history.appendResumeSettings();const checkpoint=await history.refreshAfterResume(db,resumePermit);
    const retained=auth.retainCodexRecoverySourceCheckpoint(db,{authorizationId,result:checkpoint,nowMs:6});
    assert.equal(retained.allowed,true,JSON.stringify(retained));return checkpoint;
  };
  const resume=async()=>{
    assert.equal(prepare('thread/resume',resumeParams,resumePermit).allowed,true);
    assert.equal(consume(resumeParams,resumePermit).allowed,true);
    assert.equal(auth.recordCodexRecoveryMutationResponse(db,{authorizationId,intentId:resumePermit,
      response:{thread:{id:threadId},model:resumeResponse.model,reasoningEffort:resumeResponse.reasoningEffort},
      responseDigest:digest({id:`native-resume:${suffix}`,result:resumeResponse}),responseResultDigest:digest(resumeResponse),nowMs:6}).allowed,true);
    return checkpointAfterResume();
  };
  return {suffix,session,report,reportTurn,runId,threadId,requestId,fenceId,authorizationId,capability,privatePrompt,preparedPromptDigest,
    startParams,resumeParams,startPermit,resumePermit,prepare,consume,hook,spend,history,resume,checkpointAfterResume,
    recaptured,construction,retainColdInputs,configSecret,resumeResponse,constructionReceipt};
}
function denied(value:any,reason:string){assert.equal(value.allowed,false,JSON.stringify(value));assert.equal(value.reason,reason);}
try {
  const a=await seed();
  const lookup=auth.getCodexRecoveryAuthorizationForInput(db,a.report.id);
  assert.equal(lookup?.effort,'medium');assert.ok(!JSON.stringify(lookup).includes(a.capability));
  const statePath=(db.query('PRAGMA database_list').all() as any[]).find(row=>row.name==='main')!.file;
  const restarted=new Database(statePath);
  try {
    denied(auth.claimCodexRecoveryDispatchCapability(restarted,{authorizationId:a.authorizationId,turnId:a.reportTurn,runId:a.runId,dispatchAttempt:2,nowMs:4}),
      'RECOVERY_DISPATCH_CAPABILITY_ALREADY_CLAIMED');
  }finally{restarted.close();}
  denied(auth.prepareCodexRecoveryMutation(db,{authorizationId:a.authorizationId,capability:'wrong-capability',permitId:'invalid-token',
    method:'turn/start',params:a.startParams,preparedPromptDigest:a.preparedPromptDigest,nowMs:4}),'INTERNAL_RECOVERY_CAPABILITY_INVALID');
  assert.equal(a.prepare('thread/resume',a.resumeParams,a.resumePermit).allowed,true);
  assert.equal(a.consume(a.resumeParams,a.resumePermit).allowed,true);
  assert.equal(auth.recordCodexRecoveryMutationResponse(db,{authorizationId:a.authorizationId,intentId:a.resumePermit,
    response:a.resumeResponse,nowMs:6}).allowed,true);
  const aCheckpoint=await a.checkpointAfterResume();
  assert.equal(a.retainColdInputs().allowed,false,'cold read facts cannot be recaptured after native resume changes the original source');
  assert.throws(()=>db.query('UPDATE codex_recovery_cold_inputs SET created_at_ms=0 WHERE authorization_id=?').run(a.authorizationId),/immutable/);
  assert.throws(()=>db.query('DELETE FROM codex_recovery_cold_constructions WHERE authorization_id=?').run(a.authorizationId),/immutable/);
  assert.equal(auth.retainCodexRecoverySourceCheckpoint(db,{authorizationId:a.authorizationId,result:aCheckpoint,nowMs:6}).allowed,true);
  assert.throws(()=>db.query('UPDATE codex_recovery_source_checkpoints SET created_at_ms=0 WHERE authorization_id=?').run(a.authorizationId),/immutable/);
  denied(a.prepare('turn/steer',a.startParams,'forbidden'),'RECOVERY_MUTATION_METHOD_FORBIDDEN');
  denied(a.prepare('turn/start',{...a.startParams,effort:undefined},a.startPermit),'ACTUAL_RECOVERY_EFFECTIVE_EFFORT_MISSING_OR_CHANGED');
  denied(a.prepare('turn/start',{...a.startParams,model:'gpt-6-luna'},a.startPermit),'ACTUAL_RECOVERY_MODEL_OR_THREAD_MISMATCH');
  assert.equal(a.prepare('turn/start',a.startParams,a.startPermit).allowed,true);
  denied(a.consume({...a.startParams,effort:'xhigh'},a.startPermit),'ACTUAL_RECOVERY_PARAMETERS_CHANGED');
  denied(a.consume(a.startParams,a.startPermit),'RECOVERY_DISPATCH_BUDGET_NOT_DURABLY_SPENT');
  a.spend();
  assert.equal(a.consume(a.startParams,a.startPermit).allowed,true);
  assert.equal(a.hook().allowed,true,'first exact hook can bind before sender response');
  assert.equal(a.hook().allowed,true,'stable invocation survives owner response retry');
  denied(a.hook({invocationId:'different-hook'}),'RECOVERY_HOOK_INVOCATION_ALREADY_USED');
  denied(a.hook({model:'gpt-6-luna'}),'EXACT_RECOVERY_HOOK_IDENTITY_MISMATCH');
  denied(a.hook({providerTurnId:'another-native-turn'}),'RECOVERY_NATIVE_TURN_ID_CONFLICT');
  denied(auth.recordCodexRecoveryMutationResponse(db,{authorizationId:a.authorizationId,intentId:a.startPermit,
    response:{turn:{id:'conflicting-turn'},model:'gpt-6-astra'},nowMs:8}),'RECOVERY_RESPONSE_BINDING_CONFLICT');
  assert.equal(auth.recordCodexRecoveryMutationResponse(db,{authorizationId:a.authorizationId,intentId:a.startPermit,
    response:{turn:{id:`native:${a.reportTurn}:2`},model:'gpt-6-astra',reasoningEffort:'medium'},nowMs:9}).allowed,true);
  denied(a.consume(a.startParams,a.startPermit),'RECOVERY_MUTATION_ALREADY_FORWARDED_OR_REFUSED');
  db.query('UPDATE turns SET provider_turn_id=?,provider_input_acknowledged_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(`native:${a.reportTurn}:2`,a.reportTurn);
  assert.equal(a.hook().allowed,true,'own native observation does not invalidate an exact invocation retry');
  const configured=db.query("SELECT * FROM codex_recovery_authorization_audit WHERE authorization_id=? AND phase='consume' AND allowed=1 AND actual_configured_effort IS NOT NULL ORDER BY created_at_ms DESC LIMIT 1").get(a.authorizationId) as any;
  assert.equal(configured.bound_effort,'medium');assert.equal(configured.actual_configured_effort,'medium');assert.equal(configured.actual_model,'gpt-6-astra');
  const observedHook=db.query("SELECT * FROM codex_recovery_authorization_audit WHERE authorization_id=? AND phase='hook' AND allowed=1 LIMIT 1").get(a.authorizationId) as any;
  assert.equal(observedHook.bound_effort,'medium');assert.equal(observedHook.actual_configured_effort,null);assert.equal(observedHook.observed_effort,null);
  const oldAllow=db.query("SELECT * FROM codex_recovery_authorization_audit WHERE authorization_id=? AND phase='hook' AND allowed=1 ORDER BY created_at_ms LIMIT 1").get(a.authorizationId);
  fences.stopCodexThreadMutationFence(db,{fenceId:a.fenceId,stopActionId:'stop-exact',nowMs:10});
  const stopped=a.hook();assert.equal(stopped.known,true);denied(stopped,'RECOVERY_THREAD_FENCE_CHANGED');
  const interruptParams={threadId:a.threadId,turnId:`native:${a.reportTurn}:2`};
  denied(auth.authorizeCodexRecoveryInterrupt(db,{threadId:a.threadId,providerTurnId:interruptParams.turnId,permitId:'interrupt:no-stop',
    params:interruptParams,nowMs:11}),'CANONICAL_STOP_EVIDENCE_MISSING');
  db.query('UPDATE turns SET stop_requested_at=CURRENT_TIMESTAMP WHERE id=?').run(a.reportTurn);
  const cancel=auth.authorizeCodexRecoveryInterrupt(db,{threadId:a.threadId,providerTurnId:interruptParams.turnId,
    permitId:'interrupt:canonical',params:interruptParams,nowMs:12});
  assert.equal(cancel.allowed,true,JSON.stringify(cancel));
  if(!cancel.allowed)throw new Error('canonical cancellation missing');
  assert.equal(cancel.authority,'canonical_stop','adopted no-capability execution can honor canonical Stop');
  assert.equal(auth.consumeCodexRecoveryInterrupt(db,{authorizationId:a.authorizationId,threadId:a.threadId,providerTurnId:interruptParams.turnId,
    permitId:'interrupt:canonical',intentId:'interrupt:canonical',params:interruptParams,nowMs:13}).allowed,true);
  denied(auth.consumeCodexRecoveryInterrupt(db,{authorizationId:a.authorizationId,threadId:a.threadId,providerTurnId:interruptParams.turnId,
    permitId:'interrupt:canonical',intentId:'interrupt:canonical',params:interruptParams,nowMs:14}),'OWNED_INTERRUPT_ALREADY_FORWARDED_OR_REFUSED');
  assert.equal(auth.recordCodexRecoveryInterruptResponse(db,{authorizationId:a.authorizationId,intentId:'interrupt:canonical',kind:'accepted',
    responseDigest:digest({accepted:true}),nowMs:15}).allowed,true);
  assert.equal((db.query('SELECT state FROM codex_mutation_intents WHERE intent_id=?').get('interrupt:canonical') as any).state,'response_received',
    'interrupt acknowledgement alone cannot clear outstanding native execution');
  assert.equal(fences.grantCodexMutationPermit(db,{permitId:'fresh-after-stop',threadId:a.threadId,
    owner:{acceptedInputId:'unrelated',runId:'unrelated',dispatchAttempt:1},method:'turn/start',paramsDigest:digest({unrelated:true}),
    purpose:'ordinary',nowMs:16}).granted,false,'Stop cancellation permission never grants a fresh start');
  assert.deepEqual(db.query('SELECT * FROM codex_recovery_authorization_audit WHERE audit_id=?').get((oldAllow as any).audit_id),oldAllow);
  assert.throws(()=>db.query('UPDATE codex_recovery_authorization_audit SET allowed=0 WHERE audit_id=?').run((oldAllow as any).audit_id),/immutable/);
  const stored=JSON.stringify({authorizations:db.query('SELECT * FROM codex_recovery_dispatch_authorizations').all(),
    audit:db.query('SELECT * FROM codex_recovery_authorization_audit').all(),permits:db.query('SELECT * FROM codex_mutation_permits').all()});
  assert.ok(!stored.includes(a.capability)&&!stored.includes(a.privatePrompt),'storage and audit contain neither plaintext token nor prompt');
  const b=await seed();
  await b.resume();
  denied(auth.recordCodexRecoveryMutationResponse(db,{authorizationId:b.authorizationId,intentId:b.resumePermit,
    response:{thread:{id:b.threadId},model:'gpt-6-astra',reasoningEffort:'medium'},
    responseResultDigest:digest('conflicting real result'),nowMs:6}),'RECOVERY_NATIVE_RESPONSE_CONFLICT');
  assert.equal(b.prepare('turn/start',b.startParams,b.startPermit).allowed,true);
  retainSessionInput({sessionId:b.session.id,scope:'fixture',actionId:'later-never-admitted',kind:'action',origin:'human',payload:{action:'pause'}});
  denied(b.consume(b.startParams,b.startPermit),'SOURCE_FINGERPRINT_CHANGED');
  const c=await seed();
  db.query('UPDATE turns SET stop_requested_at=CURRENT_TIMESTAMP WHERE id=?').run(c.reportTurn);
  denied(c.prepare('turn/start',c.startParams,c.startPermit),'CURRENT_SEND_CONTROLS_REFUSE');
  const d=await seed();
  db.query("UPDATE session_communication_requests SET outcome='completed' WHERE request_id=?").run(d.requestId);
  denied(d.prepare('turn/start',d.startParams,d.startPermit),'CURRENT_WORK_REQUEST_CHANGED');
  const e=await seed();
  db.query("UPDATE sessions SET native_metadata_json=json_set(native_metadata_json,'$.reasoningEffort','xhigh') WHERE id=?").run(e.session.id);
  denied(e.prepare('turn/start',e.startParams,e.startPermit),'CURRENT_BINDING_CHANGED');
  const f=await seed();await f.resume();f.spend();
  assert.equal(f.prepare('turn/start',f.startParams,f.startPermit).allowed,true);
  assert.equal(f.consume(f.startParams,f.startPermit).allowed,true);
  assert.equal(auth.recordCodexRecoveryMutationResponse(db,{authorizationId:f.authorizationId,intentId:f.startPermit,
    response:{turn:{id:`native:${f.reportTurn}:2`},model:'gpt-6-astra',reasoningEffort:null},nowMs:8}).allowed,true);
  assert.equal(f.hook().allowed,true,'response-first and hook-first schedules bind the same exact native turn');
  denied(f.hook({invocationId:'another-after-response'}),'RECOVERY_HOOK_INVOCATION_ALREADY_USED');
  const privateInterrupt={threadId:f.threadId,turnId:`native:${f.reportTurn}:2`};
  denied(auth.authorizeCodexRecoveryInterrupt(db,{authorizationId:f.authorizationId,threadId:f.threadId,providerTurnId:'another-native',
    permitId:'interrupt:wrong-native',params:{...privateInterrupt,turnId:'another-native'},capability:f.capability,nowMs:10}),
    'OWNED_INTERRUPT_NATIVE_TURN_NOT_PROVEN');
  const inactivity=auth.authorizeCodexRecoveryInterrupt(db,{authorizationId:f.authorizationId,threadId:f.threadId,providerTurnId:privateInterrupt.turnId,
    permitId:'interrupt:inactivity',params:privateInterrupt,capability:f.capability,nowMs:11});
  assert.equal(inactivity.allowed,true,JSON.stringify(inactivity));
  if(inactivity.allowed)assert.equal(inactivity.authority,'live_dispatcher');
  assert.equal(auth.consumeCodexRecoveryInterrupt(db,{authorizationId:f.authorizationId,threadId:f.threadId,providerTurnId:privateInterrupt.turnId,
    permitId:'interrupt:inactivity',intentId:'interrupt:inactivity',params:privateInterrupt,capability:f.capability,nowMs:12}).allowed,true);
  denied(f.hook(),'RECOVERY_THREAD_FENCE_CHANGED');
  const interruptAudit=db.query("SELECT * FROM codex_recovery_authorization_audit WHERE authorization_id=? AND phase='interrupt-consume' AND allowed=1 LIMIT 1")
    .get(f.authorizationId) as any;
  assert.equal(interruptAudit.policy,'codex-recovery-interrupt-v1');
  assert.equal(interruptAudit.actual_configured_effort,null,'an interrupt does not claim new model execution');
  assert.equal(interruptAudit.provider_turn_id,privateInterrupt.turnId);
  denied(auth.reconcileCodexRecoveryNativeTerminal(db,{acceptedInputId:a.report.id,nowMs:18}),'EXACT_PROVIDER_TERMINAL_WITNESS_MISSING');
  recordSessionEvent({eventId:`codex-recovery-native-terminal:${a.reportTurn}:2`,sessionId:a.session.id,inputId:a.report.id,
    turnId:a.reportTurn,kind:'codex_recovery_native_terminal',payload:{providerThreadId:a.threadId,providerTurnId:`native:${a.reportTurn}:2`,
      inputId:a.report.id,runId:a.runId,dispatchAttempt:2,observedTerminal:true,status:'completed'}});
  assert.equal(auth.reconcileCodexRecoveryNativeTerminal(db,{acceptedInputId:a.report.id,nowMs:19}).allowed,true);
  assert.equal((db.query('SELECT state FROM codex_mutation_intents WHERE intent_id=?').get('interrupt:canonical') as any).state,'reconciled_applied');
  const g=await seed();await g.resume();g.spend();
  assert.equal(g.prepare('turn/start',g.startParams,g.startPermit).allowed,true);
  assert.equal(g.consume(g.startParams,g.startPermit).allowed,true);
  denied(auth.reconcileCodexRecoveryNativeTerminal(db,{acceptedInputId:g.report.id,nowMs:20}),'EXACT_PROVIDER_TERMINAL_WITNESS_MISSING');
  assert.equal(fences.getCodexThreadMutationFence(db,g.threadId)?.fenceId,g.fenceId,'missing observer event keeps exact fence held');
  const terminalEventId=`codex-recovery-native-terminal:${g.reportTurn}:2`;
  recordSessionEvent({eventId:terminalEventId,sessionId:g.session.id,inputId:g.report.id,turnId:g.reportTurn,
    kind:'codex_recovery_native_terminal',payload:{providerThreadId:g.threadId,providerTurnId:`native:${g.reportTurn}:2`,inputId:g.report.id,
      runId:g.runId,dispatchAttempt:2,observedTerminal:true,status:'completed'}});
  const terminal=auth.reconcileCodexRecoveryNativeTerminal(db,{acceptedInputId:g.report.id,nowMs:21});
  assert.equal(terminal.allowed,true,JSON.stringify(terminal));
  if(!terminal.allowed)throw new Error('terminal settlement missing');
  assert.equal(terminal.inputAcknowledged,false);assert.equal(terminal.hookAllowed,false);assert.equal(terminal.usefulWork,'not_assessed');
  const settledIntent=db.query('SELECT * FROM codex_mutation_intents WHERE intent_id=?').get(g.startPermit) as any;
  assert.equal(settledIntent.state,'reconciled_applied');assert.equal(settledIntent.response_kind,null);
  assert.equal(fences.getCodexThreadMutationFence(db,g.threadId),null);
  assert.equal(auth.recordCodexRecoveryMutationResponse(db,{authorizationId:g.authorizationId,intentId:g.startPermit,
    response:{turn:{id:`native:${g.reportTurn}:2`},model:'gpt-6-astra',reasoningEffort:'medium'},nowMs:22}).allowed,true);
  const lateIntent=db.query('SELECT * FROM codex_mutation_intents WHERE intent_id=?').get(g.startPermit) as any;
  assert.equal(lateIntent.state,'reconciled_applied');assert.equal(lateIntent.terminal_evidence_digest,settledIntent.terminal_evidence_digest);
  assert.equal(lateIntent.response_kind,'accepted','first delayed response adds receipt without resurrecting native execution');
  denied(auth.recordCodexRecoveryMutationResponse(db,{authorizationId:g.authorizationId,intentId:g.startPermit,
    response:{turn:{id:`native:${g.reportTurn}:2`},model:'gpt-6-astra',reasoningEffort:'medium',unexpected:'conflicting receipt'},nowMs:23}),
    'RECOVERY_NATIVE_RESPONSE_CONFLICT');
  const repeated=auth.reconcileCodexRecoveryNativeTerminal(db,{acceptedInputId:g.report.id,nowMs:24});
  assert.equal(repeated.allowed,true);if(repeated.allowed)assert.equal(repeated.duplicate,true);
  assert.equal((db.query('SELECT additional_dispatch_attempt FROM codex_unacknowledged_recoveries WHERE accepted_input_id=?').get(g.report.id) as any).additional_dispatch_attempt,2);
  assert.equal((db.query('SELECT outcome FROM session_communication_requests WHERE request_id=?').get(g.requestId) as any).outcome,null);
  assert.throws(()=>db.query('DELETE FROM codex_recovery_terminal_settlements WHERE accepted_input_id=?').run(g.report.id),/immutable/);
  const terminalAudit=db.query("SELECT * FROM codex_recovery_authorization_audit WHERE authorization_id=? AND phase='native-terminal' AND allowed=1 LIMIT 1")
    .get(g.authorizationId) as any;
  assert.ok(JSON.parse(terminalAudit.evidence_refs_json).includes(terminalEventId));
  const missingCheckpoint=await seed();
  denied(missingCheckpoint.prepare('turn/start',missingCheckpoint.startParams,missingCheckpoint.startPermit),'OWNED_RESUME_SOURCE_CHECKPOINT_MISSING');
  assert.equal(missingCheckpoint.prepare('thread/resume',missingCheckpoint.resumeParams,missingCheckpoint.resumePermit).allowed,true);
  appendFileSync(missingCheckpoint.history.sourcePath,'source changed after prepare\n');
  denied(missingCheckpoint.consume(missingCheckpoint.resumeParams,missingCheckpoint.resumePermit),'NATIVE_ORIGINAL_EFFECT_HISTORY_SOURCE_CHANGED');
  const missingCold=await seed({retainColdInputs:false});
  denied(missingCold.prepare('thread/resume',missingCold.resumeParams,missingCold.resumePermit),'COLD_RESUME_INPUTS_NOT_RETAINED');
  denied(auth.retainCodexRecoveryColdInputs(db,{authorizationId:missingCold.authorizationId,
    witness:{...missingCold.recaptured,privateConfig:'must not enter storage'} as any,
    paramsDigest:digest(missingCold.resumeParams),nowMs:4}),'COLD_CONSTRUCTION_WITNESS_INVALID');
  assert.equal(missingCold.retainColdInputs().allowed,true);
  assert.equal(missingCold.retainColdInputs().allowed,true,'exact immutable worker recapture is idempotent');
  denied(auth.retainCodexRecoveryColdInputs(db,{authorizationId:missingCold.authorizationId,witness:missingCold.recaptured,
    paramsDigest:digest({...missingCold.resumeParams,approvalPolicy:'on-request'}),nowMs:4}),'COLD_RESUME_INPUTS_CONFLICT');
  denied(missingCold.prepare('thread/resume',{...missingCold.resumeParams,config:{model_reasoning_effort:'medium',features:{hooks:true,unknown:true}}},
    missingCold.resumePermit),'RECOVERY_PREPARATION_SHAPE_INVALID');
  denied(missingCold.prepare('thread/resume',{...missingCold.resumeParams,config:{model_reasoning_effort:'medium',features:{hooks:false}}},
    missingCold.resumePermit),'RECOVERY_PREPARATION_SHAPE_INVALID');
  const missingConstruction=await seed();
  assert.equal(missingConstruction.prepare('thread/resume',missingConstruction.resumeParams,missingConstruction.resumePermit).allowed,true);
  assert.equal(missingConstruction.consume(missingConstruction.resumeParams,missingConstruction.resumePermit).allowed,true);
  assert.equal(auth.recordCodexRecoveryMutationResponse(db,{authorizationId:missingConstruction.authorizationId,
    intentId:missingConstruction.resumePermit,response:missingConstruction.resumeResponse,nowMs:6}).allowed,true);
  await missingConstruction.checkpointAfterResume({retainConstruction:false});
  denied(missingConstruction.prepare('turn/start',missingConstruction.startParams,missingConstruction.startPermit),'COLD_RESUME_CONSTRUCTION_RECEIPT_MISSING');
  const receipt=missingConstruction.constructionReceipt();
  denied(auth.retainCodexRecoveryColdConstruction(db,{authorizationId:missingConstruction.authorizationId,
    receipt:{...receipt,responseDigest:digest('unrelated native result')},nowMs:6}),'COLD_RESUME_CONSTRUCTION_RECEIPT_CONFLICT');
  assert.equal(auth.retainCodexRecoveryColdConstruction(db,{authorizationId:missingConstruction.authorizationId,receipt,nowMs:6}).allowed,true);
  assert.equal(auth.retainCodexRecoveryColdConstruction(db,{authorizationId:missingConstruction.authorizationId,receipt,nowMs:6}).allowed,true);
  assert.equal(missingConstruction.prepare('turn/start',missingConstruction.startParams,missingConstruction.startPermit).allowed,true);
  const changedBeforeStart=await seed();await changedBeforeStart.resume();changedBeforeStart.spend();
  assert.equal(changedBeforeStart.prepare('turn/start',changedBeforeStart.startParams,changedBeforeStart.startPermit).allowed,true);
  appendFileSync(changedBeforeStart.history.sourcePath,JSON.stringify({timestamp:'2026-11-13T00:00:00.000Z',
    type:'event_msg',payload:{type:'token_count',info:null}})+'\n');
  denied(changedBeforeStart.consume(changedBeforeStart.startParams,changedBeforeStart.startPermit),'NATIVE_ORIGINAL_EFFECT_HISTORY_SOURCE_CHANGED');
  assert.equal(db.query('SELECT * FROM codex_mutation_intents WHERE permit_id=?').get(changedBeforeStart.startPermit),null,
    'source changed between prepare and consume never creates a start intent');
  assert.throws(()=>db.query('DELETE FROM codex_recovery_source_checkpoints WHERE authorization_id=?').run(a.authorizationId),/immutable/);
  const publicEvidence=JSON.stringify({audit:db.query('SELECT * FROM codex_recovery_authorization_audit').all(),
    events:db.query('SELECT * FROM session_owner_events').all()});
  for(const target of [a,b,f,g,changedBeforeStart])assert.ok(!publicEvidence.includes(target.history.sourcePath),
    'private source paths stay outside audit and session events');
  const privateColdEvidence=JSON.stringify({inputs:db.query('SELECT * FROM codex_recovery_cold_inputs').all(),
    constructions:db.query('SELECT * FROM codex_recovery_cold_constructions').all()});
  for(const target of [a,b,f,g,changedBeforeStart,missingCold,missingConstruction]){
    assert.ok(!privateColdEvidence.includes(target.configSecret),'cold configuration preimages stay outside private facts');
    assert.ok(!privateColdEvidence.includes(target.history.sourcePath),'cold native source paths are hashed');
    assert.ok(!publicEvidence.includes(target.configSecret),'cold configuration preimages stay outside public audit');
  }
  console.log('Recovery dispatch authorization: real legacy Medium proof, one durable capability/start, restart/replay, exact hook invocation, Stop/current-source and immutable private audit passed');
} finally {db.close();rmSync(scratch,{recursive:true,force:true});}
