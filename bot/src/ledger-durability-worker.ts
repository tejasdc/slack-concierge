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
  port.on('message', (message: { id: number }) => {
    const started = performance.now();
    try {
      if (statSync(walPath).ino !== inode) throw new Error('the write-ahead log was replaced');
      fdatasyncSync(fd);
      port.postMessage({ id: message.id, ms: performance.now() - started });
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
  const version = (connection.query('SELECT sqlite_version() AS version').get() as { version: string }).version.split('.').map(Number);
  if (version[0] < 3 || version[0] === 3 && version[1] < 51)
    throw new Error('Checkpoint inspection requires SQLite 3.51.0 or newer; older versions treat NOOP as PASSIVE.');
  const pressure = () => {
    try { return Number(/^some avg10=([0-9.]+)/m.exec(readFileSync('/proc/pressure/io', 'utf8'))?.[1] ?? 0); }
    catch { return 0; }
  };
  // SQLite owns every open/close of its lock files. Reading SHM with readFileSync here closes
  // that inode and drops ALL of this process's POSIX locks, including the owner's writer lock
  // on another thread. NOOP reports uncopied frames without copying or bypassing SQLite.
  const pageSize = (connection.query('PRAGMA page_size').get() as { page_size: number }).page_size;
  const pendingBytes = () => {
    const result = connection.query('PRAGMA wal_checkpoint(NOOP)').get() as { log: number; checkpointed: number };
    return Math.max(0, result.log - result.checkpointed) * (pageSize + 24);
  };
  const tick = () => {
    let bytes = 0;
    try { bytes = pendingBytes(); } catch { return; }
    const ioPressure = pressure();
    // A complete checkpoint lets the owner's next commit rewind the log, and that rewind is
    // the one sync left on the owner's loop. Doing it while the disk is busy is what would
    // stall it, so the log grows through busy periods and is copied when the disk is quiet.
    if (bytes < setup.quietBytes || (ioPressure > setup.quietPressure && bytes < setup.forceBytes)) return;
    const started = performance.now();
    try {
      const result = connection.query('PRAGMA wal_checkpoint(PASSIVE)').get() as { busy: number; log: number; checkpointed: number };
      port.postMessage({ kind: 'checkpoint', ms: performance.now() - started, bytes, ioPressure, ...result });
    } catch (error) {
      port.postMessage({ kind: 'checkpoint', ms: performance.now() - started, bytes, ioPressure,
        error: error instanceof Error ? error.message : String(error) });
    }
  };
  setInterval(tick, setup.intervalMs);
}
