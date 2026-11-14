import assert from 'node:assert/strict';
import {proveCodexContinuationNativeInterval,type CodexHistoryReadClient} from '../src/codex-continuation-native-interval';
import type {AcceptedBindingContinuationSnapshot,ContinuationInput} from '../src/codex-accepted-binding-continuation';

const binding={sessionId:90,provider:'codex',threadId:'retained-thread',generation:1,model:'gpt-6-astra',effort:'medium',runner:null};
const row=(id:string,ordinal:number,turnId:number|null,extra:any={}):ContinuationInput=>({id,ordinal,session_id:90,
  kind:'input',origin:'agent',turn_id:turnId,steering_id:null,request_id:null,source_input_id:null,source_run_id:null,
  payload_json:'{}',receipt_json:null,...extra});
const admission=(id:string,turnId:number)=>({provider:'codex',inputId:id,runId:`run:${turnId}`,bindingGeneration:1,model:'gpt-6-astra',nativeBinding:null});
const turn=(id:number,accepted_input_id:string,attempts=1,acknowledged=false)=>({id,session_id:90,accepted_input_id,
  native_run_id:`run:${id}`,dispatch_attempt:attempts,status:'done',provider_input_acknowledged_at:acknowledged?'ack':null,
  stop_requested_at:null,owner_instance_id:null,provider_turn_id:`native:${id}:${attempts}`,outbound_text:null as string|null});
const create=row('request:create',1,1,{kind:'create',payload_json:JSON.stringify({provider:'codex',model:'gpt-6-astra',reasoningEffort:'medium'}),
  receipt_json:JSON.stringify({admission:admission('request:create',1)})});
const source=row('request:work',2,2);
const selected=row('report-back:work',3,3,{origin:'service',request_id:'work',source_input_id:source.id,source_run_id:'run:2',
  receipt_json:JSON.stringify({admission:admission('report-back:work',3)})});
const info=row('request:info',4,4,{request_id:'info'}),compaction=row('report-back:closed-info',5,5,{origin:'service',request_id:'closed-info'});
const never=row('request:never-admitted',6,null,{request_id:'never',receipt_json:'{"state":"failed"}'});
function make():AcceptedBindingContinuationSnapshot {
  const events:any[]=[],turns=[turn(1,create.id,1,true),turn(2,source.id,1,true),turn(3,selected.id,2),turn(4,info.id),turn(5,compaction.id)];
  const event=(event_id:string,input_id:string|null,turn_id:number,kind:string,payload:any)=>
    events.push({event_id,input_id,turn_id,session_id:90,kind,payload_json:JSON.stringify(payload)});
  for(const t of turns.slice(2))for(let attempt=1;attempt<=t.dispatch_attempt;attempt++){
    event(`prompt-cache-identity:${t.id}:${attempt}`,null,t.id,'prompt_cache_identity',{effort:'medium'});
    if(t.id!==5)event(`provider-turn-attempt:${t.id}:${attempt}`,t.accepted_input_id,t.id,'provider_turn_attempt',
      {provider:'codex',providerTurnId:`native:${t.id}:${attempt}`,dispatchAttempt:attempt});
  }
  const legacy=turns[4]!;
  const providerResult={text:'',sessionUUID:binding.threadId,toolsUsed:[],providerTurnId:'native:5:1',model:binding.model,durationMs:13};
  legacy.outbound_text=JSON.stringify({version:1,result:providerResult});
  event('result:5',compaction.id,5,'result',{...providerResult,turnId:5,sessionId:90,inputId:compaction.id,runId:'run:5'});
  event(`attention:${compaction.id}:1`,compaction.id,5,'attention',{dispatchAttempt:1});
  const requests=[{request_id:'work',target_session_id:90,target_input_id:source.id,outcome:null,payload_json:'{"requestedEffect":"work"}'},
    {request_id:'info',target_session_id:90,target_input_id:info.id,outcome:'failed',payload_json:'{"requestedEffect":"informational"}'},
    {request_id:'closed-info',target_session_id:90,target_input_id:'request:closed-info',outcome:'failed',payload_json:'{"requestedEffect":"informational"}'},
    {request_id:'never',target_session_id:90,target_input_id:never.id,outcome:'failed',payload_json:'{"requestedEffect":"informational"}'}];
  return {binding:{...binding},creation:{input:structuredClone(create),turn:turns[0]!},source:{input:structuredClone(source),turn:turns[1]!},
    selected:{input:structuredClone(selected),turn:turns[2]!},request:requests[0]!,
    creationBinding:{reference:'result:1',binding:{...binding}},selectedBinding:{reference:'result:3:attempt:2',binding:{...binding}},events,
    controls:{reference:'current-session:90',outside:false,suspended:false,archived:false,consultationOnly:false,stopRequested:false,activeHandoffIds:[]},
    interval:{complete:true,fromOrdinal:3,throughOrdinal:6,inputs:structuredClone([selected,info,compaction,never]),
      classifications:[selected,info,compaction,never].map(input=>({inputId:input.id,reference:input.id,
        significance:input.id===selected.id?'selected':'neutral'})),
      mutationCoverage:{complete:true,reference:'owner-mutations:1:6',fromInputId:create.id,changes:[]},
      fifo:{complete:true,reference:'actual-scheduler:3',selectedInputId:selected.id,runnablePredecessorInputIds:[]}},
    ownerSnapshot:{turns,requests,steering:[],deliveries:[],predecessors:[],active:[]}};
}
const native=()=>[
  {id:'prior-acknowledged-work',status:'completed',error:null},
  {id:'native:3:1',status:'completed',error:null},{id:'native:3:2',status:'completed',error:null},
  {id:'native:4:1',status:'completed',error:null},{id:'native:5:1',status:'completed',error:null}];
