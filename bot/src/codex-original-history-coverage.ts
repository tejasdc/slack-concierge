import {createHash} from 'node:crypto';
import {open,realpath,stat} from 'node:fs/promises';
import {openSync,closeSync,fstatSync,statSync,realpathSync} from 'node:fs';
import {isAbsolute,relative,sep} from 'node:path';
import type {Database} from 'bun:sqlite';
import {acceptedBindingSnapshotDigest,type ContinuationBinding} from './codex-accepted-binding-continuation';

const digest=acceptedBindingSnapshotDigest;
const object=(v:any)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const nonempty=(v:any):v is string=>typeof v==='string'&&v.length>0;
class CoverageRefusal extends Error {constructor(readonly code:string,readonly evidence:string[]=[]){super(code);}}
const refuse=(code:string,...evidence:string[]):never=>{throw new CoverageRefusal(code,evidence);};
export type CodexOriginalHistoryAttempt={inputId:string;turnId:number;runId:string;dispatchAttempt:number;
  providerTurnId:string;evidenceRefs:readonly string[]};
type PhysicalRevision={dev:string;ino:string;size:string;mtimeNs:string;ctimeNs:string};
const revision=(s:any):PhysicalRevision=>({dev:String(s.dev),ino:String(s.ino),size:String(s.size),
  mtimeNs:String(s.mtimeNs),ctimeNs:String(s.ctimeNs)});
type Span={providerTurnId:string;inputId:string;dispatchAttempt:number;startByte:number;endByte:number;
  records:number;contextRecords:number;generatedContextRecords:number;compactions:number;
  compactionCompletionRecords:number;responseUsageRecords:number;recordsDigest:string;classification:'empty'|'independent_compaction'};
export type CodexOriginalHistoryWitness={policy:'codex_original_history_v1';threadId:string;bindingDigest:string;
  sourceSessionId:string|null;
  selectedInputId:string;attemptsDigest:string;sourceIdentity:string;pathDigest:string;sourceRevisionDigest:string;
  prefixDigest:string;prefixBytes:number;recordCount:number;historyMode:'legacy'|'paginated';lastOrdinal:number|null;
  nativeTurnOrder:string[];nativeWatermark:string;spans:Span[];
  compactionRecords:{providerTurnId:string;record:number;replacementCount:number;replacementDigest:string;
    replacementClassifications:Record<string,number>;recordDigest:string;
    retainedSourceRefs:{record:number;sourceDigest:string;payloadDigest:string}[];
    resumeSourceRefs:{startedRecord:number;contextRecord:number;attributionRecord:number|null}|null}[];
  priorRecordCount:number;neutralOutsideTurnRecords:{record:number;kind:string;recordDigest:string}[];
  settingsBaseline:{record:number;startByte:number;endByte:number;snapshotDigest:string;recordDigest:string}|null;
  turnContextBaseline:{record:number;settingsDigest:string}|null;worldStateBaseline:{record:number;stateDigest:string}|null;
  ownedResumeCheckpoint?:{intentId:string;permitId:string;responseDigest:string;
    previousWitnessDigest:string;previousPrefixDigest:string;appendDigest:string;appendBytes:number;recordCount:1};witnessDigest:string};
/** Private host/worker custody only. Never put this value in an inspector, audit,
 * exception, log or public reply. It carries no record bodies or provider tokens. */
export type CodexOriginalHistoryCustody={path:string;home:string;authoritativePath:string;configuredHome:string;revision:PhysicalRevision;
  threadId:string;prefixDigest:string;witnessDigest:string};
export type CodexOriginalHistoryCoverageInput={binding:ContinuationBinding;selectedInputId:string;
  attempts:readonly CodexOriginalHistoryAttempt[];nativeTurnOrder:readonly string[];codexHome:string;
  client:{request(method:'thread/read',params:Record<string,unknown>):Promise<any>}};

function within(home:string,path:string){const rel=relative(home,path);return rel!==''&&!rel.startsWith(`..${sep}`)&&rel!=='..'&&!isAbsolute(rel);}
function validateInput(i:CodexOriginalHistoryCoverageInput){
  if(i.binding.provider!=='codex'||!nonempty(i.binding.threadId)||!nonempty(i.selectedInputId)
    ||!isAbsolute(i.codexHome)||i.attempts.length===0||i.nativeTurnOrder.length===0
    ||new Set(i.nativeTurnOrder).size!==i.nativeTurnOrder.length)refuse('ORIGINAL_HISTORY_IDENTITY_INVALID');
  if(i.binding.runner!==null)refuse('ORIGINAL_HISTORY_REMOTE_SOURCE_UNSUPPORTED');
  if(i.attempts.some(a=>!nonempty(a.providerTurnId)||!nonempty(a.inputId)||!nonempty(a.runId)
    ||!Number.isSafeInteger(a.turnId)||a.turnId<1||!Number.isSafeInteger(a.dispatchAttempt)||a.dispatchAttempt<1
    ||!Array.isArray(a.evidenceRefs)||a.evidenceRefs.length===0)
    ||new Set(i.attempts.map(a=>a.providerTurnId)).size!==i.attempts.length
    ||!i.attempts.some(a=>a.inputId===i.selectedInputId))refuse('ORIGINAL_HISTORY_ATTEMPT_IDENTITY_INVALID');
}

