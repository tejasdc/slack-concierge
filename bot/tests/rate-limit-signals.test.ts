/**
 * Tests for the structured-vs-synthetic rate-limit interpretation.
 *
 * Preserved dated incident reasons:
 *   - 2026-11-19 — Opus-only refusal blocked every Claude turn (fault F4).
 *     "Anthropic's stream can carry a structured `rate_limit_event { status: 'allowed' }`
 *      and a `<synthetic>` 'weekly limit' text at the same time; the synthetic cached
 *      a phantom refusal even when the structured event explicitly said the request was allowed."
 *     — `docs/incidents/2026-11-19-opus-only-refusal-blocked-every-claude-turn.md`
 *   - 2026-11-02 — The synthetic filter was added for a different bug. Preserving:
 *     the terminal still treats a synthetic-only turn as exhausted; structured just overrides.
 *     — `docs/incidents/2026-11-02-fresh-request-failed-instead-of-moving.md` (preserved)
 *
 * Run with: CONCIERGE_TEST_AUTHORIZATION=<token> bun test tests/rate-limit-signals.test.ts
 */
import { describe, expect, test } from "bun:test";
import {
  clearSignals,
  emptySignals,
  observeRateLimitEvent,
  observeSyntheticText,
  terminalVerdict,
} from "../src/rate-limit-signals";

const matchesExhaustion = (text: string): boolean => /weekly limit|usage limit|out of (usage|credits)/i.test(text);
const parseResetFromText = (text: string): number | null => {
  const match = text.match(/resets?\s+(?:at|on)?\s*([^.]+)/i);
  if (!match) return null;
  const parsed = Date.parse(match[1]!);
  return Number.isNaN(parsed) ? null : parsed;
};

describe("terminal verdict — rate_limit_event vs <synthetic>", () => {
  test("structured rejected only → exhausted with reset", () => {
    const signals = emptySignals();
    observeRateLimitEvent(signals, { rate_limit_info: { status: "rejected", resetsAt: "2026-11-22T22:00:00Z" } });
    const verdict = terminalVerdict(signals);
    expect(verdict.usageExhausted).toBe(true);
    expect(verdict.resetAtMs).toBe(Date.parse("2026-11-22T22:00:00Z"));
    expect(verdict.reason).toBe("structured-rejected");
  });

  test("structured allowed only → not exhausted", () => {
    const signals = emptySignals();
    observeRateLimitEvent(signals, { rate_limit_info: { status: "allowed", resetsAt: null } });
    const verdict = terminalVerdict(signals);
    expect(verdict.usageExhausted).toBe(false);
    expect(verdict.reason).toBe("structured-allowed");
  });

  test("synthetic only (no structured) → exhausted with parsed reset", () => {
    const signals = emptySignals();
    observeSyntheticText(
      signals,
      "You've hit your weekly limit. Resets at 2026-11-22T22:00:00Z.",
      matchesExhaustion,
      parseResetFromText,
    );
    const verdict = terminalVerdict(signals);
    expect(verdict.usageExhausted).toBe(true);
    expect(verdict.resetAtMs).toBe(Date.parse("2026-11-22T22:00:00Z"));
    expect(verdict.reason).toBe("synthetic-only");
  });

  test("F4 — structured allowed + synthetic exhausted → NOT exhausted, conflict logged", () => {
    // The Nov 19 exact scenario: Anthropic replied allowed; stale CLI synthetic said weekly limit.
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
    expect(verdict.conflict).not.toBeNull();
    expect(verdict.conflict!.kind).toBe("synthetic-overrides-structured");
  });

  test("rejected latches even after a later allowed in the same turn", () => {
    const signals = emptySignals();
    observeRateLimitEvent(signals, { rate_limit_info: { status: "rejected", resetsAt: "2026-11-22T22:00:00Z" } });
    observeRateLimitEvent(signals, { rate_limit_info: { status: "allowed", resetsAt: null } });
    const verdict = terminalVerdict(signals);
    expect(verdict.usageExhausted).toBe(true);
    expect(verdict.reason).toBe("structured-rejected");
  });

  test("clearSignals resets flags for a model switch", () => {
    const signals = emptySignals();
    observeRateLimitEvent(signals, { rate_limit_info: { status: "rejected", resetsAt: "2026-11-22T22:00:00Z" } });
    clearSignals(signals);
    observeRateLimitEvent(signals, { rate_limit_info: { status: "allowed", resetsAt: null } });
    const verdict = terminalVerdict(signals);
    expect(verdict.usageExhausted).toBe(false);
    expect(verdict.reason).toBe("structured-allowed");
  });

  test("no signal at all → not exhausted", () => {
    const signals = emptySignals();
    const verdict = terminalVerdict(signals);
    expect(verdict.usageExhausted).toBe(false);
    expect(verdict.reason).toBe("no-signal");
  });

  test("warning status counts as allowed (not rejected)", () => {
    const signals = emptySignals();
    observeRateLimitEvent(signals, { rate_limit_info: { status: "warning", resetsAt: null } });
    const verdict = terminalVerdict(signals);
    expect(verdict.usageExhausted).toBe(false);
    expect(verdict.reason).toBe("structured-allowed");
  });

  test("reset field in epoch seconds is normalized to milliseconds", () => {
    const signals = emptySignals();
    const secondsSinceEpoch = Math.floor(Date.parse("2026-11-22T22:00:00Z") / 1000);
    observeRateLimitEvent(signals, { rate_limit_info: { status: "rejected", resetsAt: secondsSinceEpoch } });
    const verdict = terminalVerdict(signals);
    expect(verdict.resetAtMs).toBe(secondsSinceEpoch * 1000);
  });

  test("synthetic text that doesn't match exhaustion is ignored", () => {
    const signals = emptySignals();
    observeSyntheticText(signals, "Compacting conversation history...", matchesExhaustion, parseResetFromText);
    const verdict = terminalVerdict(signals);
    expect(verdict.usageExhausted).toBe(false);
    expect(verdict.reason).toBe("no-signal");
  });

  test("reset-mismatch conflict when structured and synthetic resets differ", () => {
    const signals = emptySignals();
    observeRateLimitEvent(signals, { rate_limit_info: { status: "rejected", resetsAt: "2026-11-19T20:00:00Z" } });
    observeSyntheticText(
      signals,
      "You've hit your weekly limit. Resets at 2026-11-22T22:00:00Z.",
      matchesExhaustion,
      parseResetFromText,
    );
    const verdict = terminalVerdict(signals);
    expect(verdict.usageExhausted).toBe(true);
    expect(verdict.conflict?.kind).toBe("reset-mismatch");
  });
});
