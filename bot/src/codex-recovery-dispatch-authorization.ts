import type {Database} from 'bun:sqlite';
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {acceptedBindingSnapshotDigest as digest} from './codex-accepted-binding-continuation';
import {getCodexThreadMutationFence,grantCodexMutationPermit,consumeCodexMutationPermit,
  recordCodexMutationResponse,reconcileCodexMutationIntent,stopCodexThreadMutationFence} from './codex-mutation-fence';
import {EARLIER_TURN_BLOCKS_SQL,queuePrecedesSql} from './state';
import {revalidateCodexOriginalHistorySource} from './codex-original-history-coverage';
import {recoveryProofHistoryRefusal} from './codex-state-preserving-recovery';
import {compareCodexColdConstructionWitnesses,validateCodexColdResumeParameters,validateCodexColdResume,
  isCodexColdConstructionWitness,type CodexColdConstructionWitness} from './codex-cold-construction';
export type CodexRecoveryColdConstructionReceipt=Extract<ReturnType<typeof validateCodexColdResume>,{allowed:true}>['receipt'];

const parse=(json:string|null):any=>{try{return json===null?null:JSON.parse(json);}catch{return null;}};
const hash=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const isDigest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const exists=(value:unknown):value is string=>typeof value==='string'&&value.length>0;
class Refusal extends Error {constructor(readonly code:string){super(code);}}
function requireProof(condition:unknown,code:string):asserts condition {if(!condition)throw new Refusal(code);}

/** Explicit initializer, called only from the canonical schema owner. */
export function initializeCodexRecoveryAuthorizationSchema(db:Database){
  db.exec(`CREATE TABLE IF NOT EXISTS codex_recovery_dispatch_authorizations (
    authorization_id TEXT PRIMARY KEY,accepted_input_id TEXT NOT NULL UNIQUE,
    session_id INTEGER NOT NULL,turn_id INTEGER NOT NULL,run_id TEXT NOT NULL,dispatch_attempt INTEGER NOT NULL,
    fence_id TEXT NOT NULL,thread_id TEXT NOT NULL,binding_json TEXT NOT NULL,
    continuation_digest TEXT NOT NULL,native_digest TEXT NOT NULL,proof_digest TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,baseline_admissions_json TEXT NOT NULL,evidence_refs_json TEXT NOT NULL,
    capability_hash TEXT,capability_claimed_at_ms INTEGER,resume_permit_id TEXT UNIQUE,start_permit_id TEXT UNIQUE,
    prompt_digest TEXT,start_params_digest TEXT,hook_invocation_id TEXT,provider_turn_id TEXT,
    created_at_ms INTEGER NOT NULL,
    FOREIGN KEY(accepted_input_id) REFERENCES codex_unacknowledged_recoveries(accepted_input_id),
    FOREIGN KEY(fence_id) REFERENCES codex_thread_mutation_fences(fence_id),
    CHECK(dispatch_attempt>0),CHECK((capability_hash IS NULL)=(capability_claimed_at_ms IS NULL)));
    CREATE TABLE IF NOT EXISTS codex_recovery_authorization_audit (
      audit_id TEXT PRIMARY KEY,authorization_id TEXT,accepted_input_id TEXT,run_id TEXT,dispatch_attempt INTEGER,
      thread_id TEXT,provider_turn_id TEXT,invocation_id TEXT,phase TEXT NOT NULL,
      allowed INTEGER NOT NULL CHECK(allowed IN (0,1)),reason TEXT NOT NULL,
      basis TEXT NOT NULL CHECK(basis='accepted_binding_continuation'),
      continuation_digest TEXT,native_digest TEXT,source_fingerprint TEXT,
      policy TEXT NOT NULL,binding_generation INTEGER,bound_model TEXT,bound_effort TEXT,
      actual_model TEXT,actual_configured_effort TEXT,observed_effort TEXT,evidence_refs_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS codex_recovery_terminal_settlements (
      accepted_input_id TEXT PRIMARY KEY,authorization_id TEXT NOT NULL UNIQUE,
      terminal_event_id TEXT NOT NULL UNIQUE,terminal_event_digest TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,provider_turn_id TEXT NOT NULL,run_id TEXT NOT NULL,dispatch_attempt INTEGER NOT NULL,
      result_json TEXT NOT NULL,created_at_ms INTEGER NOT NULL,
      FOREIGN KEY(authorization_id) REFERENCES codex_recovery_dispatch_authorizations(authorization_id));
    CREATE TRIGGER IF NOT EXISTS codex_recovery_terminal_no_update BEFORE UPDATE ON codex_recovery_terminal_settlements
      BEGIN SELECT RAISE(ABORT,'recovery terminal settlement is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS codex_recovery_terminal_no_delete BEFORE DELETE ON codex_recovery_terminal_settlements
      BEGIN SELECT RAISE(ABORT,'recovery terminal settlement is immutable'); END;
    CREATE TABLE IF NOT EXISTS codex_recovery_source_checkpoints (
      authorization_id TEXT PRIMARY KEY,original_witness_digest TEXT NOT NULL,resume_intent_id TEXT NOT NULL UNIQUE,
      witness_json TEXT NOT NULL,custody_json TEXT NOT NULL,checkpoint_digest TEXT NOT NULL,created_at_ms INTEGER NOT NULL,
      FOREIGN KEY(authorization_id) REFERENCES codex_recovery_dispatch_authorizations(authorization_id));
    CREATE TRIGGER IF NOT EXISTS codex_recovery_source_checkpoint_no_update BEFORE UPDATE ON codex_recovery_source_checkpoints
      BEGIN SELECT RAISE(ABORT,'recovery source checkpoint is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS codex_recovery_source_checkpoint_no_delete BEFORE DELETE ON codex_recovery_source_checkpoints
      BEGIN SELECT RAISE(ABORT,'recovery source checkpoint is immutable'); END;
    CREATE TABLE IF NOT EXISTS codex_recovery_cold_inputs (
      authorization_id TEXT PRIMARY KEY,witness_json TEXT NOT NULL,params_digest TEXT NOT NULL,
      inputs_digest TEXT NOT NULL,created_at_ms INTEGER NOT NULL,
      FOREIGN KEY(authorization_id) REFERENCES codex_recovery_dispatch_authorizations(authorization_id));
    CREATE TRIGGER IF NOT EXISTS codex_recovery_cold_inputs_no_update BEFORE UPDATE ON codex_recovery_cold_inputs
      BEGIN SELECT RAISE(ABORT,'recovery cold inputs are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS codex_recovery_cold_inputs_no_delete BEFORE DELETE ON codex_recovery_cold_inputs
      BEGIN SELECT RAISE(ABORT,'recovery cold inputs are immutable'); END;
    CREATE TABLE IF NOT EXISTS codex_recovery_cold_constructions (
      authorization_id TEXT PRIMARY KEY,receipt_json TEXT NOT NULL,receipt_digest TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      FOREIGN KEY(authorization_id) REFERENCES codex_recovery_dispatch_authorizations(authorization_id));
    CREATE TRIGGER IF NOT EXISTS codex_recovery_cold_construction_no_update BEFORE UPDATE ON codex_recovery_cold_constructions
      BEGIN SELECT RAISE(ABORT,'recovery cold construction is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS codex_recovery_cold_construction_no_delete BEFORE DELETE ON codex_recovery_cold_constructions
      BEGIN SELECT RAISE(ABORT,'recovery cold construction is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS codex_recovery_audit_no_update BEFORE UPDATE ON codex_recovery_authorization_audit
      BEGIN SELECT RAISE(ABORT,'recovery authorization audit is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS codex_recovery_audit_no_delete BEFORE DELETE ON codex_recovery_authorization_audit
      BEGIN SELECT RAISE(ABORT,'recovery authorization audit is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS codex_recovery_authorization_identity_immutable BEFORE UPDATE ON codex_recovery_dispatch_authorizations
      WHEN NEW.authorization_id IS NOT OLD.authorization_id OR NEW.accepted_input_id IS NOT OLD.accepted_input_id
        OR NEW.session_id IS NOT OLD.session_id OR NEW.turn_id IS NOT OLD.turn_id OR NEW.run_id IS NOT OLD.run_id
        OR NEW.dispatch_attempt IS NOT OLD.dispatch_attempt OR NEW.fence_id IS NOT OLD.fence_id
        OR NEW.thread_id IS NOT OLD.thread_id OR NEW.binding_json IS NOT OLD.binding_json
        OR NEW.continuation_digest IS NOT OLD.continuation_digest OR NEW.native_digest IS NOT OLD.native_digest
        OR NEW.proof_digest IS NOT OLD.proof_digest OR NEW.source_fingerprint IS NOT OLD.source_fingerprint
        OR NEW.baseline_admissions_json IS NOT OLD.baseline_admissions_json
        OR NEW.evidence_refs_json IS NOT OLD.evidence_refs_json
        OR OLD.capability_hash IS NOT NULL AND NEW.capability_hash IS NOT OLD.capability_hash
        OR OLD.resume_permit_id IS NOT NULL AND NEW.resume_permit_id IS NOT OLD.resume_permit_id
        OR OLD.start_permit_id IS NOT NULL AND NEW.start_permit_id IS NOT OLD.start_permit_id
        OR OLD.prompt_digest IS NOT NULL AND NEW.prompt_digest IS NOT OLD.prompt_digest
        OR OLD.start_params_digest IS NOT NULL AND NEW.start_params_digest IS NOT OLD.start_params_digest
        OR OLD.hook_invocation_id IS NOT NULL AND NEW.hook_invocation_id IS NOT OLD.hook_invocation_id
        OR OLD.provider_turn_id IS NOT NULL AND NEW.provider_turn_id IS NOT OLD.provider_turn_id
      BEGIN SELECT RAISE(ABORT,'recovery authorization identity is immutable'); END;`);
}
const get=(db:Database,id:string)=>db.query('SELECT * FROM codex_recovery_dispatch_authorizations WHERE authorization_id=?').get(id) as any;
/** Safe internal dispatcher lookup; contains no capability or private prompt. */
export function getCodexRecoveryAuthorizationForInput(db:Database,inputId:string){
  const row=db.query('SELECT * FROM codex_recovery_dispatch_authorizations WHERE accepted_input_id=?').get(inputId) as any;
  if(!row)return null;
  const reservation=db.query('SELECT proof_json FROM codex_unacknowledged_recoveries WHERE accepted_input_id=?').get(inputId) as any;
  const refusal=recoveryProofHistoryRefusal(parse(reservation?.proof_json??null));
  if(refusal)throw new Error(refusal);
  const binding=parse(row.binding_json);
  return {authorizationId:row.authorization_id,model:binding.model,effort:binding.effort,
    status:row.start_permit_id?'start_bound':row.capability_hash?'claimed':'granted'};
}
function audit(db:Database,row:any,phase:string,allowed:boolean,reason:string,nowMs:number,hook?:any){
  const binding=parse(row?.binding_json??null);
  db.query(`INSERT INTO codex_recovery_authorization_audit(audit_id,authorization_id,accepted_input_id,run_id,
    dispatch_attempt,thread_id,provider_turn_id,invocation_id,phase,allowed,reason,basis,continuation_digest,native_digest,
    source_fingerprint,policy,binding_generation,bound_model,bound_effort,actual_model,actual_configured_effort,observed_effort,
    evidence_refs_json,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,'accepted_binding_continuation',?,?,?,
      ?,?,?,?,?,?,?,?,?)`)
    .run(randomUUID(),row?.authorization_id??null,row?.accepted_input_id??null,row?.run_id??null,row?.dispatch_attempt??null,
      row?.thread_id??hook?.providerSessionId??null,hook?.providerTurnId??row?.provider_turn_id??null,
      hook?.invocationId??null,phase,allowed?1:0,reason,row?.continuation_digest??null,row?.native_digest??null,
      row?.source_fingerprint??null,hook?.policy??'codex-recovery-dispatch-v1',binding?.generation??null,binding?.model??null,binding?.effort??null,
      hook?.actualModel??null,hook?.configuredEffort??null,hook?.observedEffort??null,
      JSON.stringify([...(parse(row?.evidence_refs_json??'[]')??[]),...(hook?.evidenceRefs??[])]),nowMs);
}
function operation<T extends object>(db:Database,id:string,phase:string,nowMs:number,work:(row:any)=>T,hook?:any):T|{allowed:false;reason:string}{
  return db.transaction(()=>{
    const row=get(db,id);
    try {
      requireProof(row,'RECOVERY_AUTHORIZATION_MISSING');
      const reservation=db.query('SELECT proof_json FROM codex_unacknowledged_recoveries WHERE accepted_input_id=?').get(row.accepted_input_id) as any;
      const refusal=recoveryProofHistoryRefusal(parse(reservation?.proof_json??null));
      requireProof(!refusal,refusal??'RECOVERY_HISTORY_POLICY_UNKNOWN');
      const result=work(row);audit(db,get(db,id),phase,true,hook?.allowReason??'EXACT_RECOVERY_CONTINUATION',nowMs,hook);return result;
    }catch(error){
      if(!(error instanceof Refusal))throw error;
      audit(db,row,phase,false,error.code,nowMs,hook);return {allowed:false as const,reason:error.code};
    }
  }).immediate();
}
function admissions(receipt:string|null){
  const saved=parse(receipt);
  return Array.isArray(saved?.admissionHistory)?saved.admissionHistory.map((entry:any)=>entry.admission):saved?.admission?[saved.admission]:[];
}

