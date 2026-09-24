import { db } from "./state-database";
import { publishRetryBreakerNotice } from "./retry-breaker-notice";
import { createRetryBreaker } from "./retry-breaker-core";

export type { RetryDecision, RetryFailure, RetrySite } from "./retry-breaker-core";

const applicationRetryBreaker = createRetryBreaker(db, publishRetryBreakerNotice);
export const recordRetryFailure = applicationRetryBreaker.recordRetryFailure;
export const clearRetryBreaker = applicationRetryBreaker.clearRetryBreaker;
export const retryBreakerDueForProbe = applicationRetryBreaker.retryBreakerDueForProbe;
