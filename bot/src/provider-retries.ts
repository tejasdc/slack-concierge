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