function client(options:{turns?:any[];items?:Record<string,any[]>;alter?:(method:string,params:any,page:any)=>any}={}):CodexHistoryReadClient {
  const turns=options.turns??native(),items=options.items??{'native:5:1':[{id:'independent-compaction',type:'contextCompaction'}]};
  return {async request(method,params){
    let page:any;
    if(method==='thread/turns/list'){
      // Two complete pages, with summary items omitted: only item pages count.
      page=params.cursor===null?{data:turns.slice(0,3),nextCursor:'turn-page-2'}:{data:turns.slice(3),nextCursor:null};
    }else page={data:(items[String(params.turnId)]??[]).map(item=>({turnId:params.turnId,item})),nextCursor:null};
    return options.alter?options.alter(method,params,page):page;
  }};
}
const initial=make(),before=JSON.stringify(initial);
const proof=await proveCodexContinuationNativeInterval({snapshot:initial,client:client()});
assert.equal(proof.proven,true,JSON.stringify(proof.reasons));
assert.equal(JSON.stringify(initial),before,'native evidence collection never mutates owner snapshot');
assert.equal(proof.authorizesProviderStart,false);
if(proof.proven){
  assert.equal(proof.attempts.length,4);
  assert.deepEqual(proof.coverage.map(row=>row.classification),['empty','empty','empty','independent_compaction']);
  assert.equal(proof.nativeWatermark,'native:5:1');
  assert.equal(proof.requiresHeldThreadFence,true);
  assert.equal(proof.coverage[3]!.itemCount,1,'distinct compaction does not stand in for missing selected-attempt history');
}
async function refuses(code:string,options:Parameters<typeof client>[0]={},change?:(snapshot:AcceptedBindingContinuationSnapshot)=>void){
  const snapshot=make();change?.(snapshot);
  const result=await proveCodexContinuationNativeInterval({snapshot,client:client(options)});
  assert.equal(result.proven,false,code);
  assert.ok(result.reasons.some(reason=>reason.code===code),`${code}: ${JSON.stringify(result.reasons)}`);
}
await refuses('EXACT_ACCEPTED_INPUT_ACKNOWLEDGED',{items:{'native:3:1':[{id:'ack',type:'userMessage',clientId:'slack-concierge:turn:3:attempt:1'}]}});
await refuses('NATIVE_USER_CONTEXT_COVERAGE_UNCERTAIN',{items:{'native:5:1':[{id:'generated-context',type:'userMessage'}]}});
for(const type of ['agentMessage','commandExecution','reasoning','unknownFutureItem'])
  await refuses('NATIVE_CONVERSATIONAL_TOOL_OR_UNKNOWN_ITEM_PRESENT',{items:{'native:4:1':[{id:'effect',type}]}});
