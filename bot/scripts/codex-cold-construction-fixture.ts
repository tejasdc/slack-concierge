#!/usr/bin/env bun
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Database} from 'bun:sqlite';
import {acceptedBindingSnapshotDigest as digest} from '../src/codex-accepted-binding-continuation';
import {acquireCodexThreadMutationFence,initializeCodexMutationFenceSchema,grantCodexMutationPermit,
  consumeCodexMutationPermit} from '../src/codex-mutation-fence';
import {initializeCodexRecoveryAuthorizationSchema,recordCodexRecoveryMutationResponse} from '../src/codex-recovery-dispatch-authorization';
import {readCodexColdConstructionWitness,compareCodexColdConstructionWitnesses,
  validateCodexColdResumeParameters,validateCodexColdResume,type CodexColdConstructionReadClient} from '../src/codex-cold-construction';

const scratch=mkdtempSync(join(tmpdir(),'codex-cold-construction-'));
const state=join(scratch,'state'),systemDir=join(scratch,'etc-codex'),cwd=join(scratch,'project');
mkdirSync(state);mkdirSync(join(systemDir,'hooks'),{recursive:true});mkdirSync(cwd);
const oldSystemDir=process.env.CODEX_SYSTEM_DIR;process.env.CODEX_SYSTEM_DIR=systemDir;
const db=new Database(join(state,'state.sqlite'));
const threadId='019a7181-0000-7000-8000-000000000001',acceptedInputId='cold-selected',runId='cold-run';
const binding={sessionId:82,provider:'codex',threadId,generation:3,model:'gpt-6-astra',effort:'medium',runner:null};
const bindingDigest=digest(binding),fenceId='cold-fence';
const owner={threadId,fenceId,acceptedInputId,runId,dispatchAttempt:2,bindingDigest};
const params={threadId,model:binding.model,excludeTurns:true,cwd,config:{features:{hooks:true},model_reasoning_effort:'medium'}};
const responseResult={thread:{id:threadId,cwd,path:'/fixture/hidden-rollout.jsonl',sessionId:threadId,historyMode:'legacy',reasoningEffort:'medium'},
  model:binding.model,reasoningEffort:'medium'};

function requirements(overrides:any={}){
  return {supportsIndependentSpeedModes:true,requirements:{featureRequirements:{hooks:true},hooks:{managedDir:resolve(systemDir,'hooks'),
    windowsManagedDir:null,UserPromptSubmit:[{matcher:null,hooks:[{type:'command',command:resolve(systemDir,'hooks','concierge-model-start'),
      async:false,timeoutSec:20,statusMessage:'Checking Astra escalation reason',commandWindows:null,additionalContextLimit:null}]}]},...overrides}};
}
function configRead(features:any={hooks:true}){
  return {config:{features},origins:{},layers:[{name:{type:'user'},version:'fixture',config:{features}}]};
}
function client(options:{loaded?:string[]|((pass:number)=>string[]);requirements?:(pass:number)=>any;thread?:(pass:number)=>any;config?:(pass:number)=>any;cursorLoop?:boolean}={}):CodexColdConstructionReadClient{
  let pass=0,pagesInPass=0;
  return {async request(method,params){
    if(method==='thread/read'){
      pass++;pagesInPass=0;assert.deepEqual(params,{threadId,includeTurns:false});
      return options.thread?.(pass)??{thread:{id:threadId,cwd,status:{type:'notLoaded'},path:'/fixture/hidden-rollout.jsonl',
        model:binding.model,reasoningEffort:'medium',
        sessionId:threadId,historyMode:'legacy',forkedFromId:null,parentThreadId:null,preview:'must never leave the reader'}};
    }
    if(method==='thread/loaded/list'){
      pagesInPass++;
      const loaded=typeof options.loaded==='function'?options.loaded(pass):options.loaded??[];
      if(pagesInPass===1){assert.equal(params.cursor,undefined);return {data:[...loaded,'other-thread-a'],nextCursor:'opaque-next-page'};}
      assert.equal(params.cursor,options.cursorLoop?'opaque-next-page':'opaque-next-page');
      return {data:['other-thread-b'],nextCursor:options.cursorLoop?'opaque-next-page':null};
    }
    if(method==='configRequirements/read')return options.requirements?.(pass)??requirements();
    if(method==='config/read'){assert.deepEqual(params,{cwd,includeLayers:true});return options.config?.(pass)??configRead();}
    throw new Error(`unexpected fixture method ${method}`);
  }};
}

