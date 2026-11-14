import type {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {acceptedBindingSnapshotDigest as digest} from './codex-accepted-binding-continuation';
import type {ContinuationBinding} from './codex-accepted-binding-continuation';
import {getCodexThreadMutationFence,type CodexMutationFence} from './codex-mutation-fence';
import {assessManagedHookInstallerCoverage,codexManagedHookConfigStatus} from './codex-managed-hook-config';

export interface CodexColdConstructionReadClient {
  request(method:'thread/read'|'thread/loaded/list'|'configRequirements/read'|'config/read',params:Record<string,unknown>):Promise<any>;
}

export interface CodexColdConstructionOwner extends CodexMutationFence {
  bindingDigest:string;
}

interface ColdConstructionProcessSource {
  listPids():number[];
  identity(pid:number):{pid:number;bootId:string;startTicks:string;executablePath:string}|null;
  parentPid(pid:number):number|null;
  commandLine(pid:number):string[]|null;
}

export interface CodexColdConstructionWitness {
  policy:'codex_cold_resume_construction_v1';
  threadId:string;
  fenceId:string;
  acceptedInputId:string;
  runId:string;
  dispatchAttempt:number;
  bindingDigest:string;
  cwdDigest:string;
  nativePathDigest:string;
  nativeSessionIdDigest:string;
  nativeHistoryModeDigest:string;
  model:string;
  effort:'medium';
  threadObservationDigest:string;
  loadedThreadsDigest:string;
  requirementsDigest:string;
  effectiveConfigDigest:string;
  requiredHandlerDigest:string;
  witnessDigest:string;
}

export interface CodexColdResumeReceipt {
  policy:'codex_cold_resume_accepted_v1';
  threadId:string;
  fenceId:string;
  authorizationId:string;
  intentId:string;
  bindingDigest:string;
  coldWitnessDigest:string;
  paramsDigest:string;
  responseDigest:string;
  receiptDigest:string;
}

type Refusal={proven:false;reasons:Array<{code:string;evidence:string[]}>};
type Proven={proven:true;witness:CodexColdConstructionWitness};
type WitnessResult=Proven|Refusal;
const isText=(value:unknown):value is string=>typeof value==='string'&&value.length>0;
const isDigest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
class ColdConstructionRefusal extends Error {constructor(readonly code:string,evidence:string[]=[]){super(code);this.evidence=evidence;}
  evidence:string[];}
const refuse=(code:string,...evidence:string[]):never=>{throw new ColdConstructionRefusal(code,evidence);};

function fenceMatches(db:Database,owner:CodexColdConstructionOwner){
  if(!isText(owner.threadId)||!isText(owner.fenceId)||!isText(owner.acceptedInputId)||!isText(owner.runId)
    ||!Number.isSafeInteger(owner.dispatchAttempt)||owner.dispatchAttempt<1||!isDigest(owner.bindingDigest))return false;
  const fence=getCodexThreadMutationFence(db,owner.threadId);
  return !!fence&&fence.state==='active'&&fence.fenceId===owner.fenceId&&fence.threadId===owner.threadId
    &&fence.acceptedInputId===owner.acceptedInputId&&fence.runId===owner.runId
    &&fence.dispatchAttempt===owner.dispatchAttempt&&fence.bindingDigest===owner.bindingDigest;
}

function isRecord(value:unknown):value is Record<string,any>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function canonicalSystemDir(){
  const value=process.env.CODEX_SYSTEM_DIR||'/etc/codex';
  if(!value.startsWith('/'))refuse('COLD_HOOK_SYSTEM_DIRECTORY_NOT_ABSOLUTE');
  return resolve(value);
}

async function readLoadedThreads(client:CodexColdConstructionReadClient):Promise<string[]> {
  const ids:string[]=[],seenCursors=new Set<string>();let cursor:string|null=null;
  do {
    let page:any;
    try{page=await client.request('thread/loaded/list',{...(cursor===null?{}:{cursor}),limit:100});}
    catch{refuse('COLD_NATIVE_LOADED_THREADS_READ_FAILED');}
    if(!isRecord(page)||!Array.isArray(page.data)||!Object.hasOwn(page,'nextCursor')
      ||page.nextCursor!==null&&!isText(page.nextCursor))refuse('COLD_NATIVE_LOADED_THREADS_PAGE_INVALID');
    for(const id of page.data){if(!isText(id))refuse('COLD_NATIVE_LOADED_THREADS_ID_INVALID');ids.push(id);}
    cursor=page.nextCursor;
    if(cursor!==null){if(seenCursors.has(cursor))refuse('COLD_NATIVE_LOADED_THREADS_CURSOR_LOOP');seenCursors.add(cursor);}
  }while(cursor!==null);
  if(new Set(ids).size!==ids.length)refuse('COLD_NATIVE_LOADED_THREADS_DUPLICATE_ID');
  return ids.sort();
}

function exactRequiredHandler(requirements:any,systemDir:string){
  if(!isRecord(requirements)||requirements.featureRequirements?.hooks!==true)
    refuse('COLD_HOOK_FEATURE_REQUIREMENT_NOT_ENABLED');
  const hooks=requirements.hooks,managedDir=resolve(systemDir,'hooks');
  if(!isRecord(hooks)||hooks.managedDir!==managedDir||hooks.windowsManagedDir!=null)
    refuse('COLD_MANAGED_HOOK_DIRECTORY_MISMATCH');
  const groups=hooks.UserPromptSubmit;
  if(!Array.isArray(groups)||groups.length!==1)refuse('COLD_USER_PROMPT_HOOK_GROUP_MISMATCH');
  const group=groups[0];
  if(!isRecord(group)||group.matcher!==null||!Array.isArray(group.hooks)||group.hooks.length!==1)
    refuse('COLD_USER_PROMPT_HOOK_MATCHER_OR_HANDLER_MISMATCH');
  const handler=group.hooks[0],command=resolve(managedDir,'concierge-model-start');
  if(!isRecord(handler)||handler.type!=='command'||handler.command!==command||handler.async!==false
    ||handler.timeoutSec!==20||handler.statusMessage!=='Checking Astra escalation reason'
    ||handler.commandWindows!=null||handler.additionalContextLimit!=null
    ||Object.keys(handler).some(key=>!['type','command','async','timeoutSec','statusMessage','commandWindows','additionalContextLimit'].includes(key)))
    refuse('COLD_USER_PROMPT_MANAGED_HANDLER_MISMATCH');
  return digest({managedDir,groups});
}

async function readObservation(input:{db:Database;owner:CodexColdConstructionOwner;binding:ContinuationBinding;
  client:CodexColdConstructionReadClient;systemDir:string}){
  const {db,owner,binding,client,systemDir}=input;
  let threadRead:any,requirementsRead:any,configRead:any,loaded:string[];
  try{
    threadRead=await client.request('thread/read',{threadId:owner.threadId,includeTurns:false});
    loaded=await readLoadedThreads(client);
    requirementsRead=await client.request('configRequirements/read',{});
    const cwd=threadRead?.thread?.cwd;
    if(!isText(cwd)||!cwd.startsWith('/'))refuse('COLD_NATIVE_THREAD_CWD_INVALID');
    configRead=await client.request('config/read',{cwd,includeLayers:true});
  }catch(error){
    if(error instanceof ColdConstructionRefusal)throw error;
    refuse('COLD_NATIVE_CONFIGURATION_READ_FAILED');
  }
  if(!isRecord(threadRead)||!isRecord(threadRead.thread))refuse('COLD_NATIVE_THREAD_READ_INVALID');
  const thread=threadRead.thread;
  if(thread.id!==owner.threadId||thread.status?.type!=='notLoaded'||!isText(thread.cwd)||!thread.cwd.startsWith('/')
    ||thread.model!==binding.model||thread.reasoningEffort!==binding.effort
    ||thread.forkedFromId!=null||thread.parentThreadId!=null)
    refuse('COLD_NATIVE_THREAD_NOT_EXACTLY_UNLOADED');
  if(loaded.includes(owner.threadId))refuse('COLD_NATIVE_THREAD_PRESENT_IN_LOADED_LIST');
  const req=requirementsRead?.requirements;
  if(!isRecord(requirementsRead)||!req)refuse('COLD_CONFIGURATION_REQUIREMENTS_MISSING');
  const handlerDigest=exactRequiredHandler(req,systemDir);
  if(!isRecord(configRead)||!isRecord(configRead.config)||!isRecord(configRead.origins)||!Array.isArray(configRead.layers))
    refuse('COLD_EFFECTIVE_CONFIG_READ_INVALID');
  const configFeatures=configRead.config.features;
  if(configFeatures!==undefined&&configFeatures!==null
    &&(!isRecord(configFeatures)||configFeatures.hooks!==undefined&&configFeatures.hooks!==true))
    refuse('COLD_EFFECTIVE_HOOK_FEATURE_CONFLICT');
  return {
    threadObservationDigest:digest({id:thread.id,cwd:thread.cwd,status:thread.status,path:thread.path??null,
      sessionId:thread.sessionId??null,historyMode:thread.historyMode??null,forkedFromId:thread.forkedFromId??null,
      parentThreadId:thread.parentThreadId??null}),
    loadedThreadsDigest:digest(loaded),
    requirementsDigest:digest(requirementsRead),
    effectiveConfigDigest:digest(configRead),
    requiredHandlerDigest:handlerDigest,
    cwdDigest:digest(resolve(thread.cwd)),nativePathDigest:digest(thread.path??null),
    nativeSessionIdDigest:digest(thread.sessionId??null),nativeHistoryModeDigest:digest(thread.historyMode??null),model:binding.model,
  };
}

function makeWitness(owner:CodexColdConstructionOwner,observation:Awaited<ReturnType<typeof readObservation>>):CodexColdConstructionWitness {
  const {threadObservationDigest,loadedThreadsDigest,requirementsDigest,effectiveConfigDigest,requiredHandlerDigest,cwdDigest,
    nativePathDigest,nativeSessionIdDigest,nativeHistoryModeDigest,model}=observation;
  const basis={policy:'codex_cold_resume_construction_v1' as const,threadId:owner.threadId,fenceId:owner.fenceId,
    acceptedInputId:owner.acceptedInputId,runId:owner.runId,dispatchAttempt:owner.dispatchAttempt,
    bindingDigest:owner.bindingDigest,cwdDigest,nativePathDigest,nativeSessionIdDigest,nativeHistoryModeDigest,
    model,effort:'medium' as const,threadObservationDigest,
    loadedThreadsDigest,requirementsDigest,effectiveConfigDigest,requiredHandlerDigest};
  return {...basis,witnessDigest:digest(basis)};
}

/** Derives a cold-construction candidate from native read RPCs under the exact
 * active mutation fence. The caller must retain its common-owner configuration
 * writer exclusion through the subsequent authorized `thread/resume`; these
 * read RPCs do not provide a configuration generation token. No raw response,
 * path, settings, or requirements object is returned or logged. */
export async function readCodexColdConstructionWitness(input:{db:Database;owner:CodexColdConstructionOwner;
  binding:ContinuationBinding;client:CodexColdConstructionReadClient;installerProcesses?:ColdConstructionProcessSource}):Promise<WitnessResult>{
  try{
    if(input.binding.provider!=='codex'||input.binding.threadId!==input.owner.threadId||input.binding.runner!==null
      ||input.binding.effort!=='medium'||!isText(input.binding.model)||digest(input.binding)!==input.owner.bindingDigest)
      refuse('COLD_BOUND_THREAD_BINDING_INVALID');
    if(!fenceMatches(input.db,input.owner))refuse('COLD_EXACT_ACTIVE_FENCE_MISSING');
    const assertManagedHookWriterQuiescent=()=>{
      if(codexManagedHookConfigStatus(input.db).blocked)refuse('COLD_MANAGED_HOOK_CONFIG_INTENT_UNRESOLVED');
      const coverage=assessManagedHookInstallerCoverage({db:input.db,...(input.installerProcesses?{processes:input.installerProcesses}:{})});
      if(!coverage.covered)refuse('COLD_HOOK_INSTALL_PROCESS_COVERAGE_INCOMPLETE',
        ...coverage.blockers.map(blocker=>blocker.code));
    };
    assertManagedHookWriterQuiescent();
    const systemDir=canonicalSystemDir();
    const before=await readObservation({...input,systemDir});
    const after=await readObservation({...input,systemDir});
    const stable=(observation:typeof before)=>({threadObservationDigest:observation.threadObservationDigest,
      requirementsDigest:observation.requirementsDigest,effectiveConfigDigest:observation.effectiveConfigDigest,
      requiredHandlerDigest:observation.requiredHandlerDigest,cwdDigest:observation.cwdDigest,model:observation.model});
    if(digest(stable(before))!==digest(stable(after)))refuse('COLD_CONFIGURATION_OR_THREAD_CHANGED_DURING_READ');
    assertManagedHookWriterQuiescent();
    if(!fenceMatches(input.db,input.owner))refuse('COLD_EXACT_ACTIVE_FENCE_CHANGED');
    return {proven:true,witness:makeWitness(input.owner,after)};
  }catch(error){
    const refusal=error instanceof ColdConstructionRefusal?error:new ColdConstructionRefusal('COLD_CONSTRUCTION_SOURCE_READ_FAILED');
    return {proven:false,reasons:[{code:refusal.code,evidence:refusal.evidence}]};
  }
}

export function isCodexColdConstructionWitness(value:unknown):value is CodexColdConstructionWitness{
  if(!isRecord(value))return false;
  const witness=value as CodexColdConstructionWitness;
  const keys=['policy','threadId','fenceId','acceptedInputId','runId','dispatchAttempt','bindingDigest','cwdDigest',
    'nativePathDigest','nativeSessionIdDigest','nativeHistoryModeDigest','model','effort','threadObservationDigest',
    'loadedThreadsDigest','requirementsDigest','effectiveConfigDigest','requiredHandlerDigest','witnessDigest'];
  if(Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key)))return false;
  const {witnessDigest,...basis}=witness;
  return witness.policy==='codex_cold_resume_construction_v1'&&isText(witness.threadId)&&isText(witness.fenceId)
    &&isText(witness.acceptedInputId)&&isText(witness.runId)&&Number.isSafeInteger(witness.dispatchAttempt)
    &&witness.dispatchAttempt>0&&isText(witness.model)&&witness.effort==='medium'&&isDigest(witness.bindingDigest)
    &&isDigest(witness.cwdDigest)&&isDigest(witness.nativePathDigest)&&isDigest(witness.nativeSessionIdDigest)
    &&isDigest(witness.nativeHistoryModeDigest)&&isDigest(witness.threadObservationDigest)&&isDigest(witness.loadedThreadsDigest)
    &&isDigest(witness.requirementsDigest)&&isDigest(witness.effectiveConfigDigest)&&isDigest(witness.requiredHandlerDigest)
    &&isDigest(witnessDigest)&&digest(basis)===witnessDigest;
}

