import { db } from "./state-database";
import { log } from "./log";
import { publishProviderFreeNotice } from "./provider-free-notice";

/** Stable key is a site plus target. The Inbox ledger deduplicates the notice across restarts. */
export function publishRetryBreakerNotice(input: {
  key: string;
  what: string;
  reason: string;
  sinceMs: number;
  restartSignal: string;
}): boolean {
  try {
    const recorded = publishProviderFreeNotice(db, {
      key: `retry:${input.key}`,
      kind: "retry_stopped",
      text: `${input.what} stopped after repeated failures. ${input.reason} It had been failing since ${new Date(input.sinceMs).toISOString()}. It will restart when ${input.restartSignal}.`,
      payload: { key: input.key, what: input.what, reason: input.reason, sinceMs: input.sinceMs, restartSignal: input.restartSignal },
    });
    log(recorded ? "error" : "info", "retry_breaker_notice", { key: input.key, recorded });
    return true;
  } catch (error) {
    log("error", "retry_breaker_notice_failed", { key: input.key, error: String(error) });
    return false;
  }
}
