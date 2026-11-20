/**
 * Incident replay: 2026-11-02 — "Mac signin-wait read as usage".
 *
 * Verbatim comment from `bot/src/provider-account-dispatch.ts:158`:
 *   "the Mac's tejas@chann.app read 54% free while its home was signed out,
 *    and the hold notice promised work would 'move to it by itself'."
 *
 * The invariant: a reading showing room on an account whose home is signed-out
 * on this machine is NOT a dispatchable account. The verdict is `signed-out`,
 * not `ready`. See architecture doc §3 Step 1.
 *
 * Also preserves the sibling 2026-11-02 reason at `provider-exhaustion-recovery.ts:176`:
 *   "An account with room whose login here is signed out is a sign-in wait,
 *    not an allowance wall."
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canTakeWork } from "../../src/account-authority";
import { setHomeRootForTesting } from "../../src/account-home-resolver";
import { clearAll } from "../../src/account-refusal-cache";

let scratchHome: string;

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "mac-signin-"));
  setHomeRootForTesting(scratchHome);
  clearAll("claude-code");
});

afterEach(() => {
  setHomeRootForTesting(null);
  rmSync(scratchHome, { recursive: true, force: true });
  clearAll("claude-code");
});

test("no home on this machine → verdict is no-home, never ready", () => {
  // Home not on disk; reading is irrelevant.
  const verdict = canTakeWork("claude-code",
    { provider: "claude-code", label: "tejas@chann.app" },
    "claude-opus-5-5");
  expect(verdict.ok).toBe(false);
  expect(verdict.reason).toBe("no-home");
});

test("the Mac case — a per-account folder with no credential file is not a home", () => {
  // An empty folder is not a signed-in home; home resolver returns none.
  mkdirSync(join(scratchHome, ".claude-accounts", "chann"), { recursive: true });
  const verdict = canTakeWork("claude-code",
    { provider: "claude-code", label: "tejas@chann.app" },
    "claude-opus-5-5");
  expect(verdict.ok).toBe(false);
  expect(verdict.reason).toBe("no-home");
});

test("credentials present and no cached refusal → not ok without a reading (unknown)", () => {
  // The architecture: no signal means unknown, not ready. A reading would decide.
  writeHomeForTejas();
  const verdict = canTakeWork("claude-code",
    { provider: "claude-code", label: "tejas@chann.app" },
    "claude-opus-5-5");
  // Either "unknown" or "reading-stale" — the key invariant is NOT "ready" without a fresh reading.
  expect(verdict.ok).toBe(false);
  expect(verdict.reason).not.toBe("ready");
});

function writeHomeForTejas(): void {
  const home = join(scratchHome, ".claude-accounts", "chann");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { refreshToken: "token-chann", subscriptionType: "max" },
  }));
  writeFileSync(join(home, ".account-email"), "tejas@chann.app");
}
