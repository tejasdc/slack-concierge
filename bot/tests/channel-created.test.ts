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
const { db, getChannel, getChannelByCodePath } = state;
const { appendTodo, attachMigratedProjectChannel } = require("../src/channel");
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
    appendTodo(channel, "Keep this once", "inline by U1", "C1:123.456", CAPTURE_SECRET);
    appendTodo(channel, "Keep this once", "inline by U1", "C1:123.456", CAPTURE_SECRET);

    const content = readFileSync(join(dir, "TODOS.md"), "utf-8");
    expect(content.match(/Keep this once/g)).toHaveLength(1);
    expect(content).toMatch(/concierge-capture-v1:[0-9a-f]{64}/);
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

    const content = readFileSync(join(dir, "TODOS.md"), "utf-8");
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
    source.indexOf("async function syncCanvasIfAgentsChanged"),
  );
  const recovery = source.slice(
    source.indexOf("async function reconcileOrphanedSlackInputs"),
    source.indexOf("async function reconcilePriorInstanceTurns"),
  );

  expect(capture.indexOf("appendTodo(")).toBeLessThan(capture.indexOf("appendListItem({"));
  expect(capture.indexOf("appendListItem({")).toBeLessThan(capture.indexOf("finishInlineCapture("));
  expect(capture).toContain("if (isTransientSlackError(error) || isTransientDatabaseError(error)) throw error");
  expect(capture).toContain("markInlineCaptureListSkipped(");
  expect(recovery.indexOf("scheduleInlineCaptureRecovery(")).toBeLessThan(recovery.indexOf("releaseOrphanedSlackInputClaims("));
});
