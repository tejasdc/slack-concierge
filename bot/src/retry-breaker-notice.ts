import { db } from "./state-database";
import { log } from "./log";
import { noticeTime, publishProviderFreeNotice, SERVICE_NOTICE_SCOPE } from "./provider-free-notice";
import { fileServiceNotices, settleServiceNotice } from "./session-topics";

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
      text: `${input.what} stopped after repeated failures. ${input.reason} It had been failing since ${noticeTime(db, input.sinceMs)}. It will start again by itself when ${input.restartSignal}.`,
      payload: { key: input.key, what: input.what, reason: input.reason, sinceMs: input.sinceMs, restartSignal: input.restartSignal },
    });
    log(recorded ? "error" : "info", "retry_breaker_notice", { key: input.key, recorded });
    // The notice has its thread before its notification can be tapped.
    if (recorded) fileServiceNotices();
    return true;
  } catch (error) {
    log("error", "retry_breaker_notice_failed", { key: input.key, error: String(error) });
    return false;
  }
}

/**
 * A notice whose condition has cleared says so and closes, rather than sitting in his threads
 * as something to read (Tejas, 2026-09-25: "I don't know what is happening if the Codex
 * problem is still happening or not"). Called with a breaker key the moment that breaker is
 * cleared by a success, and at startup with no key for every retry notice whose breaker no
 * longer exists — the clear happened while nothing recorded it, or before this existed. Each
 * notice is settled once: a service post in its thread saying it is running again, and the
 * thread closed, which ends its reading item.
 */
export function resolveRetryNotices(breakerKey?: string): number {
  const rows = db.query(`SELECT input.id, event.payload_json FROM session_inputs input
    JOIN session_owner_events event ON event.input_id=input.id AND event.kind='retry_stopped'
    WHERE input.scope=? AND input.id LIKE 'service:service-notice:retry:%'`).all(SERVICE_NOTICE_SCOPE) as { id: string; payload_json: string }[];
  let settled = 0;
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as { key?: string; what?: string };
    // The published key is the breaker key with the first failure's time appended.
    const key = String(payload.key ?? "").replace(/:\d+$/, "");
    if (!key || (breakerKey !== undefined && key !== breakerKey)) continue;
    if (breakerKey === undefined && db.query("SELECT 1 FROM retry_breakers WHERE key=?").get(key)) continue;
    try {
      if (settleServiceNotice({ inputId: row.id, text: `${payload.what ?? "It"} is running again as of ${noticeTime(db, Date.now())}. Nothing waits on you.` })) settled += 1;
    } catch (error) {
      log("error", "retry_notice_resolve_failed", { key, input_id: row.id, error: String(error) });
    }
  }
  return settled;
}
