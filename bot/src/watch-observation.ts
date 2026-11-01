import { Worker } from 'node:worker_threads';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { releaseWorkerPath } from './release-worker';
import { log } from './log';

const RESTART_MS = 1_000;
const SLOW_MS = 200;
let worker: Worker | null = null;
let stopping = false;
let nextId = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
const pending = new Map<number, { resolve: () => void; reject: (reason: Error) => void }>();

function restartLater() {
  if (stopping || restartTimer) return;
  restartTimer = setTimeout(() => { restartTimer = null; start(); }, RESTART_MS);
  restartTimer.unref();
}

function fail(reason: string, failed: Worker) {
  if (worker !== failed) return;
  worker = null;
  for (const waiter of pending.values()) waiter.reject(new Error(reason));
  pending.clear();
  log('error', 'watch_observation_worker_failed', { reason });
  restartLater();
}

function start() {
  if (worker || stopping) return;
  try {
    const databasePath = join(realpathSync(process.env.CONCIERGE_STATE_DIR!), 'state.db');
    const next = new Worker(releaseWorkerPath('watch-observation-worker'), { workerData: { databasePath } });
    next.unref();
    worker = next;
    next.on('message', (reply: { id: number; durationMs: number; error?: string }) => {
      if (worker !== next) return;
      const waiter = pending.get(reply.id);
      if (!waiter) return;
      pending.delete(reply.id);
      if (reply.durationMs >= SLOW_MS) log('warn', 'watch_observation_write_slow', {
        duration_ms: Math.round(reply.durationMs), failed: !!reply.error });
      if (reply.error) waiter.reject(new Error(reply.error));
      else waiter.resolve();
    });
    next.on('error', error => fail(`thread error: ${error.message}`, next));
    next.on('exit', code => fail(`thread exited with ${code}`, next));
  } catch (error) {
    log('error', 'watch_observation_worker_failed', { reason: error instanceof Error ? error.message : String(error) });
    restartLater();
  }
}

/** A failed cursor write leaves the earlier durable observation in place. The next successful
 * poll records the resulting possible gap; no watch outcome is inferred from this cursor. */
export function startWatchObservationWorker() { stopping = false; start(); }

export function recordWatchObservation(watchId: string, observedAt: number, gapMs: number): Promise<void> {
  start();
  if (!worker) return Promise.reject(new Error('watch observation worker unavailable'));
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    try { worker!.postMessage({ id, watchId, observedAt, gapMs }); }
    catch (error) { pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
  });
}

export function stopWatchObservationWorker() {
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  const current = worker;
  worker = null;
  for (const waiter of pending.values()) waiter.reject(new Error('watch observation worker stopped'));
  pending.clear();
  if (current) void current.terminate();
}
