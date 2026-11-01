import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

// Exercise the real worker and SQLite lock on owned scratch state. A locked poll must leave
// the accepting JavaScript loop free and the next poll must report its missing coverage.
const dir = mkdtempSync(join(tmpdir(), 'watch-observation-'));
process.env.CONCIERGE_STATE_DIR = dir;
process.env.CONCIERGE_TEST_MODE = '1';
process.env.CONCIERGE_WATCH_OBSERVATION_STALL_CHECK = '1';
const path = join(dir, 'state.db');
const db = new Database(path);
db.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE watches(watch_id TEXT PRIMARY KEY,state TEXT,last_observed_ms INTEGER,
    created_at_ms INTEGER NOT NULL,gaps_json TEXT NOT NULL);
  INSERT INTO watches VALUES('watch-check','accepted',0,0,'[]')`);
const { recordWatchObservation, stopWatchObservationWorker } = await import('../src/watch-observation');
let ticks = 0;
const timer = setInterval(() => { ticks++; }, 50);
try {
  db.exec('BEGIN IMMEDIATE');
  const started = performance.now();
  await assert.rejects(recordWatchObservation('watch-check', 5_000, 15_000), /locked|busy/i);
  const waited = performance.now() - started;
  assert(waited >= 2_000 && waited < 4_500, `controlled lock wait ${waited}ms`);
  assert(ticks >= 20, `accepting loop advanced only ${ticks} times while worker waited`);
  db.exec('ROLLBACK');
  await recordWatchObservation('watch-check', 20_000, 15_000);
  const row = db.query('SELECT state,last_observed_ms,gaps_json FROM watches WHERE watch_id=?').get('watch-check') as
    { state: string; last_observed_ms: number; gaps_json: string };
  assert.equal(row.state, 'observing');
  assert.equal(row.last_observed_ms, 20_000);
  assert.deepEqual(JSON.parse(row.gaps_json), [{ fromMs: 0, toMs: 20_000 }]);
  console.log(JSON.stringify({ check: 'watch-observation-isolation', status: 'passed', wait_ms: Math.round(waited), loop_ticks: ticks,
    conservative_gap: true }));
} finally {
  if (db.inTransaction) db.exec('ROLLBACK');
  clearInterval(timer);
  stopWatchObservationWorker();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
