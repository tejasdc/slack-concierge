import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";

const fixtureStateDir = join(tmpdir(), `test-concierge-state-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(fixtureStateDir, { recursive: true });
process.env.CONCIERGE_STATE_DIR = fixtureStateDir;
process.env.CONCIERGE_STATE_DB = join(fixtureStateDir, "state.db");
process.env.CONCIERGE_TEST_MODE = "1";
process.env.CONCIERGE_TEST_AUTHORIZATION = "native-attribution-5eaa0768";

try {
  const { liveAccessToken, ownLoginRefreshable } = await import("../src/runner-provider-account-readings");
  const { usageSignal } = await import("../src/provider-usage-forecast");
  const { db } = await import("../src/state");
  const { accountUsageTable } = await import("../src/provider-usage-tables");

  // Test 1: liveAccessToken detection
  {
    const dir = join(tmpdir(), `test-claude-live-token-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      // Missing credentials file
      assert.equal(liveAccessToken(dir), null, "missing file should return null");

      // Expired access token
      writeFileSync(join(dir, ".credentials.json"), JSON.stringify({
        claudeAiOauth: {
          accessToken: "expired-token",
          expiresAt: Date.now() - 10_000,
          refreshToken: "valid-refresh",
          refreshTokenExpiresAt: Date.now() + 86_400_000,
        },
      }));
      assert.equal(liveAccessToken(dir), null, "expired token should return null");

      // Token expiring in less than 60 seconds
      writeFileSync(join(dir, ".credentials.json"), JSON.stringify({
        claudeAiOauth: {
          accessToken: "expiring-soon-token",
          expiresAt: Date.now() + 30_000,
          refreshToken: "valid-refresh",
          refreshTokenExpiresAt: Date.now() + 86_400_000,
        },
      }));
      assert.equal(liveAccessToken(dir), null, "token expiring in < 60s should return null");

      // Valid live token
      writeFileSync(join(dir, ".credentials.json"), JSON.stringify({
        claudeAiOauth: {
          accessToken: "live-valid-token",
          expiresAt: Date.now() + 3_600_000,
          refreshToken: "valid-refresh",
          refreshTokenExpiresAt: Date.now() + 86_400_000,
        },
      }));
      assert.equal(liveAccessToken(dir), "live-valid-token", "valid token should be returned");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Test 2: ownLoginRefreshable validation
  {
    const dir = join(tmpdir(), `test-claude-refreshable-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      assert.equal(ownLoginRefreshable(dir), false, "missing file should not be refreshable");

      // Expired refresh token
      writeFileSync(join(dir, ".credentials.json"), JSON.stringify({
        claudeAiOauth: {
          accessToken: "token",
          refreshToken: "refresh-token",
          refreshTokenExpiresAt: Date.now() - 1000,
        },
      }));
      assert.equal(ownLoginRefreshable(dir), false, "expired refresh token should not be refreshable");

      // Valid refresh token
      writeFileSync(join(dir, ".credentials.json"), JSON.stringify({
        claudeAiOauth: {
          accessToken: "token",
          refreshToken: "refresh-token",
          refreshTokenExpiresAt: Date.now() + 86_400_000,
        },
      }));
      assert.equal(ownLoginRefreshable(dir), true, "valid refresh token should be refreshable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Test 3: usageSignal unreadable accounts surfacing
  {
    const provider = "claude-code";
    const testUsage = {
      observedAt: new Date().toISOString(),
      accounts: [
        {
          label: "healthy@example.com",
          plan: null,
          current: true,
          windows: [
            { name: "Weekly", usedPercent: 10, resetsAt: new Date(Date.now() + 86_400_000).toISOString(), willLastToReset: null, runsOutAt: null },
            { name: "Weekly · Fable only", usedPercent: 0, resetsAt: new Date(Date.now() + 86_400_000).toISOString(), willLastToReset: null, runsOutAt: null },
          ],
          problem: null,
          readAt: new Date().toISOString(),
        },
        {
          label: "tejas@chann.app",
          plan: null,
          current: false,
          windows: [],
          problem: "Usage could not be read.",
          readAt: null,
        },
      ],
      problem: null,
      sourceRunner: "ax41",
    };

    db.query(`INSERT INTO ${accountUsageTable(provider)} (provider, observed_at, usage_json) VALUES (?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET observed_at = excluded.observed_at, usage_json = excluded.usage_json`)
      .run(provider, testUsage.observedAt, JSON.stringify(testUsage));

    const signal = usageSignal(provider);
    assert.ok(signal.accountsWithRoom.includes("healthy@example.com"), "healthy account should have room");
    assert.ok(!signal.accountsWithRoom.includes("tejas@chann.app"), "unreadable account should not have room");

    // Must be present in unreadableAccounts
    assert.ok(signal.unreadableAccounts.includes("tejas@chann.app"), "unreadableAccounts must include tejas@chann.app");

    // Must be present in unreadable array
    const unreadableEntry = signal.unreadable.find(u => u.account === "tejas@chann.app");
    assert.ok(unreadableEntry, "unreadable list must have an entry for tejas@chann.app");
    assert.equal(unreadableEntry?.problem, "Usage could not be read.");

    // Must be present in accounts list
    const accountEntry = signal.accounts.find(a => a.account === "tejas@chann.app");
    assert.ok(accountEntry, "accounts list must have an entry for tejas@chann.app");
    assert.equal(accountEntry?.status, "unreadable");
    assert.equal(accountEntry?.hasRoom, false);
  }

  console.log("runner-provider-account-readings-fixture: ok");
} finally {
  rmSync(fixtureStateDir, { recursive: true, force: true });
}
