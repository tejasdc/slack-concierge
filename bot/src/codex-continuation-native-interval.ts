import {acceptedBindingSnapshotDigest,proveAcceptedBindingContinuation,
  type AcceptedBindingContinuationSnapshot,type ContinuationInput} from './codex-accepted-binding-continuation';
import {nativeResultEventId} from './native-result-identity';
import {revalidateCodexOriginalHistorySource,type CodexOriginalHistoryWitness,type CodexOriginalHistoryCustody} from './codex-original-history-coverage';

export interface CodexHistoryReadClient {
  request(method:'thread/turns/list'|'thread/items/list',params:Record<string,unknown>):Promise<any>;
}
interface Attempt {inputId:string;turnId:number;runId:string;dispatchAttempt:number;providerTurnId:string;evidenceRefs:string[]}
const parse=(value:string|null):any=>{try{return value===null?null:JSON.parse(value);}catch{return null;}};
const text=(value:unknown):value is string=>typeof value==='string'&&value.length>0;
class IntervalRefusal extends Error {
  constructor(readonly code:string,readonly evidence:string[]=[]){super(code);}
}
const fail=(code:string,...refs:string[]):never=>{throw new IntervalRefusal(code,refs);};

/** Resolve every attempt from immutable owner identities. Neither timestamps nor
 * message content participates. The legacy fallback requires the exact result,
 * attention, effort and retained delivery envelope used by the existing owner. */
function attemptsFor(snapshot:AcceptedBindingContinuationSnapshot,input:ContinuationInput):Attempt[] {
  const raw=snapshot.ownerSnapshot as any;
  const turn=raw.turns.find((row:any)=>row.id===input.turn_id);
  if(!turn||turn.session_id!==snapshot.binding.sessionId||turn.accepted_input_id!==input.id
    ||!text(turn.native_run_id)||!Number.isSafeInteger(turn.dispatch_attempt)||turn.dispatch_attempt<1
    ||!['done','parked'].includes(turn.status)||turn.provider_input_acknowledged_at!==null
    ||turn.stop_requested_at!==null||turn.owner_instance_id!=null)
    fail('OWNER_ATTEMPT_NOT_TERMINAL_UNACKNOWLEDGED',input.id);
  const events=snapshot.events.filter(event=>event.session_id===snapshot.binding.sessionId&&event.turn_id===turn.id);
  const exact=(kind:string,id:string,inputScoped=true)=>{
    const matches=events.filter(event=>event.kind===kind&&event.event_id===id&&(!inputScoped||event.input_id===input.id));
    return matches.length===1?matches[0]:null;
  };
  const attempts:Attempt[]=[];
  for(let index=1;index<=turn.dispatch_attempt;index++){
    const effortId=`prompt-cache-identity:${turn.id}:${index}`,effort=exact('prompt_cache_identity',effortId,false);
    if(!effort||parse(effort.payload_json)?.effort!==snapshot.binding.effort)
      fail('ATTEMPT_EFFECTIVE_EFFORT_NOT_PROVEN',input.id,effortId);
    const modernId=`provider-turn-attempt:${turn.id}:${index}`,modern=exact('provider_turn_attempt',modernId);
    const mapping=modern?parse(modern.payload_json):null;
    const resultId=nativeResultEventId(turn.id,index),resultEvent=exact('result',resultId);
    const result=resultEvent?parse(resultEvent.payload_json):null;
    let providerTurnId:string,evidenceRefs:string[];
    if(modern){
      if(mapping?.provider!=='codex'||mapping.dispatchAttempt!==index||!text(mapping.providerTurnId))
        fail('EXACT_PROVIDER_ATTEMPT_IDENTITY_INVALID',input.id,modernId);
      providerTurnId=mapping.providerTurnId;evidenceRefs=[modernId,effortId];
      if(result&&(result.providerTurnId!==providerTurnId||result.runId!==turn.native_run_id
        ||result.inputId!==input.id||result.sessionId!==snapshot.binding.sessionId||result.turnId!==turn.id
        ||result.sessionUUID!==snapshot.binding.threadId||result.model!==snapshot.binding.model
        ||result.dispatchAttempt!==undefined&&result.dispatchAttempt!==index))
        fail('RESULT_ATTEMPT_IDENTITY_CONFLICT',input.id,resultId);
    }else{
      const attentionId=`attention:${input.id}:${index}`,attentionEvent=exact('attention',attentionId);
      const attention=attentionEvent?parse(attentionEvent.payload_json):null;
      if(!resultEvent||!attentionEvent||attention?.dispatchAttempt!==index||result?.inputId!==input.id
        ||result.sessionId!==snapshot.binding.sessionId||result.turnId!==turn.id||result.runId!==turn.native_run_id
        ||result.sessionUUID!==snapshot.binding.threadId||result.model!==snapshot.binding.model
        ||!text(result.providerTurnId)||result.dispatchAttempt!==undefined&&result.dispatchAttempt!==index
        ||index!==turn.dispatch_attempt||result.providerTurnId!==turn.provider_turn_id)
        fail('LEGACY_ATTEMPT_IDENTITY_NOT_PROVEN',input.id,resultId,attentionId);
      const envelope=parse(turn.outbound_text);
      const {inputId:_inputId,sessionId:_sessionId,turnId:_turnId,runId:_runId,dispatchAttempt:_attempt,...providerResult}=result;
      if(envelope?.version!==1||!envelope.result||acceptedBindingSnapshotDigest(envelope.result)!==acceptedBindingSnapshotDigest(providerResult))
        fail('LEGACY_RESULT_ENVELOPE_NOT_PROVEN',input.id,resultId);
      providerTurnId=result.providerTurnId;evidenceRefs=[resultId,attentionId,effortId];
    }
    if(result&&(result.text!==''||!Array.isArray(result.toolsUsed)||result.toolsUsed.length!==0))
      fail('OWNER_RESULT_HAS_CONVERSATIONAL_OR_TOOL_EFFECT',input.id,resultId);
    const admissionEvent=exact('provider_admission',`provider_admission:${turn.id}:${index}`);
    const admitted=admissionEvent?parse(admissionEvent.payload_json):null;
    if(admitted&&(admitted.dispatchAttempt!==index||admitted.admission?.inputId!==input.id
      ||admitted.admission?.runId!==turn.native_run_id||admitted.admission?.provider!=='codex'
      ||admitted.admission?.model!==snapshot.binding.model||admitted.admission?.bindingGeneration!==snapshot.binding.generation
      ||admitted.admission?.reasoningEffort!==undefined&&admitted.admission.reasoningEffort!==snapshot.binding.effort))
      fail('OWNER_ADMISSION_BINDING_CONFLICT',input.id,admissionEvent!.event_id);
    attempts.push({inputId:input.id,turnId:turn.id,runId:turn.native_run_id,dispatchAttempt:index,providerTurnId,evidenceRefs});
  }
  if(events.some(event=>event.kind==='provider_turn_attempt'
    &&!attempts.some(attempt=>event.event_id===`provider-turn-attempt:${turn.id}:${attempt.dispatchAttempt}`)))
    fail('OWNER_ATTEMPT_MAPPING_INCOMPLETE',input.id);
  return attempts;
}

