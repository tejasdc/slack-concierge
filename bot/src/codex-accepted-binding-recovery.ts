import {db,executionChanged,codexUnacknowledgedRecovery} from './state';
import {inspectAcceptedBindingContinuation} from './codex-accepted-binding-snapshot';
import {acceptedBindingSnapshotDigest} from './codex-accepted-binding-continuation';
import {proveCodexContinuationNativeInterval,bindCodexOriginalHistoryCoverage,type CodexHistoryReadClient} from './codex-continuation-native-interval';
import {revalidateCodexOriginalHistorySource,type readCodexOriginalHistoryCoverage} from './codex-original-history-coverage';
import {acquireCodexThreadMutationFence} from './codex-mutation-fence';
import {grantCodexRecoveryAuthorization} from './codex-recovery-dispatch-authorization';
import {assessManagedCodexWriterCoverage} from './codex-managed-process-registry';
import {RETRYING_PROVIDER_TURN_STATUS_TEXT} from './text';
import type {OwnerContextCandidate} from './codex-owner-context-diagnostic';
import {requireRecoveryHistoryPolicy,type CodexRecoveryHistoryPolicy} from './codex-state-preserving-recovery';

/** Owner-internal host evidence adapter. Tests supply process identities, never
 * a caller's claim that writers are covered. Production uses the real host. */
export interface CodexRecoveryHostDependencies {
  writerProc?:Parameters<typeof assessManagedCodexWriterCoverage>[0]['proc'];
  diagnosticContextCandidates?:readonly OwnerContextCandidate[];
  readOriginalHistory?:(input:{sessionId:number;inputId:string;requestId:string;runId:string;fenceId:string;
    expectedDecisionDigest:string;expectedNativeDigest:string;diagnosticContextCandidates?:readonly OwnerContextCandidate[]})=>Promise<Awaited<ReturnType<typeof readCodexOriginalHistoryCoverage>> &
      {coldConstruction?:import('./codex-cold-construction').CodexColdConstructionWitness}>;
}

/** The owner supplies only its already-authorized request identity and read-only
 * native client. No external caller can furnish a proof or a grant boolean. */
