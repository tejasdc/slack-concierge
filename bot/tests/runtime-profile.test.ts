import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertAuthenticatedSlackIdentity,
  assertConfiguredSlackIdentity,
  clearSandboxReadyReceipt,
  resolveAuthenticatedSlackAppId,
  resolveRuntimeProfile,
  writeSandboxReadyReceipt,
} from "../src/runtime-profile";
import {
  SandboxSlackIdentityGate,
  sandboxSlackIdentityMiddleware,
} from "../src/sandbox-slack-identity";
import {
  loadCaptureQueueTokenFromPath,
  validateSlackUserToken,
} from "../src/capture-delivery-worker";

const sandboxEnvironment = {
  CONCIERGE_RUNTIME_PROFILE: "sandbox",
  CONCIERGE_TEST_MODE: "1",
  CONCIERGE_CONFIG_PATH: "/etc/concierge/sandbox/lanes/lane-1/slack.toml",
  CONCIERGE_STATE_DIR: "/var/lib/slack-concierge-sandbox/lanes/lane-1/runs/run-7",
  CONCIERGE_SANDBOX_EXPECTED_TEAM_ID: "T01234",
  CONCIERGE_SANDBOX_EXPECTED_APP_ID: "A01234",
  CONCIERGE_SANDBOX_EXPECTED_BOT_USER_ID: "U01234",
  CONCIERGE_SANDBOX_EXPECTED_BOT_ID: "B01234",
  CONCIERGE_SANDBOX_RUN_ID: "run-7",
  CONCIERGE_SANDBOX_LANE: "1",
  CONCIERGE_SANDBOX_READY_FILE: "/var/lib/slack-concierge-sandbox/lanes/lane-1/runs/run-7/ready.json",
};

