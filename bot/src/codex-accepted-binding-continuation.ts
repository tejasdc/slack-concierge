import {createHash} from 'node:crypto';
import {REASONING_EFFORTS} from './aliases';

export interface ContinuationBinding {
  sessionId:number; provider:string; threadId:string; generation:number;
  model:string; effort:string; runner:string|null;
}
export interface ContinuationInput {
  id:string; session_id:number; ordinal:number; kind:string; origin:string;
  turn_id:number|null; steering_id:number|null; request_id:string|null;
  source_input_id:string|null; source_run_id:string|null;
  payload_json:string; receipt_json:string|null;
}
export interface ContinuationTurn {
  id:number; session_id:number; accepted_input_id:string|null; native_run_id:string|null;
  dispatch_attempt:number; status:string; provider_input_acknowledged_at:string|null;
  stop_requested_at:string|null;
}
export interface ContinuationOwnerEvent {
  event_id:string; session_id:number; input_id:string|null; turn_id:number|null;
  kind:string; payload_json:string;
}
export interface ContinuationWitness {
  reference:string; binding:ContinuationBinding;
}
export interface AcceptedBindingContinuationSnapshot {
  binding:ContinuationBinding;
  creation:{input:ContinuationInput; turn:ContinuationTurn};
  source:{input:ContinuationInput; turn:ContinuationTurn};
  selected:{input:ContinuationInput; turn:ContinuationTurn};
  request:{request_id:string;target_session_id:number;target_input_id:string|null;
    outcome:string|null;payload_json:string};
  /** Owner-resolved native binding at acknowledged creation and selected admission.
   * A legacy null nativeBinding is not an identity witness. The adapter must use a
   * retained binding/result record and name it here instead. */
  creationBinding:ContinuationWitness|null;
  selectedBinding:ContinuationWitness|null;
  events:ContinuationOwnerEvent[];
  controls:{reference:string;outside:boolean;suspended:boolean;archived:boolean;
    consultationOnly:boolean;stopRequested:boolean;activeHandoffIds:string[]};
  interval:{
    /** The adapter obtains both the watermark and all rows in one owner snapshot.
     * Session input ordinals can have gaps belonging to other sessions. */
    complete:boolean;fromOrdinal:number;throughOrdinal:number;inputs:ContinuationInput[];
    /** Include accepted controls/actions without turns. An unknown classification
     * refuses; message text is deliberately never used to classify authority. */
    classifications:Array<{inputId:string;reference:string;
      significance:'selected'|'neutral'|'control'|'custody'|'ordering'|'unknown'}>;
    /** Complete relevant owner mutation history from creation through this
     * snapshot. Binding changes refuse. A prior control/custody change requires
     * an exact owner reconciliation proving it no longer blocks this input. */
    mutationCoverage:{complete:boolean;reference:string;fromInputId:string;
      changes:Array<{reference:string;kind:'binding'|'control'|'custody';reconciledBy?:string}>};
    /** These are the actual scheduler's runnable predecessors, not every older
     * terminal reminder. No text overlap can remove a predecessor. */
    fifo:{complete:boolean;reference:string;selectedInputId:string;runnablePredecessorInputIds:string[]};
  };
  /** Include complete owner-side rows used by the adapter, including controls,
   * steering, pending delivery, and obligation custody. They enter the digest but
   * are never emitted. Native proof and the execution fence are separate gates. */
  ownerSnapshot:unknown;
}

function canonical(value:unknown):string {
  if(value===null||typeof value!=='object'){
    const json=JSON.stringify(value);
    if(json===undefined)throw new Error('Continuation snapshot contains an undefined value.');
    return json;
  }
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key])}`).join(',')}}`;
}
export const acceptedBindingSnapshotDigest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const parse=(json:string|null):any=>{try{return json===null?null:JSON.parse(json);}catch{return null;}};
const nonempty=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0;
const bindingEqual=(a:ContinuationBinding,b:ContinuationBinding)=>canonical(a)===canonical(b);

/** Pure owner-evidence policy. This proves a factual continuation basis only;
 * it is neither a queue reservation nor a capability to start a provider. Both
 * execution gates must additionally bind its digest to the same one-attempt
 * reservation, native interval proof and receiver-side execution fence. */
