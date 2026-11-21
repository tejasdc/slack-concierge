/**
 * Incident replay: 2026-11-21 — a stuck Claude usage probe silently discarded the
 * stored allowance windows and the dispatcher refused every turn with "Every available
 * Claude account is out of room," even though the Accounts tray clearly showed
 * tejas@chann.app at 75% used and tejastej.dc@gmail.com at 43%.
 *
 * What happened: every three minutes the probe batch logged
 * `provider_account_usage_observed provider:claude-code accounts:3 unreadable:3`.
 * The stored windows from a prior successful read were preserved (the tray rendered
 * them with "Showing the last reading; the latest could not be taken"), but
 * `canTakeWork` Step 5 required `reading.problem === null` to admit a stale-but-
 * positive reading. With the current probe marking the account `.problem="Usage
 * could not be read"`, Step 5 was skipped, Step 6 returned `reading-stale`, and the
 * dispatcher's attemptRoom filter did not list `reading-stale` as hold-worthy.
 *
 * The invariant: "the latest probe failed" is not the same as "your allowance is
 * invalid." Stored windows showing < 100% used remain the best signal we have; if
 * the attempt itself hits a wall, the server's refusal caches and blocks the next
 * pass. Refusing to try, while the only signal says go, guarantees a stuck state.
 *
 * Preserved context: see `account-authority.ts` Step 5 and the dispatcher
 * attemptRoom filter in `provider-account-dispatch.ts` (hold-worthy reasons:
 * `unknown`, `last-showed-room`, `proven-attempt`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canTakeWork } from "../../src/account-authority";
import { setHomeRootForTesting } from "../../src/account-home-resolver";
import { clearAll } from "../../src/account-refusal-cache";
import { db } from "../../src/state";

const ACCOUNT = "tejas@chann.app";
const OPUS = "claude-opus-5-5";

let scratchHome: string;

function writeClaudeHome(home: string, email: string): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { refreshToken: `token-${email}`, subscriptionType: "max" },
  }));
  writeFileSync(join(home, ".account-email"), email);
}

function seedClaudeUsage(payload: unknown, observedAtMs: number): void {
  db.query(`INSERT INTO provider_account_usage (provider, observed_at, usage_json) VALUES ('claude-code', ?, ?)
    ON CONFLICT(provider) DO UPDATE SET observed_at = excluded.observed_at, usage_json = excluded.usage_json`)
    .run(new Date(observedAtMs).toISOString(), JSON.stringify(payload));
}

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "probe-failure-"));
  setHomeRootForTesting(scratchHome);
  clearAll("claude-code");
  db.query("DELETE FROM provider_account_usage WHERE provider = 'claude-code'").run();
});

afterEach(() => {
  setHomeRootForTesting(null);
  rmSync(scratchHome, { recursive: true, force: true });
  clearAll("claude-code");
  db.query("DELETE FROM provider_account_usage WHERE provider = 'claude-code'").run();
});

describe("probe failure must not discard last-good windows", () => {
  test("latest probe failed, stored windows show room → ok:true reason:last-showed-room", () => {
    // Exact Nov 21 shape: home exists, prior reading was good (windows < 100%),
    // latest probe set account.problem="Usage could not be read" without replacing
    // the windows. The tray renders this as "Showing the last reading; the latest
    // could not be taken" with the prior Weekly 75% and Weekly Fable 2% bars.
    writeClaudeHome(join(scratchHome, ".claude-accounts", "chann"), ACCOUNT);
    const observedAtMs = Date.now() - 9 * 24 * 60 * 60 * 1000; // ~Nov 12, matches the tray
    seedClaudeUsage({
      observedAt: new Date(observedAtMs).toISOString(),
      accounts: [{
        label: ACCOUNT,
        current: false,
        signedOut: false,
        problem: "Usage could not be read",
        readAt: new Date(observedAtMs).toISOString(),
        windows: [
          { label: "Weekly", usedPercent: 75, resetsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString() },
          { label: "Weekly Fable", usedPercent: 2, model: "claude-fable-5-2", resetsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString() },
        ],
      }],
    }, observedAtMs);

    const verdict = canTakeWork("claude-code", { provider: "claude-code", label: ACCOUNT }, OPUS);
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBe("last-showed-room");
    expect(verdict.source.readingFresh).toBe(false);
    expect(verdict.source.readingUsedPercent).toBe(75);
  });

  test("latest probe failed, no prior windows → ok:false (not admitted)", () => {
    // A fresh account whose first probe failed has no stored windows to honor.
    // This is the "unknown" / "reading-stale" path and must stay refused.
    writeClaudeHome(join(scratchHome, ".claude-accounts", "chann"), ACCOUNT);
    const observedAtMs = Date.now() - 9 * 24 * 60 * 60 * 1000;
    seedClaudeUsage({
      observedAt: new Date(observedAtMs).toISOString(),
      accounts: [{
        label: ACCOUNT, current: false, signedOut: false,
        problem: "Usage could not be read",
        readAt: new Date(observedAtMs).toISOString(),
        windows: [],
      }],
    }, observedAtMs);

    const verdict = canTakeWork("claude-code", { provider: "claude-code", label: ACCOUNT }, OPUS);
    expect(verdict.ok).toBe(false);
    // Either `reading-stale` (if usage.problem latches) or `unknown` — crucially NOT `ready`.
    expect(["reading-stale", "unknown"]).toContain(verdict.reason);
  });

  test("latest probe failed, prior windows show 100% used → stay refused", () => {
    // A failed probe must not revive a spent account. If the prior windows were
    // all at 100% used, the account is still out of room; Step 5 refuses to admit.
    writeClaudeHome(join(scratchHome, ".claude-accounts", "chann"), ACCOUNT);
    const observedAtMs = Date.now() - 9 * 24 * 60 * 60 * 1000;
    seedClaudeUsage({
      observedAt: new Date(observedAtMs).toISOString(),
      accounts: [{
        label: ACCOUNT, current: false, signedOut: false,
        problem: "Usage could not be read",
        readAt: new Date(observedAtMs).toISOString(),
        windows: [{ label: "Weekly", usedPercent: 100, resetsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString() }],
      }],
    }, observedAtMs);

    const verdict = canTakeWork("claude-code", { provider: "claude-code", label: ACCOUNT }, OPUS);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).not.toBe("last-showed-room");
  });

  test("no probe failure, stale positive reading still admitted (regression fence on Step 5)", () => {
    // The original last-showed-room path (no .problem on the account): make sure
    // the broadened Step 5 condition still admits the clean stale case.
    writeClaudeHome(join(scratchHome, ".claude-accounts", "chann"), ACCOUNT);
    const observedAtMs = Date.now() - 9 * 24 * 60 * 60 * 1000;
    seedClaudeUsage({
      observedAt: new Date(observedAtMs).toISOString(),
      accounts: [{
        label: ACCOUNT, current: false, signedOut: false, problem: null,
        readAt: new Date(observedAtMs).toISOString(),
        windows: [{ label: "Weekly", usedPercent: 43, resetsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString() }],
      }],
    }, observedAtMs);

    const verdict = canTakeWork("claude-code", { provider: "claude-code", label: ACCOUNT }, OPUS);
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBe("last-showed-room");
  });
});
