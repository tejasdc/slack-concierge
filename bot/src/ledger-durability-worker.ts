import { parentPort, workerData } from 'node:worker_threads';
import { fdatasyncSync, fstatSync, openSync, readFileSync, statSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { CHECKPOINT_CUSTODY } from './ledger-checkpoint-protocol';

/** The disk waits the owner's event loop used to take on every ledger commit, on threads of
 * their own. Role `sync` makes the write-ahead log durable on request; role `checkpoint` copies
 * it into the database and primes its next generation, only under an exclusive owner grant.
 * See docs/architecture/LEDGER-DURABILITY.md. */
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
  const identity = fstatSync(fd);
  port.postMessage({ ready: true });
  port.on('message', (message: { id: number; sentAtMs?: number }) => {
    const receivedAtMs = performance.timeOrigin + performance.now();
    const started = performance.now();
    try {
      const current=statSync(walPath);
      if (current.ino !== identity.ino||current.dev!==identity.dev) throw new Error('the write-ahead log was replaced');
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
  // Application rows remain on the original owner connection. The only worker write is the
  // same-current-value page-one metadata primer, while application admission is closed.
  // The lock wait is set before the first statement: preparing one reads the schema.
  const raw = new Database(setup.databasePath);
  // This private fixed-SQL connection exposes no statements, iterators, blobs, backups or
  // extensions. Every prepare is finalized before returning; query()'s statement cache and
  // ledgerWriteResults' retained changes() statement are deliberately absent from this role.
  const statements = new Set<ReturnType<Database['prepare']>>();
  let finalized = 0;
  let retiring = false, closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const workerId = (workerData as Setup & { workerId: string }).workerId;
  function statement<T>(sql: string, read: boolean): T {
    const prepared = raw.prepare(sql);
    statements.add(prepared);
    try { return (read ? prepared.get() : prepared.run()) as T; }
    finally { prepared.finalize(); statements.delete(prepared); finalized++; }
  }
  const get = <T>(sql: string): T => statement<T>(sql, true);
  const execute = (sql: string): void => { statement(sql, false); };
  function closeLedger(retirementId: number | null) {
    retiring = true;
    if (timer) clearInterval(timer);
    if (closed) return;
    if (raw.inTransaction) execute('ROLLBACK');
    for (const prepared of statements) { prepared.finalize(); statements.delete(prepared); finalized++; }
    if (raw.inTransaction || statements.size) throw new Error('checkpoint private resources did not drain');
    raw.close(true);
    // This getter enters Bun's native handle lookup. Its refusal alone is NOT the proof:
    // successful native close plus the finite, non-escaping resource inventory above is.
    let nativeClosed = false;
    try { void raw.inTransaction; }
    catch (error) { nativeClosed = error instanceof Error && /Database has closed/.test(error.message); }
    if (!nativeClosed) throw new Error('checkpoint native close was not confirmed');
    closed = true;
    port.postMessage({ kind: 'ledger-closed', workerId, retirementId,
      pendingStatements: 0, inTransaction: false, finalized, nativeClosed: true, custody: CHECKPOINT_CUSTODY });
  }
  function refuseClose(error: unknown) {
    port.postMessage({ kind: 'close-refused', workerId, error: error instanceof Error ? error.message : String(error) });
  }
  function retire(retirementId: number | null, code: number) {
    try { closeLedger(retirementId); }
    catch (error) { refuseClose(error); return; }
    process.exit(code);
  }
  // A parent never skips this boundary with terminate(). A caught failure returns to this
  // port; an uncaught failure is captured here so a close refusal can retain the live handle.
  const ownFailure = (error: unknown) => {
    // Publish cleanup outcome first. Otherwise the owner can request another close
    // between the error and refusal messages, turning a refused lifetime into a retry.
    try { closeLedger(null); }
    catch (failure) {
      refuseClose(failure);
      port.postMessage({ kind: 'checkpoint-error', error: String(error) });
      return;
    }
    port.postMessage({ kind: 'checkpoint-error', error: String(error) });
    process.exit(1);
  };
  process.on('uncaughtException', ownFailure);
  process.on('unhandledRejection', ownFailure);
  process.on('exit', () => {
    if (closed) return;
    try { closeLedger(null); }
    catch (error) {
      refuseClose(error);
      // An exit hook cannot asynchronously refuse VM destruction. If native cleanup is
      // uncertain, retain this worker here instead of entering Bun's destructive sweep.
      // There is no timeout or parent force fallback; the epoch remains closed.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  });
  port.on('message', (message: { kind: string; retirementId?: number }) => {
    if (message.kind === 'retire' && Number.isSafeInteger(message.retirementId)) retire(message.retirementId!, 0);
  });
  execute('PRAGMA busy_timeout = 5000');
  execute('PRAGMA synchronous = FULL');
  execute('PRAGMA wal_autocheckpoint = 0');
  const engine = get<{ version: string; sourceId: string }>('SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId');
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
  const pageSize = get<{ page_size: number }>('PRAGMA page_size').page_size;
  const pendingBytes = () => {
    const result = get<{ log: number; checkpointed: number }>('PRAGMA wal_checkpoint(NOOP)');
    return Math.max(0, result.log - result.checkpointed) * (pageSize + 24);
  };
  let requested = false;
  let nextRequestId = 0, nextObligationId = 0;
  let pendingRequestId: number | null = null, obligationId: number | null = null;
  let ownerReady=false;
  let activeEpoch: number | null = null;
  let completedEpoch = 0;
  port.on('message', (message: { kind: string; epoch: number }) => {
    if (retiring) return;
    if(message.kind==='enable'){ownerReady=true;return;}
    if (message.kind !== 'recycle' || !Number.isSafeInteger(message.epoch) || message.epoch <= completedEpoch || activeEpoch !== null) return;
    requested = true;
    pendingRequestId = null;
    activeEpoch = message.epoch;
    const started = performance.now();
    const attempt = () => {
      if (retiring) return;
      try {
        const result = get<{ busy: number; log: number; checkpointed: number }>('PRAGMA wal_checkpoint(RESTART)');
        if (result.busy || result.log !== result.checkpointed) {
          // Business writes stay held meanwhile; say so at the busy handler's own pace.
          if (result.busy) port.postMessage({ kind: 'recycle-waiting', epoch: message.epoch,
            ms: performance.now() - started, ...result });
          // The same frozen frontier and grant survive finite old readers. Never return to
          // eligibility after partial backfill: pendingBytes may now be zero.
          setImmediate(attempt);
          return;
        }
        execute('BEGIN IMMEDIATE');
        try {
          const value = get<{ user_version: number }>('PRAGMA main.user_version').user_version;
          if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new Error('invalid user_version');
          execute(`PRAGMA main.user_version = ${value}`);
          execute('COMMIT');
          const preserved = get<{ user_version: number }>('PRAGMA main.user_version').user_version;
          if (preserved !== value) throw new Error('primer changed user_version');
        } catch (error) {
          if (raw.inTransaction) execute('ROLLBACK');
          throw error;
        }
        const fresh = get<{ log: number; checkpointed: number }>('PRAGMA wal_checkpoint(NOOP)');
        if (fresh.log <= 0 || fresh.checkpointed !== 0 || raw.inTransaction)
          throw new Error('primer did not establish a fresh unbackfilled WAL generation');
        completedEpoch = message.epoch;
        activeEpoch = null;
        port.postMessage({ kind: 'recycled', epoch: message.epoch, ms: performance.now() - started,
          ...result, primedFrames: fresh.log });
        // Only the owner can acknowledge completion and reopen eligibility.
      } catch (error) {
        port.postMessage({ kind: 'recycle-error', epoch: message.epoch,
          error: error instanceof Error ? error.message : String(error) });
      }
    };
    attempt();
  });
  port.on('message', (message: { kind: string; epoch: number; workerId?: string; requestId?: number; obligationId?: number }) => {
    if (retiring || activeEpoch !== null) return;
    if (message.kind === 'maintenance-deferred' && message.workerId === workerId
      && message.requestId === pendingRequestId && pendingRequestId !== null && message.obligationId === obligationId) {
      // No grant was issued. Keep the already eligible obligation, but let the
      // established checkpoint tick ask again with a new attempt identity.
      requested = false;
      pendingRequestId = null;
    }
    if (message.kind === 'resumed' && message.epoch === completedEpoch && completedEpoch > 0 && requested && pendingRequestId === null) {
      requested = false;
      pendingRequestId = null;
      obligationId = null;
    }
  });
  // Until the release handover grants fixed-tail recycling, a legacy direct writer may still
  // exist, so this worker keeps the installed lock-free behavior: PASSIVE copies under the
  // same quiet/forced eligibility, with the partly-copied tail finished on the next tick.
  // It never takes the writer lock and cannot stall another writer.
  const passiveTick = () => {
    let log: number, checkpointed: number;
    try { ({ log, checkpointed } = get<{ log: number; checkpointed: number }>('PRAGMA wal_checkpoint(NOOP)')); } catch { return; }
    const bytes = Math.max(0, log - checkpointed) * (pageSize + 24);
    const ioPressure = pressure();
    const tail = checkpointed > 0 && bytes > 0 && bytes < setup.quietBytes;
    if ((bytes < setup.quietBytes && !tail) || (ioPressure > setup.quietPressure && bytes < setup.forceBytes)) return;
    const started = performance.now();
    try {
      const result = get<{ busy: number; log: number; checkpointed: number }>('PRAGMA wal_checkpoint(PASSIVE)');
      if (tail && result.checkpointed <= checkpointed) return;
      port.postMessage({ kind: 'passive-checkpoint', ms: performance.now() - started, bytes, ioPressure, tail, ...result });
    } catch (error) {
      port.postMessage({ kind: 'passive-checkpoint', ms: performance.now() - started, bytes, ioPressure,
        error: error instanceof Error ? error.message : String(error) });
    }
  };
  const tick = () => {
    if (!retiring && !ownerReady && activeEpoch === null) { passiveTick(); return; }
    if (retiring || !ownerReady || requested || activeEpoch !== null) return;
    let bytes = 0;
    try { bytes = pendingBytes(); } catch { return; }
    const ioPressure = pressure();
    // Preserve the existing quiet/forced eligibility. The owner closes admission
    // before RESTART and keeps it closed through the worker's header prime.
    if (obligationId === null && (bytes < setup.quietBytes || (ioPressure > setup.quietPressure && bytes < setup.forceBytes))) return;
    obligationId ??= ++nextObligationId;
    pendingRequestId = ++nextRequestId;
    requested = true;
    port.postMessage({ kind: 'maintenance-request', workerId, requestId: pendingRequestId, obligationId, bytes, ioPressure });
  };
  timer = setInterval(tick, setup.intervalMs);
}
