import {acceptedBindingSnapshotDigest as digest} from './codex-accepted-binding-continuation';

export const STATE_PRESERVING_HISTORY_POLICY='codex_state_preserving_recovery_v1' as const;
export type CodexRecoveryHistoryPolicy='codex_original_history_v1'|typeof STATE_PRESERVING_HISTORY_POLICY;
const CAPABILITY_MISSING='NATIVE_EXPLICIT_SELECTION_COLD_RESUME_UNAVAILABLE';
const BOUNDARY_MISSING='PRESERVED_FUTURE_SELECTION_BOUNDARY_UNPROVEN';
const object=(v:any)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=(v:any):v is string=>typeof v==='string'&&v.length>0;
const hash=(v:any):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const keys=(v:any,expected:string[])=>object(v)&&Object.keys(v).length===expected.length
  &&Object.keys(v).every(k=>expected.includes(k));
type Selection={environmentId:string;status:'available'|'starting'|'failed';cwdDigest:string;rootsDigest:string};
type Source={threadId:string;sourceIdentity:string;sourceRevisionDigest:string;prefixDigest:string;recordCount:number;
  bindingDigest:string;selectedInputId:string;logicalInputDigest:string;attemptsDigest:string};
type Capture={source:Source;worldRecords:number[];contextRecord:number;nativeTurnId:string;
  producer:'ordinary_context_continuous_local_v0162';selection:Selection[]};
type Boundary={sourceDigest:string;captureDigest:string;fenceId:string;controlRevision:number;
  operationId:string;operationParamsDigest:string;operationReceiptDigest:string;preparationDigest:string;
  cause:{kind:'captured_turn_construction';nativeTurnId:string}|{kind:'standalone_future_settings'};
  savedSelection:Selection[];outstandingSelectionOperationIds:string[]};
type Preparation={bindingDigest:string;selectedInputId:string;logicalInputDigest:string;
  attachmentIds:string[];preservedRoots:string[];prospectiveRoots:string[];scratchCleanupRoots:string[];
  accessConfigurationDigest:string;taskBoundaryDigest:string;
  startParams:{threadId:string;input:{type:'text';text:string}[];clientUserMessageId:string;model:string;effort:'medium'}};

/** A conditional comparison of private premises, NOT owner evidence. In
 * particular, an equal persisted settings projection is deliberately absent
 * from this relation: it does not encode the saved future selection.
 * There is no constructor for a positive executable state-preserving witness. */
export function compareConditionalPreservation(input:{capture:Capture;boundary:Boundary|null;preparation:Preparation}){
  try {
  const reasons:string[]=[];
  const fail=(code:string)=>{if(!reasons.includes(code))reasons.push(code);};
  const {capture:c,boundary:b,preparation:p}=input;
  const selection=(s:any)=>Array.isArray(s)&&s.length>0&&new Set(s.map(e=>e?.environmentId)).size===s.length
    &&s.every(e=>keys(e,['environmentId','status','cwdDigest','rootsDigest'])&&text(e.environmentId)
      &&['available','starting','failed'].includes(e.status)&&hash(e.cwdDigest)&&hash(e.rootsDigest));
  if(!keys(input,['capture','boundary','preparation'])
    ||!keys(c,['source','worldRecords','contextRecord','nativeTurnId','producer','selection'])
    ||!keys(c?.source,['threadId','sourceIdentity','sourceRevisionDigest','prefixDigest','recordCount','bindingDigest','selectedInputId','logicalInputDigest','attemptsDigest'])
    ||!text(c?.source?.threadId)||!text(c?.source?.sourceIdentity)||!text(c?.source?.selectedInputId)
    ||!['sourceRevisionDigest','prefixDigest','bindingDigest','logicalInputDigest','attemptsDigest'].every(k=>hash((c?.source as any)?.[k]))
    ||!Number.isSafeInteger(c?.source?.recordCount)||c.source.recordCount<1
    ||!Array.isArray(c?.worldRecords)||!c.worldRecords.length
    ||c.worldRecords.some((n,i,a)=>!Number.isSafeInteger(n)||n<1||i>0&&n<=a[i-1])
    ||!Number.isSafeInteger(c?.contextRecord)||c.contextRecord<=c.worldRecords.at(-1)!
    ||c.contextRecord>c.source.recordCount||!text(c.nativeTurnId)
    ||c.producer!=='ordinary_context_continuous_local_v0162'||!selection(c.selection))fail('CAPTURED_STEP_RELATION_INVALID');
  if(!b)fail(BOUNDARY_MISSING);
  else if(!keys(b,['sourceDigest','captureDigest','fenceId','controlRevision','operationId','operationParamsDigest',
    'operationReceiptDigest','preparationDigest','cause','savedSelection','outstandingSelectionOperationIds'])
    ||b.sourceDigest!==digest(c?.source)||b.captureDigest!==digest(c)||!text(b.fenceId)
    ||!Number.isSafeInteger(b.controlRevision)||b.controlRevision<0||!text(b.operationId)
    ||!hash(b.operationParamsDigest)||!hash(b.operationReceiptDigest)||!selection(b.savedSelection)
    ||!Array.isArray(b.outstandingSelectionOperationIds)||b.outstandingSelectionOperationIds.length
    ||!keys(b.cause,['kind','nativeTurnId'])||b.cause.kind!=='captured_turn_construction'
    ||b.cause.nativeTurnId!==c.nativeTurnId)fail(BOUNDARY_MISSING);
  if(b&&b.preparationDigest!==digest(p))fail('PRESERVATION_PREPARATION_CHANGED');
  // This arm preserves sole-local access. Nonlocal/starting/failed authority is
  // not discarded merely because an unrelated local work reference exists.
  if(selection(c?.selection)&&(c.selection.length!==1||c.selection[0].environmentId!=='local'
    ||c.selection[0].status!=='available'))fail('CAPTURED_SELECTION_NOT_SOLE_READY_LOCAL');
  if(b&&selection(b.savedSelection)&&(digest(b.savedSelection)!==digest(c.selection)))
    fail('SAVED_FUTURE_SELECTION_DIFFERS_FROM_CAPTURE');
  if(!keys(p,['bindingDigest','selectedInputId','logicalInputDigest','attachmentIds','preservedRoots','prospectiveRoots',
    'scratchCleanupRoots','accessConfigurationDigest','taskBoundaryDigest','startParams'])
    ||p.bindingDigest!==c?.source?.bindingDigest||p.selectedInputId!==c?.source?.selectedInputId
    ||p.logicalInputDigest!==c.source.logicalInputDigest||!hash(p.accessConfigurationDigest)||!hash(p.taskBoundaryDigest)
    ||!Array.isArray(p.attachmentIds)||p.attachmentIds.length||!Array.isArray(p.preservedRoots)||!p.preservedRoots.length
    ||p.preservedRoots.some(r=>!text(r)||!r.startsWith('/'))||new Set(p.preservedRoots).size!==p.preservedRoots.length
    ||c.selection[0]?.rootsDigest!==digest(p.preservedRoots)
    ||digest(p.prospectiveRoots)!==digest(p.preservedRoots)||!Array.isArray(p.scratchCleanupRoots)||p.scratchCleanupRoots.length
    ||!keys(p.startParams,['threadId','input','clientUserMessageId','model','effort'])||p.startParams.threadId!==c.source.threadId
    ||!text(p.startParams.clientUserMessageId)||p.startParams.model!=='gpt-6-astra'||p.startParams.effort!=='medium'
    ||!Array.isArray(p.startParams.input)||p.startParams.input.length!==1
    ||!keys(p.startParams.input[0],['type','text'])||p.startParams.input[0].type!=='text'||!text(p.startParams.input[0].text))
    fail('SELECTED_PREPARATION_FRAME_UNPROVEN');
  // No raw roots, config, prompts or native/private paths leave this comparison.
  return {policy:STATE_PRESERVING_HISTORY_POLICY,diagnosticOnly:true as const,authorizesProviderStart:false as const,
    proven:false as const,relation:reasons.length?'unproved' as const:'conditional_match' as const,reasons,
    premisesDigest:digest(input)};
  }catch{
    return {policy:STATE_PRESERVING_HISTORY_POLICY,diagnosticOnly:true as const,authorizesProviderStart:false as const,
      proven:false as const,relation:'unproved' as const,reasons:['CONDITIONAL_PRESERVATION_PREMISES_MALFORMED'],premisesDigest:null};
  }
}

