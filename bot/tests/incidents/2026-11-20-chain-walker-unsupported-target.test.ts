/**
 * Incident guard: 2026-11-20 — `recoverExhaustedWork` must return
 * `"unsupported-target"` when the configured `provider_chain` names a provider
 * `transferSession` cannot reach (today: antigravity). Before this invariant
 * landed, the walker would silently hold the session instead of surfacing the
 * gap, and operators were left guessing why a Claude-exhausted thread wouldn't
 * fail over.
 *
 * Reviewer-flagged gap 2026-11-20: the `unsupported-target` return path at
 * `bot/src/provider-exhaustion-recovery.ts:244,254` was unreachable from any
 * `bot/tests/` file, so a rename or enum change could silently break it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/state";
import { recoverExhaustedWork, sessionProviderChain } from "../../src/provider-exhaustion-recovery";

let claudeOnlySessionId: number;
let claudeToAntigravitySessionId: number;

beforeEach(() => {
  db.query("BEGIN").run();
  // Session with the default chain (claude-code → codex). No unsupported target.
  const defaultSession = db.query(
    `INSERT INTO sessions (slack_channel_id, slack_thread_ts, provider_id, status)
     VALUES ('C_default', 'T_default', 'claude-code', 'idle') RETURNING id`,
  ).get() as { id: number };
  claudeOnlySessionId = defaultSession.id;

  // Session whose configured chain names antigravity — unsupported by transferSession today.
  const unsupported = db.query(
    `INSERT INTO sessions (slack_channel_id, slack_thread_ts, provider_id, status, provider_chain)
     VALUES ('C_unsup', 'T_unsup', 'claude-code', 'idle', ?) RETURNING id`,
  ).get(JSON.stringify(["claude-code", "antigravity"])) as { id: number };
  claudeToAntigravitySessionId = unsupported.id;
  db.query("COMMIT").run();
});

afterEach(() => {
  db.query(`DELETE FROM sessions WHERE id IN (?, ?)`).run(claudeOnlySessionId, claudeToAntigravitySessionId);
});

describe("chain walker", () => {
  test("sessionProviderChain returns the stored chain when provider_chain is set", () => {
    expect(sessionProviderChain(claudeToAntigravitySessionId)).toEqual(["claude-code", "antigravity"]);
  });

  test("sessionProviderChain falls back to [claude-code, codex] default when provider_chain is null", () => {
    expect(sessionProviderChain(claudeOnlySessionId)).toEqual(["claude-code", "codex"]);
  });

  test("recoverExhaustedWork returns 'unsupported-target' when chain names antigravity", () => {
    // The chain [claude-code, antigravity] has no supported next-hop; transferSession
    // can't move to antigravity. The walker must surface the gap, not silently hold.
    expect(recoverExhaustedWork(claudeToAntigravitySessionId)).toBe("unsupported-target");
  });

  test("recoverExhaustedWork returns 'no-chain' when chain has only one entry", () => {
    const singletonSession = db.query(
      `INSERT INTO sessions (slack_channel_id, slack_thread_ts, provider_id, status, provider_chain)
       VALUES ('C_single', 'T_single', 'codex', 'idle', ?) RETURNING id`,
    ).get(JSON.stringify(["codex"])) as { id: number };
    try {
      expect(recoverExhaustedWork(singletonSession.id)).toBe("no-chain");
    } finally {
      db.query("DELETE FROM sessions WHERE id=?").run(singletonSession.id);
    }
  });
});
