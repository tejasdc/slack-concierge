import { Worker } from 'node:worker_threads';
import { closeSync, fdatasyncSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { db } from './state-database';
import { installLedgerBarrier } from './ledger-durability-barrier';
import { releaseWorkerPath } from './release-worker';
import { errorFields, log } from './log';

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
const CHECKPOINT = { quietBytes: 64 * 1024 * 1024, forceBytes: 1024 * 1024 * 1024, quietPressure: 10, intervalMs: 5_000 };

type Waiter = { changes: number; resolve: () => void; reject: (error: Error) => void };
const counters = { syncs: 0, slowSyncs: 0, slowestSyncMs: 0, lastSyncMs: 0, checkpoints: 0, slowestCheckpointMs: 0,
  lastCheckpointAt: null as string | null, failure: null as string | null };
let active: { sync: Worker; checkpoint: Worker; walPath: string } | null = null;
let synced = 0, inFlight: { changes: number; since: number } | null = null, nextId = 0;
const waiters: Waiter[] = [];

const totalChanges = () => (db.query('SELECT total_changes() AS n').get() as { n: number }).n;

function settle(error?: Error) {
  while (waiters.length && (error || waiters[0].changes <= synced)) {
    const waiter = waiters.shift()!;
    if (error) waiter.reject(error); else waiter.resolve();
  }
}

function pump() {
  if (!active || inFlight || db.inTransaction) return;
  const changes = totalChanges();
  if (changes <= synced) { settle(); return; }
  inFlight = { changes, since: performance.now() };
  active.sync.postMessage({ id: ++nextId });
}

/** Resolves once every ledger commit made before the call is on disk. Waiters resolve in call
 * order, so callers that write to one stream keep their order. */
function durable(): Promise<void> {
  return new Promise((resolve, reject) => {
    // Sample after the current synchronous task: a caller inside a transaction callback must
    // not count rows that are not committed yet.
    queueMicrotask(() => {
      if (!active) {
        try { syncOwed(); resolve(); } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
        return;
      }
      const changes = totalChanges();
      if (!waiters.length && changes <= synced) { resolve(); return; }
      waiters.push({ changes, resolve, reject });
      pump();
    });
  });
}

/** Rows committed while the threads ran, not yet synced when they stopped; synced on this thread
 * the next time anything needs them, because the barrier no longer sees them. */
let owedSync: string | null = null;
function syncOwed() {
  if (!owedSync) return;
  const fd = openSync(owedSync, 'r');
  try { fdatasyncSync(fd); } finally { closeSync(fd); }
  owedSync = null;
}

/** The threads are gone: return to SQLite's own synchronous commits. Waiters are released only
 * after one sync here; with none waiting, that sync waits for the next caller, so stopping under
 * disk load does not hold the loop. */
function fallBack(reason: string, stopping = false) {
  if (!active) return;
  const { sync, checkpoint, walPath } = active;
  active = null; inFlight = null;
  if (!stopping) { counters.failure = reason; log('error', 'ledger_durability_fallback', { reason }); }
  void sync.terminate(); void checkpoint.terminate();
  try {
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA wal_autocheckpoint = 1000');
    if (totalChanges() > synced) owedSync = walPath;
    if (waiters.length) syncOwed();
    synced = totalChanges();
    settle();
  } catch (error) {
    log('critical', 'ledger_durability_fallback_failed', errorFields(error));
    settle(error instanceof Error ? error : new Error(String(error)));
  }
}

export function startLedgerDurability(stateDir: string): () => void {
  if (active || process.platform !== 'linux') return () => {};
  const databasePath = join(stateDir, 'state.db');
  const start = (role: 'sync' | 'checkpoint') => {
    const worker = new Worker(releaseWorkerPath('ledger-durability-worker'), { workerData: { role, databasePath, ...CHECKPOINT } });
    worker.unref();
    worker.on('error', error => fallBack(`${role} worker error: ${error.message}`));
    worker.on('exit', code => { if (active?.[role] === worker) fallBack(`${role} worker exited with ${code}`); });
    return worker;
  };
  const sync = start('sync'), checkpoint = start('checkpoint');
  active = { sync, checkpoint, walPath: `${databasePath}-wal` };
  sync.on('message', (reply: { id: number; ms?: number; error?: string }) => {
    if (!inFlight || active?.sync !== sync) return;
    if (reply.error) { fallBack(`log sync failed: ${reply.error}`); return; }
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
  checkpoint.on('message', (result: { ms: number; bytes: number; ioPressure: number; busy?: number; log?: number; checkpointed?: number; error?: string }) => {
    counters.checkpoints++; counters.lastCheckpointAt = new Date().toISOString();
    counters.slowestCheckpointMs = Math.max(counters.slowestCheckpointMs, Math.round(result.ms));
    log(result.error ? 'warn' : 'info', 'ledger_checkpoint', { ...result, ms: Math.round(result.ms) });
  });
  // The owner's connection stops syncing only after both threads exist, and every row written
  // before this point was synced by SQLite itself.
  synced = totalChanges();
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA wal_autocheckpoint = 0');
  const periodic = setInterval(pump, PERIODIC_SYNC_MS);
  periodic.unref();
  // Stays installed after stop: it then settles any sync the stop left owed.
  installLedgerBarrier(durable);
  log('info', 'ledger_durability_started', { checkpoint_quiet_bytes: CHECKPOINT.quietBytes, checkpoint_force_bytes: CHECKPOINT.forceBytes });
  return () => {
    clearInterval(periodic);
    if (active?.sync !== sync) return;
    fallBack('stopping', true);
  };
}

export function ledgerDurabilityCounters() {
  return { mode: active ? 'deferred' : 'synchronous', ...counters, waiters: waiters.length,
    inFlightMs: inFlight ? Math.round(performance.now() - inFlight.since) : null, pendingChanges: active ? totalChanges() - synced : 0 };
}