export function proveAcceptedBindingContinuation(snapshot:AcceptedBindingContinuationSnapshot) {
  const reasons:Array<{code:string;evidence:string[]}>=[];
  const refuse=(code:string,...evidence:string[])=>reasons.push({code,evidence});
  const {binding,creation,source,selected,request,interval}=snapshot;
  const refs=new Set<string>();
  const cite=(...references:string[])=>references.filter(nonempty).forEach(ref=>refs.add(ref));
  const createPayload=parse(creation.input.payload_json),createAdmission=parse(creation.input.receipt_json)?.admission;
  const admission=parse(selected.input.receipt_json)?.admission;
  const linked=(item:{input:ContinuationInput;turn:ContinuationTurn})=>
    item.input.session_id===binding.sessionId&&item.turn.session_id===binding.sessionId
      &&item.input.turn_id===item.turn.id&&item.turn.accepted_input_id===item.input.id
      &&nonempty(item.turn.native_run_id);
  const admissionMatches=(value:any,item:{input:ContinuationInput;turn:ContinuationTurn})=>
    value?.inputId===item.input.id&&value.runId===item.turn.native_run_id
      &&value.provider===binding.provider&&value.model===binding.model&&value.bindingGeneration===binding.generation;
  if(binding.provider!=='codex'||binding.model!=='gpt-6-astra'||!REASONING_EFFORTS.includes(binding.effort as any)
    ||!nonempty(binding.threadId)||!Number.isSafeInteger(binding.sessionId)
    ||binding.sessionId<1||!Number.isSafeInteger(binding.generation)||binding.generation<1)
    refuse('PRESERVED_ACCEPTED_BINDING_NOT_PROVEN');
  if(binding.runner!==null&&!nonempty(binding.runner))refuse('RUNNER_CUSTODY_NOT_PROVEN');
  cite(creation.input.id,source.input.id,selected.input.id,request.request_id);
  if(creation.input.kind!=='create'||!linked(creation)||!creation.turn.provider_input_acknowledged_at
    ||createPayload?.provider!==binding.provider||createPayload.model!==binding.model
    ||createPayload.reasoningEffort!==binding.effort||!admissionMatches(createAdmission,creation)
    ||createAdmission.reasoningEffort!==undefined&&createAdmission.reasoningEffort!==binding.effort)
    refuse('ACKNOWLEDGED_CREATION_BINDING_NOT_PROVEN',creation.input.id);
  for(const [name,witness] of [['CREATION',snapshot.creationBinding],['SELECTED',snapshot.selectedBinding]] as const){
    if(!witness||!nonempty(witness.reference)||!bindingEqual(witness.binding,binding))
      refuse(`${name}_NATIVE_BINDING_NOT_PROVEN`,...(witness?[witness.reference]:[]));
    else cite(witness.reference);
  }
  if(!linked(source)||!source.turn.provider_input_acknowledged_at
    ||source.input.id!==request.target_input_id||source.input.ordinal>=selected.input.ordinal
    ||selected.input.source_input_id!==source.input.id||selected.input.source_run_id!==source.turn.native_run_id)
    refuse('ACKNOWLEDGED_SOURCE_CUSTODY_NOT_PROVEN',source.input.id,selected.input.id);
  if(!linked(selected)||selected.input.origin!=='service'||selected.input.id!==`report-back:${request.request_id}`
    ||selected.input.request_id!==request.request_id||selected.input.steering_id!==null
    ||!['done','parked'].includes(selected.turn.status)||selected.turn.provider_input_acknowledged_at!==null
    ||selected.turn.stop_requested_at!==null||selected.turn.dispatch_attempt<1
    ||!admissionMatches(admission,selected))
    refuse('EXACT_UNACKNOWLEDGED_SERVICE_INPUT_NOT_PROVEN',selected.input.id);
  const effortEventId=`prompt-cache-identity:${selected.turn.id}:${selected.turn.dispatch_attempt}`;
  const effortEvents=snapshot.events.filter(event=>event.event_id===effortEventId);
  const effortEvent=effortEvents.length===1?effortEvents[0]:null;
  const exactEffort=effortEvent?.session_id===binding.sessionId&&effortEvent.turn_id===selected.turn.id
    &&(effortEvent.input_id===null||effortEvent.input_id===selected.input.id)
    &&effortEvent.kind==='prompt_cache_identity'?parse(effortEvent.payload_json)?.effort:null;
  // Older receipts omit reasoningEffort. Only the exact attempt event fills that
  // gap; current metadata or a neighbouring event cannot supply it.
  if(admission?.reasoningEffort!==undefined&&admission.reasoningEffort!==binding.effort
    ||exactEffort!==binding.effort)
    refuse('EXACT_SELECTED_EFFORT_NOT_PROVEN',selected.input.id,effortEventId);
  else cite(effortEventId);
  if(request.target_session_id!==binding.sessionId||request.outcome!==null
    ||parse(request.payload_json)?.requestedEffect!=='work'||request.target_input_id===selected.input.id)
    refuse('OPEN_WORK_CUSTODY_NOT_PROVEN',request.request_id);
  const controls=snapshot.controls;
  if(!nonempty(controls.reference)||controls.outside||controls.suspended||controls.archived
    ||controls.consultationOnly||controls.stopRequested||controls.activeHandoffIds.length)
    refuse('CURRENT_SEND_CONTROL_REFUSES',controls.reference,...controls.activeHandoffIds);
  else cite(controls.reference);
  const coverage=interval.mutationCoverage;
  if(!coverage.complete||!nonempty(coverage.reference)||coverage.fromInputId!==creation.input.id)
    refuse('BINDING_CONTROL_CUSTODY_HISTORY_INCOMPLETE',creation.input.id);
  else {
    cite(coverage.reference);
    for(const change of coverage.changes){
      cite(change.reference);
      if(change.kind==='binding'||!nonempty(change.reconciledBy))
        refuse('BINDING_CONTROL_OR_CUSTODY_CHANGED',change.reference);
      else cite(change.reconciledBy);
    }
  }
  const rows=interval.inputs,ids=new Set(rows.map(row=>row.id));
  if(!interval.complete||interval.fromOrdinal!==selected.input.ordinal
    ||!Number.isSafeInteger(interval.throughOrdinal)||interval.throughOrdinal<interval.fromOrdinal
    ||rows.length===0||rows[0]?.id!==selected.input.id||ids.size!==rows.length
    ||rows.some((row,index)=>row.session_id!==binding.sessionId||row.ordinal<interval.fromOrdinal
      ||row.ordinal>interval.throughOrdinal||index>0&&row.ordinal<=rows[index-1]!.ordinal)
    ||rows.at(-1)?.ordinal!==interval.throughOrdinal
    ||canonical(rows[0]??null)!==canonical(selected.input))
    refuse('COMPLETE_ACCEPTED_INPUT_INTERVAL_NOT_PROVEN',selected.input.id);
  const classifications=interval.classifications;
  if(classifications.length!==rows.length||new Set(classifications.map(row=>row.inputId)).size!==rows.length
    ||classifications.some(row=>!ids.has(row.inputId)||!nonempty(row.reference)))
    refuse('ACCEPTED_INPUT_CLASSIFICATION_INCOMPLETE',selected.input.id);
  for(const row of classifications){
    cite(row.reference);
    if(row.inputId===selected.input.id?row.significance!=='selected':row.significance!=='neutral')
      refuse('ACCEPTED_INPUT_CHANGES_CONTROL_CUSTODY_OR_ORDER',row.inputId,row.reference);
  }
  const fifo=interval.fifo;
  if(!fifo.complete||!nonempty(fifo.reference)||fifo.selectedInputId!==selected.input.id)
    refuse('ACTUAL_FIFO_WITNESS_MISSING',selected.input.id);
  else if(fifo.runnablePredecessorInputIds.length)
    refuse('RUNNABLE_FIFO_PREDECESSOR_PRESENT',fifo.reference,...fifo.runnablePredecessorInputIds);
  else cite(fifo.reference);
  const snapshotDigest=acceptedBindingSnapshotDigest(snapshot);
  const identity={requestId:request.request_id,acceptedInputId:selected.input.id,runId:selected.turn.native_run_id,
    turnId:selected.turn.id,dispatchAttempt:selected.turn.dispatch_attempt,sourceInputId:source.input.id,
    sourceRunId:source.turn.native_run_id,creationInputId:creation.input.id,binding};
  const evidenceRefs=[...refs].sort();
  return {policy:'codex-accepted-binding-continuation-v1' as const,basis:'accepted_binding_continuation' as const,
    proven:reasons.length===0,diagnosticOnly:true as const,authorizesProviderStart:false as const,
    identity,snapshotDigest,evidenceRefs,reasons,
    decisionDigest:acceptedBindingSnapshotDigest({policy:'codex-accepted-binding-continuation-v1',
      basis:'accepted_binding_continuation',identity,snapshotDigest,evidenceRefs,reasons})};
}
