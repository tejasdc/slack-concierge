import { clearRetryBreaker, recordRetryFailure, type RetrySite } from "./retry-breaker";
import { createDatabaseRetry, isTransientDatabaseError } from "./database-retry";
import { nextRetry, withRetry } from "./retry";
import { RETRY_POLICY_FOR_SITE } from "./retry-policies";

export { isTransientDatabaseError } from "./database-retry";
export const retryTransientDatabaseOperation = createDatabaseRetry(withRetry);

export interface DurableNoticeRow {
  noticeStatus: "pending" | "sending" | "delivered" | "parked";
  attempts: number;
  nextAttemptMs: number | null;
  startedAtMs?: number;
}

export function createKeyedTaskScheduler(
  onError: (key: string, error: unknown) => void = () => {},
) {
  const activeTasks = new Map<string, Promise<void>>();
  return (key: string, run: () => Promise<void>) => {
    const existing = activeTasks.get(key);
    if (existing) return existing;
    const task = run()
      .catch((error) => onError(key, error))
      .finally(() => {
        if (activeTasks.get(key) === task) activeTasks.delete(key);
      });
    activeTasks.set(key, task);
    return task;
  };
}

export async function runDurableNoticeWorker<Row extends DurableNoticeRow>(input: {
  load: () => Row | null;
  claim: (nowMs: number) => Row | null;
  deliver: (row: Row) => Promise<void>;
  markDelivered: () => void;
  markRetry: (error: string, nextAttemptMs: number) => void;
  markParked: (error: string) => void;
  isRetryable: (error: unknown) => boolean;
  isPersistenceRetryable?: (error: unknown) => boolean;
  shouldStop?: () => boolean;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  initialDelayMs?: number;
  maximumDelayMs?: number;
  maximumAttempts?: number;
  retrySite?: RetrySite;
  onBreakerTrip?: (error: unknown, sinceMs: number) => void;
  breakerKey?: string;
  breakerWhat?: string;
}): Promise<"delivered" | "stopped" | "permanent_failure"> {
  const now = input.now || Date.now;
  const wait = input.wait || ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  const retryPersistence = <T>(operation: () => T) => retryTransientDatabaseOperation({
    operation,
    isRetryable: input.isPersistenceRetryable,
    shouldStop: input.shouldStop,
    wait,
  });

  while (!input.shouldStop?.()) {
    const loaded = await retryPersistence(input.load);
    if (loaded.stopped) return "stopped";
    const current = loaded.value;
    if (!current || current.noticeStatus === "parked") return "permanent_failure";
    if (current.noticeStatus === "delivered") return "delivered";
    if (current.noticeStatus === "sending") {
      await wait(50);
      continue;
    }

    const dueAt = current.nextAttemptMs || 0;
    if (dueAt > now()) {
      await wait(dueAt - now());
      continue;
    }

    const claim = await retryPersistence(() => input.claim(now()));
    if (claim.stopped) return "stopped";
    const claimed = claim.value;
    if (!claimed) continue;
    let deliveryError: unknown = null;
    try {
      await input.deliver(claimed);
    } catch (error) {
      deliveryError = error;
    }
    if (deliveryError === null) {
      const delivered = await retryPersistence(input.markDelivered);
      if (delivered.stopped) return "stopped";
      if (input.breakerKey) clearRetryBreaker(input.breakerKey);
      return "delivered";
    }
    const retryable = input.isRetryable(deliveryError);
    const failure = { kind: retryable ? "transient" as const : "permanent" as const, reason: String(deliveryError),
      restartSignal: "the notice is retried explicitly" };
    const decision = input.breakerKey ? recordRetryFailure({ key: input.breakerKey,
      site: input.retrySite ?? "notice", what: input.breakerWhat ?? "A service notice", failure }) : nextRetry({
      policy: RETRY_POLICY_FOR_SITE[input.retrySite ?? "notice"], attempt: claimed.attempts,
      startedAtMs: claimed.startedAtMs ?? now(), nowMs: now(), classification: failure.kind,
    });
    if (decision.action !== "retry" || claimed.attempts >= (input.maximumAttempts ?? RETRY_POLICY_FOR_SITE[input.retrySite ?? "notice"].maxAttempts)) {
      const parked = await retryPersistence(() => input.markParked(String(deliveryError)));
      if (parked.stopped) return "stopped";
      input.onBreakerTrip?.(deliveryError, now());
      return "permanent_failure";
    }
    const retryAtMs = decision.atMs;
    const retried = await retryPersistence(() => input.markRetry(String(deliveryError), retryAtMs));
    if (retried.stopped) return "stopped";
  }
  return "stopped";
}
