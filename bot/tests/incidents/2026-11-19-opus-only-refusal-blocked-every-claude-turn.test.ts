/**
 * Incident replay: 2026-11-19 — "Room remains" sat beside "no account has room".
 *
 * Verbatim incident paragraph (from docs/incidents/2026-11-19-opus-only-refusal-blocked-every-claude-turn.md):
 *
 *   A Nov-22 Opus refusal cached under `hey@tejas.nyc` held the Inbox for hours while the
 *   same account's fresh reading showed 39% weekly used with a Nov-19 reset. The hold
 *   message named Nov 22. When the operator cleared the cache by hand and re-pressed, the
 *   bot's re-attempt received both a structured `rate_limit_event { status: "allowed" }` and
 *   a synthetic "You've hit your weekly limit" assistant text, and re-cached the same phantom
 *   Nov-22 refusal. After `claude /login` was run in the terminal to try a different path,
 *   `accounts.validate` reported `resolution:"ambiguous"` and every Claude turn refused with
 *   `Runner ax41 cannot resolve selected Claude account hey@tejas.nyc`.
 *
 * Four stacked faults:
 *   - F1 `claudeAccountCachedReset(account, null)` returned the max across any model scope.
 *     Fix: model-specific queries stay model-specific; `anyWorkCachedReset` walks the chain.
 *   - F2 No Claude equivalent of `retireCodexRefusalSupersededByReading`.
 *     Fix: `retireRefusalSupersededByReading` is generic.
 *   - F3 `runnerAccountHomes` enumerated live root + per-account folders as independent candidates.
 *     Fix: `account-home-resolver.ts` dedupes by label; live root is a benign mirror.
 *   - F4 `parsed.text` carried synthetic exhaustion overrode `rate_limit_event { status:"allowed" }`.
 *     Fix: `rate-limit-signals.ts` latches structured flags; structured beats synthetic.
 *
 * This file replays the Nov 19 scenario end-to-end at the primitive level.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  anyWorkCachedReset,
  cachedRefusal,
  clearAll,
  openWrite,
  recordRefusal,
  retireRefusalSupersededByReading,
} from "../../src/account-refusal-cache";
import {
  emptySignals,
  observeRateLimitEvent,
  observeSyntheticText,
  terminalVerdict,
} from "../../src/rate-limit-signals";
import {
  resolveAccountHome,
  setHomeRootForTesting,
} from "../../src/account-home-resolver";

const ACCOUNT = "hey@tejas.nyc";
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";
const matchesExhaustion = (text: string): boolean => /weekly limit|usage limit|out of (usage|credits)/i.test(text);
const parseResetFromText = (text: string): number | null => {
  const match = text.match(/resets?\s+(?:at|on)?\s*([^.]+)/i);
  if (!match) return null;
  const parsed = Date.parse(match[1]!);
  return Number.isNaN(parsed) ? null : parsed;
};

describe("2026-11-19 incident replays", () => {
  describe("F1 — Opus-only refusal does NOT block Sonnet/Haiku", () => {
    beforeEach(() => clearAll("claude-code"));
    afterEach(() => clearAll("claude-code"));

    test("Opus cache does not poison Sonnet model-specific reads", () => {
      const nov22 = Date.now() + 3 * 24 * 60 * 60 * 1000;
      const token = openWrite("claude-code", ACCOUNT, OPUS);
      recordRefusal(token, nov22);
      expect(cachedRefusal("claude-code", ACCOUNT, OPUS)!.resetAtMs).toBe(nov22);
      expect(cachedRefusal("claude-code", ACCOUNT, SONNET)).toBeNull();
      expect(cachedRefusal("claude-code", ACCOUNT, HAIKU)).toBeNull();
    });

    test("Opus cache alone does NOT trip any-work for the account (Sonnet/Haiku have room)", () => {
      const nov22 = Date.now() + 3 * 24 * 60 * 60 * 1000;
      const token = openWrite("claude-code", ACCOUNT, OPUS);
      recordRefusal(token, nov22);
      expect(anyWorkCachedReset(ACCOUNT)).toBeNull();
    });
  });

  describe("F2 — fresh reading retires the Claude cache", () => {
    beforeEach(() => clearAll("claude-code"));
    afterEach(() => clearAll("claude-code"));

    test("39% weekly used with Nov 19 reset retires a Nov 22 Opus refusal", () => {
      const nov22 = Date.now() + 3 * 24 * 60 * 60 * 1000;
      const nov19 = Date.now() + 1 * 24 * 60 * 60 * 1000;
      const token = openWrite("claude-code", ACCOUNT, OPUS);
      recordRefusal(token, nov22);
      const windows = [{ usedPercent: 39, resetsAt: new Date(nov19).toISOString() }];
      const readAt = Date.now() + 1_000;
      expect(retireRefusalSupersededByReading("claude-code", ACCOUNT, OPUS, windows, readAt)).toBe(true);
      expect(cachedRefusal("claude-code", ACCOUNT, OPUS)).toBeNull();
    });
  });

  describe("F3 — live-root mirror never refuses as ambiguous", () => {
    let scratchHome: string;
    beforeEach(() => {
      scratchHome = mkdtempSync(join(tmpdir(), "nov19-f3-"));
      setHomeRootForTesting(scratchHome);
    });
    afterEach(() => {
      setHomeRootForTesting(null);
      rmSync(scratchHome, { recursive: true, force: true });
    });

    function writeClaudeHome(home: string, email: string, refreshToken: string): void {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, ".credentials.json"), JSON.stringify({
        claudeAiOauth: { refreshToken, subscriptionType: "max" },
      }));
      writeFileSync(join(home, ".account-email"), email);
    }

    test("hand `claude /login` into live root + existing per-account folder → resolved, liveRootMirror=true", () => {
      writeClaudeHome(join(scratchHome, ".claude-accounts", "hey"), ACCOUNT, "token-hey");
      writeClaudeHome(join(scratchHome, ".claude"), ACCOUNT, "token-hey");
      const result = resolveAccountHome("claude-code", ACCOUNT);
      expect(result.kind).toBe("resolved");
      if (result.kind !== "resolved") return;
      expect(result.record.liveRootMirror).toBe(true);
      expect(result.record.canonicalHome).toBe(join(scratchHome, ".claude-accounts", "hey"));
    });
  });

  describe("F4 — structured 'allowed' beats synthetic 'weekly limit'", () => {
    test("Nov 19 exact scenario: allowed + synthetic weekly-limit → NOT cached as refusal", () => {
      const signals = emptySignals();
      observeRateLimitEvent(signals, { rate_limit_info: { status: "allowed", resetsAt: null } });
      observeSyntheticText(
        signals,
        "You've hit your weekly limit. Resets at 2026-11-22T22:00:00Z.",
        matchesExhaustion,
        parseResetFromText,
      );
      const verdict = terminalVerdict(signals);
      expect(verdict.usageExhausted).toBe(false);
      expect(verdict.reason).toBe("structured-allowed");
      expect(verdict.conflict?.kind).toBe("synthetic-overrides-structured");
    });

    test("synthetic-only still caches when no structured event arrives", () => {
      // Preserving the original purpose of `isClaudeUsageExhaustion`; a run that never saw
      // a `rate_limit_event` must not drop its synthetic exhaustion notice.
      const signals = emptySignals();
      observeSyntheticText(
        signals,
        "You've hit your weekly limit. Resets at 2026-11-22T22:00:00Z.",
        matchesExhaustion,
        parseResetFromText,
      );
      const verdict = terminalVerdict(signals);
      expect(verdict.usageExhausted).toBe(true);
      expect(verdict.reason).toBe("synthetic-only");
    });
  });
});