/** Validates the actual successful owner-mediated resume against the DB-retained
 * authorization/intent, exact params digest, and its terminal result digest. */
export function validateCodexColdResumeParameters(input:{witness:CodexColdConstructionWitness;params:any}){
  const {witness,params}=input;
  if(!isCodexColdConstructionWitness(witness))return {allowed:false as const,reason:'COLD_CONSTRUCTION_WITNESS_INVALID'};
  if(!isRecord(params)||params.threadId!==witness.threadId||params.model!==witness.model||params.excludeTurns!==true
    ||!isRecord(params.config)||params.config.model_reasoning_effort!=='medium'
    ||Object.keys(params).some(key=>!['threadId','cwd','runtimeWorkspaceRoots','approvalPolicy','sandbox','config','model','excludeTurns'].includes(key))
    ||Object.keys(params.config).some(key=>!['agents','shell_environment_policy','model_reasoning_effort','features'].includes(key))
    ||!isRecord(params.config.features)||params.config.features.hooks!==true
    ||Object.keys(params.config.features).some(key=>key!=='hooks')
    ||!isText(params.cwd)||digest(resolve(params.cwd))!==witness.cwdDigest)
    return {allowed:false as const,reason:'COLD_RESUME_PARAMETERS_DO_NOT_MATCH_WITNESS'};
  return {allowed:true as const,paramsDigest:digest(params),witnessDigest:witness.witnessDigest};
}

