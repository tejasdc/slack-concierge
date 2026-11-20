/**
 * Incident replay: 2026-11-19 — session-owner JSONL header overrode dispatcher.
 *
 * Verbatim (from the live incident addendum):
 *   "The incident: Essos session `93bba235-...` and Inbox router session
 *    `ea1772f7-...` both had their owner header pointing at tejas@chann.app's
 *    accountUuid, from when chann.app owned the sessions. The dispatcher correctly
 *    picked hey@tejas.nyc. The launcher silently rebound to chann.app's home. Every
 *    API call went through chann.app's token → Anthropic refused with
 *    `status:"rejected", rateLimitType:"seven_day", overageDisabledReason:"out_of_credits",
 *    resetsAt:1795402800` (chann.app's Nov 22 reset). The bot cached the refusal
 *    under hey@tejas.nyc's hash because the dispatcher labeled it that way. Right
 *    refusal data, wrong account label."
 *
 * The invariant: a dispatcher-signed `claude_session_account_bindings` row wins
 * over the JSONL `session-owner` header. The launcher reads the binding first;
 * the header is informational. See `bot/src/claude-session-binding.ts` and the
 * launcher's exact-resume branch at `bot/scripts/agent-claude-launch.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readClaudeSessionBinding, writeClaudeSessionBinding, recordSessionOwnerHeaderMismatch } from "../../src/claude-session-binding";
import { db } from "../../src/state";

const SESSION_UUID = "93bba235-1234-4abc-9def-0123456789ab";

beforeEach(() => {
  db.query("DELETE FROM claude_session_account_bindings").run();
});
afterEach(() => {
  db.query("DELETE FROM claude_session_account_bindings").run();
});

test("the dispatcher's binding is retrievable by session UUID", () => {
  writeClaudeSessionBinding({ sessionUuid: SESSION_UUID, accountLabel: "hey@tejas.nyc", accountUuid: "hey-uuid-abc", organizationUuid: "org-xyz", boundByDispatchRevision: 31 });
  const binding = readClaudeSessionBinding(SESSION_UUID);
  expect(binding).not.toBeNull();
  expect(binding!.accountLabel).toBe("hey@tejas.nyc");
  expect(binding!.accountUuid).toBe("hey-uuid-abc");
  expect(binding!.organizationUuid).toBe("org-xyz");
  expect(binding!.boundByDispatchRevision).toBe(31);
});

test("a later binding update rebinds the session to a different account", () => {
  // CAS is strict: a newer revision overrides an older. Writes with the same revision
  // and a different account label are a race and refused as "same-revision-conflict".
  writeClaudeSessionBinding({ sessionUuid: SESSION_UUID, accountLabel: "tejas@chann.app", accountUuid: "chann-uuid", boundByDispatchRevision: 1 });
  writeClaudeSessionBinding({ sessionUuid: SESSION_UUID, accountLabel: "hey@tejas.nyc", accountUuid: "hey-uuid", boundByDispatchRevision: 2 });
  const binding = readClaudeSessionBinding(SESSION_UUID);
  expect(binding!.accountLabel).toBe("hey@tejas.nyc");
  expect(binding!.accountUuid).toBe("hey-uuid");
});

test("same-revision writes with different accounts are refused as a race", () => {
  const first = writeClaudeSessionBinding({ sessionUuid: SESSION_UUID, accountLabel: "tejas@chann.app", accountUuid: "chann-uuid", boundByDispatchRevision: 5 });
  const second = writeClaudeSessionBinding({ sessionUuid: SESSION_UUID, accountLabel: "hey@tejas.nyc", accountUuid: "hey-uuid", boundByDispatchRevision: 5 });
  expect(first.written).toBe(true);
  expect(second.written).toBe(false);
  expect(second.reason).toBe("same-revision-conflict");
  const binding = readClaudeSessionBinding(SESSION_UUID);
  expect(binding!.accountLabel).toBe("tejas@chann.app");
});

test("CAS: an older revision cannot overwrite a newer one", () => {
  // Reviewer-flagged gap 2026-11-20: the CAS is the entire defense against a stale
  // launcher overwriting a newer dispatcher binding (the Nov 19 fault class). Guards
  // both the JS pre-check and the SQL `WHERE excluded.revision > bound_by_dispatch_revision`.
  const newer = writeClaudeSessionBinding({ sessionUuid: SESSION_UUID, accountLabel: "hey@tejas.nyc", accountUuid: "hey-uuid", boundByDispatchRevision: 10 });
  const older = writeClaudeSessionBinding({ sessionUuid: SESSION_UUID, accountLabel: "tejas@chann.app", accountUuid: "chann-uuid", boundByDispatchRevision: 3 });
  expect(newer.written).toBe(true);
  expect(older.written).toBe(false);
  expect(older.reason).toBe("stale-revision");
  const binding = readClaudeSessionBinding(SESSION_UUID);
  expect(binding!.accountLabel).toBe("hey@tejas.nyc");
  expect(binding!.boundByDispatchRevision).toBe(10);
});

test("CAS: same-revision idempotent write for the same account label is allowed", () => {
  // A retry of the same binding (same account, same revision) is a no-op not a conflict.
  const first = writeClaudeSessionBinding({ sessionUuid: SESSION_UUID, accountLabel: "hey@tejas.nyc", accountUuid: "hey-uuid", boundByDispatchRevision: 7 });
  const retry = writeClaudeSessionBinding({ sessionUuid: SESSION_UUID, accountLabel: "hey@tejas.nyc", accountUuid: "hey-uuid", boundByDispatchRevision: 7 });
  expect(first.written).toBe(true);
  expect(retry.written).toBe(true);
  const binding = readClaudeSessionBinding(SESSION_UUID);
  expect(binding!.accountLabel).toBe("hey@tejas.nyc");
});

test("recordSessionOwnerHeaderMismatch logs without throwing", () => {
  // The mismatch is INFORMATIONAL; the launcher still trusts the binding.
  expect(() => recordSessionOwnerHeaderMismatch({
    sessionUuid: SESSION_UUID,
    bindingLabel: "hey@tejas.nyc",
    headerAccountUuid: "chann-uuid",
    headerOrganizationUuid: "chann-org",
  })).not.toThrow();
});

test("reading an unknown session UUID returns null", () => {
  expect(readClaudeSessionBinding("00000000-0000-4000-8000-000000000000")).toBeNull();
});
