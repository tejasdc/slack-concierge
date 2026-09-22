import { executionChanged } from "./state";
import type { ClaudeProviderRetry } from "./claude-code";

// Claude retrying its own API call is live process state, like a background wait: it
// cannot outlive the provider process that is doing the retrying.
const retries = new Map<number, ClaudeProviderRetry>();

export function recordTurnProviderRetry(turnId: number, retry: ClaudeProviderRetry | null) {
  if (retry) retries.set(turnId, retry);
  else if (!retries.delete(turnId)) return;
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
