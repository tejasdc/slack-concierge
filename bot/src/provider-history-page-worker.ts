/** Provider page projection belongs on a separate event loop from sends and page routing. */
import {parentPort} from 'node:worker_threads';
import {SessionOwner} from './session-owner';
import {log} from './log';
import {sharedCodexAppServerClient} from './codex-app-server-client';
import {readClaudeHistory,readCodexHistory,readCodexHistoryWindow} from './provider-history';
import {db,getSessionById} from './state';
import {providerRunnerForSession,sessionMetadata} from './session-inputs';
import {inspectAcceptedBindingContinuation} from './codex-accepted-binding-snapshot';
import {acceptedBindingSnapshotDigest} from './codex-accepted-binding-continuation';
import {proveCodexContinuationNativeInterval} from './codex-continuation-native-interval';
import {readCodexOriginalHistoryCoverage,revalidateCodexOriginalHistorySource,
  refreshCodexOriginalHistoryAfterOwnedResume} from './codex-original-history-coverage';
import {getCodexThreadMutationFence} from './codex-mutation-fence';
import {resolveOwnerContextDiagnosticEvidence,OwnerContextRefusal,type OwnerContextCandidate} from './codex-owner-context-diagnostic';
import {codexRecoverySourceFingerprint} from './codex-recovery-dispatch-authorization';
import {readCodexColdConstructionWitness,compareCodexColdConstructionWitnesses,validateCodexColdResumeParameters,validateCodexColdResume} from './codex-cold-construction';
import {homedir} from 'node:os';
import {join} from 'node:path';

type Work={id:number;operation:'page'|'delta'|'prepare';sessionId:string;cwd:string;cursor:string|null;limit:number;after:string|null;
  want?:{dialogue:number;untilInput:boolean};thread?:string}|
  {id:number;operation:'original-recovery-coverage';sessionId:number;inputId:string;requestId:string;runId:string;fenceId:string;
    expectedDecisionDigest:string;expectedNativeDigest:string;diagnosticContextCandidates?:readonly OwnerContextCandidate[]}|
  {id:number;operation:'original-recovery-cold-before-resume';authorizationId:string;params:Record<string,unknown>}|
  {id:number;operation:'original-recovery-refresh-after-resume';authorizationId:string;params:Record<string,unknown>;responseResult:unknown};
if(!parentPort)throw new Error('HISTORY_PAGE_WORKER_PARENT_REQUIRED');
// Connect to Codex's App Server when the worker starts, not inside the first history open:
// after a restart the first open of each Codex conversation took 0.3-0.5 s against 0.05-0.25 s
// once warm (2026-10-30). A failed early connection is retried by the first request as before.
void sharedCodexAppServerClient().connect().catch(()=>{});
const refuseCoverage=(code:string,evidence:string[]=[])=>(
  {proven:false as const,reasons:[{code,evidence}]});
