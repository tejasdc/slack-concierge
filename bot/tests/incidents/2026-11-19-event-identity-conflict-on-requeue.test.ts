/**
 * Incident replay: 2026-11-19 — `recordSessionEvent` threw `Event identity conflict`
 * on a requeued turn's new attempt because the event id was tied to `turn_id` alone.
 *
 * Verbatim (addendum):
 *   "`recordSessionEvent` throws `Event identity conflict` when a turn's status moves
 *    error → queued and tries to re-record an event with a duplicate key. Tie the event
 *    ID to `(turn_id, dispatch_attempt)` not `(turn_id)` so a re-queued turn can record
 *    its new attempt's event cleanly. This blocked recovery of turn 33959 today."
 *
 * Invariant: `recordSessionEvent` supports two writes under keys `foo:<turn>:0` and
 * `foo:<turn>:1` without throwing. This is a smoke test on the primitive — the full fix
 * is composing event ids as `<kind>:<turn_id>:<dispatch_attempt>` at every caller that
 * may re-fire on requeue (e.g. `capacity-reroute` at `turn-execution.ts`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/state";
import { recordSessionEvent } from "../../src/session-inputs";

let sessionId: number;
let turnId: number;

beforeEach(() => {
  // Build a disposable session + queued turn so recordSessionEvent has a valid FK.
  const sessionInsert = db.query(
    `INSERT INTO sessions (slack_channel_id, slack_thread_ts, provider_id, status)
     VALUES ('C_test', 'T_test', 'claude-code', 'idle') RETURNING id`,
  ).get() as { id: number };
  sessionId = sessionInsert.id;
  const turnInsert = db.query(
    `INSERT INTO turns (session_id, slack_user_msg_ts, user_text, status)
     VALUES (?, 'U_test', 'hello', 'queued') RETURNING id`,
  ).get(sessionId) as { id: number };
  turnId = turnInsert.id;
});

afterEach(() => {
  db.query("DELETE FROM session_owner_events WHERE session_id = ?").run(sessionId);
  db.query("DELETE FROM turns WHERE id = ?").run(turnId);
  db.query("DELETE FROM sessions WHERE id = ?").run(sessionId);
});

test("two attempts of the same turn can record events under keyed-by-(turn,attempt) ids", () => {
  // Attempt 0: a capacity-reroute event
  recordSessionEvent({
    eventId: `capacity-reroute:${turnId}:0`,
    sessionId, turnId, kind: "provider",
    payload: { from: "claude-code", to: "codex", reason: "test" },
  });
  // Turn status flips back to queued (simulating requeue); next attempt fires again.
  recordSessionEvent({
    eventId: `capacity-reroute:${turnId}:1`,
    sessionId, turnId, kind: "provider",
    payload: { from: "claude-code", to: "codex", reason: "retry-after-requeue" },
  });
  const events = db.query(
    `SELECT event_id FROM session_owner_events WHERE turn_id = ? ORDER BY event_id`,
  ).all(turnId) as Array<{ event_id: string }>;
  expect(events.map(e => e.event_id)).toEqual([`capacity-reroute:${turnId}:0`, `capacity-reroute:${turnId}:1`]);
});

test("the SAME event id under the same (turn,attempt) with same payload is idempotent", () => {
  // No-op on duplicate with matching content — classic upsert-by-identity.
  const eventId = `capacity-reroute:${turnId}:5`;
  recordSessionEvent({ eventId, sessionId, turnId, kind: "provider", payload: { reason: "x" } });
  expect(() => recordSessionEvent({ eventId, sessionId, turnId, kind: "provider", payload: { reason: "x" } })).not.toThrow();
});

test("DIFFERENT payload at the same event id still throws — a true identity conflict", () => {
  // The fix is in the CALLER's event-id composition, not in relaxing the primitive.
  // The primitive still refuses two different events at the same id, because that
  // would silently discard the second event.
  const eventId = `capacity-reroute:${turnId}:7`;
  recordSessionEvent({ eventId, sessionId, turnId, kind: "provider", payload: { reason: "a" } });
  expect(() => recordSessionEvent({ eventId, sessionId, turnId, kind: "provider", payload: { reason: "b" } }))
    .toThrow(/Event identity conflict/);
});
