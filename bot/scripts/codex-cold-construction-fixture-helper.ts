/** Disposable source-contract fixture only; no native RPC or installed files. */
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {readCodexColdConstructionWitness,type CodexColdConstructionOwner} from '../src/codex-cold-construction';
import type {ContinuationBinding} from '../src/codex-accepted-binding-continuation';
import type {Database} from 'bun:sqlite';

export async function fixtureColdConstruction(input:{db:Database;owner:CodexColdConstructionOwner;
  binding:ContinuationBinding;sourcePath:string;loaded?:string[];configSecret?:string}){
  const managedDir=resolve(process.env.CODEX_SYSTEM_DIR||'/etc/codex','hooks');
  const result=await readCodexColdConstructionWitness({db:input.db,owner:input.owner,binding:input.binding,
    // This fixture owns synthetic native/configuration state, not the host's process inventory.
    installerProcesses:{listPids:()=>[],identity:()=>null,parentPid:()=>null,commandLine:()=>null},
    client:{async request(method,params){
      if(method==='thread/read'){
        assert.deepEqual(params,{threadId:input.binding.threadId,includeTurns:false});
        return {thread:{id:input.binding.threadId,model:input.binding.model,reasoningEffort:input.binding.effort,cwd:'/fixture',path:input.sourcePath,status:{type:'notLoaded'},
          sessionId:input.binding.threadId,historyMode:'legacy',forkedFromId:null,parentThreadId:null}};
      }
      if(method==='thread/loaded/list')return {data:input.loaded??[],nextCursor:null};
      if(method==='configRequirements/read')return {requirements:{featureRequirements:{hooks:true},hooks:{managedDir,
        windowsManagedDir:null,UserPromptSubmit:[{matcher:null,hooks:[{type:'command',command:resolve(managedDir,'concierge-model-start'),
          async:false,timeoutSec:20,statusMessage:'Checking Astra escalation reason',commandWindows:null,additionalContextLimit:null}]}]}}};
      if(method==='config/read')return {config:{features:{hooks:true},...(input.configSecret?{env:{FIXTURE_PRIVATE:input.configSecret}}:{})},
        origins:{},layers:[]};
      throw new Error('unexpected fixture cold read');
    }}});
  assert.equal(result.proven,true,JSON.stringify(result));if(!result.proven)throw new Error('fixture cold witness missing');
  return result.witness;
}
