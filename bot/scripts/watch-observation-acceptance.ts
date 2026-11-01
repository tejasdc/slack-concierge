import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

// Hold the cursor store's writer, then prove the accepting loop and main ledger can proceed.
const dir = mkdtempSync(join(tmpdir(), 'watch-observation-'));
process.env.CONCIERGE_STATE_DIR = dir;
process.env.CONCIERGE_TEST_MODE = '1';
process.env.CONCIERGE_WATCH_OBSERVATION_STALL_CHECK = '1';
const main = new Database(join(dir, 'state.db'));
main.exec('PRAGMA journal_mode=WAL; CREATE TABLE owner_check(value INTEGER); INSERT INTO owner_check VALUES(0)');
const partial = new Database(join(dir, 'watch-observations.db'));
partial.close();
const { loadWatchObservationCursors, startWatchObservationWorker, waitForWatchObservationWorker, recordWatchObservation,
  observationForWatch, stopWatchObservationWorker } = await import('../src/watch-observation');
loadWatchObservationCursors(['watch-check']);
startWatchObservationWorker();
await waitForWatchObservationWorker();
const sidecar = new Database(join(dir, 'watch-observations.db'));
const watch = { watch_id: 'watch-check', created_at_ms: 0, last_observed_ms: 0, gaps_json: '[]' };
let ticks = 0;
const timer = setInterval(() => { ticks++; }, 50);
try {
  sidecar.exec('BEGIN IMMEDIATE');
  const started = performance.now();
  const blocked = recordWatchObservation(watch, 5_000, 15_000);
  main.query('UPDATE owner_check SET value=1').run();
  await assert.rejects(blocked, /locked|busy/i);
  const waited = performance.now() - started;
  assert(waited >= 2_000 && waited < 4_500, `controlled sidecar wait ${waited}ms`);
  assert(ticks >= 20, `accepting loop advanced only ${ticks} times while cursor store waited`);
  assert.equal((main.query('SELECT value FROM owner_check').get() as { value: number }).value, 1);
  sidecar.exec('ROLLBACK');
  await recordWatchObservation(watch, 20_000, 15_000);
  const cursor = observationForWatch(watch);
  assert.equal(cursor.lastObservedAt, 20_000);
  assert.deepEqual(JSON.parse(cursor.gapsJson), [{ fromMs: 0, toMs: 20_000 }]);
  loadWatchObservationCursors(['watch-check']);
  assert.deepEqual(observationForWatch(watch), cursor);
  console.log(JSON.stringify({ check: 'watch-observation-isolation', status: 'passed', wait_ms: Math.round(waited),
    loop_ticks: ticks, owner_write_during_stall: true, conservative_gap: true, restart_cursor_recovered: true }));
} finally {
  if (sidecar.inTransaction) sidecar.exec('ROLLBACK');
  clearInterval(timer);
  stopWatchObservationWorker();
  sidecar.close();
  main.close();
  rmSync(dir, { recursive: true, force: true });
}
