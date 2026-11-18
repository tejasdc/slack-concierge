import type { Database } from "bun:sqlite";

/**
 * Keep-working mode (docs/plans/2026-11-18-keep-working-mode.md): a session in this mode must
 * never go idle until it says it is done. Concierge stores no backlog; the queue lives in the
 * orchestrator's own project file. This module is only the durable on/off history. The wake rule
 * itself is request-liveness.ts's `sessionWillWake`, the one definition of "something will wake it".
 */
export const KEEP_WORKING_WAKE_PREFIX = "keep-working-wake:";
export const KEEP_WORKING_STUCK_REASON = "Woke once with nothing dispatched; the queue looks blocked";
export const OWNER_ACTOR = "owner";

export function ensureKeepWorkingTable(db: Database) {
  db.exec(`
CREATE TABLE IF NOT EXISTS session_keep_working_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  action_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('on','off')),
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  source_input_id TEXT,
  source_run_id TEXT,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(session_id, action_id)
);
CREATE INDEX IF NOT EXISTS session_keep_working_events_session ON session_keep_working_events(session_id, id);`);
}

type EventRow = { id: number; state: "on" | "off"; reason: string; actor: string; created_at_ms: number };

export type KeepWorkingView = {
  keepWorking: { since: string; reason: string } | null;
  keepWorkingLastOff: { at: string; reason: string; by: "owner" | "agent" } | null;
};

export function keepWorkingState(db: Database, sessionId: number): { on: { sinceMs: number; reason: string } | null; lastOff: { atMs: number; reason: string; actor: string } | null } {
  const latest = db.query("SELECT * FROM session_keep_working_events WHERE session_id=? ORDER BY id DESC LIMIT 1").get(sessionId) as EventRow | null;
  if (!latest) return { on: null, lastOff: null };
  if (latest.state === "off") return { on: null, lastOff: { atMs: latest.created_at_ms, reason: latest.reason, actor: latest.actor } };
  const lastOffId = (db.query("SELECT coalesce(max(id),0) AS id FROM session_keep_working_events WHERE session_id=? AND state='off'").get(sessionId) as { id: number }).id;
  const first = db.query("SELECT created_at_ms FROM session_keep_working_events WHERE session_id=? AND state='on' AND id>? ORDER BY id LIMIT 1").get(sessionId, lastOffId) as { created_at_ms: number };
  return { on: { sinceMs: first.created_at_ms, reason: latest.reason }, lastOff: null };
}

export function keepWorkingView(db: Database, sessionId: number): KeepWorkingView {
  const state = keepWorkingState(db, sessionId);
  return {
    keepWorking: state.on ? { since: new Date(state.on.sinceMs).toISOString(), reason: state.on.reason } : null,
    keepWorkingLastOff: state.lastOff
      ? { at: new Date(state.lastOff.atMs).toISOString(), reason: state.lastOff.reason, by: state.lastOff.actor === OWNER_ACTOR ? "owner" : "agent" } : null,
  };
}

/** Idempotent by action id: a repeat returns the first event; the same id with another meaning is refused. */
export function recordKeepWorking(db: Database, input: {
  sessionId: number; actionId: string; state: "on" | "off"; reason: string; actor: string;
  sourceInputId?: string | null; sourceRunId?: string | null; nowMs: number;
}): { duplicate: boolean } {
  const reason = input.reason.trim();
  if (!reason) throw new Error(input.state === "on" ? "Say what queue to keep working through and why (--reason)." : "Say why it may now rest (--reason).");
  const changes = db.query(`INSERT OR IGNORE INTO session_keep_working_events(session_id,action_id,state,reason,actor,source_input_id,source_run_id,created_at_ms)
    VALUES (?,?,?,?,?,?,?,?)`).run(input.sessionId, input.actionId, input.state, reason.slice(0, 500), input.actor, input.sourceInputId ?? null, input.sourceRunId ?? null, input.nowMs).changes;
  if (changes === 1) return { duplicate: false };
  const prior = db.query("SELECT state,reason FROM session_keep_working_events WHERE session_id=? AND action_id=?").get(input.sessionId, input.actionId) as { state: string; reason: string };
  if (prior.state !== input.state || prior.reason !== reason.slice(0, 500)) throw new Error("Idempotency conflict: this action ID already recorded another keep-working change.");
  return { duplicate: true };
}

export const wakeText = (reason: string) =>
  `Keep-working wake: you are in keep-working mode (${reason}) and your last turn ended with nothing in flight. `
  + "Dispatch the next backlog item with a request that returns to you, or turn keep-working off with the reason.";

export const stopReminderText = (reason: string, offCommand: string) =>
  `You are in keep-working mode (${reason}) and nothing in flight will wake you: no request that returns to you, no watch, no scheduled turn. `
  + "Dispatch the next backlog item now with a request that returns to you (sessions ask / sessions implement). "
  + `If the backlog is empty or everything left waits on Tejas, run: ${offCommand} --reason '<why>'`;
