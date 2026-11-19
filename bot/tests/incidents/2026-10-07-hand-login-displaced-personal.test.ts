/**
 * Incident replay: 2026-10-07 — hand `/login` displaced his personal account.
 *
 * Verbatim comment from `bot/src/provider-account-dispatch.ts:193`:
 *   "a hand sign-in as tejas@chann.app replaced his personal account that way, and
 *    his personal account dropped out of agents' work with nothing said."
 *
 * The invariant: a hand `/login` into the live root for a NEW account (no per-account
 * folder) is NEVER a launch home. The resolver reports `new-account-in-live-root` so
 * the operator can migrate, but it does not replace an existing per-account folder's
 * account. Preserves F3 for its migration case.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAccounts, liveRootOrphans, resolveAccountHome, setHomeRootForTesting } from "../../src/account-home-resolver";

let scratchHome: string;

function writeHome(home: string, email: string, refreshToken: string = `token-${email}`): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { refreshToken, subscriptionType: "max" },
  }));
  writeFileSync(join(home, ".account-email"), email);
}

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "hand-login-"));
  setHomeRootForTesting(scratchHome);
});

afterEach(() => {
  setHomeRootForTesting(null);
  rmSync(scratchHome, { recursive: true, force: true });
});

test("hand `/login` for a NEW account does not appear in listAccounts", () => {
  writeHome(join(scratchHome, ".claude-accounts", "hey"), "hey@tejas.nyc");
  // Hand sign-in of a new account into the live root (not in a per-account folder).
  writeHome(join(scratchHome, ".claude"), "newaccount@tejas.nyc");
  const labels = listAccounts("claude-code").map(a => a.label);
  expect(labels).toEqual(["hey@tejas.nyc"]);
  expect(labels).not.toContain("newaccount@tejas.nyc");
});

test("the hand-login orphan is reported by liveRootOrphans for migration", () => {
  writeHome(join(scratchHome, ".claude-accounts", "hey"), "hey@tejas.nyc");
  writeHome(join(scratchHome, ".claude"), "newaccount@tejas.nyc");
  const orphans = liveRootOrphans("claude-code");
  expect(orphans.map(o => o.label)).toEqual(["newaccount@tejas.nyc"]);
});

test("existing per-account folder keeps winning when the live root duplicates its account", () => {
  // Nov 19 F3 variant: hand `/login` matched an existing per-account folder's account.
  writeHome(join(scratchHome, ".claude-accounts", "hey"), "hey@tejas.nyc", "token-hey");
  writeHome(join(scratchHome, ".claude"), "hey@tejas.nyc", "token-hey");
  const result = resolveAccountHome("claude-code", "hey@tejas.nyc");
  expect(result.kind).toBe("resolved");
  if (result.kind !== "resolved") return;
  expect(result.record.liveRootMirror).toBe(true);
  expect(result.record.canonicalHome).toBe(join(scratchHome, ".claude-accounts", "hey"));
});
