/**
 * Incident replay: 2026-11-21 — Tejas switched Codex in the Accounts panel from the
 * exhausted `tejastej.dc@gmail.com` (ChatGPT Pro at 100% weekly, reset Nov 23) to the
 * clean `tejas@chann.app`, and Canvas 13's three queued Codex turns stayed held with
 * `dispatch_hold='usage'` until an operator cleared them by hand. The fix wires the
 * account switch into `releaseUsageHeldWork('codex','owner_switch')`, which routes to
 * `releaseScheduledProviderRetries('codex', true)`.
 *
 * Invariant under test: a queued Codex turn whose dispatch was held on usage
 * (`dispatch_hold='usage'`, `dispatch_failure_class='backoff'`, a positive
 * `dispatch_next_attempt_ms` in the future) and whose session has no banked
 * account binding gets moved to the paced release hold with its next-attempt
 * reset to zero. A banked turn with an explicit saved account is kept on its
 * window and must not be swept onto the new login.
 *
 * Context: see `bot/src/session-execution-host.ts` (`putCodexAccountInUse`
 * runner and local branches) and `bot/src/state.ts`
 * (`releaseScheduledProviderRetries`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db, RELEASE_PACE_HOLD, releaseScheduledProviderRetries } from "../../src/state";

function insertCodexSession(): number {
  const row = db.query(`INSERT INTO sessions (provider_id, status) VALUES ('codex', 'idle') RETURNING id`).get() as { id: number };
  return row.id;
}

function insertHeldCodexTurn(sessionId: number, options: { saved_kind?: string | null; saved_account?: string | null } = {}): number {
  const nextAttempt = Date.now() + 36 * 60 * 60 * 1000; // ~36h ahead, matching a Nov 23 reset
  const row = db.query(`INSERT INTO turns (
      session_id, status, dispatch_hold, dispatch_failure_class, dispatch_next_attempt_ms,
      saved_kind, saved_account
    ) VALUES (?, 'queued', 'usage', 'backoff', ?, ?, ?) RETURNING id`)
    .get(sessionId, nextAttempt, options.saved_kind ?? null, options.saved_account ?? null) as { id: number };
  return row.id;
}

const testSessionIds: number[] = [];

beforeEach(() => { testSessionIds.length = 0; });

afterEach(() => {
  if (testSessionIds.length) {
    const placeholders = testSessionIds.map(() => "?").join(",");
    db.query(`DELETE FROM turns WHERE session_id IN (${placeholders})`).run(...testSessionIds);
    db.query(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...testSessionIds);
  }
});

describe("Codex account switch releases held work", () => {
  test("a queued, usage-held, unbound Codex turn is released by the switch path", () => {
    // Canvas 13's shape: a plain queued turn, no saved_kind, held for the old account's reset.
    const sessionId = insertCodexSession();
    testSessionIds.push(sessionId);
    const turnId = insertHeldCodexTurn(sessionId);

    const released = releaseScheduledProviderRetries("codex", true);
    expect(released).toBeGreaterThanOrEqual(1);

    const after = db.query(`SELECT dispatch_hold, dispatch_next_attempt_ms FROM turns WHERE id=?`).get(turnId) as any;
    expect(after.dispatch_hold).toBe(RELEASE_PACE_HOLD);
    expect(after.dispatch_next_attempt_ms).toBe(0);
  });

  test("a banked turn saved for a specific old account is NOT released by an account switch", () => {
    // Banked work spends its chosen account's window. The operator's switch of the active
    // login is not a reason to silently move that banked turn to a different account.
    const sessionId = insertCodexSession();
    testSessionIds.push(sessionId);
    const turnId = insertHeldCodexTurn(sessionId, { saved_kind: "banked", saved_account: "tejastej.dc@gmail.com" });

    releaseScheduledProviderRetries("codex", true);

    const after = db.query(`SELECT dispatch_hold, dispatch_next_attempt_ms FROM turns WHERE id=?`).get(turnId) as any;
    expect(after.dispatch_hold).toBe("usage");
    expect(after.dispatch_next_attempt_ms).toBeGreaterThan(Date.now());
  });

  test("a scheduled turn with no saved_account is released (treated as unbound)", () => {
    // A scheduled Codex turn with saved_account IS NULL has not committed to any account,
    // so it rides on the active login just like a plain queued turn.
    const sessionId = insertCodexSession();
    testSessionIds.push(sessionId);
    const turnId = insertHeldCodexTurn(sessionId, { saved_kind: "scheduled", saved_account: null });

    releaseScheduledProviderRetries("codex", true);

    const after = db.query(`SELECT dispatch_hold FROM turns WHERE id=?`).get(turnId) as any;
    expect(after.dispatch_hold).toBe(RELEASE_PACE_HOLD);
  });
});
