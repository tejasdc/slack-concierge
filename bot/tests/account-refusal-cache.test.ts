/**
 * Tests for `account-refusal-cache.ts`. Replaces the band-aid file
 * `multi-account-cache-semantics.test.ts` with authority-oriented coverage.
 *
 * Preserved dated incident reasons:
 *   - 2026-09-15 — "A Codex limit outlived the account it belonged to" → scopeKey
 *     always carries account identity. (`docs/incidents/2026-09-15-codex-usage-limit-scope.md`)
 *   - 2026-11-06 — Nov 3 Codex refusal held every turn while account read 7% → the
 *     generic retire-by-reading rule.
 *   - 2026-11-19 F1 — Opus-only refusal must not poison Sonnet, Haiku, or any-work.
 *   - 2026-11-19 F2 — A fresh Claude reading with windows < 100% and no window reset
 *     matching the cache retires that cache.
 *   - 2026-11-19 F10 — Scoped clear: one model / one account / all.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  anyWorkCachedReset,
  cachedRefusal,
  cachedRefusalsForAccount,
  clearAll,
  clearScoped,
  openWrite,
  recordRefusal,
  retireRefusalBySuccess,
  retireRefusalSupersededByReading,
} from "../src/account-refusal-cache";
import { CLAUDE_USAGE_FALLBACK_CHAIN } from "../src/aliases";

const ACCOUNT = "hey@tejas.nyc";
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";
const FABLE = "claude-fable-5-2";

function cache(model: string, resetAtMs: number): void {
  const token = openWrite("claude-code", ACCOUNT, model);
  recordRefusal(token, resetAtMs);
}

describe("account-refusal-cache", () => {
  beforeEach(() => { clearAll("claude-code"); clearAll("codex"); });
  afterEach(() => { clearAll("claude-code"); clearAll("codex"); });

  describe("scope convention and reads", () => {
    test("records and reads back one model-specific refusal", () => {
      const resetAt = Date.now() + 3 * 60 * 60 * 1000;
      cache(OPUS, resetAt);
      const record = cachedRefusal("claude-code", ACCOUNT, OPUS);
      expect(record).not.toBeNull();
      expect(record!.resetAtMs).toBe(resetAt);
    });

    test("different models for the same account write to different scopes (F1)", () => {
      const resetA = Date.now() + 3 * 60 * 60 * 1000;
      const resetB = Date.now() + 4 * 60 * 60 * 1000;
      cache(OPUS, resetA);
      cache(SONNET, resetB);
      expect(cachedRefusal("claude-code", ACCOUNT, OPUS)!.resetAtMs).toBe(resetA);
      expect(cachedRefusal("claude-code", ACCOUNT, SONNET)!.resetAtMs).toBe(resetB);
    });

    test("Opus 1M collapses onto Opus's allowance scope", () => {
      const resetAt = Date.now() + 3 * 60 * 60 * 1000;
      cache(OPUS, resetAt);
      // Opus 1M should read back the same refusal because the allowance collapses.
      expect(cachedRefusal("claude-code", ACCOUNT, "opus[1m]")!.resetAtMs).toBe(resetAt);
    });

    test("Codex scope is per-account (not per-model)", () => {
      const token = openWrite("codex", "tejas@chann.app", null);
      recordRefusal(token, Date.now() + 60_000);
      expect(cachedRefusal("codex", "tejas@chann.app", null)).not.toBeNull();
    });
  });

  describe("F1 — any-work cache reset", () => {
    test("Opus-only refusal does NOT trip any-work (Sonnet, Haiku, Fable all have room)", () => {
      const resetAt = Date.now() + 3 * 24 * 60 * 60 * 1000;
      cache(OPUS, resetAt);
      expect(anyWorkCachedReset(ACCOUNT)).toBeNull();
    });

    test("any-work returns the max reset when every allowance model refused", () => {
      const base = Date.now();
      const resets = CLAUDE_USAGE_FALLBACK_CHAIN.map((_, i) => base + (i + 1) * 60 * 60 * 1000);
      CLAUDE_USAGE_FALLBACK_CHAIN.forEach((model, i) => cache(model, resets[i]!));
      expect(anyWorkCachedReset(ACCOUNT)).toBe(Math.max(...resets));
    });

    test("Opus expired (reset passed) is not a block even with other models refused", () => {
      cache(OPUS, Date.now() - 60_000);  // in the past
      for (const model of CLAUDE_USAGE_FALLBACK_CHAIN.filter(m => m !== OPUS))
        cache(model, Date.now() + 60 * 60 * 1000);
      expect(anyWorkCachedReset(ACCOUNT)).toBeNull();
    });
  });

  describe("F2 — retire by reading (generic rule)", () => {
    test("retires a Claude cache when a fresh reading contradicts it", () => {
      const refusedReset = Date.parse("2026-11-22T22:00:00Z");
      const freshReset = Date.parse("2026-11-19T20:00:00Z");
      cache(OPUS, refusedReset);
      const windows = [{ usedPercent: 39, resetsAt: new Date(freshReset).toISOString() }];
      const readAt = Date.now() + 1_000;
      const retired = retireRefusalSupersededByReading("claude-code", ACCOUNT, OPUS, windows, readAt);
      expect(retired).toBe(true);
      expect(cachedRefusal("claude-code", ACCOUNT, OPUS)).toBeNull();
    });

    test("keeps the cache when a window's reset matches within 60s", () => {
      const refusedReset = Date.parse("2026-11-22T22:00:00Z");
      cache(OPUS, refusedReset);
      const windows = [{ usedPercent: 50, resetsAt: new Date(refusedReset - 30_000).toISOString() }];
      const retired = retireRefusalSupersededByReading("claude-code", ACCOUNT, OPUS, windows, Date.now());
      expect(retired).toBe(false);
    });

    test("keeps the cache when any window is at or above 100%", () => {
      const refusedReset = Date.parse("2026-11-22T22:00:00Z");
      cache(OPUS, refusedReset);
      const windows = [{ usedPercent: 100, resetsAt: new Date(Date.now() + 86400_000).toISOString() }];
      const retired = retireRefusalSupersededByReading("claude-code", ACCOUNT, OPUS, windows, Date.now());
      expect(retired).toBe(false);
    });

    test("keeps the cache when the reading is older than the cached refusal", () => {
      const refusedReset = Date.parse("2026-11-22T22:00:00Z");
      cache(OPUS, refusedReset);
      const windows = [{ usedPercent: 39, resetsAt: new Date(Date.now() + 3 * 86400_000).toISOString() }];
      const retired = retireRefusalSupersededByReading("claude-code", ACCOUNT, OPUS, windows, Date.now() - 86400_000);
      expect(retired).toBe(false);
    });

    test("retires a Codex cache the same way (preserves 2026-11-06)", () => {
      // Replay: on 2026-11-06 a Nov-3 Codex refusal cached until Nov 9 19:36 UTC
      // held every Codex turn while the account's own reading showed 7% used with
      // the week ending Nov 12. The retire rule fires because the fresh reading's
      // resets diverge from the cache's reset.
      const refusedReset = Date.now() + 5 * 24 * 60 * 60 * 1000;
      const freshReset = Date.now() + 10 * 24 * 60 * 60 * 1000;
      const token = openWrite("codex", "tejas@chann.app", null);
      recordRefusal(token, refusedReset);
      const windows = [{ usedPercent: 7, resetsAt: new Date(freshReset).toISOString() }];
      const retired = retireRefusalSupersededByReading("codex", "tejas@chann.app", null, windows, Date.now() + 1_000);
      expect(retired).toBe(true);
      expect(cachedRefusal("codex", "tejas@chann.app", null)).toBeNull();
    });
  });

  describe("F10 — scoped clear", () => {
    test("clear one (account, model) leaves other scopes alone", () => {
      const resetAt = Date.now() + 3 * 24 * 60 * 60 * 1000;
      cache(OPUS, resetAt);
      cache(SONNET, resetAt + 1_000);
      const result = clearScoped("claude-code", ACCOUNT, OPUS);
      expect(result.cleared).toBe(1);
      expect(cachedRefusal("claude-code", ACCOUNT, OPUS)).toBeNull();
      expect(cachedRefusal("claude-code", ACCOUNT, SONNET)!.resetAtMs).toBe(resetAt + 1_000);
    });

    test("clear one account clears every model for it", () => {
      const resetAt = Date.now() + 3 * 24 * 60 * 60 * 1000;
      cache(OPUS, resetAt);
      cache(SONNET, resetAt + 1_000);
      cache(HAIKU, resetAt + 2_000);
      const result = clearScoped("claude-code", ACCOUNT);
      expect(result.cleared).toBe(3);
    });

    test("clearScoped with model but no account refuses", () => {
      expect(() => clearScoped("claude-code", null, OPUS)).toThrow(/requires an account label/);
    });

    test("clearAll bumps generation so in-flight tokens cannot write", () => {
      const resetAt = Date.now() + 3 * 24 * 60 * 60 * 1000;
      const token = openWrite("claude-code", ACCOUNT, OPUS);
      clearAll("claude-code");
      const stored = recordRefusal(token, resetAt);
      expect(stored).toBe(false);  // token generation stale
      expect(cachedRefusal("claude-code", ACCOUNT, OPUS)).toBeNull();
    });
  });

  describe("generation and revision discipline", () => {
    test("a later refusal with higher revision wins; an older revision is dropped", () => {
      const firstReset = Date.now() + 3 * 60 * 60 * 1000;
      const tokenA = openWrite("claude-code", ACCOUNT, OPUS);
      recordRefusal(tokenA, firstReset);

      // Open a new token (reads current state), simulate a concurrent writer with a stale token.
      const tokenC = openWrite("claude-code", ACCOUNT, OPUS);  // fresh token sees the current revision
      const secondReset = firstReset + 60_000;
      const rec = recordRefusal(tokenC, secondReset);
      expect(rec).toBe(true);
      expect(cachedRefusal("claude-code", ACCOUNT, OPUS)!.resetAtMs).toBe(secondReset);

      // tokenA is now stale (revision behind tokenC's write).
      const stale = recordRefusal(tokenA, firstReset);
      expect(stale).toBe(false);
    });

    test("retireRefusalBySuccess clears only when the token's revision matches or is newer", () => {
      const resetAt = Date.now() + 3 * 60 * 60 * 1000;
      const tokenA = openWrite("claude-code", ACCOUNT, OPUS);
      recordRefusal(tokenA, resetAt);
      // Fresh token: its revision is at or beyond the stored one.
      const tokenNow = openWrite("claude-code", ACCOUNT, OPUS);
      const retired = retireRefusalBySuccess(tokenNow);
      expect(retired).toBe(true);
      expect(cachedRefusal("claude-code", ACCOUNT, OPUS)).toBeNull();
    });
  });

  test("cachedRefusalsForAccount lists every active scope under an account", () => {
    const resetAt = Date.now() + 3 * 60 * 60 * 1000;
    cache(OPUS, resetAt);
    cache(SONNET, resetAt + 1_000);
    cache(FABLE, resetAt + 2_000);
    const records = cachedRefusalsForAccount("claude-code", ACCOUNT);
    expect(records).toHaveLength(3);
    // Different account's cache is excluded.
    cache(HAIKU, resetAt + 3_000);
    const tokenOther = openWrite("claude-code", "tejas@chann.app", OPUS);
    recordRefusal(tokenOther, resetAt + 4_000);
    expect(cachedRefusalsForAccount("claude-code", ACCOUNT)).toHaveLength(4);
    expect(cachedRefusalsForAccount("claude-code", "tejas@chann.app")).toHaveLength(1);
  });
});
