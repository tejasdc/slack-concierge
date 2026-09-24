import { db } from "./state-database";
import { publishRetryBreakerNotice } from "./retry-breaker-notice";
import { nextRetry } from "./retry";
import { RETRY_POLICY_FOR_SITE } from "./retry-policies";
import { log } from "./log";

export type RetrySite = keyof typeof RETRY_POLICY_FOR_SITE;
export type RetryFailure = {
  kind: "transient" | "permanent" | "unknown";
  reason: string;
  waitForSignal?: string | null;
  retryAtMs?: number | null;
  retryAfterMs?: number | null;
  restartSignal?: string | null;
};
export type RetryDecision = { action: "retry"; atMs: number } | { action: "wait-signal"; signal: string }
  | { action: "stop"; reason: string; notify: boolean; restartSignal: string | null };

db.exec(`CREATE TABLE IF NOT EXISTS retry_breakers (
  key TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  first_failure_ms INTEGER NOT NULL,
  consecutive_failures INTEGER NOT NULL,
  same_kind_failures INTEGER NOT NULL,
  last_kind TEXT,
  tripped_at_ms INTEGER,
  next_probe_ms INTEGER,
  notice_sent INTEGER NOT NULL DEFAULT 0
)`);

export function recordRetryFailure(input: {
  key: string; site: RetrySite; what: string; failure: RetryFailure; nowMs?: number;
}): RetryDecision {
  const nowMs = input.nowMs ?? Date.now();
  const policy = RETRY_POLICY_FOR_SITE[input.site];
  const row = db.query("SELECT * FROM retry_breakers WHERE key=?").get(input.key) as {
    first_failure_ms: number; consecutive_failures: number; same_kind_failures: number;
    last_kind: string | null; tripped_at_ms: number | null; next_probe_ms: number | null; notice_sent: number;
  } | null;
  const firstFailureMs = row?.first_failure_ms ?? nowMs;
  const priorTrip = row?.tripped_at_ms != null;
  const probe = priorTrip && row!.next_probe_ms != null && nowMs >= row!.next_probe_ms;
  const attempts = (row?.consecutive_failures ?? 0) + 1;
  const sameKind = row?.last_kind === input.failure.kind ? (row?.same_kind_failures ?? 0) + 1 : 1;
  const schedule = nextRetry({ policy, attempt: attempts, startedAtMs: firstFailureMs, nowMs,
    classification: input.failure.kind, retryAtMs: input.failure.retryAtMs ??
      (input.failure.retryAfterMs == null ? null : nowMs + input.failure.retryAfterMs) });
  const tripped = priorTrip || schedule.action === "stop";
  const nextProbeMs = tripped ? (probe || !priorTrip ? nowMs + policy.capDelayMs : row!.next_probe_ms) : null;
  db.query(`INSERT INTO retry_breakers(key,site,first_failure_ms,consecutive_failures,same_kind_failures,
    last_kind,tripped_at_ms,next_probe_ms,notice_sent) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET site=excluded.site,consecutive_failures=excluded.consecutive_failures,
    same_kind_failures=excluded.same_kind_failures,last_kind=excluded.last_kind,
    tripped_at_ms=excluded.tripped_at_ms,next_probe_ms=excluded.next_probe_ms,notice_sent=excluded.notice_sent`)
    .run(input.key, input.site, firstFailureMs, attempts, sameKind, input.failure.kind,
      tripped ? row?.tripped_at_ms ?? nowMs : null, nextProbeMs, row?.notice_sent ?? 0);
  if (tripped) {
    if (!priorTrip || probe) log("error", "retry_budget_exhausted", { operation: input.site,
      attempts, elapsed_ms: nowMs - firstFailureMs, last_error: input.failure.reason,
      reason: schedule.action === "stop" ? schedule.reason : "attempts" });
    const announced = !row?.notice_sent && publishRetryBreakerNotice({ key: `${input.key}:${firstFailureMs}`,
      what: input.what, reason: input.failure.reason, sinceMs: firstFailureMs,
      restartSignal: input.failure.restartSignal ?? "the dependency answers or a retry is requested" });
    if (announced) db.query("UPDATE retry_breakers SET notice_sent=1 WHERE key=?").run(input.key);
    return { action: "stop", reason: input.failure.reason, notify: !!announced,
      restartSignal: input.failure.restartSignal ?? null };
  }
  if (input.failure.waitForSignal) return { action: "wait-signal", signal: input.failure.waitForSignal };
  return { action: "retry", atMs: schedule.action === "retry" ? schedule.atMs : nowMs };
}

export function clearRetryBreaker(key: string): void { db.query("DELETE FROM retry_breakers WHERE key=?").run(key); }
export function retryBreakerDueForProbe(key: string, nowMs = Date.now()): boolean {
  const row = db.query("SELECT next_probe_ms FROM retry_breakers WHERE key=?").get(key) as { next_probe_ms: number | null } | null;
  return row?.next_probe_ms != null && row.next_probe_ms <= nowMs;
}
