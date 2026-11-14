import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,renameSync,truncateSync,readFileSync,symlinkSync,rmSync} from 'node:fs';
import {Database} from 'bun:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readCodexOriginalHistoryCoverage,revalidateCodexOriginalHistorySource,refreshCodexOriginalHistoryAfterOwnedResume,
  type CodexOriginalHistoryCoverageInput} from '../src/codex-original-history-coverage';
import {fixtureNativeSettings} from './codex-original-history-fixture-helper';
import {CODEX_HISTORY_INTERPRETATION,decodeNativeHistoryRecord,decodeResponse,rolloutKinds,responseKinds,
  turnItemKinds,NativeHistoryDecodeError} from '../src/codex-native-history-decoder';
import eventCatalogue from '../src/codex-native-event-catalogue.json';
import {parseNativeSourceRecord,nativeSourceValueDigest} from '../src/codex-native-source-values';

const scratch=mkdtempSync(join(tmpdir(),'codex-original-source-')),home=join(scratch,'codex-home');mkdirSync(home);
const path=join(home,'rollout-original.jsonl'),threadId='019a7181-0000-7000-8000-000000000001';
const binding={sessionId:90,provider:'codex',threadId,generation:1,model:'gpt-6-astra',effort:'medium',runner:null};
const attempts=[{inputId:'selected',turnId:30,runId:'run:30',dispatchAttempt:1,providerTurnId:'selected-T',evidenceRefs:['provider-turn-attempt:30:1']},
  {inputId:'closed-info',turnId:31,runId:'run:31',dispatchAttempt:1,providerTurnId:'compaction-T',evidenceRefs:['result:31']},
  {inputId:'later-empty',turnId:32,runId:'run:32',dispatchAttempt:1,providerTurnId:'empty-T',evidenceRefs:['provider-turn-attempt:32:1']}];
const row=(type:string,payload:any,metadata?:any)=>({timestamp:'2026-11-13T00:00:00.000Z',type,payload,...metadata?{metadata}:{}});
const begin=(id:string)=>row('event_msg',{type:'task_started',turn_id:id,model_context_window:258400,collaboration_mode_kind:'default'});
const context=(id:string)=>row('turn_context',{turn_id:id,cwd:'/fixture',approval_policy:'never',sandbox_policy:{type:'danger-full-access'},
  model:'gpt-6-astra',effort:'medium',summary:'none'});
const end=(id:string)=>row('event_msg',{type:'task_complete',turn_id:id,last_agent_message:null});
const user={type:'message',id:'prior-native-item',role:'user',content:[{type:'input_text',text:'prior preserved request'}]};
const generated={type:'message',id:'static-context',role:'user',content:[{type:'input_text',text:'arbitrary static instructions'},
  {type:'input_text',text:'arbitrary environment'}],internal_chat_message_metadata_passthrough:{
  content_item_kinds:['agents_md.instructions','environments.environment_context']}};
function records():any[]{return structuredClone([row('session_meta',{id:threadId,session_id:threadId,timestamp:'2026-11-13T00:00:00.000Z',
    originator:'codex_cli_rs',cli_version:'0.162.0',cwd:'/fixture',source:'cli',history_mode:'legacy'}),
  begin('prior-T'),context('prior-T'),row('response_item',user,{user_input_order:7}),
  row('event_msg',{type:'user_message',client_id:'prior-client',message:'prior preserved request',local_images:[]}),
  row('response_item',{type:'function_call',name:'some-tool',call_id:'prior-call',arguments:'{"private":"preserved"}'}),
  row('response_item',{type:'function_call_output',call_id:'prior-call',output:'earlier successful effect'}),
  row('response_item',generated),end('prior-T'),
  row('event_msg',{type:'thread_settings_applied',thread_id:threadId,thread_settings:fixtureNativeSettings(binding)}),
  begin('selected-T'),row('response_item',generated),context('selected-T'),end('selected-T'),
  begin('compaction-T'),context('compaction-T'),row('compacted',{message:'model context summary',replacement_history:[user,generated],
    replacement_history_metadata:[{user_input_order:7},{}]}),context('compaction-T'),end('compaction-T'),
  begin('empty-T'),context('empty-T'),row('event_msg',{type:'token_count',info:null,rate_limits:null}),end('empty-T')]);}
const serialize=(rows:any[])=>rows.map(r=>JSON.stringify(r)).join('\n')+'\n';
const write=(rows=records())=>writeFileSync(path,serialize(rows));
const input:CodexOriginalHistoryCoverageInput={binding,selectedInputId:'selected',attempts,
  nativeTurnOrder:['prior-T','selected-T','compaction-T','empty-T'],codexHome:home,
  client:{async request(method,params){assert.equal(method,'thread/read');assert.equal(params.includeTurns,false);
    return {thread:{id:threadId,path}};}}};
const read=()=>readCodexOriginalHistoryCoverage(input);
async function refuses(code:string,change:(rows:any[])=>void){const rows=records();change(rows);write(rows);
  const result=await read();assert.equal(result.proven,false,code);
  if(!result.proven)assert.equal(result.reasons[0]?.code,code,JSON.stringify(result));}
write();
const result=await read();assert.equal(result.proven,true,JSON.stringify(result));
if(!result.proven)throw new Error('fixture source proof failed');
assert.deepEqual(result.witness.spans.map(s=>s.classification),['empty','independent_compaction','empty']);
assert.equal(result.witness.spans[0]?.generatedContextRecords,1);
assert.equal(result.witness.compactionRecords[0]?.replacementClassifications.historicalAcceptedUser,1);
assert.equal(result.witness.priorRecordCount,10);
assert.equal(revalidateCodexOriginalHistorySource(result.custody,result.witness).valid,true);
assert.ok(!JSON.stringify(result.witness).includes(path)&&!JSON.stringify(result.witness).includes('earlier successful effect'));
const original=readFileSync(path);
assert.equal(result.witness.interpretation.upstreamCommit,'c1382380de69521303b416720a52f42d51af6248');
assert.equal(rolloutKinds.length,12);
assert.deepEqual(responseKinds,['additional_tools','message','agent_message','reasoning','local_shell_call',
  'function_call','tool_search_call','function_call_output','custom_tool_call','custom_tool_call_output','tool_search_output',
  'web_search_call','image_generation_call','compaction','context_compaction','configuration_update','compaction_trigger']);
