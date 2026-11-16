import type { Database } from "bun:sqlite";
import { MAX_SNOOZE_MS, readCrowding, workIsHisToWaitOn, type CrowdingConfig } from "./crowding";

/**
 * A self-snooze: an agent on a crowded machine whose work can wait sets itself a later start.
 * It is one queued continuation turn of the same session, saved as scheduled work (the existing clock
 * wakes it; there is no new scheduler). Every open request the session holds stays open, and its
 * due time moves past the wake so the reminder and overdue rules see a known wake time, not a stall.
 */
export const SNOOZE_HOLD_PREFIX = "snooze:";
export const SNOOZE_OVERDUE_MARGIN_MS = 15 * 60_000;

export class SnoozeRefused extends Error {
  constructor(readonly code: "HIS_WORK" | "NOT_CROWDED" | "BAD_TIME" | "NO_REASON" | "NO_TURN", message: string) { super(message); }
}

export function snoozeHold(reason: string): string { return `${SNOOZE_HOLD_PREFIX}${reason}`; }
export function snoozeReason(hold: string | null | undefined): string | null {
  return typeof hold === "string" && hold.startsWith(SNOOZE_HOLD_PREFIX) ? hold.slice(SNOOZE_HOLD_PREFIX.length) : null;
}

/** The refusals, in order; returns normally when the agent may snooze. */
export function checkSnooze(db: Database, input: { turnId: number; untilMs: number; reason: string; nowMs: number }, crowding: CrowdingConfig | null, facts: Parameters<typeof readCrowding>[3] = {}) {
  if (!input.reason.trim()) throw new SnoozeRefused("NO_REASON", "Say why this work can wait (--reason).");
  if (!Number.isFinite(input.untilMs) || input.untilMs <= input.nowMs + 60_000 || input.untilMs > input.nowMs + MAX_SNOOZE_MS)
    throw new SnoozeRefused("BAD_TIME", "Snooze until a time between one minute and six hours from now; snooze again on waking if it is still crowded.");
  if (workIsHisToWaitOn(db, input.turnId))
    throw new SnoozeRefused("HIS_WORK", "This work is his own direct message or the Inbox router, which he is waiting on; it never snoozes.");
  if (!crowding || !readCrowding(db, crowding, input.nowMs, facts).crowded)
    throw new SnoozeRefused("NOT_CROWDED", "This machine is not crowded, so there is no reason to pause; carry on.");
}

/** After the continuation turn is queued and saved: its hold text and the open requests' due times. */
export function recordSnooze(db: Database, input: { continuationTurnId: number; sessionId: number; untilMs: number; reason: string }) {
  db.query("UPDATE turns SET dispatch_hold=? WHERE id=? AND status='queued'").run(snoozeHold(input.reason.trim().slice(0, 300)), input.continuationTurnId);
  db.query(`UPDATE session_communication_requests SET due_at_ms=max(due_at_ms,?)
    WHERE target_session_id=? AND outcome IS NULL AND overdue_at_ms IS NULL AND stalled_at_ms IS NULL`)
    .run(input.untilMs + SNOOZE_OVERDUE_MARGIN_MS, input.sessionId);
}

export function continuationText(reason: string, untilMs: number): string {
  return `You snoozed this work because the machine was crowded (“${reason.trim()}”). It is ${new Date(untilMs).toISOString()} or later now: `
    + "pick the work up where you left it. Your open requests are still open. If the machine is still crowded and the work can still wait, snooze again.";
}
