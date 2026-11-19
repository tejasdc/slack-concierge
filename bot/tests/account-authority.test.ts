/**
 * Tests for `account-authority.ts` — the single `canTakeWork` authority.
 *
 * Preserved dated reasons live in the per-state transitions. Full index in the
 * architecture doc at `docs/plans/2026-11-19-provider-account-rebuild-architecture.md` §3.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canTakeWork, canTakeAnyWork, listAccounts } from "../src/account-authority";
import { setHomeRootForTesting } from "../src/account-home-resolver";
import { clearAll, openWrite, recordRefusal } from "../src/account-refusal-cache";

const ACCOUNT = "hey@tejas.nyc";
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";

let scratchHome: string;

function writeClaudeHome(home: string, email: string, refreshToken: string = `token-${email}`): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { refreshToken, subscriptionType: "max" },
  }));
  writeFileSync(join(home, ".account-email"), email);
}

describe("canTakeWork — state transitions", () => {
  beforeEach(() => {
    scratchHome = mkdtempSync(join(tmpdir(), "authority-"));
    setHomeRootForTesting(scratchHome);
    clearAll("claude-code");
    clearAll("codex");
  });

  afterEach(() => {
    setHomeRootForTesting(null);
    rmSync(scratchHome, { recursive: true, force: true });
    clearAll("claude-code");
    clearAll("codex");
  });

  test("no home → ok:false reason:no-home", () => {
    const verdict = canTakeWork("claude-code", { provider: "claude-code", label: ACCOUNT }, OPUS);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("no-home");
  });

  test("live-root-only account → ok:false reason:no-home with liveRootMirror hint", () => {
    writeClaudeHome(join(scratchHome, ".claude"), ACCOUNT);
    const verdict = canTakeWork("claude-code", { provider: "claude-code", label: ACCOUNT }, OPUS);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("no-home");
    expect(verdict.source.liveRootMirror).toBe(true);
  });

  test("per-account folder + no reading → ok:false reason:unknown", () => {
    writeClaudeHome(join(scratchHome, ".claude-accounts", "hey"), ACCOUNT);
    const verdict = canTakeWork("claude-code", { provider: "claude-code", label: ACCOUNT }, OPUS);
    // No reading is "unknown"; it's not launchable without proof or last-good signal.
    expect(verdict.ok).toBe(false);
    expect(["unknown", "reading-stale"]).toContain(verdict.reason);
  });

  test("cached refusal for this model → ok:false reason:cached-refusal with clearsAt", () => {
    writeClaudeHome(join(scratchHome, ".claude-accounts", "hey"), ACCOUNT);
    const reset = Date.now() + 3 * 24 * 60 * 60 * 1000;
    const token = openWrite("claude-code", ACCOUNT, OPUS);
    recordRefusal(token, reset);
    const verdict = canTakeWork("claude-code", { provider: "claude-code", label: ACCOUNT }, OPUS);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("cached-refusal");
    expect(verdict.clearsAtMs).toBe(reset);
  });

  test("F1 scoped — Opus cache does NOT block Sonnet's verdict", () => {
    writeClaudeHome(join(scratchHome, ".claude-accounts", "hey"), ACCOUNT);
    const reset = Date.now() + 3 * 24 * 60 * 60 * 1000;
    const token = openWrite("claude-code", ACCOUNT, OPUS);
    recordRefusal(token, reset);
    const opusVerdict = canTakeWork("claude-code", { provider: "claude-code", label: ACCOUNT }, OPUS);
    const sonnetVerdict = canTakeWork("claude-code", { provider: "claude-code", label: ACCOUNT }, SONNET);
    expect(opusVerdict.reason).toBe("cached-refusal");
    // Sonnet has no cache. With no reading either, Sonnet's verdict is "unknown"
    // (not "cached-refusal") — crucially, Opus's cache did not poison it.
    expect(sonnetVerdict.reason).not.toBe("cached-refusal");
  });
});

describe("canTakeAnyWork — chain walk", () => {
  beforeEach(() => {
    scratchHome = mkdtempSync(join(tmpdir(), "authority-any-"));
    setHomeRootForTesting(scratchHome);
    clearAll("claude-code");
    clearAll("codex");
  });

  afterEach(() => {
    setHomeRootForTesting(null);
    rmSync(scratchHome, { recursive: true, force: true });
    clearAll("claude-code");
    clearAll("codex");
  });

  test("Opus-only cached refusal does not block the any-work verdict (Sonnet has room)", () => {
    writeClaudeHome(join(scratchHome, ".claude-accounts", "hey"), ACCOUNT);
    const reset = Date.now() + 3 * 24 * 60 * 60 * 1000;
    const token = openWrite("claude-code", ACCOUNT, OPUS);
    recordRefusal(token, reset);
    const verdict = canTakeAnyWork("claude-code", { provider: "claude-code", label: ACCOUNT });
    // "any work" walks the chain; finding Sonnet with no cached refusal, the verdict is non-cached-refusal.
    expect(verdict.reason).not.toBe("cached-refusal");
  });
});

describe("listAccounts", () => {
  beforeEach(() => {
    scratchHome = mkdtempSync(join(tmpdir(), "authority-list-"));
    setHomeRootForTesting(scratchHome);
  });

  afterEach(() => {
    setHomeRootForTesting(null);
    rmSync(scratchHome, { recursive: true, force: true });
  });

  test("returns one HomeRecord per account on this machine", () => {
    writeClaudeHome(join(scratchHome, ".claude-accounts", "hey"), ACCOUNT);
    writeClaudeHome(join(scratchHome, ".claude-accounts", "chann"), "tejas@chann.app");
    const accounts = listAccounts("claude-code");
    expect(accounts.map(a => a.label).sort()).toEqual(["hey@tejas.nyc", "tejas@chann.app"]);
  });

  test("antigravity has no local homes (keyring-managed)", () => {
    expect(listAccounts("antigravity")).toEqual([]);
  });
});