describe("Concierge runtime profile", () => {
  test("keeps production as the unchanged default owner", () => {
    const runtime = resolveRuntimeProfile({ CONCIERGE_STATE_DIR: "/root/.local/state/concierge" }, "/root");

    expect(runtime).toEqual({
      profile: "production",
      slackConfigPath: "/root/.config/concierge/slack.toml",
      stateDir: "/root/.local/state/concierge",
      expectedSlackTeamId: null,
      expectedSlackAppId: null,
      expectedSlackBotUserId: null,
      expectedSlackBotId: null,
      sandboxRunId: null,
      sandboxLane: null,
      sandboxReadyFile: null,
      captureQueueUrl: null,
      captureQueueTokenPath: null,
      ownership: {
        captureDelivery: true,
        deployment: true,
        codexRemote: true,
        projectCutover: true,
      },
    });
  });

  test("creates a sandbox profile with no production-only owners", () => {
    const runtime = resolveRuntimeProfile(sandboxEnvironment, "/root");

    expect(runtime.profile).toBe("sandbox");
    expect(runtime.slackConfigPath).toBe(sandboxEnvironment.CONCIERGE_CONFIG_PATH);
    expect(runtime.stateDir).toBe(sandboxEnvironment.CONCIERGE_STATE_DIR);
    expect(runtime.expectedSlackTeamId).toBe("T01234");
    expect(runtime.expectedSlackAppId).toBe("A01234");
    expect(runtime.expectedSlackBotUserId).toBe("U01234");
    expect(runtime.expectedSlackBotId).toBe("B01234");
    expect(runtime.sandboxRunId).toBe("run-7");
    expect(runtime.sandboxLane).toBe(1);
    expect(runtime.sandboxReadyFile).toBe(sandboxEnvironment.CONCIERGE_SANDBOX_READY_FILE);
    expect(runtime.ownership).toEqual({
      captureDelivery: false,
      deployment: false,
      codexRemote: false,
      projectCutover: false,
    });
  });

  test("requires explicit sandbox paths, identities, and the state isolation guard", () => {
    const requiredKeys = [
      "CONCIERGE_CONFIG_PATH",
      "CONCIERGE_STATE_DIR",
      "CONCIERGE_SANDBOX_EXPECTED_TEAM_ID",
      "CONCIERGE_SANDBOX_EXPECTED_APP_ID",
      "CONCIERGE_SANDBOX_EXPECTED_BOT_USER_ID",
      "CONCIERGE_SANDBOX_EXPECTED_BOT_ID",
      "CONCIERGE_SANDBOX_RUN_ID",
      "CONCIERGE_SANDBOX_LANE",
      "CONCIERGE_SANDBOX_READY_FILE",
    ] as const;
    for (const key of requiredKeys) {
      const environment = { ...sandboxEnvironment };
      delete environment[key];
      expect(() => resolveRuntimeProfile(environment, "/root")).toThrow();
    }
    expect(() => resolveRuntimeProfile({
      ...sandboxEnvironment,
      CONCIERGE_TEST_MODE: "0",
    }, "/root")).toThrow("CONCIERGE_TEST_MODE=1");
  });

  test("refuses production config and home-owned state paths", () => {
    expect(() => resolveRuntimeProfile({
      ...sandboxEnvironment,
      CONCIERGE_CONFIG_PATH: "/root/.config/concierge/slack.toml",
    }, "/root")).toThrow("production Slack configuration path");
    expect(() => resolveRuntimeProfile({
      ...sandboxEnvironment,
      CONCIERGE_STATE_DIR: "/root/.local/state/concierge-sandbox/lane-1",
    }, "/root")).toThrow("outside the production home");
    expect(() => resolveRuntimeProfile({
      ...sandboxEnvironment,
      CONCIERGE_CONFIG_PATH: "relative.toml",
    }, "/root")).toThrow("absolute path");
    expect(() => resolveRuntimeProfile({
      ...sandboxEnvironment,
      CONCIERGE_SANDBOX_READY_FILE: "/tmp/ready.json",
    }, "/root")).toThrow("inside the active sandbox run state directory");
  });

  test("fails closed on configured and authenticated workspace/app drift", () => {
    const runtime = resolveRuntimeProfile(sandboxEnvironment, "/root");
    expect(() => assertConfiguredSlackIdentity(runtime, {
      team_id: "T01234",
      app_id: "A01234",
    })).not.toThrow();
    expect(() => assertConfiguredSlackIdentity(runtime, {
      team_id: "T99999",
      app_id: "A01234",
    })).toThrow("team_id");
    expect(() => assertConfiguredSlackIdentity(runtime, {
      team_id: "T01234",
      app_id: "A99999",
    })).toThrow("app_id");

    expect(() => assertAuthenticatedSlackIdentity(runtime, {
      team_id: "T01234",
      app_id: "A01234",
      user_id: "U01234",
      bot_id: "B01234",
    })).not.toThrow();
    expect(() => assertAuthenticatedSlackIdentity(runtime, {
      team_id: "T01234",
      user_id: "U01234",
      bot_id: "B01234",
    })).toThrow("expected sandbox lane app");
    expect(() => assertAuthenticatedSlackIdentity(runtime, {
      team_id: "T01234",
      app_id: "A01234",
      user_id: "U99999",
      bot_id: "B01234",
    })).toThrow("bot user");
  });

  test("resolves optional auth.test app identity through bots.info", async () => {
    const runtime = resolveRuntimeProfile(sandboxEnvironment, "/root");
    let lookedUpBotId = "";
    expect(await resolveAuthenticatedSlackAppId(runtime, {
      bot_id: "B01234",
    }, async (botId) => {
      lookedUpBotId = botId;
      return "A01234";
    })).toBe("A01234");
    expect(lookedUpBotId).toBe("B01234");
    expect(await resolveAuthenticatedSlackAppId(runtime, {
      app_id: "A01234",
      bot_id: "B01234",
    }, async () => {
      throw new Error("lookup should not run");
    })).toBe("A01234");
  });

  test("enables capture only with a lane-local queue origin and run-local token", () => {
    expect(resolveRuntimeProfile(sandboxEnvironment, "/root").ownership.captureDelivery).toBe(false);
    const captureEnvironment = {
      ...sandboxEnvironment,
      CONCIERGE_CAPTURE_QUEUE_URL: "http://127.0.0.1:18081",
      CONCIERGE_CAPTURE_QUEUE_TOKEN_FILE: `${sandboxEnvironment.CONCIERGE_STATE_DIR}/capture-queue.token`,
    };
    const runtime = resolveRuntimeProfile(captureEnvironment, "/root");
    expect(runtime.ownership.captureDelivery).toBe(true);
    expect(runtime.captureQueueUrl).toBe("http://127.0.0.1:18081");

    expect(() => resolveRuntimeProfile({
      ...sandboxEnvironment,
      CONCIERGE_CAPTURE_QUEUE_URL: "http://127.0.0.1:18081",
    }, "/root")).toThrow("requires both");
    expect(() => resolveRuntimeProfile({
      ...captureEnvironment,
      CONCIERGE_CAPTURE_QUEUE_URL: "http://127.0.0.1:8081",
    }, "/root")).toThrow("production capture queue URL");
    expect(() => resolveRuntimeProfile({
      ...captureEnvironment,
      CONCIERGE_CAPTURE_QUEUE_URL: "https://capture.example.test:18081",
    }, "/root")).toThrow("loopback HTTP origin");
    expect(() => resolveRuntimeProfile({
      ...captureEnvironment,
      CONCIERGE_CAPTURE_QUEUE_TOKEN_FILE: "/etc/concierge/capture-queue.token",
    }, "/root")).toThrow("active sandbox run state directory");
  });

  test("rejects a sandbox capture token symlink that escapes the run root", () => {
    const root = mkdtempSync(join(tmpdir(), "concierge-sandbox-capture-"));
    const runRoot = join(root, "run");
    mkdirSync(runRoot);
    const outsideToken = join(root, "production.token");
    writeFileSync(outsideToken, "a-secure-random-capture-token\n", { mode: 0o600 });
    const linkedToken = join(runRoot, "capture.token");
    symlinkSync(outsideToken, linkedToken);
    expect(() => loadCaptureQueueTokenFromPath(linkedToken, runRoot)).toThrow("permissions are unsafe");
  });

  test("rejects a sandbox capture user token from another workspace", async () => {
    const authTest = (async () => Response.json({
      ok: true,
      user_id: "U01234",
      team_id: "T99999",
    })) as typeof fetch;
    await expect(validateSlackUserToken(
      "xoxp-test-user-token-with-at-least-24-characters",
      authTest,
      "T01234",
    )).rejects.toThrow("expected sandbox workspace");
  });

  test("proves Socket Mode identity and rejects unverified inbound payload classes", async () => {
    const runtime = resolveRuntimeProfile(sandboxEnvironment, "/root");
    const gate = new SandboxSlackIdentityGate(runtime, "xapp-test-token");
    gate.receiver.client.emit("ws_message", Buffer.from(JSON.stringify({
      type: "hello",
      connection_info: { app_id: "A01234" },
    })), false);
    expect(() => gate.assertConnected()).not.toThrow();
    expect(() => gate.assertInbound({
      type: "event_callback",
      team_id: "T01234",
      api_app_id: "A01234",
    })).not.toThrow();
    expect(() => gate.assertInbound({
      type: "message_action",
      team: { id: "T01234" },
    })).not.toThrow();
    expect(() => gate.assertInbound({
      type: "message_action",
      team: { id: "T99999" },
    })).toThrow("expected sandbox workspace");
    expect(() => gate.assertInbound({
      type: "event_callback",
      team_id: "T01234",
    })).toThrow("missing a verifiable sandbox app identity");
    expect(() => gate.assertInbound({
      type: "event_callback",
      team_id: "T01234",
      api_app_id: "A99999",
    })).toThrow("expected sandbox app");

    const wrongGate = new SandboxSlackIdentityGate(runtime, "xapp-test-token");
    wrongGate.observeSocketMessage(Buffer.from(JSON.stringify({
      type: "hello",
      connection_info: { app_id: "A99999" },
    })), false);
    expect(() => wrongGate.assertConnected()).toThrow("Socket Mode app token");

    const unconnectedGate = new SandboxSlackIdentityGate(runtime, "xapp-test-token");
    expect(() => unconnectedGate.assertInbound({
      type: "shortcut",
      team: { id: "T01234" },
    })).toThrow("before startup completed");

    let nextCalls = 0;
    const middleware = sandboxSlackIdentityMiddleware(gate);
    await expect(middleware({
      body: { type: "event_callback", team_id: "T01234", api_app_id: "A99999" },
      next: async () => { nextCalls += 1; },
    })).rejects.toThrow("expected sandbox app");
    await expect(middleware({
      body: { type: "event_callback", team_id: "T01234" },
      next: async () => { nextCalls += 1; },
    })).rejects.toThrow("missing a verifiable sandbox app identity");
    expect(nextCalls).toBe(0);

    let reconnectFailure = "";
    gate.setFailureHandler((error) => { reconnectFailure = error.message; });
    gate.receiver.client.emit("ws_message", Buffer.from(JSON.stringify({
      type: "hello",
      connection_info: { app_id: "A99999" },
    })), false);
    expect(reconnectFailure).toContain("Socket Mode app token");
    expect(() => gate.assertConnected()).toThrow("Socket Mode app token");
  });

  test("atomically publishes and clears a run-bound readiness receipt", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "concierge-sandbox-ready-"));
    const readyFile = join(stateDir, "evidence", "ready.json");
    const runtime = resolveRuntimeProfile({
      ...sandboxEnvironment,
      CONCIERGE_STATE_DIR: stateDir,
      CONCIERGE_SANDBOX_READY_FILE: readyFile,
    }, "/root");
    writeSandboxReadyReceipt(runtime, {
      teamId: "T01234",
      botUserId: "U01234",
      botId: "B01234",
      appId: "A01234",
    }, new Date("2026-08-27T12:00:00.000Z"));
    expect(JSON.parse(readFileSync(readyFile, "utf8"))).toEqual({
      schema_version: 1,
      pid: process.pid,
      run_id: "run-7",
      lane: 1,
      team_id: "T01234",
      bot_user_id: "U01234",
      bot_id: "B01234",
      app_id: "A01234",
      ready_at: "2026-08-27T12:00:00.000Z",
    });
    expect(statSync(readyFile).mode & 0o077).toBe(0);
    clearSandboxReadyReceipt(runtime);
    expect(existsSync(readyFile)).toBe(false);
  });

  test("rejects sandbox state before opening SQLite when the import-time guard is absent", () => {
    const stateDir = join(mkdtempSync(join(tmpdir(), "concierge-sandbox-guard-")), "state");
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", "await import('./src/state.ts')"],
      cwd: resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        CONCIERGE_RUNTIME_PROFILE: "sandbox",
        CONCIERGE_TEST_MODE: "0",
        CONCIERGE_STATE_DIR: stateDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).not.toBe(0);
    expect(Buffer.from(result.stderr).toString("utf8")).toContain("Sandbox runtime requires CONCIERGE_TEST_MODE=1");
    expect(existsSync(stateDir)).toBe(false);
  });

  test("wires sandbox ownership around startup without branching provider/session routing", () => {
    const source = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");
    const handler = source.slice(source.indexOf("async function handleUserMessage"), source.indexOf("const ROUTABLE_SUBTYPES"));
    const startup = source.slice(source.lastIndexOf("(async () => {"));

    expect(source).toContain("readFileSync(runtime.slackConfigPath");
    expect(source).toContain("assertConfiguredSlackIdentity(runtime, cfg)");
    expect(startup.indexOf("assertAuthenticatedSlackIdentity(runtime, auth)"))
      .toBeLessThan(startup.indexOf("await app.start()"));
    expect(startup).toContain("if (runtime.ownership.captureDelivery)");
    expect(startup).toContain("if (runtime.ownership.codexRemote)");
    expect(startup).toContain("if (runtime.ownership.deployment)");
    expect(source).toContain("app.use(sandboxSlackIdentityMiddleware(sandboxSlackIdentity))");
    expect(startup).toContain("sandboxSlackIdentity?.assertConnected()");
    expect(startup).toContain("app.client.bots.info");
    expect(startup).toContain("writeSandboxReadyReceipt(runtime");
    expect(startup.lastIndexOf("serviceOnline = true"))
      .toBeLessThan(startup.indexOf("writeSandboxReadyReceipt(runtime"));
    expect(source).toContain("runtime.ownership.projectCutover");
    expect(handler).not.toContain("runtime.ownership");
    expect(handler).not.toContain("runtime.profile");
  });
});
