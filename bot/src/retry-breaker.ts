import { db } from "./state-database";
import { publishRetryBreakerNotice, resolveRetryNotices } from "./retry-breaker-notice";
import { createRetryBreaker } from "./retry-breaker-core";

export type { RetryDecision, RetryFailure, RetrySite } from "./retry-breaker-core";

const applicationRetryBreaker = createRetryBreaker(db, publishRetryBreakerNotice, (key) => { resolveRetryNotices(key); });
export const recordRetryFailure = applicationRetryBreaker.recordRetryFailure;
export const clearRetryBreaker = applicationRetryBreaker.clearRetryBreaker;
export const retryBreakerDueForProbe = applicationRetryBreaker.retryBreakerDueForProbe;
