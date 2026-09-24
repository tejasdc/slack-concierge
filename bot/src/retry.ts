import { publishRetryBreakerNotice } from "./retry-breaker-notice";
import {
  nextRetry,
  retryDelayMs,
  withRetry as withRetryCore,
  type Retryable,
} from "./retry-core";

export { nextRetry, retryDelayMs, RetryBudgetExhaustedError } from "./retry-core";
export type { RetryErrorKind, Retryable } from "./retry-core";

/** Application retries add the provider-free Inbox notice to the storage-neutral retry primitive. */
export function withRetry<T>(input: Retryable<T>): Promise<T> {
  const callerExhausted = input.onBudgetExhausted;
  return withRetryCore({
    ...input,
    onBudgetExhausted: (error) => {
      publishRetryBreakerNotice({ key: `${input.operation}:${input.key}:${error.startedAtMs}`,
        what: input.operation, reason: String(error.lastError), sinceMs: error.startedAtMs,
        restartSignal: "the operation is explicitly retried after the failure is resolved" });
      callerExhausted?.(error);
    },
  });
}
