#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { Database } from 'bun:sqlite';
import { awaitingOutside, observedDatabase, observeStorageOperation, storageObservationFailures, withStorageReadBudget,StorageReadBudgetError,type StorageWork } from '../src/storage-observation';
import { ledgerRows } from '../src/ledger-rows';
import { startStorageIntervals, takeStorageInterval, observeSynchronousStorage } from '../src/storage-interval';

// No application state import: the fixture owns its database and has no production path.
const raw = new Database(':memory:');
const db = observedDatabase(raw);
try {
  db.exec('CREATE TABLE facts(id INTEGER PRIMARY KEY, text TEXT)');
  db.query('INSERT INTO facts VALUES (?, ?)').run(1, 'é');
  db.query('INSERT INTO facts VALUES (?, ?)').run(2, 'second');
  let snapshot: StorageWork | undefined;
  observeStorageOperation('read', () => {
    assert.deepEqual(db.query('SELECT * FROM facts ORDER BY id').all(), [{id:1,text:'é'},{id:2,text:'second'}]);
    assert.equal((db.query('SELECT text FROM facts WHERE id=?').get(1) as any).text, 'é');
  }, value => { snapshot = value; });
  assert.equal(snapshot!.db_calls, 2);
  assert.equal(snapshot!.db_rows, 3);
  assert.equal(snapshot!.db_result_bytes, 26);
  assert.match(snapshot!.db_slowest_fingerprint!, /^[a-f0-9]{16}$/);
  const budget={maxCalls:3,maxRows:3,maxResultBytes:100};
  const bounded=(read:()=>unknown)=>observeStorageOperation('bounded',()=>withStorageReadBudget(budget,read),()=>{});
  assert.throws(()=>bounded(()=>db.query('SELECT * FROM facts').all()),StorageReadBudgetError);
  assert.throws(()=>bounded(()=>db.query('DELETE FROM facts').run()),StorageReadBudgetError);
  assert.throws(()=>bounded(()=>{for(let i=0;i<4;i++)db.query('SELECT id FROM facts WHERE id=1').get();}),StorageReadBudgetError);
  assert.equal((bounded(()=>db.query('SELECT * FROM facts ORDER BY id LIMIT ?').all(2)) as any[]).length,2);

  // An early exit still goes through the canonical finalizing iterator.
  observeStorageOperation('iteration', () => {
    for (const row of ledgerRows<{id:number}>(db, 'SELECT id FROM facts')) { assert.equal(row.id, 1); break; }
  }, value => { snapshot = value; });
  assert.equal(snapshot!.db_calls, 1);
  assert.equal(snapshot!.db_rows, 1);
  db.transaction(() => db.query('INSERT INTO facts VALUES (?, ?)').run(3, 'third')).immediate();

  const failure = new Error('operation failed');
  assert.throws(() => observeStorageOperation('failure', () => { throw failure; }, () => {}), error => error === failure);
  observeStorageOperation('query-failure', () => {
    assert.throws(() => db.query('INSERT INTO facts VALUES (?, ?)').run(1, 'duplicate'));
  }, value => { snapshot = value; });
  assert.equal(snapshot!.db_errors, 1);

  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const isolated: StorageWork[] = [];
  const first = observeStorageOperation('first', async () => {
    db.query('SELECT id FROM facts WHERE id=1').get();
    await barrier;
    db.query('SELECT id FROM facts WHERE id=2').get();
  }, value => { isolated[0] = value; });
  await observeStorageOperation('second', async () => {
    db.query('SELECT id FROM facts').all();
    release();
  }, value => { isolated[1] = value; });
  await first;
  assert.equal(isolated[0]!.db_calls, 2);
  assert.equal(isolated[1]!.db_calls, 1);
  assert.equal(isolated[0]!.db_rows, 2);
  assert.equal(isolated[1]!.db_rows, 3);

  // Waits on another process overlap: a search fans its archive retention proofs out to
  // Thinkering together. The request was away for as long as at least one wait was pending,
  // so overlapping waits, side by side or nested, count once as their union and waits that
  // follow one another add up. Counting only the first sibling read a 29 s proof beside a
  // 3 s one as 26 s of owner slowness (work-flow supervisor incident fa772103, 2026-10-15).
  const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  let waited: StorageWork | undefined;
  const waitingBegan = performance.now();
  await observeStorageOperation('waits', async () => {
    await Promise.all([
      awaitingOutside(() => pause(20)),
      awaitingOutside(() => pause(120)),
      awaitingOutside(() => awaitingOutside(() => pause(60))),
    ]);
    await awaitingOutside(() => pause(40));
  }, value => { waited = value; });
  const waitingWall = performance.now() - waitingBegan;
  assert.ok(waited!.awaited_ms >= 150, `overlapping waits counted as their union, then the next one added: ${waited!.awaited_ms} ms`);
  assert.ok(waited!.awaited_ms <= waitingWall + 1, `awaited never exceeds wall time: ${waited!.awaited_ms} of ${waitingWall} ms`);

  const failures = storageObservationFailures();
  assert.equal(observeStorageOperation('sink-failure', () => 42, () => { throw new Error('sink down'); }), 42);
  assert.equal(storageObservationFailures(), failures + 1);

  // The same observation boundary must see background calls and the transaction's finish,
  // without an HTTP scope, without counting nested work twice, and without changing rollback.
  startStorageIntervals();
  const begin = performance.now();
  db.transaction(() => {
    db.query('SELECT id FROM facts WHERE id=1').get();
    observeSynchronousStorage('statement', () => '0123456789abcdef', () => Bun.sleepSync(30));
  }).immediate();
  const wall = performance.now() - begin;
  const occupied = takeStorageInterval();
  assert.equal(occupied.transactions, 1);
  assert.ok(occupied.occupied_ms >= 30 && occupied.occupied_ms <= wall + 1);
  assert.equal(occupied.slowest?.kind, 'transaction');
  assert.ok(occupied.slowest!.stack.length <= 8);
  assert.equal(takeStorageInterval().calls, 0);
  db.query('SELECT id FROM facts WHERE id=1').get();
  assert.ok(takeStorageInterval().calls >= 1);
  assert.throws(() => db.transaction(() => {
    db.query('INSERT INTO facts VALUES (?, ?)').run(5, 'rollback');
    throw failure;
  }).exclusive(), error => error === failure);
  assert.equal(db.query('SELECT id FROM facts WHERE id=5').get(), null);
  takeStorageInterval();
  assert.equal(observeSynchronousStorage('statement', () => { throw failure; }, () => { Bun.sleepSync(30); return 42; }), 42);
  assert.equal(takeStorageInterval().observation_failures, 1);

  // Representative large content detects instrumentation that copies whole result payloads.
  const payload = 'x'.repeat(8 * 1024 * 1024);
  db.query('INSERT INTO facts VALUES (?, ?)').run(4, payload);
  let rawMs = 0, observedMs = 0;
  for (let i = 0; i < 10; i++) {
    let start = performance.now();
    raw.query('SELECT text FROM facts WHERE id=4').get();
    rawMs += performance.now() - start;
    start = performance.now();
    observeStorageOperation('large', () => db.query('SELECT text FROM facts WHERE id=4').get(), value => { snapshot = value; });
    observedMs += performance.now() - start;
  }
  assert.equal(snapshot!.db_result_bytes, payload.length);
  console.log(JSON.stringify({check:'storage-observation',status:'passed',large_bytes:payload.length,
    raw_mean_ms:rawMs/10,observed_mean_ms:observedMs/10}));
} finally { db.close(true); }
