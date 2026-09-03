import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaneFixtureIdentities } from "../../scripts/sandbox-provision";
import { LiveTypedTurnAdapter } from "./adapters/live-typed-turn";
import { createLiveTypedTurnSurfaces } from "./runner";
import { AgentBrowserSlackDriver } from "./support/browser";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "sandbox-runner-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

const lane: LaneFixtureIdentities = {
  schema_version: 1,
  lane_id: "lane-1",
  app_id: "AAPP1",
  team_id: "TSANDBOX1",
  bot_user_id: "UBOT1",
  bot_id: "BBOT1",
  manifest_digest: "a".repeat(64),
  installer_user_id: "UINSTALLER1",
  dm_channel_id: "DDM1",
  channels: {
    core: { id: "CCORE1", name: "concierge-lane-1-core" },
    project: { id: "CPROJECT1", name: "concierge-lane-1-project" },
    capture: { id: "CCAPTURE1", name: "concierge-lane-1-capture" },
  },
  browser: {
    namespace: "concierge-sandbox-lane-1",
    profile_path: "/tmp/concierge-sandbox-browser/lane-1",
    client_workspace_id: "EENTERPRISE1",
    canonical_workspace_domain: "sandbox-workspace.slack.com",
  },
};

function controllerRun(): { stateRoot: string; configPath: string } {
  const stateRoot = scratch();
  const runRoot = join(stateRoot, "lanes", "lane-1", "runs", "run-1");
  const state = join(runRoot, "state");
  const readyFile = join(state, "ready.json");
  const configPath = join(stateRoot, "config", "lane-1", "slack.toml");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(join(stateRoot, "config", "lane-1"), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, "user_token = \"xoxp-offline-test\"\n", { mode: 0o600 });
  writeFileSync(readyFile, `${JSON.stringify({
    schema_version: 1,
    pid: 43210,
    run_id: "run-1",
    lane: 1,
    team_id: lane.team_id,
    app_id: lane.app_id,
    bot_user_id: lane.bot_user_id,
    bot_id: lane.bot_id,
  })}\n`, { mode: 0o600 });
  writeFileSync(join(runRoot, "run.json"), `${JSON.stringify({
    run_id: "run-1",
    lane: 1,
    status: "running",
    generation: 1,
    source: {
      git_sha: "a".repeat(40),
      branch: "worktree-test",
      dirty_digest: null,
      source_id: "a".repeat(40),
    },
    candidate: { pid: 43210 },
    lane_identity: {
      team_id: lane.team_id,
      app_id: lane.app_id,
      bot_user_id: lane.bot_user_id,
      bot_id: lane.bot_id,
    },
    lane_fixtures: {
      lane_id: lane.lane_id,
      installer_user_id: lane.installer_user_id,
      browser: {
        client_workspace_id: lane.browser.client_workspace_id,
        canonical_workspace_domain: lane.browser.canonical_workspace_domain,
      },
    },
    paths: { config: configPath, fixtures: "unused", state, ready_file: readyFile },
  })}\n`, { mode: 0o600 });
  return { stateRoot, configPath };
}

function invokeRunner(arguments_: string[], roots: { config: string; state: string; browser: string }) {
  return Bun.spawnSync([process.execPath, "run", "tests/sandbox/runner.ts", ...arguments_], {
    cwd: join(import.meta.dir, "../.."),
    env: {
      ...process.env,
      CONCIERGE_SANDBOX_CONFIG_ROOT: roots.config,
      CONCIERGE_SANDBOX_STATE_ROOT: roots.state,
      CONCIERGE_SANDBOX_BROWSER_ROOT: roots.browser,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("sandbox acceptance runner", () => {
  test("plan stays read-only while advertising the explicit live boundary", async () => {
    const root = scratch();
    const paths = { config: join(root, "config"), state: join(root, "state"), browser: join(root, "browser") };
    const result = invokeRunner(["plan", "typed-turn", "--lane", "lane-2", "--run-id", "plan-run"], paths);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      lane_id: "lane-2",
      run_id: "plan-run",
      executable: true,
      requires_apply: true,
    });
    expect(await Bun.file(join(paths.state, "lanes", "lane-2", "runs", "plan-run")).exists()).toBe(false);
  });

  test("plans the focused todo-capture reaction and no-reply boundary", async () => {
    const root = scratch();
    const paths = { config: join(root, "config"), state: join(root, "state"), browser: join(root, "browser") };
    const result = invokeRunner(["plan", "todo-capture", "--lane", "lane-2", "--run-id", "todo-plan"], paths);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      case_id: "todo-capture",
      lane_id: "lane-2",
      run_id: "todo-plan",
      executable: true,
      requires_apply: true,
    });
    expect(await Bun.file(join(paths.state, "lanes", "lane-2", "runs", "todo-plan")).exists()).toBe(false);
  });

  test("plans the exact Claude steering acknowledgement boundary", async () => {
    const root = scratch();
    const paths = { config: join(root, "config"), state: join(root, "state"), browser: join(root, "browser") };
    const result = invokeRunner([
      "plan", "claude-steering-ack", "--lane", "lane-2", "--run-id", "steering-plan",
    ], paths);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      case_id: "claude-steering-ack",
      lane_id: "lane-2",
      run_id: "steering-plan",
      executable: true,
      requires_apply: true,
    });
    expect(await Bun.file(join(paths.state, "lanes", "lane-2", "runs", "steering-plan")).exists()).toBe(false);
  });

  test("execute refuses before provisioning or any Slack call unless explicitly applied", () => {
    const root = scratch();
    const paths = { config: join(root, "config"), state: join(root, "state"), browser: join(root, "browser") };
    const blocked = invokeRunner(["execute", "typed-turn", "--lane", "lane-1", "--run-id", "run-1"], paths);
    expect(blocked.exitCode).toBe(1);
    expect(JSON.parse(blocked.stderr.toString())).toMatchObject({ ok: false, code: "apply_required" });

    const applied = invokeRunner(["execute", "typed-turn", "--lane", "lane-1", "--run-id", "run-1", "--apply"], paths);
    expect(applied.exitCode).toBe(1);
    expect(JSON.parse(applied.stderr.toString())).toMatchObject({ ok: false, code: "lane_not_provisioned" });
  });

  test("composes the real adapter and browser only after exact controller run binding", () => {
    const harness = controllerRun();
    const surfaces = createLiveTypedTurnSurfaces({
      lane,
      workspaceDomain: "concierge--sandbox.enterprise.slack.com",
      runId: "run-1",
      stateRoot: harness.stateRoot,
      configPath: harness.configPath,
    });
    expect(surfaces.adapter).toBeInstanceOf(LiveTypedTurnAdapter);
    expect(surfaces.browser).toBeInstanceOf(AgentBrowserSlackDriver);
  });
});