assert.equal(Object.keys(eventCatalogue.events).length,85);
assert.equal(turnItemKinds.length,19);
// A decoder catalogue is recognition, not a neutral-effects allowlist.
for(const [kind,payload] of Object.entries({additional_tools:{role:'system',tools:[]},
  agent_message:{author:'root',recipient:'root/child',content:[{type:'input_text',text:'historical communication'}]},
  tool_search_call:{execution:'server',arguments:{query:'opaque historical argument'}},
  tool_search_output:{execution:'server',status:'completed',tools:[]},configuration_update:{reasoning:{effort:'medium'}},
  context_compaction:{},compaction_summary:{encrypted_content:'opaque historical compaction'}})){
  assert.ok(decodeResponse({type:kind,...payload}));
}
assert.throws(()=>decodeResponse({type:'computer_call'}),NativeHistoryDecodeError);
assert.throws(()=>decodeResponse({type:'local_shell_call',status:'completed',action:{type:'exec',command:'invalid native vector'}}),NativeHistoryDecodeError);
assert.throws(()=>decodeResponse({type:'function_call_output',output:[{type:'future_output',text:'unclassified'}]}),NativeHistoryDecodeError);
assert.throws(()=>decodeResponse({type:'compaction_trigger'}),NativeHistoryDecodeError);
const lexicalA=parseNativeSourceRecord('{"n":9007199254740992}'),lexicalB=parseNativeSourceRecord('{"n":9007199254740993}');
assert.equal(lexicalA.n,lexicalB.n,'JavaScript alone collapses these distinct native JSON numbers');
assert.notEqual(nativeSourceValueDigest(lexicalA),nativeSourceValueDigest(lexicalB),'source payload identity retains exact numeric evidence');
assert.throws(()=>decodeNativeHistoryRecord(parseNativeSourceRecord(JSON.stringify({...row('response_item',user),metadata:{user_input_order:1}})
  .replace('"user_input_order":1','"user_input_order":1.0'))),NativeHistoryDecodeError);
const originalSearch={type:'tool_search_call',id:'earlier-search',execution:'server',arguments:{n:'RAW_NUMBER_A'}};
for(const same of [true,false]){
  const rows=records();rows.splice(8,0,row('response_item',originalSearch));
  const checkpoint=rows.find(r=>r.type==='compacted').payload;
  checkpoint.replacement_history.push({...originalSearch,arguments:{n:same?'RAW_NUMBER_A':'RAW_NUMBER_B'}});
  checkpoint.replacement_history_metadata.push({});
  writeFileSync(path,serialize(rows).replaceAll('"RAW_NUMBER_A"','9007199254740992').replaceAll('"RAW_NUMBER_B"','9007199254740993'));
  assert.equal((await read()).proven,same,'replacement effects require exact original numeric payload identity');
}
assert.throws(()=>decodeNativeHistoryRecord({...row('response_item',user),metadata:{future_authority:true}}),NativeHistoryDecodeError);
const historicalPair=records();historicalPair.splice(4,0,row('inter_agent_communication_metadata',{trigger_turn:true}),
  row('response_item',{type:'agent_message',id:'comm-item',author:'root/child',recipient:'root',
    content:[{type:'input_text',text:'earlier child reply'}],internal_chat_message_metadata_passthrough:{turn_id:'prior-T'}}));
write(historicalPair);const paired=await read();assert.equal(paired.proven,true,JSON.stringify(paired));
if(paired.proven)assert.ok(paired.witness.baselineTransitions.some(t=>t.kind==='communication_pair'));
const separatelyAttributedPair=structuredClone(historicalPair);
separatelyAttributedPair[5].payload.internal_chat_message_metadata_passthrough.turn_id='declared-communication-turn';
write(separatelyAttributedPair);assert.equal((await read()).proven,true,
  'the native communication instruction boundary is not inferred from the active task');
const interruptedPair=structuredClone(historicalPair);interruptedPair.splice(5,0,row('event_msg',{type:'token_count',info:null,rate_limits:null}));
write(interruptedPair);const brokenPair=await read();assert.equal(brokenPair.proven,false);
if(!brokenPair.proven)assert.equal(brokenPair.reasons[0]?.code,'ORIGINAL_HISTORY_COMMUNICATION_PAIR_UNPROVEN');
for(const trigger_turn of [false,true])await refuses('ORIGINAL_HISTORY_INTERVAL_COMMUNICATION_PRESENT',rows=>{
  rows.splice(12,0,row('inter_agent_communication_metadata',{trigger_turn}),historicalPair[5]);});
const historicalCompletion=records();historicalCompletion.splice(8,0,row('event_msg',{type:'item_completed',
  thread_id:threadId,turn_id:'prior-T',item:{type:'ContextCompaction',id:'prior-compaction-completion'}}));
write(historicalCompletion);assert.equal((await read()).proven,true,'prior completion is preserved rather than subjected to interval counters');
for(const kind of ['retained_context','security_risk_score','realtime_item']){
  const payload=kind==='retained_context'?{type:'verified_answer',turn_id:'prior-T',call_id:'prior-question',
    questions:[{question:'earlier question',answer:'earlier answer'}],acceptance_order:9}:
    kind==='security_risk_score'?{scores:{risk:0.2},call_id:'prior-call'}:
    {id:'realtime-item',realtime_session_id:'prior-realtime',type:'transcript_segment',role:'assistant',text:'earlier speech'};
  const rows=records();rows.splice(8,0,row(kind,payload));write(rows);
  assert.equal((await read()).proven,true,`${kind} prior fact is preserved`);
  rows.splice(8,1);rows.splice(12,0,row(kind,payload));write(rows);assert.equal((await read()).proven,false,`${kind} relevant effect refuses`);
}
const allProblems=records();allProblems.splice(4,0,row('unknown_future_record',{}));
allProblems.push(row('event_msg',{type:'another_future_event'}));write(allProblems);const inventory=await read();
assert.equal(inventory.proven,false);if(!inventory.proven){
  assert.equal(inventory.reasons.length,2);assert.equal(inventory.diagnostic?.completeCapturedEof,true);
  assert.equal(inventory.diagnostic?.recordCount,allProblems.length);
  assert.equal(inventory.diagnostic?.inventory.unknown_record,1);
  assert.equal(inventory.diagnostic?.inventory['event_msg:unknown'],1);
}
write();
const resetAndReestablish=records();
resetAndReestablish.splice(8,0,row('world_state',{full:true,state:{stable:'before-compaction'}}),
  row('compacted',{message:'earlier preserved model summary',replacement_history:[],resume_metadata:{
    multi_agent_version:null,last_started_turn_id:null,previous_turn_settings:null}}),
  row('world_state',{full:false,state:{ignored:'without full snapshot'}}),
  row('world_state',{full:true,state:{stable:'reestablished'}}),context('prior-T'));
