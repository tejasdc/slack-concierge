/**
 * Incident replay: 2026-11-19 — a refusal whose resetsAt matches no window of the
 * labeled account indicates a wrong-home binding.
 *
 * Verbatim (addendum):
 *   "A refusal's `resetsAt` MUST be compared to the account's own window. If a refusal's
 *    `resetsAt` doesn't match any window in the fresh reading for the labeled account,
 *    that's a strong signal the refusal is from a DIFFERENT account (wrong-home binding).
 *    Log `rate_limit_event_account_mismatch` and refuse to cache the refusal under the
 *    labeled account's scope."
 *
 * Invariant: `detectAccountMismatch(signals, reading)` returns a `ConflictNote` when a
 * structured-rejected `resetsAt` matches no window of the labeled account within 60s.
 */
import { describe, expect, test } from "bun:test";
import {
  detectAccountMismatch,
  emptySignals,
  observeRateLimitEvent,
} from "../../src/rate-limit-signals";

test("rate_limit_event resetsAt not matching any labeled-account window flags a mismatch", () => {
  const signals = emptySignals();
  observeRateLimitEvent(signals, {
    rate_limit_info: { status: "rejected", resetsAt: "2026-11-22T22:00:00Z" },
  });
  // The labeled account's windows end Nov-19 — not Nov-22. Mismatch.
  const reading = {
    accountLabel: "hey@tejas.nyc",
    windowResetAtMs: [Date.parse("2026-11-19T20:00:00Z"), Date.parse("2026-11-20T01:00:00Z")],
  };
  const conflict = detectAccountMismatch(signals, reading);
  expect(conflict).not.toBeNull();
  expect(conflict!.kind).toBe("rate_limit_event_account_mismatch");
});

test("no mismatch when a window's reset matches within 60 seconds", () => {
  const signals = emptySignals();
  observeRateLimitEvent(signals, {
    rate_limit_info: { status: "rejected", resetsAt: "2026-11-22T22:00:00Z" },
  });
  const reading = {
    accountLabel: "tejas@chann.app",
    windowResetAtMs: [Date.parse("2026-11-22T22:00:30Z")],  // 30 seconds off
  };
  expect(detectAccountMismatch(signals, reading)).toBeNull();
});

test("no mismatch when there is no structured reset to compare", () => {
  const signals = emptySignals();
  const reading = {
    accountLabel: "hey@tejas.nyc",
    windowResetAtMs: [Date.parse("2026-11-19T20:00:00Z")],
  };
  expect(detectAccountMismatch(signals, reading)).toBeNull();
});

test("no mismatch when the reading has no windows to compare against", () => {
  const signals = emptySignals();
  observeRateLimitEvent(signals, {
    rate_limit_info: { status: "rejected", resetsAt: "2026-11-22T22:00:00Z" },
  });
  const reading = { accountLabel: "hey@tejas.nyc", windowResetAtMs: [] };
  expect(detectAccountMismatch(signals, reading)).toBeNull();
});

test("no mismatch when a reading is null (unknown — not evidence either way)", () => {
  const signals = emptySignals();
  observeRateLimitEvent(signals, {
    rate_limit_info: { status: "rejected", resetsAt: "2026-11-22T22:00:00Z" },
  });
  expect(detectAccountMismatch(signals, null)).toBeNull();
});
