import { strict as assert } from 'node:assert';
import { mkdtempSync, openSync, readSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { Database } from 'bun:sqlite';
import { ledgerWriteResults } from '../src/ledger-write-results';
import { LedgerAdmission } from '../src/ledger-admission';

// Disposable only. The schedule that defeated PASSIVE tail-finishing on 2026-11-16 (60 commits/s,
// a commit landing while every checkpoint copies): the owner commits through admission while the
// actual checkpoint worker runs its fixed-tail RESTART and header primer. Recycling must converge,
// every queued commit must land exactly once, and the owner loop must keep turning.
const SECONDS = Number(process.env.FIXTURE_SECONDS ?? 3), RATE = 60;
const folder = mkdtempSync(join(tmpdir(), 'concierge-ledger-recycle-concurrent-'));
const databasePath = join(folder, 'fixture.db');
const owner = ledgerWriteResults(new Database(databasePath));
owner.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=NORMAL; CREATE TABLE application(id INTEGER PRIMARY KEY, body BLOB); PRAGMA user_version=7');
const fd = openSync(`${databasePath}-wal`, 'r');
const generation = () => { const b = Buffer.alloc(32); assert.equal(readSync(fd, b, 0, 32, 0), 32); return b.subarray(12, 24).toString('hex'); };
const gate = new LedgerAdmission();
gate.enable();
const worker = new Worker(new URL('./ledger-recycling-hook-worker.ts', import.meta.url), {
  workerData: { role: 'checkpoint', workerId: crypto.randomUUID(), databasePath, quietBytes: 64 * 1024, forceBytes: 1 << 30, quietPressure: 1000, intervalMs: 200 },
});
const replies: Array<(reply: any) => void> = [];
let maintenancePending = false, cycles = 0, maintenanceMs: number[] = [];
const body = new Uint8Array(3000);
worker.on('message', (reply: any) => {
  if (reply.kind === 'maintenance-request' && !maintenancePending) {
    maintenancePending = true;
    const started = performance.now();
    void gate.maintain(async epoch => {
      const done = new Promise<any>((resolve, reject) => { replies.push(r => r.kind === 'recycle-error' ? reject(new Error(r.error)) : resolve(r)); });
      worker.postMessage({ kind: 'recycle', epoch });
      const result = await done;
      assert.equal(result.epoch, epoch);
      worker.postMessage({ kind: 'resumed', epoch });
    }).then(() => { cycles++; maintenanceMs.push(performance.now() - started); maintenancePending = false; });
  } else if (reply.kind === 'recycled' || reply.kind === 'recycle-error') replies.shift()?.(reply);
});
worker.postMessage({ kind: 'enable' });

let submitted = 0, committed = 0, rewinds = 0, lastGeneration = generation(), maxLagMs = 0, lastTick = performance.now();
const loop = setInterval(() => { const now = performance.now(); maxLagMs = Math.max(maxLagMs, now - lastTick - 5); lastTick = now; }, 5);
const writes = setInterval(() => {
  submitted++;
  void gate.run(() => { owner.query('INSERT INTO application(body) VALUES (?)').run(body); committed++; });
  const now = generation(); if (now !== lastGeneration) { rewinds++; lastGeneration = now; }
}, 1000 / RATE);
try {
  await new Promise(resolve => setTimeout(resolve, SECONDS * 1000));
  clearInterval(writes);
  await gate.run(() => {});
  await gate.pendingMaintenance();
  clearInterval(loop);
  const rows = (owner.query('SELECT count(*) n FROM application').get() as any).n;
  assert.equal(rows, submitted, 'every admitted commit landed exactly once');
  assert.equal(committed, submitted);
  assert.equal((owner.query('PRAGMA user_version').get() as any).user_version, 7, 'primer preserved user_version');
  assert.ok(cycles >= 3, `recycling converged repeatedly under ${RATE} commits/s (cycles=${cycles})`);
  assert.ok(rewinds >= 3, `WAL generation changed repeatedly (rewinds=${rewinds})`);
  const sorted = [...maintenanceMs].sort((a, b) => a - b);
  console.log(JSON.stringify({ fixture: 'ledger-recycling-concurrent', bun: Bun.version, sqlite: (owner.query('SELECT sqlite_version() v').get() as any).v,
    seconds: SECONDS, rate: RATE, submitted, rows, cycles, rewinds, maintenanceMsP50: Math.round(sorted[sorted.length >> 1] ?? 0), maintenanceMsMax: Math.round(sorted.at(-1) ?? 0),
    ownerLoopMaxLagMs: Math.round(maxLagMs),
    limits: 'Disposable database on this host disk; loop lag includes host load. No held-syscall latch, power-loss or production claim.' }));
} finally {
  clearInterval(writes); clearInterval(loop);
  const closed = new Promise<void>(resolve => worker.once('exit', () => resolve()));
  worker.on('message', (m: any) => { if (m.kind === 'ledger-closed') {} });
  worker.postMessage({ kind: 'retire', retirementId: 1 });
  await closed;
  closeSync(fd); owner.close(); rmSync(folder, { recursive: true, force: true });
}
