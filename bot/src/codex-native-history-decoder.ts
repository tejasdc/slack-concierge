import catalogue from './codex-native-event-catalogue.json';
import {acceptedBindingSnapshotDigest as digest} from './codex-accepted-binding-continuation';
import {matchesPinnedNativeResponse,nativeResponseSchemaIdentity} from './codex-native-response-shape';
import {nativeSourceIntegerAt} from './codex-native-source-values';

// Vocabulary is pinned, not inferred from the installed CLI or the first failing
// record. Recognition never implies that an effect is admissible for recovery.
export const CODEX_HISTORY_INTERPRETATION={upstreamCommit:catalogue.upstreamCommit,
  tag:catalogue.tag,decoder:'original_history_decoder_v2',reducer:'preserved_baseline_interval_v2',
  catalogueDigest:digest(catalogue),responseSchema:nativeResponseSchemaIdentity,sourceNumbers:'lexical_numeric_identity_v1'} as const;
export const rolloutKinds=['session_meta','response_item','inter_agent_communication',
  'inter_agent_communication_metadata','compacted','turn_context','token_usage_record','world_state',
  'retained_context','security_risk_score','event_msg','realtime_item'] as const;
const obj=(v:any)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const str=(v:any)=>typeof v==='string';
const opt=(v:any,f:(v:any)=>boolean)=>v==null||f(v);
const uint=(v:any)=>Number.isSafeInteger(v)&&v>=0;
const fields=(v:any,names:readonly string[])=>obj(v)&&Object.keys(v).every(k=>names.includes(k));
export class NativeHistoryDecodeError extends Error {constructor(readonly code:string){super(code);}}
const fail=(code:string):never=>{throw new NativeHistoryDecodeError(code);};
const passthrough=['turn_id','create_time','content_item_kinds','cell_id','executed_tool_calls','tool_calls_complete'];
const harness=['guardian_sources','guardian_review_ids','guardian_source_order_guidance','guardian_retained_omissions',
  'retained_source','client_authored','fallback_token_limit_override','delivered_assistant_message',
  'harness_authored_configuration','compaction_model_hash','user_input_order','compaction_output',
  'inherited_user_message','mcp_attribution','sender_user_messages'];
