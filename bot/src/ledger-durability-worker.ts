import { parentPort, workerData } from 'node:worker_threads';
import { closeSync, fdatasyncSync, fstatSync, openSync, readFileSync, statSync } from 'node:fs';
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
  let fd: number | null = null, inode = -1;
  const current = () => {
    const now = statSync(walPath).ino;
    if (fd === null || now !== inode) {
      if (fd !== null) closeSync(fd);
      fd = openSync(walPath, 'r');
      inode = fstatSync(fd).ino;
    }
    return fd;
  };
  port.on('message', (message: { id: number }) => {
    const started = performance.now();
    try {
      fdatasyncSync(current());
      port.postMessage({ id: message.id, ms: performance.now() - started });
    } catch (error) {
      port.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
    }
  });
} else {
  // Synchronous FULL: the checkpoint syncs the log before copying it and the database after,
  // which is what lets the owner's connection skip those syncs.
  // A ledger connection that writes no rows: it only copies the log into the database file.
  const connection = ledgerWriteResults(new Database(setup.databasePath));
  connection.exec('PRAGMA busy_timeout = 5000');
  connection.exec('PRAGMA synchronous = FULL');
  const pressure = () => {
    try { return Number(/^some avg10=([0-9.]+)/m.exec(readFileSync('/proc/pressure/io', 'utf8'))?.[1] ?? 0); }
    catch { return 0; }
  };
  // The log file keeps its size after SQLite rewinds it, so its length says nothing about
  // what is left to copy. The documented wal-index header does: frames written (mxFrame, offset
  // 16, after the page size at 14) less frames already copied (nBackfill, offset 96).
  const pendingBytes = () => {
    const header = readFileSync(`${setup.databasePath}-shm`).subarray(0, 100);
    if (header.length < 100) return 0;
    const pageSize = header.readUInt16LE(14) === 1 ? 65536 : header.readUInt16LE(14);
    return Math.max(0, header.readUInt32LE(16) - header.readUInt32LE(96)) * (pageSize + 24);
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
