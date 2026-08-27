import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDatabaseTestLock } from "./db-lock";

// CONCIERGE_STATE_DIR is set by tests/preload.ts; state.ts hard-refuses
// production paths under CONCIERGE_TEST_MODE=1. Destructive DELETEs
// below are safe by construction.
process.env.CONCIERGE_WORKSPACE_ROOT = "/root/workspace";

const state = require("../src/state");
const { db, getAllChannels, getChannel, getChannelByCodePath, getSlackChannels } = state;
const { appendTodo, attachMigratedProjectChannel } = require("../src/channel");
const { syncAllAgentsCanvases } = require("../src/canvas");
const CAPTURE_SECRET = "capture-test-signing-secret";

let releaseDatabaseTestLock: (() => void) | null = null;
beforeEach(async () => {
  releaseDatabaseTestLock = await acquireDatabaseTestLock();
  db.query("DELETE FROM deployment_drain").run();
  db.query("DELETE FROM comparison_requests").run();
  db.query("DELETE FROM slack_user_input_claims").run();
  db.query("DELETE FROM turn_steering_messages").run();
  db.query("DELETE FROM turn_delivery_chunks").run();
  db.query("DELETE FROM turns").run();
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM process_instances").run();
  db.query("DELETE FROM channels").run();
});
afterEach(() => { releaseDatabaseTestLock?.(); releaseDatabaseTestLock = null; });

describe("attachMigratedProjectChannel", () => {
  test("strict Canvas inventory excludes registry-only NULL-channel rows", async () => {
    db.query(`
      INSERT INTO channels (
        slack_channel_id, slack_channel_name, vault_path, code_path,
        additional_paths, provider_default, group_name, name, mode
      ) VALUES
        (NULL, 'adopted', '/vault/adopted', '/code/adopted', '[]', 'codex', NULL, 'adopted', 'agent-auto'),
        ('C123', 'visible', '/vault/visible', '/code/visible', '[]', 'codex', NULL, 'visible', 'agent-auto')
    `).run();
    const synchronized: string[] = [];

    const result = await syncAllAgentsCanvases({
      channels: getSlackChannels(),
      requireSuccess: true,
      sync: async (channel: any) => {
        synchronized.push(channel.slack_channel_id);
        return { ok: true as const };
      },
    });

    expect(getAllChannels()).toHaveLength(2);
    expect(getSlackChannels().map((channel: any) => channel.slack_channel_id)).toEqual(["C123"]);
    expect(synchronized).toEqual(["C123"]);
    expect(result).toEqual({ refreshed: 1, failures: [] });
  });

  test("attaches a channel_created event to a migrated NULL-channel row", () => {
    const codePath = "/root/workspace/blogs/binding-values";
    db.query(`
      INSERT INTO channels (
        slack_channel_id, slack_channel_name, vault_path, code_path,
        additional_paths, provider_default, group_name, name, mode
      )
      VALUES (NULL, ?, ?, ?, '[]', 'codex', ?, ?, 'agent-auto')
    `).run(
      "blogs_binding-values",
      "/root/workspace/vault/projects/blogs/binding-values",
      codePath,
      "blogs",
      "binding-values",
    );

    const result = attachMigratedProjectChannel("C123", "blogs_binding-values");

    expect(result.status).toBe("attached");
    expect(getChannel("C123")?.code_path).toBe(codePath);
    expect(getChannelByCodePath(codePath)?.slack_channel_id).toBe("C123");
  });

  test("does not claim a migrated path that already has a Slack channel id", () => {
    const codePath = "/root/workspace/ralph";
    db.query(`
      INSERT INTO channels (
        slack_channel_id, slack_channel_name, vault_path, code_path,
        additional_paths, provider_default, group_name, name, mode
      )
      VALUES (?, ?, ?, ?, '[]', 'codex', NULL, ?, 'agent-auto')
    `).run("COLD", "ralph", "/root/workspace/vault/projects/ralph", codePath, "ralph");

    const result = attachMigratedProjectChannel("CNEW", "ralph");

    expect(result.status).toBe("claimed");
    expect(getChannel("COLD")?.code_path).toBe(codePath);
    expect(getChannel("CNEW")).toBeNull();
  });
});