await refuses('NATIVE_CONVERSATIONAL_TOOL_OR_UNKNOWN_ITEM_PRESENT',{items:{'native:3:1':[{id:'compaction',type:'contextCompaction'}]}});
await refuses('UNMAPPED_NATIVE_SUFFIX_TURN',{turns:[...native(),{id:'foreign-native',status:'completed',error:null}]});
await refuses('MAPPED_NATIVE_ATTEMPT_ABSENT',{turns:native().filter(turn=>turn.id!=='native:3:1')});
await refuses('NATIVE_ATTEMPT_NOT_SUCCESSFULLY_TERMINAL',{turns:native().map(turn=>turn.id==='native:4:1'?{...turn,status:'inProgress'}:turn)});
await refuses('NATIVE_HISTORY_PAGE_INCOMPLETE',{alter:(method,_params,page)=>method==='thread/items/list'?{data:page.data}:page});
await refuses('NATIVE_HISTORY_PAGE_INCOMPLETE',{alter:(_method,_params,page)=>({...page,nextCursor:null,hasMore:true})});
await refuses('NATIVE_HISTORY_CURSOR_LOOP',{alter:(method,_params,page)=>method==='thread/turns/list'?{...page,nextCursor:'loop'}:page});
await refuses('NATIVE_HISTORY_CURSOR_LOOP',{alter:(method,_params,page)=>method==='thread/items/list'?{...page,nextCursor:'loop'}:page});
await refuses('EXACT_NATIVE_TURN_ITEM_COVERAGE_INVALID',{alter:(method,_params,page)=>method==='thread/items/list'
  ?{data:[{turnId:'other-turn',item:{id:'wrong',type:'contextCompaction'}}],nextCursor:null}:page});
await refuses('LEGACY_RESULT_ENVELOPE_NOT_PROVEN',{},s=>{(s.ownerSnapshot as any).turns[4].outbound_text='{"version":1,"result":{}}';});
await refuses('LEGACY_ATTEMPT_IDENTITY_NOT_PROVEN',{},s=>{s.events=s.events.filter(event=>event.kind!=='attention');});
await refuses('OWNER_ATTEMPT_MAPPING_INCOMPLETE',{},s=>{s.events.push({event_id:'unexpected-provider-attempt',session_id:90,input_id:selected.id,
  turn_id:3,kind:'provider_turn_attempt',payload_json:'{"provider":"codex","dispatchAttempt":7,"providerTurnId":"unmapped"}'});});
await refuses('LATER_INPUT_NOT_CLOSED_CANONICAL_INFORMATIONAL',{},s=>{(s.ownerSnapshot as any).requests[1].outcome=null;});
await refuses('LATER_INPUT_NOT_CLOSED_CANONICAL_INFORMATIONAL',{},s=>{(s.ownerSnapshot as any).requests[1].payload_json='{"requestedEffect":"work"}';});
await refuses('NEVER_ADMITTED_INFORMATIONAL_TERMINAL_PROOF_MISSING',{},s=>{s.interval.inputs[3]!.receipt_json='{}';});
await refuses('INTERVAL_STEERING_REQUIRES_RECONCILIATION',{},s=>{(s.ownerSnapshot as any).steering.push({turn_id:4,status:'ambiguous'});});
await refuses('INTERVAL_PRODUCT_DELIVERY_PRESENT',{},s=>{(s.ownerSnapshot as any).deliveries.push({turn_id:4});});
await refuses('OWNER_QUEUE_PRECEDENCE_OR_ACTIVE_TURN_PRESENT',{},s=>{(s.ownerSnapshot as any).predecessors.push({accepted_input_id:'earlier-work'});});
let listRequests=0;
await refuses('NATIVE_WATERMARK_CHANGED_DURING_INSPECTION',{alter:(method,params,page)=>{
  if(method==='thread/turns/list'&&params.cursor===null)listRequests++;
  return listRequests>1&&method==='thread/turns/list'&&params.cursor!==null
    ?{...page,data:[...page.data,{id:'new-native',status:'completed',error:null}]}:page;
}});
console.log('Codex native continuation interval: all selected/later attempts, exact legacy result mapping, full paginated persisted suffix, compaction and refusal controls passed');
