import {randomUUID} from 'node:crypto';
import {db, executionChanged} from './state';
import type { ClaudeProviderRetry } from "./claude-code";

// Claude retrying its own API call is live process state, like a background wait: it
// cannot outlive the provider process that is doing the retrying.
const retries = new Map<number, ClaudeProviderRetry>();
const incarnation=randomUUID();
db.transaction(()=>{
  db.query('INSERT INTO provider_retry_incarnation(singleton,incarnation) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET incarnation=excluded.incarnation').run(incarnation);
  db.query('DELETE FROM provider_retry_observations').run();
})();

export function recordTurnProviderRetry(turnId: number, retry: ClaudeProviderRetry | null) {
  if(retry){
    db.query(`INSERT INTO provider_retry_observations(turn_id,incarnation,since_ms,attempt,max_retries,status,retry_at_ms)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(turn_id) DO UPDATE SET
      incarnation=excluded.incarnation,since_ms=excluded.since_ms,attempt=excluded.attempt,
      max_retries=excluded.max_retries,status=excluded.status,retry_at_ms=excluded.retry_at_ms`)
      .run(turnId,incarnation,retry.since,retry.attempt,retry.maxRetries,retry.status,retry.retryAt);
    retries.set(turnId,retry);
  }else{
    const had=retries.delete(turnId);
    const removed=db.query('DELETE FROM provider_retry_observations WHERE turn_id=?').run(turnId).changes;
    if(!had&&!removed)return;
  }
  executionChanged();
}

export function turnProviderRetry(turnId: number) {
  return retries.get(turnId) ?? null;
}

// A live run stuck retrying can be ended as an ordinary retryable failure so its next
// attempt starts at once, on the model he just chose. Only a run that is retrying
// registers one, and it applies only while no output has come back.
const restarts = new Map<number, () => boolean>();
export function registerTurnRetryRestart(turnId: number, restart: (() => boolean) | null) {
  if (restart) restarts.set(turnId, restart);
  else restarts.delete(turnId);
}
export function restartRetryingTurn(turnId: number) {
  return restarts.get(turnId)?.() ?? false;
}
