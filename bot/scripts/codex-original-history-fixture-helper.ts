/** Fixture source construction only. Production proof always reads native-owned
 * records through the existing private worker; this helper is never imported there. */
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {acceptedBindingSnapshotDigest as digest,type ContinuationBinding} from '../src/codex-accepted-binding-continuation';
import {readCodexOriginalHistoryCoverage,refreshCodexOriginalHistoryAfterOwnedResume} from '../src/codex-original-history-coverage';
import type {Database} from 'bun:sqlite';

/** Complete pinned native snapshot shape, confined to disposable source fixtures. */
export function fixtureNativeSettings(binding:Pick<ContinuationBinding,'model'|'effort'>){
  return {model:binding.model,model_provider_id:'openai',approval_policy:'never',approvals_reviewer:'user',
    permission_profile:{type:'disabled'},cwd:'/fixture',runtime_workspace_roots:[],reasoning_effort:binding.effort,
    reasoning_summary:'none',collaboration_mode:{mode:'default',settings:{model:binding.model,
      reasoning_effort:binding.effort,developer_instructions:null}},disabled_plugin_ids:[]};
}

export async function createFixtureOriginalHistory(input:{root:string;binding:ContinuationBinding;selectedInputId:string;nativeProof:any}){
  const home=mkdtempSync(join(input.root,'fixture-codex-home-')),directory=join(home,'sessions');mkdirSync(directory);
  const sourcePath=join(directory,'rollout-fixture.jsonl'),timestamp='2026-11-13T00:00:00.000Z';
  const row=(type:string,payload:any)=>({timestamp,type,payload});
  const begin=(id:string)=>row('event_msg',{type:'task_started',turn_id:id,model_context_window:258400,collaboration_mode_kind:'default'});
  const context=(id:string)=>row('turn_context',{turn_id:id,cwd:'/fixture',approval_policy:'never',
    sandbox_policy:{type:'danger-full-access'},model:input.binding.model,effort:input.binding.effort,summary:'none',
    comp_hash:'fixture-native-compatibility',realtime_active:false,multi_agent_version:'v1'});
  const end=(id:string)=>row('event_msg',{type:'task_complete',turn_id:id,last_agent_message:null});
  const prior='fixture-prior-acknowledged';
  const records:any[]=[row('session_meta',{id:input.binding.threadId,session_id:input.binding.threadId,timestamp,
    cli_version:'0.162.0',cwd:'/fixture',source:'cli',history_mode:'legacy'}),begin(prior),context(prior),
    {...row('response_item',{type:'message',id:'prior-source-user',role:'user',content:[{type:'input_text',text:'prior accepted fixture work'}]}),
      metadata:{user_input_order:1}},
    row('event_msg',{type:'agent_message',message:'earlier retained useful work'}),
    row('event_msg',{type:'token_count',info:null,rate_limits:{limit_id:'fixture-quota',limit_name:null,
      primary:{used_percent:25,window_minutes:300,resets_at:1794528000},secondary:null,credits:null,
      individual_limit:null,spend_control_reached:false,plan_type:'pro',rate_limit_reached_type:null}}),end(prior),
    row('event_msg',{type:'thread_settings_applied',thread_id:input.binding.threadId,thread_settings:fixtureNativeSettings(input.binding)})];
  for(const covered of input.nativeProof.coverage){
    const id=covered.providerTurnId;records.push(begin(id),context(id));
    if(covered.classification==='independent_compaction')records.push(row('compacted',{message:'fixture model context summary',replacement_history:[],
      retained_context:{verified_answers:[],incomplete:false,user_messages:[],user_messages_incomplete:true,
        assistant_messages:[],assistant_messages_incomplete:false,next_order:2},
      resume_metadata:{multi_agent_version:'v1',last_started_turn_id:id,
        previous_turn_settings:{model:input.binding.model,comp_hash:'fixture-native-compatibility',realtime_active:false}}}),
      context(id),row('event_msg',{type:'item_completed',thread_id:input.binding.threadId,turn_id:id,item:{type:'ContextCompaction',id:`fixture-compaction:${id}`}}));
    records.push(end(id));
  }
  writeFileSync(sourcePath,records.map(record=>JSON.stringify(record)).join('\n')+'\n');
  const result=await readCodexOriginalHistoryCoverage({binding:input.binding,selectedInputId:input.selectedInputId,
    attempts:input.nativeProof.attempts,nativeTurnOrder:input.nativeProof.nativeTurnOrder,codexHome:home,
    client:{async request(method,params){assert.equal(method,'thread/read');assert.equal(params.threadId,input.binding.threadId);
      return {thread:{id:input.binding.threadId,path:sourcePath}};}}});
  assert.equal(result.proven,true,JSON.stringify(result));if(!result.proven)throw new Error('fixture original history unavailable');
  const originalHistory={witness:result.witness,custody:result.custody};
  const nativeEvidence={threadId:input.nativeProof.threadId,continuationDecisionDigest:input.nativeProof.continuationDecisionDigest,
    ownerSnapshotDigest:input.nativeProof.ownerSnapshotDigest,attempts:input.nativeProof.attempts,coverage:input.nativeProof.coverage,
    nativeTurnOrder:input.nativeProof.nativeTurnOrder,nativeWatermark:input.nativeProof.nativeWatermark,originalHistory};
  const nativeWithOriginalHistory={...input.nativeProof,originalHistory,nativeDigest:digest(nativeEvidence)};
  const appendResumeSettings=()=>appendFileSync(sourcePath,JSON.stringify(row('event_msg',{type:'thread_settings_applied',
    thread_id:input.binding.threadId,thread_settings:fixtureNativeSettings(input.binding)}))+'\n');
  const refreshAfterResume=async(db:Database,intentId:string,permitId=intentId)=>{
    const refreshed=await refreshCodexOriginalHistoryAfterOwnedResume({db,intentId,...originalHistory});
    assert.equal(refreshed.proven,true,JSON.stringify(refreshed));if(!refreshed.proven)throw new Error('fixture resume source checkpoint missing');
    return {...refreshed,intentId,permitId};
  };
  return {sourcePath,home,originalHistory,nativeWithOriginalHistory,appendResumeSettings,refreshAfterResume};
}