/** Security projection over actual owner rows. Queue state, status projections,
 * newly owned execution events and the one provider-turn observation are checked
 * separately, so the owner's own claim does not invalidate its proof. Accepted
 * bytes, original admission history, source custody and all controls stay bound. */
export function codexRecoverySourceFingerprint(db:Database,row:any){
  const session=db.query('SELECT * FROM sessions WHERE id=?').get(row.session_id) as any;
  const turn=db.query('SELECT * FROM turns WHERE id=?').get(row.turn_id) as any;
  const input=db.query('SELECT * FROM session_inputs WHERE id=?').get(row.accepted_input_id) as any;
  const reservation=db.query('SELECT * FROM codex_unacknowledged_recoveries WHERE accepted_input_id=?').get(row.accepted_input_id) as any;
  const binding=parse(row.binding_json),metadata=parse(session?.native_metadata_json),proof=parse(reservation?.proof_json);
  requireProof(session&&turn&&input&&reservation&&metadata&&binding,'SOURCE_ROWS_MISSING');
  const historyRefusal=recoveryProofHistoryRefusal(proof);
  requireProof(!historyRefusal,historyRefusal??'RECOVERY_HISTORY_POLICY_UNKNOWN');
  requireProof(session.provider_id==='codex'&&binding.provider==='codex'&&binding.model==='gpt-6-astra'
    &&session.agent_session_uuid===binding.threadId&&session.binding_generation===binding.generation
    &&metadata.model===binding.model&&metadata.reasoningEffort===binding.effort
    &&Object.hasOwn(metadata,'providerRunner')&&(metadata.providerRunner??null)===binding.runner,'CURRENT_BINDING_CHANGED');
  requireProof(session.status!=='archived'&&!metadata.suspended&&!metadata.outside&&!metadata.canvasObservation
    &&metadata.interactionPolicy!=='consultation-only'&&!turn.stop_requested_at,'CURRENT_SEND_CONTROLS_REFUSE');
  requireProof(turn.session_id===session.id&&turn.accepted_input_id===input.id&&turn.native_run_id===row.run_id
    &&input.session_id===session.id&&input.origin==='service'&&input.id===`report-back:${reservation.request_id}`
    &&input.request_id===reservation.request_id&&input.steering_id===null,'CURRENT_EXACT_INPUT_CHANGED');
  requireProof(digest(proof)===row.proof_digest,'RETAINED_RECOVERY_PROOF_CHANGED');
  const identity=proof.continuation.identity;
  requireProof(input.source_input_id===identity.sourceInputId&&input.source_run_id===identity.sourceRunId,'CURRENT_SOURCE_IDENTITY_CHANGED');
  const source=db.query('SELECT * FROM session_inputs WHERE id=?').get(input.source_input_id) as any;
  const sourceTurn=db.query('SELECT * FROM turns WHERE native_run_id=? AND session_id=?').get(input.source_run_id,session.id) as any;
  requireProof(source&&sourceTurn&&source.session_id===session.id&&sourceTurn.provider_input_acknowledged_at,'ACKNOWLEDGED_SOURCE_CUSTODY_CHANGED');
  const request=db.query('SELECT * FROM session_communication_requests WHERE request_id=?').get(reservation.request_id) as any;
  requireProof(request&&request.target_session_id===session.id&&request.target_input_id===source.id
    &&request.outcome===null&&parse(request.payload_json)?.requestedEffect==='work','CURRENT_WORK_REQUEST_CHANGED');
  const baseline=parse(row.baseline_admissions_json),currentAdmissions=admissions(input.receipt_json);
  requireProof(Array.isArray(baseline)&&baseline.length>0&&currentAdmissions.length>=baseline.length
    &&digest(currentAdmissions.slice(0,baseline.length))===digest(baseline),'ORIGINAL_ADMISSION_HISTORY_CHANGED');
  const pause=db.query('SELECT * FROM global_pause WHERE singleton=1').get() as any;
  requireProof(pause,'GLOBAL_PAUSE_PREDICATE_MISSING');
  const machine=process.env.CONCIERGE_PEER_NAME==='mac'?'mac':'cloud';
  const exception=db.query('SELECT * FROM global_pause_exceptions WHERE generation=? AND machine=? AND session_id=?')
    .get(pause.generation,machine,session.id);
  requireProof(!pause.paused||!!exception,'GLOBAL_PAUSE_REFUSES');
  const handoffs=db.query('SELECT * FROM session_handoffs WHERE predecessor_session_id=? ORDER BY id').all(session.id) as any[];
  requireProof(!handoffs.some(handoff=>['proposed','accepted'].includes(handoff.state)),'CURRENT_HANDOFF_REFUSES');
  const allInputs=db.query('SELECT rowid AS ordinal,* FROM session_inputs WHERE session_id=? ORDER BY rowid').all(session.id) as any[];
  const projectedInputs=allInputs.map(accepted=>{
    if(accepted.id!==input.id)return accepted;
    const {receipt_json:_receipt,updated_at:_updated,...immutable}=accepted;
    return {...immutable,baselineAdmissions:baseline};
  });
  const others=db.query('SELECT * FROM turns WHERE session_id=? AND id<>? AND id>=? ORDER BY id')
    .all(session.id,row.turn_id,identity.turnId) as any[];
  const active=db.query("SELECT id FROM turns WHERE session_id=? AND id<>? AND status IN ('running','delivering') ORDER BY id")
    .all(session.id,row.turn_id);
  const predecessors=db.query(`SELECT older.id FROM turns older JOIN turns current ON current.id=?
    WHERE older.session_id=? AND ${queuePrecedesSql('older','current')} AND ${EARLIER_TURN_BLOCKS_SQL}
    ORDER BY older.id`).all(row.turn_id,session.id);
  requireProof(!active.length&&!predecessors.length&&!others.some(other=>['queued','running','delivering'].includes(other.status)),
    'OTHER_RUNNABLE_TURN_PRESENT');
  const steering=db.query('SELECT s.* FROM turn_steering_messages s JOIN turns t ON t.id=s.turn_id WHERE t.session_id=? AND t.id>=? ORDER BY s.id')
    .all(session.id,identity.turnId);
  requireProof(steering.length===0,'CURRENT_STEERING_UNRECONCILED');
  const deliveries=db.query('SELECT d.* FROM turn_artifact_deliveries d JOIN turns t ON t.id=d.turn_id WHERE t.session_id=? AND t.id>=? ORDER BY d.artifact_id')
    .all(session.id,identity.turnId);
  requireProof(deliveries.length===0,'CURRENT_PRODUCT_DELIVERY_PRESENT');
  const requests=db.query('SELECT * FROM session_communication_requests WHERE source_session_id=? OR target_session_id=? ORDER BY rowid')
    .all(session.id,session.id);
  // Session attention generation and execution status are owner projections.
  const {generation:_attention,...stableMetadata}=metadata;
  const {additional_dispatch_attempt:_budget,...stableReservation}=reservation;
  return digest({binding,metadata:stableMetadata,archived:session.status==='archived',inputs:projectedInputs,
    selected:{id:turn.id,native_run_id:turn.native_run_id,accepted_input_id:turn.accepted_input_id,stop_requested_at:turn.stop_requested_at},
    source,sourceTurn,request,requests,pause,exception:exception??null,handoffs,others,active,predecessors,steering,deliveries,reservation:stableReservation});
}
function current(db:Database,row:any){
  const fingerprint=codexRecoverySourceFingerprint(db,row);
  requireProof(fingerprint===row.source_fingerprint,'SOURCE_FINGERPRINT_CHANGED');
  const fence=getCodexThreadMutationFence(db,row.thread_id);
  requireProof(fence?.fenceId===row.fence_id&&fence.acceptedInputId===row.accepted_input_id&&fence.runId===row.run_id
    &&fence.dispatchAttempt===row.dispatch_attempt&&fence.bindingDigest===digest(parse(row.binding_json)),'RECOVERY_THREAD_FENCE_CHANGED');
}
function originalSource(db:Database,row:any){
  const reservation=db.query('SELECT proof_json FROM codex_unacknowledged_recoveries WHERE accepted_input_id=?')
    .get(row.accepted_input_id) as any;
  const proof=parse(reservation?.proof_json),original=proof?.native?.originalHistory;
  requireProof(original?.witness?.policy==='codex_original_history_v1'&&original.custody
    &&original.witness.bindingDigest===digest(parse(row.binding_json))&&original.witness.selectedInputId===row.accepted_input_id
    &&original.witness.attemptsDigest===digest(proof.native.attempts)
    &&digest(original.witness.nativeTurnOrder)===digest(proof.native.coverage.map((item:any)=>item.providerTurnId)),
    'NATIVE_ORIGINAL_EFFECT_HISTORY_COVERAGE_UNPROVEN');
  return original;
}
function requireCurrentOriginalSource(db:Database,row:any,afterResume=false){
  const original=originalSource(db,row);
  let selected=original;
  if(afterResume){
    const saved=db.query('SELECT * FROM codex_recovery_source_checkpoints WHERE authorization_id=?').get(row.authorization_id) as any;
    requireProof(saved,'OWNED_RESUME_SOURCE_CHECKPOINT_MISSING');
    selected={witness:parse(saved.witness_json),custody:parse(saved.custody_json)};
    const checkpoint=selected.witness?.ownedResumeCheckpoint;
    const intent=db.query('SELECT * FROM codex_mutation_intents WHERE permit_id=?').get(row.resume_permit_id) as any;
    requireProof(saved.original_witness_digest===original.witness.witnessDigest&&checkpoint
      &&checkpoint.previousWitnessDigest===original.witness.witnessDigest&&checkpoint.previousPrefixDigest===original.witness.prefixDigest
      &&intent?.intent_id===saved.resume_intent_id&&checkpoint.intentId===intent.intent_id&&checkpoint.permitId===row.resume_permit_id
      &&intent.state==='reconciled_applied'&&intent.response_kind==='accepted'&&checkpoint.responseDigest===intent.response_digest
      &&saved.checkpoint_digest===digest({authorizationId:row.authorization_id,originalWitnessDigest:saved.original_witness_digest,
        resumeIntentId:saved.resume_intent_id,...selected}),'OWNED_RESUME_SOURCE_CHECKPOINT_CONFLICT');
  }
  const revision=revalidateCodexOriginalHistorySource(selected.custody,selected.witness);
  requireProof(revision.valid,'NATIVE_ORIGINAL_EFFECT_HISTORY_SOURCE_CHANGED');
  return selected;
}

