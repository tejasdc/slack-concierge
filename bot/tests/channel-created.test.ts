import { beforeEach, describe, expect, test } from "bun:test";

process.env.CONCIERGE_STATE_DIR = "/tmp/concierge-state-channel-created-test";
process.env.CONCIERGE_WORKSPACE_ROOT = "/root/workspace";

const state = require("../src/state");
if (!String(state.db?.filename || "").startsWith("/tmp/concierge-state-")) {
  throw new Error(`Refusing to run channel-created.test.ts against unexpected DB: ${state.db?.filename}.`);
}

const { db, getChannel, getChannelByCodePath } = state;
const { attachMigratedProjectChannel } = require("../src/channel");

beforeEach(() => {
  db.query("DELETE FROM turns").run();
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM channels").run();
});

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
