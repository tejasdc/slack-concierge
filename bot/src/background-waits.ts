import { executionChanged } from "./state";
import type { ClaudeBackgroundWait } from "./claude-code";

// A run waiting on its own background work lives only as long as this process, so
// its wait is process state: it cannot outlive the provider process that holds it.
const waits = new Map<number, ClaudeBackgroundWait>();

export function recordTurnBackgroundWait(turnId: number, wait: ClaudeBackgroundWait | null) {
  if (wait) waits.set(turnId, wait);
  else if (!waits.delete(turnId)) return;
  executionChanged();
}

export function turnBackgroundWait(turnId: number) {
  const wait = waits.get(turnId);
  return wait ? { since: new Date(wait.since).toISOString(), tasks: [...wait.tasks] } : null;
}
