import {createHash} from 'node:crypto';
import {open,realpath,stat} from 'node:fs/promises';
import {openSync,closeSync,fstatSync,statSync,realpathSync} from 'node:fs';
import {isAbsolute,relative,sep} from 'node:path';
import type {Database} from 'bun:sqlite';
import {acceptedBindingSnapshotDigest,type ContinuationBinding} from './codex-accepted-binding-continuation';
import {CODEX_HISTORY_INTERPRETATION,decodeNativeHistoryRecord,decodeResponse,nativeHistoryInventoryKey,NativeHistoryDecodeError} from './codex-native-history-decoder';
import {parseNativeSourceRecord,nativeSourceValueDigest as sourceDigest,nativeSourceShadow,nativeSourceWithoutKeys,nativeSourceIntegerAt} from './codex-native-source-values';
import {CONTEXT_TRANSITION_INTERPRETATION,ContextTransitionRefusal,renderAdjacentContextTransition} from './codex-diagnostic-context-transition';
import {OwnerContextRefusal,verifyOwnerContextOccurrence,type OwnerContextDiagnosticEvidence} from './codex-owner-context-diagnostic';
import {deriveOrdinaryOriginalCapture,RetainedCaptureRefusal,nativeRetainedFamilyBytes} from './codex-retained-message-capture';
import {recoveryHistoryRefusal,STATE_PRESERVING_HISTORY_POLICY} from './codex-state-preserving-recovery';

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
  interpretation:typeof CODEX_HISTORY_INTERPRETATION;inventory:Record<string,number>;
  baselineTransitions:{record:number;kind:string;sourceRecord:number|null;stateDigest:string|null}[];
  selectedBaselineDigest:string;
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
  ownerContextEvidence?:OwnerContextDiagnosticEvidence;
  client:{request(method:'thread/read',params:Record<string,unknown>):Promise<any>}};

type DiagnosticState={settings:CodexOriginalHistoryWitness['settingsBaseline'];
  context:CodexOriginalHistoryWitness['turnContextBaseline'];world:CodexOriginalHistoryWitness['worldStateBaseline'];
  resetRecord:number|null;resumeRecord:number};
type DiagnosticReference={record:number;snapshotDigest?:string;settingsDigest?:string;stateDigest?:string;
  startByte?:number;endByte?:number;recordDigest?:string}|null;
type DiagnosticFinding={kind:'observed_drift'|'strict_effect'|'invalidated';code:string;evidence:string[];
  record:number;startByte:number;endByte:number;recordDigest:string;before?:DiagnosticReference;after?:DiagnosticReference};
type SourceRecordReference={record:number;startByte:number;endByte:number;recordDigest:string};
type DiagnosticRetainedOriginal={source:SourceRecordReference;payloadDigest:string;envelopeDigest:string;metadataDigest:string;
  order:number|null;capture?:ReturnType<typeof deriveOrdinaryOriginalCapture>;refusal?:string};
type RetainedCaptureRelation={original:SourceRecordReference;checkpoint:SourceRecordReference;sourceDigest:string;
  retainedSource:{id:{message_id:string;turn_id:string;role:string};revision:string;complete:boolean};
  payloadDigest:string;envelopeDigest:string;metadataDigest:string;order:number;role:string;
  capture:Omit<ReturnType<typeof deriveOrdinaryOriginalCapture>,'text'>;snapshotDigest:string;
  familyFlags:{incomplete:boolean;user_messages_incomplete:boolean;assistant_messages_incomplete:boolean;next_order:number};
  subsectionOnly:true;familyMembership:'not_established';compactionRecordValidated:boolean};
type ContextWorldTransition=Omit<ReturnType<typeof renderAdjacentContextTransition>,'fragments'>&{
  interpretation:typeof CONTEXT_TRANSITION_INTERPRETATION;message:SourceRecordReference;patch:SourceRecordReference;
  turnDigest:string;metadataDigest:string;beforeWorldDigest:string;afterWorldDigest:string;
  resetRecord:number|null;fullRecord:number;worldRecords:number[];
  fragments:{index:number;kind:string;textDigest:string;textBytes:number}[]};
/** Deliberately not a witness: no witnessDigest, custody, spans or execution policy.
 * It describes observations under a permanently failed strict proof. */
export type CodexOriginalHistorySuffixDiagnostic={policy:'codex_original_history_diagnostic_v1';
  diagnosticOnly:true;authorizesProviderStart:false;proofBlocked:true;
  interpretation:typeof CODEX_HISTORY_INTERPRETATION;diagnosticInterpretation:'observed_suffix_retained_capture_v4';
  bindingDigest:string;selectedInputId:string;sourceIdentity:string;sourceRevisionDigest:string;pathDigest:string;
  prefixDigest:string;prefixBytes:number;recordCount:number;completeCapturedEof:true;inventory:Record<string,number>;
  strictFailures:{code:string;evidence:string[]}[];findings:DiagnosticFinding[];
  selectedBaseline:DiagnosticState|null;lastObservedState:DiagnosticState|null;
  semanticThroughRecord:number;semanticComplete:boolean;
  invalidatedDependencies:string[];unassessedRange:{firstRecord:number;lastRecord:number}|null;
  transitions:CodexOriginalHistoryWitness['baselineTransitions'];contextWorldTransitions:ContextWorldTransition[];
  ownerContextOccurrences:(ReturnType<typeof verifyOwnerContextOccurrence>&{source:SourceRecordReference;envelopeDigest:string})[];
  retainedCaptureRelations:RetainedCaptureRelation[]};

