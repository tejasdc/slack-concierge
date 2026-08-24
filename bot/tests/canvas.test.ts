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
  canvasSlackErrorFields,
  MAX_CANVAS_SLACK_DETAIL,
  normalizeCanvasMarkdown,
  scheduleAgentsCanvasRefreshIfChanged,
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

  test("normalizes the relative-link shapes from rejected live documents", () => {
    const fixtures = [
      ["[`docs/README.md`](docs/README.md)", "`docs/README.md`"],
      ["[STATUS.md](STATUS.md)", "STATUS.md"],
      ["[Documentation index](docs/README.md)", "Documentation index — `docs/README.md`"],
      ["[text](url)", "text — `url`"],
    ];

    for (const [source, expected] of fixtures) {
      expect(normalizeCanvasMarkdown(source)).toBe(expected);
    }
  });

  test("normalizes only the live-proven list child contexts", () => {
    const source = [
      "1. Numbered parent",
      "   - nested bullet",
      "    > nested quote",
      "- Bullet parent",
      "  - preserved bullet under bullet",
      "> Top-level quote",
      "  > preserved quote under quote",
      "Outside the list.",
      "   - preserved indented non-child",
    ].join("\n");

    expect(normalizeCanvasMarkdown(source)).toBe([
      "1. Numbered parent",
      "   • nested bullet",
      "    ↳ nested quote",
      "- Bullet parent",
      "  - preserved bullet under bullet",
      "> Top-level quote",
      "  > preserved quote under quote",
      "Outside the list.",
      "   - preserved indented non-child",
    ].join("\n"));
  });

  test("preserves unsupported links and code while converting an adjacent proven link", () => {
    const source = [
      "[web](https://example.com) [mail](mailto:test@example.com) [root](/docs) [anchor](#part) [bare](README) [domain](www.example.com)",
      "![image](docs/image.png) \\[escaped](docs/escaped.md) [title](docs/file.md \"Title\") [balanced](docs/a(b).md)",
      "``[inside](docs/inside.md)`` and [outside](docs/outside.md)",
      "Inline replacement tokens stay literal: `$`, `$&`, `$\`` and `--body`.",
      "  ````typescript",
      "[fenced](docs/fenced.md)",
      "   - fenced bullet",
      "  ```",
      "[still fenced](docs/still-fenced.md)",
      "  ````",
      "[after](docs/after.md)",
      "  ~~~~~",
      "[tilde fenced](docs/tilde.md)",
      "  ~~~~~",
      "> ```md",
      "> [quoted fenced](docs/quoted.md)",
      "> ```",
      "- ```md",
      "  [list fenced](docs/list.md)",
      "  ```",
      "`[multiline inline](docs/multiline.md)",
      "continued` and [after multiline](docs/after-multiline.md)",
      "    1. indented code",
      "       - remains code",
      "- Quote parent",
      "  > projected outer quote",
      "    > preserved nested quote",
    ].join("\n");
    const normalized = normalizeCanvasMarkdown(source);

    expect(normalized).toContain("[web](https://example.com)");
    expect(normalized).toContain("[mail](mailto:test@example.com)");
    expect(normalized).toContain("[root](/docs)");
    expect(normalized).toContain("[anchor](#part)");
    expect(normalized).toContain("[bare](README)");
    expect(normalized).toContain("[domain](www.example.com)");
    expect(normalized).toContain("![image](docs/image.png)");
    expect(normalized).toContain("\\[escaped](docs/escaped.md)");
    expect(normalized).toContain("[title](docs/file.md \"Title\")");
    expect(normalized).toContain("[balanced](docs/a(b).md)");
    expect(normalized).toContain("``[inside](docs/inside.md)`` and outside — `docs/outside.md`");
    expect(normalized).toContain("Inline replacement tokens stay literal: `$`, `$&`, `$\`` and `--body`.");
    expect(normalized).toContain("[fenced](docs/fenced.md)");
    expect(normalized).toContain("[still fenced](docs/still-fenced.md)");
    expect(normalized).toContain("[tilde fenced](docs/tilde.md)");
    expect(normalized).toContain("> [quoted fenced](docs/quoted.md)");
    expect(normalized).toContain("  [list fenced](docs/list.md)");
    expect(normalized).toContain("`[multiline inline](docs/multiline.md)\ncontinued`");
    expect(normalized).toContain("after multiline — `docs/after-multiline.md`");
    expect(normalized).toContain("    1. indented code\n       - remains code");
    expect(normalized).toContain("  ↳ projected outer quote\n    > preserved nested quote");
    expect(normalized).toContain("after — `docs/after.md`");
    expect(normalizeCanvasMarkdown(normalized)).toBe(normalized);
  });

  test("applies the Canvas cap after an expanding compatibility transform", () => {
    const agentsText = "[Guide](docs/README.md)\n".repeat(42_000);
    expect(agentsText.length).toBeLessThan(1_048_576);

    const markdown = buildAgentsCanvasMarkdown({ channelName: "expanding", agentsText });

    expect(markdown.length).toBeLessThanOrEqual(1_048_576);
    expect(markdown).toContain("Guide — `docs/README.md`");
    expect(markdown).toContain("Trimmed by Concierge");
  });

  test("extracts only a bounded string Slack Canvas detail", () => {
    const detail = "x".repeat(MAX_CANVAS_SLACK_DETAIL + 500);
    expect(canvasSlackErrorFields({ data: { detail, token: "secret" } })).toEqual({
      slack_detail: "x".repeat(MAX_CANVAS_SLACK_DETAIL),
    });
    expect(canvasSlackErrorFields({ data: { detail: { nested: true }, token: "secret" } })).toEqual({});
    expect(canvasSlackErrorFields({ data: { token: "secret" } })).toEqual({});
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

  test("sends normalized Markdown through both Canvas edit and create", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "concierge-canvas-payload-"));
    scratchDirectories.push(projectDir);
    writeFileSync(join(projectDir, "AGENTS.md"), "Read [the guide](docs/README.md).\n");
    for (const channelId of ["C_EDIT", "C_NEW"]) {
      upsertChannel({
        slack_channel_id: channelId,
        slack_channel_name: channelId.toLowerCase(),
        group_name: null,
        name: channelId,
        vault_path: projectDir,
        code_path: projectDir,
      });
    }
    updateChannelCanvasId("C_EDIT", "F_EDIT");
    let editedMarkdown = "";
    let createdMarkdown = "";
    const client = {
      canvases: {
        edit: async (args: any) => {
          editedMarkdown = args.changes[0].document_content.markdown;
          return { ok: true };
        },
      },
      conversations: {
        info: async () => ({ ok: true, channel: { properties: { tabs: [] } } }),
        canvases: {
          create: async (args: any) => {
            createdMarkdown = args.document_content.markdown;
            return { ok: true, canvas_id: "F_NEW" };
          },
        },
      },
    };

    expect((await syncAgentsCanvas({ client, channel: getChannel("C_EDIT"), reason: "edit" })).ok).toBeTrue();
    expect((await syncAgentsCanvas({ client, channel: getChannel("C_NEW"), reason: "create" })).ok).toBeTrue();
    expect(editedMarkdown).toContain("the guide — `docs/README.md`");
    expect(createdMarkdown).toContain("the guide — `docs/README.md`");
  });

  test("logs only bounded Slack parser detail for Canvas edit and create failures", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "concierge-canvas-errors-"));
    scratchDirectories.push(projectDir);
    writeFileSync(join(projectDir, "AGENTS.md"), "# Instructions\n");
    for (const channelId of ["C_EDIT_ERROR", "C_CREATE_ERROR"]) {
      upsertChannel({
        slack_channel_id: channelId,
        slack_channel_name: channelId.toLowerCase(),
        group_name: null,
        name: channelId,
        vault_path: projectDir,
        code_path: projectDir,
      });
    }
    updateChannelCanvasId("C_EDIT_ERROR", "F_EDIT_ERROR");
    const editError: any = new Error("canvas edit rejected");
    editError.data = {
      error: "canvas_editing_failed",
      detail: "e".repeat(MAX_CANVAS_SLACK_DETAIL + 200),
      token: "edit-secret",
    };
    const createError: any = new Error("canvas create rejected");
    createError.data = {
      error: "canvas_editing_failed",
      detail: "create detail",
      token: "create-secret",
    };
    const client = {
      canvases: { edit: async () => { throw editError; } },
      conversations: {
        info: async () => ({ ok: true, channel: { properties: { tabs: [] } } }),
        canvases: { create: async () => { throw createError; } },
      },
    };
    const originalConsoleError = console.error;
    const errorLines: string[] = [];
    console.error = (line?: any) => { errorLines.push(String(line)); };
    try {
      await syncAgentsCanvas({ client, channel: getChannel("C_EDIT_ERROR"), reason: "edit-error" });
      await syncAgentsCanvas({ client, channel: getChannel("C_CREATE_ERROR"), reason: "create-error" });
    } finally {
      console.error = originalConsoleError;
    }

    const failures = errorLines.map((line) => JSON.parse(line));
    expect(failures.map((entry) => entry.event)).toEqual(["canvas_update_failed", "canvas_create_failed"]);
    expect(failures[0].slack_detail).toBe("e".repeat(MAX_CANVAS_SLACK_DETAIL));
    expect(failures[1].slack_detail).toBe("create detail");
    expect(errorLines.join("\n")).not.toContain("edit-secret");
    expect(errorLines.join("\n")).not.toContain("create-secret");
  });

  test("contains final fingerprint failures and rejected scheduled refreshes", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "concierge-canvas-schedule-"));
    scratchDirectories.push(projectDir);
    writeFileSync(join(projectDir, "AGENTS.md"), "# Instructions\n");
    upsertChannel({
      slack_channel_id: "C_SCHEDULE",
      slack_channel_name: "schedule",
      group_name: null,
      name: "schedule",
      vault_path: projectDir,
      code_path: projectDir,
    });
    const channel = getChannel("C_SCHEDULE");
    const originalConsoleError = console.error;
    const errorLines: string[] = [];
    const unhandled: unknown[] = [];
    const recordUnhandled = (error: unknown) => { unhandled.push(error); };
    console.error = (line?: any) => { errorLines.push(String(line)); };
    process.on("unhandledRejection", recordUnhandled);
    try {
      scheduleAgentsCanvasRefreshIfChanged({
        client: {},
        channel,
        user: "U1",
        before: "before",
        reason: "turn_done",
        fingerprint: () => { throw new Error("final fingerprint failed"); },
      });
      scheduleAgentsCanvasRefreshIfChanged({
        client: {},
        channel,
        user: "U1",
        before: "before",
        reason: "turn_error",
        fingerprint: () => "after",
        sync: async () => { throw new Error("scheduled refresh rejected"); },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off("unhandledRejection", recordUnhandled);
      console.error = originalConsoleError;
    }

    const failures = errorLines.map((line) => JSON.parse(line));
    expect(failures).toHaveLength(2);
    expect(failures.map((entry) => entry.reason)).toEqual(["turn_done", "turn_error"]);
    expect(failures.every((entry) => entry.channel === "C_SCHEDULE")).toBeTrue();
    expect(unhandled).toEqual([]);
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
