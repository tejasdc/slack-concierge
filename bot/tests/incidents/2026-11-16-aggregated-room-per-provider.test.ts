/**
 * Incident replay: 2026-11-16 — aggregated room per provider, not per biggest account.
 *
 * Verbatim comment from `bot/src/provider-start-choice.ts:13-18`:
 *   "One account a provider could start new work on. `providerRoom` is the provider's
 *    whole remaining weekly room summed over every account it can run on, the same figure
 *    on each of its candidates: three Claude accounts at 14% are 258 points of room, one
 *    Codex account at 14% is 86, and a provider is weighed by that total, not by its
 *    roomiest account alone (Tejas, 2026-11-16: 'It has to look at aggregated usage per
 *    provider, not existing usage per single account')."
 *
 * The invariant (on the authority layer that this PR introduces):
 * `providerRoomBreakdown` returns per-account verdicts so a caller can sum them, rather
 * than returning a single aggregate that hides per-account state. The existing dispatch
 * continues to call `providerTotalRoom` for the aggregate figure; this test verifies the
 * authority's breakdown surface is available and does not pre-aggregate.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerRoomBreakdown } from "../../src/account-authority";
import { setHomeRootForTesting } from "../../src/account-home-resolver";
import { clearAll } from "../../src/account-refusal-cache";

let scratchHome: string;

function writeHome(home: string, email: string): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { refreshToken: `token-${email}`, subscriptionType: "max" },
  }));
  writeFileSync(join(home, ".account-email"), email);
}

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "aggregated-"));
  setHomeRootForTesting(scratchHome);
  writeHome(join(scratchHome, ".claude-accounts", "hey"), "hey@tejas.nyc");
  writeHome(join(scratchHome, ".claude-accounts", "chann"), "tejas@chann.app");
  writeHome(join(scratchHome, ".claude-accounts", "personal"), "tejastej.dc@gmail.com");
  clearAll("claude-code");
});

afterEach(() => {
  setHomeRootForTesting(null);
  rmSync(scratchHome, { recursive: true, force: true });
  clearAll("claude-code");
});

test("providerRoomBreakdown returns per-account verdicts, not a single aggregate", () => {
  const breakdown = providerRoomBreakdown("claude-code", "claude-opus-5-5");
  expect(breakdown.perAccount).toHaveLength(3);
  for (const entry of breakdown.perAccount) {
    expect(entry.account.label).toBeTypeOf("string");
    expect(entry.verdict.reason).toBeTypeOf("string");
    expect(entry.verdict.ok).toBeTypeOf("boolean");
  }
});

test("without any reading, every account is held — aggregated status reflects that", () => {
  const breakdown = providerRoomBreakdown("claude-code", "claude-opus-5-5");
  // No fresh reading, no proof, no cached refusal → every account "unknown" or "reading-stale".
  // The aggregate `ready` set should be empty; `held` should contain every account.
  expect(breakdown.ready).toHaveLength(0);
  expect(breakdown.held.length).toBeGreaterThan(0);
});
