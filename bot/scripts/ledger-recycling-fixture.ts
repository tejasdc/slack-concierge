import { strict as assert } from 'node:assert';
import { mkdtempSync, openSync, fstatSync, statSync, readSync, closeSync, rmSync, fdatasyncSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { Database } from 'bun:sqlite';
import {ledgerWriteResults} from '../src/ledger-write-results';
import { LedgerAdmission } from '../src/ledger-admission';

// Disposable only: never imports application state/startup or opens a production path.
const folder = mkdtempSync(join(tmpdir(), 'concierge-ledger-recycle-'));
const databasePath = join(folder, 'fixture.db');
const owner = ledgerWriteResults(new Database(databasePath));
owner.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=NORMAL; CREATE TABLE application(value); INSERT INTO application VALUES(1); PRAGMA user_version=-23');
const fd = openSync(`${databasePath}-wal`, 'r');
const identity = fstatSync(fd);
const generation = () => { const b = Buffer.alloc(32); assert.equal(readSync(fd, b, 0, 32, 0), 32); return b.subarray(12, 24).toString('hex'); };
const gate = new LedgerAdmission();
gate.enable();
let worker: Worker;
function start() {
  const w = new Worker(new URL('./ledger-recycling-hook-worker.ts', import.meta.url), {
    workerData: { role: 'checkpoint', workerId:crypto.randomUUID(), databasePath, quietBytes: 1, forceBytes: 1, quietPressure: 10, intervalMs: 10 },
  });
  w.postMessage({kind:'enable'});
  return w;
}
function next(w: Worker, kind: string) {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timeout: ${kind}`)); }, 15000);
    const onMessage = (reply: any) => {
      if (reply.kind === 'recycle-error') { cleanup(); reject(new Error(reply.error)); }
      else if (reply.kind === kind) { cleanup(); resolve(reply); }
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => { clearTimeout(timer); w.off('message', onMessage); w.off('error', onError); };
    w.on('message', onMessage); w.on('error', onError);
  });
}
const report: any[] = [];
async function retire(w:Worker){
 const completed=next(w,'ledger-closed');
 const ended=new Promise(resolve=>w.once('exit',resolve));
 w.postMessage({kind:'retire',retirementId:1});
 const proof=await completed;assert.equal(proof.pendingStatements,0);assert.equal(proof.nativeClosed,true);
 await ended;
}
try {
  worker = start();
  for (let cycle = 1; cycle <= 3; cycle++) {
    if (cycle > 1) await gate.run(() => owner.exec('UPDATE application SET value=value+1'));
    await next(worker, 'maintenance-request');
    const before = generation();
    const changes = (owner.query('SELECT total_changes() n').get() as any).n;
    const reader = new Database(databasePath,{readonly:true});
    reader.exec('BEGIN');
    const old = (reader.query('SELECT value FROM application').get() as any).value;
    let resumed = false;
    let held: Promise<void>;
    const maintenance = gate.maintain(async epoch => {
      let workerCompleted = false;
      const completed = next(worker, 'recycled');
      void completed.then(() => { workerCompleted = true; });
      worker.postMessage({ kind: 'recycle', epoch });
      // A real old SQLite snapshot holds restart readiness while memory-only owner control
      // continues. No native connection or WAL descriptor is replaced between phases.
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(gate.snapshot().phase, 'maintenance');
      assert.equal(resumed, false);
      assert.equal(workerCompleted, false, 'RESTART waits for the finite old WAL reader');
      assert.equal((owner.query('SELECT total_changes() n').get() as any).n, changes);
      assert.equal((reader.query('SELECT value FROM application').get() as any).value, old);
      reader.exec('COMMIT'); reader.close();
      const reply = await completed;
      assert.equal(reply.epoch, epoch);
      assert.notEqual(generation(), before);
      assert.equal(reply.primedFrames, 1);
      assert.equal((owner.query('PRAGMA user_version').get() as any).user_version, -23);
      assert.equal((owner.query('SELECT total_changes() n').get() as any).n, changes);
      // Lost reply after possible commit: discard this completed worker, await its actual
      // lifetime, and repeat the entire lifecycle on a new worker under this SAME grant.
      if (cycle === 2) {
        await retire(worker);
        assert.equal((owner.query('SELECT value FROM application').get() as any).value, old);
        assert.equal(fstatSync(fd).nlink, 1);
        assert.equal(fstatSync(fd).ino, identity.ino);
        worker = start();
        const recovered = next(worker, 'recycled');
        worker.postMessage({ kind: 'recycle', epoch });
        assert.equal((await recovered).epoch, epoch);
        assert.equal(gate.snapshot().epoch, epoch);
        assert.equal(gate.snapshot().phase, 'maintenance');
      }
      worker.postMessage({ kind: 'resumed', epoch });
    });
    held = gate.run(() => { resumed = true; owner.exec('UPDATE application SET value=value+1'); });
    await maintenance;
    const primed = generation();
    await held;
    // The original lifetime witness remains usable for later committed application writes.
    fdatasyncSync(fd);
    assert.equal(generation(), primed, 'next owner write uses worker-primed generation');
    const fresh = new Database(databasePath,{readonly:true});
    assert.equal((fresh.query('SELECT value FROM application').get() as any).value, old + 1);
    fresh.close();
    const pathIdentity = statSync(`${databasePath}-wal`);
    assert.equal(pathIdentity.ino, identity.ino); assert.equal(pathIdentity.dev, identity.dev);
    assert.equal(fstatSync(fd).ino, identity.ino);
    report.push({ cycle, sameOwnerConnection: true, originalWalDescriptor: true, generation: primed,
      bytes: pathIdentity.size, allocatedBytes: pathIdentity.blocks * 512, applicationChanges: changes,
      oldSnapshot: old, workerFailureRecovery: cycle === 2 });
  }
  // Own-error exit must close its SQLite registry entry before Bun's VM sweep.
  // If cleanup checkpointed/backfilled/truncated the primed generation, NOOP or
  // this original descriptor/header check fails even after the exit is delivered.
  const beforeExit=generation();
  const ended=new Promise<void>(resolve=>worker.once('exit',()=>resolve()));
  worker.on('error',()=>{});
  worker.postMessage({kind:'fixture-own-error'});
  await ended;
  const retained=owner.query('PRAGMA wal_checkpoint(NOOP)').get() as any;
  assert.ok(retained.log>0);assert.equal(retained.checkpointed,0);
  assert.equal(generation(),beforeExit);
  owner.exec('UPDATE application SET value=value+1');
  assert.equal(generation(),beforeExit);
  report.push({ownErrorExitHook:true,originalWalDescriptor:true,unbackfilledGenerationPreserved:true});
  console.log(JSON.stringify({ bun: Bun.version, sqlite: owner.query('SELECT sqlite_version() v').get(), report,
    limits: 'Native generation/reader/descriptor and gate composition only. No held-syscall latch, production receipts, whole caller coverage, power-loss or crash durability claim.' }, null, 2));
} finally {
  if (worker! && worker.threadId!==-1) await retire(worker);
  closeSync(fd); owner.close(); rmSync(folder, { recursive: true, force: true });
}
