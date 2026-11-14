#!/usr/bin/env bun
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,rm} from 'node:fs/promises';
import {Worker} from 'node:worker_threads';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fixtureNativeSettings} from './codex-original-history-fixture-helper';
import {releaseWorkerPath} from '../src/release-worker';
import {ownerContextRawSha256,renderOwnerApplicationContext} from '../src/codex-owner-context-diagnostic';

// Both the owner worker and its App Server bridge inherit these isolated paths.
const scratch=await mkdtemp(join(tmpdir(),'codex-original-worker-'));
const state=join(scratch,'state'),codexHome=join(scratch,'codex-home'),socket=join(scratch,'app-server.sock'),
  systemDir=join(scratch,'etc-codex'),nativeCwd=join(scratch,'project');
await mkdir(state);await mkdir(codexHome);await mkdir(join(systemDir,'hooks'),{recursive:true});await mkdir(nativeCwd);
process.env.CONCIERGE_STATE_DIR=state;process.env.CONCIERGE_CAPTURE_STATE_DIR=join(state,'capture');
process.env.CONCIERGE_TEST_MODE='1';process.env.CONCIERGE_TEST_AUTHORIZATION='implementation-edit-gate-2026-11-12';
process.env.CONCIERGE_CODEX_APP_SERVER_SOCKET=socket;process.env.CODEX_HOME=codexHome;
process.env.CODEX_SYSTEM_DIR=systemDir;
const nodeExecutable=process.env.CONCIERGE_NODE_BIN?.trim()||Bun.which('node');
assert.ok(nodeExecutable,'The isolated native bridge fixture requires a selected Node runtime.');
process.env.CONCIERGE_NODE_BIN=nodeExecutable;
delete process.env.CONCIERGE_CODEX_RUNNER;

const threadId='019a7181-0000-7000-8000-000000000001';
const nativeTurnId='native-turn-selected';
const privateOwnerHeader='fixture private owner commitment\n'+('captured instructions 😀\n'.repeat(300));
const originalPath=join(codexHome,'original.jsonl');
const line=(type:string,payload:any)=>JSON.stringify({timestamp:'2026-11-13T12:00:00.000Z',type,payload});
const settings=fixtureNativeSettings({model:'gpt-6-astra',effort:'medium'});
const context=(turnId:string)=>line('turn_context',{turn_id:turnId,cwd:'/fixture',approval_policy:'never',
  sandbox_policy:{type:'danger-full-access'},model:'gpt-6-astra',effort:'medium'});
const original=[
  line('session_meta',{id:threadId,session_id:threadId,history_mode:'legacy'}),
  line('event_msg',{type:'thread_settings_applied',thread_id:threadId,thread_settings:settings}),
  line('event_msg',{type:'task_started',turn_id:'prior-native-turn',model_context_window:258400}),
  context('prior-native-turn'),
  line('event_msg',{type:'task_complete',turn_id:'prior-native-turn',last_agent_message:null}),
  line('event_msg',{type:'task_started',turn_id:nativeTurnId,model_context_window:258400}),
  context(nativeTurnId),
  line('event_msg',{type:'task_complete',turn_id:nativeTurnId,last_agent_message:null}),
].join('\n')+'\n';
await writeFile(originalPath,original);

let reads=0,threadReadCalls=0,loadedListCalls=0,requirementsAvailable=true,loadedTarget=false,configMarker='baseline',
  holdThreadRead=false,releaseThreadRead!:()=>void,threadReadReached!:()=>void;
