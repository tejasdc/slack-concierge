import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION} from '../src/test-authorizations';
const scratch=mkdtempSync(join(tmpdir(),'concierge-binding-recovery-composed-'));
process.env.CONCIERGE_STATE_DIR=join(scratch,'state');process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
const releaseRoot=join(scratch,'sealed-release');process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT=releaseRoot;
process.env.CONCIERGE_TEST_MODE='1';process.env.CONCIERGE_TEST_AUTHORIZATION=IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION;
const [state,inputs,{inspectAcceptedBindingContinuation},{recoverAcceptedBindingCodex},registry,fences,auth,activation]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/codex-accepted-binding-snapshot'),
  import('../src/codex-accepted-binding-recovery'),import('../src/codex-managed-process-registry'),
  import('../src/codex-mutation-fence'),import('../src/codex-recovery-dispatch-authorization'),import('../src/codex-continuation-activation')]);
const {db,claimNextQueuedTurn,markTurnProviderAdmissionIntended,codexUnacknowledgedRecovery,codexRecoveryAttemptBudgetSpent,
  retryRunningTurnAfterProviderFailure}=state;
const {createNativeSession,retainSessionInput,enqueueSessionInput,nativeRunId,recordSessionEvent}=inputs;
fences.initializeCodexMutationFenceSchema(db);auth.initializeCodexRecoveryAuthorizationSchema(db);registry.initializeManagedCodexProcessRegistrySchema(db);
const nativeExecutable=join(scratch,'native','codex');mkdirSync(join(scratch,'native'),{recursive:true});
writeFileSync(nativeExecutable,'fixture identity file; never executed');
const helperBytes='fixture sealed helper; never executed';
const unsigned={format:2,files:{'control/codex-managed-launch.js':createHash('sha256').update(helperBytes).digest('hex')}};
const artifactDigest=createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
const artifact=join(releaseRoot,'releases',artifactDigest),helperPath=join(artifact,'control','codex-managed-launch.js');
mkdirSync(join(artifact,'control'),{recursive:true});writeFileSync(helperPath,helperBytes);
writeFileSync(join(artifact,'manifest.json'),JSON.stringify({...unsigned,artifact_digest:artifactDigest}));
const identity=(pid:number)=>({pid,startTicks:String(pid*10),executablePath:nativeExecutable});
const processRows=new Map([[100,identity(100)],[201,identity(201)],[200,{pid:200,startTicks:'2000',executablePath:'/fixture/bun'}]]);
const socketPath=join(scratch,'native-daemon.sock');
const proxySocket='/tmp/concierge-codex-proxy-composed-fixture/proxy.sock';
const proc={listPids:()=>[...processRows.keys()],identity:(pid:number)=>processRows.get(pid)??null,
  socketListeners:(_socket:string)=>[100],parentPid:(pid:number)=>pid===201?200:null,
  commandLine:(pid:number)=>pid===200?['/fixture/bun',helperPath,'--native',nativeExecutable,'--','app-server','proxy']
    :pid===201?[nativeExecutable,'app-server','proxy','--sock',proxySocket]:null,
  ownsUnixListener:(pid:number,socket:string)=>pid===200&&socket===proxySocket};
registry.registerManagedCodexChild({db,registration:{connectionId:'composed-proxy',permitId:'composed-process',kind:'rawproxy',
  threadScope:'*',mediated:true,evidenceIds:['composed-proxy','composed-process']},pid:201,nowMs:1,proc,releaseRoot});