/** Fixed public native resume protocol lacks selection before initialization.
 * No version/environment flag, client-supplied field, test mode or dependency
 * injection can turn this into a positive production capability. */
export function statePreservingRecoveryAvailability(){
  return {policy:STATE_PRESERVING_HISTORY_POLICY,proven:false as const,diagnosticOnly:true as const,
    authorizesProviderStart:false as const,reasons:[CAPABILITY_MISSING,BOUNDARY_MISSING]};
}
export function requireRecoveryHistoryPolicy(policy:CodexRecoveryHistoryPolicy|undefined){
  if(policy===undefined||policy==='codex_original_history_v1')return;
  if(policy===STATE_PRESERVING_HISTORY_POLICY)throw new Error(CAPABILITY_MISSING);
  throw new Error('RECOVERY_HISTORY_POLICY_UNKNOWN');
}

/** One discriminant at all existing execution consumers. Legacy strict
 * reservations retain their original representation and digest. A conditional
 * match, including one wrapped as a witness, is never execution authority. */
export function recoveryHistoryRefusal(original:any):string|null {
  if(original?.policy===STATE_PRESERVING_HISTORY_POLICY||original?.witness?.policy===STATE_PRESERVING_HISTORY_POLICY)
    return CAPABILITY_MISSING;
  if(original?.diagnosticOnly||original?.witness?.diagnosticOnly
    ||original?.authorizesProviderStart===false||original?.witness?.authorizesProviderStart===false)
    return 'NATIVE_ORIGINAL_EFFECT_HISTORY_COVERAGE_UNPROVEN';
  if(!keys(original,['witness','custody'])||original.witness?.policy!=='codex_original_history_v1')
    return 'RECOVERY_HISTORY_POLICY_UNKNOWN';
  return null;
}
export function recoveryProofHistoryRefusal(proof:any):string|null{
  if(!object(proof))return 'RECOVERY_HISTORY_POLICY_UNKNOWN';
  if(proof?.policy===STATE_PRESERVING_HISTORY_POLICY||proof?.historyPolicy===STATE_PRESERVING_HISTORY_POLICY)
    return CAPABILITY_MISSING;
  if(Object.hasOwn(proof,'policy')||Object.hasOwn(proof,'historyPolicy'))return 'RECOVERY_HISTORY_POLICY_UNKNOWN';
  if(proof?.native?.originalHistory!==undefined)return recoveryHistoryRefusal(proof.native.originalHistory);
  // Original human-choice/3012 reservations predate the continuation arm.
  return proof?.continuation?'NATIVE_ORIGINAL_EFFECT_HISTORY_COVERAGE_UNPROVEN':null;
}
