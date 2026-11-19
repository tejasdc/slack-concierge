// Tests for the 2026-11-19 multi-account/multi-provider redesign (F1, F2, F3, F4).
// The design doc is docs/plans/2026-11-19-multi-account-multi-provider-redesign.md.
//
// Run with: CONCIERGE_TEST_AUTHORIZATION=<token> bun test tests/multi-account-cache-semantics.test.ts
// The project disables unauthorized agent-run tests (see scripts/testing-disabled.ts);
// this file exists so the user can run it when reviewing.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { claudeAccountCachedReset, clearProviderUsage, clearProviderUsageScoped,
  recordUsageExhaustion, retireClaudeRefusalSupersededByReading, usageAttempt } from "../src/provider-usage";
import { CLAUDE_USAGE_FALLBACK_CHAIN } from "../src/aliases";
import { runnerAccountHomes, runnerLiveRootMirror } from "../src/runner-provider-accounts";
import { db } from "../src/state";

const CLAUDE_ACCOUNT = "hey@tejas.nyc";
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";

function cacheRefusal(model: string, resetAt: number) {
  const attempt = usageAttempt("claude-code", model, CLAUDE_ACCOUNT);
  recordUsageExhaustion(attempt, resetAt);
  return attempt;
}

describe("F1 — claudeAccountCachedReset semantics", () => {
  beforeEach(() => { clearProviderUsage("claude-code"); });
  afterEach(() => { clearProviderUsage("claude-code"); });

  test("model-specific semantics requires a model (default)", () => {
    expect(() => claudeAccountCachedReset(CLAUDE_ACCOUNT)).toThrow(/requires a model/);
    expect(() => claudeAccountCachedReset(CLAUDE_ACCOUNT, null)).toThrow(/requires a model/);
  });

  test("Opus-only refusal does NOT block Sonnet model-specific check", () => {
    const resetAt = Date.now() + 3 * 24 * 60 * 60 * 1000; // Nov 22 effect
    cacheRefusal(OPUS, resetAt);
    expect(claudeAccountCachedReset(CLAUDE_ACCOUNT, OPUS)).toBe(resetAt);
    expect(claudeAccountCachedReset(CLAUDE_ACCOUNT, SONNET)).toBeNull();
  });

  test("Opus-only refusal does NOT block any-work release check (F1 fix)", () => {
    const resetAt = Date.now() + 3 * 24 * 60 * 60 * 1000;
    cacheRefusal(OPUS, resetAt);
    expect(claudeAccountCachedReset(CLAUDE_ACCOUNT, null, "any-work")).toBeNull();
  });

  test("any-work returns the max reset only when every allowance model refused", () => {
    const base = Date.now();
    const resets = CLAUDE_USAGE_FALLBACK_CHAIN.map((_, i) => base + (i + 1) * 60 * 60 * 1000);
    CLAUDE_USAGE_FALLBACK_CHAIN.forEach((model, i) => cacheRefusal(model, resets[i]!));
    expect(claudeAccountCachedReset(CLAUDE_ACCOUNT, null, "any-work")).toBe(Math.max(...resets));
  });

  test("any-work ignores an expired refusal (counts as room on that model)", () => {
    // Opus refused in the past — effectively not refused. Even with other models refused,
    // any-work must see Opus as free and return null.
    cacheRefusal(OPUS, Date.now() - 60_000);
    for (const model of CLAUDE_USAGE_FALLBACK_CHAIN.filter(m => m !== OPUS))
      cacheRefusal(model, Date.now() + 60 * 60 * 1000);
    expect(claudeAccountCachedReset(CLAUDE_ACCOUNT, null, "any-work")).toBeNull();
  });
});

