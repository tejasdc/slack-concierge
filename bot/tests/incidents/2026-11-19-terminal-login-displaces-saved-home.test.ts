/**
 * Incident replay: 2026-11-19 — a terminal `/login` writes credentials into the
 * live root (`~/.claude/.credentials.json`). If a per-account folder for the same
 * label already exists, the launcher MUST still resolve to the folder; the live
 * root is only a mirror. The I3 reversal of the launcher's home iteration
 * complements the home-resolver's dedup: both now prefer the per-account folder.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAccounts, resolveAccountHome, setHomeRootForTesting } from "../../src/account-home-resolver";

let scratchHome: string;

function writeHome(home: string, email: string, refreshToken: string): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { refreshToken, subscriptionType: "max" },
  }));
  writeFileSync(join(home, ".account-email"), email);
}

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "terminal-login-"));
  setHomeRootForTesting(scratchHome);
});
afterEach(() => {
  setHomeRootForTesting(null);
  rmSync(scratchHome, { recursive: true, force: true });
});

test("terminal `/login` into live root for an account held in a folder doesn't displace the folder", () => {
  // Per-account folder exists first.
  writeHome(join(scratchHome, ".claude-accounts", "hey"), "hey@tejas.nyc", "token-hey-folder");
  // User runs `claude /login` in their shell; it writes to live root with the same account.
  writeHome(join(scratchHome, ".claude"), "hey@tejas.nyc", "token-hey-live");
  const result = resolveAccountHome("claude-code", "hey@tejas.nyc");
  expect(result.kind).toBe("resolved");
  if (result.kind !== "resolved") return;
  // The CANONICAL home is the per-account folder, NOT the live root, even though the
  // live-root credential is more recent. The live root is noted as a mirror.
  expect(result.record.canonicalHome).toBe(join(scratchHome, ".claude-accounts", "hey"));
  expect(result.record.liveRootMirror).toBe(true);
});

test("the resolver lists only ONE entry per label when terminal login duplicates a folder", () => {
  writeHome(join(scratchHome, ".claude-accounts", "hey"), "hey@tejas.nyc", "same-token");
  writeHome(join(scratchHome, ".claude"), "hey@tejas.nyc", "same-token");
  const accounts = listAccounts("claude-code");
  expect(accounts).toHaveLength(1);
  expect(accounts[0]!.canonicalHome).toBe(join(scratchHome, ".claude-accounts", "hey"));
  expect(accounts[0]!.liveRootMirror).toBe(true);
});

test("a terminal `/login` for a DIFFERENT (new) account doesn't appear in listAccounts", () => {
  // The existing per-account folder is the canonical home for `hey`; a shell sign-in
  // of a different account into the live root should be reported as an orphan, not
  // as a second launch candidate.
  writeHome(join(scratchHome, ".claude-accounts", "hey"), "hey@tejas.nyc", "token-hey");
  writeHome(join(scratchHome, ".claude"), "someone@else.com", "token-else");
  const accounts = listAccounts("claude-code");
  expect(accounts.map(a => a.label)).toEqual(["hey@tejas.nyc"]);
});