/** Re-read at the dispatch boundary. Other threads may load or unload while the
 * target remains cold; those unrelated loaded-list changes do not alter the
 * target construction basis. */
export function compareCodexColdConstructionWitnesses(expected:CodexColdConstructionWitness,actual:CodexColdConstructionWitness){
  if(!isCodexColdConstructionWitness(expected)||!isCodexColdConstructionWitness(actual))return {same:false as const,reason:'COLD_CONSTRUCTION_WITNESS_INVALID'};
  const stable=(w:CodexColdConstructionWitness)=>({policy:w.policy,threadId:w.threadId,fenceId:w.fenceId,
    acceptedInputId:w.acceptedInputId,runId:w.runId,dispatchAttempt:w.dispatchAttempt,bindingDigest:w.bindingDigest,
    cwdDigest:w.cwdDigest,nativePathDigest:w.nativePathDigest,nativeSessionIdDigest:w.nativeSessionIdDigest,
    nativeHistoryModeDigest:w.nativeHistoryModeDigest,model:w.model,effort:w.effort,threadObservationDigest:w.threadObservationDigest,
    requirementsDigest:w.requirementsDigest,effectiveConfigDigest:w.effectiveConfigDigest,
    requiredHandlerDigest:w.requiredHandlerDigest});
  return digest(stable(expected))===digest(stable(actual))?{same:true as const}:{same:false as const,reason:'COLD_CONFIGURATION_OR_THREAD_CHANGED'};
}

