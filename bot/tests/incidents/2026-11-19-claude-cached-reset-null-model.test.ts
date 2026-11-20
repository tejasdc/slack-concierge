/**
 * Incident replay: 2026-11-19 — `claudeAccountCachedReset` null-model throw regression.
 *
 * The first rebuild commit added `semantics: 'model-specific' | 'any-work'` with a
 * default of `'model-specific'` and a throw when `model` was null/undefined. Every
 * surviving caller that passed `null`/`undefined` (release loop, forecast,
 * exhaustion recovery, Accounts view) started throwing on every tick, dropping
 * callers that wrapped in try/catch to "no accounts have room" — re-introducing
 * the exact fault F1 the rebuild claims to eliminate, now as an Error instead of
 * a stale cache.
 *
 * Fix: a null/undefined model with the default semantics is silently treated as
 * `'any-work'`. The function returns a sensible answer without throwing.
 *
 * Invariant: `claudeAccountCachedReset(label)`, `(label, null)`, `(label, undefined)`
 * all return a sensible non-throwing answer.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { claudeAccountCachedReset, clearProviderUsage } from "../../src/provider-usage";
import { openWrite, recordRefusal } from "../../src/account-refusal-cache";
import { CLAUDE_USAGE_FALLBACK_CHAIN } from "../../src/aliases";

const ACCOUNT = "hey@tejas.nyc";
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";

beforeEach(() => clearProviderUsage("claude-code"));
afterEach(() => clearProviderUsage("claude-code"));

test("claudeAccountCachedReset(label) does not throw when no refusal is cached", () => {
  expect(() => claudeAccountCachedReset(ACCOUNT)).not.toThrow();
  expect(claudeAccountCachedReset(ACCOUNT)).toBeNull();
});

test("claudeAccountCachedReset(label, null) does not throw when no refusal is cached", () => {
  expect(() => claudeAccountCachedReset(ACCOUNT, null)).not.toThrow();
  expect(claudeAccountCachedReset(ACCOUNT, null)).toBeNull();
});

test("claudeAccountCachedReset(label, undefined) does not throw when no refusal is cached", () => {
  expect(() => claudeAccountCachedReset(ACCOUNT, undefined)).not.toThrow();
  expect(claudeAccountCachedReset(ACCOUNT, undefined)).toBeNull();
});

test("default-semantics null model returns null when Opus is refused but Sonnet has room (F1 preserved)", () => {
  // The whole point of 'any-work': an Opus-only refusal must not block callers that
  // ask the model-agnostic question.
  const resetAt = Date.now() + 3 * 24 * 60 * 60 * 1000;
  const token = openWrite("claude-code", ACCOUNT, OPUS);
  recordRefusal(token, resetAt);
  expect(claudeAccountCachedReset(ACCOUNT)).toBeNull();
  expect(claudeAccountCachedReset(ACCOUNT, null)).toBeNull();
  expect(claudeAccountCachedReset(ACCOUNT, undefined)).toBeNull();
});

test("default-semantics null model returns the max reset when every allowance model is refused", () => {
  const base = Date.now();
  const resets = CLAUDE_USAGE_FALLBACK_CHAIN.map((_, i) => base + (i + 1) * 60 * 60 * 1000);
  CLAUDE_USAGE_FALLBACK_CHAIN.forEach((m, i) => {
    const token = openWrite("claude-code", ACCOUNT, m);
    recordRefusal(token, resets[i]!);
  });
  expect(claudeAccountCachedReset(ACCOUNT)).toBe(Math.max(...resets));
  expect(claudeAccountCachedReset(ACCOUNT, null)).toBe(Math.max(...resets));
});

test("explicit 'model-specific' semantics with null model still throws (caller contract)", () => {
  // The old guarantee is preserved for callers that DECLARE they want model-specific:
  // passing null with an explicit 'model-specific' semantics is a contract bug.
  expect(() => claudeAccountCachedReset(ACCOUNT, null, "model-specific"))
    .toThrow(/requires a model/);
});

test("model-specific semantics with a real model still works (band-aid test parity)", () => {
  const resetAt = Date.now() + 3 * 24 * 60 * 60 * 1000;
  const token = openWrite("claude-code", ACCOUNT, OPUS);
  recordRefusal(token, resetAt);
  expect(claudeAccountCachedReset(ACCOUNT, OPUS)).toBe(resetAt);
  expect(claudeAccountCachedReset(ACCOUNT, SONNET)).toBeNull();
});