function validateOwnerInterval(snapshot:AcceptedBindingContinuationSnapshot):Attempt[] {
  const basis=proveAcceptedBindingContinuation(snapshot);
  if(!basis.proven)fail('ACCEPTED_BINDING_CONTINUATION_NOT_PROVEN',...basis.reasons.map(reason=>reason.code));
  const raw=snapshot.ownerSnapshot as any;
  if(!raw||!Array.isArray(raw.turns)||!Array.isArray(raw.requests)||!Array.isArray(raw.steering)
    ||!Array.isArray(raw.deliveries)||!Array.isArray(raw.predecessors)||!Array.isArray(raw.active))
    fail('COMPLETE_OWNER_INTERVAL_ROWS_MISSING');
  if(raw.predecessors.length||raw.active.length)fail('OWNER_QUEUE_PRECEDENCE_OR_ACTIVE_TURN_PRESENT');
  const inputs=snapshot.interval.inputs,turnIds=new Set(inputs.map(row=>row.turn_id).filter(id=>id!==null));
  if(raw.steering.some((row:any)=>turnIds.has(row.turn_id)))fail('INTERVAL_STEERING_REQUIRES_RECONCILIATION');
  if(raw.deliveries.some((row:any)=>turnIds.has(row.turn_id)))fail('INTERVAL_PRODUCT_DELIVERY_PRESENT');
  const attempts:Attempt[]=[];
  for(const input of inputs){
    if(input.steering_id!==null)fail('ACCEPTED_STEERING_NOT_NEUTRAL',input.id);
    if(input.id!==snapshot.selected.input.id){
      const matches=raw.requests.filter((request:any)=>request.target_session_id===snapshot.binding.sessionId
        &&(request.target_input_id===input.id||input.origin==='service'&&input.id===`report-back:${request.request_id}`
          &&input.request_id===request.request_id));
      const request=matches.length===1?matches[0]:null;
      if(!request||parse(request.payload_json)?.requestedEffect!=='informational'||request.outcome===null
        ||input.origin==='human'||!['input','request','consultation'].includes(input.kind))
        fail('LATER_INPUT_NOT_CLOSED_CANONICAL_INFORMATIONAL',input.id);
    }
    if(input.turn_id===null){
      if(!['failed','completed','cancelled','withdrawn'].includes(parse(input.receipt_json)?.state)
        ||snapshot.events.some(event=>event.input_id===input.id&&['provider_turn_attempt','provider_admission','result'].includes(event.kind)))
        fail('NEVER_ADMITTED_INFORMATIONAL_TERMINAL_PROOF_MISSING',input.id);
      continue;
    }
    attempts.push(...attemptsFor(snapshot,input));
  }
  if(new Set(attempts.map(attempt=>attempt.providerTurnId)).size!==attempts.length)
    fail('NATIVE_ATTEMPT_IDENTITY_REUSED');
  return attempts;
}

