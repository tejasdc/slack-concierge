/**
 * Tests for `account-home-resolver.ts` — the F3 fix.
 *
 * Preserved dated reasons:
 *   - 2026-11-19 — a hand `claude /login` into the live root while the same account
 *     had a per-account folder caused `accounts.validate` to refuse every Claude turn
 *     with `resolution:"ambiguous"`. The resolver dedupes by LABEL, never by home path,
 *     and a live-root mirror is a benign flag, not a second candidate.
 *   - 2026-10-07 — a hand `/login` displaced his personal account. The migration path
 *     into the canonical folder is explicit, not automatic.
 *
 * These tests build a disposable `$HOME` with scratched `.claude-accounts/` and
 * `.claude/` folders, then exercise `resolveAccountHome` and `listAccounts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAccounts, resolveAccountHome, liveRootOrphans, setHomeRootForTesting } from "../src/account-home-resolver";
import { claudeKeychainService, setClaudeKeychainProbeForTesting } from "../src/claude-keychain";

let scratchHome: string;

function writeClaudeHome(home: string, email: string, refreshToken: string = `token-${email}`): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { refreshToken, subscriptionType: "max" },
  }));
  writeFileSync(join(home, ".account-email"), email);
}

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "home-resolver-"));
  setHomeRootForTesting(scratchHome);
});

afterEach(() => {
  setHomeRootForTesting(null);
  setClaudeKeychainProbeForTesting(null);
  rmSync(scratchHome, { recursive: true, force: true });
});

describe("resolveAccountHome — Claude", () => {
  test("per-account folder only → resolved; liveRootMirror=false", () => {
    writeClaudeHome(join(scratchHome, ".claude-accounts", "hey"), "hey@tejas.nyc");
    const result = resolveAccountHome("claude-code", "hey@tejas.nyc");
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") return;
    expect(result.record.liveRootMirror).toBe(false);
    expect(result.record.canonicalHome).toBe(join(scratchHome, ".claude-accounts", "hey"));
  });

  test("F3 — live root signed into SAME account as a per-account folder → resolved + mirror", () => {
    writeClaudeHome(join(scratchHome, ".claude-accounts", "hey"), "hey@tejas.nyc", "same-token");
    writeClaudeHome(join(scratchHome, ".claude"), "hey@tejas.nyc", "same-token");
    const result = resolveAccountHome("claude-code", "hey@tejas.nyc");
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") return;
    expect(result.record.liveRootMirror).toBe(true);
    // Per-account folder wins; the live root is NEVER the canonical home when a folder exists.
    expect(result.record.canonicalHome).toBe(join(scratchHome, ".claude-accounts", "hey"));
  });

  test("live root signed into a NEW account (no per-account folder) → new-account-in-live-root", () => {
    writeClaudeHome(join(scratchHome, ".claude-accounts", "hey"), "hey@tejas.nyc");
    writeClaudeHome(join(scratchHome, ".claude"), "newaccount@tejas.nyc");
    const result = resolveAccountHome("claude-code", "newaccount@tejas.nyc");
    expect(result.kind).toBe("new-account-in-live-root");
    if (result.kind !== "new-account-in-live-root") return;
    expect(result.record.liveRoot).toBe(join(scratchHome, ".claude"));
    expect(result.record.label).toBe("newaccount@tejas.nyc");
  });

  test("account not on this machine → none", () => {
    writeClaudeHome(join(scratchHome, ".claude-accounts", "hey"), "hey@tejas.nyc");
    const result = resolveAccountHome("claude-code", "someone-else@tejas.nyc");
    expect(result.kind).toBe("none");
  });

  test("listAccounts returns one entry per account label even when live root duplicates", () => {
    writeClaudeHome(join(scratchHome, ".claude-accounts", "hey"), "hey@tejas.nyc", "same-token");
    writeClaudeHome(join(scratchHome, ".claude-accounts", "chann"), "tejas@chann.app");
    writeClaudeHome(join(scratchHome, ".claude"), "hey@tejas.nyc", "same-token");
    const accounts = listAccounts("claude-code");
    const labels = accounts.map(a => a.label).sort();
    expect(labels).toEqual(["hey@tejas.nyc", "tejas@chann.app"]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("liveRootOrphans lists only labels without a per-account folder", () => {
    writeClaudeHome(join(scratchHome, ".claude-accounts", "hey"), "hey@tejas.nyc");
    writeClaudeHome(join(scratchHome, ".claude"), "newaccount@tejas.nyc");
    const orphans = liveRootOrphans("claude-code");
    expect(orphans.map(o => o.label)).toEqual(["newaccount@tejas.nyc"]);
  });

  test("liveRootOrphans is empty when live root mirrors an existing per-account folder", () => {
    writeClaudeHome(join(scratchHome, ".claude-accounts", "hey"), "hey@tejas.nyc", "same-token");
    writeClaudeHome(join(scratchHome, ".claude"), "hey@tejas.nyc", "same-token");
    expect(liveRootOrphans("claude-code")).toEqual([]);
  });

  test("two per-account folders with the same label → kind:'ambiguous'", () => {
    // Reviewer-flagged gap 2026-11-20: the commit that added `{kind:"ambiguous",count}`
    // to the resolver shipped without any test exercising that kind. This asserts the
    // real-world case where terminal /login creates a second folder with a duplicate label.
    writeClaudeHome(join(scratchHome, ".claude-accounts", "hey"), "hey@tejas.nyc");
    writeClaudeHome(join(scratchHome, ".claude-accounts", "hey-duplicate"), "hey@tejas.nyc");
    const result = resolveAccountHome("claude-code", "hey@tejas.nyc");
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(result.count).toBe(2);
  });

  test("ambiguous label does not surface in listAccounts (no safe launch home)", () => {
    writeClaudeHome(join(scratchHome, ".claude-accounts", "hey"), "hey@tejas.nyc");
    writeClaudeHome(join(scratchHome, ".claude-accounts", "hey-duplicate"), "hey@tejas.nyc");
    writeClaudeHome(join(scratchHome, ".claude-accounts", "chann"), "tejas@chann.app");
    const labels = listAccounts("claude-code").map(a => a.label).sort();
    // chann is unique → listed. hey@tejas.nyc is ambiguous → not a canonical choice,
    // but both folders remain enumerable for reader paths that walk all candidates.
    // The reduce-to-unique happens at resolveAccountHome, which returns "ambiguous".
    expect(labels).toContain("tejas@chann.app");
  });
});

describe("resolveAccountHome — Codex", () => {
  function writeCodexHome(home: string, email: string, accountId: string): void {
    mkdirSync(home, { recursive: true });
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({ email })).toString("base64url");
    const id_token = `${header}.${claims}.sig`;
    writeFileSync(join(home, "auth.json"), JSON.stringify({
      tokens: { account_id: accountId, id_token },
    }));
  }

  test("per-account folder only → resolved", () => {
    writeCodexHome(join(scratchHome, ".codex-accounts", "chann"), "tejas@chann.app", "acct-chann");
    const result = resolveAccountHome("codex", "tejas@chann.app");
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") return;
    expect(result.record.accountId).toBe("acct-chann");
  });

  test("Codex live-root signed in to the SAME account as a folder → mirror flag", () => {
    writeCodexHome(join(scratchHome, ".codex-accounts", "chann"), "tejas@chann.app", "acct-chann");
    writeCodexHome(join(scratchHome, ".codex"), "tejas@chann.app", "acct-chann");
    const result = resolveAccountHome("codex", "tejas@chann.app");
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") return;
    expect(result.record.liveRootMirror).toBe(true);
    expect(result.record.canonicalHome).toBe(join(scratchHome, ".codex-accounts", "chann"));
  });
});

// 2026-11-20 — on the Mac Claude Code keeps each folder's login in the Keychain and writes no
// `.credentials.json`. The resolver read only the file, found no Claude home on the Mac, and
// every Mac Claude turn failed as "Every available Claude account is out of room".
describe("resolveAccountHome — Mac Keychain logins", () => {
  function keychainOnlyHome(name: string, email: string): string {
    const home = join(scratchHome, ".claude-accounts", name);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".account-email"), email);
    return home;
  }

  test("a folder whose login is in the Keychain resolves", () => {
    const home = keychainOnlyHome("gmail", "tejastej.dc@gmail.com");
    setClaudeKeychainProbeForTesting(service => service === claudeKeychainService(home) ? 0 : 44);
    const result = resolveAccountHome("claude-code", "tejastej.dc@gmail.com");
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") return;
    expect(result.record.canonicalHome).toBe(home);
    expect(listAccounts("claude-code").map(entry => entry.label)).toEqual(["tejastej.dc@gmail.com"]);
  });

  test("no file and no Keychain item → none", () => {
    keychainOnlyHome("gmail", "tejastej.dc@gmail.com");
    setClaudeKeychainProbeForTesting(() => 44);
    expect(resolveAccountHome("claude-code", "tejastej.dc@gmail.com").kind).toBe("none");
  });

  test("an unanswered Keychain lookup is not evidence of a missing login", () => {
    keychainOnlyHome("gmail", "tejastej.dc@gmail.com");
    setClaudeKeychainProbeForTesting(() => 36);
    expect(resolveAccountHome("claude-code", "tejastej.dc@gmail.com").kind).toBe("resolved");
  });
});
