import { Worker } from 'node:worker_threads';
import { realpathSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { db } from './state-database';
import { installLedgerBarrier } from './ledger-durability-barrier';
import { releaseWorkerPath } from './release-worker';
import { log } from './log';

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
const CHECKPOINT = { quietBytes: 64 * 1024 * 1024, forceBytes: 4 * 1024 * 1024 * 1024, quietPressure: 10, intervalMs: 5_000 };

type Waiter = { changes: number; resolve: () => void };
const counters = { syncs: 0, slowSyncs: 0, slowestSyncMs: 0, lastSyncMs: 0, checkpoints: 0, slowestCheckpointMs: 0,
  lastCheckpointAt: null as string | null, failure: null as string | null };
/** Once the owner's connection stops syncing (`deferred`), it never syncs again for the life of
 * the process, and only a confirmed sync releases anything. A thread that fails is replaced while
 * waiters keep waiting: returning to synchronous commits would put the disk wait back on the loop. */
let threads: { sync: Worker; checkpoint: Worker } | null = null;
let deferred = false, databasePath = '';
let synced = 0, inFlight: { changes: number; since: number; loggedAt: number } | null = null, nextId = 0;
const waiters: Waiter[] = [];

const totalChanges = () => (db.query('SELECT total_changes() AS n').get() as { n: number }).n;

function settle() {
  while (waiters.length && waiters[0].changes <= synced) waiters.shift()!.resolve();
}

function pump() {
  if (!threads || inFlight || db.inTransaction) return;
  const changes = totalChanges();
  if (changes <= synced) { settle(); return; }
  inFlight = { changes, since: performance.now(), loggedAt: performance.now() };
  threads.sync.postMessage({ id: ++nextId });
}

/** Resolves once every ledger commit made before the call is on disk. Waiters resolve in call
 * order, so callers that write to one stream keep their order. It never rejects: while the disk
 * cannot confirm a sync, what depends on it waits. */
function durable(): Promise<void> {
  return new Promise(resolve => {
    // Sample after the current synchronous task: a caller inside a transaction callback must
    // not count rows that are not committed yet.
    queueMicrotask(() => {
      if (!deferred) { resolve(); return; }
      const changes = totalChanges();
      if (!waiters.length && changes <= synced) { resolve(); return; }
      waiters.push({ changes, resolve });
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
  if (role === 'sync' && deferred) {
    // Written synchronously: the bounded log sink is asynchronous and the process ends here.
    writeSync(2, JSON.stringify({ ts: new Date().toISOString(), level: 'critical', event: 'ledger_durability_lost', reason, waiters: waiters.length }) + '\n');
    process.exit(75);
  }
  log('error', 'ledger_durability_thread_failed', { role, reason, restart_ms: RESTART_AFTER_MS });
  if (role === 'checkpoint') {
    const failed = threads.checkpoint;
    void failed.terminate();
    setTimeout(() => { if (threads?.checkpoint === failed) threads.checkpoint = startWorker('checkpoint'); }, RESTART_AFTER_MS).unref();
    return;
  }
  const { sync, checkpoint } = threads;
  threads = null; inFlight = null;
  void sync.terminate(); void checkpoint.terminate();
  restartLater();
}

/** Before commits stop syncing nothing is owed, so a failed start is simply tried again. */
function restartLater() { setTimeout(startThreads, RESTART_AFTER_MS).unref(); }

function startWorker(role: 'sync' | 'checkpoint'): Worker {
  const worker = new Worker(releaseWorkerPath('ledger-durability-worker'), { workerData: { role, databasePath, ...CHECKPOINT } });
  worker.unref();
  worker.on('error', error => { if (threads?.[role] === worker) fail(role, `${role} thread error: ${error.message}`); });
  worker.on('exit', code => { if (threads?.[role] === worker) fail(role, `${role} thread exited with ${code}`); });
  if (role === 'checkpoint') worker.on('message', (result: { kind?: string; version?: string; sourceId?: string; ms: number; bytes: number; ioPressure: number; busy?: number; log?: number; checkpointed?: number; error?: string }) => {
    if (result.kind === 'engine') {
      log('info', 'ledger_engine', { role, version: result.version, sourceId: result.sourceId });
      return;
    }
    counters.checkpoints++; counters.lastCheckpointAt = new Date().toISOString();
    counters.slowestCheckpointMs = Math.max(counters.slowestCheckpointMs, Math.round(result.ms));
    log(result.error ? 'warn' : 'info', 'ledger_checkpoint', { ...result, ms: Math.round(result.ms) });
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
  sync.on('message', (reply: { ready?: boolean; id?: number; ms?: number; error?: string }) => {
    if (threads?.sync !== sync) return;
    if (reply.ready) {
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
      pump();
      return;
    }
    if (!inFlight) return;
    if (reply.error) { fail('sync', `log sync failed: ${reply.error}`); return; }
    const ms = performance.now() - inFlight.since;
    synced = Math.max(synced, inFlight.changes);
    inFlight = null;
    counters.syncs++; counters.lastSyncMs = Math.round(ms); counters.slowestSyncMs = Math.max(counters.slowestSyncMs, Math.round(ms));
    // Database completion latency, kept apart from the owner's loop lag: a slow sync here is
    // the disk being slow while the owner keeps working.
    if (ms >= SLOW_SYNC_MS) { counters.slowSyncs++; log('warn', 'ledger_durability_slow_sync', { ms: Math.round(ms), sync_ms: Math.round(reply.ms ?? 0), waiters: waiters.length }); }
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
    pendingChanges: deferred ? totalChanges() - synced : 0 };
}