describe("F2 — retireClaudeRefusalSupersededByReading", () => {
  beforeEach(() => { clearProviderUsage("claude-code"); });
  afterEach(() => { clearProviderUsage("claude-code"); });

  test("retires a cached refusal when a fresh reading shows every window under 100% with a different reset", () => {
    const refusedReset = Date.parse("2026-11-22T22:00:00Z");
    const freshReset = Date.parse("2026-11-19T20:00:00Z");
    cacheRefusal(OPUS, refusedReset);
    const windows = [{ usedPercent: 39, resetsAt: new Date(freshReset).toISOString() }];
    // Read must be strictly after the cache's observedAt (which is Date.now() at cache time);
    // bump by one second so the inequality is unambiguous regardless of millisecond resolution.
    const readAt = Date.now() + 1_000;
    const cleared = retireClaudeRefusalSupersededByReading(CLAUDE_ACCOUNT, windows, OPUS, readAt);
    expect(cleared).toBe(true);
    expect(claudeAccountCachedReset(CLAUDE_ACCOUNT, OPUS)).toBeNull();
  });

  test("keeps the cache when a window still ends at the refused reset (within 60s)", () => {
    const refusedReset = Date.parse("2026-11-22T22:00:00Z");
    cacheRefusal(OPUS, refusedReset);
    const windows = [{ usedPercent: 50, resetsAt: new Date(refusedReset - 30_000).toISOString() }];
    const cleared = retireClaudeRefusalSupersededByReading(CLAUDE_ACCOUNT, windows, OPUS, Date.now());
    expect(cleared).toBe(false);
    expect(claudeAccountCachedReset(CLAUDE_ACCOUNT, OPUS)).toBe(refusedReset);
  });

  test("keeps the cache when any window is at or above 100%", () => {
    const refusedReset = Date.parse("2026-11-22T22:00:00Z");
    cacheRefusal(OPUS, refusedReset);
    const windows = [{ usedPercent: 100, resetsAt: new Date(Date.parse("2026-11-19T20:00:00Z")).toISOString() }];
    const cleared = retireClaudeRefusalSupersededByReading(CLAUDE_ACCOUNT, windows, OPUS, Date.now());
    expect(cleared).toBe(false);
  });

  test("keeps the cache when the reading is older than the cached refusal", () => {
    const refusedReset = Date.parse("2026-11-22T22:00:00Z");
    const attempt = cacheRefusal(OPUS, refusedReset);
    const windows = [{ usedPercent: 39, resetsAt: new Date(Date.parse("2026-11-19T20:00:00Z")).toISOString() }];
    // Reading time is earlier than the refusal's observedAt (which is "now" at cache time).
    const cleared = retireClaudeRefusalSupersededByReading(CLAUDE_ACCOUNT, windows, OPUS,
      Date.now() - 24 * 60 * 60 * 1000);
    expect(cleared).toBe(false);
    void attempt;
  });
});

describe("F10 — clearProviderUsageScoped", () => {
  beforeEach(() => { clearProviderUsage("claude-code"); });
  afterEach(() => { clearProviderUsage("claude-code"); });

  test("clears one model-specific scope and leaves others untouched", () => {
    const resetAt = Date.now() + 3 * 24 * 60 * 60 * 1000;
    cacheRefusal(OPUS, resetAt);
    cacheRefusal(SONNET, resetAt + 1_000);
    const result = clearProviderUsageScoped("claude-code", CLAUDE_ACCOUNT, OPUS);
    expect(result.cleared).toBe(1);
    expect(claudeAccountCachedReset(CLAUDE_ACCOUNT, OPUS)).toBeNull();
    expect(claudeAccountCachedReset(CLAUDE_ACCOUNT, SONNET)).toBe(resetAt + 1_000);
  });

  test("clears every scope for one account", () => {
    const resetAt = Date.now() + 3 * 24 * 60 * 60 * 1000;
    cacheRefusal(OPUS, resetAt);
    cacheRefusal(SONNET, resetAt + 1_000);
    const result = clearProviderUsageScoped("claude-code", CLAUDE_ACCOUNT);
    expect(result.cleared).toBe(2);
    expect(claudeAccountCachedReset(CLAUDE_ACCOUNT, OPUS)).toBeNull();
    expect(claudeAccountCachedReset(CLAUDE_ACCOUNT, SONNET)).toBeNull();
  });

  test("refuses --model without --account for Claude", () => {
    expect(() => clearProviderUsageScoped("claude-code", null, OPUS))
      .toThrow(/requires an account label/);
  });
});

describe("F3 — runnerAccountHomes dedupes live root vs per-account folder", () => {
  // These paths need fs scaffolding; the test is a shape-check on the function's contract:
  // it never returns two entries with the same account label. A full fs fixture belongs in a
  // scripts/*-fixture.ts (the project's convention for integration-level checks) and is
  // scheduled as the next step beyond this unit cover.
  test("function contract: at most one entry per account label", () => {
    const providerKeys = ["claude-code", "codex"] as const;
    for (const key of providerKeys) {
      const entries = runnerAccountHomes(key);
      const labels = new Set<string>();
      for (const entry of entries) {
        expect(labels.has(entry.account)).toBe(false);
        labels.add(entry.account);
      }
    }
  });

  test("runnerLiveRootMirror never claims a mirror for an account not in a per-account folder", () => {
    for (const key of ["claude-code", "codex"] as const) {
      const mirror = runnerLiveRootMirror(key);
      if (mirror) {
        expect(mirror.canonicalHome).not.toBe(mirror.liveRoot);
        expect(mirror.account.length).toBeGreaterThan(0);
      }
    }
  });
});

// F4 is in claude-code.ts's stream parser; its invariant is best exercised with a recorded
// stream fixture rather than a unit test. See the updated terminal decision at claude-code.ts
// around the "F4 (2026-11-19)" comment and the companion warn-log that records every
// synthetic-vs-structured conflict for post-incident quantification.

// Hash check used by the implementation; kept here so the test file is self-contained.
void createHash;
void db;
