import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canvasSlackBucket, slackBucket } from "../src/rate-limit";
import { acquireDatabaseTestLock } from "./db-lock";

const {
  agentsFingerprint,
  agentsPath,
  buildAgentsCanvasMarkdown,
  buildAgentsCanvasPayload,
  startRuntimeWithCanvasRefresh,
  syncAgentsCanvas,
  syncAllAgentsCanvases,
} = require("../src/canvas");
const { db, getChannel, updateChannelCanvasId, upsertChannel } = require("../src/state");
const scratchDirectories: string[] = [];
let releaseDatabaseTestLock: (() => void) | null = null;

beforeEach(async () => {
  releaseDatabaseTestLock = await acquireDatabaseTestLock();
  db.query("DELETE FROM channels").run();
  canvasSlackBucket.reset();
  slackBucket.reset();
});

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  releaseDatabaseTestLock?.();
  releaseDatabaseTestLock = null;
});

describe("buildAgentsCanvasMarkdown", () => {
  test("renders AGENTS.md into deterministic Slack Canvas markdown", () => {
    const markdown = buildAgentsCanvasMarkdown({
      channelName: "proj_alpha",
      sourcePath: "/root/workspace/proj/alpha/AGENTS.md",
      agentsText: "# Instructions\n\n- Keep markdown as source of truth.",
    });

    expect(markdown).toContain("# Instructions");
    expect(markdown).toContain("- Keep markdown as source of truth.");
    expect(markdown).toContain("Synced from /root/workspace/proj/alpha/AGENTS.md");
    expect(markdown).not.toContain("# #proj_alpha instructions");
    expect(markdown.length).toBeLessThanOrEqual(1_048_576);
  });

  test("caps payload at Slack's document_content limit", () => {
    const markdown = buildAgentsCanvasMarkdown({
      channelName: "proj_big",
      agentsText: "x".repeat(1_100_000),
    });

    expect(markdown.length).toBeLessThanOrEqual(1_048_576);
    expect(markdown).toContain("Trimmed by Concierge");
  });

  test("reads code-root instructions for managed projects and vault instructions only for vault-only channels", () => {
    const root = mkdtempSync(join(tmpdir(), "concierge-canvas-source-"));
    scratchDirectories.push(root);
    const codePath = join(root, "code");
    const vaultPath = join(root, "vault");
    mkdirSync(codePath, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    writeFileSync(join(codePath, "AGENTS.md"), "# Code authority\n");
    writeFileSync(join(vaultPath, "AGENTS.md"), "# Vault authority\n");

    const managed = {
      slack_channel_name: "managed",
      code_path: codePath,
      vault_path: vaultPath,
    };
    const vaultOnly = {
      slack_channel_name: "vault-only",
      code_path: null,
      vault_path: vaultPath,
    };

    expect(agentsPath(managed)).toBe(join(codePath, "AGENTS.md"));
    expect(buildAgentsCanvasPayload(managed).document_content.markdown).toContain("# Code authority");
    expect(buildAgentsCanvasPayload(managed).document_content.markdown).not.toContain("# Vault authority");
    expect(agentsPath(vaultOnly)).toBe(join(vaultPath, "AGENTS.md"));
    expect(buildAgentsCanvasPayload(vaultOnly).document_content.markdown).toContain("# Vault authority");
    expect(agentsFingerprint(managed)).not.toBe(agentsFingerprint(vaultOnly));
  });

  test("fails a required all-channel refresh but tolerates ordinary scheduled failures", async () => {
    const channels = [
      { slack_channel_id: "C1" },
      { slack_channel_id: "C2" },
    ] as any[];
    const sync = async (channel: any) => channel.slack_channel_id === "C1"
      ? { ok: true as const }
      : { ok: false as const, error: "canvas_failed" };

    const ordinary = await syncAllAgentsCanvases({ channels, requireSuccess: false, sync });
    expect(ordinary).toEqual({
      refreshed: 1,
      failures: [{ channel: "C2", error: "canvas_failed" }],
    });
    await expect(syncAllAgentsCanvases({ channels, requireSuccess: true, sync })).rejects.toThrow("Required Canvas refresh failed");
  });

  test("starts normal runtime before a best-effort Canvas refresh and does not wait for it", async () => {
    const transitions: string[] = [];
    let finishRefresh!: () => void;
    const refreshFinished = new Promise<void>((resolve) => { finishRefresh = resolve; });

    await startRuntimeWithCanvasRefresh({
      requireCanvasRefresh: false,
      refreshCanvases: async () => {
        transitions.push("refresh_started");
        await refreshFinished;
        transitions.push("refresh_finished");
      },
      startRuntime: async () => { transitions.push("runtime_started"); },
      reportBackgroundRefreshError: () => { transitions.push("refresh_failed"); },
    });

    expect(transitions).toEqual(["runtime_started", "refresh_started"]);
    finishRefresh();
    await refreshFinished;
  });

  test("keeps runtime closed until a required cutover Canvas refresh succeeds", async () => {
    const transitions: string[] = [];
    let finishRefresh!: () => void;
    const refreshFinished = new Promise<void>((resolve) => { finishRefresh = resolve; });

    const startup = startRuntimeWithCanvasRefresh({
      requireCanvasRefresh: true,
      refreshCanvases: async () => {
        transitions.push("refresh_started");
        await refreshFinished;
        transitions.push("refresh_finished");
      },
      startRuntime: async () => { transitions.push("runtime_started"); },
      reportBackgroundRefreshError: () => { transitions.push("refresh_failed"); },
    });

    expect(transitions).toEqual(["refresh_started"]);
    finishRefresh();
    await startup;
    expect(transitions).toEqual(["refresh_started", "refresh_finished", "runtime_started"]);
  });

  test("keeps runtime closed when a required cutover Canvas refresh fails", async () => {
    let runtimeStarted = false;

    await expect(startRuntimeWithCanvasRefresh({
      requireCanvasRefresh: true,
      refreshCanvases: async () => { throw new Error("required Canvas failed"); },
      startRuntime: async () => { runtimeStarted = true; },
      reportBackgroundRefreshError: () => {},
    })).rejects.toThrow("required Canvas failed");

    expect(runtimeStarted).toBe(false);
  });

  test("reports a normal background Canvas refresh failure without failing startup", async () => {
    let reported: unknown;
    const refreshFailure = new Error("Slack Canvas unavailable");

    await startRuntimeWithCanvasRefresh({
      requireCanvasRefresh: false,
      refreshCanvases: async () => { throw refreshFailure; },
      startRuntime: async () => {},
      reportBackgroundRefreshError: (error) => { reported = error; },
    });
    await Promise.resolve();

    expect(reported).toBe(refreshFailure);
  });

  test("serializes same-channel refreshes so an older payload cannot overwrite newer instructions", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "concierge-canvas-serialized-"));
    scratchDirectories.push(projectDir);
    writeFileSync(join(projectDir, "AGENTS.md"), "# Older instructions\n");
    upsertChannel({
      slack_channel_id: "C_SERIAL",
      slack_channel_name: "serialized",
      group_name: null,
      name: "serialized",
      vault_path: projectDir,
      code_path: projectDir,
    });
    updateChannelCanvasId("C_SERIAL", "F_SERIAL");
    const firstChannel = getChannel("C_SERIAL");
    const secondChannel = { ...firstChannel };
    let editCount = 0;
    let appliedMarkdown = "";
    let reportFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { reportFirstStarted = resolve; });
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const client = {
      canvases: {
        edit: async (args: any) => {
          editCount += 1;
          if (editCount === 1) {
            reportFirstStarted();
            await firstMayFinish;
          }
          appliedMarkdown = args.changes[0].document_content.markdown;
          return { ok: true };
        },
      },
    };

    const first = syncAgentsCanvas({ client, channel: firstChannel, reason: "first" });
    await firstStarted;
    writeFileSync(join(projectDir, "AGENTS.md"), "# Newer instructions\n");
    const second = syncAgentsCanvas({ client, channel: secondChannel, reason: "second" });
    await Promise.resolve();
    expect(editCount).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);

    expect(editCount).toBe(2);
    expect(appliedMarkdown).toContain("# Newer instructions");
    expect(appliedMarkdown).not.toContain("# Older instructions");
  });

  test("reloads Canvas identity inside the channel queue before creating", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "concierge-canvas-create-"));
    scratchDirectories.push(projectDir);
    writeFileSync(join(projectDir, "AGENTS.md"), "# Instructions\n");
    upsertChannel({
      slack_channel_id: "C_CREATE",
      slack_channel_name: "create",
      group_name: null,
      name: "create",
      vault_path: projectDir,
      code_path: projectDir,
    });
    const firstChannel = getChannel("C_CREATE");
    const secondChannel = { ...firstChannel };
    let createCount = 0;
    let editCount = 0;
    let reportCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => { reportCreateStarted = resolve; });
    let releaseCreate!: () => void;
    const createMayFinish = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const client = {
      conversations: {
        info: async () => ({ ok: true, channel: { properties: { tabs: [] } } }),
        canvases: {
          create: async () => {
            createCount += 1;
            reportCreateStarted();
            await createMayFinish;
            return { ok: true, canvas_id: "F_CREATED" };
          },
        },
      },
      canvases: {
        edit: async () => {
          editCount += 1;
          return { ok: true };
        },
      },
    };

    const first = syncAgentsCanvas({ client, channel: firstChannel, reason: "first" });
    await createStarted;
    const second = syncAgentsCanvas({ client, channel: secondChannel, reason: "second" });
    await Promise.resolve();
    expect(createCount).toBe(1);
    releaseCreate();
    await Promise.all([first, second]);

    expect(createCount).toBe(1);
    expect(editCount).toBe(1);
    expect(getChannel("C_CREATE")?.canvas_id).toBe("F_CREATED");
  });
});
