import {createHash} from 'node:crypto';
import {acceptedBindingSnapshotDigest as digest,type AcceptedBindingContinuationSnapshot,type ContinuationBinding} from './codex-accepted-binding-continuation';
import type {CodexOriginalHistoryAttempt} from './codex-original-history-coverage';

export const CODEX_OWNER_CONTEXT_KEY='slack-concierge';
export const OWNER_CONTEXT_INTERPRETATION='native_0162_owner_application_preimage_v1' as const;
export type OwnerContextCandidate={inputId:string;turnId:number;runId:string;dispatchAttempt:number;providerTurnId:string;value:string};
type Commitment=Omit<OwnerContextCandidate,'value'>&{eventId:string;eventDigest:string;expectedSha256:string;value:string};
/** Private comparison inputs only. Production builds this from its fresh owner
 * snapshot; static adapters must keep their conditional evidence status. */
export type OwnerContextDiagnosticEvidence={policy:'owner_context_diagnostic_evidence_v1';
  status:'owner_snapshot'|'conditional_retained_adapter';bindingDigest:string;selectedInputId:string;
  ownerSnapshotDigest:string;attemptsDigest:string;commitments:Commitment[]};
const parse=(s:string)=>{try{return JSON.parse(s);}catch{return null;}};
const object=(v:any)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const closed=(v:any,keys:string[])=>object(v)&&Object.keys(v).every(k=>keys.includes(k));
export class OwnerContextRefusal extends Error {constructor(readonly code:string){super(code);}}
const fail=(code:string):never=>{throw new OwnerContextRefusal(code);};
export const ownerContextRawSha256=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');

/** Resolve the expected commitment independently of candidate bytes. Existing
 * native proof supplies admission/result/attempt links; recheck their exact rows
 * here so null event input IDs never act as cross-turn or cross-run wildcards. */
export function resolveOwnerContextDiagnosticEvidence(input:{snapshot:AcceptedBindingContinuationSnapshot;
  attempts:readonly CodexOriginalHistoryAttempt[];candidates:readonly OwnerContextCandidate[];
  status:OwnerContextDiagnosticEvidence['status']}):OwnerContextDiagnosticEvidence{
  const {snapshot,attempts,candidates}=input,raw=snapshot.ownerSnapshot as any;
  if(!raw||!Array.isArray(raw.turns)||!Array.isArray(snapshot.events)||!Array.isArray(snapshot.interval?.inputs)||!Array.isArray(candidates)
    ||!['owner_snapshot','conditional_retained_adapter'].includes(input.status))fail('OWNER_CONTEXT_SNAPSHOT_INVALID');
  const commitments:Commitment[]=[];
  for(const candidate of candidates){
    if(!closed(candidate,['inputId','turnId','runId','dispatchAttempt','providerTurnId','value'])
      ||typeof candidate.value!=='string'||candidate.value.length===0
      ||new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(candidate.value,'utf8'))!==candidate.value)
      fail('OWNER_CONTEXT_CANDIDATE_INVALID');
    const matches=attempts.filter(a=>a.inputId===candidate.inputId&&a.turnId===candidate.turnId
      &&a.runId===candidate.runId&&a.dispatchAttempt===candidate.dispatchAttempt&&a.providerTurnId===candidate.providerTurnId);
    if(matches.length!==1)fail('OWNER_CONTEXT_ATTEMPT_CONFLICT');
    const attempt=matches[0],turns=raw.turns.filter((t:any)=>t.id===attempt.turnId);
    if(turns.length!==1||turns[0].session_id!==snapshot.binding.sessionId||turns[0].accepted_input_id!==attempt.inputId
      ||turns[0].native_run_id!==attempt.runId||turns[0].dispatch_attempt<attempt.dispatchAttempt
      ||!snapshot.interval.inputs.some(i=>i.id===attempt.inputId&&i.session_id===snapshot.binding.sessionId&&i.turn_id===attempt.turnId))
      fail('OWNER_CONTEXT_OWNER_JOIN_CONFLICT');
    const eventId=`prompt-cache-identity:${attempt.turnId}:${attempt.dispatchAttempt}`;
    if(snapshot.events.some(e=>e.kind==='prompt_cache_identity'&&e.turn_id===attempt.turnId
      &&!attempts.some(a=>a.turnId===attempt.turnId&&e.event_id===`prompt-cache-identity:${a.turnId}:${a.dispatchAttempt}`)))
      fail('OWNER_CONTEXT_EVENT_IDENTITY_CONFLICT');
    const events=snapshot.events.filter(e=>e.event_id===eventId);
    if(events.length!==1)fail('OWNER_CONTEXT_EVENT_NOT_UNIQUE');
    const event=events[0],p=parse(event.payload_json);
    if(event.session_id!==snapshot.binding.sessionId||event.turn_id!==attempt.turnId
      ||event.kind!=='prompt_cache_identity'||!attempt.evidenceRefs.includes(eventId)
      ||event.input_id!==null&&event.input_id!==attempt.inputId
      ||!closed(p,['systemInstructionsSha256','effort'])||p.effort!==snapshot.binding.effort
      ||typeof p.systemInstructionsSha256!=='string'||!/^[a-f0-9]{64}$/.test(p.systemInstructionsSha256))
      fail('OWNER_CONTEXT_EVENT_IDENTITY_CONFLICT');
    // Raw owner events have no run/operation column. A retained projection may
    // supply them, in which case even explicit null must agree, never wildcard.
    const extra=event as any;
    if(Object.hasOwn(extra,'runId')&&extra.runId!==attempt.runId
      ||Object.hasOwn(extra,'operationId')&&extra.operationId!==null&&extra.operationId!==attempt.inputId)
      fail('OWNER_CONTEXT_EVENT_IDENTITY_CONFLICT');
    if(commitments.some(c=>c.providerTurnId===attempt.providerTurnId))fail('OWNER_CONTEXT_CANDIDATE_NOT_UNIQUE');
    const {value,...identity}=candidate;
    commitments.push({...identity,eventId,eventDigest:digest(event),expectedSha256:p.systemInstructionsSha256,value});
  }
  return {policy:'owner_context_diagnostic_evidence_v1',status:input.status,bindingDigest:digest(snapshot.binding),
    selectedInputId:snapshot.selected.input.id,ownerSnapshotDigest:digest(raw),attemptsDigest:digest(attempts),commitments};
}