function exactRecoverySnapshot(input:Extract<Work,{operation:'original-recovery-coverage'}>){
  const inspection=inspectAcceptedBindingContinuation({sessionId:input.sessionId,inputId:input.inputId,
    requestId:input.requestId,includeSnapshot:true});
  if(!inspection.proven||!('snapshot'in inspection)||!inspection.snapshot)
    return {refusal:refuseCoverage('CURRENT_ACCEPTED_BINDING_OR_CONTROLS_REFUSE',
      inspection.reasons.map(reason=>reason.code))};
  const snapshot=inspection.snapshot,session=(snapshot.ownerSnapshot as any)?.session;
  if(!session||session.id!==input.sessionId||snapshot.selected.input.id!==input.inputId
    ||snapshot.selected.turn.native_run_id!==input.runId||snapshot.binding.provider!=='codex'
    ||snapshot.binding.sessionId!==input.sessionId||!snapshot.binding.threadId)
    return {refusal:refuseCoverage('EXACT_RECOVERY_SOURCE_IDENTITY_CHANGED')};
  const fence=getCodexThreadMutationFence(db,snapshot.binding.threadId);
  return {snapshot,inspection,fence,session};
}
async function originalRecoveryCoverage(input:Extract<Work,{operation:'original-recovery-coverage'}>){
  const current=exactRecoverySnapshot(input);
  if(current.refusal)return current.refusal;
  const {snapshot,inspection,fence,session}=current;
  if(inspection.decisionDigest!==input.expectedDecisionDigest)return refuseCoverage('EXPECTED_CONTINUATION_DIGEST_CHANGED');
  if(!fence||fence.fenceId!==input.fenceId||fence.acceptedInputId!==input.inputId||fence.runId!==input.runId
    ||fence.dispatchAttempt!==snapshot.selected.turn.dispatch_attempt+1
    ||fence.bindingDigest!==acceptedBindingSnapshotDigest(snapshot.binding))return refuseCoverage('EXACT_ACTIVE_FENCE_CHANGED');
  const metadata=sessionMetadata(session),runner=providerRunnerForSession(session);
  if(runner.status!=='bound'||runner.runner!==snapshot.binding.runner)return refuseCoverage('CURRENT_RUNNER_BINDING_CHANGED');
  if(snapshot.binding.runner!==null)return refuseCoverage('ORIGINAL_HISTORY_REMOTE_SOURCE_UNSUPPORTED');
  const account=typeof metadata.providerAccount==='string'?metadata.providerAccount:null;
  const client={request:(method:'thread/read'|'thread/turns/list'|'thread/items/list',params:Record<string,unknown>)=>
    sharedCodexAppServerClient().request(method,params)};
  const native=await proveCodexContinuationNativeInterval({snapshot,client});
  if(!native.proven)return {proven:false as const,reasons:native.reasons};
  if(native.nativeDigest!==input.expectedNativeDigest)return refuseCoverage('EXPECTED_NATIVE_DIGEST_CHANGED');
  const codexHome=process.env.CODEX_HOME?.trim()||join(homedir(),'.codex');
  let ownerContextEvidence;
  if(input.diagnosticContextCandidates!==undefined){
    try{ownerContextEvidence=resolveOwnerContextDiagnosticEvidence({snapshot,attempts:native.attempts,
      candidates:input.diagnosticContextCandidates,status:'owner_snapshot'});}
    catch(error){if(error instanceof OwnerContextRefusal)return refuseCoverage(error.code);throw error;}
  }
  const result=await readCodexOriginalHistoryCoverage({binding:snapshot.binding,selectedInputId:input.inputId,
    attempts:native.attempts,nativeTurnOrder:native.nativeTurnOrder,codexHome,client,ownerContextEvidence});
  if(!result.proven&&!('diagnostic'in result))return result;
  if(result.proven&&!revalidateCodexOriginalHistorySource(result.custody,result.witness).valid)
    return refuseCoverage('ORIGINAL_HISTORY_SOURCE_CHANGED');
  // Re-read the entire owner/native basis after I/O. A stable digest is the exact
  // snapshot comparison; it does not upgrade the browser's or caller's assertion.
  const after=exactRecoverySnapshot(input);
  if(after.refusal)return after.refusal;
  if(after.inspection.decisionDigest!==input.expectedDecisionDigest||after.fence?.fenceId!==input.fenceId
    ||after.fence.state!=='active'||after.fence.acceptedInputId!==input.inputId||after.fence.runId!==input.runId
    ||after.fence.dispatchAttempt!==after.snapshot.selected.turn.dispatch_attempt+1
    ||after.fence.bindingDigest!==acceptedBindingSnapshotDigest(after.snapshot.binding))
    return refuseCoverage('SOURCE_CONTROL_OR_FENCE_CHANGED_DURING_READ');
  const afterMetadata=sessionMetadata(after.session),afterRunner=providerRunnerForSession(after.session);
  if(afterRunner.status!=='bound'||afterRunner.runner!==runner.runner
    ||(typeof afterMetadata.providerAccount==='string'?afterMetadata.providerAccount:null)!==account)
    return refuseCoverage('SOURCE_ACCOUNT_OR_RUNNER_CHANGED_DURING_READ');
  const afterNative=await proveCodexContinuationNativeInterval({snapshot:after.snapshot,client});
  if(!afterNative.proven)return {proven:false as const,reasons:afterNative.reasons};
  if(afterNative.nativeDigest!==input.expectedNativeDigest)return refuseCoverage('NATIVE_INTERVAL_CHANGED_DURING_READ');
  if(!result.proven)return result;
  const custody=result.custody,witness=result.witness;
  if(!revalidateCodexOriginalHistorySource(custody,witness).valid)
    return refuseCoverage('ORIGINAL_HISTORY_SOURCE_CHANGED_DURING_READ');
  const construction=await readCodexColdConstructionWitness({db,owner:after.fence!,binding:after.snapshot.binding,client:sharedCodexAppServerClient()});
  if(!construction.proven)return construction;
  return {proven:true as const,witness,custody,coldConstruction:construction.witness};
}
async function coldBeforeResume(input:Extract<Work,{operation:'original-recovery-cold-before-resume'}>){
  const auth=db.query('SELECT * FROM codex_recovery_dispatch_authorizations WHERE authorization_id=?').get(input.authorizationId) as any;
  if(!auth)return refuseCoverage('RECOVERY_AUTHORIZATION_NOT_FOUND');
  let proof:any,binding:any;
  try{proof=JSON.parse((db.query('SELECT proof_json FROM codex_unacknowledged_recoveries WHERE accepted_input_id=?').get(auth.accepted_input_id) as any)?.proof_json);binding=JSON.parse(auth.binding_json);}
  catch{return refuseCoverage('RETAINED_RECOVERY_PROOF_INVALID');}
  try{if(codexRecoverySourceFingerprint(db,auth)!==auth.source_fingerprint)return refuseCoverage('SOURCE_FINGERPRINT_CHANGED_BEFORE_COLD_RESUME');}
  catch{return refuseCoverage('SOURCE_CONTROLS_REFUSE_BEFORE_COLD_RESUME');}
  const fence=getCodexThreadMutationFence(db,auth.thread_id);
  if(!fence||fence.fenceId!==auth.fence_id)return refuseCoverage('EXACT_ACTIVE_FENCE_CHANGED');
  const current=await readCodexColdConstructionWitness({db,owner:fence,binding,client:sharedCodexAppServerClient()});
  if(!current.proven)return current;
  if(!proof?.coldResume?.construction)return refuseCoverage('COLD_CONSTRUCTION_WITNESS_NOT_RETAINED');
  const same=compareCodexColdConstructionWitnesses(proof.coldResume.construction,current.witness);
  if(!same.same)return refuseCoverage(same.reason);
  const params=validateCodexColdResumeParameters({witness:current.witness,params:input.params});
  if(!params.allowed)return refuseCoverage(params.reason);
  if(!revalidateCodexOriginalHistorySource(proof.native.originalHistory.custody,proof.native.originalHistory.witness).valid)
    return refuseCoverage('ORIGINAL_HISTORY_SOURCE_CHANGED_BEFORE_COLD_RESUME');
  return {proven:true as const,witness:current.witness,paramsDigest:params.paramsDigest};
}
async function originalHistoryAfterOwnedResume(input:Extract<Work,{operation:'original-recovery-refresh-after-resume'}>){
  const authorization=db.query('SELECT * FROM codex_recovery_dispatch_authorizations WHERE authorization_id=?')
    .get(input.authorizationId) as any;
  if(!authorization)return refuseCoverage('RECOVERY_AUTHORIZATION_NOT_FOUND');
  const reservation=db.query('SELECT * FROM codex_unacknowledged_recoveries WHERE accepted_input_id=?')
    .get(authorization.accepted_input_id) as any;
  let proof:any;
  try{proof=JSON.parse(reservation?.proof_json??'null');}catch{return refuseCoverage('RETAINED_RECOVERY_PROOF_INVALID');}
  const original=proof?.native?.originalHistory;
  if(!reservation||!original?.witness||!original?.custody)
    return refuseCoverage('ORIGINAL_HISTORY_CUSTODY_NOT_RETAINED');
  try{
    if(codexRecoverySourceFingerprint(db,authorization)!==authorization.source_fingerprint)
      return refuseCoverage('SOURCE_FINGERPRINT_CHANGED_BEFORE_RESUME_CHECKPOINT');
  }catch{return refuseCoverage('SOURCE_CONTROLS_REFUSE_BEFORE_RESUME_CHECKPOINT');}
  const fence=getCodexThreadMutationFence(db,authorization.thread_id);
  if(!fence||fence.fenceId!==authorization.fence_id||fence.acceptedInputId!==authorization.accepted_input_id
    ||fence.runId!==authorization.run_id||fence.dispatchAttempt!==authorization.dispatch_attempt
    ||fence.bindingDigest!==acceptedBindingSnapshotDigest(JSON.parse(authorization.binding_json)))
    return refuseCoverage('EXACT_ACTIVE_FENCE_CHANGED_BEFORE_RESUME_CHECKPOINT');
  const permitId=authorization.resume_permit_id;
  const intent=permitId?db.query('SELECT intent_id,state,response_kind,response_digest,method,thread_id,permit_id FROM codex_mutation_intents WHERE permit_id=?')
    .get(permitId) as any:null;
  // An accepted resume is immediately terminally reconciled by the recovery
  // response recorder. Both the retained response and its applied reconciliation
  // are required; requiring response_received here would reject the real path.
  if(!intent||!['response_received','reconciled_applied'].includes(intent.state)||intent.response_kind!=='accepted'
    ||!intent.response_digest||intent.method!=='thread/resume'
    ||intent.thread_id!==authorization.thread_id)
    return refuseCoverage('EXACT_OWNED_RESUME_RESPONSE_NOT_RETAINED');
  const coldInputs=db.query('SELECT witness_json FROM codex_recovery_cold_inputs WHERE authorization_id=?').get(input.authorizationId) as any;
  let coldWitness:any;try{coldWitness=JSON.parse(coldInputs?.witness_json??'null');}catch{}
  if(!coldWitness)return refuseCoverage('COLD_CONSTRUCTION_INPUTS_NOT_RETAINED');
  const constructed=validateCodexColdResume({db,authorizationId:input.authorizationId,intentId:intent.intent_id,
    witness:coldWitness,params:input.params,responseResult:input.responseResult});
  if(!constructed.allowed)return refuseCoverage(constructed.reason);
  const refreshed=await refreshCodexOriginalHistoryAfterOwnedResume({db,intentId:intent.intent_id,
    witness:original.witness,custody:original.custody});
  if(!refreshed.proven)return refreshed;
  if(!revalidateCodexOriginalHistorySource(refreshed.custody,refreshed.witness).valid)
    return refuseCoverage('ORIGINAL_HISTORY_SOURCE_CHANGED_AFTER_OWNED_RESUME');
  try{
    if(codexRecoverySourceFingerprint(db,authorization)!==authorization.source_fingerprint)
      return refuseCoverage('SOURCE_FINGERPRINT_CHANGED_DURING_RESUME_CHECKPOINT');
  }catch{return refuseCoverage('SOURCE_CONTROLS_REFUSE_DURING_RESUME_CHECKPOINT');}
  const afterFence=getCodexThreadMutationFence(db,authorization.thread_id);
  if(!afterFence||afterFence.fenceId!==authorization.fence_id||afterFence.acceptedInputId!==authorization.accepted_input_id
    ||afterFence.runId!==authorization.run_id||afterFence.dispatchAttempt!==authorization.dispatch_attempt)
    return refuseCoverage('EXACT_ACTIVE_FENCE_CHANGED_DURING_RESUME_CHECKPOINT');
  return {proven:true as const,witness:refreshed.witness,custody:refreshed.custody,
    intentId:intent.intent_id,permitId,construction:constructed.receipt};
}
parentPort.on('message',async(input:Work)=>{
  try {
    if(input.operation==='original-recovery-cold-before-resume'){
      parentPort!.postMessage({id:input.id,result:await coldBeforeResume(input)});return;
    }
    if(input.operation==='original-recovery-refresh-after-resume'){
      if(!Number.isSafeInteger(input.id)||input.id<1||typeof input.authorizationId!=='string'
        ||input.authorizationId.length<1||input.authorizationId.length>200)
        throw new Error('INVALID_ORIGINAL_HISTORY_RESUME_WORK');
      parentPort!.postMessage({id:input.id,result:await originalHistoryAfterOwnedResume(input)});
      return;
    }
    if(input.operation==='original-recovery-coverage'){
      if(!Number.isSafeInteger(input.id)||input.id<1||!Number.isSafeInteger(input.sessionId)||input.sessionId<1
        ||typeof input.inputId!=='string'||input.inputId.length<1||input.inputId.length>200
        ||typeof input.requestId!=='string'||input.requestId.length<1||input.requestId.length>200
        ||typeof input.runId!=='string'||input.runId.length<1||input.runId.length>200
        ||typeof input.fenceId!=='string'||input.fenceId.length<1||input.fenceId.length>200
        ||! /^[a-f0-9]{64}$/.test(input.expectedDecisionDigest)||! /^[a-f0-9]{64}$/.test(input.expectedNativeDigest))
        throw new Error('INVALID_ORIGINAL_HISTORY_COVERAGE_WORK');
      parentPort!.postMessage({id:input.id,result:await originalRecoveryCoverage(input)});
      return;
    }
    // Codex activity tops up that conversation's kept window, so the next open reads it ready.
    if(input.operation==='prepare'){
      if(!Number.isSafeInteger(input.id)||typeof input.sessionId!=='string'||!/^concierge:[1-9][0-9]*$/.test(input.sessionId)
        ||typeof input.thread!=='string'||!/^[A-Za-z0-9-]{8,80}$/.test(input.thread))
        throw new Error('INVALID_HISTORY_PAGE_WORK');
      const sessionId=Number(input.sessionId.slice('concierge:'.length)),session=Number.isSafeInteger(sessionId)?getSessionById(sessionId):null;
      const metadata=session?sessionMetadata(session):{};
      await readCodexHistoryWindow({sessionUuid:input.thread,
        ...(typeof (metadata as any).providerRunner==='string'?{runner:(metadata as any).providerRunner}:{}),
        ...(typeof (metadata as any).providerAccount==='string'?{account:(metadata as any).providerAccount}:{})});
      parentPort!.postMessage({id:input.id,result:{prepared:true}});
      return;
    }
    if(!Number.isSafeInteger(input.id)||input.id<1||!/^concierge:[1-9][0-9]*$/.test(input.sessionId)
      ||!['page','delta'].includes(input.operation)||typeof input.cwd!=='string'||input.cwd.length>4096
      ||!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>100
      ||input.want!==undefined&&(!Number.isSafeInteger(input.want.dialogue)||input.want.dialogue<0||input.want.dialogue>40||typeof input.want.untilInput!=='boolean'))
      throw new Error('INVALID_HISTORY_PAGE_WORK');
    const owner=new SessionOwner({wake(){},steer(){return false;},async stop(){return false;},available(){return false;},
      history:async(session,cursor,limit)=>{
        if(!session.agent_session_uuid)return null;
        const metadata=sessionMetadata(session);
        const options={sessionUuid:session.agent_session_uuid,cwd:input.cwd,cursor,limit,ownerSessionId:session.id,
          ...(typeof (metadata as any).providerRunner==='string'?{runner:(metadata as any).providerRunner}:{}),
          ...(typeof (metadata as any).providerAccount==='string'?{account:(metadata as any).providerAccount}:{})};
        // The newest page of a window read is the conversation's kept window, not a listing.
        // A kept window that cannot be read or topped up falls back to the ordinary listing.
        if(session.provider_id==='codex'&&cursor===null&&input.operation==='page'&&input.want&&(input.want.dialogue||input.want.untilInput))
          try{return await readCodexHistoryWindow({sessionUuid:session.agent_session_uuid,want:input.want,
            ...(typeof (metadata as any).providerRunner==='string'?{runner:(metadata as any).providerRunner}:{}),
            ...(typeof (metadata as any).providerAccount==='string'?{account:(metadata as any).providerAccount}:{})});}
          catch(error){log('warn','codex_history_window_unavailable',{session_id:session.id,error:String(error).slice(0,300)});}
        return session.provider_id==='claude-code'?readClaudeHistory(options):session.provider_id==='codex'?readCodexHistory(options):null;
      }},input.cwd);
    const result=input.operation==='page'
      // A window is collected here, page after page, rather than one worker round trip per page.
      ?await owner.history(input.sessionId,input.cursor,input.limit,false,input.want)
      :await owner.historyDelta(input.sessionId,input.after??'');
    parentPort!.postMessage({id:input.id,result});
  } catch(error) {
    parentPort!.postMessage({id:input.id,error:{message:error instanceof Error?error.message:'History page failed.',
      status:typeof error==='object'&&error!==null&&'status' in error?Number(error.status):503}});
  }
});