async function pages(client:CodexHistoryReadClient,method:'thread/turns/list'|'thread/items/list',params:Record<string,unknown>) {
  const rows:any[]=[],cursors=new Set<string>();let cursor:string|null=null;
  do {
    const page=await client.request(method,{...params,cursor});
    if(!page||!Array.isArray(page.data)||!Object.hasOwn(page,'nextCursor')
      ||page.nextCursor!==null&&!text(page.nextCursor)||page.hasMore===true&&page.nextCursor===null
      ||page.hasMore===false&&page.nextCursor!==null)
      fail('NATIVE_HISTORY_PAGE_INCOMPLETE',method);
    rows.push(...page.data);
    cursor=page.nextCursor;
    if(cursor){if(cursors.has(cursor))fail('NATIVE_HISTORY_CURSOR_LOOP',method);cursors.add(cursor);}
  }while(cursor!==null);
  return rows;
}

/** Read complete projected turn/item pages under a caller-held native thread
 * fence. This module performs no resume, start, compaction, unload or mutation.
 * This projection is not a lossless original-effect history certificate: native
 * migration/materialization can omit records. Activation independently refuses
 * NATIVE_ORIGINAL_EFFECT_HISTORY_COVERAGE_UNPROVEN until an owned source witness
 * fills that predicate. The returned digest also requires that same held fence. */