/** Pinned context-fragments Application renderer: 1000 approximate tokens,
 * four UTF-8 bytes each. Marker/wrapper are outside the content budget. */
export function renderOwnerApplicationContext(value:string):string{
  const bytes=Buffer.from(value,'utf8');let text=value;
  if(bytes.length>4000){
    let left=2000,right=bytes.length-2000;
    while((bytes[left]&0xc0)===0x80)left--;
    while((bytes[right]&0xc0)===0x80)right++;
    text=bytes.subarray(0,left).toString('utf8')+`…${Math.ceil((bytes.length-4000)/4)} tokens truncated…`+bytes.subarray(right).toString('utf8');
  }
  return `<${CODEX_OWNER_CONTEXT_KEY}>${text}</${CODEX_OWNER_CONTEXT_KEY}>`;
}

export function verifyOwnerContextOccurrence(input:{evidence:OwnerContextDiagnosticEvidence;binding:ContinuationBinding;
  selectedInputId:string;attempts:readonly CodexOriginalHistoryAttempt[];nativeTurnId:string;payload:any;metadata:any}){
  const {evidence,payload:p,metadata:m}=input;
  if(evidence.policy!=='owner_context_diagnostic_evidence_v1'||!['owner_snapshot','conditional_retained_adapter'].includes(evidence.status)
    ||evidence.bindingDigest!==digest(input.binding)||evidence.selectedInputId!==input.selectedInputId
    ||evidence.attemptsDigest!==digest(input.attempts))fail('OWNER_CONTEXT_EVIDENCE_BINDING_CONFLICT');
  const matches=evidence.commitments.filter(c=>c.providerTurnId===input.nativeTurnId);
  if(matches.length!==1)fail('OWNER_CONTEXT_COMMITMENT_MISSING_OR_CONFLICTING');
  const c=matches[0];
  if(!input.attempts.some(a=>a.inputId===c.inputId&&a.turnId===c.turnId&&a.runId===c.runId
    &&a.dispatchAttempt===c.dispatchAttempt&&a.providerTurnId===c.providerTurnId))fail('OWNER_CONTEXT_ATTEMPT_CONFLICT');
  if(ownerContextRawSha256(c.value)!==c.expectedSha256)fail('OWNER_CONTEXT_FULL_PREIMAGE_MISMATCH');
  const passthrough=p?.internal_chat_message_metadata_passthrough;
  if(!closed(p,['type','id','role','content','phase','internal_chat_message_metadata_passthrough'])
    ||p.type!=='message'||p.role!=='developer'||p.phase!=null||!Array.isArray(p.content)||p.content.length!==1
    ||!closed(p.content[0],['type','text'])||p.content[0].type!=='input_text'||typeof p.content[0].text!=='string'
    ||!closed(passthrough,['turn_id','create_time','content_item_kinds'])||passthrough.turn_id!==input.nativeTurnId
    ||!Array.isArray(passthrough.content_item_kinds)||passthrough.content_item_kinds.length!==1
    ||passthrough.content_item_kinds[0]!==`additional_content.${CODEX_OWNER_CONTEXT_KEY}`
    ||m!=null)fail('OWNER_CONTEXT_NATIVE_ENVELOPE_UNSUPPORTED');
  const rendered=renderOwnerApplicationContext(c.value);
  if(p.content[0].text!==rendered)fail('OWNER_CONTEXT_RENDER_MISMATCH');
  const {value:_private,...commitment}=c;
  return {interpretation:OWNER_CONTEXT_INTERPRETATION,evidenceStatus:evidence.status,
    ownerSnapshotDigest:evidence.ownerSnapshotDigest,commitment,
    preimageBytes:Buffer.byteLength(c.value),renderedSha256:ownerContextRawSha256(rendered),renderedBytes:Buffer.byteLength(rendered),
    key:CODEX_OWNER_CONTEXT_KEY,materiality:'unassessed' as const,omittedMiddleVisibility:'not_established' as const,
    contextMapAndEmissionCause:'not_established' as const};
}
