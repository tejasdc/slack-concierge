/** Private, disposable proof of the proposed command/commit/sync exchange.
 * This is not imported by the serving application. See
 * docs/plans/2026-11-07-async-ledger-authority.md before production wiring. */
import { Database } from 'bun:sqlite';
import { strict as assert } from 'node:assert';
import { mkdtempSync, openSync, fdatasyncSync, fstatSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

type Input = { actionId: string; body: string };
type Stored = Input & { inputId: string };
type WriterRequest = { id: number; type: 'defer' | 'accept' | 'find'; input?: Input;
  crash?: 'before-commit' | 'after-commit'; hold?: SharedArrayBuffer };
type WriterReply = { id: number; kind: 'ready' | 'result' | 'error' | 'held';
  result?: Stored | null; target?: number; generation?: string; error?: string };
type SyncRequest = { id: number; hold?: SharedArrayBuffer };
type SyncReply = { id?: number; kind: 'ready' | 'waiting' | 'synced' | 'error'; error?: string };

const setup = workerData as { role: 'writer' | 'sync'; path: string; generation: string } | null;
if (!isMainThread && setup) {
  const port = parentPort!;
  if (setup.role === 'writer') {
    const db = new Database(setup.path, { create: true });
    db.exec('PRAGMA busy_timeout=5000');
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA wal_autocheckpoint=0');
    db.exec('PRAGMA synchronous=FULL');
    db.exec('CREATE TABLE IF NOT EXISTS accepted (action_id TEXT PRIMARY KEY, body TEXT NOT NULL, input_id TEXT NOT NULL UNIQUE)');
    const find = db.query('SELECT action_id AS actionId, body, input_id AS inputId FROM accepted WHERE action_id=?');
    const insert = db.query('INSERT INTO accepted(action_id,body,input_id) VALUES (?,?,?)');
    port.postMessage({ id: 0, kind: 'ready', generation: setup.generation } satisfies WriterReply);
    port.on('message', (request: WriterRequest) => {
      try {
        if (request.type === 'defer') {
          db.exec('PRAGMA synchronous=NORMAL');
          port.postMessage({ id: request.id, kind: 'result', generation: setup.generation,
            target: (db.query('SELECT total_changes() AS n').get() as { n: number }).n } satisfies WriterReply);
          return;
        }
        if (request.type === 'find') {
          const row = find.get(request.input?.actionId ?? '') as Stored | null;
          port.postMessage({ id: request.id, kind: 'result', generation: setup.generation, result: row,
            target: (db.query('SELECT total_changes() AS n').get() as { n: number }).n } satisfies WriterReply);
          return;
        }
        const input = request.input!;
        const transaction = db.transaction(() => {
          const existing = find.get(input.actionId) as Stored | null;
          if (existing) {
            if (existing.body !== input.body) throw new Error('IDEMPOTENCY_CONFLICT');
            return existing;
          }
          if (request.hold) {
            port.postMessage({ id: request.id, kind: 'held' } satisfies WriterReply);
            const flag = new Int32Array(request.hold);
            while (Atomics.load(flag, 0) === 0) Atomics.wait(flag, 0, 0);
          }
          if (request.crash === 'before-commit') process.exit(86);
          const stored = { ...input, inputId: `scratch:${crypto.randomUUID()}` };
          insert.run(input.actionId, input.body, stored.inputId);
          return stored;
        });
        const result = transaction();
        // total_changes is connection-local and includes uncommitted statements. Sample it
        // only after the outer transaction has returned and committed.
        const target = (db.query('SELECT total_changes() AS n').get() as { n: number }).n;
        if (request.crash === 'after-commit') process.exit(87);
        port.postMessage({ id: request.id, kind: 'result', result, target,
          generation: setup.generation } satisfies WriterReply);
      } catch (error) {
        port.postMessage({ id: request.id, kind: 'error', error: String(error),
          generation: setup.generation } satisfies WriterReply);
      }
    });
  } else {
    // The descriptor is opened before the writer enters NORMAL mode and stays open for this
    // accepting lifetime. A fresh descriptor must never certify its predecessor's writes.
    const wal = `${setup.path}-wal`;
    const fd = openSync(wal, 'r');
    const inode = fstatSync(fd).ino;
    port.postMessage({ kind: 'ready' } satisfies SyncReply);
    port.on('message', (request: SyncRequest) => {
      try {
        if (request.hold) {
          const flag = new Int32Array(request.hold);
          port.postMessage({ id: request.id, kind: 'waiting' } satisfies SyncReply);
          while (Atomics.load(flag, 0) === 0) Atomics.wait(flag, 0, 0);
        }
        if (statSync(wal).ino !== inode) throw new Error('WAL_REPLACED');
        fdatasyncSync(fd);
        port.postMessage({ id: request.id, kind: 'synced' } satisfies SyncReply);
      } catch (error) {
        port.postMessage({ id: request.id, kind: 'error', error: String(error) } satisfies SyncReply);
      }
    });
  }
}

if (isMainThread) {
  const scratch = mkdtempSync(join(tmpdir(), 'concierge-async-ledger-prototype-'));
  const path = join(scratch, 'state.db');
  let nextId = 0;
  const runWorker = (role: 'writer' | 'sync', generation: string) =>
    new Worker(import.meta.filename, { workerData: { role, path, generation } });
  const onceMessage = <T extends { kind: string; id?: number }>(worker: Worker, predicate: (message: T) => boolean): Promise<T> =>
    new Promise((resolve, reject) => {
      const message = (value: T) => { if (predicate(value)) { cleanup(); resolve(value); } };
      const exit = (code: number) => { cleanup(); reject(new Error(`worker exited ${code}`)); };
      const error = (cause: Error) => { cleanup(); reject(cause); };
      const cleanup = () => { worker.off('message', message); worker.off('exit', exit); worker.off('error', error); };
      worker.on('message', message); worker.on('exit', exit); worker.on('error', error);
    });
  class Authority {
    writer!: Worker;
    sync!: Worker;
    generation = crypto.randomUUID();
    terminal = false;
    async start() {
      this.writer = runWorker('writer', this.generation);
      await onceMessage<WriterReply>(this.writer, value => value.kind === 'ready');
      this.sync = runWorker('sync', this.generation);
      await onceMessage<SyncReply>(this.sync, value => value.kind === 'ready');
      const id = ++nextId;
      const ready = onceMessage<WriterReply>(this.writer, value => value.id === id);
      this.writer.postMessage({ id, type: 'defer' } satisfies WriterRequest);
      assert.equal((await ready).kind, 'result');
    }
    ping() { return { alive: !this.terminal, generation: this.generation }; }
    async accept(input: Input, options: { crash?: WriterRequest['crash']; holdWrite?: SharedArrayBuffer;
      holdSync?: SharedArrayBuffer; onWriterHeld?: () => void; onCommitted?: () => void;
      onSyncWaiting?: () => void } = {}) {
      if (this.terminal) throw new Error('AUTHORITY_TERMINAL');
      const id = ++nextId;
      const writerResult = new Promise<WriterReply>((resolve, reject) => {
        const message = (reply: WriterReply) => {
          if (reply.id !== id) return;
          if (reply.kind === 'held') { options.onWriterHeld?.(); return; }
          cleanup(); resolve(reply);
        };
        const exit = () => { cleanup(); this.terminal = true; reject(new Error('UNKNOWN_AFTER_WRITER_EXIT')); };
        const error = (cause: Error) => { cleanup(); this.terminal = true; reject(cause); };
        const cleanup = () => { this.writer.off('message', message); this.writer.off('exit', exit); this.writer.off('error', error); };
        this.writer.on('message', message); this.writer.on('exit', exit); this.writer.on('error', error);
      });
      this.writer.postMessage({ id, type: 'accept', input, crash: options.crash,
        hold: options.holdWrite } satisfies WriterRequest);
      const reply = await writerResult;
      if (reply.kind !== 'result' || reply.generation !== this.generation || reply.target == null || !reply.result)
        throw new Error(reply.error ?? 'INVALID_WRITER_RESULT');
      options.onCommitted?.();
      const synced = new Promise<SyncReply>((resolve, reject) => {
        const message = (value: SyncReply) => {
          if (value.id !== id) return;
          if (value.kind === 'waiting') { options.onSyncWaiting?.(); return; }
          cleanup(); resolve(value);
        };
        const exit = () => { cleanup(); this.terminal = true; reject(new Error('SYNC_WORKER_EXIT')); };
        const error = (cause: Error) => { cleanup(); this.terminal = true; reject(cause); };
        const cleanup = () => { this.sync.off('message', message); this.sync.off('exit', exit); this.sync.off('error', error); };
        this.sync.on('message', message); this.sync.on('exit', exit); this.sync.on('error', error);
      });
      this.sync.postMessage({ id, hold: options.holdSync } satisfies SyncRequest);
      const proof = await synced;
      if (proof.kind !== 'synced') { this.terminal = true; throw new Error(proof.error ?? 'SYNC_FAILED'); }
      return { ...reply.result, generation: reply.generation, target: reply.target };
    }
    async close() { await Promise.all([this.writer?.terminate(), this.sync?.terminate()]); }
  }
  const gate = () => new SharedArrayBuffer(4);
  const release = (buffer: SharedArrayBuffer) => {
    const flag = new Int32Array(buffer);
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  };
  try {
    // A pending transaction cannot be acknowledged and cannot block the parent's liveness.
    let authority = new Authority();
    await authority.start();
    const heldWrite = gate();
    let writerHeld!: () => void;
    const wasHeld = new Promise<void>(resolve => { writerHeld = resolve; });
    const before = authority.accept({ actionId: 'before-commit', body: 'one' },
      { crash: 'before-commit', holdWrite: heldWrite, onWriterHeld: writerHeld });
    await wasHeld;
    assert.equal(authority.ping().alive, true);
    release(heldWrite);
    await assert.rejects(before, /UNKNOWN_AFTER_WRITER_EXIT/);
    assert.equal(authority.terminal, true);
    await authority.close();

    const afterPrecommitDeath = new Database(path, { readonly: true });
    assert.equal(afterPrecommitDeath.query('SELECT input_id FROM accepted WHERE action_id=?').get('before-commit'), null);
    afterPrecommitDeath.close();

    authority = new Authority();
    await authority.start();
    const first = await authority.accept({ actionId: 'before-commit', body: 'one' });
    assert.equal(first.actionId, 'before-commit');
    const heldSync = gate();
    let syncWaiting!: () => void;
    const waiting = new Promise<void>(resolve => { syncWaiting = resolve; });
    let escaped = false;
    const pending = authority.accept({ actionId: 'sync-held', body: 'two' },
      { holdSync: heldSync, onSyncWaiting: syncWaiting }).then(result => { escaped = true; return result; });
    await waiting;
    assert.equal(escaped, false);
    assert.equal(authority.ping().alive, true);
    release(heldSync);
    const second = await pending;
    assert.equal(second.actionId, 'sync-held');
    assert.ok(second.target >= first.target);
    const predecessorGate = gate();
    let predecessorWaiting!: () => void;
    const predecessorStarted = new Promise<void>(resolve => { predecessorWaiting = resolve; });
    const predecessor = authority.accept({ actionId: 'predecessor', body: 'old' },
      { holdSync: predecessorGate, onSyncWaiting: predecessorWaiting });
    await predecessorStarted;
    let successorCommitted!: () => void;
    const committedLater = new Promise<void>(resolve => { successorCommitted = resolve; });
    let laterEscaped = false;
    const later = authority.accept({ actionId: 'later-target', body: 'new' },
      { onCommitted: successorCommitted }).then(result => { laterEscaped = true; return result; });
    await committedLater;
    assert.equal(laterEscaped, false);
    release(predecessorGate);
    const [predecessorResult, laterResult] = await Promise.all([predecessor, later]);
    assert.ok(laterResult.target > predecessorResult.target);
    const [orderedA, orderedB] = await Promise.all([
      authority.accept({ actionId: 'ordered-a', body: 'a' }),
      authority.accept({ actionId: 'ordered-b', body: 'b' }),
    ]);
    assert.ok(orderedA.target < orderedB.target);
    assert.notEqual(orderedA.inputId, orderedB.inputId);
    await assert.rejects(authority.accept({ actionId: 'sync-held', body: 'conflict' }), /IDEMPOTENCY_CONFLICT/);
    await assert.rejects(authority.accept({ actionId: 'lost-reply', body: 'three' },
      { crash: 'after-commit' }), /UNKNOWN_AFTER_WRITER_EXIT/);
    assert.equal(authority.terminal, true);
    await authority.close();

    // A new accepting lifetime resolves the exact ID instead of fabricating a second effect.
    authority = new Authority();
    await authority.start();
    const recovered = await authority.accept({ actionId: 'lost-reply', body: 'three' });
    const same = await authority.accept({ actionId: 'lost-reply', body: 'three' });
    assert.equal(recovered.inputId, same.inputId);
    assert.equal(recovered.actionId, 'lost-reply');
    const newAfterRestart = await authority.accept({ actionId: 'new-after-restart', body: 'four' });
    assert.notEqual(newAfterRestart.inputId, recovered.inputId);
    await assert.rejects(authority.accept({ actionId: 'lost-reply', body: 'different' }), /IDEMPOTENCY_CONFLICT/);
    await authority.close();

    authority = new Authority();
    await authority.start();
    const failedSyncGate = gate();
    let failedSyncWaiting!: () => void;
    const syncBlocked = new Promise<void>(resolve => { failedSyncWaiting = resolve; });
    const noReceipt = authority.accept({ actionId: 'sync-worker-dies', body: 'five' },
      { holdSync: failedSyncGate, onSyncWaiting: failedSyncWaiting });
    await syncBlocked;
    assert.equal(authority.ping().alive, true);
    await authority.sync.terminate();
    await assert.rejects(noReceipt, /SYNC_WORKER_EXIT/);
    assert.equal(authority.terminal, true);
    await authority.close();
    process.stdout.write('private command/commit/sync prototype: PASS (precommit death, held sync, later target behind predecessor, independent liveness, ordered targets, conflicts, lost reply, exact retry, sync-worker death)\n');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