export function validateCodexColdResume(input:{db:Database;authorizationId:string;intentId:string;
  witness:CodexColdConstructionWitness;params:any;responseResult:any}){
  const {db,authorizationId,intentId,witness,params,responseResult}=input;
  const fail=(reason:string)=>({allowed:false as const,reason});
  if(!isText(authorizationId)||!isText(intentId)||!isCodexColdConstructionWitness(witness))return fail('COLD_CONSTRUCTION_WITNESS_INVALID');
  const auth=db.query('SELECT * FROM codex_recovery_dispatch_authorizations WHERE authorization_id=?').get(authorizationId) as any;
  const intent=db.query('SELECT * FROM codex_mutation_intents WHERE intent_id=?').get(intentId) as any;
  const binding=(()=>{try{return JSON.parse(auth?.binding_json??'null');}catch{return null;}})();
  const fence=auth?getCodexThreadMutationFence(db,auth.thread_id):null;
  if(!auth||!intent||!binding||!fence||fence.state!=='active'||auth.thread_id!==witness.threadId
    ||auth.fence_id!==witness.fenceId||auth.accepted_input_id!==witness.acceptedInputId||auth.run_id!==witness.runId
    ||auth.dispatch_attempt!==witness.dispatchAttempt||digest(binding)!==witness.bindingDigest
    ||fence.fenceId!==witness.fenceId||fence.bindingDigest!==witness.bindingDigest)
    return fail('COLD_RECOVERY_OWNER_BINDING_CHANGED');
  if(auth.resume_permit_id!==intent.permit_id||intent.method!=='thread/resume'||intent.thread_id!==witness.threadId
    ||intent.fence_id!==witness.fenceId||intent.accepted_input_id!==witness.acceptedInputId||intent.run_id!==witness.runId
    ||intent.dispatch_attempt!==witness.dispatchAttempt||intent.state!=='reconciled_applied'||intent.response_kind!=='accepted')
    return fail('COLD_RESUME_INTENT_NOT_ACCEPTED');
  const parameterCheck=validateCodexColdResumeParameters({witness,params});
  if(!parameterCheck.allowed||digest(params)!==intent.params_digest)
    return fail('COLD_RESUME_PARAMETERS_DO_NOT_MATCH_WITNESS');
  if(!isRecord(responseResult)||digest(responseResult)!==intent.terminal_evidence_digest
    ||responseResult.thread?.id!==witness.threadId||!isText(responseResult.thread?.cwd)
    ||digest(resolve(responseResult.thread.cwd))!==witness.cwdDigest
    ||responseResult.thread.path!==undefined&&digest(responseResult.thread.path??null)!==witness.nativePathDigest
    ||responseResult.thread.sessionId!==undefined&&digest(responseResult.thread.sessionId??null)!==witness.nativeSessionIdDigest
    ||responseResult.thread.historyMode!==undefined&&digest(responseResult.thread.historyMode??null)!==witness.nativeHistoryModeDigest
    ||responseResult.model!==witness.model
    ||responseResult.reasoningEffort!=='medium')
    return fail('COLD_RESUME_RESULT_DOES_NOT_MATCH_WITNESS');
  const receipt:CodexColdResumeReceipt={policy:'codex_cold_resume_accepted_v1',threadId:witness.threadId,
    fenceId:witness.fenceId,authorizationId,intentId,bindingDigest:witness.bindingDigest,
    coldWitnessDigest:witness.witnessDigest,paramsDigest:intent.params_digest,
    responseDigest:intent.terminal_evidence_digest,receiptDigest:digest({policy:'codex_cold_resume_accepted_v1',
      threadId:witness.threadId,fenceId:witness.fenceId,authorizationId,intentId,bindingDigest:witness.bindingDigest,
      coldWitnessDigest:witness.witnessDigest,paramsDigest:intent.params_digest,responseDigest:intent.terminal_evidence_digest})};
  return {allowed:true as const,receipt};
}
