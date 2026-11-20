/**
 * Incident replay: 2026-11-02 — Opus 1M shares Opus's allowance scope.
 *
 * Verbatim comment from `bot/src/aliases.ts:478-481`:
 *   "The allowance a Claude model spends, for usage limits and holds only. Claude Code's
 *    extended-window Opus is the same model on the same allowance: on 2026-11-02 one
 *    account was refused for both names with the same reset. Kept as two scopes, an
 *    Accounts check that proved Opus never released the Inbox, which runs on the
 *    extended one (2026-11-03)."
 *
 * The invariant: a cached refusal written under `claude-opus-5-5` also blocks `opus[1m]`
 * (and vice-versa), because they share one allowance window on Anthropic's side.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cachedRefusal, clearAll, openWrite, recordRefusal } from "../../src/account-refusal-cache";

const ACCOUNT = "hey@tejas.nyc";

beforeEach(() => clearAll("claude-code"));
afterEach(() => clearAll("claude-code"));

test("a refusal written under claude-opus-5-5 reads back under opus[1m]", () => {
  const reset = Date.now() + 3 * 60 * 60 * 1000;
  const token = openWrite("claude-code", ACCOUNT, "claude-opus-5-5");
  recordRefusal(token, reset);
  const lookup = cachedRefusal("claude-code", ACCOUNT, "opus[1m]");
  expect(lookup).not.toBeNull();
  expect(lookup!.resetAtMs).toBe(reset);
});

test("a refusal written under opus[1m] reads back under claude-opus-5-5", () => {
  const reset = Date.now() + 3 * 60 * 60 * 1000;
  const token = openWrite("claude-code", ACCOUNT, "opus[1m]");
  recordRefusal(token, reset);
  const lookup = cachedRefusal("claude-code", ACCOUNT, "claude-opus-5-5");
  expect(lookup).not.toBeNull();
  expect(lookup!.resetAtMs).toBe(reset);
});

test("sonnet refusal does NOT read back under opus — they are different allowance scopes", () => {
  const reset = Date.now() + 3 * 60 * 60 * 1000;
  const token = openWrite("claude-code", ACCOUNT, "claude-sonnet-5-5");
  recordRefusal(token, reset);
  expect(cachedRefusal("claude-code", ACCOUNT, "claude-opus-5-5")).toBeNull();
  expect(cachedRefusal("claude-code", ACCOUNT, "claude-sonnet-5-5")).not.toBeNull();
});