let threadReadBlocked:Promise<void>|null=null,threadReadWaiter:Promise<void>|null=null;
const appServer=Bun.serve({unix:socket,fetch:(request,server)=>server.upgrade(request)?undefined:new Response('websocket only',{status:400}),
  websocket:{async message(ws,message){
    const request=JSON.parse(String(message));
    if(request.method==='thread/read'){
      threadReadCalls++;
      if(holdThreadRead){threadReadReached();await threadReadBlocked;}
    }
    const result=request.method==='initialize'?{userAgent:'isolated-original-history-fixture'}
      :request.method==='thread/read'?{thread:{id:threadId,path:originalPath,cwd:nativeCwd,status:{type:'notLoaded'},
        sessionId:threadId,historyMode:'legacy',model:'gpt-6-astra',reasoningEffort:'medium',forkedFromId:null,parentThreadId:null}}
      :request.method==='thread/loaded/list'?(loadedListCalls++,request.params?.cursor
        ?{data:['loaded-unrelated-b'],nextCursor:null}
        :{data:[...(loadedTarget?[threadId]:[]),'loaded-unrelated-a'],nextCursor:'worker-opaque-cursor'})
      :request.method==='configRequirements/read'?requirementsAvailable?{supportsIndependentSpeedModes:true,requirements:{
        featureRequirements:{hooks:true},hooks:{managedDir:join(systemDir,'hooks'),windowsManagedDir:null,
          UserPromptSubmit:[{matcher:null,hooks:[{type:'command',command:join(systemDir,'hooks','concierge-model-start'),
            async:false,timeoutSec:20,statusMessage:'Checking Astra escalation reason',commandWindows:null,additionalContextLimit:null}]}]}}}:{}
      :request.method==='config/read'?{config:{notify:configMarker},origins:{},layers:[{name:{type:'user'},version:'fixture',config:{notify:configMarker}}]}
      :request.method==='thread/turns/list'?(reads++,{data:[{id:nativeTurnId,status:'completed',error:null}],nextCursor:null,hasMore:false})
      :request.method==='thread/items/list'?{data:[],nextCursor:null,hasMore:false}
      :{};
    ws.send(JSON.stringify({id:request.id,result}));
  }}});