resetAndReestablish.splice(resetAndReestablish.findIndex((r,index)=>index>15&&r.type==='compacted')+1,0,
  row('world_state',{full:true,state:{stable:'reestablished'}}));
write(resetAndReestablish);const reconstructed=await read();assert.equal(reconstructed.proven,true,JSON.stringify(reconstructed));
if(reconstructed.proven){
  const reset=reconstructed.witness.baselineTransitions.find(t=>t.kind==='compaction_reset')!;
  assert.ok(reconstructed.witness.baselineTransitions.some(t=>t.kind==='world_full'&&t.sourceRecord===reset.record));
  assert.ok(reconstructed.witness.baselineTransitions.some(t=>t.kind==='context_established'&&t.sourceRecord===reset.record));
}
const unbasedWorld=structuredClone(resetAndReestablish);
const laterReset=unbasedWorld.findIndex((r,index)=>index>15&&r.type==='compacted');unbasedWorld.splice(laterReset+1,1);
write(unbasedWorld);const noWorldBaseline=await read();assert.equal(noWorldBaseline.proven,false);
if(!noWorldBaseline.proven)assert.equal(noWorldBaseline.reasons[0]?.code,'ORIGINAL_HISTORY_WORLD_STATE_BASELINE_MISSING');
const missingReestablishment=records();missingReestablishment.splice(17,1);write(missingReestablishment);
assert.equal((await read()).proven,false,'a pre-compaction context cannot certify a post-compaction baseline');
const legacyCompaction=records();delete legacyCompaction[16].payload.replacement_history;
delete legacyCompaction[16].payload.replacement_history_metadata;write(legacyCompaction);
const legacyRefusal=await read();assert.equal(legacyRefusal.proven,false);
if(!legacyRefusal.proven)assert.equal(legacyRefusal.reasons[0]?.code,'ORIGINAL_HISTORY_LEGACY_COMPACTION_TRANSFORMATION_UNSUPPORTED');
const forgedConfiguration=records();forgedConfiguration[16].payload.replacement_history.push({type:'message',role:'developer',
  content:[{type:'input_text',text:'new instructions'}]});forgedConfiguration[16].payload.replacement_history_metadata.push({});
write(forgedConfiguration);const configRefusal=await read();assert.equal(configRefusal.proven,false);
if(!configRefusal.proven)assert.equal(configRefusal.reasons[0]?.code,'ORIGINAL_HISTORY_CONFIGURATION_PROVENANCE_UNPROVEN');
const strippedEnvelope=records();strippedEnvelope[16].payload.replacement_history_metadata[0]={};write(strippedEnvelope);
assert.equal((await read()).proven,false,'payload equality cannot erase original acceptance order');
write();
appendFileSync(path,serialize([row('event_msg',{type:'token_count'})]));
assert.equal(revalidateCodexOriginalHistorySource(result.custody,result.witness).valid,false,'append is a source change');
writeFileSync(path,original);assert.equal(revalidateCodexOriginalHistorySource(result.custody,result.witness).valid,false,'restoring bytes does not restore source revision');
const fresh=await read();assert.equal(fresh.proven,true);if(!fresh.proven)throw new Error('fixture');
renameSync(path,path+'.old');writeFileSync(path,original);
assert.equal(revalidateCodexOriginalHistorySource(fresh.custody,fresh.witness).valid,false,'replacement inode refuses');
const truncation=await read();assert.equal(truncation.proven,true);if(!truncation.proven)throw new Error('fixture');
truncateSync(path,original.length-10);assert.equal(revalidateCodexOriginalHistorySource(truncation.custody,truncation.witness).valid,false);
await refuses('ORIGINAL_HISTORY_RECORD_SHAPE_INVALID',rows=>{rows[13]={...rows[13],timestamp:'invalid'};});
await refuses('ORIGINAL_HISTORY_UNKNOWN_OR_UNCLASSIFIED_RECORD',rows=>{rows.splice(12,0,row('future_raw_type',{}));});
await refuses('ORIGINAL_HISTORY_UNKNOWN_OR_UNCLASSIFIED_EVENT',rows=>{rows.splice(12,0,row('event_msg',{type:'future_effect'}));});
await refuses('ORIGINAL_HISTORY_ACCEPTED_USER_EVENT_PRESENT',rows=>{rows.splice(12,0,row('event_msg',{type:'user_message',message:'accepted'}));});
await refuses('ORIGINAL_HISTORY_CONVERSATIONAL_OR_TOOL_EFFECT',rows=>{rows.splice(12,0,row('response_item',{
  type:'function_call',call_id:'hidden-effect',name:'tool',arguments:'{}'}));});