class RecordCoverage {
  count=0;prior=0;mode:'legacy'|'paginated'='legacy';lastOrdinal:number|null=null;
  sourceSessionId:string|null=null;neutralOutsideTurnRecords:CodexOriginalHistoryWitness['neutralOutsideTurnRecords']=[];
  relevant=false;active:string|null=null;seen=new Set<string>();order:string[]=[];
  spans:Span[]=[];compactions:CodexOriginalHistoryWitness['compactionRecords']=[];
  current:{id:string;start:number;records:number;contexts:number;generated:number;compactions:number;typedCompactions:number;
    compactedRecords:number;completionIds:Set<string>;responseIds:Set<string>;usageRecords:any[];tokenCounts:any[];hash:ReturnType<typeof createHash>}|null=null;
  priorAcceptedUsers=new Map<number,string>();
  priorResponseItems=new Set<string>();
  priorEnvelopes=new Map<string,{metadataDigest:string;supported:boolean}>();
  priorRetainedSources=new Map<string,{payloadDigest:string;textDigest:string|null;phase:any;origin:string;order:number;record:number}>();
  priorMcpAttributions=new Set<string>();
  lastContext:any=null;lastStartedTurnId:string|null=null;lastAttribution:any=null;
  lastContextRecord=0;lastStartedRecord=0;lastAttributionRecord:number|null=null;
  settingsBaseline:CodexOriginalHistoryWitness['settingsBaseline']=null;
  turnContextBaseline:CodexOriginalHistoryWitness['turnContextBaseline']=null;
  worldStateBaseline:CodexOriginalHistoryWitness['worldStateBaseline']=null;
  worldState:any=null;settingsSnapshot:any=null;recordStart=0;recordEnd=0;
  expected:string[];
  constructor(readonly input:CodexOriginalHistoryCoverageInput){
    const positions=input.attempts.filter(a=>a.inputId===input.selectedInputId).map(a=>input.nativeTurnOrder.indexOf(a.providerTurnId));
    if(positions.some(p=>p<0))refuse('ORIGINAL_HISTORY_SELECTED_TURN_ABSENT');
    this.expected=input.nativeTurnOrder.slice(Math.min(...positions));
    if(this.expected.some(id=>!input.attempts.some(a=>a.providerTurnId===id))
      ||input.attempts.some(a=>!this.expected.includes(a.providerTurnId)))refuse('ORIGINAL_HISTORY_NATIVE_SUFFIX_MAPPING_INCOMPLETE');
  }
  line(bytes:Buffer,start:number,end:number){
    let row:any;
    try{row=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
    catch{refuse('ORIGINAL_HISTORY_RECORD_DECODE_FAILED',`record:${this.count+1}`);}
    this.count++;
    this.recordStart=start;this.recordEnd=end;
    const ref=`record:${this.count}`;
    if(!object(row)||!nonempty(row.type)||!object(row.payload)||!nonempty(row.timestamp)
      ||!Number.isFinite(Date.parse(row.timestamp)))refuse('ORIGINAL_HISTORY_RECORD_SHAPE_INVALID',ref);
    if(this.count===1){
      if(row.type!=='session_meta'||row.payload.id!==this.input.binding.threadId
        ||Object.hasOwn(row.payload,'session_id')&&!nonempty(row.payload.session_id))
        refuse('ORIGINAL_HISTORY_SESSION_IDENTITY_UNPROVEN',ref);
      // Pinned SessionMetaLine deserialization fills an omitted legacy session_id
      // from id. An explicitly distinct session_id remains a distinct identity.
      this.sourceSessionId=row.payload.session_id??row.payload.id;
      const p=row.payload;
      if(p.history_base!=null||p.subagent_history_start_ordinal!=null||p.forked_from_id!=null
        ||p.forked_from_ordinal_exclusive!=null||p.parent_thread_id!=null)
        refuse('ORIGINAL_HISTORY_INHERITED_LINEAGE_UNSUPPORTED',ref);
      if(p.history_mode!=null&&!['legacy','paginated'].includes(p.history_mode))refuse('ORIGINAL_HISTORY_MODE_UNSUPPORTED',ref);
      this.mode=p.history_mode??'legacy';
    }else if(row.type==='session_meta')refuse('ORIGINAL_HISTORY_SESSION_METADATA_REPLACED',ref);
    if(this.mode==='paginated'){
      if(!Number.isSafeInteger(row.ordinal)||row.ordinal!==(this.lastOrdinal===null?0:this.lastOrdinal+1))
        refuse('ORIGINAL_HISTORY_ORDINAL_COVERAGE_INVALID',ref);
      this.lastOrdinal=row.ordinal;
    }else if(row.ordinal!=null)refuse('ORIGINAL_HISTORY_UNEXPECTED_ORDINAL',ref);
    if(row.payload.thread_id!=null&&row.payload.thread_id!==this.input.binding.threadId)
      refuse('ORIGINAL_HISTORY_RECORD_THREAD_CONFLICT',ref);
    const p=row.payload;
    if(row.type==='event_msg'&&['thread_rolled_back','thread_rollback'].includes(p.type))refuse('ORIGINAL_HISTORY_ROLLBACK_UNSUPPORTED',ref);
    const begins=row.type==='event_msg'&&['task_started','turn_started'].includes(p.type);
    const ends=row.type==='event_msg'&&['task_complete','turn_complete','turn_aborted'].includes(p.type);
    if(begins){
      if(!nonempty(p.turn_id)||this.active!==null||this.seen.has(p.turn_id))refuse('ORIGINAL_HISTORY_TURN_BOUNDARY_INVALID',ref);
      this.active=p.turn_id;this.seen.add(p.turn_id);
      this.lastStartedTurnId=p.turn_id;
      this.lastStartedRecord=this.count;
      if(p.turn_attribution!=null){this.lastAttribution=p.turn_attribution;this.lastAttributionRecord=this.count;}
      if(this.expected.includes(p.turn_id)||this.relevant){
        if(!this.relevant&&!this.settingsBaseline)refuse('ORIGINAL_HISTORY_SETTINGS_BASELINE_MISSING',ref);
        if(!this.relevant&&!this.turnContextBaseline)refuse('ORIGINAL_HISTORY_TURN_SETTINGS_BASELINE_MISSING',ref);
        this.relevant=true;
        if(p.turn_id!==this.expected[this.order.length])refuse('ORIGINAL_HISTORY_NATIVE_ORDER_OR_SUFFIX_CONFLICT',ref);
        this.order.push(p.turn_id);
        this.current={id:p.turn_id,start,records:0,contexts:0,generated:0,compactions:0,typedCompactions:0,
          compactedRecords:0,completionIds:new Set(),responseIds:new Set(),usageRecords:[],tokenCounts:[],hash:createHash('sha256')};
      }
    }
    if(!this.relevant)this.prior++;
    if(this.relevant&&row.type!=='session_meta'&&!this.active){
      if(['token_usage_record','world_state'].includes(row.type)||row.type==='event_msg'&&['token_count','thread_settings_applied'].includes(p.type))
        this.neutralOutsideTurnRecords.push({record:this.count,kind:row.type==='event_msg'?p.type:row.type,recordDigest:digest(row)});
      else refuse('ORIGINAL_HISTORY_UNOWNED_SUFFIX_RECORD',ref);
    }
    if(this.current){this.current.records++;this.current.hash.update(bytes);this.current.hash.update('\n');}
    if((row.type==='turn_context'&&this.relevant||ends)&&p.turn_id!==this.active)refuse('ORIGINAL_HISTORY_EXACT_TURN_CONTEXT_MISSING',ref);
    this.classify(row,ref);
    if(ends){
      if(!nonempty(p.turn_id)||p.turn_id!==this.active)refuse('ORIGINAL_HISTORY_TURN_BOUNDARY_INVALID',ref);
      if(this.current){
        if(!['task_complete','turn_complete'].includes(p.type)||p.error!=null||p.last_agent_message!=null&&p.last_agent_message!=='')
          refuse('ORIGINAL_HISTORY_TERMINAL_EFFECT_OR_FAILURE',ref);
        if(this.current.contexts!==1)refuse('ORIGINAL_HISTORY_EXACT_TURN_CONTEXT_MISSING',ref);
        const owner=this.input.attempts.find(a=>a.providerTurnId===this.current!.id)!;
        if(owner.inputId===this.input.selectedInputId&&this.current.compactions>0)refuse('ORIGINAL_HISTORY_SELECTED_COMPACTION_PRESENT',ref);
        if(this.current.typedCompactions>0&&this.current.compactedRecords===0)
          refuse('ORIGINAL_HISTORY_COMPACTION_RECORD_COVERAGE_UNPROVEN',ref);
        const usage=this.current.usageRecords,counts=this.current.tokenCounts;
        if(usage.length){
          const last=usage.at(-1),output=usage.reduce((sum,item)=>sum+item.usage.output_tokens,0),
            reasoning=usage.reduce((sum,item)=>sum+item.usage.reasoning_output_tokens,0);
          if(last.turn_token_usage.output_tokens!==output||last.turn_token_usage.reasoning_output_tokens!==reasoning)
            refuse('ORIGINAL_HISTORY_TOKEN_USAGE_RESPONSE_COVERAGE_UNPROVEN',ref);
        }
        const positive=usage.some(item=>item.usage.output_tokens>0||item.usage.reasoning_output_tokens>0)
          ||counts.length>0;
        if(positive&&(owner.inputId===this.input.selectedInputId||this.current.compactions===0||this.current.typedCompactions===0
          ||usage.length===0||usage.some(item=>!this.current!.responseIds.has(item.response_id))
          ||counts.some(count=>digest(count)!==digest(usage.at(-1).usage))))
          refuse('ORIGINAL_HISTORY_TOKEN_USAGE_EFFECT_UNASSESSED',ref);
        this.spans.push({providerTurnId:owner.providerTurnId,inputId:owner.inputId,dispatchAttempt:owner.dispatchAttempt,
          startByte:this.current.start,endByte:end,records:this.current.records,contextRecords:this.current.contexts,
          generatedContextRecords:this.current.generated,compactions:this.current.compactions,recordsDigest:this.current.hash.digest('hex'),
          compactionCompletionRecords:this.current.typedCompactions,responseUsageRecords:usage.length,
          classification:this.current.compactions?'independent_compaction':'empty'});
        this.current=null;
      }
      this.active=null;
    }
  }
  neutralMetadata(metadata:any,allowed:readonly string[]=[]):boolean{
    if(metadata==null)return true;
    if(!object(metadata))return false;
    const {mcp_attribution,...rest}=metadata;
    return neutralHarnessMetadata(rest,allowed)&&(mcp_attribution==null
      ||validMcpAttribution(mcp_attribution)&&(mcp_attribution.status==='none'
        ||this.priorMcpAttributions.has(digest(mcp_attribution))));
  }
  retainedCheckpoint(value:any,ref:string,classes:Record<string,number>){
    if(!closed(value,['verified_answers','incomplete','user_messages','user_messages_incomplete',
      'assistant_messages','assistant_messages_incomplete','next_order','sender_deliveries'])
      ||!Array.isArray(value.verified_answers)||!Array.isArray(value.user_messages)||!Array.isArray(value.assistant_messages)
      ||typeof value.incomplete!=='boolean'||typeof value.user_messages_incomplete!=='boolean'
      ||typeof value.assistant_messages_incomplete!=='boolean'||!uint(value.next_order))
      refuse('ORIGINAL_HISTORY_COMPACTION_SIDECAR_UNCLASSIFIED',ref);
    if(value.verified_answers.length||value.sender_deliveries!=null&&(!Array.isArray(value.sender_deliveries)||value.sender_deliveries.length))
      refuse('ORIGINAL_HISTORY_RETAINED_CONTEXT_EVENT_PROVENANCE_UNSUPPORTED',ref);
    const identities=new Set<string>(),orders=new Set<number>(),refs:{record:number;sourceDigest:string;payloadDigest:string}[]=[];
    for(const role of ['user','assistant'])for(const entry of value[`${role}_messages`]){
      if(!closed(entry,['revision','inherited','order','turn_id','message_id','text','complete','origin','phase'])
        ||!nonempty(entry.revision)||!nonempty(entry.turn_id)||!nonempty(entry.message_id)||!uint(entry.order)
        ||typeof entry.text!=='string'||typeof entry.complete!=='boolean'||entry.inherited!=null&&entry.inherited!==false)
        refuse('ORIGINAL_HISTORY_RETAINED_CONTEXT_SOURCE_UNPROVEN',ref);
      const source={id:{message_id:entry.message_id,turn_id:entry.turn_id,role},revision:entry.revision,complete:entry.complete};
      const key=digest(source),original=this.priorRetainedSources.get(key);
      if(!original||original.order!==entry.order||entry.order>=value.next_order||identities.has(key)||orders.has(entry.order))
        refuse('ORIGINAL_HISTORY_RETAINED_CONTEXT_SOURCE_UNPROVEN',ref);
      if(original.textDigest===null||original.textDigest!==digest(entry.text)||original.phase!==(entry.phase??null))
        refuse('ORIGINAL_HISTORY_RETAINED_CONTEXT_PAYLOAD_UNPROVEN',ref);
      if((entry.origin??'user')!==original.origin)refuse('ORIGINAL_HISTORY_RETAINED_CONTEXT_SOURCE_UNPROVEN',ref);
      identities.add(key);orders.add(entry.order);
      refs.push({record:original.record,sourceDigest:key,payloadDigest:original.payloadDigest});
      classes.historicalRetainedSource=(classes.historicalRetainedSource??0)+1;
    }
    return refs;
  }
  resumeCheckpoint(value:any,ref:string){
    const context=this.lastContext,settings=value?.previous_turn_settings;
    if(!closed(value,['multi_agent_version','last_started_turn_id','turn_attribution','previous_turn_settings'])
      ||!Object.hasOwn(value,'multi_agent_version')||!Object.hasOwn(value,'last_started_turn_id')
      ||!Object.hasOwn(value,'previous_turn_settings')||!context
      ||!optional(value.multi_agent_version,v=>['disabled','v1','v2'].includes(v))
      ||value.last_started_turn_id!==this.lastStartedTurnId
      ||!optional(value.turn_attribution,v=>closed(v,['turn_id','turn_trigger','parent_turn_id','initiating_agent_path','root_turn_id'])
        &&nonempty(v.turn_id)&&this.seen.has(v.turn_id)
        &&['turn_trigger','parent_turn_id','initiating_agent_path','root_turn_id'].every(key=>optional(v[key],t=>typeof t==='string')))
      ||digest(value.turn_attribution??null)!==digest(this.lastAttribution)
      ||(value.multi_agent_version??null)!==(context.multi_agent_version??null)
      ||!closed(settings,['model','cyber_access_program','comp_hash','realtime_active'])
      ||!Object.hasOwn(settings,'comp_hash')||!Object.hasOwn(settings,'realtime_active')
      ||!optional(settings.comp_hash,v=>typeof v==='string')||!optional(settings.realtime_active,v=>typeof v==='boolean')
      ||!optional(settings.cyber_access_program,v=>['standard','daybreak_blue','daybreak_red'].includes(v))
      ||settings.model!==context.model||(settings.comp_hash??null)!==(context.comp_hash??null)
      ||(settings.realtime_active??null)!==(context.realtime_active??null)
      ||(settings.cyber_access_program??null)!==(context.cyber_access_program??null))
      refuse('ORIGINAL_HISTORY_COMPACTION_RESUME_STATE_UNPROVEN',ref);
    return {startedRecord:this.lastStartedRecord,contextRecord:this.lastContextRecord,attributionRecord:this.lastAttributionRecord};
  }
  opaqueCompaction(entry:any,metadata:any,checkpoint:any):boolean{
    return closed(entry,['type','id','encrypted_content','internal_chat_message_metadata_passthrough'])
      &&nonempty(entry.id)&&nonempty(entry.encrypted_content)
      &&optional(entry.internal_chat_message_metadata_passthrough,v=>closed(v,['turn_id','create_time','content_item_kinds'])
        &&optional(v.turn_id,id=>id===this.active)&&optional(v.create_time,t=>typeof t==='number'&&Number.isFinite(t))
        &&optional(v.content_item_kinds,k=>Array.isArray(k)&&k.every((kind:any)=>typeof kind==='string')))
      &&closed(metadata,['client_authored','mcp_attribution','compaction_model_hash'])&&metadata.client_authored!==true
      &&Object.hasOwn(metadata,'compaction_model_hash')&&nonempty(metadata.compaction_model_hash)
      &&metadata.compaction_model_hash===this.lastContext?.comp_hash
      &&nonempty(checkpoint.compaction_response_id)&&this.current!==null
      &&this.current.usageRecords.some(usage=>usage.response_id===checkpoint.compaction_response_id)
      &&this.neutralMetadata({client_authored:metadata.client_authored,mcp_attribution:metadata.mcp_attribution});
  }
  classify(row:any,ref:string){
    const p=row.payload;
    if(row.type==='session_meta')return;
    if(row.type==='turn_context'){
      if(this.current){
        if(p.model!==this.input.binding.model||p.effort!==this.input.binding.effort)
          refuse('ORIGINAL_HISTORY_CONTEXT_BINDING_CONFLICT',ref);
        if(!this.turnContextBaseline)refuse('ORIGINAL_HISTORY_TURN_SETTINGS_BASELINE_MISSING',ref);
        if(digest(contextSettings(p))!==this.turnContextBaseline.settingsDigest)
          refuse('ORIGINAL_HISTORY_TURN_SETTINGS_CHANGED',ref);
        if(!contextMatchesSettings(p,this.settingsSnapshot))refuse('ORIGINAL_HISTORY_SETTINGS_BASELINES_CONFLICT',ref);
        this.current.contexts++;
      }else if(!this.relevant){
        if(!object(p)||!nonempty(p.cwd)||!Object.hasOwn(p,'approval_policy')||!object(p.sandbox_policy))
          refuse('ORIGINAL_HISTORY_TURN_SETTINGS_BASELINE_INCOMPLETE',ref);
        this.turnContextBaseline={record:this.count,settingsDigest:digest(contextSettings(p))};
      }
      this.lastContext=p;this.lastContextRecord=this.count;return;
    }
    if(row.type==='world_state'){
      if(typeof p.full!=='boolean'||!object(p.state)||Object.keys(p).some(key=>!['full','state'].includes(key)))
        refuse('ORIGINAL_HISTORY_WORLD_STATE_SHAPE_INVALID',ref);
      if(!p.full&&this.worldState===null)refuse('ORIGINAL_HISTORY_WORLD_STATE_BASELINE_MISSING',ref);
      const next=p.full?p.state:mergeWorldState(this.worldState,p.state);
      if(this.relevant){
        if(!this.worldStateBaseline)refuse('ORIGINAL_HISTORY_WORLD_STATE_BASELINE_MISSING',ref);
        if(digest(next)!==this.worldStateBaseline.stateDigest)refuse('ORIGINAL_HISTORY_WORLD_STATE_CHANGED',ref);
      }else{
        this.worldState=next;this.worldStateBaseline={record:this.count,stateDigest:digest(next)};
      }
      return;
    }
    if(row.type==='compacted'){
      if(typeof p.message!=='string'||p.replacement_history!=null&&!Array.isArray(p.replacement_history))
        refuse('ORIGINAL_HISTORY_COMPACTION_SHAPE_INVALID',ref);
      if(Object.keys(p).some(key=>!['message','replacement_history','replacement_history_metadata','guardian_history',
        'retained_context','mcp_resource_origins','window_number','first_window_id','previous_window_id','window_id',
        'compaction_response_id','latest_token_usage_record','resume_metadata'].includes(key)))
        refuse('ORIGINAL_HISTORY_COMPACTION_SIDECAR_UNCLASSIFIED',ref);
      const history=p.replacement_history??[];
      if(p.replacement_history_metadata!=null&&(!Array.isArray(p.replacement_history_metadata)
        ||p.replacement_history_metadata.length!==history.length))refuse('ORIGINAL_HISTORY_COMPACTION_SHAPE_INVALID',ref);
      const classes:Record<string,number>={};
      let retainedSourceRefs:{record:number;sourceDigest:string;payloadDigest:string}[]=[];
      let resumeSourceRefs:{startedRecord:number;contextRecord:number;attributionRecord:number|null}|null=null;
      if(this.relevant){
        if(p.guardian_history!=null&&(!Array.isArray(p.guardian_history)||p.guardian_history.length!==0)
          ||p.mcp_resource_origins!=null&&(!closed(p.mcp_resource_origins,['origins','turns','current_turn_id'])
            ||!Array.isArray(p.mcp_resource_origins.origins)||p.mcp_resource_origins.origins.length!==0
            ||!Array.isArray(p.mcp_resource_origins.turns)||p.mcp_resource_origins.turns.length!==0
            ||p.mcp_resource_origins.current_turn_id!=null))refuse('ORIGINAL_HISTORY_COMPACTION_SIDECAR_UNCLASSIFIED',ref);
        if(p.retained_context!=null)retainedSourceRefs=this.retainedCheckpoint(p.retained_context,ref,classes);
        if(p.resume_metadata!=null)resumeSourceRefs=this.resumeCheckpoint(p.resume_metadata,ref);
      }
      if(this.relevant&&p.latest_token_usage_record!=null&&(!this.current?.usageRecords.length
        ||digest(p.latest_token_usage_record)!==digest(this.current.usageRecords.at(-1))))
        refuse('ORIGINAL_HISTORY_COMPACTION_USAGE_CHECKPOINT_UNPROVEN',ref);
      for(const [index,entry] of history.entries()){
        if(!object(entry)||!nonempty(entry.type))refuse('ORIGINAL_HISTORY_REPLACEMENT_ITEM_INVALID',ref);
        if(entry.type==='message'&&!['system','developer','user','assistant'].includes(entry.role))
          refuse('ORIGINAL_HISTORY_REPLACEMENT_ITEM_INVALID',ref);
        const c=entry.type==='message'?`message:${entry.role}`:entry.type;
        classes[c]=(classes[c]??0)+1;
        if(this.relevant){
          const metadata=p.replacement_history_metadata?.[index];
          if(metadata!=null&&!object(metadata))refuse('ORIGINAL_HISTORY_COMPACTION_SHAPE_INVALID',ref);
          const original=this.priorEnvelopes.get(digest(entry));
          // Cloned originals preserve all provenance; a shortened or rewritten copy
          // cannot borrow a retained-source identity from another native payload.
          const cloned=original?.supported===true&&knownHarnessMetadata(metadata)&&digest(metadata??null)===original.metadataDigest;
          const opaque=['compaction','context_compaction'].includes(entry.type)&&this.opaqueCompaction(entry,metadata,p);
          if(!cloned&&!opaque&&!this.neutralMetadata(metadata,['user_input_order']))
            refuse('ORIGINAL_HISTORY_REPLACEMENT_METADATA_UNCLASSIFIED',ref);
          if(opaque){classes.opaqueCompactionContext=(classes.opaqueCompactionContext??0)+1;continue;}
          if(entry.type==='message'&&entry.role==='user'){
            const order=metadata?.user_input_order;
            if(Number.isSafeInteger(order)&&order>=0&&this.priorAcceptedUsers.get(order)===digest(entry)){
              classes.historicalAcceptedUser=(classes.historicalAcceptedUser??0)+1;continue;
            }
            if(order==null&&generatedStaticContext(entry)){
              classes.generatedStaticContext=(classes.generatedStaticContext??0)+1;continue;
            }
            refuse('ORIGINAL_HISTORY_REPLACEMENT_USER_PROVENANCE_UNPROVEN',ref);
          }
          if(this.priorResponseItems.has(digest(entry))){
            classes.historicalRetainedEffect=(classes.historicalRetainedEffect??0)+1;continue;
          }
          if(entry.type!=='message'||!['system','developer'].includes(entry.role))
            refuse('ORIGINAL_HISTORY_REPLACEMENT_EFFECT_PROVENANCE_UNPROVEN',ref);
        }
      }
      if(this.current){this.current.compactions++;this.current.compactedRecords++;}
      if(this.current&&p.compaction_response_id!=null){
        if(!nonempty(p.compaction_response_id)||this.current.responseIds.has(p.compaction_response_id))refuse('ORIGINAL_HISTORY_COMPACTION_RESPONSE_IDENTITY_INVALID',ref);
        this.current.responseIds.add(p.compaction_response_id);
      }
      this.compactions.push({providerTurnId:this.active??'',record:this.count,replacementCount:history.length,
        replacementDigest:digest({history,metadata:p.replacement_history_metadata??null}),replacementClassifications:classes,recordDigest:digest(row),retainedSourceRefs,resumeSourceRefs});
      return;
    }
    if(row.type==='response_item'){
      if(!nonempty(p.type))refuse('ORIGINAL_HISTORY_RESPONSE_ITEM_INVALID',ref);
      const known=['message','reasoning','function_call','function_call_output','custom_tool_call','custom_tool_call_output',
        'local_shell_call','web_search_call','image_generation_call','compaction','computer_call','computer_call_output'];
      if(!known.includes(p.type))refuse('ORIGINAL_HISTORY_UNKNOWN_RESPONSE_ITEM',ref);
      if(p.type==='message'&&!['system','developer','user','assistant'].includes(p.role))refuse('ORIGINAL_HISTORY_UNKNOWN_MESSAGE_ROLE',ref);
      if(!this.relevant){
        this.priorResponseItems.add(digest(p));this.priorEnvelopes.set(digest(p),
          {metadataDigest:digest(row.metadata??null),supported:knownHarnessMetadata(row.metadata)});
        if(validMcpAttribution(row.metadata?.mcp_attribution))this.priorMcpAttributions.add(digest(row.metadata.mcp_attribution));
        const source=row.metadata?.retained_source,order=row.metadata?.user_input_order;
        if(knownHarnessMetadata(row.metadata)&&validRetainedSource(source)&&p.type==='message'&&source.id.message_id===p.id&&source.id.role===p.role
          &&source.id.turn_id===this.active&&p.internal_chat_message_metadata_passthrough?.turn_id===this.active
          &&Number.isSafeInteger(order)&&order>=0&&row.metadata.inherited_user_message!==true){
          const key=digest(source),existing=this.priorRetainedSources.get(key);
          if(existing&&(existing.payloadDigest!==digest(p)||existing.order!==order))refuse('ORIGINAL_HISTORY_RETAINED_SOURCE_IDENTITY_CONFLICT',ref);
          const content=p.content,kinds=p.internal_chat_message_metadata_passthrough?.content_item_kinds;
          const textDigest=Array.isArray(content)&&content.every((c:any)=>closed(c,['type','text'])
            &&['input_text','output_text'].includes(c.type)&&typeof c.text==='string')?digest(content.map((c:any)=>c.text).join('\n')):null;
          this.priorRetainedSources.set(key,{payloadDigest:digest(p),textDigest,phase:p.phase??null,
            origin:p.role==='user'&&Array.isArray(kinds)&&kinds.length===1&&kinds[0]==='user.heartbeat'?'heartbeat':'user',order,record:this.count});
        }
      }
      if(p.type==='message'&&p.role==='user'&&row.metadata?.user_input_order!=null){
        const order=row.metadata.user_input_order;
        if(!Number.isSafeInteger(order)||order<0)refuse('ORIGINAL_HISTORY_ACCEPTANCE_ORDER_INVALID',ref);
        if(this.relevant)refuse('ORIGINAL_HISTORY_ACCEPTED_USER_PROVENANCE_PRESENT',ref);
        if(this.priorAcceptedUsers.has(order)&&this.priorAcceptedUsers.get(order)!==digest(p))
          refuse('ORIGINAL_HISTORY_ACCEPTANCE_ORDER_CONFLICT',ref);
        this.priorAcceptedUsers.set(order,digest(p));
      }
      if(this.relevant){
        if(!this.neutralMetadata(row.metadata))refuse('ORIGINAL_HISTORY_RESPONSE_METADATA_UNCLASSIFIED',ref);
        if(p.type==='message'&&p.role==='user'&&generatedStaticContext(p)){
          if(this.current)this.current.generated++;return;
        }
        if(p.type==='message'&&p.role==='user')refuse('ORIGINAL_HISTORY_USER_PROVENANCE_UNPROVEN',ref);
        if(p.type!=='message'||!['system','developer'].includes(p.role))refuse('ORIGINAL_HISTORY_CONVERSATIONAL_OR_TOOL_EFFECT',ref);
        // Runtime configuration messages may carry security or steering changes.
        refuse('ORIGINAL_HISTORY_CONFIGURATION_PROVENANCE_UNPROVEN',ref);
      }
      return;
    }
    if(row.type==='event_msg'){
      if(p.type==='thread_settings_applied'){
        if(p.thread_id!==this.input.binding.threadId||!completeSettings(p.thread_settings))
          refuse('ORIGINAL_HISTORY_SETTINGS_SNAPSHOT_INCOMPLETE',ref);
        const snapshotDigest=digest(p.thread_settings);
        if(this.relevant){
          if(!this.settingsBaseline)refuse('ORIGINAL_HISTORY_SETTINGS_BASELINE_MISSING',ref);
          if(snapshotDigest!==this.settingsBaseline.snapshotDigest)refuse('ORIGINAL_HISTORY_NATIVE_SETTINGS_CHANGED',ref);
        }else{
          this.settingsSnapshot=p.thread_settings;
          this.settingsBaseline={record:this.count,startByte:this.recordStart,endByte:this.recordEnd,snapshotDigest,recordDigest:digest(row)};
        }
        return;
      }
      if(['task_started','turn_started','task_complete','turn_complete','turn_aborted'].includes(p.type)){
        if(this.relevant&&p.type!=='turn_aborted'){
          const start=['task_started','turn_started'].includes(p.type);
          const keys=start?['type','turn_attribution','turn_id','root_turn_id','trace_id','started_at','model_context_window','collaboration_mode_kind']
            :['type','root_turn_id','turn_id','last_agent_message','error','started_at','completed_at','duration_ms','time_to_first_token_ms'];
          if(Object.keys(p).some(key=>!keys.includes(key)))refuse('ORIGINAL_HISTORY_BOUNDARY_SIDECAR_UNKNOWN',ref);
          if(start&&p.turn_attribution!=null&&(!object(p.turn_attribution)||p.turn_attribution.turn_id!==p.turn_id
            ||Object.keys(p.turn_attribution).some(key=>!['turn_id','turn_trigger','parent_turn_id','initiating_agent_path','root_turn_id'].includes(key))))
            refuse('ORIGINAL_HISTORY_BOUNDARY_SIDECAR_UNKNOWN',ref);
        }
        return;
      }
      if(p.type==='token_count'){
        if(!Object.hasOwn(p,'info')||!Object.hasOwn(p,'rate_limits')||!validRateLimits(p.rate_limits)
          ||Object.keys(p).some(key=>!['type','info','rate_limits'].includes(key))
          ||p.info!==null&&(!object(p.info)||!validUsage(p.info.total_token_usage)||!validUsage(p.info.last_token_usage)
            ||Object.keys(p.info).some(key=>!['total_token_usage','last_token_usage','model_context_window'].includes(key))
            ||p.info.model_context_window!==null&&(!Number.isSafeInteger(p.info.model_context_window)||p.info.model_context_window<0)))
          refuse('ORIGINAL_HISTORY_TOKEN_METADATA_UNCLASSIFIED',ref);
        if(this.relevant&&p.info&&(p.info.last_token_usage.output_tokens>0||p.info.last_token_usage.reasoning_output_tokens>0)){
          if(!this.current)refuse('ORIGINAL_HISTORY_TOKEN_USAGE_EFFECT_UNASSESSED',ref);
          this.current.tokenCounts.push(p.info.last_token_usage);
        }
        return;
      }
      if(p.type==='item_completed'&&p.item?.type==='ContextCompaction'){
        if(!this.current||p.thread_id!==this.input.binding.threadId||p.turn_id!==this.active||!nonempty(p.item.id)
          ||Object.keys(p.item).some(key=>!['type','id'].includes(key))
          ||Object.keys(p).some(key=>!['type','thread_id','turn_id','item','started_at_ms','completed_at_ms'].includes(key)))
          refuse('ORIGINAL_HISTORY_COMPACTION_ITEM_IDENTITY_UNPROVEN',ref);
        if(this.current.completionIds.has(p.item.id))refuse('ORIGINAL_HISTORY_COMPACTION_ITEM_IDENTITY_UNPROVEN',ref);
        this.current.completionIds.add(p.item.id);this.current.typedCompactions++;this.current.compactions++;return;
      }
      if(p.type==='context_compacted'){
        if(Object.keys(p).some(key=>key!=='type'))refuse('ORIGINAL_HISTORY_BOUNDARY_SIDECAR_UNKNOWN',ref);
        if(this.current)this.current.compactions++;
        return;
      }
      const effects=['user_message','agent_message','agent_reasoning','agent_reasoning_raw_content','exec_command_begin',
        'exec_command_end','apply_patch_begin','apply_patch_end','web_search_begin','web_search_end','item_completed'];
      if(effects.includes(p.type)){
        if(this.relevant)refuse(p.type==='user_message'?'ORIGINAL_HISTORY_ACCEPTED_USER_EVENT_PRESENT':'ORIGINAL_HISTORY_CONVERSATIONAL_OR_TOOL_EFFECT',ref);
        return;
      }
      refuse('ORIGINAL_HISTORY_UNKNOWN_OR_UNCLASSIFIED_EVENT',ref);
    }
    if(row.type==='token_usage_record'){
      if(!validUsage(p.usage)||!validUsage(p.turn_token_usage)||!validUsage(p.thread_token_usage)
        ||!nonempty(p.response_id)||!nonempty(p.turn_id)||!nonempty(p.session_id)||!nonempty(p.root_turn_id)
        ||Object.keys(p).some(key=>!['thread_id','turn_id','session_id','root_turn_id','response_id','usage','turn_token_usage','thread_token_usage'].includes(key)))
        refuse('ORIGINAL_HISTORY_TOKEN_USAGE_SHAPE_INVALID',ref);
      if(p.session_id!==this.sourceSessionId)refuse('ORIGINAL_HISTORY_TOKEN_SESSION_IDENTITY_CONFLICT',ref);
      if(this.relevant){
        if(!this.current||p.turn_id!==this.active||this.current.usageRecords.some(item=>item.response_id===p.response_id))
          refuse('ORIGINAL_HISTORY_TOKEN_USAGE_EFFECT_UNASSESSED',ref);
        this.current.usageRecords.push(p);
      }
      return;
    }
    refuse('ORIGINAL_HISTORY_UNKNOWN_OR_UNCLASSIFIED_RECORD',ref);
  }
  finish(){
    if(this.active!==null||this.current)refuse('ORIGINAL_HISTORY_TURN_NOT_TERMINAL');
    if(this.order.length!==this.expected.length||this.spans.length!==this.expected.length)refuse('ORIGINAL_HISTORY_ATTEMPT_COVERAGE_INCOMPLETE');
  }
}

/** Pinned core context fragments attach these exact source kinds positionally.
 * A role, prompt text, missing client ID or incomplete vector gives no proof. */
function generatedStaticContext(item:any):boolean{
  const kinds=item.internal_chat_message_metadata_passthrough?.content_item_kinds;
  return Array.isArray(item.content)&&item.content.length>0&&Array.isArray(kinds)&&kinds.length===item.content.length
    &&kinds.every((kind:any,index:number)=>['agents_md.instructions','environments.environment_context'].includes(kind)
      &&item.content[index]?.type==='input_text'&&typeof item.content[index].text==='string');
}

function contextSettings(context:any){
  // These two fields identify the turn/root, not the effective settings. Every
  // other persisted field, including future fields, participates in equality.
  const {turn_id:_turn,root_turn_id:_root,...settings}=context;return settings;
}
function contextMatchesSettings(context:any,settings:any):boolean{
  if(!settings||context.cwd!==settings.cwd||context.model!==settings.model||context.effort!==settings.reasoning_effort
    ||digest(context.approval_policy)!==digest(settings.approval_policy))return false;
  for(const key of ['approvals_reviewer','permission_profile','active_permission_profile','collaboration_mode','disabled_plugin_ids']){
    if(Object.hasOwn(context,key)&&digest(context[key])!==digest(settings[key]??null))return false;
  }
  // Legacy context still records sandbox policy. A modern explicit permission
  // profile is compared above; only the exact source-defined disabled legacy
  // representation is accepted without one.
  return Object.hasOwn(context,'permission_profile')||settings.permission_profile.type==='disabled'
    &&digest(context.sandbox_policy)===digest({type:'danger-full-access'});
}
function completeSettings(p:any):boolean{
  if(!object(p)||!nonempty(p.model)||!nonempty(p.model_provider_id)||!nonempty(p.cwd)||!isAbsolute(p.cwd)
    ||!nonempty(p.reasoning_effort)||!['user','auto_review','guardian_subagent'].includes(p.approvals_reviewer)
    ||!Array.isArray(p.disabled_plugin_ids)||p.disabled_plugin_ids.some((id:any)=>!nonempty(id))
    ||!object(p.collaboration_mode)||!['default','plan'].includes(p.collaboration_mode.mode)
    ||!object(p.collaboration_mode.settings)||!nonempty(p.collaboration_mode.settings.model)
    ||!Object.hasOwn(p.collaboration_mode.settings,'reasoning_effort')
    ||!Object.hasOwn(p.collaboration_mode.settings,'developer_instructions')||!object(p.permission_profile))return false;
  const approval=p.approval_policy;
  if(!['never','on-request','on-failure','untrusted'].includes(approval)
    &&!(object(approval)&&object(approval.granular)&&['sandbox_approval','rules','mcp_elicitations'].every(key=>typeof approval.granular[key]==='boolean')))return false;
  const profile=p.permission_profile;
  if(profile.type==='disabled')return true;
  if(!['managed','external'].includes(profile.type)||!['enabled','restricted'].includes(profile.network))return false;
  return profile.type==='external'||object(profile.file_system)
    &&(profile.file_system.type==='unrestricted'||profile.file_system.type==='restricted'&&Array.isArray(profile.file_system.entries));
}
function mergeWorldState(target:any,patch:any):any{
  if(!object(patch))return structuredClone(patch);
  const result=object(target)?structuredClone(target):Object.create(null);
  for(const [key,value] of Object.entries(patch)){
    if(value===null)delete result[key];
    else Object.defineProperty(result,key,{value:mergeWorldState(Object.hasOwn(result,key)?result[key]:null,value),
      enumerable:true,writable:true,configurable:true});
  }
  return result;
}
function validUsage(value:any):boolean{
  const required=['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'];
  return object(value)&&required.every(key=>Number.isSafeInteger(value[key])&&value[key]>=0)
    &&Object.keys(value).every(key=>[...required,'cache_write_input_tokens'].includes(key)
      &&Number.isSafeInteger(value[key])&&value[key]>=0);
}
const closed=(value:any,keys:readonly string[]):boolean=>object(value)&&Object.keys(value).every(key=>keys.includes(key));
const uint=(value:any):boolean=>Number.isSafeInteger(value)&&value>=0;
const optional=(value:any,check:(value:any)=>boolean)=>value==null||check(value);
function validRateLimits(value:any):boolean{
  if(value===null)return true;
  const window=(v:any)=>closed(v,['used_percent','window_minutes','resets_at'])&&typeof v.used_percent==='number'
    &&Number.isFinite(v.used_percent)&&optional(v.window_minutes,Number.isSafeInteger)&&optional(v.resets_at,Number.isSafeInteger);
  return closed(value,['limit_id','limit_name','normal_model_slug','primary','secondary','credits','individual_limit',
    'spend_control_reached','plan_type','rate_limit_reached_type'])
    &&['limit_id','limit_name','normal_model_slug','plan_type'].every(key=>optional(value[key],v=>typeof v==='string'))
    &&optional(value.primary,window)&&optional(value.secondary,window)
    &&optional(value.spend_control_reached,v=>typeof v==='boolean')
    &&optional(value.credits,v=>closed(v,['has_credits','unlimited','balance'])&&typeof v.has_credits==='boolean'
      &&typeof v.unlimited==='boolean'&&optional(v.balance,b=>typeof b==='string'))
    &&optional(value.individual_limit,v=>closed(v,['limit','used','remaining_percent','resets_at'])
      &&typeof v.limit==='string'&&typeof v.used==='string'&&Number.isSafeInteger(v.remaining_percent)
      &&v.remaining_percent>=-2147483648&&v.remaining_percent<=2147483647&&Number.isSafeInteger(v.resets_at))
    &&optional(value.rate_limit_reached_type,v=>['rate_limit_reached','workspace_owner_credits_depleted',
      'workspace_member_credits_depleted','workspace_owner_usage_limit_reached','workspace_member_usage_limit_reached'].includes(v));
}
function validRetainedSource(value:any):boolean{
  return closed(value,['id','revision','complete'])&&closed(value.id,['message_id','turn_id','role'])
    &&nonempty(value.id.message_id)&&nonempty(value.id.turn_id)&&['user','assistant'].includes(value.id.role)
    &&nonempty(value.revision)&&typeof value.complete==='boolean';
}
function validMcpAttribution(value:any):boolean{
  return closed(value,['status','sources','error_reason'])&&['none','complete'].includes(value.status)
    &&value.error_reason==null&&(!Object.hasOwn(value,'sources')||Array.isArray(value.sources)&&value.sources.every((source:any)=>
      closed(source,['connector_id','plugin_id','server_name','tool_name','first_turn_id'])
      &&['server_name','tool_name','first_turn_id'].every(key=>nonempty(source[key]))
      &&['connector_id','plugin_id'].every(key=>optional(source[key],nonempty))))
    &&(value.status!=='none'||value.sources==null||value.sources.length===0);
}
function knownHarnessMetadata(value:any):boolean{
  if(value==null)return true;
  if(!object(value))return false;
  const {retained_source,user_input_order,mcp_attribution,...rest}=value;
  return neutralHarnessMetadata(rest)&&optional(retained_source,validRetainedSource)
    &&optional(user_input_order,uint)&&optional(mcp_attribution,validMcpAttribution);
}

function neutralHarnessMetadata(metadata:any,allowed:readonly string[]=[]):boolean{
  if(metadata==null)return true;
  if(!object(metadata))return false;
  const keys=['guardian_sources','guardian_review_ids','guardian_source_order_guidance','guardian_retained_omissions',
    'retained_source','client_authored','fallback_token_limit_override','delivered_assistant_message',
    'harness_authored_configuration','compaction_model_hash','user_input_order','compaction_output',
    'inherited_user_message','mcp_attribution','sender_user_messages'];
  return Object.entries(metadata).every(([key,value])=>keys.includes(key)&&(allowed.includes(key)&&optional(value,uint)||value==null
    ||['client_authored','harness_authored_configuration','guardian_source_order_guidance','compaction_output','inherited_user_message'].includes(key)&&value===false
    ||['guardian_sources','guardian_review_ids'].includes(key)&&Array.isArray(value)&&value.length===0));
}

/** The caller supplies its actual host client and source binding. This performs
 * a supported read only, then independently reads every original source byte. */
export async function readCodexOriginalHistoryCoverage(input:CodexOriginalHistoryCoverageInput){
  let handle:Awaited<ReturnType<typeof open>>|undefined;
  try{
    validateInput(input);
    const response=await input.client.request('thread/read',{threadId:input.binding.threadId,includeTurns:false});
    if(response?.thread?.id!==input.binding.threadId||!nonempty(response.thread.path)||!isAbsolute(response.thread.path))
      refuse('ORIGINAL_HISTORY_AUTHORITATIVE_PATH_MISSING');
    const home=await realpath(input.codexHome),path=await realpath(response.thread.path);
    if(!within(home,path)||!path.endsWith('.jsonl'))refuse('ORIGINAL_HISTORY_SOURCE_PATH_UNSUPPORTED');
    handle=await open(path,'r');
    const before=await handle.stat({bigint:true}),rev=revision(before);
    if(!before.isFile()||before.size===0n||before.size>BigInt(Number.MAX_SAFE_INTEGER))refuse('ORIGINAL_HISTORY_SOURCE_SHAPE_INVALID');
    const size=Number(before.size),coverage=new RecordCoverage(input),hash=createHash('sha256');
    const chunk=Buffer.alloc(64*1024);let offset=0,lineStart=0,pending:Buffer[]=[],pendingBytes=0;
    while(offset<size){
      const {bytesRead}=await handle.read(chunk,0,Math.min(chunk.length,size-offset),offset);
      if(bytesRead===0)refuse('ORIGINAL_HISTORY_SOURCE_SHORT_READ');
      const bytes=Buffer.from(chunk.subarray(0,bytesRead));hash.update(bytes);
      let start=0,newline:number;
      while((newline=bytes.indexOf(10,start))!==-1){
        const piece=bytes.subarray(start,newline),line=pendingBytes?Buffer.concat([...pending,piece]):piece;
        const end=offset+newline+1;
        coverage.line(line,lineStart,end);lineStart=end;pending=[];pendingBytes=0;start=newline+1;
      }
      if(start<bytes.length){const rest=bytes.subarray(start);pending.push(rest);pendingBytes+=rest.length;}
      offset+=bytesRead;
    }
    if(pendingBytes!==0||lineStart!==size)refuse('ORIGINAL_HISTORY_PARTIAL_FINAL_RECORD');
    coverage.finish();
    if(digest(revision(await handle.stat({bigint:true})))!==digest(rev)
      ||digest(revision(await stat(path,{bigint:true})))!==digest(rev)
      ||await realpath(response.thread.path)!==path)refuse('ORIGINAL_HISTORY_SOURCE_CHANGED');
    const prefixDigest=hash.digest('hex');
    const summary={policy:'codex_original_history_v1' as const,threadId:input.binding.threadId,sourceSessionId:coverage.sourceSessionId,bindingDigest:digest(input.binding),
      selectedInputId:input.selectedInputId,attemptsDigest:digest(input.attempts),sourceIdentity:digest({dev:rev.dev,ino:rev.ino}),
      pathDigest:digest(path),sourceRevisionDigest:digest(rev),prefixDigest,prefixBytes:size,recordCount:coverage.count,
      historyMode:coverage.mode,lastOrdinal:coverage.lastOrdinal,nativeTurnOrder:coverage.order,
      nativeWatermark:coverage.order.at(-1)!,spans:coverage.spans,compactionRecords:coverage.compactions,priorRecordCount:coverage.prior,
      neutralOutsideTurnRecords:coverage.neutralOutsideTurnRecords,settingsBaseline:coverage.settingsBaseline,
      turnContextBaseline:coverage.turnContextBaseline,worldStateBaseline:coverage.worldStateBaseline};
    const witness:CodexOriginalHistoryWitness={...summary,witnessDigest:digest(summary)};
    const custody:CodexOriginalHistoryCustody={path,home,authoritativePath:response.thread.path,configuredHome:input.codexHome,
      revision:rev,threadId:input.binding.threadId,prefixDigest,witnessDigest:witness.witnessDigest};
    return {proven:true as const,witness,custody};
  }catch(error){
    const refusal=error instanceof CoverageRefusal?error:new CoverageRefusal('ORIGINAL_HISTORY_SOURCE_UNAVAILABLE');
    return {proven:false as const,reasons:[{code:refusal.code,evidence:refusal.evidence}]};
  }finally{await handle?.close();}
}

/** Synchronous physical source check for an owner's existing immediate reserve/
 * consume transaction. No parsing or provider I/O occurs inside that transaction. */
export function revalidateCodexOriginalHistorySource(custody:CodexOriginalHistoryCustody,witness:CodexOriginalHistoryWitness):
  {valid:true}|{valid:false;reason:string}{
  let fd:number|undefined;
  try{
    const {witnessDigest,...summary}=witness;
    if(digest(summary)!==witnessDigest||custody.witnessDigest!==witnessDigest||custody.threadId!==witness.threadId
      ||custody.prefixDigest!==witness.prefixDigest||digest(custody.revision)!==witness.sourceRevisionDigest
      ||digest(custody.path)!==witness.pathDigest||Number(custody.revision.size)!==witness.prefixBytes)
      return {valid:false,reason:'ORIGINAL_HISTORY_WITNESS_CONFLICT'};
    if(realpathSync(custody.configuredHome)!==custody.home||realpathSync(custody.authoritativePath)!==custody.path
      ||realpathSync(custody.path)!==custody.path||!within(custody.home,custody.path))
      return {valid:false,reason:'ORIGINAL_HISTORY_SOURCE_CHANGED'};
    fd=openSync(custody.path,'r');
    if(digest(revision(fstatSync(fd,{bigint:true})))!==witness.sourceRevisionDigest
      ||digest(revision(statSync(custody.path,{bigint:true})))!==witness.sourceRevisionDigest)
      return {valid:false,reason:'ORIGINAL_HISTORY_SOURCE_CHANGED'};
    return {valid:true};
  }catch{return {valid:false,reason:'ORIGINAL_HISTORY_SOURCE_UNAVAILABLE'};}
  finally{if(fd!==undefined)closeSync(fd);}
}

/** Worker-only refresh after an actual retained successful owned resume. A native
 * resume persists a settings checkpoint even when no user turn starts. This
 * accepts precisely that owned append; it cannot authorize an arbitrary suffix. */
export async function refreshCodexOriginalHistoryAfterOwnedResume(input:{db:Database;intentId:string;
  witness:CodexOriginalHistoryWitness;custody:CodexOriginalHistoryCustody}){
  let handle:Awaited<ReturnType<typeof open>>|undefined;
  try{
    const {db,witness:w,custody:c}=input,{witnessDigest,...originalSummary}=w;
    if(w.ownedResumeCheckpoint||digest(originalSummary)!==witnessDigest||c.witnessDigest!==witnessDigest
      ||c.prefixDigest!==w.prefixDigest||digest(c.revision)!==w.sourceRevisionDigest||digest(c.path)!==w.pathDigest
      ||c.threadId!==w.threadId||Number(c.revision.size)!==w.prefixBytes)refuse('ORIGINAL_HISTORY_WITNESS_CONFLICT');
    const intent=db.query('SELECT * FROM codex_mutation_intents WHERE intent_id=?').get(input.intentId) as any;
    const permit=intent?db.query('SELECT * FROM codex_mutation_permits WHERE permit_id=?').get(intent.permit_id) as any:null;
    const auth=intent?db.query('SELECT * FROM codex_recovery_dispatch_authorizations WHERE resume_permit_id=?').get(intent.permit_id) as any:null;
    const fence=auth?db.query('SELECT * FROM codex_thread_mutation_fences WHERE fence_id=?').get(auth.fence_id) as any:null;
    let binding:any;try{binding=JSON.parse(auth?.binding_json??'null');}catch{binding=null;}
    if(!intent||!permit||!auth||!fence||!binding||permit.purpose!=='fenced_recovery'||intent.method!=='thread/resume'
      ||intent.response_kind!=='accepted'||!nonempty(intent.response_digest)||intent.state==='reconciled_not_applied'
      ||intent.thread_id!==w.threadId||intent.fence_id!==auth.fence_id||fence.state!=='active'||fence.thread_id!==w.threadId
      ||auth.accepted_input_id!==w.selectedInputId||intent.accepted_input_id!==auth.accepted_input_id
      ||intent.run_id!==auth.run_id||intent.dispatch_attempt!==auth.dispatch_attempt
      ||fence.accepted_input_id!==auth.accepted_input_id||fence.run_id!==auth.run_id||fence.dispatch_attempt!==auth.dispatch_attempt
      ||digest(binding)!==w.bindingDigest||auth.thread_id!==w.threadId)
      refuse('ORIGINAL_HISTORY_OWNED_RESUME_RECEIPT_UNPROVEN');
    if(await realpath(c.configuredHome)!==c.home||await realpath(c.authoritativePath)!==c.path||!within(c.home,c.path))
      refuse('ORIGINAL_HISTORY_SOURCE_CHANGED');
    handle=await open(c.path,'r');const before=await handle.stat({bigint:true}),rev=revision(before);
    if(!before.isFile()||rev.dev!==c.revision.dev||rev.ino!==c.revision.ino||before.size<=BigInt(w.prefixBytes)
      ||before.size>BigInt(Number.MAX_SAFE_INTEGER))refuse('ORIGINAL_HISTORY_OWNED_RESUME_APPEND_MISSING');
    const size=Number(before.size),fullHash=createHash('sha256'),prefixHash=createHash('sha256');
    let offset=0;const chunk=Buffer.alloc(64*1024),append:Buffer[]=[];
    while(offset<size){
      const {bytesRead}=await handle.read(chunk,0,Math.min(chunk.length,size-offset),offset);
      if(!bytesRead)refuse('ORIGINAL_HISTORY_SOURCE_SHORT_READ');
      const bytes=Buffer.from(chunk.subarray(0,bytesRead));fullHash.update(bytes);
      const prefixLength=Math.max(0,Math.min(bytesRead,w.prefixBytes-offset));
      if(prefixLength)prefixHash.update(bytes.subarray(0,prefixLength));
      if(prefixLength<bytesRead)append.push(bytes.subarray(prefixLength));offset+=bytesRead;
    }
    if(prefixHash.digest('hex')!==w.prefixDigest)refuse('ORIGINAL_HISTORY_OWNED_RESUME_PREFIX_CHANGED');
    const bytes=Buffer.concat(append);
    if(bytes.at(-1)!==10||bytes.subarray(0,-1).includes(10))refuse('ORIGINAL_HISTORY_OWNED_RESUME_APPEND_NOT_EXACT');
    let row:any;try{row=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,-1)));}
    catch{refuse('ORIGINAL_HISTORY_OWNED_RESUME_APPEND_DECODE_FAILED');}
    const p=row?.payload,settings=p?.thread_settings;
    if(!w.settingsBaseline)refuse('ORIGINAL_HISTORY_OWNED_RESUME_SETTINGS_BASELINE_MISSING');
    if(!object(row)||row.type!=='event_msg'||!nonempty(row.timestamp)||!Number.isFinite(Date.parse(row.timestamp))
      ||p?.type!=='thread_settings_applied'||p.thread_id!==w.threadId||!completeSettings(settings)
      ||settings.model!==binding.model||settings.reasoning_effort!==binding.effort
      ||digest(settings)!==w.settingsBaseline.snapshotDigest
      ||w.historyMode==='paginated'&&row.ordinal!==w.lastOrdinal!+1
      ||w.historyMode==='legacy'&&row.ordinal!=null)
      refuse('ORIGINAL_HISTORY_OWNED_RESUME_SETTINGS_CONFLICT');
    if(digest(revision(await handle.stat({bigint:true})))!==digest(rev)
      ||digest(revision(await stat(c.path,{bigint:true})))!==digest(rev)
      ||await realpath(c.authoritativePath)!==c.path)refuse('ORIGINAL_HISTORY_SOURCE_CHANGED');
    const checkpoint={intentId:intent.intent_id,permitId:intent.permit_id,responseDigest:intent.response_digest,
      previousWitnessDigest:w.witnessDigest,previousPrefixDigest:w.prefixDigest,
      appendDigest:createHash('sha256').update(bytes).digest('hex'),appendBytes:bytes.length,recordCount:1 as const};
    const summary={...originalSummary,prefixDigest:fullHash.digest('hex'),prefixBytes:size,recordCount:w.recordCount+1,
      sourceRevisionDigest:digest(rev),lastOrdinal:w.historyMode==='paginated'?row.ordinal:null,ownedResumeCheckpoint:checkpoint};
    const witness:CodexOriginalHistoryWitness={...summary,witnessDigest:digest(summary)};
    const custody:CodexOriginalHistoryCustody={...c,revision:rev,prefixDigest:witness.prefixDigest,witnessDigest:witness.witnessDigest};
    return {proven:true as const,witness,custody};
  }catch(error){
    const refusal=error instanceof CoverageRefusal?error:new CoverageRefusal('ORIGINAL_HISTORY_SOURCE_UNAVAILABLE');
    return {proven:false as const,reasons:[{code:refusal.code,evidence:refusal.evidence}]};
  }finally{await handle?.close();}
}