/** Private worker evidence enters the same owner's immutable custody, never the
 * product event/audit stream. Its paths and source bytes are not public fields. */
export function retainCodexRecoverySourceCheckpoint(db:Database,input:{authorizationId:string;result:any;nowMs:number}){
  return operation(db,input.authorizationId,'source-checkpoint',input.nowMs,row=>{
    current(db,row);running(db,row);
    const original=originalSource(db,row),result=input.result,checkpoint=result?.witness?.ownedResumeCheckpoint;
    const coverageReason=result?.reasons?.[0]?.code;
    requireProof(result?.proven===true,typeof coverageReason==='string'&&/^[A-Z][A-Z0-9_]{1,120}$/.test(coverageReason)
      ?coverageReason:'OWNED_RESUME_SOURCE_CHECKPOINT_UNPROVEN');
    const intent=db.query('SELECT * FROM codex_mutation_intents WHERE permit_id=?').get(row.resume_permit_id) as any;
    requireProof(result.custody&&checkpoint
      &&intent?.intent_id===result.intentId&&intent.permit_id===result.permitId&&intent.method==='thread/resume'
      &&intent.fence_id===row.fence_id&&intent.accepted_input_id===row.accepted_input_id&&intent.run_id===row.run_id
      &&intent.dispatch_attempt===row.dispatch_attempt&&intent.state==='reconciled_applied'&&intent.response_kind==='accepted'
      &&checkpoint.intentId===intent.intent_id&&checkpoint.permitId===intent.permit_id&&checkpoint.responseDigest===intent.response_digest
      &&checkpoint.previousWitnessDigest===original.witness.witnessDigest&&checkpoint.previousPrefixDigest===original.witness.prefixDigest
      &&result.witness.bindingDigest===original.witness.bindingDigest&&result.witness.threadId===row.thread_id
      &&result.witness.selectedInputId===row.accepted_input_id&&result.witness.attemptsDigest===original.witness.attemptsDigest,
      'OWNED_RESUME_SOURCE_CHECKPOINT_UNPROVEN');
    requireProof(revalidateCodexOriginalHistorySource(result.custody,result.witness).valid,'NATIVE_ORIGINAL_EFFECT_HISTORY_SOURCE_CHANGED');
    const value={authorizationId:row.authorization_id,originalWitnessDigest:original.witness.witnessDigest,
      resumeIntentId:intent.intent_id,witness:result.witness,custody:result.custody},checkpointDigest=digest(value);
    const prior=db.query('SELECT checkpoint_digest FROM codex_recovery_source_checkpoints WHERE authorization_id=?').get(row.authorization_id) as any;
    requireProof(!prior||prior.checkpoint_digest===checkpointDigest,'OWNED_RESUME_SOURCE_CHECKPOINT_CONFLICT');
    if(!prior)db.query(`INSERT INTO codex_recovery_source_checkpoints(authorization_id,original_witness_digest,resume_intent_id,
      witness_json,custody_json,checkpoint_digest,created_at_ms) VALUES(?,?,?,?,?,?,?)`).run(row.authorization_id,
        original.witness.witnessDigest,intent.intent_id,JSON.stringify(result.witness),JSON.stringify(result.custody),checkpointDigest,input.nowMs);
    requireCurrentOriginalSource(db,row,true);
    return {allowed:true as const,checkpointDigest,duplicate:!!prior};
  });
}
function coldWitness(db:Database,row:any,witness:any):CodexColdConstructionWitness{
  requireProof(isCodexColdConstructionWitness(witness),'COLD_CONSTRUCTION_WITNESS_INVALID');
  const reservation=db.query('SELECT proof_json FROM codex_unacknowledged_recoveries WHERE accepted_input_id=?').get(row.accepted_input_id) as any;
  const expected=parse(reservation?.proof_json)?.coldResume?.construction,binding=parse(row.binding_json);
  requireProof(expected,'COLD_CONSTRUCTION_RESERVATION_WITNESS_MISSING');
  const compared=compareCodexColdConstructionWitnesses(expected,witness);
  requireProof(compared.same,compared.same?'COLD_CONFIGURATION_OR_THREAD_CHANGED':compared.reason);
  requireProof(witness.threadId===row.thread_id&&witness.fenceId===row.fence_id
    &&witness.acceptedInputId===row.accepted_input_id&&witness.runId===row.run_id&&witness.dispatchAttempt===row.dispatch_attempt
    &&witness.bindingDigest===digest(binding)&&witness.model===binding.model&&witness.effort===binding.effort,
    'COLD_RECOVERY_OWNER_BINDING_CHANGED');
  return witness;
}
function retainedColdInputs(db:Database,row:any,params?:any){
  const saved=db.query('SELECT * FROM codex_recovery_cold_inputs WHERE authorization_id=?').get(row.authorization_id) as any;
  requireProof(saved,'COLD_RESUME_INPUTS_NOT_RETAINED');
  const witness=coldWitness(db,row,parse(saved.witness_json));
  requireProof(isDigest(saved.params_digest)&&saved.inputs_digest===digest({authorizationId:row.authorization_id,witness,paramsDigest:saved.params_digest}),
    'COLD_RESUME_INPUTS_CONFLICT');
  if(params!==undefined){
    const checked=validateCodexColdResumeParameters({witness,params});
    requireProof(checked.allowed,checked.allowed?'COLD_RESUME_PARAMETERS_DO_NOT_MATCH_WITNESS':checked.reason);
    requireProof(digest(params)===saved.params_digest,'COLD_RESUME_PARAMETERS_DO_NOT_MATCH_WITNESS');
  }
  return {saved,witness};
}
function checkedConstructionReceipt(db:Database,row:any,receipt:any){
  const {saved,witness}=retainedColdInputs(db,row);
  const intent=db.query('SELECT * FROM codex_mutation_intents WHERE permit_id=?').get(row.resume_permit_id) as any;
  requireProof(intent?.method==='thread/resume'&&intent.state==='reconciled_applied'&&intent.response_kind==='accepted'
    &&intent.fence_id===row.fence_id&&intent.thread_id===row.thread_id&&intent.accepted_input_id===row.accepted_input_id
    &&intent.run_id===row.run_id&&intent.dispatch_attempt===row.dispatch_attempt&&intent.params_digest===saved.params_digest
    &&isDigest(intent.terminal_evidence_digest),'COLD_RESUME_INTENT_NOT_ACCEPTED');
  const basis={policy:'codex_cold_resume_accepted_v1',threadId:row.thread_id,fenceId:row.fence_id,
    authorizationId:row.authorization_id,intentId:intent.intent_id,bindingDigest:witness.bindingDigest,
    coldWitnessDigest:witness.witnessDigest,paramsDigest:saved.params_digest,responseDigest:intent.terminal_evidence_digest};
  const expected={...basis,receiptDigest:digest(basis)};
  requireProof(digest(receipt)===digest(expected),'COLD_RESUME_CONSTRUCTION_RECEIPT_CONFLICT');
  return expected;
}
function requireColdConstruction(db:Database,row:any){
  const saved=db.query('SELECT * FROM codex_recovery_cold_constructions WHERE authorization_id=?').get(row.authorization_id) as any;
  requireProof(saved,'COLD_RESUME_CONSTRUCTION_RECEIPT_MISSING');
  const receipt=checkedConstructionReceipt(db,row,parse(saved.receipt_json));
  requireProof(saved.receipt_digest===receipt.receiptDigest,'COLD_RESUME_CONSTRUCTION_RECEIPT_CONFLICT');
}
/** Private worker read facts, not raw configuration or a caller readiness flag. */
export function retainCodexRecoveryColdInputs(db:Database,input:{authorizationId:string;witness:CodexColdConstructionWitness;
  paramsDigest:string;nowMs:number}){
  return operation(db,input.authorizationId,'cold-inputs',input.nowMs,row=>{
    current(db,row);running(db,row);requireCurrentOriginalSource(db,row);
    const witness=coldWitness(db,row,input.witness);requireProof(isDigest(input.paramsDigest),'COLD_RESUME_PARAMETERS_DIGEST_INVALID');
    const inputsDigest=digest({authorizationId:row.authorization_id,witness,paramsDigest:input.paramsDigest});
    const prior=db.query('SELECT * FROM codex_recovery_cold_inputs WHERE authorization_id=?').get(row.authorization_id) as any;
    requireProof(!prior||prior.inputs_digest===inputsDigest,'COLD_RESUME_INPUTS_CONFLICT');
    requireProof(!row.resume_permit_id||!!prior,'COLD_RESUME_INPUTS_ALREADY_USED');
    if(!prior)db.query(`INSERT INTO codex_recovery_cold_inputs(authorization_id,witness_json,params_digest,inputs_digest,created_at_ms)
      VALUES(?,?,?,?,?)`).run(row.authorization_id,JSON.stringify(witness),input.paramsDigest,inputsDigest,input.nowMs);
    return {allowed:true as const,inputsDigest,duplicate:!!prior};
  });
}
/** Retains only the validated receipt's fixed hash/identity fields. */
export function retainCodexRecoveryColdConstruction(db:Database,input:{authorizationId:string;
  receipt:CodexRecoveryColdConstructionReceipt;nowMs:number}){
  return operation(db,input.authorizationId,'cold-construction',input.nowMs,row=>{
    current(db,row);running(db,row);
    const receipt=checkedConstructionReceipt(db,row,input.receipt);
    const prior=db.query('SELECT * FROM codex_recovery_cold_constructions WHERE authorization_id=?').get(row.authorization_id) as any;
    requireProof(!prior||prior.receipt_digest===receipt.receiptDigest,'COLD_RESUME_CONSTRUCTION_RECEIPT_CONFLICT');
    if(!prior)db.query(`INSERT INTO codex_recovery_cold_constructions(authorization_id,receipt_json,receipt_digest,created_at_ms)
      VALUES(?,?,?,?)`).run(row.authorization_id,JSON.stringify(receipt),receipt.receiptDigest,input.nowMs);
    return {allowed:true as const,receiptDigest:receipt.receiptDigest,duplicate:!!prior};
  });
}
function authenticate(row:any,capability:string){
  const actual=typeof capability==='string'?hash(capability):'';
  requireProof(isDigest(row.capability_hash)&&isDigest(actual)
    &&timingSafeEqual(Buffer.from(row.capability_hash,'hex'),Buffer.from(actual,'hex')),'INTERNAL_RECOVERY_CAPABILITY_INVALID');
}
function running(db:Database,row:any){
  const turn=db.query('SELECT * FROM turns WHERE id=?').get(row.turn_id) as any;
  requireProof(turn?.status==='running'&&turn.dispatch_attempt===row.dispatch_attempt&&exists(turn.owner_instance_id),'EXACT_RECOVERY_DISPATCH_NOT_RUNNING');
  return turn;
}