await refuses('ORIGINAL_HISTORY_ACCEPTED_USER_PROVENANCE_PRESENT',rows=>{rows.splice(12,0,row('response_item',user,{user_input_order:8}));});
await refuses('ORIGINAL_HISTORY_USER_PROVENANCE_UNPROVEN',rows=>{rows[11].payload.internal_chat_message_metadata_passthrough.content_item_kinds.pop();});
await refuses('ORIGINAL_HISTORY_USER_PROVENANCE_UNPROVEN',rows=>{rows[11].payload.internal_chat_message_metadata_passthrough.content_item_kinds[1]='unknown.source';});
await refuses('ORIGINAL_HISTORY_USER_PROVENANCE_UNPROVEN',rows=>{delete rows[11].payload.internal_chat_message_metadata_passthrough;});
await refuses('ORIGINAL_HISTORY_REPLACEMENT_USER_PROVENANCE_UNPROVEN',rows=>{delete rows[16].payload.replacement_history_metadata;});
await refuses('ORIGINAL_HISTORY_REPLACEMENT_USER_PROVENANCE_UNPROVEN',rows=>{rows[16].payload.replacement_history_metadata[0].user_input_order=999;});
await refuses('ORIGINAL_HISTORY_COMPACTION_SHAPE_INVALID',rows=>{rows[16].payload.replacement_history_metadata.pop();});
await refuses('ORIGINAL_HISTORY_COMPACTION_SIDECAR_UNCLASSIFIED',rows=>{rows[16].payload.retained_context={unknown:'not projected'};});
await refuses('ORIGINAL_HISTORY_COMPACTION_SIDECAR_UNCLASSIFIED',rows=>{rows[16].payload.future_effect_sidecar={unknown:'not projected'};});
await refuses('ORIGINAL_HISTORY_RESPONSE_METADATA_UNCLASSIFIED',rows=>{rows[11].metadata={delivered_assistant_message:'confirmed elsewhere'};});
await refuses('ORIGINAL_HISTORY_ENVELOPE_FIELD_UNKNOWN',rows=>{rows[16].payload.replacement_history_metadata[1]={unknown_future_provenance:1};});
await refuses('ORIGINAL_HISTORY_ROLLBACK_UNSUPPORTED',rows=>{rows.splice(4,0,row('event_msg',{type:'thread_rolled_back',num_turns:1}));});
for(const key of ['history_base','subagent_history_start_ordinal','forked_from_id','forked_from_ordinal_exclusive','parent_thread_id'])
  await refuses('ORIGINAL_HISTORY_INHERITED_LINEAGE_UNSUPPORTED',rows=>{rows[0].payload[key]=key==='history_base'?{thread_id:threadId,end_ordinal_exclusive:1}:1;});
await refuses('ORIGINAL_HISTORY_CONTEXT_BINDING_CONFLICT',rows=>{rows[12].payload.effort='high';});
await refuses('ORIGINAL_HISTORY_EXACT_TURN_CONTEXT_MISSING',rows=>{rows.splice(12,1);});
await refuses('ORIGINAL_HISTORY_SETTINGS_BASELINE_MISSING',rows=>{rows.splice(9,1);});
await refuses('ORIGINAL_HISTORY_SETTINGS_SNAPSHOT_INCOMPLETE',rows=>{delete rows[9].payload.thread_settings.approval_policy;});
await refuses('ORIGINAL_HISTORY_TURN_SETTINGS_CHANGED',rows=>{rows[12].payload.cwd='/unrelated-directory';});
await refuses('ORIGINAL_HISTORY_TURN_SETTINGS_CHANGED',rows=>{rows[12].payload.approval_policy='on-request';});
await refuses('ORIGINAL_HISTORY_TURN_SETTINGS_CHANGED',rows=>{rows[12].payload.sandbox_policy={type:'read-only'};});
for(const [key,value] of Object.entries({approval_policy:'on-request',cwd:'/unrelated',permission_profile:{type:'external',network:'enabled'},
  runtime_workspace_roots:['/new'],disabled_plugin_ids:['new-plugin'],service_tier:'priority',personality:'friendly',
  unknown_future_setting:'unowned-change'}))
  await refuses('ORIGINAL_HISTORY_NATIVE_SETTINGS_CHANGED',rows=>{const snapshot=fixtureNativeSettings(binding) as any;snapshot[key]=value;
    rows.splice(16,0,row('event_msg',{type:'thread_settings_applied',thread_id:threadId,thread_settings:snapshot}));});
const unchanged=records();unchanged.splice(16,0,row('event_msg',{type:'thread_settings_applied',thread_id:threadId,
  thread_settings:fixtureNativeSettings(binding)}));write(unchanged);
assert.equal((await read()).proven,true,'complete identical settings checkpoint is neutral');
await refuses('ORIGINAL_HISTORY_WORLD_STATE_BASELINE_MISSING',rows=>{rows.splice(16,0,row('world_state',{full:true,state:{environment:{cwd:'/fixture'}}}));});
const state={environment:{cwd:'/fixture',approval:'never'},privateContext:{retained:'unchanged'}};
const stableWorld=records();stableWorld.splice(17,0,row('world_state',{full:true,state}));stableWorld.splice(9,0,row('world_state',{full:true,state}));write(stableWorld);
assert.equal((await read()).proven,true,'source-backed full world-state baseline equality');
const stablePatch=records();stablePatch.splice(16,0,row('world_state',{full:false,state:{environment:{cwd:'/fixture'}}}));
stablePatch.splice(stablePatch.findIndex(r=>r.type==='compacted')+1,0,row('world_state',{full:true,state}));
stablePatch.splice(9,0,row('world_state',{full:true,state}));write(stablePatch);
assert.equal((await read()).proven,true,'recursive merge patch with identical effective state is neutral');
await refuses('ORIGINAL_HISTORY_WORLD_STATE_CHANGED',rows=>{rows.splice(16,0,row('world_state',{full:false,state:{environment:{cwd:'/new'}}}));
  rows.splice(9,0,row('world_state',{full:true,state}));});
const usage={input_tokens:10,cached_input_tokens:0,output_tokens:0,reasoning_output_tokens:0,total_tokens:10};
await refuses('ORIGINAL_HISTORY_TOKEN_USAGE_EFFECT_UNASSESSED',rows=>{rows.splice(12,0,row('event_msg',{type:'token_count',
  info:{total_token_usage:{...usage,output_tokens:10,total_tokens:20},last_token_usage:{...usage,output_tokens:1,total_tokens:11},model_context_window:258400},rate_limits:null}));});
await refuses('ORIGINAL_HISTORY_TOKEN_USAGE_EFFECT_UNASSESSED',rows=>{rows.splice(12,0,row('event_msg',{type:'token_count',
  info:{total_token_usage:{...usage,reasoning_output_tokens:10,total_tokens:20},last_token_usage:{...usage,reasoning_output_tokens:1,total_tokens:11},model_context_window:258400},rate_limits:null}));});