let serial=0;
function seed(){
  const suffix=++serial,requestId=`composed-work:${suffix}`,threadId=`composed-native-thread:${suffix}`;
  const session=createNativeSession('codex',{title:'retained writing work',purpose:'same accepted work',origin:'native',model:'gpt-6-astra',
    reasoningEffort:'medium',providerRunner:null} as any);
  db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run(threadId,session.id);
  const save=(id:string,kind:any,origin:any,payload:any,extra:any={})=>retainSessionInput({id,sessionId:session.id,scope:'fixture',actionId:id,
    kind,origin,payload,...extra}).input;
  const create=save(`composed-create:${suffix}`,'create','agent',{provider:'codex',model:'gpt-6-astra',reasoningEffort:'medium',
    firstInput:{text:'original retained work'}}),createTurn=enqueueSessionInput(create.id).turn_id!;
  const source=save(`request:${requestId}`,'input','agent',{text:'preserve original writing obligations'},{requestId}),sourceTurn=enqueueSessionInput(source.id).turn_id!;
  const report=save(`report-back:${requestId}`,'input','service',{text:'exact retained service reminder',attachments:['retained-attachment']},
    {requestId,sourceInputId:source.id,sourceRunId:nativeRunId(sourceTurn)}),reportTurn=enqueueSessionInput(report.id).turn_id!;
  const infoRequest=`closed-info:${suffix}`,info=save(`request:${infoRequest}`,'input','agent',{text:'closed informational question'},{requestId:infoRequest});
  const infoTurn=enqueueSessionInput(info.id).turn_id!;
  for(const [row,turnId,acknowledged] of [[create,createTurn,true],[source,sourceTurn,true],[report,reportTurn,false],[info,infoTurn,false]] as const){
    const providerResult={text:acknowledged?'prior acknowledged writing checkpoint':'',sessionUUID:threadId,toolsUsed:acknowledged?['read']:[],
      providerTurnId:`composed-native:${turnId}`,model:'gpt-6-astra',durationMs:7};
    db.query(`UPDATE turns SET status='done',dispatch_attempt=1,provider_turn_id=?,outbound_text=?,
      provider_input_acknowledged_at=?,owner_instance_id=NULL,provider_admission_intended_at=CURRENT_TIMESTAMP,
      provider_started_at=CURRENT_TIMESTAMP,reasoning_effort='medium' WHERE id=?`)
      .run(providerResult.providerTurnId,JSON.stringify({version:1,result:providerResult}),acknowledged?'retained-ack':null,turnId);
    const admission={provider:'codex',inputId:row.id,runId:nativeRunId(turnId),bindingGeneration:1,model:'gpt-6-astra',nativeBinding:null};
    db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({state:'completed',admission}),row.id);
    recordSessionEvent({eventId:`result:${turnId}`,sessionId:session.id,inputId:row.id,turnId,kind:'result',
      payload:{...providerResult,runId:nativeRunId(turnId),inputId:row.id,turnId,sessionId:session.id}});
    recordSessionEvent({eventId:`attention:${row.id}:1`,sessionId:session.id,inputId:row.id,turnId,kind:'attention',payload:{dispatchAttempt:1}});
    recordSessionEvent({eventId:`prompt-cache-identity:${turnId}:1`,sessionId:session.id,turnId,kind:'prompt_cache_identity',payload:{effort:'medium'}});
  }
  const insertRequest=(id:string,target:string,effect:string,outcome:string|null)=>db.query(`INSERT INTO session_communication_requests(
    request_id,source_channel,source_message_ts,source_turn_id,source_session_id,source_root_ts,action_id,target_session_id,
    target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms,source_input_id,target_input_id,status,outcome)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,'fixture','source',sourceTurn,session.id,'root',id,session.id,'fixture','root',
      JSON.stringify({requestedEffect:effect}),'hash',0,0,source.id,target,'admitted',outcome);
  insertRequest(requestId,source.id,'work',null);insertRequest(infoRequest,info.id,'informational','failed');
  const inspect=()=>inspectAcceptedBindingContinuation({sessionId:session.id,inputId:report.id,requestId});
  const inspection=inspect();assert.equal(inspection.proven,true,JSON.stringify(inspection.reasons));
  if(!('decisionDigest' in inspection))throw new Error('source proof absent');
  const nativeOrder=[createTurn,sourceTurn,reportTurn,infoTurn].map(turnId=>({id:`composed-native:${turnId}`,status:'completed',error:null}));
  let validations=0,nativeReads=0;
  const client=(onItem?:(params:any)=>Promise<void>|void)=>({async request(method:string,params:any){
    nativeReads++;
    if(method==='thread/read')return {thread:{id:threadId,model:'gpt-6-astra',reasoningEffort:'medium',historyMode:'paginated',status:{type:'notLoaded'}}};
    if(method==='thread/turns/list')return {data:nativeOrder,nextCursor:null};
    if(method==='thread/items/list'){
      await onItem?.(params);
      return {data:params.turnId===`composed-native:${infoTurn}`?[{turnId:params.turnId,item:{id:`compaction:${infoTurn}`,type:'contextCompaction'}}]:[],nextCursor:null};
    }
    throw new Error(`Native mutation forbidden by fixture: ${method}`);
  }});
  const recovery=(nativeClient=client(),extra:any={})=>recoverAcceptedBindingCodex({sessionId:session.id,inputId:report.id,requestId,
    actionId:`recover:${suffix}`,sourceInputId:source.id,sourceRunId:nativeRunId(sourceTurn),socketPath,client:nativeClient,
    validateSource:()=>{validations++;},expectedDecisionDigest:inspection.decisionDigest,...extra},{writerProc:proc});
  const retained=()=>JSON.stringify({source:db.query('SELECT * FROM session_inputs WHERE id=?').get(source.id),
    creation:db.query('SELECT * FROM session_inputs WHERE id=?').get(create.id),
    firstAdmission:db.query('SELECT receipt_json FROM session_inputs WHERE id=?').get(report.id),
    results:db.query("SELECT * FROM session_owner_events WHERE session_id=? AND kind='result' ORDER BY sequence").all(session.id),
    request:db.query('SELECT * FROM session_communication_requests WHERE request_id=?').get(requestId)});
  return {session,requestId,threadId,source,report,reportTurn,infoTurn,client,recovery,inspect,retained,counts:()=>({validations,nativeReads}),save};
}
try {
  const activationBefore=db.query('SELECT COUNT(*) AS count FROM codex_unacknowledged_recoveries').get() as any;
  assert.deepEqual(activation.codexContinuationActivationReadiness().reasons.map(reason=>reason.code),
    ['LEGACY_NATIVE_ISSUED_SEND_DRAIN_UNPROVEN','COLD_RESUME_HOOK_CONFIGURATION_UNPROVEN']);
  assert.throws(()=>activation.requireCodexContinuationActivation(),/LEGACY_NATIVE_ISSUED_SEND_DRAIN_UNPROVEN.*COLD_RESUME_HOOK_CONFIGURATION_UNPROVEN/);
  assert.deepEqual(db.query('SELECT COUNT(*) AS count FROM codex_unacknowledged_recoveries').get(),activationBefore,
    'default production activation refusal creates no reservation');
  const first=seed(),before=first.retained();
  const recovered=await first.recovery();assert.equal(recovered.status,'requeued');
  assert.equal(first.retained(),before,'actual recovery preserves original source, first admission, all historical results and open work custody');
  const reservation=codexUnacknowledgedRecovery(first.report.id)!;
  const proof=JSON.parse(reservation.proof_json);
  assert.equal(proof.continuation.basis,'accepted_binding_continuation');
  assert.equal(proof.continuation.identity.binding.effort,'medium');assert.equal(proof.continuation.identity.binding.runner,null);
  assert.equal(proof.attempts.length,1,'budget counts selected attempts only');
  assert.equal(proof.native.coverage.length,2,'complete native suffix includes later closed informational compaction');
  const reads=first.counts().nativeReads;
  const duplicate=await first.recovery();assert.equal(duplicate.status,'already_recovered');
  assert.equal(first.counts().nativeReads,reads,'duplicate reservation is returned without another native read or retry');
  const claim=claimNextQueuedTurn('composed-owner');
  assert.equal(claim?.turn_id,first.reportTurn);assert.equal(claim?.dispatch_attempt,2);assert.equal(claim?.reasoning_effort,'medium');
  const authorization=auth.getCodexRecoveryAuthorizationForInput(db,first.report.id)!;
  assert.equal(authorization.effort,'medium');
  assert.equal(auth.claimCodexRecoveryDispatchCapability(db,{authorizationId:authorization.authorizationId,turnId:first.reportTurn,
    runId:recovered.runId,dispatchAttempt:2,nowMs:20}).allowed,true,'real queue claim preserves the source authorization fingerprint');
  assert.equal(markTurnProviderAdmissionIntended(first.reportTurn,'composed-owner',2),true);
  assert.equal(markTurnProviderAdmissionIntended(first.reportTurn,'composed-owner',2),false);
  assert.equal(codexRecoveryAttemptBudgetSpent(first.reportTurn),true);
  assert.equal(retryRunningTurnAfterProviderFailure({turnId:first.reportTurn,ownerInstanceId:'composed-owner',dispatchAttempt:2,
    error:'another empty completion',nextAttemptMs:Date.now()}),false);
  assert.equal(codexUnacknowledgedRecovery(first.report.id)!.proof_json,reservation.proof_json);
  db.query("UPDATE turns SET status='done',owner_instance_id=NULL WHERE id=?").run(first.reportTurn);

  const racing=seed(),raceBefore=racing.retained();
  let entered=0,release!:()=>void;const bothReading=new Promise<void>(resolve=>{release=resolve;});
  const barrier=async(params:any)=>{if(params.turnId===`composed-native:${racing.reportTurn}`){entered++;if(entered===2)release();await bothReading;}};
  const [left,right]=await Promise.all([racing.recovery(racing.client(barrier)),racing.recovery(racing.client(barrier),{actionId:'different-racing-action'})]);
  assert.deepEqual([left.status,right.status].sort(),['already_recovered','requeued']);
  assert.equal((db.query('SELECT COUNT(*) AS count FROM codex_unacknowledged_recoveries WHERE accepted_input_id=?').get(racing.report.id) as any).count,1);
  assert.equal((db.query('SELECT COUNT(*) AS count FROM codex_recovery_dispatch_authorizations WHERE accepted_input_id=?').get(racing.report.id) as any).count,1);
  assert.equal(racing.retained(),raceBefore,'racing recovery retains exact original admissions and results');

  const stale=seed();let changed=false;
  await assert.rejects(()=>stale.recovery(stale.client(()=>{
    if(!changed){changed=true;stale.save('composed-held-pause','action','human',{action:'pause'});}
  })),/watermark, source custody, controls, binding or attempts changed/);
  assert.equal(codexUnacknowledgedRecovery(stale.report.id),null,'never-admitted control accepted during read prevents atomic reservation');
  assert.equal((db.query('SELECT status FROM turns WHERE id=?').get(stale.reportTurn) as any).status,'done');
  const writerChanged=seed();let newWriter=false;
  await assert.rejects(()=>writerChanged.recovery(writerChanged.client(()=>{
    if(!newWriter){newWriter=true;processRows.set(998,identity(998));}
  })),/Managed writer coverage changed before atomic reservation/);
  assert.equal(codexUnacknowledgedRecovery(writerChanged.report.id),null,'real second process-coverage check rejects a writer that appeared during history reads');
  processRows.delete(998);
  const unmanaged=seed();processRows.set(999,identity(999));
  const unmanagedReads=unmanaged.counts().nativeReads;
  await assert.rejects(()=>unmanaged.recovery(),/UNMEDIATED_NATIVE_WRITER:999/);
  assert.equal(unmanaged.counts().nativeReads,unmanagedReads,'unregistered native writer refuses before any native read');
  assert.equal(codexUnacknowledgedRecovery(unmanaged.report.id),null);
  console.log('Composed accepted-binding recovery: real source/native proofs, managed process evidence, Medium queue/custody, race dedup, immutable history and production activation refusal passed');
}finally{db.close();rmSync(scratch,{recursive:true,force:true});}