test("inline capture markers make a retried file append idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "concierge-capture-test-"));
  const channel = { slack_channel_id: "C1", slack_channel_name: "capture", vault_path: dir };
  try {
    const slackOrigin = { channel: "C1", ts: "123.456789" };
    appendTodo(channel, "Keep this once", "inline by U1", "C1:123.456789", CAPTURE_SECRET, slackOrigin);
    appendTodo(channel, "Keep this once", "inline by U1", "C1:123.456789", CAPTURE_SECRET, slackOrigin);

    const content = readFileSync(join(dir, "notes", "TODOS.md"), "utf-8");
    expect(content.match(/Keep this once/g)).toHaveLength(1);
    expect(content).toMatch(/concierge-capture-v1:[0-9a-f]{64}/);
    expect(content).toContain("concierge-slack-origin-v1:C1:123.456789");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("multi-paragraph todo captures remain one canonical checklist item", () => {
  const dir = mkdtempSync(join(tmpdir(), "concierge-capture-test-"));
  const channel = { slack_channel_id: "C1", slack_channel_name: "capture", vault_path: dir };
  try {
    appendTodo(channel, "First paragraph.\n\nSecond paragraph.", "inline by U1");

    const content = readFileSync(join(dir, "notes", "TODOS.md"), "utf-8");
    expect(content).toContain("- [ ] First paragraph.\n\n    Second paragraph.\n");
    expect(content.match(/^- \[ \]/gm)).toHaveLength(1);
    expect(content).not.toContain("\nSecond paragraph.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("user-authored marker text cannot suppress another inline capture", () => {
  const dir = mkdtempSync(join(tmpdir(), "concierge-capture-test-"));
  const channel = { slack_channel_id: "C1", slack_channel_name: "capture", vault_path: dir };
  try {
    appendTodo(
      channel,
      "planted <!-- concierge-capture-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->",
      "inline by U1",
    );
    appendTodo(channel, "Victim capture", "inline by U1", "C1:999.999", CAPTURE_SECRET);

    const content = readFileSync(join(dir, "notes", "TODOS.md"), "utf-8");
    expect(content).toContain("Victim capture");
    expect(content).toMatch(/concierge-capture-v1:(?!a{64})[0-9a-f]{64}/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup completes durable inline captures before generic orphan release", () => {
  const source = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf-8");
  const capture = source.slice(
    source.indexOf("async function handleInlineCapture"),
    source.indexOf("async function projectTodos"),
  );
  const recovery = source.slice(
    source.indexOf("async function reconcileOrphanedSlackInputs"),
    source.indexOf("async function reconcilePriorInstanceTurns"),
  );

  expect(capture.indexOf("appendTodo(")).toBeLessThan(capture.indexOf("todoFileWatcher?.schedule("));
  expect(capture.indexOf("todoFileWatcher?.schedule(")).toBeLessThan(capture.indexOf("finishInlineCapture("));
  expect(capture).not.toContain("await projectTodos(");
  expect(capture).toContain("markInlineCaptureListSkipped(");
  expect(recovery.indexOf("scheduleInlineCaptureRecovery(")).toBeLessThan(recovery.indexOf("releaseOrphanedSlackInputClaims("));
});

test("todo capture queues file projection without entering the interactive Slack path", () => {
  const source = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf-8");
  const command = source.slice(
    source.indexOf('app.command("/todo"'),
    source.indexOf('app.command("/note"'),
  );

  expect(command.indexOf("appendTodo(")).toBeLessThan(command.indexOf("todoFileWatcher?.schedule("));
  expect(command.indexOf("todoFileWatcher?.schedule(")).toBeLessThan(command.indexOf("await respond("));
  expect(command).toContain("`Todo added: ${text}`");
  expect(command).not.toContain("const file = appendTodo");
  expect(command).not.toContain("await projectTodos(");
  expect(source).not.toContain("CONCIERGE_TODO_SYNC_INTERVAL_MS");
  expect(source).not.toContain("scheduleAllTodoSync");
});