const priorTotals=records();priorTotals.splice(12,0,row('event_msg',{type:'token_count',info:{
  total_token_usage:{...usage,output_tokens:100,total_tokens:110},last_token_usage:usage,model_context_window:258400},rate_limits:null}));write(priorTotals);
assert.equal((await read()).proven,true,'cumulative prior output alone does not assert selected work');
await refuses('ORIGINAL_HISTORY_EVENT_FIELD_UNKNOWN',rows=>{rows[10].payload.user_message='unclassified future sidecar';});
await refuses('ORIGINAL_HISTORY_EVENT_FIELD_UNKNOWN',rows=>{rows[13].payload.tool_effect={unknown:true};});
await refuses('ORIGINAL_HISTORY_CONTEXT_FIELD_UNKNOWN',rows=>{rows[17].payload.extra_effect='unknown';});
const attribution=records();attribution[10].payload.turn_attribution={turn_id:'selected-T',turn_trigger:null,parent_turn_id:null,
  initiating_agent_path:null,root_turn_id:'selected-T'};write(attribution);
assert.equal((await read()).proven,true,'native attribution is causal identity, not accepted input');
const compactUsage={...usage,output_tokens:5,total_tokens:15};
const oldUsage={thread_id:threadId,turn_id:'prior-T',session_id:threadId,root_turn_id:'prior-T',response_id:'prior-response',
  usage:compactUsage,turn_token_usage:compactUsage,thread_token_usage:compactUsage};
const inheritedUsage=records();inheritedUsage.splice(8,0,row('token_usage_record',oldUsage));
inheritedUsage.find(r=>r.type==='compacted').payload.latest_token_usage_record=structuredClone(oldUsage);
inheritedUsage.at(-2).payload.info={total_token_usage:compactUsage,last_token_usage:compactUsage,model_context_window:258400};
write(inheritedUsage);assert.equal((await read()).proven,true,'compaction keeps the latest reachable usage even when no response replaces it');
function compactionResponseSource(){const rows=records(),compacted=rows[16];compacted.payload.compaction_response_id='exact-compaction-response';
  const start=rows.findIndex(r=>r.payload.type==='task_started'&&r.payload.turn_id==='compaction-T'),
    finish=rows.findIndex(r=>r.payload.type==='task_complete'&&r.payload.turn_id==='compaction-T');
  rows.splice(start,finish-start+1,begin('compaction-T'),
    row('token_usage_record',{thread_id:threadId,turn_id:'compaction-T',session_id:threadId,root_turn_id:'compaction-T',
      response_id:'exact-compaction-response',usage:compactUsage,turn_token_usage:compactUsage,thread_token_usage:compactUsage}),
    compacted,row('world_state',{full:true,state}),context('compaction-T'),
    row('event_msg',{type:'thread_settings_applied',thread_id:threadId,thread_settings:fixtureNativeSettings(binding)}),
    row('event_msg',{type:'token_count',info:{total_token_usage:compactUsage,last_token_usage:compactUsage,model_context_window:258400},rate_limits:null}),
    row('event_msg',{type:'item_completed',thread_id:threadId,turn_id:'compaction-T',
      item:{type:'ContextCompaction',id:'exact-native-compaction-item'},completed_at_ms:1}),end('compaction-T'));
  rows.splice(9,0,row('world_state',{full:true,state}));
  return rows;}
write(compactionResponseSource());const accounted=await read();assert.equal(accounted.proven,true,JSON.stringify(accounted));
if(accounted.proven){assert.equal(accounted.witness.spans[1]?.compactionCompletionRecords,1);assert.equal(accounted.witness.spans[1]?.responseUsageRecords,1);}
// Pinned quota telemetry describes the account; it does not change native settings
// or acknowledge an accepted input. Cumulative prior output stays prior work.
const quota={limit_id:'fixture-quota',limit_name:'ordinary quota',normal_model_slug:'quota-alias',
  primary:{used_percent:25.5,window_minutes:300,resets_at:1794528000},secondary:null,
  credits:{has_credits:true,unlimited:false,balance:'4.25'},
  individual_limit:{limit:'100',used:'25',remaining_percent:75,resets_at:1794528000},
  spend_control_reached:false,plan_type:'pro',rate_limit_reached_type:null};
const priorQuota=records();priorQuota.splice(8,0,row('event_msg',{type:'token_count',info:{
  total_token_usage:compactUsage,last_token_usage:compactUsage,model_context_window:258400},rate_limits:quota}));write(priorQuota);
