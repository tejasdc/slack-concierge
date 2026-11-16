import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { realpathSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { db } from './state-database';
import { installLedgerBarrier, type LedgerBarrierContext } from './ledger-durability-barrier';
import { releaseWorkerPath } from './release-worker';
import { log } from './log';
import { maintainLedger,ledgerAdmissionSnapshot,enableLedgerAdmission,runLedgerSegment } from './ledger-admission';
import {protectedDurability,type DurabilityOutcome} from './protected-durability-observation';
import { checkpointCloseCertificate, type CheckpointClosed } from './ledger-checkpoint-protocol';

/** The accepting owner commits ledger rows without waiting for the disk, and nothing leaves the
 * process until those rows are on it. SQLite's default commit syncs the write-ahead log on the
 * calling thread; under agent disk load that sync waited on the filesystem journal for up to
 * 100 seconds, with the owner's whole event loop stopped (2026-10-09/10). Here the owner's
 * connection writes with synchronous=NORMAL, which SQLite documents as safe from corruption,
 * while a sync thread makes the log durable and a checkpoint thread copies it into the database.
 * Answers, provider input and peer requests wait on `ledgerDurable()` asynchronously, so a slow
 * disk delays only what depends on it. See docs/architecture/LEDGER-DURABILITY.md. */

const PERIODIC_SYNC_MS = 1_000;
const SLOW_SYNC_MS = 1_000;
const STALLED_SYNC_LOG_MS = 60_000;
const RESTART_AFTER_MS = 5_000;
const CHECKPOINT = { quietBytes: 64 * 1024 * 1024, forceBytes: 256 * 1024 * 1024, quietPressure: 10, intervalMs: 5_000 };

type Waiter = { changes: number; sampledAtMs: number; precedingSyncId: number | null;
  context?: LedgerBarrierContext; resolve: () => void };
const counters = { syncs: 0, slowSyncs: 0, slowestSyncMs: 0, lastSyncMs: 0, checkpoints: 0, slowestCheckpointMs: 0,
  lastCheckpointAt: null as string | null, failure: null as string | null,
  lastQueueMs: null as number | null, lastFdatasyncMs: null as number | null, lastDeliveryMs: null as number | null };
/** Once the owner's connection stops syncing (`deferred`), it never syncs again for the life of
 * the process, and only a confirmed sync releases anything. A thread that fails is replaced while
 * waiters keep waiting: returning to synchronous commits would put the disk wait back on the loop. */
let threads: { sync: Worker; checkpoint: Worker } | null = null;
let deferred = false, databasePath = '';
let synced = 0, inFlight: { id: number; changes: number; since: number; startedAtMs: number; loggedAt: number } | null = null, nextId = 0;
const waiters: Waiter[] = [];
// A failed native attempt owns its possible locks until its actual worker lifetime ends.
let checkpointReplacement: Promise<Worker> | null = null;
let checkpointUnavailable:Worker|null=null;
const checkpointRecoveryRetries=new WeakMap<Worker,ReturnType<typeof setTimeout>>();
let recycling: { epoch: number; worker: Worker | null; resolve?: () => void; reject?: (error: Error) => void } | null = null;
let recyclingEnabled = false;
let maintenanceAuthority: (() => Promise<() => void | Promise<void>>) | null = null;
let heldMaintenanceAuthority: (() => void | Promise<void>) | null = null;
let maintenanceRequest: Promise<void> | null = null;

/** Existing launch authority supplies its kernel lifetime guard. It must acquire without
 * entering SQLite; release is synchronous and occurs only after the epoch resumes. */
export function installLedgerMaintenanceAuthority(acquire: () => Promise<() => void | Promise<void>>): void {
  if (maintenanceAuthority || maintenanceRequest || recyclingEnabled)
    throw new Error('ledger maintenance authority must be installed once before recycling');
  maintenanceAuthority = acquire;
}
type CheckpointLifetime = {
  workerId: string; retirementId?: number; exited: boolean; certificate?: CheckpointClosed; refusal?: Error;
  cleanup: Promise<CheckpointClosed | Error>; settleCleanup: (result: CheckpointClosed | Error) => void;
  exit: Promise<void>; settleExit: () => void;
};
const unadmittedSites = new Set<string>();
const checkpointLifetimes = new WeakMap<Worker, CheckpointLifetime>();
let nextRetirementId = 0;

async function retireCheckpoint(worker: Worker): Promise<void> {
  const lifetime = checkpointLifetimes.get(worker);
  if (!lifetime) throw new Error('unknown checkpoint lifetime');
  if (lifetime.refusal) throw lifetime.refusal;
  if (!lifetime.certificate && !lifetime.exited && lifetime.retirementId === undefined) {
    lifetime.retirementId = ++nextRetirementId;
    worker.postMessage({ kind: 'retire', retirementId: lifetime.retirementId });
  }
  // Never turn an own error into forced teardown. Missing/refused cleanup holds the
  // maintenance epoch; an exit notification alone is not the native-close certificate.
  const proof = await lifetime.cleanup;
  if (proof instanceof Error) throw proof;
  await lifetime.exit;
}

function replaceCheckpoint(failed: Worker): Promise<Worker> {
  if (checkpointReplacement) return checkpointReplacement;
  checkpointReplacement = (async () => {
    if(recyclingEnabled&&ledgerAdmissionSnapshot().enabled&&ledgerAdmissionSnapshot().phase==='serving')throw new Error('checkpoint retirement requires exclusive ledger admission');
    await retireCheckpoint(failed);
    await new Promise<void>(resolve => setTimeout(resolve, RESTART_AFTER_MS));
    if (!threads || threads.checkpoint !== failed) throw new Error('checkpoint authority changed');
    const replacement = startWorker('checkpoint');
    threads.checkpoint = replacement;
    if(checkpointUnavailable===failed)checkpointUnavailable=null;
    return replacement;
  })().finally(() => { checkpointReplacement = null; });
  return checkpointReplacement;
}

export function recycleLedger(): Promise<void> {
  if (!recyclingEnabled) return Promise.reject(new Error('ledger recycling is not enabled'));
  // A transaction left open by a reported unadmitted caller holds the writer; granting now
  // would make its later COMMIT a fatal in-maintenance statement. The worker asks again.
  if (db.inTransaction) return Promise.reject(new Error('an unadmitted ledger transaction is open'));
  return requestLedgerRecycle();
}

/** Bootstrap primes under the same protected epoch while periodic eligibility stays
 * disabled. The release authority records and fences completion before enabling it. */
export function initializeLedgerRecycling():Promise<void>{
  if(recyclingEnabled||!maintenanceAuthority||!ledgerAdmissionSnapshot().enabled)
    return Promise.reject(new Error('initial recycling requires withheld eligibility and launch authority'));
  return requestLedgerRecycle();
}

function requestLedgerRecycle():Promise<void>{
  if (maintenanceRequest) return maintenanceRequest;
  const current = (async () => {
    const release = maintenanceAuthority ? await maintenanceAuthority() : () => {};
    if (typeof release !== 'function') throw new Error('ledger maintenance authority did not return release custody');
    heldMaintenanceAuthority = release;
    await performRecycle();
    await release();
    heldMaintenanceAuthority = null;
  })();
  maintenanceRequest = current;
  void current.then(() => { maintenanceRequest = null; }, error => {
    // A failed acquisition has not closed admission or entered SQLite and can be retried.
    if (!heldMaintenanceAuthority) { maintenanceRequest = null; return; }
    // A failed-closed epoch would otherwise hold every business write forever. Owner
    // recovery is the existing boundary for lost ledger authority: exiting ends the worker
    // and its native locks with the process, and nothing unsynced was ever answered.
    writeSync(2, JSON.stringify({ ts: new Date().toISOString(), level: 'critical', event: 'ledger_maintenance_failed_closed',
      reason: error instanceof Error ? error.message : String(error) }) + '\n');
    process.exit(75);
  });
  return current;
}

function pregrantStillServing(epoch:number):boolean {
  const admission=ledgerAdmissionSnapshot();
  return admission.phase==='serving'&&admission.epoch===epoch&&!heldMaintenanceAuthority;
}

/** A dead checkpoint worker has no eligibility tick left. Its existing replacement
 * obligation retries acquisition on the same replacement cadence, never native cleanup. */
function recoverUnavailableCheckpoint(failed:Worker):void {
  if(threads?.checkpoint!==failed||checkpointUnavailable!==failed||checkpointRecoveryRetries.has(failed))return;
  const epoch=ledgerAdmissionSnapshot().epoch;
  void recycleLedger().catch(error=>{
    log('error','ledger_checkpoint_replacement_failed',{reason:String(error)});
    if(!pregrantStillServing(epoch)||threads?.checkpoint!==failed||checkpointUnavailable!==failed||checkpointRecoveryRetries.has(failed))return;
    const retry=setTimeout(()=>{
      checkpointRecoveryRetries.delete(failed);
      if(pregrantStillServing(epoch)&&threads?.checkpoint===failed&&checkpointUnavailable===failed)
        recoverUnavailableCheckpoint(failed);
    },RESTART_AFTER_MS);
    checkpointRecoveryRetries.set(failed,retry);
    retry.unref();
  });
}

async function performRecycle(): Promise<void> {
  await maintainLedger(async epoch => {
    const cycle: NonNullable<typeof recycling> = { epoch, worker: null };
    recycling = cycle;
    // The owner connection is frozen. The original sync descriptor, rather than the
    // checkpoint or metadata commit, proves the last application mutation frontier.
    await durable();
    try {
      while (true) {
        if (!threads) throw new Error('durability authority unavailable');
        if (checkpointReplacement) await checkpointReplacement;
        if(checkpointUnavailable===threads.checkpoint)await replaceCheckpoint(threads.checkpoint);
        const worker = threads.checkpoint;
        cycle.worker = worker;
        try {
          await new Promise<void>((resolve, reject) => {
            cycle.resolve = resolve;
            cycle.reject = reject;
            worker.postMessage({ kind: 'recycle', epoch });
          });
          if (threads.checkpoint !== worker || cycle.worker !== worker||checkpointUnavailable===worker)
            throw new Error('stale checkpoint completion');
          // This acknowledgment is queued before maintenance resumes admission; another
          // worker tick cannot request a cycle from the previous completion.
          worker.postMessage({ kind: 'resumed', epoch });
          return;
        } catch (error) {
          cycle.resolve = undefined;
          cycle.reject = undefined;
          await replaceCheckpoint(worker);
        }
      }
    } finally { if (recycling === cycle) recycling = null; }
  });
}


const totalChanges = () => (db.query('SELECT total_changes() AS n').get() as { n: number }).n;

function settle() {
  while (waiters.length && waiters[0].changes <= synced) waiters.shift()!.resolve();
}

function pump() {
  if (!threads || inFlight || db.inTransaction) return;
  const changes = totalChanges();
  if (changes <= synced) { settle(); return; }
  const now = performance.now(), id = ++nextId;
  inFlight = { id, changes, since: now, startedAtMs: performance.timeOrigin + now, loggedAt: now };
  threads.sync.postMessage({ id, sentAtMs: inFlight.startedAtMs });
}

/** Resolves once every ledger commit made before the call is on disk. Waiters resolve in call
 * order, so callers that write to one stream keep their order. It never rejects: while the disk
 * cannot confirm a sync, what depends on it waits. */
function durable(context?: LedgerBarrierContext): Promise<void> {
  const observation=context?.observation??protectedDurability.begin(context?.kind);
  return new Promise(resolve => {
    const covered=(proof:DurabilityOutcome)=>{
      observation.proof=proof;
      // The receipt's wider timer ends in its response continuation. Provider input ends here.
      if(!context?.observation)observation.finish(proof);
      resolve();
    };
    // Sample after the current synchronous task: a caller inside a transaction callback must
    // not count rows that are not committed yet.
    queueMicrotask(() => {
      if (!deferred) { covered(3); return; }
      const changes = totalChanges();
      if (!waiters.length && changes <= synced) { covered(1); return; }
      const id = context?.id;
      waiters.push({ changes, resolve:()=>covered(2), sampledAtMs: performance.timeOrigin + performance.now(),
        precedingSyncId: inFlight && changes > inFlight.changes ? inFlight.id : null,
        context: context && (!id || /^[A-Za-z0-9:_-]{1,128}$/.test(id)) ? context : undefined });
      pump();
    });
  });
}

/** Only the sync thread that was open when a commit skipped its sync can vouch for it: Linux
 * reports a failed write-back to descriptors open at the time, so a replacement could report
 * success over a lost write. Once commits stop syncing, losing that thread restarts the owner,
 * which reopens the ledger from what is actually on disk; nothing unsynced was ever answered.
 * The checkpoint thread proves nothing and is simply replaced. */
function fail(role: 'sync' | 'checkpoint', reason: string) {
  if (!threads) return;
  counters.failure = reason;
  if (role === 'sync' && (deferred||ledgerAdmissionSnapshot().enabled)) {
    // Written synchronously: the bounded log sink is asynchronous and the process ends here.
    writeSync(2, JSON.stringify({ ts: new Date().toISOString(), level: 'critical', event: 'ledger_durability_lost', reason, waiters: waiters.length }) + '\n');
    process.exit(75);
  }
  log('error', 'ledger_durability_thread_failed', { role, reason, restart_ms: RESTART_AFTER_MS });
  if (role === 'checkpoint') {
    const failed = threads.checkpoint;
    checkpointUnavailable=failed;
    const cycle = recycling;
    if (cycle && cycle.worker === failed && cycle.reject) {
      cycle.reject(new Error(reason));
    } else {
      if(recyclingEnabled&&ledgerAdmissionSnapshot().enabled)recoverUnavailableCheckpoint(failed);
      else void replaceCheckpoint(failed).catch(error => {
        log('error', 'ledger_checkpoint_replacement_failed', { reason: String(error) });
      });
    }
    return;
  }
  const { sync, checkpoint } = threads;
  threads = null; inFlight = null;
  void sync.terminate(); // Descriptor-only worker, with no SQLite connection.
  void retireCheckpoint(checkpoint).then(restartLater, error => {
    log('error', 'ledger_checkpoint_close_refused', { reason: String(error) });
  });
}

/** Before commits stop syncing nothing is owed, so a failed start is simply tried again. */
function restartLater() { setTimeout(startThreads, RESTART_AFTER_MS).unref(); }

function startWorker(role: 'sync' | 'checkpoint'): Worker {
  const workerId = randomUUID();
  let lastMaintenanceRequestId=0;
  const worker = new Worker(releaseWorkerPath('ledger-durability-worker'), { workerData: { role, databasePath, workerId, ...CHECKPOINT } });
  if (role === 'checkpoint') {
    let settleCleanup!: CheckpointLifetime['settleCleanup'], settleExit!: () => void;
    const lifetime: CheckpointLifetime = { workerId, exited: false,
      cleanup: new Promise(resolve => { settleCleanup = resolve; }), settleCleanup: result => settleCleanup(result),
      exit: new Promise(resolve => { settleExit = resolve; }), settleExit: () => settleExit() };
    checkpointLifetimes.set(worker, lifetime);
    worker.on('message', (reply: any) => {
      if (checkpointCloseCertificate(reply, workerId, lifetime.retirementId)) {
        if (!lifetime.certificate) { lifetime.certificate = reply; lifetime.settleCleanup(reply); }
      } else if (reply?.kind === 'close-refused' && reply.workerId === workerId && !lifetime.certificate) {
        lifetime.refusal = new Error(`checkpoint close refused: ${reply.error}`);
        lifetime.settleCleanup(lifetime.refusal);
      }
    });
    worker.on('exit', () => { lifetime.exited = true; lifetime.settleExit(); });
  }
  worker.unref();
  if(role==='checkpoint'&&deferred&&recyclingEnabled&&ledgerAdmissionSnapshot().enabled)worker.postMessage({kind:'enable'});
  worker.on('error', error => { if (threads?.[role] === worker) fail(role, `${role} thread error: ${error.message}`); });
  worker.on('exit', code => { if (threads?.[role] === worker) fail(role, `${role} thread exited with ${code}`); });
  if (role === 'checkpoint') worker.on('message', (result: { kind?: string; epoch?: number; workerId?: string; requestId?: number; obligationId?: number; version?: string; sourceId?: string; ms?: number; bytes?: number; ioPressure?: number; error?: string }) => {
    if (threads?.checkpoint !== worker) return;
    if (result.kind === 'engine') {
      log('info', 'ledger_engine', { role, version: result.version, sourceId: result.sourceId });
      return;
    }
    if (result.kind === 'maintenance-request') {
      if(result.workerId!==workerId||!Number.isSafeInteger(result.requestId)||result.requestId! <=lastMaintenanceRequestId
        ||!Number.isSafeInteger(result.obligationId)||result.obligationId! <=0)return;
      lastMaintenanceRequestId=result.requestId!;
      if (recycling) return;
      const epoch=ledgerAdmissionSnapshot().epoch;
      const deferred=()=>{
        if(threads?.checkpoint===worker&&pregrantStillServing(epoch))worker.postMessage({kind:'maintenance-deferred',
          workerId,requestId:result.requestId,obligationId:result.obligationId});
      };
      void recycleLedger().then(deferred,error => {
        log('error', 'ledger_checkpoint_admission_failed', { reason: String(error) });
        deferred();
      });
      return;
    }
    if (result.kind === 'checkpoint-error' || result.kind === 'close-refused') {
      fail('checkpoint', result.error ?? 'checkpoint native cleanup failed');
      return;
    }
    if (result.kind === 'recycle-waiting') {
      log('warn', 'ledger_recycle_waiting_for_reader', { epoch: result.epoch, held_ms: Math.round(result.ms ?? 0),
        log: result.log, checkpointed: result.checkpointed });
      return;
    }
    if (result.kind === 'passive-checkpoint') {
      log(result.error ? 'warn' : 'info', 'ledger_checkpoint', { ...result, mode: 'passive-before-handover', ms: Math.round(result.ms ?? 0) });
      return;
    }
    if (!recycling || recycling.worker !== worker || result.epoch !== recycling.epoch) return;
    if (result.kind === 'recycle-error') {
      fail('checkpoint', result.error ?? 'checkpoint failed');
      return;
    }
    if (result.kind !== 'recycled') return;
    if(!recycling.resolve||!recycling.reject)return;
    counters.checkpoints++; counters.lastCheckpointAt = new Date().toISOString();
    counters.slowestCheckpointMs = Math.max(counters.slowestCheckpointMs, Math.round(result.ms ?? 0));
    log('info', 'ledger_checkpoint', { ...result, ms: Math.round(result.ms ?? 0) });
    recycling.resolve?.();
  });
  return worker;
}

function startThreads() {
  if (threads) return;
  let sync: Worker, checkpoint: Worker;
  try { sync = startWorker('sync'); checkpoint = startWorker('checkpoint'); }
  catch (error) {
    log('error', 'ledger_durability_thread_failed', { reason: error instanceof Error ? error.message : String(error), restart_ms: RESTART_AFTER_MS });
    restartLater();
    return;
  }
  threads = { sync, checkpoint };
  sync.on('message', (reply: { ready?: boolean; id?: number; ms?: number; error?: string;
    queueMs?: number | null; fdatasyncMs?: number; postedAtMs?: number }) => {
    if (threads?.sync !== sync) return;
    if (reply.ready) {
      void runLedgerSegment(()=>{
      if(threads?.sync!==sync)return;
      // The sync thread holds its descriptor before any commit skips the sync, so a writeback
      // error after this point reaches it.
      if (!deferred) {
        synced = totalChanges();
        db.exec('PRAGMA synchronous = NORMAL');
        db.exec('PRAGMA wal_autocheckpoint = 0');
        deferred = true;
        const engine = db.query('SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId').get();
        log('info', 'ledger_durability_started', { checkpoint_quiet_bytes: CHECKPOINT.quietBytes, checkpoint_force_bytes: CHECKPOINT.forceBytes, engine });
      }
      if(recyclingEnabled&&ledgerAdmissionSnapshot().enabled)threads?.checkpoint.postMessage({kind:'enable'});
      pump();
      });
      return;
    }
    if (!inFlight || reply.id!==inFlight.id) return;
    if (reply.error) { fail('sync', `log sync failed: ${reply.error}`); return; }
    const completed = inFlight;
    const ms = performance.now() - completed.since;
    const completedAtMs = performance.timeOrigin + performance.now();
    const deliveryMs = reply.postedAtMs == null ? null
      : performance.timeOrigin + performance.now() - reply.postedAtMs;
    synced = Math.max(synced, completed.changes);
    const released = ms >= SLOW_SYNC_MS ? waiters.filter(waiter => waiter.changes <= synced) : [];
    inFlight = null;
    counters.syncs++; counters.lastSyncMs = Math.round(ms); counters.slowestSyncMs = Math.max(counters.slowestSyncMs, Math.round(ms));
    counters.lastQueueMs = reply.queueMs == null || reply.queueMs < 0 ? null : Math.round(reply.queueMs);
    counters.lastFdatasyncMs = reply.fdatasyncMs == null ? null : Math.round(reply.fdatasyncMs);
    counters.lastDeliveryMs = deliveryMs == null || deliveryMs < 0 ? null : Math.round(deliveryMs);
    // The worker's syscall and the owner's callback can each be delayed independently.
    if (ms >= SLOW_SYNC_MS) { counters.slowSyncs++; log('warn', 'ledger_durability_slow_sync', {
      ms: Math.round(ms), sync_ms: Math.round(reply.ms ?? 0), queue_ms: counters.lastQueueMs,
      fdatasync_ms: counters.lastFdatasyncMs, delivery_ms: counters.lastDeliveryMs, waiters: waiters.length,
      owner_pid: process.pid, sync_id: completed.id, sync_target_changes: completed.changes,
      sync_started_at_ms: completed.startedAtMs, worker_posted_at_ms: reply.postedAtMs ?? null,
      sync_completed_at_ms: completedAtMs, released_waiters: released.length,
      receipt_join_truncated: Math.max(0, released.filter(waiter => waiter.context).length - 16),
      receipt_join: released.filter(waiter => waiter.context).slice(0, 16).map(waiter => ({
        kind: waiter.context?.kind ?? 'unlabelled', id: waiter.context?.id ?? null,
        target_changes: waiter.changes, sampled_at_ms: waiter.sampledAtMs,
        preceding_sync_id: waiter.precedingSyncId,
        waited_ms: Math.round(completedAtMs - waiter.sampledAtMs),
      })),
    }); }
    settle();
    pump();
  });
}

/** Starts once per process and lasts for it: stopping the request API leaves the threads to the
 * process's exit, so commits made while it drains are still synced and still gate what leaves. */
export function startLedgerDurability(stateDir: string): void {
  if (databasePath || process.platform !== 'linux') return;
  // The ledger may be a link to its own filesystem; SQLite keeps the log beside the real file.
  databasePath = realpathSync(join(stateDir, 'state.db'));
  installLedgerBarrier(durable);
  protectedDurability.installed=1;
  startThreads();
  setInterval(() => {
    pump();
    // A sync that does not return is the disk not answering; it is reported, never assumed done.
    if (inFlight && performance.now() - inFlight.loggedAt >= STALLED_SYNC_LOG_MS) {
      inFlight.loggedAt = performance.now();
      log('error', 'ledger_durability_sync_stalled', { ms: Math.round(performance.now() - inFlight.since), waiters: waiters.length });
    }
  }, PERIODIC_SYNC_MS).unref();
}

export function ledgerDurabilityCounters() {
  return { mode: deferred ? 'deferred' : 'synchronous', threads: threads ? 'running' : 'restarting', ...counters,
    waiters: waiters.length, inFlightMs: inFlight ? Math.round(performance.now() - inFlight.since) : null,
    pendingChanges: deferred ? totalChanges() - synced : 0,admission:ledgerAdmissionSnapshot() };
}

/** Startup and schema initialization finish before accepting this reversible
 * lifetime. Unexpected callers fail the process before a native writer attempt,
 * using the same retained-input recovery boundary as lost durability authority. */
export function activateLedgerMaintenance(options: { recycling?: boolean } = {}):void {
  if(process.platform!=='linux')return;
  if (options.recycling === false && recyclingEnabled) throw new Error('ledger recycling cannot be disabled after activation');
  enableLedgerAdmission(error=>{
    writeSync(2,JSON.stringify({level:'critical',event:'ledger_operation_not_admitted',error:error.stack})+'\n');
    process.exit(75);
  }, error=>{
    // Serving-phase miss: harmless now, but the same call during a maintenance window would
    // end the owner. Reported once per call site so the missing wrap can be fixed.
    const site = error.stack?.split('\n').slice(2, 6).join('\n') ?? '';
    if (unadmittedSites.has(site)) return;
    unadmittedSites.add(site);
    log('error', 'ledger_operation_unadmitted_while_serving', { stack: error.stack });
  });
  if (options.recycling !== false) enableLedgerRecycling();
}

/** The handover caller establishes its lifetime proof before granting checkpoint eligibility. */
export function enableLedgerRecycling(): void {
  if (process.platform !== 'linux') return;
  if (!ledgerAdmissionSnapshot().enabled) throw new Error('ledger admission must precede recycling');
  recyclingEnabled = true;
  if (deferred) threads?.checkpoint.postMessage({ kind: 'enable' });
}
