import './sqlite-worker-identity';
import { parentPort, workerData } from 'node:worker_threads';
import { fdatasyncSync, fstatSync, openSync, readFileSync, statSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { ledgerWriteResults } from './ledger-write-results';

/** The disk waits the owner's event loop used to take on every ledger commit, on threads of
 * their own. Role `sync` makes the write-ahead log durable on request; role `checkpoint` copies
 * it into the database file. Neither opens a write transaction, so neither can make the owner
 * wait for SQLite's writer lock. See docs/architecture/LEDGER-DURABILITY.md. */
type Setup = { role: 'sync' | 'checkpoint'; databasePath: string; quietBytes: number; forceBytes: number;
  quietPressure: number; intervalMs: number };
const setup = workerData as Setup;
const port = parentPort!;
const walPath = `${setup.databasePath}-wal`;

if (setup.role === 'sync') {
  // One descriptor for the log's lifetime: Linux reports a writeback error to a descriptor
  // opened before the error, so reopening per sync could hide a failed write.
  // It is opened before the owner stops syncing, so no write it must vouch for predates it. The
  // log is never replaced while the checkpoint thread holds the database open; if it were, this
  // descriptor could not vouch for the new file, and the sync fails rather than guessing.
  const fd = openSync(walPath, 'r');
  const inode = fstatSync(fd).ino;
  port.postMessage({ ready: true });
  port.on('message', (message: { id: number; sentAtMs?: number }) => {
    const receivedAtMs = performance.timeOrigin + performance.now();
    const started = performance.now();
    try {
      if (statSync(walPath).ino !== inode) throw new Error('the write-ahead log was replaced');
      const syncStarted = performance.now();
      fdatasyncSync(fd);
      const fdatasyncMs = performance.now() - syncStarted;
      port.postMessage({ id: message.id, ms: performance.now() - started,
        queueMs: message.sentAtMs == null ? null : receivedAtMs - message.sentAtMs,
        fdatasyncMs, postedAtMs: performance.timeOrigin + performance.now() });
    } catch (error) {
      port.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
    }
  });
} else {
  // Synchronous FULL: the checkpoint syncs the log before copying it and the database after,
  // which is what lets the owner's connection skip those syncs.
  // A ledger connection that writes no rows: it only copies the log into the database file.
  // The lock wait is set before the first statement: preparing one reads the schema.
  const raw = new Database(setup.databasePath);
  raw.exec('PRAGMA busy_timeout = 5000');
  raw.exec('PRAGMA synchronous = FULL');
  const connection = ledgerWriteResults(raw);
  const engine = connection.query('SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId').get() as { version: string; sourceId: string };
  const version = engine.version.split('.').map(Number);
  if (version[0] < 3 || version[0] === 3 && version[1] < 51)
    throw new Error('Checkpoint inspection requires SQLite 3.51.0 or newer; older versions treat NOOP as PASSIVE.');
  port.postMessage({ kind: 'engine', ...engine });
  const pressure = () => {
    try { return Number(/^some avg10=([0-9.]+)/m.exec(readFileSync('/proc/pressure/io', 'utf8'))?.[1] ?? 0); }
    catch { return 0; }
  };
  // SQLite owns every open/close of its lock files. Reading SHM with readFileSync here closes
  // that inode and drops ALL of this process's POSIX locks, including the owner's writer lock
  // on another thread. NOOP reports uncopied frames without copying or bypassing SQLite.
  const pageSize = (connection.query('PRAGMA page_size').get() as { page_size: number }).page_size;
  const uncopied = () => {
    const result = connection.query('PRAGMA wal_checkpoint(NOOP)').get() as { log: number; checkpointed: number };
    return { bytes: Math.max(0, result.log - result.checkpointed) * (pageSize + 24), checkpointed: result.checkpointed };
  };
  const tick = () => {
    let before: { bytes: number; checkpointed: number };
    try { before = uncopied(); } catch { return; }
    const { bytes } = before;
    const ioPressure = pressure();
    // The log rewinds only when a writer starts with every committed frame copied. PASSIVE
    // copies up to the frame it saw when it began, so commits made while it runs stay behind
    // as a small tail. Waiting for that tail to reach the copy threshold let the log grow
    // without bound (16 hours and ~14 GB on 2026-11-15), so a generation already partly copied
    // has its tail finished on the next tick. This stays PASSIVE: FULL or RESTART would hold
    // the writer lock through the copy and its syncs, and the owner's synchronous commits would
    // wait for them. A tail copy can still lose the race to a new commit; it then retries on
    // the next tick, so recycling is likely under the live write rate, not guaranteed.
    // See docs/architecture/LEDGER-DURABILITY.md#log-recycling.
    const tail = before.checkpointed > 0 && bytes > 0 && bytes < setup.quietBytes;
    // A complete checkpoint lets the owner's next commit rewind the log, and that rewind is
    // the one sync left on the owner's loop. Doing it while the disk is busy is what would
    // stall it, so the log grows through busy periods and is copied when the disk is quiet.
    if ((bytes < setup.quietBytes && !tail) || (ioPressure > setup.quietPressure && bytes < setup.forceBytes)) return;
    const started = performance.now();
    try {
      const result = connection.query('PRAGMA wal_checkpoint(PASSIVE)').get() as { busy: number; log: number; checkpointed: number };
      // A reader still using older frames can hold the tail in place; record a tail attempt
      // only when it copied something, so a long read does not log every tick.
      if (tail && result.checkpointed <= before.checkpointed) return;
      port.postMessage({ kind: 'checkpoint', ms: performance.now() - started, bytes, ioPressure, tail, ...result });
    } catch (error) {
      port.postMessage({ kind: 'checkpoint', ms: performance.now() - started, bytes, ioPressure,
        error: error instanceof Error ? error.message : String(error) });
    }
  };
  setInterval(tick, setup.intervalMs);
}