assert.equal((await read()).proven,true,'source-defined preselected quota telemetry preserves prior output');
const suffixQuota=records();suffixQuota.at(-2).payload.rate_limits=quota;write(suffixQuota);
assert.equal((await read()).proven,true,'typed quota telemetry alone is neutral in the covered suffix');
for(const change of [(q:any)=>{q.unknown_setting=true;},(q:any)=>{q.primary.future_steering='hidden';},
  (q:any)=>{q.credits.has_credits='true';},(q:any)=>{q.rate_limit_reached_type='future-policy';}]){
  const rows=structuredClone(priorQuota);change(rows[8].payload.rate_limits);write(rows);const proof=await read();
  assert.equal(proof.proven,false);if(!proof.proven)assert.equal(proof.reasons[0]?.code,'ORIGINAL_HISTORY_TOKEN_METADATA_UNCLASSIFIED');
}
function checkpointSource(){
  const rows=compactionResponseSource();
  for(const r of rows)if(r.type==='response_item'&&r.payload.id===generated.id)
    r.metadata={client_authored:false,mcp_attribution:{status:'none'}};
  const attribution={turn_id:'selected-T',turn_trigger:null,parent_turn_id:null,initiating_agent_path:null,root_turn_id:'selected-T'};
  rows.find(r=>r.payload.type==='task_started'&&r.payload.turn_id==='selected-T').payload.turn_attribution=attribution;
  for(const r of rows)if(r.type==='turn_context')Object.assign(r.payload,{comp_hash:'native-model-compatibility',realtime_active:false,multi_agent_version:'v1'});
  const accepted=rows.find(r=>r.type==='response_item'&&r.payload.id==='prior-native-item');
  accepted.payload.internal_chat_message_metadata_passthrough={turn_id:'prior-T',content_item_kinds:['user.text']};
  const userSource={id:{message_id:'prior-native-item',turn_id:'prior-T',role:'user'},revision:'retained-user-revision',complete:true};
  accepted.metadata={client_authored:false,user_input_order:7,retained_source:userSource,mcp_attribution:{status:'none'}};
  const assistant={type:'message',id:'prior-assistant-item',role:'assistant',phase:'final_answer',
    content:[{type:'output_text',text:'earlier preserved assistant answer'}],internal_chat_message_metadata_passthrough:{turn_id:'prior-T'}};
  const assistantSource={id:{message_id:assistant.id,turn_id:'prior-T',role:'assistant'},revision:'retained-assistant-revision',complete:true};
  const assistantMetadata={client_authored:false,user_input_order:8,retained_source:assistantSource,mcp_attribution:{status:'none'}};
  rows.splice(rows.findIndex(r=>r.payload.type==='task_complete'&&r.payload.turn_id==='prior-T'),0,row('response_item',assistant,assistantMetadata));
  const compacted=rows.find(r=>r.type==='compacted').payload;
  compacted.replacement_history=[structuredClone(accepted.payload),generated,assistant,
    {type:'compaction',id:'opaque-native-item',encrypted_content:'opaque fixture ciphertext',
      internal_chat_message_metadata_passthrough:{turn_id:'compaction-T',create_time:1794528000}}];
  compacted.replacement_history_metadata=[structuredClone(accepted.metadata),{client_authored:false,mcp_attribution:{status:'none'}},
    assistantMetadata,{client_authored:false,compaction_model_hash:'native-model-compatibility',mcp_attribution:{status:'none'}}];
  compacted.retained_context={verified_answers:[],incomplete:false,user_messages:[{revision:userSource.revision,order:7,
    turn_id:'prior-T',message_id:userSource.id.message_id,text:accepted.payload.content[0].text,complete:true}],
    user_messages_incomplete:false,assistant_messages:[{revision:assistantSource.revision,order:8,turn_id:'prior-T',
      message_id:assistant.id,text:assistant.content[0].text,complete:true,phase:'final_answer'}],
    assistant_messages_incomplete:false,next_order:9};
  compacted.resume_metadata={multi_agent_version:'v1',last_started_turn_id:'compaction-T',
    turn_attribution:attribution,previous_turn_settings:{model:binding.model,comp_hash:'native-model-compatibility',realtime_active:false}};
  compacted.latest_token_usage_record=rows.find(r=>r.type==='token_usage_record').payload;
  return rows;
}
write(checkpointSource());const checkpointProof=await read();assert.equal(checkpointProof.proven,true,JSON.stringify(checkpointProof));
if(checkpointProof.proven){
  assert.equal(checkpointProof.witness.compactionRecords[0].replacementClassifications.historicalRetainedSource,2);
  assert.equal(checkpointProof.witness.compactionRecords[0].replacementClassifications.opaqueCompactionContext,1);
  assert.equal(checkpointProof.witness.compactionRecords[0].retainedSourceRefs.length,2);
  assert.ok(checkpointProof.witness.compactionRecords[0].resumeSourceRefs?.attributionRecord);
  assert.ok(!JSON.stringify(checkpointProof.witness).includes('earlier preserved assistant answer'));
}
const earlierRetained=records(),retainedFacts={verified_answers:[{revision:'answer-revision',order:6,turn_id:'prior-T',call_id:'prior-answer',
  questions:[{question:'earlier question',answer:'earlier verified reply'}]}],incomplete:false,
  user_messages:[],user_messages_incomplete:false,assistant_messages:[],assistant_messages_incomplete:false,next_order:7,sender_deliveries:[]};
