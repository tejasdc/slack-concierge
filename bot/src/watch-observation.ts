import { Worker } from 'node:worker_threads';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { releaseWorkerPath } from './release-worker';
import { log } from './log';

type Cursor = { watch_id: string; last_observed_ms: number; gaps_json: string };
type WatchSeed = { watch_id: string; created_at_ms: number; last_observed_ms: number | null; gaps_json: string };
const RESTART_MS = 1_000;
const SLOW_MS = 200;
const cursors = new Map<string, Cursor>();
let worker: Worker | null = null;
let ready = false;
let stopping = false;
let nextId = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
const pending = new Map<number, { resolve: () => void; reject: (reason: Error) => void }>();
const readiness = new Set<{ resolve: () => void; reject: (reason: Error) => void }>();

/** Read the separate cursor store once at startup. No serving owner transaction touches it. */
export function loadWatchObservationCursors(openWatchIds: readonly string[]) {
  cursors.clear();
  const path = join(realpathSync(process.env.CONCIERGE_STATE_DIR!), 'watch-observations.db');
  if (!existsSync(path)) return;
  const db = new Database(path, { readonly: true });
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cursors'").get()) return;
    const find = db.query('SELECT watch_id,last_observed_ms,gaps_json FROM cursors WHERE watch_id=?');
    for (const watchId of openWatchIds) {
      const cursor = find.get(watchId) as Cursor | null;
      if (cursor) cursors.set(watchId, cursor);
    }
  } finally { db.close(); }
}

export function observationForWatch(row: WatchSeed): { lastObservedAt: number; gapsJson: string } {
  const cursor = cursors.get(row.watch_id);
  const ledgerAt = row.last_observed_ms ?? row.created_at_ms;
  return cursor && cursor.last_observed_ms > ledgerAt
    ? { lastObservedAt: cursor.last_observed_ms, gapsJson: cursor.gaps_json }
    : { lastObservedAt: ledgerAt, gapsJson: row.gaps_json };
}

export function forgetWatchObservation(watchId: string) { cursors.delete(watchId); }

function restartLater() {
  if (stopping || restartTimer) return;
  restartTimer = setTimeout(() => { restartTimer = null; start(); }, RESTART_MS);
  restartTimer.unref();
}

function fail(reason: string, failed: Worker) {
  if (worker !== failed) return;
  worker = null;
  ready = false;
  for (const waiter of pending.values()) waiter.reject(new Error(reason));
  pending.clear();
  for (const waiter of readiness) waiter.reject(new Error(reason));
  readiness.clear();
  log('error', 'watch_observation_worker_failed', { reason });
  restartLater();
}

function start() {
  if (worker || stopping) return;
  try {
    const stateDir = realpathSync(process.env.CONCIERGE_STATE_DIR!);
    const next = new Worker(releaseWorkerPath('watch-observation-worker'), { workerData: { stateDir } });
    next.unref();
    worker = next;
    next.on('message', (reply: { type?: string; id?: number;
      durationMs?: number; cursor?: Cursor; error?: string }) => {
      if (worker !== next) return;
      if (reply.type === 'ready') {
        ready = true;
        for (const waiter of readiness) waiter.resolve();
        readiness.clear();
        return;
      }
      const waiter = pending.get(reply.id!);
      if (!waiter) return;
      pending.delete(reply.id!);
      if ((reply.durationMs ?? 0) >= SLOW_MS) log('warn', 'watch_observation_write_slow', {
        duration_ms: Math.round(reply.durationMs!), failed: !!reply.error });
      if (reply.error) waiter.reject(new Error(reply.error));
      else if (reply.cursor) {
        cursors.set(reply.cursor.watch_id, reply.cursor);
        waiter.resolve();
      } else waiter.reject(new Error('watch observation worker returned no cursor'));
    });
    next.on('error', error => fail(`thread error: ${error.message}`, next));
    next.on('exit', code => fail(`thread exited with ${code}`, next));
  } catch (error) {
    log('error', 'watch_observation_worker_failed', { reason: error instanceof Error ? error.message : String(error) });
    restartLater();
  }
}

export function startWatchObservationWorker() { stopping = false; start(); }

export function waitForWatchObservationWorker(): Promise<void> {
  start();
  if (ready) return Promise.resolve();
  if (!worker) return Promise.reject(new Error('watch observation worker unavailable'));
  return new Promise((resolve, reject) => { readiness.add({ resolve, reject }); });
}

/** Failed storage leaves the earlier cursor in place, so the next poll records possible silence. */
export function recordWatchObservation(row: WatchSeed, observedAt: number, gapMs: number): Promise<void> {
  start();
  if (!worker || !ready) return Promise.reject(new Error('watch observation worker unavailable'));
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    try { worker!.postMessage({ id, watchId: row.watch_id, observedAt, gapMs,
      initialAt: row.last_observed_ms ?? row.created_at_ms, initialGaps: row.gaps_json }); }
    catch (error) { pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
  });
}

export function stopWatchObservationWorker() {
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  const current = worker;
  worker = null;
  ready = false;
  for (const waiter of pending.values()) waiter.reject(new Error('watch observation worker stopped'));
  pending.clear();
  for (const waiter of readiness) waiter.reject(new Error('watch observation worker stopped'));
  readiness.clear();
  if (current) void current.terminate();
}