try{
  const [stateModule,inputs,snapshotModule,nativeModule,fenceModule,authModule,continuationDigest,workerClientModule]=await Promise.all([
    import('../src/state'),import('../src/session-inputs'),import('../src/codex-accepted-binding-snapshot'),
    import('../src/codex-continuation-native-interval'),import('../src/codex-mutation-fence'),
    import('../src/codex-recovery-dispatch-authorization'),import('../src/codex-accepted-binding-continuation'),
    import('../src/provider-history-page-client')]);
  // Match the serving owner's startup order: session-fit owns additive request
  // columns and is loaded by SessionOwner before any continuation snapshot.
  await import('../src/session-owner');
  const {db}=stateModule;const {createNativeSession,retainSessionInput,enqueueSessionInput,nativeRunId,recordSessionEvent}=inputs;
  const {inspectAcceptedBindingContinuation}=snapshotModule;
  const {proveCodexContinuationNativeInterval}=nativeModule;
  const {acquireCodexThreadMutationFence}=fenceModule;
  const auth=authModule;
  const session=createNativeSession('codex',{title:'isolated original-history worker',purpose:'fixture',origin:'native',
    model:'gpt-6-astra',reasoningEffort:'medium',providerRunner:null} as any);
  db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run(threadId,session.id);
  const requestId='worker-request';
  const save=(id:string,kind:any,origin:any,payload:any,extra:any={})=>retainSessionInput({id,sessionId:session.id,
    scope:'fixture',actionId:id,kind,origin,payload,...extra}).input;
  const create=save('create-worker','create','agent',{provider:'codex',model:'gpt-6-astra',reasoningEffort:'medium',firstInput:{text:'setup'}});
  const createTurn=enqueueSessionInput(create.id).turn_id!;
  const source=save('request-worker','input','agent',{text:'accepted original request'},{requestId});
  const sourceTurn=enqueueSessionInput(source.id).turn_id!;
  const report=save('report-back:worker-request','input','service',{text:'retained service continuation'},
    {requestId,sourceInputId:source.id,sourceRunId:nativeRunId(sourceTurn)});
  const reportTurn=enqueueSessionInput(report.id).turn_id!;
  for(const [input,turn] of [[create,createTurn],[source,sourceTurn],[report,reportTurn]] as const){
    const providerTurnId=input.id===report.id?nativeTurnId:`native:${turn}:1`;
    const result={text:'',sessionUUID:threadId,toolsUsed:[],providerTurnId,model:'gpt-6-astra',durationMs:1};
    db.query("UPDATE turns SET status='done',dispatch_attempt=1,provider_turn_id=?,outbound_text=? WHERE id=?")
      .run(providerTurnId,JSON.stringify({version:1,result}),turn);
    db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({admission:{provider:'codex',inputId:input.id,
      runId:nativeRunId(turn),bindingGeneration:1,model:'gpt-6-astra',nativeBinding:null}}),input.id);
    recordSessionEvent({eventId:`result:${turn}`,sessionId:session.id,inputId:input.id,turnId:turn,kind:'result',
      payload:{...result,runId:nativeRunId(turn),turnId:turn,sessionId:session.id,inputId:input.id}});
    recordSessionEvent({eventId:`attention:${input.id}:1`,sessionId:session.id,inputId:input.id,turnId:turn,kind:'attention',payload:{dispatchAttempt:1}});
    recordSessionEvent({eventId:`prompt-cache-identity:${turn}:1`,sessionId:session.id,turnId:turn,kind:'prompt_cache_identity',
      payload:{effort:'medium',systemInstructionsSha256:ownerContextRawSha256(privateOwnerHeader)}});
  }
  db.query('UPDATE turns SET provider_input_acknowledged_at=CURRENT_TIMESTAMP WHERE id IN (?,?)').run(createTurn,sourceTurn);
  db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,
    source_root_ts,action_id,target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms,
    source_input_id,target_input_id,status,outcome) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(requestId,'fixture','source',sourceTurn,session.id,'root',requestId,session.id,'fixture','root',
      JSON.stringify({requestedEffect:'work'}),'hash',0,0,source.id,source.id,'admitted',null);
  const inspection=inspectAcceptedBindingContinuation({sessionId:session.id,inputId:report.id,requestId,includeSnapshot:true});
  assert.equal(inspection.proven,true,JSON.stringify(inspection.reasons));
  if(!inspection.proven||!('snapshot'in inspection)||!inspection.snapshot)throw new Error('fixture continuation missing');
  const nativeClient={async request(method:string,params:any){
    if(method==='thread/turns/list')return {data:[{id:nativeTurnId,status:'completed',error:null}],nextCursor:null,hasMore:false};
    if(method==='thread/items/list')return {data:[],nextCursor:null,hasMore:false};
    throw new Error(`unexpected fixture method: ${method} ${JSON.stringify(params)}`);
  }};
  const native=await proveCodexContinuationNativeInterval({snapshot:inspection.snapshot,client:nativeClient as any});
  assert.equal(native.proven,true,JSON.stringify(native.reasons));if(!native.proven)throw new Error('native interval missing');
  assert.equal(continuationDigest.acceptedBindingSnapshotDigest({threadId:native.threadId,continuationDecisionDigest:native.continuationDecisionDigest,
    ownerSnapshotDigest:native.ownerSnapshotDigest,attempts:native.attempts,coverage:native.coverage,
    nativeTurnOrder:native.nativeTurnOrder,nativeWatermark:native.nativeWatermark}),native.nativeDigest);
  const fenceId='worker-exact-fence',runId=nativeRunId(reportTurn);
  const fence=acquireCodexThreadMutationFence(db,{threadId,fenceId,acceptedInputId:report.id,runId,dispatchAttempt:2,
    bindingDigest:continuationDigest.acceptedBindingSnapshotDigest(inspection.identity.binding),nowMs:1});
  assert.equal(fence.acquired,true,JSON.stringify(fence));
  const postFenceInspection=inspectAcceptedBindingContinuation({sessionId:session.id,inputId:report.id,requestId,includeSnapshot:true});
  assert.equal(postFenceInspection.proven,true,JSON.stringify(postFenceInspection.reasons));
  if(!postFenceInspection.proven)throw new Error('post-fence snapshot missing');
  assert.equal(postFenceInspection.decisionDigest,inspection.decisionDigest,'acquiring the exact reservation fence must not alter continuation identity');
  const managedConfigPath=resolve(import.meta.dir,'../src/codex-managed-hook-config.ts');
  const actualWorkerEntry=resolve(import.meta.dir,'../src/provider-history-page-worker.ts');
  const fixtureWorkerEntry=join(scratch,'provider-history-page-fixture-worker.ts');
  await writeFile(fixtureWorkerEntry,`import {mock} from 'bun:test';
const modulePath=${JSON.stringify(managedConfigPath)};
const actual=await import(modulePath);
const assessCoverage=actual.assessManagedHookInstallerCoverage;
const fixtureProcesses={listPids:()=>[],identity:()=>null,parentPid:()=>null,commandLine:()=>null};
mock.module(modulePath,()=>({...actual,assessManagedHookInstallerCoverage:(input:any)=>
  assessCoverage({...input,processes:fixtureProcesses})}));
const lifecyclePath=${JSON.stringify(resolve(import.meta.dir,'../src/codex-daemon-file-limit.ts'))};
const lifecycle=await import(lifecyclePath);
mock.module(lifecyclePath,()=>({...lifecycle,raiseCodexDaemonFileLimit:async()=>{},moveCodexDaemonToOwnScope:async()=>{},
  startCodexDaemonWhenAbsent:()=>{throw new Error('Fixture must never start a real native daemon');}}));
const nativeModule=await import(${JSON.stringify(resolve(import.meta.dir,'../src/codex-app-server-client.ts'))});
const nativeClient=nativeModule.sharedCodexAppServerClient();
const request=nativeClient.request.bind(nativeClient);
nativeClient.request=async(method:any,...args:any[])=>{
  try{return await request(method,...args);}
  catch(error){console.error('Fixture native read failed',method,String(error));throw error;}
};
await import(${JSON.stringify(actualWorkerEntry)});
`);
  const productionWorkerEntry=releaseWorkerPath('provider-history-page-worker');
  const client=new workerClientModule.ProviderHistoryPageClient(entry=>{
    assert.equal(entry,productionWorkerEntry,'fixture factory only substitutes the worker entry');
    return new Worker(fixtureWorkerEntry);
  });
  try{
    const candidate={inputId:report.id,turnId:reportTurn,runId,dispatchAttempt:1,providerTurnId:nativeTurnId,value:privateOwnerHeader};
    const diagnosticRows=original.trimEnd().split('\n').map(text=>JSON.parse(text));
    diagnosticRows.splice(diagnosticRows.length-1,0,JSON.parse(line('response_item',{type:'message',role:'developer',
      content:[{type:'input_text',text:renderOwnerApplicationContext(privateOwnerHeader)}],
      internal_chat_message_metadata_passthrough:{turn_id:nativeTurnId,create_time:12.5,content_item_kinds:['additional_content.slack-concierge']}})));
    await writeFile(originalPath,diagnosticRows.map(row=>JSON.stringify(row)).join('\n')+'\n');
    const eventCount=(db.query('SELECT count(*) AS count FROM session_owner_events').get() as any).count;
    const diagnosticRequest={sessionId:session.id,inputId:report.id,requestId,runId,fenceId,
      expectedDecisionDigest:inspection.decisionDigest,expectedNativeDigest:native.nativeDigest,diagnosticContextCandidates:[candidate]};
    const observed=await client.readOriginalCodexRecoveryCoverage(diagnosticRequest) as any;
    assert.equal(observed.proven,false,JSON.stringify(observed));assert.equal(observed.diagnostic.semanticComplete,true);
    assert.equal(observed.diagnostic.ownerContextOccurrences.length,1);
    assert.equal(observed.diagnostic.ownerContextOccurrences[0].evidenceStatus,'owner_snapshot');
    assert.ok(!JSON.stringify(observed).includes(privateOwnerHeader)&&!JSON.stringify(observed).includes(originalPath));
    const again=await client.readOriginalCodexRecoveryCoverage(diagnosticRequest) as any;
    assert.deepEqual(again.diagnostic.ownerContextOccurrences,observed.diagnostic.ownerContextOccurrences);
    assert.equal((db.query('SELECT count(*) AS count FROM session_owner_events').get() as any).count,eventCount,
      'read-side evidence use never spends a historical event or attempt');
    const poisoned=await client.readOriginalCodexRecoveryCoverage({...diagnosticRequest,
      diagnosticContextCandidates:[{...candidate,expectedSha256:ownerContextRawSha256('different')}] as any}) as any;
    assert.equal(poisoned.proven,false);assert.equal(poisoned.reasons[0].code,'OWNER_CONTEXT_CANDIDATE_INVALID');
    const mismatch=await client.readOriginalCodexRecoveryCoverage({...diagnosticRequest,
      diagnosticContextCandidates:[{...candidate,value:privateOwnerHeader+'changed'}]}) as any;
    assert.equal(mismatch.proven,false);assert.equal(mismatch.diagnostic.findings.at(-1).code,'OWNER_CONTEXT_FULL_PREIMAGE_MISMATCH');
    await writeFile(originalPath,original);
    const noFenceReads=threadReadCalls;
    const staleFence=await client.readOriginalCodexRecoveryCoverage({sessionId:session.id,inputId:report.id,requestId,runId,
      fenceId:'wrong-fence',expectedDecisionDigest:inspection.decisionDigest,expectedNativeDigest:native.nativeDigest}) as any;
    assert.equal(staleFence.proven,false);assert.equal(staleFence.reasons[0].code,'EXACT_ACTIVE_FENCE_CHANGED');
    assert.equal(threadReadCalls,noFenceReads,'a replaced/unknown fence is refused before source access');

    holdThreadRead=true;
    threadReadBlocked=new Promise(resolve=>{releaseThreadRead=resolve;});
    threadReadWaiter=new Promise(resolve=>{threadReadReached=resolve;});
    const inFlight=client.readOriginalCodexRecoveryCoverage({sessionId:session.id,inputId:report.id,requestId,runId,fenceId,
      expectedDecisionDigest:inspection.decisionDigest,expectedNativeDigest:native.nativeDigest}) as Promise<any>;
    await Promise.race([threadReadWaiter,inFlight.then(result=>{
      throw new Error(`Fixture operation completed before its native-read barrier: ${JSON.stringify(result)}`);
    })]);
    const originalMetadata=(db.query('SELECT native_metadata_json FROM sessions WHERE id=?').get(session.id) as any).native_metadata_json;
    const changedMetadata={...JSON.parse(originalMetadata),suspended:true};
    db.query('UPDATE sessions SET native_metadata_json=? WHERE id=?').run(JSON.stringify(changedMetadata),session.id);
    releaseThreadRead();
    const changedDuringRead=await inFlight;
    assert.equal(changedDuringRead.proven,false,JSON.stringify(changedDuringRead));
    assert.equal(changedDuringRead.reasons[0].code,'CURRENT_ACCEPTED_BINDING_OR_CONTROLS_REFUSE');
    db.query('UPDATE sessions SET native_metadata_json=? WHERE id=?').run(originalMetadata,session.id);
    holdThreadRead=false;

    const coverage=await client.readOriginalCodexRecoveryCoverage({sessionId:session.id,inputId:report.id,requestId,runId,fenceId,
      expectedDecisionDigest:inspection.decisionDigest,expectedNativeDigest:native.nativeDigest}) as any;
    assert.equal(coverage.proven,true,JSON.stringify(coverage));
    assert.equal(coverage.witness.threadId,threadId);assert.equal(coverage.witness.selectedInputId,report.id);
    assert.ok(!JSON.stringify(coverage.witness).includes(originalPath),'safe witness must not expose source path');
    assert.ok(!JSON.stringify(coverage).includes('accepted original request'),'worker result contains no raw request body');
    assert.ok(reads>=2,'worker used the actual App Server stand-in for native coverage');

    const {snapshot:_private,...continuation}=inspection;
  assert.ok(coverage.coldConstruction?.witnessDigest,'initial source read also proved cold construction');
  assert.ok(loadedListCalls>=4,'cold source collector exhausted opaque loaded-thread pagination on two observations');
  const originalHistory={witness:coverage.witness,custody:coverage.custody};
    const proofNative={...native,originalHistory,nativeDigest:continuationDigest.acceptedBindingSnapshotDigest({
      threadId:native.threadId,continuationDecisionDigest:native.continuationDecisionDigest,ownerSnapshotDigest:native.ownerSnapshotDigest,
      attempts:native.attempts,coverage:native.coverage,nativeTurnOrder:native.nativeTurnOrder,nativeWatermark:native.nativeWatermark,
      originalHistory})};
    const proof={attempts:native.attempts.filter(a=>a.inputId===report.id).map(({dispatchAttempt,providerTurnId})=>({dispatchAttempt,providerTurnId})),
      dispatchAttemptCount:1,continuation,native:proofNative,coldResume:{construction:coverage.coldConstruction}};
    const persistedNative=JSON.parse(JSON.stringify(proof.native));
    assert.equal(continuationDigest.acceptedBindingSnapshotDigest({threadId:persistedNative.threadId,
      continuationDecisionDigest:persistedNative.continuationDecisionDigest,ownerSnapshotDigest:persistedNative.ownerSnapshotDigest,
      attempts:persistedNative.attempts,coverage:persistedNative.coverage,nativeTurnOrder:persistedNative.nativeTurnOrder,
      nativeWatermark:persistedNative.nativeWatermark,originalHistory:persistedNative.originalHistory}),persistedNative.nativeDigest);
    db.query(`INSERT INTO codex_unacknowledged_recoveries(accepted_input_id,request_id,turn_id,provider_thread_id,
      proof_json,action_id,source_input_id,source_run_id,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(report.id,requestId,reportTurn,threadId,JSON.stringify(proof),'reserve-worker',source.id,nativeRunId(sourceTurn),2);
    db.query("UPDATE turns SET status='queued',provider_turn_id=NULL,outbound_text=NULL,reasoning_effort='medium' WHERE id=?").run(reportTurn);
    const granted=auth.grantCodexRecoveryAuthorization(db,{acceptedInputId:report.id,fenceId,nowMs:3});
    assert.equal(granted.allowed,true,JSON.stringify(granted));if(!granted.allowed)throw new Error('authorization missing');
    db.query("UPDATE turns SET status='running',owner_instance_id='fixture-owner',dispatch_attempt=2 WHERE id=?").run(reportTurn);
    const claimed=auth.claimCodexRecoveryDispatchCapability(db,{authorizationId:granted.authorizationId,turnId:reportTurn,
      runId,dispatchAttempt:2,nowMs:4});
    assert.equal(claimed.allowed,true,JSON.stringify(claimed));if(!claimed.allowed)throw new Error('dispatcher capability missing');
    const resumePermit='resume-worker',resumeParams={threadId,model:'gpt-6-astra',excludeTurns:true,
      cwd:nativeCwd,config:{features:{hooks:true},model_reasoning_effort:'medium'}};
    const beforeResumeThreads=threadReadCalls;
    requirementsAvailable=false;
    const missingHooks=await client.readCodexColdInputsBeforeResume(granted.authorizationId,resumeParams) as any;
    assert.equal(missingHooks.proven,false,JSON.stringify(missingHooks));
    assert.ok(missingHooks.reasons.some((reason:any)=>reason.code==='COLD_CONFIGURATION_REQUIREMENTS_MISSING'));
    assert.equal(threadReadCalls,beforeResumeThreads+1,'failed hook requirements stop before mutation permit preparation');
    requirementsAvailable=true;
    loadedTarget=true;
    const loadedTargetRefusal=await client.readCodexColdInputsBeforeResume(granted.authorizationId,resumeParams) as any;
    assert.equal(loadedTargetRefusal.proven,false,JSON.stringify(loadedTargetRefusal));
    assert.ok(loadedTargetRefusal.reasons.some((reason:any)=>reason.code==='COLD_NATIVE_THREAD_PRESENT_IN_LOADED_LIST'));
    loadedTarget=false;
    configMarker='changed-after-reservation';
    const changedConfig=await client.readCodexColdInputsBeforeResume(granted.authorizationId,resumeParams) as any;
    assert.equal(changedConfig.proven,false,JSON.stringify(changedConfig));
    assert.ok(changedConfig.reasons.some((reason:any)=>reason.code==='COLD_CONFIGURATION_OR_THREAD_CHANGED'));
    configMarker='baseline';
    const coldInputs=await client.readCodexColdInputsBeforeResume(granted.authorizationId,resumeParams) as any;
    assert.equal(coldInputs.proven,true,JSON.stringify(coldInputs));
    assert.equal(coldInputs.witness.witnessDigest,coverage.coldConstruction.witnessDigest);
    const retainedCold=auth.retainCodexRecoveryColdInputs(db,{authorizationId:granted.authorizationId,witness:coldInputs.witness,
      paramsDigest:coldInputs.paramsDigest,nowMs:5});
    assert.equal(retainedCold.allowed,true,JSON.stringify(retainedCold));
    const prepared=auth.prepareCodexRecoveryMutation(db,{authorizationId:granted.authorizationId,capability:claimed.capability,
      permitId:resumePermit,method:'thread/resume',params:resumeParams,nowMs:6});
    assert.equal(prepared.allowed,true,JSON.stringify(prepared));
    const consumed=auth.consumeCodexRecoveryMutation(db,{authorizationId:granted.authorizationId,capability:claimed.capability,
      permitId:resumePermit,intentId:resumePermit,params:resumeParams,nowMs:7});
    assert.equal(consumed.allowed,true,JSON.stringify(consumed));
    const responseResult={thread:{id:threadId,cwd:nativeCwd,path:originalPath,sessionId:threadId,historyMode:'legacy'},
      model:'gpt-6-astra',reasoningEffort:'medium'};
    const accepted=auth.recordCodexRecoveryMutationResponse(db,{authorizationId:granted.authorizationId,intentId:resumePermit,
      response:responseResult,nowMs:8});
    assert.equal(accepted.allowed,true,JSON.stringify(accepted));
    assert.equal((db.query('SELECT state FROM codex_mutation_intents WHERE intent_id=?').get(resumePermit) as any).state,'reconciled_applied');

    const checkpoint=line('event_msg',{type:'thread_settings_applied',thread_id:threadId,
      thread_settings:settings})+'\n';
    await appendFile(originalPath,checkpoint);
    const refreshed=await client.refreshOriginalCodexHistoryAfterResume(granted.authorizationId,resumeParams,responseResult) as any;
    assert.equal(refreshed.proven,true,JSON.stringify(refreshed));
    assert.equal(refreshed.witness.ownedResumeCheckpoint.intentId,resumePermit);
    assert.equal(refreshed.witness.ownedResumeCheckpoint.permitId,resumePermit);
    assert.equal(refreshed.witness.ownedResumeCheckpoint.recordCount,1);
    assert.equal(refreshed.witness.recordCount,coverage.witness.recordCount+1);
    assert.ok(!JSON.stringify(refreshed).includes('accepted original request'));
    assert.ok(refreshed.construction?.receiptDigest,'successful resume must return its source-derived construction receipt');
    const retainedConstruction=auth.retainCodexRecoveryColdConstruction(db,{authorizationId:granted.authorizationId,
      receipt:refreshed.construction,nowMs:9});
    assert.equal(retainedConstruction.allowed,true,JSON.stringify(retainedConstruction));
    const retained=auth.retainCodexRecoverySourceCheckpoint(db,{authorizationId:granted.authorizationId,result:refreshed,nowMs:10});
    assert.equal(retained.allowed,true,JSON.stringify(retained));
    const retainedPrivate=db.query('SELECT resume_intent_id,checkpoint_digest,witness_json,custody_json FROM codex_recovery_source_checkpoints WHERE authorization_id=?')
      .get(granted.authorizationId) as any;
    assert.equal(retainedPrivate.resume_intent_id,resumePermit);assert.ok(retainedPrivate.checkpoint_digest);
    assert.ok(!JSON.stringify(retainedPrivate).includes('accepted original request'));
    console.log('Codex original history worker: real SQLite snapshot/fence, actual App Server bridge read, private source witness, accepted resume receipt and exact one-record checkpoint passed');
  }finally{await client.close();}
}finally{
  appServer.stop(true);await rm(scratch,{recursive:true,force:true});
}
