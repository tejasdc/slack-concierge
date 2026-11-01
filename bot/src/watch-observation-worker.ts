import { parentPort, workerData } from 'node:worker_threads';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';

type Cursor = { watch_id: string; last_observed_ms: number; gaps_json: string };
type Request = { id: number; watchId: string; observedAt: number; gapMs: number;
  initialAt: number; initialGaps: string };
const path = join(workerData.stateDir as string, 'watch-observations.db');
const db = new Database(path, { create: true });
const controlledStall = process.env.CONCIERGE_TEST_MODE === '1' && path.startsWith('/tmp/')
  && process.env.CONCIERGE_WATCH_OBSERVATION_STALL_CHECK === '1';
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=${controlledStall ? 2500 : 0};
  CREATE TABLE IF NOT EXISTS cursors(watch_id TEXT PRIMARY KEY, last_observed_ms INTEGER NOT NULL, gaps_json TEXT NOT NULL)`);
const get = db.query('SELECT watch_id,last_observed_ms,gaps_json FROM cursors WHERE watch_id=?');
const put = db.query(`INSERT INTO cursors(watch_id,last_observed_ms,gaps_json) VALUES(?,?,?)
  ON CONFLICT(watch_id) DO UPDATE SET last_observed_ms=excluded.last_observed_ms,gaps_json=excluded.gaps_json`);
// A watch expires within 30 days. Older cursors are no longer needed even if an expired
// watch has not yet been settled; dropping one only widens its eventual gap.
if (!controlledStall) db.query('DELETE FROM cursors WHERE last_observed_ms<?').run(Date.now() - 31 * 24 * 60 * 60_000);
parentPort!.postMessage({ type: 'ready' });

parentPort!.on('message', (request: Request) => {
  const started = performance.now();
  try {
    const prior = get.get(request.watchId) as Cursor | null;
    const last = Math.max(prior?.last_observed_ms ?? request.initialAt, request.initialAt);
    const gaps = JSON.parse(prior?.gaps_json ?? request.initialGaps) as { fromMs: number; toMs: number }[];
    if (request.observedAt > last) {
      if (request.observedAt - last > request.gapMs) gaps.push({ fromMs: last, toMs: request.observedAt });
      put.run(request.watchId, request.observedAt, JSON.stringify(gaps));
    }
    parentPort!.postMessage({ id: request.id, durationMs: performance.now() - started,
      cursor: { watch_id: request.watchId, last_observed_ms: Math.max(last, request.observedAt), gaps_json: JSON.stringify(gaps) } });
  } catch (error) {
    parentPort!.postMessage({ id: request.id, durationMs: performance.now() - started,
      error: error instanceof Error ? error.message : String(error) });
  }
});