try{
  initializeCodexMutationFenceSchema(db);
  db.query(`INSERT INTO codex_thread_mutation_revisions(thread_id,revision) VALUES(?,0)`).run(threadId);
  assert.equal(acquireCodexThreadMutationFence(db,{...owner,nowMs:1}).acquired,true);
  const validClient=client();
  const fixtureInput={db,owner,binding,installerProcesses:{listPids:()=>[],identity:()=>null,parentPid:()=>null,commandLine:()=>null}};
  const read=()=>readCodexColdConstructionWitness({...fixtureInput,client:validClient});
  const cold=await read();assert.equal(cold.proven,true,JSON.stringify(cold));
  if(!cold.proven)throw new Error('cold witness missing');
  const unreadableProcess=await readCodexColdConstructionWitness({...fixtureInput,client:client(),installerProcesses:{
    listPids:()=>[98765],identity:()=>{throw Object.assign(new Error('unreadable fixture identity'),{code:'EACCES'});},
    parentPid:()=>null,commandLine:()=>null}});
  assert.equal(unreadableProcess.proven,false,'the cold path retains strict unreadable process refusal');
  if(!unreadableProcess.proven)assert.equal(unreadableProcess.reasons[0]?.code,'COLD_HOOK_INSTALL_PROCESS_COVERAGE_INCOMPLETE');
  assert.equal(cold.witness.policy,'codex_cold_resume_construction_v1');
  assert.equal(cold.witness.effort,'medium');assert.equal(cold.witness.bindingDigest,bindingDigest);
  assert.equal(cold.witness.cwdDigest,digest(resolve(cwd)));
  assert.equal(validateCodexColdResumeParameters({witness:cold.witness,params}).allowed,true);
  assert.equal(validateCodexColdResumeParameters({witness:cold.witness,params:{...params,excludeTurns:false}}).allowed,false);
  assert.equal(validateCodexColdResumeParameters({witness:cold.witness,params:{...params,cwd:'/elsewhere'}}).allowed,false);
  assert.equal(validateCodexColdResumeParameters({witness:cold.witness,params:{threadId,model:binding.model,excludeTurns:true,
    cwd,config:{model_reasoning_effort:'medium'}}}).allowed,false,'resume must carry the enabled hook feature explicitly');
  assert.ok(!JSON.stringify(cold).includes('/fixture/hidden-rollout.jsonl'));
  assert.ok(!JSON.stringify(cold).includes('concierge-model-start'));

  const changedLoaded=await readCodexColdConstructionWitness({...fixtureInput,client:client({loaded:['different-other-thread']})});
  assert.equal(changedLoaded.proven,true,JSON.stringify(changedLoaded));
  if(!changedLoaded.proven)throw new Error('second cold witness missing');
  assert.notEqual(changedLoaded.witness.loadedThreadsDigest,cold.witness.loadedThreadsDigest);
  assert.equal(compareCodexColdConstructionWitnesses(cold.witness,changedLoaded.witness).same,true,
    'unrelated native thread load/unload does not invalidate this exact target basis');
  const changingOtherThreads=await readCodexColdConstructionWitness({...fixtureInput,client:client({loaded:pass=>pass===1?['before-read']:['after-read']})});
  assert.equal(changingOtherThreads.proven,true,JSON.stringify(changingOtherThreads));

  const targetLoaded=await readCodexColdConstructionWitness({...fixtureInput,client:client({loaded:[threadId]})});
  assert.equal(targetLoaded.proven,false);if(!targetLoaded.proven)assert.equal(targetLoaded.reasons[0]?.code,'COLD_NATIVE_THREAD_PRESENT_IN_LOADED_LIST');
  const hookDisabled=await readCodexColdConstructionWitness({...fixtureInput,client:client({requirements:()=>requirements({featureRequirements:{hooks:false}})})});
  assert.equal(hookDisabled.proven,false);if(!hookDisabled.proven)assert.equal(hookDisabled.reasons[0]?.code,'COLD_HOOK_FEATURE_REQUIREMENT_NOT_ENABLED');
  const handlerChanged=await readCodexColdConstructionWitness({...fixtureInput,client:client({requirements:()=>requirements({hooks:{...requirements().requirements.hooks,
    UserPromptSubmit:[{matcher:'*',hooks:[{type:'command',command:resolve(systemDir,'hooks','other'),async:true,timeoutSec:19}]}]}})})});
  assert.equal(handlerChanged.proven,false);if(!handlerChanged.proven)assert.match(handlerChanged.reasons[0]?.code??'',/^COLD_USER_PROMPT_HOOK/);
  const configDisabled=await readCodexColdConstructionWitness({...fixtureInput,client:client({config:()=>configRead({hooks:false})})});
  assert.equal(configDisabled.proven,false);if(!configDisabled.proven)assert.equal(configDisabled.reasons[0]?.code,'COLD_EFFECTIVE_HOOK_FEATURE_CONFLICT');
  const configFeatureMissing=await readCodexColdConstructionWitness({...fixtureInput,client:client({config:()=>configRead({})})});
  assert.equal(configFeatureMissing.proven,true,'native config/read may omit stable hooks');
  const cursorLoop=await readCodexColdConstructionWitness({...fixtureInput,client:client({cursorLoop:true})});
  assert.equal(cursorLoop.proven,false);if(!cursorLoop.proven)assert.equal(cursorLoop.reasons[0]?.code,'COLD_NATIVE_LOADED_THREADS_CURSOR_LOOP');
  let requirementPass=0;
  const requirementRace=await readCodexColdConstructionWitness({...fixtureInput,client:client({requirements:()=>++requirementPass===1?requirements():requirements({featureRequirements:{hooks:false}})})});
  assert.equal(requirementRace.proven,false);if(!requirementRace.proven)assert.equal(requirementRace.reasons[0]?.code,'COLD_HOOK_FEATURE_REQUIREMENT_NOT_ENABLED');

  // Exercise the actual SQLite fence, permit, consumed intent and native response
  // reconciliation schemas. Authorization identity is fixture-seeded; no live
  // recovery is granted or dispatched.
  db.exec('CREATE TABLE codex_unacknowledged_recoveries(accepted_input_id TEXT PRIMARY KEY,proof_json TEXT NOT NULL)');
  db.query('INSERT INTO codex_unacknowledged_recoveries(accepted_input_id,proof_json) VALUES(?,?)').run(acceptedInputId,'{}');
  initializeCodexRecoveryAuthorizationSchema(db);
  const permitId='cold-resume-permit';
  const granted=grantCodexMutationPermit(db,{permitId,threadId,owner:{acceptedInputId,runId,dispatchAttempt:2,bindingDigest},
    method:'thread/resume',paramsDigest:digest(params),purpose:'fenced_recovery',fenceId,nowMs:2});
  assert.equal(granted.granted,true,JSON.stringify(granted));
  assert.equal(consumeCodexMutationPermit(db,{permitId,intentId:permitId,paramsDigest:digest(params),nowMs:3}).forward,true);
  db.query(`INSERT INTO codex_recovery_dispatch_authorizations(authorization_id,accepted_input_id,session_id,turn_id,run_id,
    dispatch_attempt,fence_id,thread_id,binding_json,continuation_digest,native_digest,proof_digest,source_fingerprint,
    baseline_admissions_json,evidence_refs_json,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('cold-auth',acceptedInputId,binding.sessionId,302,runId,2,fenceId,threadId,JSON.stringify(binding),digest('continuation'),
      digest('native'),digest('proof'),digest('fingerprint'),'[]','[]',1);
  db.query('UPDATE codex_recovery_dispatch_authorizations SET resume_permit_id=? WHERE authorization_id=?').run(permitId,'cold-auth');
  const rpcFrame={id:'resume-frame',result:responseResult};
  const recorded=recordCodexRecoveryMutationResponse(db,{authorizationId:'cold-auth',intentId:permitId,response:responseResult,
    responseDigest:digest(rpcFrame),nowMs:4});
  assert.equal(recorded.allowed,true,JSON.stringify(recorded));
  assert.equal(validateCodexColdResume({db,authorizationId:'cold-auth',intentId:permitId,witness:cold.witness,params,responseResult}).allowed,true);
  assert.equal(validateCodexColdResume({db,authorizationId:'cold-auth',intentId:permitId,witness:cold.witness,
    params,responseResult:{...responseResult,thread:{id:'other-thread'}}}).allowed,false);
  assert.equal(validateCodexColdResume({db,authorizationId:'cold-auth',intentId:permitId,witness:cold.witness,
    params,responseResult:{...responseResult,thread:{...responseResult.thread,cwd:'/elsewhere'}}}).allowed,false);
  const tampered={...cold.witness,requiredHandlerDigest:digest('other-handler')};
  assert.equal(validateCodexColdResume({db,authorizationId:'cold-auth',intentId:permitId,witness:tampered,params,responseResult}).allowed,false);
  console.log('Codex cold construction: actual SQLite fence/intent/response, complete loaded-list pagination, exact requirements/config and safe double-read witness: PASS');
}finally{
  db.close();if(oldSystemDir===undefined)delete process.env.CODEX_SYSTEM_DIR;else process.env.CODEX_SYSTEM_DIR=oldSystemDir;
  rmSync(scratch,{recursive:true,force:true});
}