export async function recoverAcceptedBindingCodex(input:{sessionId:number;inputId:string;requestId:string;
  actionId:string;sourceInputId:string;sourceRunId:string;socketPath:string;client:CodexHistoryReadClient&{
    request(method:string,params:Record<string,unknown>):Promise<any>};validateSource:()=>void;
  expectedDecisionDigest:string;historyPolicy?:CodexRecoveryHistoryPolicy},dependencies:CodexRecoveryHostDependencies={}){
  // Predictably unsupported construction must not acquire a fence, prepare
  // staging, read a provider, reserve recovery or spend its unique attempt.
  requireRecoveryHistoryPolicy(input.historyPolicy);
  const prior=codexUnacknowledgedRecovery(input.inputId);
  if(prior)return retained(prior);
  const inspection=inspectAcceptedBindingContinuation({...input,includeSnapshot:true});
  if(!inspection.proven||!('snapshot'in inspection)||!inspection.snapshot)
    throw new Error(`Accepted binding continuation refuses: ${inspection.reasons.map(reason=>reason.code).join(', ')}.`);
  if(inspection.decisionDigest!==input.expectedDecisionDigest)throw new Error('The accepted continuation changed before its execution fence.');
  const snapshot=inspection.snapshot,binding=snapshot.binding;
  const writers=assessManagedCodexWriterCoverage({db,threadId:binding.threadId,socketPath:input.socketPath,proc:dependencies.writerProc});
  if(!writers.covered)throw new Error(`Managed native writer coverage refuses: ${writers.blockers.map(item=>`${item.code}${item.pid?`:${item.pid}`:''}`).join(', ')}.`);
  const fenceId=`codex-recovery:${input.inputId}`;
  input.validateSource();
  const fence=acquireCodexThreadMutationFence(db,{fenceId,threadId:binding.threadId,
    acceptedInputId:input.inputId,runId:snapshot.selected.turn.native_run_id!,
    dispatchAttempt:snapshot.selected.turn.dispatch_attempt+1,bindingDigest:acceptedBindingSnapshotDigest(binding),nowMs:Date.now()});
  if(!fence.acquired)throw new Error(`Native mutation fence refuses: ${fence.reason}.`);
  const readThread=async()=>{
    const response=await input.client.request('thread/read',{threadId:binding.threadId,includeTurns:false});
    const thread=response?.thread;
    if(thread?.id!==binding.threadId||thread.model!==binding.model||thread.reasoningEffort!==binding.effort)
      throw new Error('The current native model, effort or conversation differs from its accepted binding.');
    if(thread.historyMode!=='paginated')throw new Error('Complete native history coverage across compaction is not proven by this history mode.');
    if(thread.status?.type!=='notLoaded')throw new Error('The native conversation is warm without current hook activation proof; no recovery input was sent.');
    return {id:thread.id,model:thread.model,effort:thread.reasoningEffort,historyMode:thread.historyMode,status:thread.status.type};
  };
  const cold=await readThread();
  const projected=await proveCodexContinuationNativeInterval({snapshot,client:input.client});
  if(!projected.proven)throw new Error(`Projected native interval refuses: ${projected.reasons.map(reason=>reason.code).join(', ')}.`);
  if(!dependencies.readOriginalHistory)throw new Error('NATIVE_ORIGINAL_EFFECT_HISTORY_COVERAGE_UNPROVEN: original source reader is unavailable.');
  const original=await dependencies.readOriginalHistory({sessionId:input.sessionId,inputId:input.inputId,requestId:input.requestId,
    runId:snapshot.selected.turn.native_run_id!,fenceId,expectedDecisionDigest:inspection.decisionDigest,expectedNativeDigest:projected.nativeDigest,
    ...(dependencies.diagnosticContextCandidates?{diagnosticContextCandidates:dependencies.diagnosticContextCandidates}:{})});
  const native=bindCodexOriginalHistoryCoverage(projected,original);
  if(!native.proven)throw new Error(`Original native history coverage refuses: ${native.reasons.map(reason=>reason.code).join(', ')}.`);
  if(!('originalHistory'in native))throw new Error('NATIVE_ORIGINAL_EFFECT_HISTORY_COVERAGE_UNPROVEN');
  if(acceptedBindingSnapshotDigest(await readThread())!==acceptedBindingSnapshotDigest(cold))
    throw new Error('Native cold-resume eligibility changed during inspection.');
  if(!original.proven||!original.coldConstruction)throw new Error('COLD_CONSTRUCTION_WITNESS_NOT_RETAINED');
  const selectedAttempts=native.attempts.filter(attempt=>attempt.inputId===input.inputId);
  const {snapshot:_privateSnapshot,...continuation}=inspection;
  const proof={provider:'codex',threadId:binding.threadId,ownerRunId:snapshot.selected.turn.native_run_id,
    ownerTurnId:snapshot.selected.turn.id,acceptedInputId:input.inputId,
    dispatchAttemptCount:snapshot.selected.turn.dispatch_attempt,attempts:selectedAttempts,
    continuation,native,coldResume:{...cold,construction:original.coldConstruction},managedWriters:writers};
  const reservation=db.transaction(()=>{
    const raced=codexUnacknowledgedRecovery(input.inputId);
    if(raced)return {row:raced,created:false};
    input.validateSource();
    const current=inspectAcceptedBindingContinuation({...input,includeSnapshot:false});
    if(!current.proven||!('decisionDigest'in current)||current.decisionDigest!==inspection.decisionDigest)
      throw new Error('Accepted input watermark, source custody, controls, binding or attempts changed before atomic reservation.');
    const currentWriters=assessManagedCodexWriterCoverage({db,threadId:binding.threadId,socketPath:input.socketPath,proc:dependencies.writerProc});
    if(!currentWriters.covered)throw new Error('Managed writer coverage changed before atomic reservation.');
    if(!revalidateCodexOriginalHistorySource(native.originalHistory.custody,native.originalHistory.witness).valid)
      throw new Error('NATIVE_ORIGINAL_EFFECT_HISTORY_SOURCE_CHANGED before atomic reservation.');
    db.query(`INSERT INTO codex_unacknowledged_recoveries(accepted_input_id,request_id,turn_id,provider_thread_id,
      proof_json,action_id,source_input_id,source_run_id,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(input.inputId,input.requestId,snapshot.selected.turn.id,binding.threadId,JSON.stringify(proof),
        input.actionId,input.sourceInputId,input.sourceRunId,Date.now());
    const changed=db.query(`UPDATE turns SET status='queued',owner_instance_id=NULL,agent_text=NULL,outbound_text=NULL,
      reasoning_effort=?,ended_at=NULL,dispatch_failure_class='backoff',dispatch_next_attempt_ms=?,
      provider_admission_intended_at=NULL,provider_started_at=NULL,provider_turn_id=NULL,provider_input_acknowledged_at=NULL,
      status_desired_text=?,status_desired_revision=status_desired_revision+1,status_projection_status='not_needed',
      status_projection_attempts=0,status_projection_error=NULL,status_projection_next_attempt_ms=0,status_projection_parked_at=NULL
      WHERE id=? AND accepted_input_id=? AND native_run_id=? AND dispatch_attempt=? AND status IN ('done','parked')
        AND owner_instance_id IS NULL AND stop_requested_at IS NULL RETURNING id`)
      .get(binding.effort,Date.now(),RETRYING_PROVIDER_TURN_STATUS_TEXT,snapshot.selected.turn.id,input.inputId,
        snapshot.selected.turn.native_run_id,snapshot.selected.turn.dispatch_attempt);
    if(!changed)throw new Error('The exact accepted continuation lost its failed turn before reservation.');
    db.query("UPDATE sessions SET status='idle' WHERE id=? AND status IN ('idle','error')").run(input.sessionId);
    const authorized=grantCodexRecoveryAuthorization(db,{acceptedInputId:input.inputId,fenceId,nowMs:Date.now()});
    if(!authorized.allowed)throw new Error(`Recovery authorization refuses: ${authorized.reason}.`);
    return {row:codexUnacknowledgedRecovery(input.inputId)!,created:true};
  }).immediate();
  executionChanged();
  return {...retained(reservation.row),status:reservation.created?'requeued' as const:'already_recovered' as const};
}
function retained(row:NonNullable<ReturnType<typeof codexUnacknowledgedRecovery>>){
  const proof=JSON.parse(row.proof_json);
  return {status:'already_recovered' as const,runId:proof.ownerRunId,
    providerTurnIds:(proof.attempts??[]).map((attempt:any)=>attempt.providerTurnId)};
}
