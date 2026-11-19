/**
 * Incident replay: 2026-11-19 — `rate_limit_event.overageDisabledReason` is semantic.
 *
 * Verbatim (addendum):
 *   "Anthropic's `rate_limit_event.overageDisabledReason` is a semantic signal worth
 *    parsing. `"out_of_credits"` means 'paid credits exhausted,' `"org_level_disabled"`
 *    means 'org admin turned overage off.' These are different situations with different
 *    operator responses. The current code treats both as a generic 'rejected.' Add to
 *    the `CapabilityVerdict`: `overage_reason` so the UI can differentiate."
 *
 * Invariant: the rate-limit signals' `terminalVerdict` carries `overageReason`; the
 * refusal cache stores it; the authority's `CapabilityVerdict.source.overageReason`
 * surfaces it to callers (notice / UI / CLI) so they can differentiate the responses.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canTakeWork } from "../../src/account-authority";
import { setHomeRootForTesting } from "../../src/account-home-resolver";
import { clearAll, openWrite, recordRefusal } from "../../src/account-refusal-cache";
import { emptySignals, observeRateLimitEvent, terminalVerdict } from "../../src/rate-limit-signals";

const ACCOUNT = "hey@tejas.nyc";
const OPUS = "claude-opus-5-5";

let scratchHome: string;

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "overage-reason-"));
  setHomeRootForTesting(scratchHome);
  const home = join(scratchHome, ".claude-accounts", "hey");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { refreshToken: "token-hey", subscriptionType: "max" },
  }));
  writeFileSync(join(home, ".account-email"), ACCOUNT);
  clearAll("claude-code");
});

afterEach(() => {
  setHomeRootForTesting(null);
  rmSync(scratchHome, { recursive: true, force: true });
  clearAll("claude-code");
});

test("'out_of_credits' overage reason survives into the terminal verdict", () => {
  const signals = emptySignals();
  observeRateLimitEvent(signals, {
    rate_limit_info: { status: "rejected", resetsAt: "2026-12-01T00:00:00Z",
      rateLimitType: "seven_day", overageDisabledReason: "out_of_credits" },
  });
  const verdict = terminalVerdict(signals);
  expect(verdict.usageExhausted).toBe(true);
  expect(verdict.overageReason).toBe("out_of_credits");
  expect(verdict.rateLimitType).toBe("seven_day");
});

test("'org_level_disabled' is distinguished from 'out_of_credits'", () => {
  const signals = emptySignals();
  observeRateLimitEvent(signals, {
    rate_limit_info: { status: "rejected", resetsAt: "2026-12-01T00:00:00Z",
      overageDisabledReason: "org_level_disabled" },
  });
  const verdict = terminalVerdict(signals);
  expect(verdict.overageReason).toBe("org_level_disabled");
});

test("unknown overage reason strings normalize to 'other'", () => {
  const signals = emptySignals();
  observeRateLimitEvent(signals, {
    rate_limit_info: { status: "rejected", resetsAt: "2026-12-01T00:00:00Z",
      overageDisabledReason: "something_new" },
  });
  const verdict = terminalVerdict(signals);
  expect(verdict.overageReason).toBe("other");
});

test("authority verdict exposes overage reason via source.overageReason and explain", () => {
  const reset = Date.now() + 3 * 24 * 60 * 60 * 1000;
  const token = openWrite("claude-code", ACCOUNT, OPUS);
  recordRefusal(token, reset, Date.now(), { overageReason: "out_of_credits", rateLimitType: "seven_day" });
  const verdict = canTakeWork("claude-code", { provider: "claude-code", label: ACCOUNT }, OPUS);
  expect(verdict.ok).toBe(false);
  expect(verdict.reason).toBe("cached-refusal");
  expect(verdict.source.overageReason).toBe("out_of_credits");
  expect(verdict.source.rateLimitType).toBe("seven_day");
  expect(verdict.explain).toBe("out of paid credits");
});

test("org-disabled refusal shows the distinct UI explain text", () => {
  const reset = Date.now() + 3 * 24 * 60 * 60 * 1000;
  const token = openWrite("claude-code", ACCOUNT, OPUS);
  recordRefusal(token, reset, Date.now(), { overageReason: "org_level_disabled", rateLimitType: "seven_day" });
  const verdict = canTakeWork("claude-code", { provider: "claude-code", label: ACCOUNT }, OPUS);
  expect(verdict.explain).toBe("org disabled overage");
});
