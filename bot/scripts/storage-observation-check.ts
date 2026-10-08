#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { Database } from 'bun:sqlite';
import { observedDatabase, observeStorageOperation, storageObservationFailures, type StorageWork } from '../src/storage-observation';
import { ledgerRows } from '../src/ledger-rows';

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

  const failures = storageObservationFailures();
  assert.equal(observeStorageOperation('sink-failure', () => 42, () => { throw new Error('sink down'); }), 42);
  assert.equal(storageObservationFailures(), failures + 1);

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