earlierRetained.splice(8,0,row('compacted',{message:'prior checkpoint',replacement_history:[],retained_context:retainedFacts}),context('prior-T'));
earlierRetained.find((r,index)=>index>10&&r.type==='compacted').payload.retained_context=structuredClone(retainedFacts);
write(earlierRetained);const retainedCopy=await read();assert.equal(retainedCopy.proven,true,JSON.stringify(retainedCopy));
if(retainedCopy.proven)assert.equal(retainedCopy.witness.compactionRecords.at(-1)?.replacementClassifications.historicalRetainedCheckpoint,1);
const newFacts=structuredClone(earlierRetained);newFacts.find((r,index)=>index>10&&r.type==='compacted').payload.retained_context.verified_answers[0].questions[0].answer='new unproved grant';
write(newFacts);assert.equal((await read()).proven,false,'a copied earlier family cannot launder a changed verified answer');
for(const [code,change] of [
  ['ORIGINAL_HISTORY_RETAINED_CONTEXT_SOURCE_UNPROVEN',(p:any)=>{p.retained_context.user_messages[0].revision='borrowed-revision';}],
  ['ORIGINAL_HISTORY_RETAINED_CONTEXT_SOURCE_UNPROVEN',(p:any)=>{p.retained_context.user_messages[0].turn_id='selected-T';}],
  ['ORIGINAL_HISTORY_RETAINED_CONTEXT_SOURCE_UNPROVEN',(p:any)=>{p.retained_context.user_messages[0].inherited=true;}],
  ['ORIGINAL_HISTORY_RETAINED_CONTEXT_SOURCE_UNPROVEN',(p:any)=>{p.retained_context.user_messages[0].order=8;}],
  ['ORIGINAL_HISTORY_RETAINED_CONTEXT_PAYLOAD_UNPROVEN',(p:any)=>{p.retained_context.user_messages[0].text='new instruction';}],
  ['ORIGINAL_HISTORY_COMPACTION_SIDECAR_UNCLASSIFIED',(p:any)=>{p.retained_context.hidden_acknowledgement=true;}],
  ['ORIGINAL_HISTORY_RETAINED_EVENT_INVALID',(p:any)=>{p.retained_context.verified_answers=[{turn_id:'selected-T'}];}],
  ['ORIGINAL_HISTORY_COMPACTION_RESUME_STATE_UNPROVEN',(p:any)=>{p.resume_metadata.last_started_turn_id='unseen-T';}],
  ['ORIGINAL_HISTORY_COMPACTION_RESUME_STATE_UNPROVEN',(p:any)=>{p.resume_metadata.previous_turn_settings.realtime_active=true;}],
  ['ORIGINAL_HISTORY_COMPACTION_RESUME_STATE_UNPROVEN',(p:any)=>{p.resume_metadata.turn_attribution={turn_id:'unseen-T'};}],
  ['ORIGINAL_HISTORY_COMPACTION_PRODUCER_CONSUMER_COMPATIBILITY_UNPROVEN',(p:any)=>{p.replacement_history_metadata[3].compaction_model_hash='unproven-model';}],
  ['ORIGINAL_HISTORY_ENVELOPE_FIELD_UNKNOWN',(p:any)=>{p.replacement_history_metadata[1].unknown_future_provenance=null;}],
] as [string,(p:any)=>void][]){
  const rows=checkpointSource();change(rows.find(r=>r.type==='compacted').payload);write(rows);const proof=await read();
  assert.equal(proof.proven,false,code);if(!proof.proven)assert.equal(proof.reasons[0]?.code,code,JSON.stringify(proof));
}
const opaqueExtra=checkpointSource();opaqueExtra.find(r=>r.type==='compacted').payload.replacement_history[3].unknown_sidecar={tool:'hidden'};write(opaqueExtra);
assert.equal((await read()).proven,false,'opaque native context cannot hide unknown item sidecars');
const wrongUsage=compactionResponseSource();wrongUsage.find(r=>r.type==='token_usage_record')!.payload.response_id='unrelated-response';write(wrongUsage);
const wrongUsageProof=await read();assert.equal(wrongUsageProof.proven,false);if(!wrongUsageProof.proven)assert.equal(wrongUsageProof.reasons[0]?.code,'ORIGINAL_HISTORY_TOKEN_USAGE_EFFECT_UNASSESSED');
const missingCompletion=compactionResponseSource().filter(r=>r.payload.type!=='item_completed');write(missingCompletion);
const missingCompletionProof=await read();assert.equal(missingCompletionProof.proven,false);
const uncounted=compactionResponseSource();uncounted.find(r=>r.type==='token_usage_record')!.payload.turn_token_usage={...compactUsage,output_tokens:6};write(uncounted);
const uncountedProof=await read();assert.equal(uncountedProof.proven,false);if(!uncountedProof.proven)assert.equal(uncountedProof.reasons[0]?.code,'ORIGINAL_HISTORY_TOKEN_USAGE_RESPONSE_COVERAGE_UNPROVEN');
const hiddenTool=compactionResponseSource();hiddenTool.splice(16,0,row('response_item',{type:'function_call',name:'hidden',call_id:'call',arguments:'{}'}));write(hiddenTool);
assert.equal((await read()).proven,false,'compaction usage identity cannot mask another tool effect');
await refuses('ORIGINAL_HISTORY_SELECTED_COMPACTION_PRESENT',rows=>{rows.splice(13,0,row('event_msg',{type:'item_completed',
  thread_id:threadId,turn_id:'selected-T',item:{type:'ContextCompaction',id:'selected-typed-only'},completed_at_ms:1}));});
const wrongSession=compactionResponseSource();wrongSession.find(r=>r.type==='token_usage_record')!.payload.session_id='different-runtime-session';write(wrongSession);
const wrongSessionProof=await read();assert.equal(wrongSessionProof.proven,false);if(!wrongSessionProof.proven)assert.equal(wrongSessionProof.reasons[0]?.code,'ORIGINAL_HISTORY_TOKEN_SESSION_IDENTITY_CONFLICT');
const legacySession=compactionResponseSource();delete legacySession[0].payload.session_id;write(legacySession);
assert.equal((await read()).proven,true,'pinned omitted session_id fallback retains exact thread identity');
const coherent=records();coherent[2].payload.approval_policy='on-request';coherent[12].payload.approval_policy='on-request';write(coherent);
const coherentProof=await read();assert.equal(coherentProof.proven,false);if(!coherentProof.proven)assert.equal(coherentProof.reasons[0]?.code,'ORIGINAL_HISTORY_SETTINGS_BASELINES_CONFLICT');
await refuses('ORIGINAL_HISTORY_NATIVE_ORDER_OR_SUFFIX_CONFLICT',rows=>{rows.push(begin('unmapped-T'),context('unmapped-T'),end('unmapped-T'));});
write();writeFileSync(path,Buffer.concat([readFileSync(path).subarray(0,-1),Buffer.from([0xff,10])]));
assert.equal((await read()).proven,false,'strict invalid UTF-8 refuses');
writeFileSync(path,serialize(records())+'{"type": broken}\n');
const malformed=await read();assert.equal(malformed.proven,false);if(!malformed.proven)assert.equal(malformed.reasons[0]?.code,'ORIGINAL_HISTORY_RECORD_DECODE_FAILED');
writeFileSync(path,serialize(records()).slice(0,-1));
const partial=await read();assert.equal(partial.proven,false);if(!partial.proven)assert.equal(partial.reasons[0]?.code,'ORIGINAL_HISTORY_PARTIAL_FINAL_RECORD');
const paginated=records().map((r,index)=>({...r,ordinal:index}));paginated[0].payload.history_mode='paginated';write(paginated);
const ordinalProof=await read();assert.equal(ordinalProof.proven,true,JSON.stringify(ordinalProof));
paginated[12].ordinal=999;write(paginated);const gap=await read();assert.equal(gap.proven,false);if(!gap.proven)assert.equal(gap.reasons[0]?.code,'ORIGINAL_HISTORY_ORDINAL_COVERAGE_INVALID');
const distinct=records();distinct[0].payload.session_id='distinct-runtime-session';distinct.push(row('event_msg',{type:'token_count',info:null,rate_limits:null}));write(distinct);
const neutral=await read();assert.equal(neutral.proven,true,JSON.stringify(neutral));
if(neutral.proven){assert.equal(neutral.witness.sourceSessionId,'distinct-runtime-session');assert.equal(neutral.witness.neutralOutsideTurnRecords.length,1);}
const high=records();for(const r of high){if(r.type==='turn_context')r.payload.effort='high';if(r.payload.type==='thread_settings_applied')r.payload.thread_settings=fixtureNativeSettings({...binding,effort:'high'});}write(high);
assert.equal((await readCodexOriginalHistoryCoverage({...input,binding:{...binding,effort:'high'}})).proven,true,'exact supported effort is preserved generically');
const outside=join(scratch,'outside.jsonl');writeFileSync(outside,serialize(records()));
const badPath=await readCodexOriginalHistoryCoverage({...input,client:{async request(){return {thread:{id:threadId,path:outside}};}}});
assert.equal(badPath.proven,false);if(!badPath.proven)assert.equal(badPath.reasons[0]?.code,'ORIGINAL_HISTORY_SOURCE_PATH_UNSUPPORTED');
write();const alias=join(home,'authoritative-alias.jsonl');symlinkSync(path,alias);
const aliased=await readCodexOriginalHistoryCoverage({...input,client:{async request(){return {thread:{id:threadId,path:alias}};}}});
assert.equal(aliased.proven,true);if(!aliased.proven)throw new Error('fixture');
rmSync(alias);symlinkSync(outside,alias);
assert.equal(revalidateCodexOriginalHistorySource(aliased.custody,aliased.witness).valid,false,'authoritative symlink re-target refuses');
write();const competingRead=read();
await new Promise<void>(resolve=>setTimeout(()=>{appendFileSync(path,serialize([row('unknown_concurrent_record',{})]));resolve();},0));
const competed=await competingRead;
assert.ok(!competed.proven||!revalidateCodexOriginalHistorySource(competed.custody,competed.witness).valid,
  'concurrent physical append cannot leave a reusable source witness');

