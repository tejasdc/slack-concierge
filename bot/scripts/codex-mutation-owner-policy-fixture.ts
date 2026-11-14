import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmodSync,mkdtempSync,rmSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION} from '../src/test-authorizations';
import {createFixtureOriginalHistory} from './codex-original-history-fixture-helper';
import {fixtureColdConstruction} from './codex-cold-construction-fixture-helper';
import {validateCodexColdResume} from '../src/codex-cold-construction';

const scratch=mkdtempSync(join(tmpdir(),'codex-mutation-owner-policy-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION;

const [{db},inputs,fences,authorizations,{codexMutationGate},{CodexMutationChannel},{acceptedBindingSnapshotDigest}]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/codex-mutation-fence'),
  import('../src/codex-recovery-dispatch-authorization'),import('../src/codex-mutation-policy'),
  import('../src/codex-mutation-channel.mjs'),import('../src/codex-accepted-binding-continuation'),
]);
const {createNativeSession,retainSessionInput,enqueueSessionInput,nativeRunId,recordSessionEvent}=inputs;
const {SessionCommunicationCoordinator}=await import('../src/session-communication');
fences.initializeCodexMutationFenceSchema(db);
authorizations.initializeCodexRecoveryAuthorizationSchema(db);
let serial=0;

// Realistic legacy source/admission rows establish the same authorization boundary
// used by the existing recovery fixture. This is data setup only; all decisions below
// go through the production codexMutationGate and CodexMutationChannel.
async function seed(){
  const suffix=++serial;
  const session=createNativeSession('codex',{title:'owned mutation integration',purpose:'recovery fixture',origin:'native',
    model:'gpt-6-astra',reasoningEffort:'medium',providerRunner:null} as any);
  const threadId=`thread:${suffix}`,requestId=`work:${suffix}`;
  db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run(threadId,session.id);
  const save=(id:string,kind:any,origin:any,payload:any,extra:any={})=>retainSessionInput({id,sessionId:session.id,
    scope:'fixture',actionId:id,kind,origin,payload,...extra}).input;
  const create=save(`create:${suffix}`,'create','agent',{provider:'codex',model:'gpt-6-astra',reasoningEffort:'medium',firstInput:{text:'accepted work'}});
  const createTurn=enqueueSessionInput(create.id).turn_id!;
  const source=save(`request:${requestId}`,'input','agent',{text:'same accepted work'},{requestId});
  const sourceTurn=enqueueSessionInput(source.id).turn_id!;
  const report=save(`report-back:${requestId}`,'input','service',{text:'retained report'},
    {requestId,sourceInputId:source.id,sourceRunId:nativeRunId(sourceTurn)});
  const turnId=enqueueSessionInput(report.id).turn_id!;
  for(const [input,turn] of [[create,createTurn],[source,sourceTurn],[report,turnId]] as const){
    const providerResult={text:'',sessionUUID:threadId,toolsUsed:[],providerTurnId:`native:${turn}:1`,model:'gpt-6-astra',durationMs:5};
    db.query("UPDATE turns SET status='done',dispatch_attempt=1,provider_turn_id=?,outbound_text=? WHERE id=?")
      .run(providerResult.providerTurnId,JSON.stringify({version:1,result:providerResult}),turn);
    const admission={provider:'codex',inputId:input.id,runId:nativeRunId(turn),bindingGeneration:1,model:'gpt-6-astra',nativeBinding:null};
    db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({admission}),input.id);
    recordSessionEvent({eventId:`result:${turn}`,sessionId:session.id,inputId:input.id,turnId:turn,kind:'result',
      payload:{...providerResult,runId:nativeRunId(turn),turnId:turn,sessionId:session.id,inputId:input.id}});
    recordSessionEvent({eventId:`attention:${input.id}:1`,sessionId:session.id,inputId:input.id,turnId:turn,kind:'attention',payload:{dispatchAttempt:1}});
    recordSessionEvent({eventId:`prompt-cache-identity:${turn}:1`,sessionId:session.id,turnId:turn,kind:'prompt_cache_identity',payload:{effort:'medium'}});
  }
  db.query('UPDATE turns SET provider_input_acknowledged_at=CURRENT_TIMESTAMP WHERE id IN (?,?)').run(createTurn,sourceTurn);
  db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,
    source_root_ts,action_id,target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms,
    source_input_id,target_input_id,status,outcome) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(requestId,'fixture','source',sourceTurn,session.id,'root',requestId,session.id,'fixture','root',
      JSON.stringify({requestedEffect:'work'}),'digest',0,0,source.id,source.id,'admitted',null);
  const inspection=await import('../src/codex-accepted-binding-snapshot').then(({inspectAcceptedBindingContinuation})=>
    inspectAcceptedBindingContinuation({sessionId:session.id,inputId:report.id,requestId,includeSnapshot:true}));
  assert.equal(inspection.proven,true,JSON.stringify(inspection.reasons));
  if(!('snapshot'in inspection)||!inspection.snapshot)throw new Error('fixture accepted-binding snapshot missing');
  const projectedNative=await import('../src/codex-continuation-native-interval').then(({proveCodexContinuationNativeInterval})=>
    proveCodexContinuationNativeInterval({snapshot:inspection.snapshot,client:{async request(method:string){
      return method==='thread/turns/list'?{data:[{id:`native:${turnId}:1`,status:'completed',error:null}],nextCursor:null}:{data:[],nextCursor:null};
    }}}));
  assert.equal(projectedNative.proven,true,JSON.stringify(projectedNative.reasons));
  if(!projectedNative.proven)throw new Error('fixture native interval proof missing');
  const history=await createFixtureOriginalHistory({root:scratch,binding:inspection.identity.binding,selectedInputId:report.id,nativeProof:projectedNative});
  const native=history.nativeWithOriginalHistory;
  const {snapshot:_snapshot,...continuation}=inspection;
  const proof={attempts:native.attempts.filter(attempt=>attempt.inputId===report.id)
    .map(attempt=>({dispatchAttempt:attempt.dispatchAttempt,providerTurnId:attempt.providerTurnId})),dispatchAttemptCount:1,continuation,native};
  const fenceId=`owned-fence-${suffix}`,runId=nativeRunId(turnId);
  assert.equal(fences.acquireCodexThreadMutationFence(db,{threadId,fenceId,acceptedInputId:report.id,runId,
    dispatchAttempt:2,bindingDigest:acceptedBindingSnapshotDigest(inspection.identity.binding),nowMs:1}).acquired,true);
  const coldOwner={threadId,fenceId,acceptedInputId:report.id,runId,dispatchAttempt:2,bindingDigest:acceptedBindingSnapshotDigest(inspection.identity.binding)};
  const construction=await fixtureColdConstruction({db,owner:coldOwner,binding:inspection.identity.binding,sourcePath:history.sourcePath});
  db.query(`INSERT INTO codex_unacknowledged_recoveries(accepted_input_id,request_id,turn_id,provider_thread_id,
    proof_json,action_id,source_input_id,source_run_id,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(report.id,requestId,turnId,threadId,JSON.stringify({...proof,coldResume:{construction}}),`reserve-${suffix}`,source.id,nativeRunId(sourceTurn),1);
  db.query("UPDATE turns SET status='queued',provider_turn_id=NULL,outbound_text=NULL,reasoning_effort='medium' WHERE id=?").run(turnId);
  const granted=authorizations.grantCodexRecoveryAuthorization(db,{acceptedInputId:report.id,fenceId,nowMs:2});
  assert.equal(granted.allowed,true,JSON.stringify(granted));if(!granted.allowed||!('authorizationId'in granted))throw new Error('fixture authorization missing');
  const authorizationId=granted.authorizationId;
  db.query("UPDATE turns SET status='running',owner_instance_id='fixture-owner',dispatch_attempt=2 WHERE id=?").run(turnId);
  db.query("UPDATE session_inputs SET receipt_json=json_set(receipt_json,'$.state','running'),updated_at=CURRENT_TIMESTAMP WHERE id=?").run(report.id);
  const claim=authorizations.claimCodexRecoveryDispatchCapability(db,{authorizationId,turnId,runId,dispatchAttempt:2,nowMs:3});
  assert.equal(claim.allowed,true,JSON.stringify(claim));if(!claim.allowed||!('capability'in claim))throw new Error('fixture live capability missing');
  const capability=claim.capability;
  const prompt=`fixture private accepted prompt ${suffix}`,preparedPromptDigest=createHash('sha256').update(prompt).digest('hex');
  const startParams={threadId,model:'gpt-6-astra',effort:'medium',input:[{type:'text',text:prompt}],
    clientUserMessageId:`slack-concierge:turn:${turnId}:attempt:2`};
  db.query('UPDATE codex_unacknowledged_recoveries SET additional_dispatch_attempt=2 WHERE accepted_input_id=?').run(report.id);
  db.query('UPDATE turns SET provider_admission_intended_at=CURRENT_TIMESTAMP WHERE id=?').run(turnId);
  const resumeParams={threadId,cwd:'/fixture',model:'gpt-6-astra',excludeTurns:true,config:{model_reasoning_effort:'medium',features:{hooks:true}}};
  const recaptured=await fixtureColdConstruction({db,owner:coldOwner,binding:inspection.identity.binding,sourcePath:history.sourcePath});
  assert.equal(authorizations.retainCodexRecoveryColdInputs(db,{authorizationId,witness:recaptured,paramsDigest:acceptedBindingSnapshotDigest(resumeParams),nowMs:3}).allowed,true);
  const resumeChannel=mediated(`owned-resume-${suffix}`);
  await resumeChannel.channel.forward({id:`owned-resume-${suffix}`,method:'thread/resume',params:{...resumeParams,
    __conciergeRecovery:{authorizationId,capability,preparedPromptDigest}}});
  assert.equal(resumeChannel.sent.length,1,JSON.stringify(resumeChannel.refused));
  const resumeIntent=db.query("SELECT * FROM codex_mutation_intents WHERE thread_id=? AND method='thread/resume'").get(threadId) as any;
  assert.ok(resumeIntent);
  history.appendResumeSettings();
  const responseResult={thread:{id:threadId,cwd:'/fixture',path:history.sourcePath,sessionId:threadId,historyMode:'legacy'},
    model:'gpt-6-astra',reasoningEffort:'medium'};
  await resumeChannel.channel.response({id:`owned-resume-${suffix}`,result:responseResult});
  const validated=validateCodexColdResume({db,authorizationId,intentId:resumeIntent.intent_id,witness:recaptured,params:resumeParams,responseResult});
  assert.equal(validated.allowed,true,JSON.stringify(validated));if(!validated.allowed)throw new Error('fixture cold construction failed');
  assert.equal(authorizations.retainCodexRecoveryColdConstruction(db,{authorizationId,receipt:validated.receipt,nowMs:4}).allowed,true);
  const checkpoint=await history.refreshAfterResume(db,resumeIntent.intent_id,resumeIntent.permit_id);
  const saved=authorizations.retainCodexRecoverySourceCheckpoint(db,{authorizationId,result:checkpoint,nowMs:4});
  assert.equal(saved.allowed,true,JSON.stringify(saved));
  return {suffix,session,report,turnId,threadId,runId,fenceId,authorizationId,capability,preparedPromptDigest,startParams,history,checkpoint};
}

function mediated(connectionId:string,afterPrepare?:(input:any,result:any)=>void){
  const sent:any[]=[],refused:any[]=[];
  const channel=new CodexMutationChannel({connectionId,gate:async(input:any)=>{
    // Real owner requests cross JSON transport; model that boundary here too.
    const request=JSON.parse(JSON.stringify(input)),result=await codexMutationGate(request);
    if(request.phase==='prepare'&&(result as any).allowed)afterPrepare?.(request,result);
    return result;
  },
    send:(frame:any)=>sent.push(frame),reject:(frame:any,reason:string,ambiguous:boolean)=>refused.push({frame,reason,ambiguous})});
  return {channel,sent,refused};
}
function terminalEvent(target:any,providerTurnId:string){
  recordSessionEvent({eventId:`codex-recovery-native-terminal:${target.turnId}:2`,sessionId:target.session.id,
    inputId:target.report.id,turnId:target.turnId,kind:'codex_recovery_native_terminal',payload:{
      providerThreadId:target.threadId,providerTurnId,inputId:target.report.id,runId:target.runId,dispatchAttempt:2,observedTerminal:true,status:'completed'}});
}
async function runNonAstraModelHook(target:any){
  const {SessionCommunicationCoordinator}=await import('../src/session-communication');
  const coordinator=new SessionCommunicationCoordinator({} as any);
  const socket=join(scratch,'requests.sock');
  let modelDecision:any=null;
  const owner=Bun.serve({unix:socket,idleTimeout:0,fetch:async request=>{
    const body=await request.json();
    modelDecision=coordinator.modelStartGate(body);
    return Response.json(modelDecision);
  }});
  chmodSync(socket,0o600);
  try{
    const hook=Bun.spawn([process.execPath,'run',join(import.meta.dir,'codex-model-start-hook.ts')],{
      stdin:'pipe',stdout:'pipe',stderr:'pipe',env:{...process.env,CONCIERGE_STATE_DIR:scratch,
        CONCIERGE_STATE_DB:join(scratch,'state.db'),CONCIERGE_TURN_ID:String(target.turnId),
        CONCIERGE_SOURCE_RUN_ID:target.runId,CONCIERGE_OUTSIDE_RUN:'0',
        CONCIERGE_RUNNER_STATE:join(scratch,'no-runner-connection'),CONCIERGE_OWNER_URL:'',
        CONCIERGE_RUNNER_TOKEN_FILE:'',CONCIERGE_AGENT_TOKEN:''}});
    await hook.stdin.write(JSON.stringify({session_id:target.threadId,turn_id:`native:${target.turnId}:2`,
      model:'gpt-6.1-sol',prompt:'fixture non-Astra protected prompt'}));
    hook.stdin.end();
    const [exit,stdout,stderr]=await Promise.all([hook.exited,new Response(hook.stdout).text(),new Response(hook.stderr).text()]);
    assert.equal(exit,0,stderr);
    assert.ok(stdout.trim(),`model hook returned no output; stderr=${stderr}; owner=${JSON.stringify(modelDecision)}`);
    return JSON.parse(stdout.trim());
  }finally{owner.stop(true);}
}

try {
  const intentCount=(db.query('SELECT COUNT(*) AS n FROM codex_mutation_intents').get() as any).n;
  assert.equal(codexMutationGate({phase:'prepare',method:fences.CODEX_MANAGED_HOOK_CONFIG_METHOD}).reason,
    'managed_hook_config_requires_owned_installer');
  assert.equal((db.query('SELECT COUNT(*) AS n FROM codex_mutation_intents').get() as any).n,intentCount,
    'generic native transport cannot impersonate the source-owned hook installer');
  // Original live dispatcher: recovery authority rides privately on the mutation,
  // is stripped before native send, and the channel retains the owner's returned ID
  // for the exact response receipt.
  const live=await seed(),liveChannel=mediated(`live-${live.suffix}`);
  await liveChannel.channel.forward({id:'protected-server-response',result:{accepted:true}});
  assert.equal(liveChannel.sent.length,0,'an owner-protected thread refuses methodless server responses as global writes');
  assert.equal(liveChannel.refused.length,1);
  const start={id:'live-start',method:'turn/start',params:{...live.startParams,__conciergeRecovery:{
    authorizationId:live.authorizationId,capability:live.capability,preparedPromptDigest:live.preparedPromptDigest}}};
  await liveChannel.channel.forward(start);
  assert.equal(liveChannel.sent.length,1,JSON.stringify(liveChannel.refused));
  assert.equal('__conciergeRecovery'in liveChannel.sent[0].params,false,'private authority is removed before native send');
  assert.equal((liveChannel.channel as any).pending.get(JSON.stringify('live-start')).authorizationId,live.authorizationId,
    'the channel carries the exact authorization ID from prepare into response handling');
  const startPermit=(db.query("SELECT * FROM codex_mutation_permits WHERE method='turn/start' AND thread_id=?").get(live.threadId) as any);
  assert.ok(startPermit);
  const startIntent=db.query('SELECT * FROM codex_mutation_intents WHERE permit_id=?').get(startPermit.permit_id) as any;
  assert.equal(startIntent.state,'forwarding');
  const authRow=db.query('SELECT * FROM codex_recovery_dispatch_authorizations WHERE authorization_id=?').get(live.authorizationId) as any;
  assert.equal(authorizations.codexRecoverySourceFingerprint(db,authRow),authRow.source_fingerprint,'source fingerprint after start forwarding');
  await liveChannel.channel.response({id:'live-start',result:{turn:{id:`native:${live.turnId}:2`},model:'gpt-6-astra',reasoningEffort:'medium'}});
  assert.equal((db.query('SELECT state FROM codex_mutation_intents WHERE intent_id=?').get(startIntent.intent_id) as any).state,'response_received');
  assert.equal(authorizations.codexRecoverySourceFingerprint(db,authRow),authRow.source_fingerprint,'source fingerprint after native start response');
  db.query('UPDATE turns SET provider_turn_id=?,provider_input_acknowledged_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(`native:${live.turnId}:2`,live.turnId);
  assert.equal(authorizations.codexRecoverySourceFingerprint(db,authRow),authRow.source_fingerprint,'source fingerprint after turn acknowledgment');
  const coordinatorDecision=new SessionCommunicationCoordinator({} as any).modelStartGate({providerSessionId:live.threadId,
    model:'gpt-6.1-sol',providerTurnId:`native:${live.turnId}:2`,ownerTurnId:live.turnId,sourceRunId:live.runId,
    invocationId:`fixture-coordinator-${live.suffix}`,promptDigest:live.preparedPromptDigest});
  assert.equal((coordinatorDecision as any).reason,'EXACT_RECOVERY_HOOK_IDENTITY_MISMATCH',JSON.stringify(coordinatorDecision));
  const nonAstraHook=await runNonAstraModelHook(live);
  assert.equal(nonAstraHook.decision,'block');
  assert.equal(nonAstraHook.reason,'EXACT_RECOVERY_HOOK_IDENTITY_MISMATCH',JSON.stringify(nonAstraHook));
  const modelGate=authorizations.getCodexRecoveryAuthorizationForInput(db,live.report.id);
  assert.ok(modelGate,'the actual model-start gate observed the protected recovery authorization');

  // A live dispatcher can interrupt only its exact owned turn. Different thread
  // and provider-turn targets are refused before either reaches the native stand-in.
  const authority={authorizationId:live.authorizationId,capability:live.capability};
  await liveChannel.channel.forward({id:'live-wrong-turn',method:'turn/interrupt',params:{threadId:live.threadId,turnId:'not-the-owned-turn',__conciergeRecovery:authority}});
  await liveChannel.channel.forward({id:'live-wrong-thread',method:'turn/interrupt',params:{threadId:'some-other-thread',turnId:`native:${live.turnId}:2`,__conciergeRecovery:authority}});
  assert.equal(liveChannel.sent.length,1);
  assert.equal(liveChannel.refused.length,3);
  assert.ok(liveChannel.refused.slice(1).every(item=>/OWNED_INTERRUPT|RECOVERY/.test(item.reason)));
  // A supported history read remains available while the exact native start is unresolved.
  await liveChannel.channel.forward({id:'live-history',method:'thread/turns/list',params:{threadId:live.threadId}});
  assert.equal(liveChannel.sent.length,2);
  await liveChannel.channel.response({id:'live-history',result:{data:[{id:`native:${live.turnId}:2`,status:'inProgress'}]}});

  await db.query('UPDATE turns SET stop_requested_at=CURRENT_TIMESTAMP WHERE id=?').run(live.turnId);
  const liveInterrupt={id:'live-interrupt',method:'turn/interrupt',params:{threadId:live.threadId,turnId:`native:${live.turnId}:2`,
    __conciergeRecovery:authority}};
  await liveChannel.channel.forward(liveInterrupt);
  assert.equal(liveChannel.sent.length,3,'the authorized live dispatcher interrupt reaches the native stand-in');
  const interruptIntentId=(db.query("SELECT intent_id FROM codex_mutation_intents WHERE method='turn/interrupt' AND thread_id=?")
    .get(live.threadId) as any).intent_id;
  await liveChannel.channel.response({id:'live-interrupt',error:{code:-32000,message:'interrupt acknowledgement failed'}});
  assert.equal((db.query('SELECT state FROM codex_mutation_intents WHERE intent_id=?').get(interruptIntentId) as any).state,
    'response_received','an RPC error/acknowledgement is not terminal native evidence');
  terminalEvent(live,`native:${live.turnId}:2`);
  const liveTerminal=authorizations.reconcileCodexRecoveryNativeTerminal(db,{acceptedInputId:live.report.id,nowMs:20});
  assert.equal(liveTerminal.allowed,true,JSON.stringify(liveTerminal));
  assert.equal((db.query('SELECT state FROM codex_mutation_intents WHERE intent_id=?').get(interruptIntentId) as any).state,'reconciled_applied');

  // Adopted execution with no dispatcher capability: canonical Stop alone authorizes
  // the exact interruption. The same callback event settles it; capability omission
  // is explicit at the channel boundary.
  const adopted=await seed(),adoptedChannel=mediated(`adopted-${adopted.suffix}`);
  await adoptedChannel.channel.forward({id:'adopted-start',method:'turn/start',params:{...adopted.startParams,
    __conciergeRecovery:{authorizationId:adopted.authorizationId,capability:adopted.capability,
      preparedPromptDigest:adopted.preparedPromptDigest}}});
  const adoptedStartPermit=db.query("SELECT permit_id FROM codex_mutation_permits WHERE method='turn/start' AND thread_id=?").get(adopted.threadId) as any;
  const adoptedStartIntent=db.query('SELECT intent_id FROM codex_mutation_intents WHERE permit_id=?').get(adoptedStartPermit.permit_id) as any;
  await adoptedChannel.channel.response({id:'adopted-start',result:{turn:{id:`native:${adopted.turnId}:2`},model:'gpt-6-astra',reasoningEffort:'medium'}});
  db.query('UPDATE turns SET stop_requested_at=CURRENT_TIMESTAMP WHERE id=?').run(adopted.turnId);
  await adoptedChannel.channel.forward({id:'adopted-interrupt',method:'turn/interrupt',params:{threadId:adopted.threadId,turnId:`native:${adopted.turnId}:2`}});
  assert.equal(adoptedChannel.sent.length,2);
  const adoptedInterruptId=(db.query("SELECT intent_id FROM codex_mutation_intents WHERE method='turn/interrupt' AND thread_id=?")
    .get(adopted.threadId) as any).intent_id;
  assert.equal((db.query('SELECT state FROM codex_mutation_intents WHERE intent_id=?').get(adoptedInterruptId) as any).state,'forwarding');
  await adoptedChannel.channel.response({id:'adopted-interrupt',result:{accepted:true}});
  const afterAck=db.query('SELECT state,response_kind FROM codex_mutation_intents WHERE intent_id=?').get(adoptedInterruptId) as any;
  assert.equal(afterAck.state,'response_received');assert.equal(afterAck.response_kind,'accepted');
  assert.equal((db.query('SELECT state FROM codex_mutation_intents WHERE intent_id=?').get(adoptedStartIntent.intent_id) as any).state,
    'response_received','interrupt acknowledgement did not settle the accepted start');
  terminalEvent(adopted,`native:${adopted.turnId}:2`);
  const adoptedTerminal=authorizations.reconcileCodexRecoveryNativeTerminal(db,{acceptedInputId:adopted.report.id,nowMs:30});
  assert.equal(adoptedTerminal.allowed,true,JSON.stringify(adoptedTerminal));
  assert.equal((db.query('SELECT state FROM codex_mutation_intents WHERE intent_id=?').get(adoptedInterruptId) as any).state,'reconciled_applied');
  assert.equal((db.query('SELECT state FROM codex_mutation_intents WHERE intent_id=?').get(adoptedStartIntent.intent_id) as any).state,'reconciled_applied');

  const changed=await seed(),changedChannel=mediated('source-change-between-gates',request=>{
    if(request.method==='turn/start')appendFileSync(changed.history.sourcePath,'unexpected source append\n');
  });
  await changedChannel.channel.forward({id:'changed-start',method:'turn/start',params:{...changed.startParams,
    __conciergeRecovery:{authorizationId:changed.authorizationId,capability:changed.capability,preparedPromptDigest:changed.preparedPromptDigest}}});
  assert.equal(changedChannel.sent.length,0,'physical source change after preparation refuses actual channel forward');
  assert.equal(changedChannel.refused[0]?.reason,'NATIVE_ORIGINAL_EFFECT_HISTORY_SOURCE_CHANGED');
  assert.equal(db.query("SELECT * FROM codex_mutation_intents WHERE thread_id=? AND method='turn/start'").get(changed.threadId),null);
  fences.stopCodexThreadMutationFence(db,{fenceId:changed.fenceId,stopActionId:'fixture-explicit-stop-after-pre-forward-refusal',nowMs:40});
  assert.throws(()=>db.query('UPDATE codex_recovery_source_checkpoints SET created_at_ms=0 WHERE authorization_id=?').run(live.authorizationId),/immutable/);
  const publicEvidence=JSON.stringify({audit:db.query('SELECT * FROM codex_recovery_authorization_audit').all(),
    events:db.query('SELECT * FROM session_owner_events').all()});
  for(const target of [live,adopted,changed])assert.ok(!publicEvidence.includes(target.history.sourcePath),
    'private physical source path never enters audit/session events');

  const unprotectedChannel=mediated('unprotected-methodless');
  await unprotectedChannel.channel.forward({id:'methodless-global',result:{accepted:true}});
  assert.equal(unprotectedChannel.sent.length,1,'a methodless native server response crosses the ordinary global gate');
  const globalIntent=db.query("SELECT * FROM codex_mutation_intents WHERE method='managed/server-response'").get() as any;
  assert.ok(globalIntent);assert.equal(globalIntent.thread_id,'*');assert.equal(globalIntent.state,'forwarding');
  await unprotectedChannel.channel.forward({id:'shared-id',method:'thread/name/set',params:{threadId:'thread:unfenced',name:'fixture'}});
  const correlated=(unprotectedChannel.channel as any).pending.get(JSON.stringify('shared-id'));
  assert.ok(correlated);
  await unprotectedChannel.channel.forward({id:'shared-id',result:{nativeRequest:'same id, opposite direction'}});
  assert.strictEqual((unprotectedChannel.channel as any).pending.get(JSON.stringify('shared-id')),correlated,
    'methodless server response with a colliding ID does not replace outgoing RPC correlation');
  await unprotectedChannel.channel.response({id:'shared-id',result:{accepted:true}});
  assert.equal((db.query('SELECT state FROM codex_mutation_intents WHERE intent_id=?').get(correlated.intentId) as any).state,'response_received');

  const setup=mediated('ordinary-setup');
  await setup.channel.forward({id:'resume',method:'thread/resume',params:{threadId:'ordinary-thread'}});
  await setup.channel.response({id:'resume',result:{thread:{id:'ordinary-thread'},model:'gpt-6.1-sol'}});
  assert.equal((db.query('SELECT state FROM codex_mutation_intents WHERE intent_id=?').get('ordinary-setup:1') as any).state,
    'reconciled_applied','a successful matching resume receipt completes its own setup mutation');
  await setup.channel.forward({id:'create',method:'thread/start',params:{model:'gpt-6.1-sol'}});
  await setup.channel.response({id:'create',result:{thread:{id:'new-ordinary-thread'},model:'gpt-6.1-sol'}});
  assert.equal((db.query('SELECT state FROM codex_mutation_intents WHERE intent_id=?').get('ordinary-setup:2') as any).state,
    'reconciled_applied','a successful create receipt completes initialization, not a provider turn');
  await setup.channel.forward({id:'failed-resume',method:'thread/resume',params:{threadId:'ordinary-thread'}});
  await setup.channel.response({id:'failed-resume',error:{code:-1,message:'may have changed settings'}});
  assert.equal((db.query('SELECT state FROM codex_mutation_intents WHERE intent_id=?').get('ordinary-setup:3') as any).state,
    'response_received','a failed setup reply cannot prove it did not act');
  await setup.channel.forward({id:'settings',method:'thread/settings/update',params:{threadId:'ordinary-thread',model:'gpt-6.1-sol'}});
  await setup.channel.response({id:'settings',result:{}});
  assert.equal((db.query('SELECT state FROM codex_mutation_intents WHERE intent_id=?').get('ordinary-setup:4') as any).state,
    'response_received','an asynchronous settings submission receipt is not completion evidence');

  console.log('codex mutation owner policy fixture: actual state DB/channel, original source/checkpoint, source-change refusal, live/adopted interruption, exact hook and native response correlation: PASS');
} finally {
  db.close();rmSync(scratch,{recursive:true,force:true});
}
