/**
 * Incident replay: 2026-10-10 — a Claude account read 0% used while Claude refused work.
 *
 * Verbatim comment from `bot/src/provider-usage.ts` dispatch section (research plan citation):
 *   "A usage percentage is not proof, since it read zero while Claude refused real work on
 *    2026-10-10." See also the `claude_home_proof` table whose ledger-backed "proven_at_ms"
 *    exists for exactly this case (`bot/src/provider-account-selection.ts:22-27`).
 *
 * The invariant: when the periodic usage reader cannot confirm an account but the home has
 * been proven by a real successful turn within the last 10 minutes, `canTakeWork` returns
 * `proven-attempt`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canTakeWork } from "../../src/account-authority";
import { setHomeRootForTesting } from "../../src/account-home-resolver";
import { clearAll } from "../../src/account-refusal-cache";
import { recordClaudeHomeProof } from "../../src/provider-account-selection";

const ACCOUNT = "hey@tejas.nyc";
const OPUS = "claude-opus-5-5";

let scratchHome: string;
let homePath: string;

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "proven-attempt-"));
  setHomeRootForTesting(scratchHome);
  homePath = join(scratchHome, ".claude-accounts", "hey");
  mkdirSync(homePath, { recursive: true });
  writeFileSync(join(homePath, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { refreshToken: "token-hey", subscriptionType: "max" },
  }));
  writeFileSync(join(homePath, ".account-email"), ACCOUNT);
  clearAll("claude-code");
});

afterEach(() => {
  recordClaudeHomeProof(homePath, false);  // clean up
  setHomeRootForTesting(null);
  rmSync(scratchHome, { recursive: true, force: true });
  clearAll("claude-code");
});

test("a home proven within 10 minutes grants proven-attempt even without a fresh reading", () => {
  recordClaudeHomeProof(homePath, true);
  const verdict = canTakeWork("claude-code", { provider: "claude-code", label: ACCOUNT }, OPUS);
  expect(verdict.ok).toBe(true);
  expect(verdict.reason).toBe("proven-attempt");
  expect(verdict.source.homeProvenAtMs).toBeDefined();
});

test("a home never proven returns unknown or reading-stale, not proven-attempt", () => {
  // No proof recorded.
  const verdict = canTakeWork("claude-code", { provider: "claude-code", label: ACCOUNT }, OPUS);
  expect(verdict.ok).toBe(false);
  expect(verdict.reason).not.toBe("proven-attempt");
});