// The same existing permit/intent ledger and a retained owned resume receipt
// establish append authority; caller assertions cannot substitute for these rows.
const db=new Database(':memory:');
db.exec(`CREATE TABLE codex_mutation_intents(intent_id TEXT,permit_id TEXT,method TEXT,response_kind TEXT,response_digest TEXT,state TEXT,
 thread_id TEXT,fence_id TEXT,accepted_input_id TEXT,run_id TEXT,dispatch_attempt INTEGER);
 CREATE TABLE codex_mutation_permits(permit_id TEXT,purpose TEXT);
 CREATE TABLE codex_recovery_dispatch_authorizations(resume_permit_id TEXT,fence_id TEXT,binding_json TEXT,
 accepted_input_id TEXT,run_id TEXT,dispatch_attempt INTEGER,thread_id TEXT);
 CREATE TABLE codex_thread_mutation_fences(fence_id TEXT,state TEXT,thread_id TEXT,accepted_input_id TEXT,run_id TEXT,dispatch_attempt INTEGER);`);
db.query('INSERT INTO codex_mutation_intents VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('resume-intent','resume-permit','thread/resume','accepted','actual-resume-reply','reconciled_applied',threadId,'fence','selected','run:30',2);
db.query('INSERT INTO codex_mutation_permits VALUES(?,?)').run('resume-permit','fenced_recovery');
db.query('INSERT INTO codex_recovery_dispatch_authorizations VALUES(?,?,?,?,?,?,?)').run('resume-permit','fence',JSON.stringify(binding),'selected','run:30',2,threadId);
db.query('INSERT INTO codex_thread_mutation_fences VALUES(?,?,?,?,?,?)').run('fence','active',threadId,'selected','run:30',2);
const checkpoint=()=>row('event_msg',{type:'thread_settings_applied',thread_id:threadId,thread_settings:fixtureNativeSettings(binding)});
async function resumeCase(extra:any[],expected?:string,change?:()=>void){write();const original=await read();assert.equal(original.proven,true);if(!original.proven)throw new Error('fixture');
  appendFileSync(path,serialize(extra));change?.();
  const refreshed=await refreshCodexOriginalHistoryAfterOwnedResume({db,intentId:'resume-intent',witness:original.witness,custody:original.custody});
  assert.equal(refreshed.proven,!expected,JSON.stringify(refreshed));
  if(!refreshed.proven)assert.equal(refreshed.reasons[0]?.code,expected);
  else {assert.equal(refreshed.witness.ownedResumeCheckpoint?.previousWitnessDigest,original.witness.witnessDigest);
    assert.equal(revalidateCodexOriginalHistorySource(refreshed.custody,refreshed.witness).valid,true);
    assert.equal(revalidateCodexOriginalHistorySource(original.custody,original.witness).valid,false);}
}
await resumeCase([checkpoint()]);
await resumeCase([checkpoint(),row('event_msg',{type:'token_count'})],'ORIGINAL_HISTORY_OWNED_RESUME_APPEND_NOT_EXACT');
const wrong=checkpoint();wrong.payload.thread_settings.reasoning_effort='high';await resumeCase([wrong],'ORIGINAL_HISTORY_OWNED_RESUME_SETTINGS_CONFLICT');
for(const [key,value] of Object.entries({approval_policy:'on-request',cwd:'/other',permission_profile:{type:'external',network:'enabled'},
  runtime_workspace_roots:['/other'],disabled_plugin_ids:['unexpected'],unknown_future_setting:{changed:true}})){
  const changed=checkpoint();(changed.payload.thread_settings as any)[key]=value;
  await resumeCase([changed],'ORIGINAL_HISTORY_OWNED_RESUME_SETTINGS_CONFLICT');
}
await resumeCase([checkpoint()],'ORIGINAL_HISTORY_OWNED_RESUME_RECEIPT_UNPROVEN',()=>db.query("UPDATE codex_mutation_intents SET response_kind='rpc_error'").run());
db.query("UPDATE codex_mutation_intents SET response_kind='accepted'").run();
await resumeCase([checkpoint()],'ORIGINAL_HISTORY_OWNED_RESUME_PREFIX_CHANGED',()=>{const bytes=readFileSync(path);bytes[bytes.indexOf('prior preserved request')]=88;writeFileSync(path,bytes);});
db.close();rmSync(scratch,{recursive:true,force:true});
console.log('Codex original history coverage: real files, legacy Medium, preserved prior effects, exact generated context and compaction provenance, strict source/record faults and owned-resume append passed');
