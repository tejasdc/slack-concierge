import { parentPort, workerData } from 'node:worker_threads';
import { Database } from 'bun:sqlite';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { ledgerAccess } from './ledger-access-policy';
import { ledgerWriteResults } from './ledger-write-results';

/** Routine poll cursors are evidence for gap reporting, not watch outcomes. They may wait on
 * SQLite or disk here, but never on the accepting owner's event loop. */
type Request = { id: number; watchId: string; observedAt: number; gapMs: number };
const databasePath = workerData.databasePath as string;
ledgerAccess(realpathSync(dirname(databasePath)), Bun.main, false);
const db = ledgerWriteResults(new Database(databasePath, { readwrite: true }));
// A scratch-state acceptance probe can hold the writer for two seconds. Production cursors
// refuse lock contention immediately; their next successful poll records the possible gap.
const controlledStall = process.env.CONCIERGE_TEST_MODE === '1' && realpathSync(databasePath).startsWith('/tmp/')
  && process.env.CONCIERGE_WATCH_OBSERVATION_STALL_CHECK === '1';
db.exec(`PRAGMA busy_timeout=${controlledStall ? 2500 : 0}; PRAGMA synchronous=NORMAL`);
const update = db.query(`UPDATE watches SET state='observing', last_observed_ms=?,
  gaps_json=CASE WHEN ?-COALESCE(last_observed_ms,created_at_ms)>?
    THEN json_insert(gaps_json,'$[#]',json_object('fromMs',COALESCE(last_observed_ms,created_at_ms),'toMs',?))
    ELSE gaps_json END
  WHERE watch_id=? AND state IN ('accepted','observing')
    AND ? > COALESCE(last_observed_ms,created_at_ms)`);

parentPort!.on('message', (request: Request) => {
  const started = performance.now();
  try {
    update.run(request.observedAt, request.observedAt, request.gapMs, request.observedAt,
      request.watchId, request.observedAt);
    parentPort!.postMessage({ id: request.id, durationMs: performance.now() - started });
  } catch (error) {
    parentPort!.postMessage({ id: request.id, durationMs: performance.now() - started,
      error: error instanceof Error ? error.message : String(error) });
  }
});