export function decodeHarnessMetadata(v:any){
  if(v==null)return;
  if(!fields(v,harness))fail('ORIGINAL_HISTORY_ENVELOPE_FIELD_UNKNOWN');
  for(const k of ['client_authored','guardian_source_order_guidance','harness_authored_configuration','compaction_output','inherited_user_message'])
    if(Object.hasOwn(v,k)&&typeof v[k]!=='boolean')fail('ORIGINAL_HISTORY_ENVELOPE_SHAPE_INVALID');
  for(const k of ['compaction_model_hash','delivered_assistant_message'])if(!opt(v[k],str))fail('ORIGINAL_HISTORY_ENVELOPE_SHAPE_INVALID');
  for(const k of ['user_input_order','fallback_token_limit_override'])if(v[k]!=null&&(!uint(v[k])||!nativeSourceIntegerAt(v,k)))fail('ORIGINAL_HISTORY_ENVELOPE_SHAPE_INVALID');
  for(const k of ['guardian_sources','guardian_review_ids'])if(Object.hasOwn(v,k)&&!Array.isArray(v[k]))fail('ORIGINAL_HISTORY_ENVELOPE_SHAPE_INVALID');
  for(const k of ['retained_source','guardian_retained_omissions','mcp_attribution','sender_user_messages'])
    if(!opt(v[k],obj))fail('ORIGINAL_HISTORY_ENVELOPE_SHAPE_INVALID');
  const source=(s:any)=>fields(s,['id','revision','complete'])&&fields(s.id,['message_id','turn_id','role'])
    &&str(s.id.message_id)&&str(s.id.turn_id)&&['user','assistant'].includes(s.id.role)&&str(s.revision)&&typeof s.complete==='boolean';
  if(!opt(v.retained_source,source)||!opt(v.guardian_sources,x=>x.every(source))
    ||!opt(v.guardian_review_ids,x=>x.every(str))
    ||!opt(v.guardian_retained_omissions,x=>fields(x,['user_instructions','assistant_context'])
      &&typeof x.user_instructions==='boolean'&&typeof x.assistant_context==='boolean')
    ||!opt(v.sender_user_messages,x=>fields(x,['receiver_turn_id','receiver_message_id','text'])
      &&str(x.receiver_turn_id)&&str(x.receiver_message_id)&&str(x.text)))fail('ORIGINAL_HISTORY_ENVELOPE_PROVENANCE_INVALID');
  if(!opt(v.mcp_attribution,x=>fields(x,['status','sources','error_reason'])
    &&['none','complete','attribution_error'].includes(x.status)&&opt(x.error_reason,str)
    &&opt(x.sources,s=>Array.isArray(s)&&s.every((s:any)=>fields(s,['connector_id','plugin_id','server_name','tool_name','first_turn_id'])
      &&str(s.server_name)&&str(s.tool_name)&&str(s.first_turn_id)&&opt(s.connector_id,str)&&opt(s.plugin_id,str)))))
    fail('ORIGINAL_HISTORY_ENVELOPE_PROVENANCE_INVALID');
}
export function decodeRetainedCheckpoint(v:any){
  if(!fields(v,['verified_answers','incomplete','user_messages','user_messages_incomplete','assistant_messages',
    'assistant_messages_incomplete','next_order','sender_deliveries'])||!Array.isArray(v.verified_answers)
    ||typeof v.incomplete!=='boolean')fail('ORIGINAL_HISTORY_COMPACTION_SIDECAR_UNCLASSIFIED');
  for(const key of ['user_messages','assistant_messages','sender_deliveries'])if(!opt(v[key],Array.isArray))
    fail('ORIGINAL_HISTORY_COMPACTION_SIDECAR_UNCLASSIFIED');
  for(const key of ['user_messages_incomplete','assistant_messages_incomplete'])if(!opt(v[key],x=>typeof x==='boolean'))
    fail('ORIGINAL_HISTORY_COMPACTION_SIDECAR_UNCLASSIFIED');
  if(!opt(v.next_order,uint))fail('ORIGINAL_HISTORY_COMPACTION_SIDECAR_UNCLASSIFIED');
  if(v.next_order!=null&&!nativeSourceIntegerAt(v,'next_order'))fail('ORIGINAL_HISTORY_COMPACTION_SIDECAR_UNCLASSIFIED');
  const families:Record<string,string[]>={verified_answers:['turn_id','call_id','questions'],
    user_messages:['turn_id','message_id','text','complete','origin','phase'],
    assistant_messages:['turn_id','message_id','text','complete','origin','phase'],
    sender_deliveries:['receiver_turn_id','receiver_message_id','text']};
  for(const [family,keys] of Object.entries(families))for(const e of v[family]??[]){
    if(!fields(e,['revision','inherited','order',...keys])||!opt(e.revision,str)||!opt(e.order,uint)
      ||!opt(e.inherited,x=>typeof x==='boolean'))fail('ORIGINAL_HISTORY_RETAINED_CONTEXT_SOURCE_UNPROVEN');
    if(e.order!=null&&!nativeSourceIntegerAt(e,'order'))fail('ORIGINAL_HISTORY_RETAINED_CONTEXT_SOURCE_UNPROVEN');
    if(family==='verified_answers'){
      if(!str(e.turn_id)||!str(e.call_id)||!Array.isArray(e.questions)
        ||e.questions.some((q:any)=>!fields(q,['question','answer'])||!str(q.question)||!str(q.answer)))
        fail('ORIGINAL_HISTORY_RETAINED_EVENT_INVALID');
    }else if(family==='sender_deliveries'){
      if(!str(e.receiver_turn_id)||!str(e.receiver_message_id)||!str(e.text))fail('ORIGINAL_HISTORY_RETAINED_EVENT_INVALID');
    }else if(!str(e.turn_id)||!opt(e.message_id,str)||!str(e.text)||typeof e.complete!=='boolean'
      ||!opt(e.origin,x=>['user','heartbeat'].includes(x))||!opt(e.phase,x=>['commentary','partial_answer','final_answer'].includes(x)))
      fail('ORIGINAL_HISTORY_RETAINED_EVENT_INVALID');
  }
}
const responseFields:Record<string,string[]>={
  additional_tools:['id','role','tools'],message:['id','role','content','phase'],
  agent_message:['id','author','recipient','content'],reasoning:['id','summary','content','encrypted_content'],
  local_shell_call:['id','call_id','status','action'],function_call:['id','name','namespace','arguments','encrypted_function_args','call_id'],
  tool_search_call:['id','call_id','status','execution','arguments'],function_call_output:['id','call_id','name','namespace','output'],
  custom_tool_call:['id','status','call_id','name','namespace','input'],custom_tool_call_output:['id','call_id','name','output'],
  tool_search_output:['id','call_id','status','execution','tools'],web_search_call:['id','status','action'],
  image_generation_call:['id','status','revised_prompt','result'],compaction:['id','encrypted_content'],
  context_compaction:['id','encrypted_content'],configuration_update:['reasoning'],compaction_trigger:[]};