export async function proveCodexContinuationNativeInterval(input:{snapshot:AcceptedBindingContinuationSnapshot;client:CodexHistoryReadClient}) {
  const continuation=proveAcceptedBindingContinuation(input.snapshot);
  try {
    const attempts=validateOwnerInterval(input.snapshot),threadId=input.snapshot.binding.threadId;
    const params={threadId,limit:50,sortDirection:'asc',itemsView:'notLoaded'};
    const nativeTurns=await pages(input.client,'thread/turns/list',params);
    if(nativeTurns.some(turn=>!text(turn?.id))||new Set(nativeTurns.map(turn=>turn.id)).size!==nativeTurns.length)
      fail('NATIVE_TURN_IDENTITY_INVALID');
    const positions=new Map(nativeTurns.map((turn,index)=>[turn.id,index]));
    for(const attempt of attempts)if(!positions.has(attempt.providerTurnId))
      fail('MAPPED_NATIVE_ATTEMPT_ABSENT',attempt.inputId,attempt.providerTurnId);
    const selected=attempts.filter(attempt=>attempt.inputId===input.snapshot.selected.input.id);
    if(!selected.length)fail('SELECTED_ATTEMPTS_MISSING');
    for(const accepted of input.snapshot.interval.inputs){
      const owned=attempts.filter(attempt=>attempt.inputId===accepted.id);
      if(owned.some((attempt,index)=>index>0&&positions.get(attempt.providerTurnId)!<=positions.get(owned[index-1]!.providerTurnId)!))
        fail('NATIVE_ATTEMPT_ORDER_CONFLICT',accepted.id);
    }
    const start=Math.min(...selected.map(attempt=>positions.get(attempt.providerTurnId)!));
    if(attempts.some(attempt=>positions.get(attempt.providerTurnId)!<start))fail('ACCEPTED_NATIVE_INTERVAL_ORDER_CONFLICT');
    const byNativeId=new Map(attempts.map(attempt=>[attempt.providerTurnId,attempt]));
    const suffix=nativeTurns.slice(start),coverage:Array<{providerTurnId:string;inputId:string;dispatchAttempt:number;
      classification:'empty'|'independent_compaction';itemCount:number;itemsDigest:string}>=[];
    for(const nativeTurn of suffix){
      const owner=byNativeId.get(nativeTurn.id);
      if(!owner)fail('UNMAPPED_NATIVE_SUFFIX_TURN',nativeTurn.id);
      if(nativeTurn.status!=='completed'||nativeTurn.error!=null)fail('NATIVE_ATTEMPT_NOT_SUCCESSFULLY_TERMINAL',nativeTurn.id);
      const entries=await pages(input.client,'thread/items/list',{threadId,turnId:nativeTurn.id,limit:100,sortDirection:'asc'});
      if(entries.some(entry=>entry?.turnId!==nativeTurn.id||!entry.item||!text(entry.item.id)||!text(entry.item.type))
        ||new Set(entries.map(entry=>entry.item.id)).size!==entries.length)
        fail('EXACT_NATIVE_TURN_ITEM_COVERAGE_INVALID',nativeTurn.id);
      const items=entries.map(entry=>entry.item),isSelected=owner.inputId===input.snapshot.selected.input.id;
      const clientId=`slack-concierge:turn:${owner.turnId}:attempt:${owner.dispatchAttempt}`;
      if(items.some(item=>item.type==='userMessage'&&item.clientId===clientId))
        fail('EXACT_ACCEPTED_INPUT_ACKNOWLEDGED',owner.inputId,nativeTurn.id);
      // A provider-generated user/context item without our client ID is not an
      // acknowledgement. It still prevents claiming this interval was empty.
      if(items.some(item=>item.type==='userMessage'))fail('NATIVE_USER_CONTEXT_COVERAGE_UNCERTAIN',owner.inputId,nativeTurn.id);
      const compactionOnly=items.length>0&&items.every(item=>['contextCompaction','context_compaction'].includes(item.type));
      if(items.length>0&&(isSelected||!compactionOnly))fail('NATIVE_CONVERSATIONAL_TOOL_OR_UNKNOWN_ITEM_PRESENT',owner.inputId,nativeTurn.id);
      coverage.push({providerTurnId:nativeTurn.id,inputId:owner.inputId,dispatchAttempt:owner.dispatchAttempt,
        classification:compactionOnly?'independent_compaction':'empty',itemCount:items.length,itemsDigest:acceptedBindingSnapshotDigest(entries)});
    }
    // Complete repeat of the ordered list catches activity that appeared during
    // item reads; the caller's fence supplies exclusion through actual dispatch.
    const finalTurns=await pages(input.client,'thread/turns/list',params);
    if(acceptedBindingSnapshotDigest(finalTurns)!==acceptedBindingSnapshotDigest(nativeTurns))fail('NATIVE_WATERMARK_CHANGED_DURING_INSPECTION');
    const evidence={threadId,continuationDecisionDigest:continuation.decisionDigest,ownerSnapshotDigest:continuation.snapshotDigest,
      attempts,coverage,nativeTurnOrder:nativeTurns.map(turn=>turn.id),nativeWatermark:nativeTurns.at(-1)?.id??null};
    return {proven:true as const,diagnosticOnly:true as const,authorizesProviderStart:false as const,requiresHeldThreadFence:true as const,
      ...evidence,nativeDigest:acceptedBindingSnapshotDigest(evidence),reasons:[]};
  }catch(error){
    const refusal=error instanceof IntervalRefusal?error:new IntervalRefusal('NATIVE_HISTORY_READ_FAILED');
    return {proven:false as const,diagnosticOnly:true as const,authorizesProviderStart:false as const,
      requiresHeldThreadFence:true as const,continuationDecisionDigest:continuation.decisionDigest,
      ownerSnapshotDigest:continuation.snapshotDigest,reasons:[{code:refusal.code,evidence:refusal.evidence}]};
  }
}

/** Join the owner-worker's original-record witness to the projected native
 * identity proof. A caller cannot replace either with a completeness boolean. */
export function bindCodexOriginalHistoryCoverage(projected:Awaited<ReturnType<typeof proveCodexContinuationNativeInterval>>,
  original:{proven:true;witness:CodexOriginalHistoryWitness;custody:CodexOriginalHistoryCustody}|{proven:false;reasons:Array<{code:string}>}){
  if(!projected.proven)return projected;
  if(!original.proven)throw new Error(`Original native history refuses: ${original.reasons.map(reason=>reason.code).join(', ')}.`);
  const {witness,custody}=original;
  if(witness.threadId!==projected.threadId||witness.attemptsDigest!==acceptedBindingSnapshotDigest(projected.attempts)
    ||acceptedBindingSnapshotDigest(witness.nativeTurnOrder)!==acceptedBindingSnapshotDigest(projected.coverage.map(item=>item.providerTurnId))
    ||!revalidateCodexOriginalHistorySource(custody,witness).valid)
    throw new Error('Original native source and projected attempt interval do not match the same unchanged source.');
  const originalHistory={witness,custody};
  const evidence={threadId:projected.threadId,continuationDecisionDigest:projected.continuationDecisionDigest,
    ownerSnapshotDigest:projected.ownerSnapshotDigest,attempts:projected.attempts,coverage:projected.coverage,
    nativeTurnOrder:projected.nativeTurnOrder,nativeWatermark:projected.nativeWatermark,originalHistory};
  return {...projected,originalHistory,nativeDigest:acceptedBindingSnapshotDigest(evidence)};
}