/** Called atomically with the source owner's proven reservation, never exposed
 * as an operation that lets callers assert permission or provide proof objects. */
export function grantCodexRecoveryAuthorization(db:Database,input:{acceptedInputId:string;fenceId:string;nowMs:number}){
  return db.transaction(()=>{
    const reservation=db.query('SELECT * FROM codex_unacknowledged_recoveries WHERE accepted_input_id=?').get(input.acceptedInputId) as any;
    let row:any=null;
    try {
      requireProof(reservation,'PROVEN_RECOVERY_RESERVATION_MISSING');
      const proof=parse(reservation.proof_json),c=proof?.continuation,n=proof?.native,identity=c?.identity;
      const historyRefusal=recoveryProofHistoryRefusal(proof);
      requireProof(!historyRefusal,historyRefusal??'RECOVERY_HISTORY_POLICY_UNKNOWN');
      requireProof(c?.proven===true&&c.basis==='accepted_binding_continuation'&&c.policy==='codex-accepted-binding-continuation-v1'
        &&Array.isArray(c.reasons)&&c.reasons.length===0&&isDigest(c.decisionDigest)&&isDigest(c.snapshotDigest)
        &&Array.isArray(c.evidenceRefs)&&c.evidenceRefs.every(exists)
        &&n?.proven===true&&n.continuationDecisionDigest===c.decisionDigest&&n.ownerSnapshotDigest===c.snapshotDigest
        &&isDigest(n.nativeDigest)&&Array.isArray(n.attempts)&&Array.isArray(n.coverage)&&Array.isArray(n.nativeTurnOrder)
        &&exists(n.nativeWatermark)&&identity?.acceptedInputId===input.acceptedInputId&&identity.requestId===reservation.request_id
        &&identity.turnId===reservation.turn_id&&identity.binding?.threadId===reservation.provider_thread_id,'MATCHED_IMMUTABLE_CONTINUATION_NATIVE_PROOF_MISSING');
      requireProof(digest({policy:c.policy,basis:c.basis,identity,snapshotDigest:c.snapshotDigest,evidenceRefs:c.evidenceRefs,reasons:c.reasons})===c.decisionDigest,
        'CONTINUATION_DECISION_DIGEST_INVALID');
      const nativeEvidence={threadId:n.threadId,continuationDecisionDigest:n.continuationDecisionDigest,ownerSnapshotDigest:n.ownerSnapshotDigest,
        attempts:n.attempts,coverage:n.coverage,nativeTurnOrder:n.nativeTurnOrder,nativeWatermark:n.nativeWatermark,originalHistory:n.originalHistory};
      requireProof(digest(nativeEvidence)===n.nativeDigest&&n.threadId===identity.binding.threadId,'NATIVE_DECISION_DIGEST_INVALID');
      requireProof(Array.isArray(proof.attempts)&&proof.attempts.length>0&&proof.dispatchAttemptCount===proof.attempts.length
        &&identity.dispatchAttempt===proof.attempts.length&&proof.attempts.every((a:any,index:number)=>a.dispatchAttempt===index+1
          &&n.attempts.some((owned:any)=>owned.inputId===input.acceptedInputId&&owned.dispatchAttempt===a.dispatchAttempt&&owned.providerTurnId===a.providerTurnId)),
        'SELECTED_RECOVERY_ATTEMPT_BUDGET_NOT_PROVEN');
      const existing=db.query('SELECT * FROM codex_recovery_dispatch_authorizations WHERE accepted_input_id=?').get(input.acceptedInputId) as any;
      if(existing){row=existing;current(db,row);requireProof(row.fence_id===input.fenceId,'RECOVERY_AUTHORIZATION_IDENTITY_CONFLICT');
        audit(db,row,'grant',true,'EXISTING_EXACT_RECOVERY_AUTHORIZATION',input.nowMs);return {allowed:true,authorizationId:row.authorization_id,duplicate:true};}
      const accepted=db.query('SELECT receipt_json FROM session_inputs WHERE id=?').get(input.acceptedInputId) as any;
      row={authorization_id:randomUUID(),accepted_input_id:input.acceptedInputId,session_id:identity.binding.sessionId,
        turn_id:identity.turnId,run_id:identity.runId,dispatch_attempt:proof.attempts.length+1,fence_id:input.fenceId,
        thread_id:identity.binding.threadId,binding_json:JSON.stringify(identity.binding),continuation_digest:c.decisionDigest,native_digest:n.nativeDigest,
        proof_digest:digest(proof),baseline_admissions_json:JSON.stringify(admissions(accepted?.receipt_json??null)),
        evidence_refs_json:JSON.stringify(c.evidenceRefs)};
      row.source_fingerprint=codexRecoverySourceFingerprint(db,row);
      current(db,row);
      requireCurrentOriginalSource(db,row);
      const turn=db.query('SELECT status,dispatch_attempt,provider_input_acknowledged_at FROM turns WHERE id=?').get(row.turn_id) as any;
      requireProof(turn?.status==='queued'&&turn.dispatch_attempt===proof.attempts.length&&turn.provider_input_acknowledged_at===null
        &&reservation.additional_dispatch_attempt===null,'EXACT_RECOVERY_RESERVATION_NOT_UNUSED');
      db.query(`INSERT INTO codex_recovery_dispatch_authorizations(authorization_id,accepted_input_id,session_id,turn_id,run_id,
        dispatch_attempt,fence_id,thread_id,binding_json,continuation_digest,native_digest,proof_digest,source_fingerprint,
        baseline_admissions_json,evidence_refs_json,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.authorization_id,row.accepted_input_id,
          row.session_id,row.turn_id,row.run_id,row.dispatch_attempt,row.fence_id,row.thread_id,row.binding_json,row.continuation_digest,
          row.native_digest,row.proof_digest,row.source_fingerprint,row.baseline_admissions_json,row.evidence_refs_json,input.nowMs);
      audit(db,row,'grant',true,'EXACT_RECOVERY_CONTINUATION',input.nowMs);
      return {allowed:true,authorizationId:row.authorization_id,duplicate:false};
    }catch(error){if(!(error instanceof Refusal))throw error;audit(db,row,'grant',false,error.code,input.nowMs);return {allowed:false,reason:error.code};}
  }).immediate();
}

/** One plaintext capability return for the internal dispatcher. A crash after
 * this durable claim does not mint another start capability on restart. */
export function claimCodexRecoveryDispatchCapability(db:Database,input:{authorizationId:string;turnId:number;runId:string;dispatchAttempt:number;nowMs:number}){
  return operation(db,input.authorizationId,'claim',input.nowMs,row=>{
    current(db,row);running(db,row);
    requireProof(row.turn_id===input.turnId&&row.run_id===input.runId&&row.dispatch_attempt===input.dispatchAttempt,'CLAIM_DISPATCH_IDENTITY_CONFLICT');
    requireProof(row.capability_hash===null,'RECOVERY_DISPATCH_CAPABILITY_ALREADY_CLAIMED');
    const capability=randomBytes(32).toString('base64url');
    db.query('UPDATE codex_recovery_dispatch_authorizations SET capability_hash=?,capability_claimed_at_ms=? WHERE authorization_id=? AND capability_hash IS NULL')
      .run(hash(capability),input.nowMs,row.authorization_id);
    return {allowed:true as const,capability};
  });
}

export function prepareCodexRecoveryMutation(db:Database,input:{authorizationId:string;capability:string;permitId:string;
  method:string;params:any;preparedPromptDigest?:string;nowMs:number}){
  return operation(db,input.authorizationId,'prepare',input.nowMs,row=>{
    authenticate(row,input.capability);current(db,row);running(db,row);
    const binding=parse(row.binding_json),isResume=input.method==='thread/resume',isStart=input.method==='turn/start';
    requireProof(isResume||isStart,'RECOVERY_MUTATION_METHOD_FORBIDDEN');
    requireCurrentOriginalSource(db,row,isStart);
    requireProof(input.params?.threadId===row.thread_id&&input.params.model===binding.model,'ACTUAL_RECOVERY_MODEL_OR_THREAD_MISMATCH');
    if(isResume){
      const allowedKeys=['threadId','cwd','runtimeWorkspaceRoots','approvalPolicy','sandbox','config','model','excludeTurns'];
      const config=input.params.config;
      requireProof(input.params.excludeTurns===true&&Object.keys(input.params).every(key=>allowedKeys.includes(key))
        &&config&&Object.keys(config).every(key=>['agents','shell_environment_policy','model_reasoning_effort','features'].includes(key))
        &&config.features&&typeof config.features==='object'&&!Array.isArray(config.features)
        &&Object.keys(config.features).length===1&&config.features.hooks===true
        &&config.model_reasoning_effort===binding.effort,'RECOVERY_PREPARATION_SHAPE_INVALID');
      if(config.agents)requireProof(Object.keys(config.agents).every(key=>['default_subagent_model','default_subagent_reasoning_effort'].includes(key))
        &&config.agents.default_subagent_model==='gpt-6-luna'&&config.agents.default_subagent_reasoning_effort==='medium','RECOVERY_PREPARATION_AGENT_CONFIG_CHANGED');
      if(config.shell_environment_policy)requireProof(config.shell_environment_policy.inherit==='all'
        &&Object.keys(config.shell_environment_policy).every(key=>['inherit','set'].includes(key))
        &&config.shell_environment_policy.set&&Object.values(config.shell_environment_policy.set).every(value=>typeof value==='string'),
        'RECOVERY_PREPARATION_ENVIRONMENT_SHAPE_INVALID');
      requireProof(!row.start_permit_id&&(!row.resume_permit_id||row.resume_permit_id===input.permitId),'RECOVERY_PREPARATION_ALREADY_USED');
      retainedColdInputs(db,row,input.params);
    }else{
      requireColdConstruction(db,row);
      requireProof(input.params.effort===binding.effort,'ACTUAL_RECOVERY_EFFECTIVE_EFFORT_MISSING_OR_CHANGED');
      requireProof(isDigest(input.preparedPromptDigest),'PREPARED_PROMPT_DIGEST_MISSING');
      requireProof(Array.isArray(input.params.input)&&input.params.input.length===1&&input.params.input[0]?.type==='text'
        &&typeof input.params.input[0].text==='string'&&hash(input.params.input[0].text)===input.preparedPromptDigest,
        'ACTUAL_PREPARED_PROMPT_MISMATCH');
      requireProof(input.params.clientUserMessageId===`slack-concierge:turn:${row.turn_id}:attempt:${row.dispatch_attempt}`,'ACTUAL_RECOVERY_CLIENT_INPUT_ID_MISMATCH');
      requireProof(!row.start_permit_id||row.start_permit_id===input.permitId,'RECOVERY_START_PERMIT_ALREADY_BOUND');
    }
    const paramsDigest=digest(input.params);
    const priorPermit=db.query('SELECT * FROM codex_mutation_permits WHERE permit_id=?').get(input.permitId) as any;
    requireProof(!priorPermit||priorPermit.method===input.method&&priorPermit.params_digest===paramsDigest
      &&priorPermit.fence_id===row.fence_id,'RECOVERY_MUTATION_PERMIT_IDENTITY_CONFLICT');
    const grant=grantCodexMutationPermit(db,{permitId:input.permitId,threadId:row.thread_id,
      owner:{acceptedInputId:row.accepted_input_id,runId:row.run_id,dispatchAttempt:row.dispatch_attempt,bindingDigest:digest(binding)},
      method:input.method,paramsDigest,purpose:'fenced_recovery',fenceId:row.fence_id,nowMs:input.nowMs});
    requireProof(grant.granted,'RECOVERY_MUTATION_PERMIT_NOT_GRANTED');
    if(isResume)db.query('UPDATE codex_recovery_dispatch_authorizations SET resume_permit_id=? WHERE authorization_id=?').run(input.permitId,row.authorization_id);
    else db.query('UPDATE codex_recovery_dispatch_authorizations SET start_permit_id=?,prompt_digest=?,start_params_digest=? WHERE authorization_id=?')
      .run(input.permitId,input.preparedPromptDigest!,paramsDigest,row.authorization_id);
    return {allowed:true as const,permitId:input.permitId,paramsDigest};
  },{actualModel:input.params?.model,configuredEffort:input.params?.effort??input.params?.config?.model_reasoning_effort});
}

export function consumeCodexRecoveryMutation(db:Database,input:{authorizationId:string;capability:string;permitId:string;intentId:string;params:any;nowMs:number}){
  return operation(db,input.authorizationId,'consume',input.nowMs,row=>{
    authenticate(row,input.capability);current(db,row);running(db,row);
    requireProof(row.start_permit_id===input.permitId||row.resume_permit_id===input.permitId,'RECOVERY_PERMIT_IDENTITY_CONFLICT');
    const permit=db.query('SELECT * FROM codex_mutation_permits WHERE permit_id=?').get(input.permitId) as any;
    requireProof(permit?.params_digest===digest(input.params),'ACTUAL_RECOVERY_PARAMETERS_CHANGED');
    requireCurrentOriginalSource(db,row,permit.method==='turn/start');
    if(permit.method==='thread/resume')retainedColdInputs(db,row,input.params);
    else requireColdConstruction(db,row);
    if(permit.method==='turn/start'){
      const reservation=db.query('SELECT additional_dispatch_attempt FROM codex_unacknowledged_recoveries WHERE accepted_input_id=?').get(row.accepted_input_id) as any;
      const turn=db.query('SELECT provider_admission_intended_at FROM turns WHERE id=?').get(row.turn_id) as any;
      requireProof(reservation?.additional_dispatch_attempt===row.dispatch_attempt&&!!turn?.provider_admission_intended_at,
        'RECOVERY_DISPATCH_BUDGET_NOT_DURABLY_SPENT');
    }
    const consumed=consumeCodexMutationPermit(db,{permitId:input.permitId,intentId:input.intentId,paramsDigest:permit.params_digest,nowMs:input.nowMs});
    requireProof(consumed.forward,'RECOVERY_MUTATION_ALREADY_FORWARDED_OR_REFUSED');
    return {allowed:true as const,forward:true as const,intentId:input.intentId};
  },{actualModel:input.params?.model,configuredEffort:input.params?.effort??input.params?.config?.model_reasoning_effort});
}

export function codexRecoveryPromptGate(db:Database,input:{providerSessionId:string;providerTurnId:string;invocationId:string;
  promptDigest:string|null;model:string;providerAgentId?:string;ownerTurnId?:number;sourceRunId?:string;nowMs:number}){
  const row=db.query(`SELECT a.* FROM codex_recovery_dispatch_authorizations a JOIN codex_thread_mutation_fences f ON f.fence_id=a.fence_id
    WHERE a.thread_id=? AND (f.state='active' OR a.provider_turn_id=? OR EXISTS(
      SELECT 1 FROM codex_mutation_intents i WHERE i.permit_id=a.start_permit_id
        AND i.state IN ('forwarding','response_received','ambiguous')))
    ORDER BY a.created_at_ms DESC LIMIT 1`).get(input.providerSessionId,input.providerTurnId) as any;
  if(!row)return {known:false as const};
  return {known:true as const,...operation(db,row.authorization_id,'hook',input.nowMs,auth=>{
    current(db,auth);running(db,auth);
    const binding=parse(auth.binding_json);
    requireProof(!input.providerAgentId&&exists(input.providerTurnId)&&exists(input.invocationId)
      &&input.model===binding.model&&isDigest(input.promptDigest)&&input.promptDigest===auth.prompt_digest
      &&(input.ownerTurnId===undefined||input.ownerTurnId===auth.turn_id)
      &&(input.sourceRunId===undefined||input.sourceRunId===auth.run_id),'EXACT_RECOVERY_HOOK_IDENTITY_MISMATCH');
    const intent=db.query('SELECT * FROM codex_mutation_intents WHERE permit_id=?').get(auth.start_permit_id) as any;
    requireProof(intent&&['forwarding','response_received'].includes(intent.state)&&intent.method==='turn/start'
      &&intent.params_digest===auth.start_params_digest&&intent.fence_id===auth.fence_id,'RECOVERY_START_NOT_FORWARDING');
    requireProof(!auth.provider_turn_id||auth.provider_turn_id===input.providerTurnId,'RECOVERY_NATIVE_TURN_ID_CONFLICT');
    requireProof(!auth.hook_invocation_id||auth.hook_invocation_id===input.invocationId,'RECOVERY_HOOK_INVOCATION_ALREADY_USED');
    db.query('UPDATE codex_recovery_dispatch_authorizations SET provider_turn_id=?,hook_invocation_id=? WHERE authorization_id=?')
      .run(input.providerTurnId,input.invocationId,auth.authorization_id);
    return {allowed:true as const,basis:'accepted_binding_continuation' as const,decisionDigest:auth.continuation_digest};
  },{...input,actualModel:input.model})};
}

export function recordCodexRecoveryMutationResponse(db:Database,input:{authorizationId:string;intentId:string;response:any;
  responseDigest?:string;responseResultDigest?:string;nowMs:number}){
  return operation(db,input.authorizationId,'response',input.nowMs,row=>{
    const intent=db.query('SELECT * FROM codex_mutation_intents WHERE intent_id=?').get(input.intentId) as any;
    requireProof(intent&&intent.fence_id===row.fence_id&&[row.resume_permit_id,row.start_permit_id].includes(intent.permit_id),'RECOVERY_RESPONSE_INTENT_MISMATCH');
    const binding=parse(row.binding_json),isStart=intent.method==='turn/start';
    const nativeTurnId=isStart?input.response?.turn?.id:null;
    requireProof(isStart?exists(nativeTurnId)&&(!row.provider_turn_id||row.provider_turn_id===nativeTurnId)
      :input.response?.thread?.id===row.thread_id&&input.response?.model===binding.model,'RECOVERY_RESPONSE_BINDING_CONFLICT');
    requireProof(input.response?.model===undefined||input.response.model===binding.model,'RECOVERY_RESPONSE_MODEL_CONFLICT');
    requireProof(input.response?.reasoningEffort===undefined||input.response.reasoningEffort===null
      ||input.response.reasoningEffort===binding.effort,'RECOVERY_RESPONSE_EFFORT_CONFLICT');
    requireProof(input.responseDigest===undefined||isDigest(input.responseDigest),'RECOVERY_RESPONSE_DIGEST_INVALID');
    requireProof(input.responseResultDigest===undefined||isDigest(input.responseResultDigest),'RECOVERY_RESPONSE_RESULT_DIGEST_INVALID');
    const resultDigest=input.responseResultDigest??digest(input.response);
    if(!isStart&&intent.terminal_evidence_digest!==null)
      requireProof(intent.state==='reconciled_applied'&&intent.terminal_evidence_digest===resultDigest,'RECOVERY_NATIVE_RESPONSE_CONFLICT');
    // A response is retained even after Stop; it reconciles custody without
    // reviving execution permission or altering any previous guard decision.
    retainRecoveryResponse(db,{intentId:input.intentId,kind:'accepted',responseDigest:input.responseDigest??digest(input.response),providerTurnId:nativeTurnId,nowMs:input.nowMs});
    if(isStart)db.query('UPDATE codex_recovery_dispatch_authorizations SET provider_turn_id=? WHERE authorization_id=?').run(nativeTurnId,row.authorization_id);
    else reconcileCodexMutationIntent(db,{intentId:input.intentId,outcome:'applied',evidenceDigest:resultDigest,nowMs:input.nowMs});
    return {allowed:true as const,recorded:true as const};
  },{actualModel:input.response?.model,observedEffort:input.response?.reasoningEffort});
}

interface RecoveryInterruptIdentity {
  authorizationId?:string;threadId:string;providerTurnId:string;permitId:string;
  params:{threadId:string;turnId:string};capability?:string;nowMs:number;
}

function retainRecoveryResponse(db:Database,input:{intentId:string;kind:'accepted'|'rpc_error'|'transport_ambiguous';
  responseDigest:string;providerTurnId:string|null;nowMs:number}){
  const intent=db.query('SELECT * FROM codex_mutation_intents WHERE intent_id=?').get(input.intentId) as any;
  requireProof(intent,'RECOVERY_RESPONSE_INTENT_MISSING');
  if(intent.response_kind!==null){
    requireProof(intent.response_kind===input.kind&&intent.response_digest===input.responseDigest
      &&intent.provider_turn_id===input.providerTurnId,'RECOVERY_NATIVE_RESPONSE_CONFLICT');
    return {recorded:false,duplicate:true};
  }
  if(['reconciled_applied','reconciled_not_applied'].includes(intent.state)){
    db.query(`UPDATE codex_mutation_intents SET response_kind=?,response_digest=?,provider_turn_id=?,response_at_ms=?
      WHERE intent_id=? AND response_kind IS NULL`).run(input.kind,input.responseDigest,input.providerTurnId,input.nowMs,input.intentId);
    return {recorded:true,duplicate:false};
  }
  return recordCodexMutationResponse(db,input);
}

function interruptRow(db:Database,input:RecoveryInterruptIdentity){
  if(input.authorizationId)return get(db,input.authorizationId);
  return db.query(`SELECT a.* FROM codex_recovery_dispatch_authorizations a JOIN turns t ON t.id=a.turn_id
    WHERE a.thread_id=? AND (a.provider_turn_id=? OR t.provider_turn_id=?)
    ORDER BY a.created_at_ms DESC LIMIT 1`).get(input.threadId,input.providerTurnId,input.providerTurnId) as any;
}

/** Cancellation needs the native execution identity, not a now-invalid start
 * fingerprint. Stop, pause and archive must revoke work while retaining the
 * ability to interrupt the very execution they are stopping. */
function exactInterruptTarget(db:Database,row:any,input:RecoveryInterruptIdentity){
  const binding=parse(row.binding_json),session=db.query('SELECT * FROM sessions WHERE id=?').get(row.session_id) as any;
  const metadata=parse(session?.native_metadata_json),turn=db.query('SELECT * FROM turns WHERE id=?').get(row.turn_id) as any;
  requireProof(input.threadId===row.thread_id&&input.params?.threadId===row.thread_id
    &&input.params.turnId===input.providerTurnId&&Object.keys(input.params).every(key=>['threadId','turnId'].includes(key)),
    'OWNED_INTERRUPT_PARAMETERS_MISMATCH');
  requireProof(session?.provider_id==='codex'&&session.agent_session_uuid===row.thread_id
    &&session.binding_generation===binding.generation&&metadata&&Object.hasOwn(metadata,'providerRunner')
    &&(metadata.providerRunner??null)===binding.runner,'OWNED_INTERRUPT_BINDING_CHANGED');
  requireProof(turn?.session_id===row.session_id&&turn.accepted_input_id===row.accepted_input_id
    &&turn.native_run_id===row.run_id&&turn.dispatch_attempt===row.dispatch_attempt,'OWNED_INTERRUPT_EXECUTION_CHANGED');
  requireProof((row.provider_turn_id===input.providerTurnId||turn.provider_turn_id===input.providerTurnId)
    &&(!row.provider_turn_id||row.provider_turn_id===input.providerTurnId)
    &&(!turn.provider_turn_id||turn.provider_turn_id===input.providerTurnId),'OWNED_INTERRUPT_NATIVE_TURN_NOT_PROVEN');
  const start=db.query(`SELECT * FROM codex_mutation_intents WHERE permit_id=? AND method='turn/start'
    AND state IN ('forwarding','response_received','ambiguous')`).get(row.start_permit_id) as any;
  requireProof(start&&start.fence_id===row.fence_id&&start.accepted_input_id===row.accepted_input_id
    &&start.run_id===row.run_id&&start.dispatch_attempt===row.dispatch_attempt
    &&(!start.provider_turn_id||start.provider_turn_id===input.providerTurnId),'OWNED_INTERRUPT_ISSUED_START_NOT_PROVEN');
  const fence=db.query('SELECT * FROM codex_thread_mutation_fences WHERE fence_id=?').get(row.fence_id) as any;
  requireProof(fence&&['active','stopped'].includes(fence.state)&&fence.thread_id===row.thread_id
    &&fence.accepted_input_id===row.accepted_input_id&&fence.run_id===row.run_id
    &&fence.dispatch_attempt===row.dispatch_attempt&&fence.binding_digest===digest(binding),'OWNED_INTERRUPT_FENCE_CHANGED');
  return {session,metadata,turn,fence,binding};
}

function currentCanonicalStop(db:Database,row:any,target:ReturnType<typeof exactInterruptTarget>){
  const refs:string[]=[];
  if(target.turn.stop_requested_at)refs.push(`turn:${row.turn_id}:stop_requested_at`);
  if(target.session.status==='archived')refs.push(`session:${row.session_id}:archived`);
  if(target.metadata.suspended)refs.push(`session:${row.session_id}:suspended`);
  const pause=db.query('SELECT * FROM global_pause WHERE singleton=1').get() as any;
  const machine=process.env.CONCIERGE_PEER_NAME==='mac'?'mac':'cloud';
  if(pause?.paused&&!db.query('SELECT 1 FROM global_pause_exceptions WHERE generation=? AND machine=? AND session_id=?')
    .get(pause.generation,machine,row.session_id))refs.push(`global-pause:${pause.generation}:${pause.action_id??'retained'}`);
  return refs;
}

/** Internal common-owner cancellation entry. An adopted execution without the
 * one dispatcher capability can interrupt only on canonical Stop evidence. */
export function authorizeCodexRecoveryInterrupt(db:Database,input:RecoveryInterruptIdentity){
  const row=interruptRow(db,input),context:any={policy:'codex-recovery-interrupt-v1',allowReason:'EXACT_OWNED_NATIVE_INTERRUPTION',
    providerSessionId:input.threadId,providerTurnId:input.providerTurnId,evidenceRefs:[]};
  return operation(db,row?.authorization_id??input.authorizationId??'', 'interrupt-prepare',input.nowMs,auth=>{
    const target=exactInterruptTarget(db,auth,input),stopRefs=currentCanonicalStop(db,auth,target);
    let authority:'live_dispatcher'|'canonical_stop';
    if(input.capability!==undefined){
      authenticate(auth,input.capability);
      requireProof(target.turn.status==='running'&&exists(target.turn.owner_instance_id),'OWNED_INTERRUPT_DISPATCHER_NOT_RUNNING');
      authority='live_dispatcher';context.evidenceRefs.push(`live-dispatch:${auth.run_id}:${auth.dispatch_attempt}`);
    }else{
      requireProof(stopRefs.length>0,'CANONICAL_STOP_EVIDENCE_MISSING');
      authority='canonical_stop';context.evidenceRefs.push(...stopRefs);
    }
    if(target.fence.state==='active')stopCodexThreadMutationFence(db,{fenceId:auth.fence_id,
      stopActionId:`owned-interrupt:${authority}:${input.permitId}`,nowMs:input.nowMs});
    const paramsDigest=digest(input.params);
    const prior=db.query('SELECT * FROM codex_mutation_permits WHERE permit_id=?').get(input.permitId) as any;
    requireProof(!prior||prior.purpose==='owned_interrupt'&&prior.fence_id===auth.fence_id
      &&prior.target_native_turn_id===input.providerTurnId&&prior.params_digest===paramsDigest,'OWNED_INTERRUPT_PERMIT_IDENTITY_CONFLICT');
    const permit=grantCodexMutationPermit(db,{permitId:input.permitId,threadId:auth.thread_id,
      owner:{acceptedInputId:auth.accepted_input_id,runId:auth.run_id,dispatchAttempt:auth.dispatch_attempt,bindingDigest:digest(target.binding)},
      method:'turn/interrupt',paramsDigest,purpose:'owned_interrupt',fenceId:auth.fence_id,nativeTurnId:input.providerTurnId,nowMs:input.nowMs});
    requireProof(permit.granted,'OWNED_INTERRUPT_PERMIT_NOT_GRANTED');
    return {allowed:true as const,authorizationId:auth.authorization_id,permitId:input.permitId,paramsDigest,authority};
  },context);
}

export function consumeCodexRecoveryInterrupt(db:Database,input:RecoveryInterruptIdentity&{authorizationId:string;intentId:string}){
  const context:any={policy:'codex-recovery-interrupt-v1',allowReason:'EXACT_OWNED_NATIVE_INTERRUPTION',
    providerSessionId:input.threadId,providerTurnId:input.providerTurnId,evidenceRefs:[`interrupt-permit:${input.permitId}`]};
  return operation(db,input.authorizationId,'interrupt-consume',input.nowMs,row=>{
    exactInterruptTarget(db,row,input);
    // The durable owned permit proves cancellation authority already accepted by
    // the common owner. A later pause release cannot revive that old execution.
    const permit=db.query('SELECT * FROM codex_mutation_permits WHERE permit_id=?').get(input.permitId) as any;
    requireProof(permit?.purpose==='owned_interrupt'&&permit.method==='turn/interrupt'&&permit.fence_id===row.fence_id
      &&permit.accepted_input_id===row.accepted_input_id&&permit.run_id===row.run_id&&permit.dispatch_attempt===row.dispatch_attempt
      &&permit.target_native_turn_id===input.providerTurnId&&permit.params_digest===digest(input.params),'OWNED_INTERRUPT_PERMIT_IDENTITY_CONFLICT');
    if(input.capability!==undefined)authenticate(row,input.capability);
    const consumed=consumeCodexMutationPermit(db,{permitId:input.permitId,intentId:input.intentId,paramsDigest:permit.params_digest,nowMs:input.nowMs});
    requireProof(consumed.forward,'OWNED_INTERRUPT_ALREADY_FORWARDED_OR_REFUSED');
    return {allowed:true as const,forward:true as const,intentId:input.intentId};
  },context);
}

/** An interrupt RPC response is not terminal proof that native work stopped. */
export function recordCodexRecoveryInterruptResponse(db:Database,input:{authorizationId:string;intentId:string;
  kind:'accepted'|'rpc_error'|'transport_ambiguous';responseDigest:string;nowMs:number}){
  return operation(db,input.authorizationId,'interrupt-response',input.nowMs,row=>{
    const intent=db.query('SELECT * FROM codex_mutation_intents WHERE intent_id=?').get(input.intentId) as any;
    requireProof(intent?.fence_id===row.fence_id&&intent.method==='turn/interrupt'&&isDigest(input.responseDigest),
      'OWNED_INTERRUPT_RESPONSE_IDENTITY_CONFLICT');
    retainRecoveryResponse(db,{intentId:input.intentId,kind:input.kind,responseDigest:input.responseDigest,
      providerTurnId:intent.target_native_turn_id,nowMs:input.nowMs});
    return {allowed:true as const,recorded:true as const,terminalConfirmed:false as const};
  },{policy:'codex-recovery-interrupt-v1',allowReason:'OWNED_INTERRUPT_RESPONSE_RETAINED',evidenceRefs:[`interrupt-intent:${input.intentId}`]});
}

/** The caller supplies no assertion of terminality. Only the exact retained
 * provider callback event can settle the issued start and its interruptions. */
export function reconcileCodexRecoveryNativeTerminal(db:Database,input:{acceptedInputId:string;nowMs:number}){
  const row=db.query('SELECT * FROM codex_recovery_dispatch_authorizations WHERE accepted_input_id=?').get(input.acceptedInputId) as any;
  const context:any={policy:'codex-recovery-native-terminal-v1',allowReason:'EXACT_PROVIDER_NATIVE_TERMINAL_OBSERVED',evidenceRefs:[]};
  return operation(db,row?.authorization_id??'','native-terminal',input.nowMs,auth=>{
    const eventId=`codex-recovery-native-terminal:${auth.turn_id}:${auth.dispatch_attempt}`;
    context.evidenceRefs.push(eventId);
    const event=db.query('SELECT * FROM session_owner_events WHERE event_id=?').get(eventId) as any;
    const payload=parse(event?.payload_json),turn=db.query('SELECT * FROM turns WHERE id=?').get(auth.turn_id) as any;
    requireProof(event&&event.kind==='codex_recovery_native_terminal'&&event.session_id===auth.session_id
      &&event.input_id===auth.accepted_input_id&&event.turn_id===auth.turn_id&&payload?.observedTerminal===true
      &&['completed','failed','interrupted'].includes(payload.status)
      &&payload.providerThreadId===auth.thread_id&&exists(payload.providerTurnId)&&payload.inputId===auth.accepted_input_id
      &&payload.runId===auth.run_id&&payload.dispatchAttempt===auth.dispatch_attempt,'EXACT_PROVIDER_TERMINAL_WITNESS_MISSING');
    requireProof(turn?.session_id===auth.session_id&&turn.accepted_input_id===auth.accepted_input_id
      &&turn.native_run_id===auth.run_id&&turn.dispatch_attempt===auth.dispatch_attempt
      &&(!auth.provider_turn_id||auth.provider_turn_id===payload.providerTurnId)
      &&(!turn.provider_turn_id||turn.provider_turn_id===payload.providerTurnId),'PROVIDER_TERMINAL_EXECUTION_IDENTITY_CONFLICT');
    const witnessDigest=digest(event);
    const existing=db.query('SELECT * FROM codex_recovery_terminal_settlements WHERE accepted_input_id=?').get(input.acceptedInputId) as any;
    if(existing){
      requireProof(existing.authorization_id===auth.authorization_id&&existing.terminal_event_id===eventId
        &&existing.terminal_event_digest===witnessDigest,'PROVIDER_TERMINAL_SETTLEMENT_CONFLICT');
      return {allowed:true as const,...parse(existing.result_json),duplicate:true};
    }
    const issued=db.query('SELECT * FROM codex_mutation_intents WHERE fence_id=? ORDER BY thread_revision').all(auth.fence_id) as any[];
    const start=issued.find(intent=>intent.permit_id===auth.start_permit_id&&intent.method==='turn/start');
    requireProof(start&&start.accepted_input_id===auth.accepted_input_id&&start.run_id===auth.run_id
      &&start.dispatch_attempt===auth.dispatch_attempt&&(!start.provider_turn_id||start.provider_turn_id===payload.providerTurnId),
      'PROVIDER_TERMINAL_ISSUED_START_NOT_PROVEN');
    const unresolved=issued.filter(intent=>['forwarding','response_received','ambiguous'].includes(intent.state));
    for(const intent of unresolved){
      const matchingStart=intent.intent_id===start.intent_id;
      const matchingInterrupt=intent.method==='turn/interrupt'&&intent.target_native_turn_id===payload.providerTurnId;
      requireProof((matchingStart||matchingInterrupt)&&intent.accepted_input_id===auth.accepted_input_id
        &&intent.run_id===auth.run_id&&intent.dispatch_attempt===auth.dispatch_attempt,'TERMINAL_FENCE_HAS_UNRELATED_ISSUED_MUTATION');
    }
    const fence=db.query('SELECT * FROM codex_thread_mutation_fences WHERE fence_id=?').get(auth.fence_id) as any;
    requireProof(fence&&fence.thread_id===auth.thread_id&&fence.accepted_input_id===auth.accepted_input_id
      &&fence.run_id===auth.run_id&&fence.dispatch_attempt===auth.dispatch_attempt,'PROVIDER_TERMINAL_FENCE_IDENTITY_CONFLICT');
    for(const intent of unresolved)reconcileCodexMutationIntent(db,{intentId:intent.intent_id,outcome:'applied',
      evidenceDigest:witnessDigest,nowMs:input.nowMs});
    if(fence.state==='active')stopCodexThreadMutationFence(db,{fenceId:auth.fence_id,
      stopActionId:`native-terminal:${eventId}`,nowMs:input.nowMs});
    db.query('UPDATE codex_recovery_dispatch_authorizations SET provider_turn_id=? WHERE authorization_id=?')
      .run(payload.providerTurnId,auth.authorization_id);
    const result={status:'native_terminal_confirmed' as const,nativeTerminalObserved:true as const,
      acceptedInputId:auth.accepted_input_id,runId:auth.run_id,dispatchAttempt:auth.dispatch_attempt,
      providerThreadId:auth.thread_id,providerTurnId:payload.providerTurnId,terminalEventId:eventId,
      terminalEventDigest:witnessDigest,inputAcknowledged:turn.provider_input_acknowledged_at!==null,
      hookAllowed:auth.hook_invocation_id!==null,usefulWork:'not_assessed' as const,
      executionFenceReleased:true as const,oneAttemptBudgetReset:false as const};
    db.query(`INSERT INTO codex_recovery_terminal_settlements(accepted_input_id,authorization_id,terminal_event_id,terminal_event_digest,
      provider_thread_id,provider_turn_id,run_id,dispatch_attempt,result_json,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(auth.accepted_input_id,auth.authorization_id,eventId,witnessDigest,auth.thread_id,payload.providerTurnId,
        auth.run_id,auth.dispatch_attempt,JSON.stringify(result),input.nowMs);
    return {allowed:true as const,...result,duplicate:false};
  },context);
}