class SuffixAnalysis {
  findings:DiagnosticFinding[]=[];selectedBaseline:DiagnosticState|null=null;lastObservedState:DiagnosticState|null=null;
  private pendingFindings:DiagnosticFinding[]=[];
  contextWorldTransitions:ContextWorldTransition[]=[];pendingContextTransition:ContextWorldTransition|null=null;
  ownerContextOccurrences:CodexOriginalHistorySuffixDiagnostic['ownerContextOccurrences']=[];
  pendingOwnerContext:CodexOriginalHistorySuffixDiagnostic['ownerContextOccurrences'][number]|null=null;
  // Verified entry relations are independent subsections. They survive a later
  // failure in the same compaction, without committing reconstruction state.
  retainedCaptureRelations:RetainedCaptureRelation[]=[];
  semanticThroughRecord=0;invalidatedAt:number|null=null;
  transitions:CodexOriginalHistoryWitness['baselineTransitions']=[];private transitionCount=0;
  record=0;startByte=0;endByte=0;recordDigest='';
  begin(bytes:Buffer,record:number,startByte:number,endByte:number){
    this.pendingFindings=[];
    this.record=record;this.startByte=startByte;this.endByte=endByte;
    this.recordDigest=createHash('sha256').update(bytes).digest('hex');
  }
  finding(kind:DiagnosticFinding['kind'],code:string,evidence:string[],before?:DiagnosticReference,after?:DiagnosticReference){
    this.pendingFindings.push({kind,code,evidence,record:this.record,startByte:this.startByte,endByte:this.endByte,
      recordDigest:this.recordDigest,...(before===undefined?{}:{before}),...(after===undefined?{}:{after})});
  }
  invalidate(error:CoverageRefusal,firstRecord=this.record){
    this.pendingContextTransition=null;
    this.pendingOwnerContext=null;
    this.pendingFindings=[];this.finding('invalidated',error.code,error.evidence);
    this.findings.push(...this.pendingFindings);this.pendingFindings=[];this.invalidatedAt=firstRecord;
  }
  state(coverage:RecordCoverage):DiagnosticState{
    return {settings:coverage.settingsBaseline,context:coverage.turnContextBaseline,world:coverage.worldStateBaseline,
      resetRecord:coverage.resetRecord,resumeRecord:coverage.resumeRecord};
  }
  commit(coverage:RecordCoverage){
    if(coverage.pendingContext)return;
    // Called only after a whole record succeeded. A thrown reducer is discarded,
    // so none of its partially updated state can appear as a committed baseline.
    this.semanticThroughRecord=coverage.count;this.lastObservedState=this.state(coverage);
    for(const relation of this.retainedCaptureRelations)if(relation.checkpoint.record===coverage.count)
      relation.compactionRecordValidated=true;
    this.findings.push(...this.pendingFindings);this.pendingFindings=[];
    if(this.pendingContextTransition){this.contextWorldTransitions.push(this.pendingContextTransition);this.pendingContextTransition=null;}
    if(this.pendingOwnerContext){
      if(!this.ownerContextOccurrences.some(o=>o.source.record===this.pendingOwnerContext!.source.record))
        this.ownerContextOccurrences.push(this.pendingOwnerContext);
      this.pendingOwnerContext=null;
    }
    if(coverage.relevant)this.transitions.push(...coverage.baselineTransitions.slice(this.transitionCount));
    this.transitionCount=coverage.baselineTransitions.length;
  }
}

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
  inventory:Record<string,number>=Object.create(null);issues:{code:string;evidence:string[]}[]=[];blocked=false;
  baselineTransitions:CodexOriginalHistoryWitness['baselineTransitions']=[];selectedBaselineDigest='';
  count=0;prior=0;mode:'legacy'|'paginated'='legacy';lastOrdinal:number|null=null;
  sourceSessionId:string|null=null;neutralOutsideTurnRecords:CodexOriginalHistoryWitness['neutralOutsideTurnRecords']=[];
  relevant=false;active:string|null=null;seen=new Set<string>();order:string[]=[];
  spans:Span[]=[];compactions:CodexOriginalHistoryWitness['compactionRecords']=[];
  current:{id:string;start:number;records:number;contexts:number;generated:number;compactions:number;typedCompactions:number;
    compactedRecords:number;completionIds:Set<string>;responseIds:Set<string>;usageRecords:any[];tokenCounts:any[];hash:ReturnType<typeof createHash>}|null=null;
  priorAcceptedUsers=new Map<number,string>();
  priorEnvelopes=new Map<string,Map<string,{record:number;supported:boolean}>>();
  configurationEnvelopes=new Map<string,number>();
  retainedCheckpoints=new Map<string,number>();
  pendingCommunication:{record:number}|null=null;
  backendControls:Record<string,{record:number;recordDigest:string}>=Object.create(null);
  latestUsage:any=null;latestUsageRecord=0;resumeState:any=null;resumeRecord=0;
  resetRecord:number|null=null;comparisonContextDigest:string|null=null;comparisonWorldDigest:string|null=null;
  priorRetainedSources=new Map<string,{payloadDigest:string;textDigest:string|null;phase:any;origin:string;order:number;record:number}>();
  diagnosticRetainedSources=new Map<string,DiagnosticRetainedOriginal>();
  diagnosticRetainedIdentities=new Map<string,DiagnosticRetainedOriginal>();
  priorMcpAttributions=new Set<string>();
  lastContext:any=null;lastStartedTurnId:string|null=null;lastAttribution:any=null;
  lastContextRecord=0;lastStartedRecord=0;lastAttributionRecord:number|null=null;
  settingsBaseline:CodexOriginalHistoryWitness['settingsBaseline']=null;
  turnContextBaseline:CodexOriginalHistoryWitness['turnContextBaseline']=null;
  worldStateBaseline:CodexOriginalHistoryWitness['worldStateBaseline']=null;
  worldState:any=null;settingsSnapshot:any=null;recordStart=0;recordEnd=0;
  worldStateShadow:any=null;
  worldFullRecord:number|null=null;worldRecords:number[]=[];
  pendingContext:{payload:any;metadata:any;source:SourceRecordReference}|null=null;
  expected:string[];
  constructor(readonly input:CodexOriginalHistoryCoverageInput,private readonly diagnostic?:SuffixAnalysis){
    const positions=input.attempts.filter(a=>a.inputId===input.selectedInputId).map(a=>input.nativeTurnOrder.indexOf(a.providerTurnId));
    if(positions.some(p=>p<0))refuse('ORIGINAL_HISTORY_SELECTED_TURN_ABSENT');
    this.expected=input.nativeTurnOrder.slice(Math.min(...positions));
    if(this.expected.some(id=>!input.attempts.some(a=>a.providerTurnId===id))
      ||input.attempts.some(a=>!this.expected.includes(a.providerTurnId)))refuse('ORIGINAL_HISTORY_NATIVE_SUFFIX_MAPPING_INCOMPLETE');
  }
  drift(code:string,ref:string,before:DiagnosticReference,after:DiagnosticReference){
    if(!this.diagnostic)refuse(code,ref);
    this.diagnostic.finding('observed_drift',code,[ref],before,after);
  }
  effect(code:string,ref:string){
    if(!this.diagnostic)refuse(code,ref);
    this.diagnostic.finding('strict_effect',code,[ref]);
  }
  line(bytes:Buffer,start:number,end:number,decoded:{row?:any}){
    let row:any;
    this.count++;
    try{
      if(!Object.hasOwn(decoded,'row'))decoded.row=parseNativeSourceRecord(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
      row=decoded.row;
    }
    catch{refuse('ORIGINAL_HISTORY_RECORD_DECODE_FAILED',`record:${this.count}`);}
    this.recordStart=start;this.recordEnd=end;
    const ref=`record:${this.count}`;
    const inventoryKey=nativeHistoryInventoryKey(row);
    this.inventory[inventoryKey]=(this.inventory[inventoryKey]??0)+1;
    try{decodeNativeHistoryRecord(row);}catch(error){
      if(error instanceof NativeHistoryDecodeError)refuse(error.code,ref);throw error;
    }
    // Once reconstruction fails, keep decoding the complete physical suffix but
    // never let a later checkpoint convert uncertainty into a successful proof.
    if(this.blocked)return;
    if(this.pendingContext&&(this.count!==this.pendingContext.source.record+1||row.type!=='world_state'||row.payload.full!==false))
      refuse('ORIGINAL_HISTORY_ADJACENT_CONTEXT_PATCH_MISSING',`record:${this.pendingContext.source.record}`,ref);
    if(this.pendingCommunication){
      const pending=this.pendingCommunication;this.pendingCommunication=null;
      if(row.type!=='response_item'||row.payload.type!=='agent_message')
        refuse('ORIGINAL_HISTORY_COMMUNICATION_PAIR_UNPROVEN',`record:${pending.record}`,ref);
      // Pinned RollbackPlanner starts a communication instruction boundary at
      // the marker and pairs the next AgentMessage. It does not derive that
      // boundary from the task that happened to be active when delivery arrived.
      this.baselineTransitions.push({record:this.count,kind:'communication_pair',sourceRecord:pending.record,stateDigest:sourceDigest(row)});
    }
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
      if(!nativeSourceIntegerAt(row,'ordinal')||row.ordinal!==(this.lastOrdinal===null?0:this.lastOrdinal+1))
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
      if(this.resumeState){this.resumeState.last_started_turn_id=p.turn_id;
        if(p.turn_attribution!=null)this.resumeState.turn_attribution=p.turn_attribution;}
      if(this.expected.includes(p.turn_id)||this.relevant){
        if(!this.relevant&&!this.settingsBaseline)refuse('ORIGINAL_HISTORY_SETTINGS_BASELINE_MISSING',ref);
        if(!this.relevant&&!this.turnContextBaseline)refuse('ORIGINAL_HISTORY_TURN_SETTINGS_BASELINE_MISSING',ref);
        if(!this.relevant){
          if(this.diagnostic)this.diagnostic.selectedBaseline=this.diagnostic.state(this);
          this.selectedBaselineDigest=digest({settings:this.settingsBaseline,context:this.turnContextBaseline,
            world:this.worldStateBaseline,resume:this.resumeState,resumeRecord:this.resumeRecord,
            backendControls:this.backendControls,
            latestUsageRecord:this.latestUsageRecord,
            lastStartedRecord:this.lastStartedRecord,lastAttributionRecord:this.lastAttributionRecord});
          this.comparisonContextDigest=this.turnContextBaseline!.settingsDigest;
          this.comparisonWorldDigest=this.worldStateBaseline?.stateDigest??null;
        }
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
        this.neutralOutsideTurnRecords.push({record:this.count,kind:row.type==='event_msg'?p.type:row.type,recordDigest:sourceDigest(row)});
      else refuse('ORIGINAL_HISTORY_UNOWNED_SUFFIX_RECORD',ref);
    }
    if(this.current){this.current.records++;this.current.hash.update(bytes);this.current.hash.update('\n');}
    if((row.type==='turn_context'&&this.relevant||ends)&&p.turn_id!==this.active)refuse('ORIGINAL_HISTORY_EXACT_TURN_CONTEXT_MISSING',ref);
    this.classify(row,ref);
    if(ends){
      if(!nonempty(p.turn_id)||p.turn_id!==this.active)refuse('ORIGINAL_HISTORY_TURN_BOUNDARY_INVALID',ref);
      if(this.current){
        if(!['task_complete','turn_complete'].includes(p.type))refuse('ORIGINAL_HISTORY_TERMINAL_EFFECT_OR_FAILURE',ref);
        if(p.error!=null||p.last_agent_message!=null&&p.last_agent_message!=='')
          this.effect('ORIGINAL_HISTORY_TERMINAL_EFFECT_OR_FAILURE',ref);
        if(this.current.contexts<1||!this.turnContextBaseline)refuse('ORIGINAL_HISTORY_EXACT_TURN_CONTEXT_MISSING',ref);
        const owner=this.input.attempts.find(a=>a.providerTurnId===this.current!.id)!;
        if(owner.inputId===this.input.selectedInputId&&this.current.compactions>0)this.effect('ORIGINAL_HISTORY_SELECTED_COMPACTION_PRESENT',ref);
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
      if(this.lastContext&&this.lastContext.turn_id===p.turn_id){
        this.resumeState??=normalizeResume({multi_agent_version:this.lastContext.multi_agent_version,
          last_started_turn_id:this.lastStartedTurnId,turn_attribution:this.lastAttribution,previous_turn_settings:null});
        this.resumeState.previous_turn_settings=previousSettings(this.lastContext);
      }
    }
  }
  rememberEnvelope(p:any,metadata:any,record=this.count){
    const key=sourceDigest(p),envelopes=this.priorEnvelopes.get(key)??new Map();
    envelopes.set(digest(canonicalMetadata(metadata)),{record,supported:true});this.priorEnvelopes.set(key,envelopes);
    const config=configurationIdentity(p,metadata);
    if(config!==null)this.configurationEnvelopes.set(config,record);
  }
  neutralMetadata(metadata:any,allowed:readonly string[]=[]):boolean{
    if(metadata==null)return true;
    if(!object(metadata))return false;
    const {mcp_attribution,...rest}=metadata;
    return neutralHarnessMetadata(rest,allowed)&&(mcp_attribution==null
      ||validMcpAttribution(mcp_attribution)&&(mcp_attribution.status==='none'
        ||this.priorMcpAttributions.has(digest(mcp_attribution))));
  }
  registerDiagnosticRetainedOriginal(row:any){
    if(!this.diagnostic)return;
    const p=row.payload,m=row.metadata,source=m?.retained_source;
    if(!validRetainedSource(source)||p.type!=='message')return;
    const original:DiagnosticRetainedOriginal={source:{record:this.count,startByte:this.recordStart,endByte:this.recordEnd,
      recordDigest:this.diagnostic.recordDigest},payloadDigest:sourceDigest(p),envelopeDigest:sourceDigest(row),
      metadataDigest:sourceDigest(m),order:Number.isSafeInteger(m.user_input_order)?m.user_input_order:null};
    const key=digest(source),identity=digest({id:source.id,revision:source.revision}),existing=this.diagnosticRetainedIdentities.get(identity);
    if(existing&&(existing.payloadDigest!==original.payloadDigest||existing.metadataDigest!==original.metadataDigest))
      refuse('ORIGINAL_HISTORY_RETAINED_SOURCE_IDENTITY_CONFLICT',`record:${existing.source.record}`,`record:${this.count}`);
    try{
      if(Buffer.from(source.revision,'utf8').toString('utf8')!==source.revision)
        throw new RetainedCaptureRefusal('RETAINED_CAPTURE_SOURCE_ID_UNSUPPORTED');
      if(source.id.message_id!==p.id||source.id.role!==p.role||source.id.turn_id!==this.active
        ||p.internal_chat_message_metadata_passthrough?.turn_id!==this.active)
        refuse('ORIGINAL_HISTORY_RETAINED_CONTEXT_SOURCE_UNPROVEN');
      if(m.inherited_user_message===true)throw new RetainedCaptureRefusal('RETAINED_CAPTURE_INHERITED_UNSUPPORTED');
      if(m.delivered_assistant_message!=null)throw new RetainedCaptureRefusal('RETAINED_CAPTURE_DELIVERED_UNSUPPORTED');
      if(m.compaction_output===true)throw new RetainedCaptureRefusal('RETAINED_CAPTURE_COMPACTION_OUTPUT_EXCLUDED');
      const {client_authored,...otherMetadata}=m;
      if(client_authored!=null&&typeof client_authored!=='boolean'||!knownHarnessMetadata(otherMetadata))
        refuse('ORIGINAL_HISTORY_RETAINED_CONTEXT_SOURCE_UNPROVEN');
      if(!nativeSourceIntegerAt(m,'user_input_order'))throw new RetainedCaptureRefusal('RETAINED_CAPTURE_LOCAL_ORDER_UNPROVEN');
      original.capture=deriveOrdinaryOriginalCapture(p,m);
      if(original.capture.complete!==source.complete)throw new RetainedCaptureRefusal('RETAINED_CAPTURE_COMPLETENESS_CONFLICT');
    }catch(error){
      if(error instanceof RetainedCaptureRefusal||error instanceof CoverageRefusal)original.refusal=error.code;else throw error;
    }
    if(!existing){this.diagnosticRetainedIdentities.set(identity,original);this.diagnosticRetainedSources.set(key,original);}
  }
  retainedCheckpoint(value:any,ref:string,classes:Record<string,number>){
    if(!closed(value,['verified_answers','incomplete','user_messages','user_messages_incomplete',
      'assistant_messages','assistant_messages_incomplete','next_order','sender_deliveries'])
      ||!Array.isArray(value.verified_answers)||!Array.isArray(value.user_messages)||!Array.isArray(value.assistant_messages)
      ||typeof value.incomplete!=='boolean'||typeof value.user_messages_incomplete!=='boolean'
      ||typeof value.assistant_messages_incomplete!=='boolean'||!uint(value.next_order))
      refuse('ORIGINAL_HISTORY_COMPACTION_SIDECAR_UNCLASSIFIED',ref);
    if(this.diagnostic&&(!nativeSourceIntegerAt(value,'next_order')
      ||Object.hasOwn(value,'sender_deliveries')&&!Array.isArray(value.sender_deliveries)))
      refuse('ORIGINAL_HISTORY_COMPACTION_SIDECAR_UNCLASSIFIED',ref);
    const checkpointRecord=this.retainedCheckpoints.get(digest(value));
    if(checkpointRecord!==undefined&&!this.diagnostic){
      classes.historicalRetainedCheckpoint=(classes.historicalRetainedCheckpoint??0)+1;
      return [{record:checkpointRecord,sourceDigest:digest(value),payloadDigest:digest(value)}];
    }
    if(value.verified_answers.length||value.sender_deliveries!=null&&(!Array.isArray(value.sender_deliveries)||value.sender_deliveries.length))
      refuse('ORIGINAL_HISTORY_RETAINED_CONTEXT_EVENT_PROVENANCE_UNSUPPORTED',ref);
    const identities=new Set<string>(),orders=new Set<number>(),refs:{record:number;sourceDigest:string;payloadDigest:string}[]=[];
    for(const role of ['user','assistant'])for(const entry of value[`${role}_messages`]){
      if(!closed(entry,['revision','inherited','order','turn_id','message_id','text','complete','origin','phase'])
        ||!nonempty(entry.revision)||!nonempty(entry.turn_id)||!nonempty(entry.message_id)||!uint(entry.order)
        ||typeof entry.text!=='string'||typeof entry.complete!=='boolean'||entry.inherited!=null&&entry.inherited!==false)
        refuse('ORIGINAL_HISTORY_RETAINED_CONTEXT_SOURCE_UNPROVEN',ref);
      if(this.diagnostic&&(Object.hasOwn(entry,'origin')&&!['user','heartbeat'].includes(entry.origin)
        ||Object.hasOwn(entry,'inherited')&&typeof entry.inherited!=='boolean'))
        refuse('ORIGINAL_HISTORY_RETAINED_CONTEXT_SOURCE_UNPROVEN',ref);
      const source={id:{message_id:entry.message_id,turn_id:entry.turn_id,role},revision:entry.revision,complete:entry.complete};
      const key=digest(source),original=this.priorRetainedSources.get(key),observed=this.diagnosticRetainedSources.get(key);
      if(this.diagnostic&&observed?.refusal)refuse(observed.refusal,ref);
      const order=this.diagnostic?observed?.order:original?.order;
      if(order!==entry.order||entry.order>=value.next_order||identities.has(key)||orders.has(entry.order))
        refuse('ORIGINAL_HISTORY_RETAINED_CONTEXT_SOURCE_UNPROVEN',ref);
      if(this.diagnostic){
        const capture=observed?.capture;
        if(!observed||!capture)refuse('ORIGINAL_HISTORY_RETAINED_CONTEXT_SOURCE_UNPROVEN',ref);
        if(capture.text!==entry.text||capture.phase!==(entry.phase??null))refuse('ORIGINAL_HISTORY_RETAINED_CONTEXT_PAYLOAD_UNPROVEN',ref);
        if(capture.complete!==entry.complete||(entry.origin??'user')!==capture.origin)
          refuse('ORIGINAL_HISTORY_RETAINED_CONTEXT_SOURCE_UNPROVEN',ref);
        if(!nativeSourceIntegerAt(entry,'order')||!nativeSourceIntegerAt(value,'next_order'))
          refuse('ORIGINAL_HISTORY_RETAINED_CONTEXT_SOURCE_UNPROVEN',ref);
        const {text:_private,...summary}=capture;
        this.diagnostic.retainedCaptureRelations.push({original:observed.source,
          checkpoint:{record:this.count,startByte:this.recordStart,endByte:this.recordEnd,recordDigest:this.diagnostic.recordDigest},
          sourceDigest:key,retainedSource:source,payloadDigest:observed.payloadDigest,envelopeDigest:observed.envelopeDigest,metadataDigest:observed.metadataDigest,
          order:entry.order,role,capture:summary,snapshotDigest:sourceDigest(value),
          familyFlags:{incomplete:value.incomplete,user_messages_incomplete:value.user_messages_incomplete,
            assistant_messages_incomplete:value.assistant_messages_incomplete,next_order:value.next_order},
          subsectionOnly:true,familyMembership:'not_established',compactionRecordValidated:false});
      }else{
        if(!original||original.textDigest===null||original.textDigest!==digest(entry.text)||original.phase!==(entry.phase??null))
          refuse('ORIGINAL_HISTORY_RETAINED_CONTEXT_PAYLOAD_UNPROVEN',ref);
        if((entry.origin??'user')!==original.origin)refuse('ORIGINAL_HISTORY_RETAINED_CONTEXT_SOURCE_UNPROVEN',ref);
      }
      identities.add(key);orders.add(entry.order);
      refs.push({record:this.diagnostic?observed!.source.record:original!.record,sourceDigest:key,
        payloadDigest:this.diagnostic?observed!.payloadDigest:original!.payloadDigest});
      classes.historicalRetainedSource=(classes.historicalRetainedSource??0)+1;
    }
    if(this.diagnostic&&['user','assistant'].some(role=>value[`${role}_messages`].length>8
      ||nativeRetainedFamilyBytes(value[`${role}_messages`])>65536))refuse('RETAINED_CAPTURE_FAMILY_BOUND_INVALID',ref);
    return refs;
  }
  resumeCheckpoint(value:any,ref:string){
    const context=this.lastContext,settings=value?.previous_turn_settings;
    if(!closed(value,['multi_agent_version','last_started_turn_id','turn_attribution','previous_turn_settings'])
      ||!Object.hasOwn(value,'multi_agent_version')||!Object.hasOwn(value,'last_started_turn_id')
      ||!Object.hasOwn(value,'previous_turn_settings')
      ||!optional(value.multi_agent_version,v=>['disabled','v1','v2'].includes(v))
      ||!optional(value.last_started_turn_id,id=>nonempty(id)&&this.seen.has(id))
      ||!optional(value.turn_attribution,v=>closed(v,['turn_id','turn_trigger','parent_turn_id','initiating_agent_path','root_turn_id'])
        &&nonempty(v.turn_id)&&this.seen.has(v.turn_id)
        &&['turn_trigger','parent_turn_id','initiating_agent_path','root_turn_id'].every(key=>optional(v[key],t=>typeof t==='string')))
      ||!optional(settings,v=>closed(v,['model','cyber_access_program','comp_hash','realtime_active'])
        &&Object.hasOwn(v,'comp_hash')&&Object.hasOwn(v,'realtime_active')&&nonempty(v.model)
        &&optional(v.comp_hash,x=>typeof x==='string')&&optional(v.realtime_active,x=>typeof x==='boolean')
        &&optional(v.cyber_access_program,x=>['standard','daybreak_blue','daybreak_red'].includes(x))))
      refuse('ORIGINAL_HISTORY_COMPACTION_RESUME_STATE_UNPROVEN',ref);
    // A checkpoint is authoritative, including None. In the relevant interval
    // it must preserve the reconstructed state, not inherit the next selection.
    const expected=this.resumeState??{multi_agent_version:context?.multi_agent_version??null,
      last_started_turn_id:this.lastStartedTurnId,turn_attribution:this.lastAttribution,
      previous_turn_settings:context?previousSettings(context):null};
    if(this.relevant&&digest(normalizeResume(value))!==digest(normalizeResume(expected)))
      refuse('ORIGINAL_HISTORY_COMPACTION_RESUME_STATE_UNPROVEN',ref);
    this.resumeState=normalizeResume(value);this.resumeRecord=this.count;
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
      // Producer compatibility is distinct from the selected model. This
      // implementation supports the positively matched consumer baseline only.
      &&metadata.compaction_model_hash===(this.lastContext?.comp_hash??this.resumeState?.previous_turn_settings?.comp_hash)
      &&nonempty(checkpoint.compaction_response_id)&&this.current!==null
      &&this.current.usageRecords.some(usage=>usage.response_id===checkpoint.compaction_response_id)
      &&this.neutralMetadata({client_authored:metadata.client_authored,mcp_attribution:metadata.mcp_attribution});
  }
  classify(row:any,ref:string){
    const p=row.payload;
    if(row.type==='session_meta')return;
    if(row.type==='inter_agent_communication_metadata'){
      if(this.relevant)refuse('ORIGINAL_HISTORY_INTERVAL_COMMUNICATION_PRESENT',ref);
      this.pendingCommunication={record:this.count};return;
    }
    if(row.type==='inter_agent_communication'){
      if(this.relevant)refuse('ORIGINAL_HISTORY_INTERVAL_COMMUNICATION_PRESENT',ref);
      this.baselineTransitions.push({record:this.count,kind:'historical_communication',sourceRecord:null,stateDigest:sourceDigest(row)});return;
    }
    if(['retained_context','security_risk_score','realtime_item'].includes(row.type)){
      if(this.relevant)refuse(row.type==='retained_context'?'ORIGINAL_HISTORY_INTERVAL_RETAINED_EFFECT_PRESENT':
        row.type==='realtime_item'?'ORIGINAL_HISTORY_INTERVAL_REALTIME_EFFECT_PRESENT':'ORIGINAL_HISTORY_INTERVAL_RISK_PROVENANCE_UNSUPPORTED',ref);
      this.baselineTransitions.push({record:this.count,kind:`historical_${row.type}`,sourceRecord:null,stateDigest:sourceDigest(row)});return;
    }
    if(row.type==='turn_context'){
      if(this.current){
        if(p.model!==this.input.binding.model||p.effort!==this.input.binding.effort)
          refuse('ORIGINAL_HISTORY_CONTEXT_BINDING_CONFLICT',ref);
        // Diagnostic drift may advance only after validating the current
        // settings relationship. It cannot waive a binding/provenance conflict.
        if(this.diagnostic&&!contextMatchesSettings(p,this.settingsSnapshot))refuse('ORIGINAL_HISTORY_SETTINGS_BASELINES_CONFLICT',ref);
        if(nativeSourceWithoutKeys(p,['turn_id','root_turn_id'])!==this.comparisonContextDigest)
          this.drift('ORIGINAL_HISTORY_TURN_SETTINGS_CHANGED',ref,this.turnContextBaseline,
            {record:this.count,settingsDigest:nativeSourceWithoutKeys(p,['turn_id','root_turn_id'])});
        if(!contextMatchesSettings(p,this.settingsSnapshot))refuse('ORIGINAL_HISTORY_SETTINGS_BASELINES_CONFLICT',ref);
        this.current.contexts++;
      }else if(!this.relevant){
        if(!object(p)||!nonempty(p.cwd)||!Object.hasOwn(p,'approval_policy')||!object(p.sandbox_policy))
          refuse('ORIGINAL_HISTORY_TURN_SETTINGS_BASELINE_INCOMPLETE',ref);
      }
      this.turnContextBaseline={record:this.count,settingsDigest:nativeSourceWithoutKeys(p,['turn_id','root_turn_id'])};
      this.baselineTransitions.push({record:this.count,kind:'context_established',sourceRecord:this.resetRecord,
        stateDigest:this.turnContextBaseline.settingsDigest});
      if(this.resumeState)this.resumeState.multi_agent_version=p.multi_agent_version??null;
      this.lastContext=p;this.lastContextRecord=this.count;return;
    }
    if(row.type==='world_state'){
      if(typeof p.full!=='boolean'||!object(p.state)||Object.keys(p).some(key=>!['full','state'].includes(key)))
        refuse('ORIGINAL_HISTORY_WORLD_STATE_SHAPE_INVALID',ref);
      if(!p.full&&this.worldState===null){
        if(this.relevant)refuse('ORIGINAL_HISTORY_WORLD_STATE_BASELINE_MISSING',ref);
        this.baselineTransitions.push({record:this.count,kind:'unbased_historical_world_patch',sourceRecord:this.resetRecord,stateDigest:null});return;
      }
      const next=p.full?p.state:mergeWorldState(this.worldState,p.state);
      const nextShadow=p.full?nativeSourceShadow(p.state):mergeWorldState(this.worldStateShadow,nativeSourceShadow(p.state));
      if(this.pendingContext){
        const pending=this.pendingContext;
        let rendered:ReturnType<typeof renderAdjacentContextTransition>;
        try{rendered=renderAdjacentContextTransition(this.worldState,next,p.state);}catch(error){
          if(error instanceof ContextTransitionRefusal)refuse(error.code,`record:${pending.source.record}`,ref);throw error;
        }
        const message=pending.payload,kinds=message.internal_chat_message_metadata_passthrough.content_item_kinds;
        if(rendered.fragments.length!==message.content.length||rendered.fragments.some((f,index)=>
          f.kind!==kinds[index]||f.text!==message.content[index].text))
          refuse('ORIGINAL_HISTORY_ADJACENT_CONTEXT_RENDER_MISMATCH',`record:${pending.source.record}`,ref);
        const {fragments,...summary}=rendered;
        this.diagnostic!.pendingContextTransition={...summary,interpretation:CONTEXT_TRANSITION_INTERPRETATION,
          message:pending.source,patch:{record:this.count,startByte:this.recordStart,endByte:this.recordEnd,recordDigest:this.diagnostic!.recordDigest},
          turnDigest:sourceDigest(this.active),metadataDigest:sourceDigest(pending.metadata),
          beforeWorldDigest:sourceDigest(this.worldState,this.worldStateShadow),afterWorldDigest:sourceDigest(next,nextShadow),
          resetRecord:this.resetRecord,fullRecord:this.worldFullRecord!,worldRecords:[...this.worldRecords],
          fragments:fragments.map((f,index)=>({index,kind:f.kind,textDigest:sourceDigest(f.text),textBytes:Buffer.byteLength(f.text)}))};
        this.rememberEnvelope(message,pending.metadata,pending.source.record);
        if(this.current)this.current.generated++;
        this.pendingContext=null;
      }
      if(this.relevant){
        if(this.comparisonWorldDigest===null)refuse('ORIGINAL_HISTORY_WORLD_STATE_BASELINE_MISSING',ref);
        if(sourceDigest(next,nextShadow)!==this.comparisonWorldDigest)
          this.drift('ORIGINAL_HISTORY_WORLD_STATE_CHANGED',ref,this.worldStateBaseline,
            {record:this.count,stateDigest:sourceDigest(next,nextShadow)});
      }
      this.worldState=next;this.worldStateShadow=nextShadow;this.worldStateBaseline={record:this.count,stateDigest:sourceDigest(next,nextShadow)};
      if(p.full){this.worldFullRecord=this.count;this.worldRecords=[];}this.worldRecords.push(this.count);
      this.baselineTransitions.push({record:this.count,kind:p.full?'world_full':'world_patch',sourceRecord:this.resetRecord,stateDigest:sourceDigest(next,nextShadow)});
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
      if(p.replacement_history==null&&p.replacement_history_metadata!=null)refuse('ORIGINAL_HISTORY_COMPACTION_SHAPE_INVALID',ref);
      if(this.relevant&&p.replacement_history==null)refuse('ORIGINAL_HISTORY_LEGACY_COMPACTION_TRANSFORMATION_UNSUPPORTED',ref);
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
      if(p.latest_token_usage_record!=null&&this.relevant&&digest(p.latest_token_usage_record)!==digest(this.latestUsage))
        refuse('ORIGINAL_HISTORY_COMPACTION_USAGE_CHECKPOINT_UNPROVEN',ref);
      for(const [index,entry] of history.entries()){
        try{decodeResponse(entry);}catch(error){if(error instanceof NativeHistoryDecodeError)refuse(error.code,ref);throw error;}
        if(entry.type==='message'&&!['system','developer','user','assistant'].includes(entry.role))
          refuse('ORIGINAL_HISTORY_REPLACEMENT_ITEM_INVALID',ref);
        const c=entry.type==='message'?`message:${entry.role}`:entry.type;
        classes[c]=(classes[c]??0)+1;
        if(this.relevant){
          const metadata=p.replacement_history_metadata?.[index];
          if(metadata!=null&&!object(metadata))refuse('ORIGINAL_HISTORY_COMPACTION_SHAPE_INVALID',ref);
          const original=this.priorEnvelopes.get(sourceDigest(entry))?.get(digest(canonicalMetadata(metadata)));
          // Cloned originals preserve all provenance; a shortened or rewritten copy
          // cannot borrow a retained-source identity from another native payload.
          const cloned=original?.supported===true;
          const opaque=['compaction','context_compaction','compaction_summary'].includes(entry.type)&&this.opaqueCompaction(entry,metadata,p);
          if(['compaction','context_compaction','compaction_summary'].includes(entry.type)&&nonempty(metadata?.compaction_model_hash)
            &&metadata.compaction_model_hash!==(this.lastContext?.comp_hash??this.resumeState?.previous_turn_settings?.comp_hash))
            refuse('ORIGINAL_HISTORY_COMPACTION_PRODUCER_CONSUMER_COMPATIBILITY_UNPROVEN',ref);
          if(!cloned&&!opaque&&!this.neutralMetadata(metadata,['user_input_order']))
            refuse('ORIGINAL_HISTORY_REPLACEMENT_METADATA_UNCLASSIFIED',ref);
          if(opaque){classes.opaqueCompactionContext=(classes.opaqueCompactionContext??0)+1;continue;}
          if(cloned){
            const name=entry.type==='message'&&entry.role==='user'&&metadata?.user_input_order!=null?
              'historicalAcceptedUser':'historicalRetainedEffect';classes[name]=(classes[name]??0)+1;continue;
          }
          const config=configurationIdentity(entry,metadata);
          if(config!==null&&this.configurationEnvelopes.has(config)){
            classes.provenConfigurationRestamp=(classes.provenConfigurationRestamp??0)+1;continue;
          }
          refuse(entry.type==='message'&&entry.role==='user'?'ORIGINAL_HISTORY_REPLACEMENT_USER_PROVENANCE_UNPROVEN':
            entry.type==='message'&&['system','developer'].includes(entry.role)?'ORIGINAL_HISTORY_CONFIGURATION_PROVENANCE_UNPROVEN':
            'ORIGINAL_HISTORY_REPLACEMENT_EFFECT_PROVENANCE_UNPROVEN',ref);
        }
      }
      if(this.current){this.current.compactions++;this.current.compactedRecords++;}
      if(this.current&&p.compaction_response_id!=null){
        if(!nonempty(p.compaction_response_id)||this.current.responseIds.has(p.compaction_response_id))refuse('ORIGINAL_HISTORY_COMPACTION_RESPONSE_IDENTITY_INVALID',ref);
        this.current.responseIds.add(p.compaction_response_id);
      }
      this.compactions.push({providerTurnId:this.active??'',record:this.count,replacementCount:history.length,
        replacementDigest:sourceDigest({history,metadata:p.replacement_history_metadata??null}),replacementClassifications:classes,recordDigest:sourceDigest(row),retainedSourceRefs,resumeSourceRefs});
      if(!this.relevant){
        this.backendControls=Object.create(null);
        for(const [index,entry] of history.entries())this.rememberEnvelope(entry,p.replacement_history_metadata?.[index]);
        for(const entry of history)if(['configuration_update','additional_tools'].includes(entry.type))
          this.backendControls[entry.type]={record:this.count,recordDigest:sourceDigest(row)};
        if(p.retained_context!=null)this.retainedCheckpoints.set(digest(p.retained_context),this.count);
        if(p.resume_metadata!=null)this.resumeCheckpoint(p.resume_metadata,ref);
        if(p.latest_token_usage_record!=null){this.latestUsage=p.latest_token_usage_record;this.latestUsageRecord=this.count;}
      }
      // Native reconstruction invalidates these independently of history contents.
      this.resetRecord=this.count;this.worldState=null;this.worldStateShadow=null;this.worldStateBaseline=null;
      this.worldFullRecord=null;this.worldRecords=[];
      this.turnContextBaseline=null;this.lastContext=null;
      this.baselineTransitions.push({record:this.count,kind:p.replacement_history==null?'legacy_compaction_reset':'compaction_reset',
        sourceRecord:null,stateDigest:null});
      return;
    }
    if(row.type==='response_item'){
      if(!nonempty(p.type))refuse('ORIGINAL_HISTORY_RESPONSE_ITEM_INVALID',ref);
      if(p.type==='message'&&!['system','developer','user','assistant'].includes(p.role))refuse('ORIGINAL_HISTORY_UNKNOWN_MESSAGE_ROLE',ref);
      this.registerDiagnosticRetainedOriginal(row);
      if(!this.relevant){
        this.rememberEnvelope(p,row.metadata);
        if(['additional_tools','configuration_update'].includes(p.type)){
          this.backendControls[p.type]={record:this.count,recordDigest:sourceDigest(row)};
          this.baselineTransitions.push({record:this.count,kind:`historical_${p.type}`,sourceRecord:null,stateDigest:sourceDigest(row)});
        }
        if(validMcpAttribution(row.metadata?.mcp_attribution))this.priorMcpAttributions.add(digest(row.metadata.mcp_attribution));
        const source=row.metadata?.retained_source,order=row.metadata?.user_input_order;
        if(knownHarnessMetadata(row.metadata)&&validRetainedSource(source)&&p.type==='message'&&source.id.message_id===p.id&&source.id.role===p.role
          &&source.id.turn_id===this.active&&p.internal_chat_message_metadata_passthrough?.turn_id===this.active
          &&Number.isSafeInteger(order)&&order>=0&&row.metadata.inherited_user_message!==true){
          const key=digest(source),existing=this.priorRetainedSources.get(key);
          if(existing&&(existing.payloadDigest!==sourceDigest(p)||existing.order!==order))refuse('ORIGINAL_HISTORY_RETAINED_SOURCE_IDENTITY_CONFLICT',ref);
          const content=p.content,kinds=p.internal_chat_message_metadata_passthrough?.content_item_kinds;
          const textDigest=Array.isArray(content)&&content.every((c:any)=>closed(c,['type','text'])
            &&['input_text','output_text'].includes(c.type)&&typeof c.text==='string')?digest(content.map((c:any)=>c.text).join('\n')):null;
          this.priorRetainedSources.set(key,{payloadDigest:sourceDigest(p),textDigest,phase:p.phase??null,
            origin:p.role==='user'&&Array.isArray(kinds)&&kinds.length===1&&kinds[0]==='user.heartbeat'?'heartbeat':'user',order,record:this.count});
        }
      }
      if(p.type==='message'&&p.role==='user'&&row.metadata?.user_input_order!=null){
        const order=row.metadata.user_input_order;
        if(!Number.isSafeInteger(order)||order<0)refuse('ORIGINAL_HISTORY_ACCEPTANCE_ORDER_INVALID',ref);
        if(this.relevant)refuse('ORIGINAL_HISTORY_ACCEPTED_USER_PROVENANCE_PRESENT',ref);
        if(this.priorAcceptedUsers.has(order)&&this.priorAcceptedUsers.get(order)!==sourceDigest(p))
          refuse('ORIGINAL_HISTORY_ACCEPTANCE_ORDER_CONFLICT',ref);
        this.priorAcceptedUsers.set(order,sourceDigest(p));
      }
      if(this.relevant){
        if(!this.neutralMetadata(row.metadata))refuse('ORIGINAL_HISTORY_RESPONSE_METADATA_UNCLASSIFIED',ref);
        if(this.diagnostic&&this.input.ownerContextEvidence&&p.type==='message'&&p.role==='developer'){
          if(!this.current||this.active===null)refuse('OWNER_CONTEXT_NATIVE_ASSOCIATION_MISSING',ref);
          try{
            const occurrence=verifyOwnerContextOccurrence({evidence:this.input.ownerContextEvidence,binding:this.input.binding,
              selectedInputId:this.input.selectedInputId,attempts:this.input.attempts,nativeTurnId:this.active,payload:p,metadata:row.metadata});
            this.diagnostic.pendingOwnerContext={...occurrence,source:{record:this.count,startByte:this.recordStart,endByte:this.recordEnd,
              recordDigest:this.diagnostic.recordDigest},envelopeDigest:sourceDigest(row)};
          }catch(error){if(error instanceof OwnerContextRefusal)refuse(error.code,ref);throw error;}
          this.diagnostic.finding('strict_effect','ORIGINAL_HISTORY_OWNER_APPLICATION_CONTEXT_OBSERVED',[ref]);
          this.rememberEnvelope(p,row.metadata);return;
        }
        if(p.type==='message'&&p.role==='user'&&generatedStaticContext(p)){
          const config=configurationIdentity(p,row.metadata);
          if(config===null||!this.configurationEnvelopes.has(config)){
            if(!this.diagnostic||config===null||!this.current||this.worldFullRecord===null||this.worldState===null
              ||this.lastContext===null||this.turnContextBaseline===null
              ||!closed(p,['type','id','role','content','phase','internal_chat_message_metadata_passthrough'])||p.phase!=null
              ||p.content.some((c:any)=>!closed(c,['type','text']))
              ||p.internal_chat_message_metadata_passthrough?.turn_id!==this.active
              ||row.metadata?.client_authored!==false||row.metadata?.mcp_attribution?.status!=='none')
              refuse('ORIGINAL_HISTORY_CONFIGURATION_PROVENANCE_UNPROVEN',ref);
            this.pendingContext={payload:p,metadata:row.metadata,source:{record:this.count,startByte:this.recordStart,
              endByte:this.recordEnd,recordDigest:this.diagnostic.recordDigest}};return;
          }
          if(this.current)this.current.generated++;return;
        }
        if(p.type==='message'&&p.role==='user')refuse('ORIGINAL_HISTORY_USER_PROVENANCE_UNPROVEN',ref);
        if(p.type!=='message'||!['system','developer'].includes(p.role)){
          this.effect('ORIGINAL_HISTORY_CONVERSATIONAL_OR_TOOL_EFFECT',ref);
          // This is an observed original envelope, not a neutral effect. Retain
          // it only in diagnostic reconstruction for later clone provenance.
          this.rememberEnvelope(p,row.metadata);return;
        }
        // Runtime configuration messages may carry security or steering changes.
        refuse('ORIGINAL_HISTORY_CONFIGURATION_PROVENANCE_UNPROVEN',ref);
      }
      return;
    }
    if(row.type==='event_msg'){
      if(p.type==='thread_settings_applied'){
        if(!this.diagnostic&&this.relevant&&object(p.thread_settings)&&this.settingsBaseline
          &&sourceDigest(p.thread_settings)!==this.settingsBaseline.snapshotDigest)refuse('ORIGINAL_HISTORY_NATIVE_SETTINGS_CHANGED',ref);
        if(p.thread_id!==this.input.binding.threadId||!completeSettings(p.thread_settings))
          refuse('ORIGINAL_HISTORY_SETTINGS_SNAPSHOT_INCOMPLETE',ref);
        if(this.diagnostic&&!diagnosticSettings(p.thread_settings))refuse('ORIGINAL_HISTORY_DIAGNOSTIC_SETTINGS_SHAPE_UNSUPPORTED',ref);
        const snapshotDigest=sourceDigest(p.thread_settings);
        if(this.relevant){
          if(!this.settingsBaseline)refuse('ORIGINAL_HISTORY_SETTINGS_BASELINE_MISSING',ref);
          if(snapshotDigest!==this.settingsBaseline.snapshotDigest)
            this.drift('ORIGINAL_HISTORY_NATIVE_SETTINGS_CHANGED',ref,this.settingsBaseline,
              {record:this.count,startByte:this.recordStart,endByte:this.recordEnd,snapshotDigest,recordDigest:sourceDigest(row)});
          if(this.diagnostic){
            this.settingsSnapshot=p.thread_settings;
            this.settingsBaseline={record:this.count,startByte:this.recordStart,endByte:this.recordEnd,snapshotDigest,recordDigest:sourceDigest(row)};
          }
        }else{
          this.settingsSnapshot=p.thread_settings;
          this.settingsBaseline={record:this.count,startByte:this.recordStart,endByte:this.recordEnd,snapshotDigest,recordDigest:sourceDigest(row)};
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
          if(this.latestUsage&&this.latestUsage.turn_id!==this.active
            &&digest(p.info.last_token_usage)===digest(this.latestUsage.usage)
            &&digest(p.info.total_token_usage)===digest(this.latestUsage.thread_token_usage))return;
          if(!this.current)refuse('ORIGINAL_HISTORY_TOKEN_USAGE_EFFECT_UNASSESSED',ref);
          this.current.tokenCounts.push(p.info.last_token_usage);
        }
        return;
      }
      if(p.type==='item_completed'&&p.item?.type==='ContextCompaction'){
        if(p.thread_id!==this.input.binding.threadId||p.turn_id!==this.active||!nonempty(p.item.id)
          ||Object.keys(p.item).some(key=>!['type','id'].includes(key))
          ||Object.keys(p).some(key=>!['type','thread_id','turn_id','item','started_at_ms','completed_at_ms'].includes(key)))
          refuse('ORIGINAL_HISTORY_COMPACTION_ITEM_IDENTITY_UNPROVEN',ref);
        if(!this.relevant)return;
        if(!this.current)refuse('ORIGINAL_HISTORY_COMPACTION_ITEM_IDENTITY_UNPROVEN',ref);
        if(this.current.completionIds.has(p.item.id))refuse('ORIGINAL_HISTORY_COMPACTION_ITEM_IDENTITY_UNPROVEN',ref);
        this.current.completionIds.add(p.item.id);this.current.typedCompactions++;this.current.compactions++;return;
      }
      if(p.type==='context_compacted'){
        if(Object.keys(p).some(key=>key!=='type'))refuse('ORIGINAL_HISTORY_BOUNDARY_SIDECAR_UNKNOWN',ref);
        if(this.current)this.current.compactions++;
        return;
      }
      // All remaining decoded events are known effects or unsupported proof
      // semantics. Their earlier existence is preserved, never declared neutral.
      {
        if(this.relevant)this.effect(p.type==='user_message'?'ORIGINAL_HISTORY_ACCEPTED_USER_EVENT_PRESENT':'ORIGINAL_HISTORY_CONVERSATIONAL_OR_TOOL_EFFECT',ref);
        return;
      }
    }
    if(row.type==='token_usage_record'){
      if(!validUsage(p.usage)||!validUsage(p.turn_token_usage)||!validUsage(p.thread_token_usage)
        ||!nonempty(p.response_id)||!nonempty(p.turn_id)||!nonempty(p.session_id)||!nonempty(p.root_turn_id)
        ||Object.keys(p).some(key=>!['thread_id','turn_id','session_id','root_turn_id','response_id','usage','turn_token_usage','thread_token_usage'].includes(key)))
        refuse('ORIGINAL_HISTORY_TOKEN_USAGE_SHAPE_INVALID',ref);
      if(p.session_id!==this.sourceSessionId)refuse('ORIGINAL_HISTORY_TOKEN_SESSION_IDENTITY_CONFLICT',ref);
      this.latestUsage=p;this.latestUsageRecord=this.count;
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
    if(this.pendingContext)refuse('ORIGINAL_HISTORY_ADJACENT_CONTEXT_PATCH_MISSING',`record:${this.pendingContext.source.record}`);
    if(this.pendingCommunication)refuse('ORIGINAL_HISTORY_COMMUNICATION_PAIR_UNPROVEN',`record:${this.pendingCommunication.record}`);
    if(this.comparisonWorldDigest!==null&&this.worldStateBaseline===null)
      refuse('ORIGINAL_HISTORY_WORLD_STATE_BASELINE_MISSING');
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

// Native serialization materializes default harness fields when a replacement
// has mixed envelopes. Only source-defined absent/default equivalence is used;
// meaningful delivery, source, order and inherited metadata remain in the key.
function canonicalMetadata(value:any){
  const result={...(value??{})};
  for(const [key,v] of Object.entries(result)){
    if(v==null||['client_authored','guardian_source_order_guidance','harness_authored_configuration','compaction_output',
      'inherited_user_message'].includes(key)&&v===false
      ||['guardian_sources','guardian_review_ids'].includes(key)&&Array.isArray(v)&&v.length===0)delete result[key];
  }
  return result;
}
function configurationIdentity(item:any,metadata:any):string|null{
  const {mcp_attribution,...rest}=metadata??{};
  if(item?.type!=='message'||!neutralHarnessMetadata(rest)
    ||mcp_attribution!=null&&(!validMcpAttribution(mcp_attribution)||mcp_attribution.status!=='none')
    ||!(generatedStaticContext(item)||['system','developer'].includes(item.role)))return null;
  const m=item.internal_chat_message_metadata_passthrough;
  if(m!=null&&(!closed(m,['turn_id','create_time','content_item_kinds'])||m.content_item_kinds!=null&&!Array.isArray(m.content_item_kinds)))return null;
  // Native stamps turn/id/time when recording freshly assembled static context.
  // Everything conveying instructions, role, phase, source kinds and harness
  // provenance must still equal the earlier original envelope.
  const {id:_id,internal_chat_message_metadata_passthrough:_metadata,...payload}=item;
  return digest({payload,kinds:m?.content_item_kinds??null,metadata:canonicalMetadata(metadata)});
}
function previousSettings(context:any){return {model:context.model,cyber_access_program:context.cyber_access_program??null,
  comp_hash:context.comp_hash??null,realtime_active:context.realtime_active??null};}
function normalizeResume(value:any){return {multi_agent_version:value.multi_agent_version??null,
  last_started_turn_id:value.last_started_turn_id??null,turn_attribution:value.turn_attribution??null,
  previous_turn_settings:value.previous_turn_settings==null?null:previousSettings(value.previous_turn_settings)};}

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
  if(!closed(p,['model','model_provider_id','service_tier','approval_policy','approvals_reviewer','permission_profile',
    'active_permission_profile','cwd','runtime_workspace_roots','reasoning_effort','reasoning_summary','personality',
    'collaboration_mode','disabled_plugin_ids'])||!nonempty(p.model)||!nonempty(p.model_provider_id)||!nonempty(p.cwd)||!isAbsolute(p.cwd)
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
function diagnosticSettings(p:any):boolean{
  // Do not advance an observed state on a shallow shape check. Complex managed
  // filesystem policies are not reconstructed by this diagnostic contract.
  return completeSettings(p)&&optional(p.runtime_workspace_roots,v=>Array.isArray(v)&&v.every((root:any)=>nonempty(root)&&isAbsolute(root)))
    &&(typeof p.approval_policy==='string'||closed(p.approval_policy,['granular'])
      &&closed(p.approval_policy.granular,['sandbox_approval','rules','skill_approval','request_permissions','mcp_elicitations'])
      &&['skill_approval','request_permissions'].every(key=>p.approval_policy.granular[key]===undefined
        ||typeof p.approval_policy.granular[key]==='boolean'))
    &&optional(p.service_tier,v=>typeof v==='string')
    &&optional(p.reasoning_summary,v=>['auto','concise','detailed','none'].includes(v))
    &&optional(p.personality,v=>['none','friendly','pragmatic'].includes(v))
    &&closed(p.collaboration_mode,['mode','settings'])
    &&closed(p.collaboration_mode.settings,['model','reasoning_effort','developer_instructions'])
    &&optional(p.collaboration_mode.settings.reasoning_effort,v=>typeof v==='string'&&v.length>0)
    &&optional(p.collaboration_mode.settings.developer_instructions,v=>typeof v==='string')
    &&optional(p.active_permission_profile,v=>closed(v,['id','extends'])&&nonempty(v.id)&&optional(v.extends,t=>typeof t==='string'))
    &&(closed(p.permission_profile,['type'])&&p.permission_profile.type==='disabled'
      ||closed(p.permission_profile,['type','network'])&&p.permission_profile.type==='external'
        &&['enabled','restricted'].includes(p.permission_profile.network));
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
      &&nativeSourceIntegerAt(value,key)&&value[key]>=0);
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
    const analysis=new SuffixAnalysis();let observed:RecordCoverage|null=new RecordCoverage(input,analysis);
    const chunk=Buffer.alloc(64*1024);let offset=0,lineStart=0,pending:Buffer[]=[],pendingBytes=0;
    while(offset<size){
      const {bytesRead}=await handle.read(chunk,0,Math.min(chunk.length,size-offset),offset);
      if(bytesRead===0)refuse('ORIGINAL_HISTORY_SOURCE_SHORT_READ');
      const bytes=Buffer.from(chunk.subarray(0,bytesRead));hash.update(bytes);
      let start=0,newline:number;
      while((newline=bytes.indexOf(10,start))!==-1){
        const piece=bytes.subarray(start,newline),line=pendingBytes?Buffer.concat([...pending,piece]):piece;
        const end=offset+newline+1;
        const decoded:{row?:any}={};
        try{coverage.line(line,lineStart,end,decoded);}catch(error){
          if(!(error instanceof CoverageRefusal))throw error;
          coverage.issues.push({code:error.code,evidence:error.evidence});coverage.blocked=true;
        }
        if(observed){
          analysis.begin(line,coverage.count,lineStart,end);
          try{observed.line(line,lineStart,end,decoded);analysis.commit(observed);}catch(error){
            if(!(error instanceof CoverageRefusal))throw error;
            analysis.invalidate(error,observed.pendingContext?.source.record);observed=null;
          }
        }
        lineStart=end;pending=[];pendingBytes=0;start=newline+1;
      }
      if(start<bytes.length){const rest=bytes.subarray(start);pending.push(rest);pendingBytes+=rest.length;}
      offset+=bytesRead;
    }
    if(pendingBytes!==0||lineStart!==size)refuse('ORIGINAL_HISTORY_PARTIAL_FINAL_RECORD');
    if(!coverage.blocked)try{coverage.finish();}catch(error){
      if(!(error instanceof CoverageRefusal))throw error;
      coverage.issues.push({code:error.code,evidence:error.evidence});coverage.blocked=true;
    }
    if(observed)try{observed.finish();}catch(error){
      if(!(error instanceof CoverageRefusal))throw error;
      analysis.invalidate(error,observed.pendingContext?.source.record);observed=null;
    }
    if(digest(revision(await handle.stat({bigint:true})))!==digest(rev)
      ||digest(revision(await stat(path,{bigint:true})))!==digest(rev)
      ||await realpath(response.thread.path)!==path)refuse('ORIGINAL_HISTORY_SOURCE_CHANGED');
    const prefixDigest=hash.digest('hex');
    if(coverage.blocked){
      const diagnostic:CodexOriginalHistorySuffixDiagnostic={policy:'codex_original_history_diagnostic_v1',
        diagnosticOnly:true,authorizesProviderStart:false,proofBlocked:true,
        interpretation:CODEX_HISTORY_INTERPRETATION,diagnosticInterpretation:'observed_suffix_retained_capture_v4',
        bindingDigest:digest(input.binding),selectedInputId:input.selectedInputId,
        sourceIdentity:digest({dev:rev.dev,ino:rev.ino}),sourceRevisionDigest:digest(rev),pathDigest:digest(path),
        inventory:coverage.inventory,prefixDigest,prefixBytes:size,recordCount:coverage.count,completeCapturedEof:true,
        strictFailures:coverage.issues,findings:analysis.findings,selectedBaseline:analysis.selectedBaseline,
        lastObservedState:analysis.lastObservedState,semanticThroughRecord:analysis.semanticThroughRecord,
        semanticComplete:observed!==null,invalidatedDependencies:observed?[]:
          ['lineage','turn_order','settings','context','world','history_provenance','resume','usage'],
        unassessedRange:analysis.invalidatedAt===null?null:{firstRecord:analysis.invalidatedAt,lastRecord:coverage.count},
        transitions:analysis.transitions,contextWorldTransitions:analysis.contextWorldTransitions,ownerContextOccurrences:analysis.ownerContextOccurrences,
        retainedCaptureRelations:analysis.retainedCaptureRelations};
      return {proven:false as const,reasons:coverage.issues,diagnostic};
    }
    const summary={policy:'codex_original_history_v1' as const,threadId:input.binding.threadId,sourceSessionId:coverage.sourceSessionId,bindingDigest:digest(input.binding),
      interpretation:CODEX_HISTORY_INTERPRETATION,inventory:coverage.inventory,baselineTransitions:coverage.baselineTransitions,
      selectedBaselineDigest:coverage.selectedBaselineDigest,
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
    const policyRefusal=recoveryHistoryRefusal({custody,witness});
    if(policyRefusal)return {valid:false,reason:(witness as any)?.policy===STATE_PRESERVING_HISTORY_POLICY
      ?policyRefusal:'ORIGINAL_HISTORY_WITNESS_CONFLICT'};
    const {witnessDigest,...summary}=witness;
    if(witness.policy!=='codex_original_history_v1'||digest(summary)!==witnessDigest||custody.witnessDigest!==witnessDigest||custody.threadId!==witness.threadId
      ||digest(witness.interpretation)!==digest(CODEX_HISTORY_INTERPRETATION)
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
    const policyRefusal=recoveryHistoryRefusal({custody:c,witness:w});
    if(policyRefusal)refuse((w as any)?.policy===STATE_PRESERVING_HISTORY_POLICY?policyRefusal:'ORIGINAL_HISTORY_WITNESS_CONFLICT');
    if(w.policy!=='codex_original_history_v1'||w.ownedResumeCheckpoint||digest(originalSummary)!==witnessDigest||c.witnessDigest!==witnessDigest
      ||digest(w.interpretation)!==digest(CODEX_HISTORY_INTERPRETATION)
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
    let row:any;try{row=parseNativeSourceRecord(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,-1)));}
    catch{refuse('ORIGINAL_HISTORY_OWNED_RESUME_APPEND_DECODE_FAILED');}
    const p=row?.payload,settings=p?.thread_settings;
    if(!w.settingsBaseline)refuse('ORIGINAL_HISTORY_OWNED_RESUME_SETTINGS_BASELINE_MISSING');
    if(!object(row)||row.type!=='event_msg'||!nonempty(row.timestamp)||!Number.isFinite(Date.parse(row.timestamp))
      ||p?.type!=='thread_settings_applied'||p.thread_id!==w.threadId||!completeSettings(settings)
      ||settings.model!==binding.model||settings.reasoning_effort!==binding.effort
      ||sourceDigest(settings)!==w.settingsBaseline.snapshotDigest
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
