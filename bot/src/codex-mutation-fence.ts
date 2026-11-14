import type { Database } from 'bun:sqlite';

/** Storage contract for managed Codex App Server mutations. This module intentionally
 * knows no transport methods: callers classify every routed write conservatively. */
export type CodexMutationOwner = {
  acceptedInputId: string;
  runId: string;
  dispatchAttempt: number;
  bindingDigest?: string;
};

export type CodexMutationFence = CodexMutationOwner & {
  fenceId: string;
  threadId: string;
};

export type CodexMutationIntent = {
  intent_id: string;
  permit_id: string;
  thread_id: string;
  accepted_input_id: string;
  run_id: string;
  dispatch_attempt: number;
  binding_digest: string | null;
  fence_id: string | null;
  method: string;
  params_digest: string;
  target_native_turn_id: string | null;
  thread_revision: number;
  state: 'forwarding' | 'response_received' | 'ambiguous' | 'reconciled_applied' | 'reconciled_not_applied';
  response_kind: 'accepted' | 'rpc_error' | 'transport_ambiguous' | null;
  response_digest: string | null;
  provider_turn_id: string | null;
  terminal_evidence_digest: string | null;
};

const unresolved = "state IN ('forwarding','response_received','ambiguous')";
export const CODEX_DAEMON_LIFECYCLE_METHOD='managed/daemon-lifecycle';

function issuedDaemonLifecycle(db:Database){
  return db.query(`SELECT intent_id,state FROM codex_mutation_intents
    WHERE thread_id='*' AND method=? AND ${unresolved} ORDER BY thread_revision LIMIT 1`)
    .get(CODEX_DAEMON_LIFECYCLE_METHOD) as {intent_id:string;state:string}|null;
}
function anyIssuedMutation(db:Database){
  return db.query(`SELECT intent_id,state FROM codex_mutation_intents WHERE ${unresolved} LIMIT 1`)
    .get() as {intent_id:string;state:string}|null;
}

function hasBlockingFence(db:Database,threadId:string) {
  if(threadId==='*') return !!db.query(`SELECT 1 FROM codex_thread_mutation_fences f WHERE f.state='active'
    OR (f.state='stopped' AND EXISTS(SELECT 1 FROM codex_mutation_intents i WHERE i.fence_id=f.fence_id AND ${unresolved})) LIMIT 1`).get();
  return !!db.query(`SELECT 1 FROM codex_thread_mutation_fences f WHERE f.thread_id=? AND
    (f.state='active' OR (f.state='stopped' AND EXISTS(SELECT 1 FROM codex_mutation_intents i WHERE i.fence_id=f.fence_id AND ${unresolved}))) LIMIT 1`).get(threadId);
}