export const responseKinds=Object.keys(responseFields);
export const turnItemKinds=['UserMessage','FunctionCallOutput','HookPrompt','AgentMessage','Plan','Reasoning',
  'CommandExecution','DynamicToolCall','CollabAgentToolCall','SubAgentActivity','WebSearch','ImageView','Extension',
  'ImageGeneration','EnteredReviewMode','ExitedReviewMode','FileChange','McpToolCall','ContextCompaction'];
export function decodeResponse(p:any){
  const kind=p?.type==='compaction_summary'?'compaction':p?.type;
  if(!Object.hasOwn(responseFields,kind))fail('ORIGINAL_HISTORY_UNKNOWN_RESPONSE_ITEM');
  if(kind==='compaction_trigger')fail('ORIGINAL_HISTORY_REQUEST_ONLY_RESPONSE_RECORD');
  if(!fields(p,['type',...responseFields[kind]!,'internal_chat_message_metadata_passthrough']))
    fail('ORIGINAL_HISTORY_RESPONSE_FIELD_UNKNOWN');
  if(!opt(p.id,str))fail('ORIGINAL_HISTORY_RESPONSE_ITEM_INVALID');
  const m=p.internal_chat_message_metadata_passthrough;
  if(m!=null&&(!fields(m,passthrough)||!opt(m.turn_id,str)||!opt(m.create_time,x=>typeof x==='number'&&Number.isFinite(x))
    ||!opt(m.content_item_kinds,x=>Array.isArray(x)&&x.every(str))||!opt(m.cell_id,str)
    ||!opt(m.executed_tool_calls,Array.isArray)||!opt(m.tool_calls_complete,x=>typeof x==='boolean')))
    fail('ORIGINAL_HISTORY_RESPONSE_PASSTHROUGH_UNSUPPORTED');
  if(kind==='message'||kind==='agent_message'){
    if(!Array.isArray(p.content)||kind==='message'&&!['user','assistant','system','developer'].includes(p.role)
      ||kind==='agent_message'&&(!str(p.author)||!str(p.recipient)))fail('ORIGINAL_HISTORY_RESPONSE_ITEM_INVALID');
    for(const c of p.content){
      const keys:Record<string,string[]>={input_text:['text'],output_text:['text'],input_image:['image_url','file_id','detail'],
        input_audio:['audio_url'],encrypted_content:['encrypted_content']};
      if(!obj(c)||!Object.hasOwn(keys,c.type)||!fields(c,['type',...keys[c.type]!])
        ||kind==='agent_message'&&!['input_text','encrypted_content'].includes(c.type))fail('ORIGINAL_HISTORY_CONTENT_KIND_UNSUPPORTED');
      if(c.type==='input_image'?!((str(c.image_url)&&c.file_id==null)||(str(c.file_id)&&c.image_url==null))
        :!str(c[c.type==='input_audio'?'audio_url':c.type==='encrypted_content'?'encrypted_content':'text']))
        fail('ORIGINAL_HISTORY_RESPONSE_ITEM_INVALID');
    }
    if(!opt(p.phase,x=>['commentary','partial_answer','final_answer'].includes(x)))fail('ORIGINAL_HISTORY_RESPONSE_ITEM_INVALID');
  }
  const required:Record<string,string[]>={function_call:['name','call_id','arguments'],custom_tool_call:['name','call_id','input'],
    custom_tool_call_output:['call_id'],tool_search_call:['execution'],tool_search_output:['status','execution'],
    image_generation_call:['status','result'],compaction:['encrypted_content']};
  if((required[kind]??[]).some(k=>!str(p[k])))fail('ORIGINAL_HISTORY_RESPONSE_ITEM_INVALID');
  if(kind==='tool_search_call'&&!Object.hasOwn(p,'arguments')||kind==='additional_tools'&&!str(p.role))
    fail('ORIGINAL_HISTORY_RESPONSE_ITEM_INVALID');
  if(['function_call_output','custom_tool_call_output'].includes(kind)&&typeof p.output!=='string'&&!Array.isArray(p.output))
    fail('ORIGINAL_HISTORY_RESPONSE_ITEM_INVALID');
  if(['additional_tools','tool_search_output'].includes(kind)&&!Array.isArray(p.tools)
    ||kind==='reasoning'&&!Array.isArray(p.summary)||kind==='local_shell_call'&&(!str(p.status)||!obj(p.action))
    ||kind==='configuration_update'&&!obj(p.reasoning))fail('ORIGINAL_HISTORY_RESPONSE_ITEM_INVALID');
  if(kind==='configuration_update'&&(!fields(p.reasoning,['effort'])
    ||!['none','minimal','low','medium','high','xhigh'].includes(p.reasoning.effort)))
    fail('ORIGINAL_HISTORY_CONFIGURATION_SHAPE_UNSUPPORTED');
  if(kind==='reasoning'){
    const textPart=(v:any,kinds:string[])=>fields(v,['type','text'])&&kinds.includes(v.type)&&str(v.text);
    if(p.summary.some((v:any)=>!textPart(v,['summary_text']))
      ||!opt(p.content,v=>Array.isArray(v)&&v.every(x=>textPart(x,['reasoning_text','text'])))
      ||!opt(p.encrypted_content,str))fail('ORIGINAL_HISTORY_REASONING_SHAPE_UNSUPPORTED');
  }
  if(!matchesPinnedNativeResponse(p,kind))fail('ORIGINAL_HISTORY_RESPONSE_NATIVE_SHAPE_INVALID');
  return kind as string;
}
export type NativeDecodedRecord={kind:string;subtype:string|null;knownUnsupported:boolean};
export function nativeHistoryInventoryKey(row:any):string{
  if(!(rolloutKinds as readonly unknown[]).includes(row?.type))return 'unknown_record';
  const type=row.type,p=row.payload;
  if(type==='response_item')return `${type}:${Object.hasOwn(responseFields,p?.type)?p.type:p?.type==='compaction_summary'?'compaction_summary':'unknown'}`;
  if(type==='event_msg')return `${type}:${Object.hasOwn(catalogue.events,p?.type)?p.type:'unknown'}`;
  return type;
}
export function decodeNativeHistoryRecord(row:any):NativeDecodedRecord{
  if(!obj(row)||typeof row.type!=='string'||!obj(row.payload)||typeof row.timestamp!=='string'
    ||!Number.isFinite(Date.parse(row.timestamp)))fail('ORIGINAL_HISTORY_RECORD_SHAPE_INVALID');
  if(!(rolloutKinds as readonly string[]).includes(row.type))fail('ORIGINAL_HISTORY_UNKNOWN_OR_UNCLASSIFIED_RECORD');
  if(!fields(row,['timestamp','type','payload','ordinal',...(row.type==='response_item'?['metadata']:[])]))
    fail('ORIGINAL_HISTORY_RECORD_ENVELOPE_UNKNOWN');
  const p=row.payload;let subtype:string|null=null,knownUnsupported=false;
  if(row.type==='response_item'){subtype=decodeResponse(p);decodeHarnessMetadata(row.metadata);}
  if(row.type==='event_msg'){
    subtype=p.type;
    const spec=Object.hasOwn(catalogue.events,p.type)?
      (catalogue.events as Record<string,{fields:string[];required:string[];unsupportedShape?:boolean}>)[p.type]:null;
    if(!spec)fail('ORIGINAL_HISTORY_UNKNOWN_OR_UNCLASSIFIED_EVENT');
    knownUnsupported=spec.unsupportedShape===true;
    if(knownUnsupported&&['context_compacted','shutdown_complete'].includes(p.type)){
      if(!fields(p,['type']))fail('ORIGINAL_HISTORY_EVENT_FIELD_UNKNOWN');knownUnsupported=false;
    }
    if(knownUnsupported)fail('ORIGINAL_HISTORY_KNOWN_EVENT_SHAPE_UNSUPPORTED');
    // Detailed policies below validate the neutral records. Other known events
    // are effects, never an empty allow; their opaque body stays private.
    if(!knownUnsupported&&!fields(p,['type',...spec.fields]))fail('ORIGINAL_HISTORY_EVENT_FIELD_UNKNOWN');
    if(!knownUnsupported&&spec.required.some(k=>!Object.hasOwn(p,k)))fail('ORIGINAL_HISTORY_EVENT_SHAPE_INVALID');
    if(p.type==='item_completed'||p.type==='item_started'){
      if(!obj(p.item)||!turnItemKinds.includes(p.item.type))fail('ORIGINAL_HISTORY_COMPLETED_ITEM_KIND_UNSUPPORTED');
      if(p.item.type==='ContextCompaction'&&(!fields(p.item,['type','id'])||!str(p.item.id)))
        fail('ORIGINAL_HISTORY_COMPACTION_ITEM_IDENTITY_UNPROVEN');
    }
  }
  if(row.type==='session_meta'&&!fields(p,['creator_user_id','creator_account_id','session_id','id','forked_from_id',
    'forked_from_ordinal_exclusive','parent_thread_id','timestamp','cwd','runtime_workspace_roots','originator','cli_version',
    'source','thread_source','agent_nickname','agent_role','agent_type','agent_path','model_provider','base_instructions',
    'dynamic_tools','selected_capability_roots','memory_mode','history_mode','history_base','subagent_history_start_ordinal',
    'multi_agent_version','context_window','git']))fail('ORIGINAL_HISTORY_SESSION_FIELD_UNKNOWN');
  if(row.type==='turn_context'&&(!fields(p,['turn_id','root_turn_id','disabled_plugin_ids','cwd','approval_policy',
    'approvals_reviewer','sandbox_policy','permission_profile','active_permission_profile','file_system_sandbox_policy',
    'model','comp_hash','collaboration_mode','multi_agent_version','realtime_active','cyber_access_program','effort','summary'])))
    fail('ORIGINAL_HISTORY_CONTEXT_FIELD_UNKNOWN');
  if(row.type==='turn_context'&&(!str(p.model)||!str(p.cwd)||!obj(p.sandbox_policy)||p.approval_policy==null))
    fail('ORIGINAL_HISTORY_CONTEXT_SHAPE_INVALID');
  if(row.type==='turn_context'&&(!opt(p.multi_agent_version,v=>['disabled','v1','v2'].includes(v))
    ||!opt(p.effort,v=>['none','minimal','low','medium','high','xhigh'].includes(v))
    ||!opt(p.realtime_active,v=>typeof v==='boolean')||!opt(p.comp_hash,str)
    ||!opt(p.disabled_plugin_ids,v=>Array.isArray(v)&&v.every(str))
    ||!opt(p.summary,v=>['auto','concise','detailed','none'].includes(v))))fail('ORIGINAL_HISTORY_CONTEXT_SHAPE_INVALID');
  if(row.type==='world_state'&&(!fields(p,['full','state'])||typeof p.full!=='boolean'||!obj(p.state)))
    fail('ORIGINAL_HISTORY_WORLD_STATE_SHAPE_INVALID');
  if(row.type==='token_usage_record'&&(!fields(p,['thread_id','turn_id','session_id','root_turn_id','response_id',
    'usage','turn_token_usage','thread_token_usage'])
    ||['thread_id','turn_id','session_id','root_turn_id','response_id'].some(k=>!str(p[k]))))
    fail('ORIGINAL_HISTORY_TOKEN_USAGE_SHAPE_INVALID');
  if(row.type==='compacted'){
    if(!fields(p,['message','replacement_history','replacement_history_metadata','guardian_history','retained_context',
      'mcp_resource_origins','window_number','first_window_id','previous_window_id','window_id','compaction_response_id',
      'latest_token_usage_record','resume_metadata']))fail('ORIGINAL_HISTORY_COMPACTION_SIDECAR_UNCLASSIFIED');
    if(!str(p.message)||!opt(p.replacement_history,Array.isArray)||!opt(p.replacement_history_metadata,Array.isArray)
      ||p.replacement_history_metadata!=null&&(p.replacement_history==null
        ||p.replacement_history_metadata.length!==p.replacement_history.length))fail('ORIGINAL_HISTORY_COMPACTION_SHAPE_INVALID');
    for(const [i,entry] of (p.replacement_history??[]).entries()){
      decodeResponse(entry);decodeHarnessMetadata(p.replacement_history_metadata?.[i]);
    }
    for(const k of ['window_number'])if(!opt(p[k],uint))fail('ORIGINAL_HISTORY_COMPACTION_SHAPE_INVALID');
    for(const k of ['first_window_id','previous_window_id','compaction_response_id'])
      if(!opt(p[k],str))fail('ORIGINAL_HISTORY_COMPACTION_SHAPE_INVALID');
    if(!opt(p.window_id,x=>str(x)||uint(x)))fail('ORIGINAL_HISTORY_COMPACTION_SHAPE_INVALID');
    if(!opt(p.guardian_history,Array.isArray))fail('ORIGINAL_HISTORY_COMPACTION_SHAPE_INVALID');
    for(const entry of p.guardian_history??[]){const {guardian_metadata,...item}=entry;
      decodeResponse(item);decodeHarnessMetadata(guardian_metadata);}
    for(const k of ['retained_context','mcp_resource_origins','latest_token_usage_record','resume_metadata'])
      if(!opt(p[k],obj))fail('ORIGINAL_HISTORY_COMPACTION_SHAPE_INVALID');
    if(p.retained_context!=null)decodeRetainedCheckpoint(p.retained_context);
  }
  if(row.type==='inter_agent_communication_metadata'&&(!fields(p,['trigger_turn'])||typeof p.trigger_turn!=='boolean'))
    fail('ORIGINAL_HISTORY_COMMUNICATION_METADATA_INVALID');
  if(row.type==='inter_agent_communication'&&(!fields(p,['id','author','recipient','other_recipients','content','encrypted_content',
    'internal_chat_message_metadata_passthrough','trigger_turn'])||!str(p.author)||!str(p.recipient)||!str(p.content)
    ||typeof p.trigger_turn!=='boolean'||!opt(p.other_recipients,x=>Array.isArray(x)&&x.every(str))))
    fail('ORIGINAL_HISTORY_COMMUNICATION_SHAPE_INVALID');
  if(row.type==='retained_context'){
    subtype=p.type;
    if(!['verified_answer','delivered_assistant_message'].includes(p.type))fail('ORIGINAL_HISTORY_RETAINED_EVENT_UNKNOWN');
    const keys=p.type==='verified_answer'?['turn_id','call_id','questions','acceptance_order']:
      ['turn_id','message_id','text','complete','origin','phase','acceptance_order'];
    if(!fields(p,['type',...keys])||!str(p.turn_id)||!opt(p.acceptance_order,uint)
      ||p.type==='verified_answer'&&(!str(p.call_id)||!Array.isArray(p.questions))
      ||p.type==='delivered_assistant_message'&&(!str(p.text)||typeof p.complete!=='boolean'||!uint(p.acceptance_order)))
      fail('ORIGINAL_HISTORY_RETAINED_EVENT_INVALID');
    if(p.type==='verified_answer'&&p.questions.some((q:any)=>!fields(q,['question','answer'])||!str(q.question)||!str(q.answer)))
      fail('ORIGINAL_HISTORY_RETAINED_EVENT_INVALID');
  }
  if(row.type==='security_risk_score'&&(!fields(p,['scores','call_id','action','sampled_at'])||!obj(p.scores)
    ||Object.values(p.scores).some(x=>typeof x!=='number'||!Number.isFinite(x))))fail('ORIGINAL_HISTORY_RISK_SHAPE_INVALID');
  if(row.type==='realtime_item'){
    subtype=p.type;
    const keys:Record<string,string[]>={realtime_session_started:[],transcript_segment:['role','text'],
      bem_item_promoted:['turn_id','item_id','presentation'],realtime_session_closed:['outcome']};
    if(!Object.hasOwn(keys,p.type))fail('ORIGINAL_HISTORY_REALTIME_KIND_UNKNOWN');
    if(!fields(p,['id','realtime_session_id','type',...keys[p.type]!])||!str(p.id)||!str(p.realtime_session_id))
      fail('ORIGINAL_HISTORY_REALTIME_SHAPE_INVALID');
    if(p.type==='transcript_segment'&&(!['user','assistant'].includes(p.role)||!str(p.text))
      ||p.type==='realtime_session_closed'&&!['ended','failed'].includes(p.outcome)
      ||p.type==='bem_item_promoted'&&(!str(p.turn_id)||!str(p.item_id)||!obj(p.presentation)
        ||!['whole_item','inline_markdown','inline_visualization'].includes(p.presentation.type)
        ||!fields(p.presentation,['type',...(p.presentation.type==='inline_visualization'?['index']:[])])
        ||p.presentation.type==='inline_visualization'&&!uint(p.presentation.index)))fail('ORIGINAL_HISTORY_REALTIME_SHAPE_INVALID');
  }
  return {kind:row.type,subtype,knownUnsupported};
}
