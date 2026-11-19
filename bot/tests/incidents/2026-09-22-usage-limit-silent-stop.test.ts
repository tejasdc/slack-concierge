/**
 * Incident replay: 2026-09-22 — five-hour Claude limit silently destroyed nine inputs.
 *
 * Verbatim comment from `bot/src/provider-usage.ts:94-96`:
 *   "Refuses before sending, and says when the refusal clears. `clearsAtMs` is what keeps
 *    the input alive: nothing left this machine, so there is no uncertain provider effect
 *    to protect, and the turn waits in its own queue instead of being killed. Until
 *    2026-09-23 this threw a plain terminal failure, and a five-hour Claude limit silently
 *    destroyed nine of the Inbox's inputs — including the returns that were reporting the
 *    outage."
 *
 * The invariant: a cached-refusal verdict always carries `clearsAtMs` so the turn stays
 * queued. The authority NEVER returns a cached-refusal reason without a clearsAtMs set.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canTakeWork } from "../../src/account-authority";
import { setHomeRootForTesting } from "../../src/account-home-resolver";
import { clearAll, openWrite, recordRefusal } from "../../src/account-refusal-cache";

const ACCOUNT = "hey@tejas.nyc";
const OPUS = "claude-opus-5-5";

let scratchHome: string;

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "silent-stop-"));
  setHomeRootForTesting(scratchHome);
  mkdirSync(join(scratchHome, ".claude-accounts", "hey"), { recursive: true });
  writeFileSync(join(scratchHome, ".claude-accounts", "hey", ".credentials.json"), JSON.stringify({
    claudeAiOauth: { refreshToken: "token-hey", subscriptionType: "max" },
  }));
  writeFileSync(join(scratchHome, ".claude-accounts", "hey", ".account-email"), ACCOUNT);
  clearAll("claude-code");
});

afterEach(() => {
  setHomeRootForTesting(null);
  rmSync(scratchHome, { recursive: true, force: true });
  clearAll("claude-code");
});

test("a cached refusal produces a verdict with a non-null clearsAtMs — the turn stays queued", () => {
  const resetAt = Date.now() + 5 * 60 * 60 * 1000;  // five-hour reset
  const token = openWrite("claude-code", ACCOUNT, OPUS);
  recordRefusal(token, resetAt);
  const verdict = canTakeWork("claude-code", { provider: "claude-code", label: ACCOUNT }, OPUS);
  expect(verdict.ok).toBe(false);
  expect(verdict.reason).toBe("cached-refusal");
  expect(verdict.clearsAtMs).toBe(resetAt);  // NOT null — the turn stays queued to wait for this.
});