/** Called by the canonical ledger schema initializer, under its existing schema gate. */
export function initializeCodexMutationFenceSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS codex_thread_mutation_revisions (
      thread_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0)
    );
    CREATE TABLE IF NOT EXISTS codex_thread_mutation_fences (
      fence_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      accepted_input_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      dispatch_attempt INTEGER NOT NULL CHECK(dispatch_attempt > 0),
      binding_digest TEXT,
      state TEXT NOT NULL CHECK(state IN ('active','stopped')),
      created_at_ms INTEGER NOT NULL,
      stopped_at_ms INTEGER,
      stop_action_id TEXT,
      UNIQUE(thread_id, fence_id),
      CHECK((state='active' AND stopped_at_ms IS NULL AND stop_action_id IS NULL) OR
            (state='stopped' AND stopped_at_ms IS NOT NULL AND stop_action_id IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS codex_thread_one_active_mutation_fence
      ON codex_thread_mutation_fences(thread_id) WHERE state='active';
    CREATE TABLE IF NOT EXISTS codex_mutation_permits (
      permit_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      accepted_input_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      dispatch_attempt INTEGER NOT NULL CHECK(dispatch_attempt > 0),
      binding_digest TEXT,
      method TEXT NOT NULL,
      params_digest TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK(purpose IN ('ordinary','fenced_recovery','owned_interrupt')),
      target_native_turn_id TEXT,
      fence_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('granted','consumed','revoked')),
      created_at_ms INTEGER NOT NULL,
      consumed_at_ms INTEGER,
      revoked_at_ms INTEGER,
      rejection_reason_digest TEXT,
      FOREIGN KEY(thread_id,fence_id) REFERENCES codex_thread_mutation_fences(thread_id,fence_id),
      CHECK((state='granted' AND consumed_at_ms IS NULL AND revoked_at_ms IS NULL) OR
            (state='consumed' AND consumed_at_ms IS NOT NULL AND revoked_at_ms IS NULL) OR
            (state='revoked' AND consumed_at_ms IS NULL AND revoked_at_ms IS NOT NULL)),
      CHECK((purpose='ordinary' AND fence_id IS NULL) OR (purpose IN ('fenced_recovery','owned_interrupt') AND fence_id IS NOT NULL)),
      CHECK((purpose='owned_interrupt' AND method='turn/interrupt' AND target_native_turn_id IS NOT NULL) OR
        (purpose='ordinary' AND method IN ('turn/steer','turn/interrupt')) OR
        (purpose<>'owned_interrupt' AND target_native_turn_id IS NULL))
    );
    CREATE INDEX IF NOT EXISTS codex_mutation_permits_thread_state
      ON codex_mutation_permits(thread_id,state);
    CREATE TABLE IF NOT EXISTS codex_mutation_intents (
      intent_id TEXT PRIMARY KEY,
      permit_id TEXT NOT NULL UNIQUE REFERENCES codex_mutation_permits(permit_id),
      thread_id TEXT NOT NULL,
      accepted_input_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      dispatch_attempt INTEGER NOT NULL CHECK(dispatch_attempt > 0),
      binding_digest TEXT,
      fence_id TEXT,
      method TEXT NOT NULL,
      params_digest TEXT NOT NULL,
      target_native_turn_id TEXT,
      thread_revision INTEGER NOT NULL CHECK(thread_revision > 0),
      state TEXT NOT NULL CHECK(state IN ('forwarding','response_received','ambiguous','reconciled_applied','reconciled_not_applied')),
      response_kind TEXT CHECK(response_kind IS NULL OR response_kind IN ('accepted','rpc_error','transport_ambiguous')),
      response_digest TEXT,
      provider_turn_id TEXT,
      terminal_evidence_digest TEXT,
      created_at_ms INTEGER NOT NULL,
      response_at_ms INTEGER,
      reconciled_at_ms INTEGER,
      FOREIGN KEY(thread_id,fence_id) REFERENCES codex_thread_mutation_fences(thread_id,fence_id),
      CHECK((state='forwarding' AND response_kind IS NULL AND response_digest IS NULL AND terminal_evidence_digest IS NULL AND reconciled_at_ms IS NULL) OR
            (state='response_received' AND response_kind IN ('accepted','rpc_error') AND response_digest IS NOT NULL AND terminal_evidence_digest IS NULL AND reconciled_at_ms IS NULL) OR
            (state='ambiguous' AND response_kind='transport_ambiguous' AND response_digest IS NOT NULL AND terminal_evidence_digest IS NULL AND reconciled_at_ms IS NULL) OR
            (state IN ('reconciled_applied','reconciled_not_applied') AND terminal_evidence_digest IS NOT NULL AND reconciled_at_ms IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS codex_mutation_intents_thread_state
      ON codex_mutation_intents(thread_id,state);
    CREATE INDEX IF NOT EXISTS codex_mutation_intents_state_thread
      ON codex_mutation_intents(state,thread_id);
  `);
}

function ownerMatches(a: CodexMutationOwner, b: CodexMutationOwner) {
  const left=a as CodexMutationOwner & {accepted_input_id?:string;run_id?:string;dispatch_attempt?:number;binding_digest?:string|null};
  const right=b as CodexMutationOwner & {accepted_input_id?:string;run_id?:string;dispatch_attempt?:number;binding_digest?:string|null};
  return (left.acceptedInputId??left.accepted_input_id) === (right.acceptedInputId??right.accepted_input_id) &&
    (left.runId??left.run_id) === (right.runId??right.run_id) &&
    (left.dispatchAttempt??left.dispatch_attempt) === (right.dispatchAttempt??right.dispatch_attempt) &&
    (left.bindingDigest??left.binding_digest??null) === (right.bindingDigest??right.binding_digest??null);
}

function getFence(db: Database, fenceId: string) {
  const row=db.query('SELECT * FROM codex_thread_mutation_fences WHERE fence_id=?').get(fenceId) as any;
  return row?{fenceId:row.fence_id,threadId:row.thread_id,acceptedInputId:row.accepted_input_id,runId:row.run_id,
    dispatchAttempt:row.dispatch_attempt,bindingDigest:row.binding_digest??undefined,state:row.state,
    createdAtMs:row.created_at_ms,stoppedAtMs:row.stopped_at_ms,stopActionId:row.stop_action_id}:null;
}

export function getCodexThreadMutationFence(db: Database, threadId: string) {
  const row=db.query("SELECT * FROM codex_thread_mutation_fences WHERE thread_id=? AND state='active'").get(threadId) as any;
  return row?{fenceId:row.fence_id,threadId:row.thread_id,acceptedInputId:row.accepted_input_id,runId:row.run_id,
    dispatchAttempt:row.dispatch_attempt,bindingDigest:row.binding_digest??undefined,state:'active' as const,createdAtMs:row.created_at_ms}:null;
}

function ownedInterruptFence(db:Database,threadId:string,fenceId:string|undefined,owner:CodexMutationOwner){
  const fence=fenceId?getFence(db,fenceId):null;
  if(!fence||fence.threadId!==threadId||!ownerMatches(fence,owner))return false;
  if(fence.state==='active')return true;
  return fence.state==='stopped'&&!!db.query(`SELECT 1 FROM codex_mutation_intents
    WHERE fence_id=? AND method='turn/start' AND ${unresolved} LIMIT 1`).get(fence.fenceId);
}

/** Grants a digest-bound one-shot permit. Ordinary writes are permitted only outside a fence. */
export function grantCodexMutationPermit(db: Database, input: {
  permitId:string; threadId:string; owner:CodexMutationOwner; method:string; paramsDigest:string;
  purpose:'ordinary'|'fenced_recovery'|'owned_interrupt'; fenceId?:string; nativeTurnId?:string; nowMs:number;
}) {
  return db.transaction(() => {
    const lifecycle=issuedDaemonLifecycle(db);
    if(lifecycle)return {granted:false,reason:'daemon_lifecycle_outstanding' as const,intentId:lifecycle.intent_id};
    const isLifecycle=input.method===CODEX_DAEMON_LIFECYCLE_METHOD;
    if(isLifecycle){
      if(input.threadId!=='*'||input.purpose!=='ordinary'||input.fenceId||input.nativeTurnId)
        return {granted:false,reason:'daemon_lifecycle_scope_invalid' as const};
      const outstanding=anyIssuedMutation(db);
      if(outstanding)return {granted:false,reason:'outstanding_mutation' as const,intentId:outstanding.intent_id};
    }
    const prior = db.query('SELECT * FROM codex_mutation_permits WHERE permit_id=?').get(input.permitId) as any;
    if (prior) {
      const same = prior.thread_id===input.threadId && prior.accepted_input_id===input.owner.acceptedInputId &&
        prior.run_id===input.owner.runId && prior.dispatch_attempt===input.owner.dispatchAttempt &&
        (prior.binding_digest??null)===(input.owner.bindingDigest??null) && prior.method===input.method &&
        prior.params_digest===input.paramsDigest && prior.purpose===input.purpose && prior.fence_id===(input.fenceId??null)
        &&prior.target_native_turn_id===(input.nativeTurnId??null);
      if (!same) throw new Error('permit identity reused with different mutation');
      return {granted:prior.state==='granted',state:prior.state,duplicate:true};
    }
    const active = getCodexThreadMutationFence(db,input.threadId);
    if (input.purpose==='ordinary' && hasBlockingFence(db,input.threadId)) return {granted:false,reason:'thread_fenced' as const};
    if (input.purpose==='fenced_recovery') {
      if (!active || active.fenceId!==input.fenceId || !ownerMatches(active,input.owner)) return {granted:false,reason:'fence_owner_mismatch' as const};
      const outstanding=db.query(`SELECT intent_id FROM codex_mutation_intents WHERE thread_id=? AND ${unresolved} LIMIT 1`).get(input.threadId) as {intent_id:string}|null;
      if(outstanding)return {granted:false,reason:'outstanding_mutation' as const,intentId:outstanding.intent_id};
    } else if(input.purpose==='owned_interrupt'){
      if(input.method!=='turn/interrupt'||!input.nativeTurnId
        ||!ownedInterruptFence(db,input.threadId,input.fenceId,input.owner))return {granted:false,reason:'owned_interrupt_identity_mismatch' as const};
    } else if (input.fenceId) throw new Error('ordinary permit cannot name a fence');
    db.query(`INSERT INTO codex_mutation_permits
      (permit_id,thread_id,accepted_input_id,run_id,dispatch_attempt,binding_digest,method,params_digest,purpose,fence_id,target_native_turn_id,state,created_at_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,?, 'granted',?)`).run(input.permitId,input.threadId,input.owner.acceptedInputId,input.owner.runId,
      input.owner.dispatchAttempt,input.owner.bindingDigest??null,input.method,input.paramsDigest,input.purpose,input.fenceId??null,input.nativeTurnId??null,input.nowMs);
    return {granted:true,state:'granted' as const,duplicate:false};
  }).immediate();
}

/** Atomically consumes a grant and records the forwarding intent before transport I/O. */
export function consumeCodexMutationPermit(db: Database, input: {permitId:string;intentId:string;paramsDigest:string;nowMs:number}) {
  return db.transaction(() => {
    const existingIntent = db.query('SELECT * FROM codex_mutation_intents WHERE intent_id=?').get(input.intentId) as CodexMutationIntent|null;
    if (existingIntent) {
      if (existingIntent.permit_id!==input.permitId || existingIntent.params_digest!==input.paramsDigest)
        throw new Error('intent identity reused with different mutation');
      return {forward:false as const,intent:existingIntent,duplicate:true};
    }
    const permit = db.query('SELECT * FROM codex_mutation_permits WHERE permit_id=?').get(input.permitId) as any;
    if (!permit) return {forward:false as const,reason:'permit_missing' as const};
    if (permit.params_digest!==input.paramsDigest) throw new Error('permit parameter digest mismatch');
    if (permit.state!=='granted') return {forward:false as const,reason:permit.state as 'consumed'|'revoked'};
    const lifecycle=issuedDaemonLifecycle(db);
    if(lifecycle)return {forward:false as const,reason:'daemon_lifecycle_outstanding' as const,intentId:lifecycle.intent_id};
    if(permit.method===CODEX_DAEMON_LIFECYCLE_METHOD){
      if(permit.thread_id!=='*'||permit.purpose!=='ordinary'||permit.fence_id||permit.target_native_turn_id)
        return {forward:false as const,reason:'daemon_lifecycle_scope_invalid' as const};
      const outstanding=anyIssuedMutation(db);
      if(outstanding)return {forward:false as const,reason:'outstanding_mutation' as const,intentId:outstanding.intent_id};
      // Unissued permission belongs to the native incarnation it preceded.
      // A delayed sender must obtain fresh authority after this lifecycle ends.
      db.query("UPDATE codex_mutation_permits SET state='revoked',revoked_at_ms=? WHERE state='granted' AND permit_id<>?")
        .run(input.nowMs,input.permitId);
    }
    const active = getCodexThreadMutationFence(db,permit.thread_id);
    if (permit.purpose==='ordinary' && hasBlockingFence(db,permit.thread_id)) return {forward:false as const,reason:'thread_fenced' as const};
    if (permit.purpose==='fenced_recovery' && (!active || active.fenceId!==permit.fence_id ||
      !ownerMatches(active,{acceptedInputId:permit.accepted_input_id,runId:permit.run_id,dispatchAttempt:permit.dispatch_attempt,bindingDigest:permit.binding_digest??undefined})))
      return {forward:false as const,reason:'fence_owner_mismatch' as const};
    if(permit.purpose==='fenced_recovery') {
      const outstanding=db.query(`SELECT intent_id FROM codex_mutation_intents WHERE thread_id=? AND ${unresolved} LIMIT 1`).get(permit.thread_id) as {intent_id:string}|null;
      if(outstanding)return {forward:false as const,reason:'outstanding_mutation' as const,intentId:outstanding.intent_id};
    }
    if(permit.purpose==='owned_interrupt'&&(permit.method!=='turn/interrupt'||!permit.target_native_turn_id
      ||!ownedInterruptFence(db,permit.thread_id,permit.fence_id,{acceptedInputId:permit.accepted_input_id,runId:permit.run_id,
        dispatchAttempt:permit.dispatch_attempt,bindingDigest:permit.binding_digest??undefined})))
      return {forward:false as const,reason:'owned_interrupt_identity_mismatch' as const};
    db.query('INSERT INTO codex_thread_mutation_revisions(thread_id,revision) VALUES(?,1) ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1').run(permit.thread_id);
    const {revision}=db.query('SELECT revision FROM codex_thread_mutation_revisions WHERE thread_id=?').get(permit.thread_id) as {revision:number};
    db.query("UPDATE codex_mutation_permits SET state='consumed',consumed_at_ms=? WHERE permit_id=? AND state='granted'").run(input.nowMs,input.permitId);
    db.query(`INSERT INTO codex_mutation_intents
      (intent_id,permit_id,thread_id,accepted_input_id,run_id,dispatch_attempt,binding_digest,fence_id,method,params_digest,target_native_turn_id,thread_revision,state,created_at_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'forwarding',?)`).run(input.intentId,input.permitId,permit.thread_id,permit.accepted_input_id,
      permit.run_id,permit.dispatch_attempt,permit.binding_digest,permit.fence_id,permit.method,permit.params_digest,permit.target_native_turn_id,revision,input.nowMs);
    return {forward:true as const,intent:db.query('SELECT * FROM codex_mutation_intents WHERE intent_id=?').get(input.intentId) as CodexMutationIntent,duplicate:false};
  }).immediate();
}

/** RPC errors are retained but remain outstanding: the native method may have partially applied. */
export function recordCodexMutationResponse(db: Database, input: {
  intentId:string; kind:'accepted'|'rpc_error'|'transport_ambiguous'; responseDigest:string; providerTurnId?:string|null; nowMs:number;
}) {
  return db.transaction(() => {
    const row = db.query('SELECT * FROM codex_mutation_intents WHERE intent_id=?').get(input.intentId) as CodexMutationIntent|null;
    if (!row) throw new Error('mutation intent not found');
    if (input.providerTurnId && ((row.provider_turn_id && row.provider_turn_id!==input.providerTurnId) ||
      (row.target_native_turn_id && row.target_native_turn_id!==input.providerTurnId)))
      throw new Error('mutation response native turn conflicts with retained identity');
    if (row.response_kind===null && ['reconciled_applied','reconciled_not_applied'].includes(row.state)) {
      db.query(`UPDATE codex_mutation_intents SET response_kind=?,response_digest=?,provider_turn_id=?,response_at_ms=?
        WHERE intent_id=? AND response_kind IS NULL`).run(input.kind,input.responseDigest,input.providerTurnId??null,input.nowMs,input.intentId);
      return {recorded:true,duplicate:false,intent:db.query('SELECT * FROM codex_mutation_intents WHERE intent_id=?').get(input.intentId)};
    }
    if (row.state!=='forwarding') {
      if (row.response_kind===input.kind && row.response_digest===input.responseDigest &&
        row.provider_turn_id===(input.providerTurnId??null)) return {recorded:false,duplicate:true,intent:row};
      throw new Error('mutation response conflicts with retained state');
    }
    const state = input.kind==='transport_ambiguous'?'ambiguous':'response_received';
    db.query('UPDATE codex_mutation_intents SET state=?,response_kind=?,response_digest=?,provider_turn_id=?,response_at_ms=? WHERE intent_id=? AND state=\'forwarding\'')
      .run(state,input.kind,input.responseDigest,input.providerTurnId??null,input.nowMs,input.intentId);
    return {recorded:true,duplicate:false,intent:db.query('SELECT * FROM codex_mutation_intents WHERE intent_id=?').get(input.intentId)};
  }).immediate();
}

/** Only exact, source-supported terminal evidence resolves an issued intent. */
export function reconcileCodexMutationIntent(db: Database, input: {
  intentId:string; outcome:'applied'|'not_applied'; evidenceDigest:string; nowMs:number;
}) {
  return db.transaction(() => {
    const row = db.query('SELECT * FROM codex_mutation_intents WHERE intent_id=?').get(input.intentId) as CodexMutationIntent|null;
    if (!row) throw new Error('mutation intent not found');
    const state = input.outcome==='applied'?'reconciled_applied':'reconciled_not_applied';
    if (row.state===state && row.terminal_evidence_digest===input.evidenceDigest) return {reconciled:false,duplicate:true,intent:row};
    if (!['forwarding','response_received','ambiguous'].includes(row.state)) throw new Error('conflicting terminal reconciliation');
    db.query('UPDATE codex_mutation_intents SET state=?,terminal_evidence_digest=?,reconciled_at_ms=? WHERE intent_id=?')
      .run(state,input.evidenceDigest,input.nowMs,input.intentId);
    return {reconciled:true,duplicate:false,intent:db.query('SELECT * FROM codex_mutation_intents WHERE intent_id=?').get(input.intentId)};
  }).immediate();
}

/** Source-side refusal before transport: permit is revoked and no native intent exists. */
export function rejectCodexMutationBeforeForward(db: Database, input:{permitId:string;reasonDigest:string;nowMs:number}) {
  return db.transaction(() => {
    const permit=db.query('SELECT * FROM codex_mutation_permits WHERE permit_id=?').get(input.permitId) as any;
    if(!permit) return {rejected:false as const,reason:'permit_missing' as const};
    const intent=db.query('SELECT 1 FROM codex_mutation_intents WHERE permit_id=?').get(input.permitId);
    if(intent) throw new Error('issued mutation cannot be rejected as pre-forward');
    if(permit.state==='revoked') return {rejected:false as const,duplicate:true};
    if(permit.state!=='granted') throw new Error('consumed permit has no pre-forward rejection');
    db.query("UPDATE codex_mutation_permits SET state='revoked',revoked_at_ms=?,rejection_reason_digest=? WHERE permit_id=? AND state='granted'")
      .run(input.nowMs,input.reasonDigest,input.permitId);
    return {rejected:true as const,duplicate:false,reasonDigest:input.reasonDigest};
  }).immediate();
}

/** A fence cannot be acquired across any possibly issued native write. */
export function acquireCodexThreadMutationFence(db: Database, input:CodexMutationFence & {nowMs:number}) {
  return db.transaction(() => {
    const lifecycle=issuedDaemonLifecycle(db);
    if(lifecycle)return {acquired:false,reason:'daemon_lifecycle_outstanding' as const,intent:lifecycle};
    const old = getFence(db,input.fenceId);
    if (old) {
      if (old.threadId!==input.threadId || !ownerMatches(old,input)) throw new Error('fence identity reused with another owner');
      if (old.state==='active') return {acquired:true,duplicate:true,fence:old};
      return {acquired:false,reason:'fence_stopped' as const};
    }
    const active=getCodexThreadMutationFence(db,input.threadId);
    if(active) return {acquired:false,reason:'already_fenced' as const,fence:active};
    const outstanding=db.query(`SELECT intent_id,state FROM codex_mutation_intents WHERE thread_id IN (?, '*') AND ${unresolved} ORDER BY thread_revision LIMIT 1`)
      .get(input.threadId) as {intent_id:string;state:string}|null;
    if(outstanding) return {acquired:false,reason:'outstanding_mutation' as const,intent:outstanding};
    db.query(`INSERT INTO codex_thread_mutation_fences
      (fence_id,thread_id,accepted_input_id,run_id,dispatch_attempt,binding_digest,state,created_at_ms)
      VALUES(?,?,?,?,?,?,'active',?)`).run(input.fenceId,input.threadId,input.acceptedInputId,input.runId,input.dispatchAttempt,input.bindingDigest??null,input.nowMs);
    db.query("UPDATE codex_mutation_permits SET state='revoked',revoked_at_ms=? WHERE thread_id IN (?, '*') AND state='granted'").run(input.nowMs,input.threadId);
    return {acquired:true,duplicate:false,fence:getFence(db,input.fenceId)};
  }).immediate();
}

/** Stop releases the reservation and all unused grants; issued intents remain durable blockers. */
export function stopCodexThreadMutationFence(db: Database, input:{fenceId:string;stopActionId:string;nowMs:number}) {
  return db.transaction(() => {
    const fence=getFence(db,input.fenceId);
    if(!fence) return {stopped:false as const,reason:'fence_missing' as const};
    if(fence.state==='stopped') {
      if(fence.stopActionId!==input.stopActionId) throw new Error('fence already stopped by another action');
      return {stopped:false as const,duplicate:true,fence};
    }
    db.query("UPDATE codex_thread_mutation_fences SET state='stopped',stopped_at_ms=?,stop_action_id=? WHERE fence_id=? AND state='active'")
      .run(input.nowMs,input.stopActionId,input.fenceId);
    db.query("UPDATE codex_mutation_permits SET state='revoked',revoked_at_ms=? WHERE fence_id=? AND state='granted'").run(input.nowMs,input.fenceId);
    return {stopped:true as const,duplicate:false,fence:getFence(db,input.fenceId)};
  }).immediate();
}

export function listCodexThreadMutationIntents(db:Database,threadId:string) {
  return db.query('SELECT * FROM codex_mutation_intents WHERE thread_id=? ORDER BY thread_revision').all(threadId) as CodexMutationIntent[];
}
