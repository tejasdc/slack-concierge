import { beforeEach, describe, expect, test } from "bun:test";

process.env.CONCIERGE_STATE_DIR = "/tmp/concierge-state-lists-test";

const state = require("../src/state");
// Safety: `bun test` may share a process across files, in which case another
// test file's earlier import of ../src/state wins the DB path lookup. If we
// somehow ended up with the production DB, refuse to run destructive DELETEs.
if (!String(state.db?.filename || "").includes("concierge-state-lists-test")) {
  throw new Error(`Refusing to run lists.test.ts against unexpected DB: ${state.db?.filename}. Set CONCIERGE_STATE_DIR before importing state.`);
}
const {
  appendListItem,
  completeListItem,
  listItems,
  normalizeListItems,
} = require("../src/lists");

const { db, getChannel, upsertChannel } = state;

function seedChannel() {
  upsertChannel({
    slack_channel_id: "C1",
    slack_channel_name: "proj_alpha",
    group_name: "proj",
    name: "alpha",
    vault_path: "/tmp/concierge-state-lists-test/vault",
    code_path: "/tmp/concierge-state-lists-test/code",
  });
  return getChannel("C1");
}

function mockClient() {
  const calls: Array<{ method: string; args: any }> = [];
  return {
    calls,
    client: {
      slackLists: {
        create: async (args: any) => {
          calls.push({ method: "slackLists.create", args });
          return {
            ok: true,
            list_id: "F_LIST",
            list_metadata: {
              schema: [
                { key: "title", id: "ColTitle", type: "text", is_primary_column: true },
                { key: "todo_completed", id: "ColDone", type: "todo_completed" },
              ],
            },
          };
        },
        access: {
          set: async (args: any) => {
            calls.push({ method: "slackLists.access.set", args });
            return { ok: true };
          },
        },
        items: {
          create: async (args: any) => {
            calls.push({ method: "slackLists.items.create", args });
            return { ok: true, item: { id: "Rec1", list_id: "F_LIST", fields: [] } };
          },
          list: async (args: any) => {
            calls.push({ method: "slackLists.items.list", args });
            return {
              ok: true,
              items: [{
                id: "Rec1",
                fields: [
                  { key: "title", text: "Ship Lists" },
                  { key: "todo_completed", checkbox: [false] },
                ],
              }],
            };
          },
          update: async (args: any) => {
            calls.push({ method: "slackLists.items.update", args });
            return { ok: true };
          },
        },
      },
      chat: {
        postEphemeral: async (args: any) => {
          calls.push({ method: "chat.postEphemeral", args });
          return { ok: true };
        },
      },
    },
  };
}

beforeEach(() => {
  db.query("DELETE FROM turns").run();
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM channels").run();
});

describe("Slack List helpers", () => {
  test("creates a per-channel List and writes todo rows with rich_text", async () => {
    const channel = seedChannel();
    const { client, calls } = mockClient();

    const itemId = await appendListItem({ client, channel, text: "Ship Canvas", source: "todo", user: "U1" });

    expect(itemId).toBe("Rec1");
    expect(calls.map((call) => call.method)).toEqual([
      "slackLists.create",
      "slackLists.access.set",
      "slackLists.items.create",
    ]);
    expect(calls[2].args).toMatchObject({
      list_id: "F_LIST",
      initial_fields: [{ column_id: "ColTitle" }],
    });
    expect(calls[2].args.initial_fields[0].rich_text[0].elements[0].elements[0].text).toBe("Ship Canvas");
    expect(getChannel("C1").list_id).toBe("F_LIST");
    expect(getChannel("C1").list_title_column_id).toBe("ColTitle");
  });

  test("reads and normalizes List rows", async () => {
    seedChannel();
    db.query(`
      UPDATE channels
      SET list_id='F_LIST', list_title_column_id='ColTitle', list_completed_column_id='ColDone'
      WHERE slack_channel_id='C1'
    `).run();
    const { client } = mockClient();

    const items = await listItems({ client, channel: getChannel("C1"), user: "U1" });

    expect(items).toEqual([{ id: "Rec1", title: "Ship Lists", completed: false }]);
  });

  test("marks rows complete with the cached todo_completed column", async () => {
    seedChannel();
    db.query(`
      UPDATE channels
      SET list_id='F_LIST', list_title_column_id='ColTitle', list_completed_column_id='ColDone'
      WHERE slack_channel_id='C1'
    `).run();
    const { client, calls } = mockClient();

    expect(await completeListItem({ client, channel: getChannel("C1"), itemId: "Rec1", user: "U1" })).toBe(true);

    expect(calls.at(-1)).toEqual({
      method: "slackLists.items.update",
      args: {
        list_id: "F_LIST",
        cells: [{ row_id: "Rec1", column_id: "ColDone", checkbox: true }],
      },
    });
  });

  test("normalizes rich text fallback values", () => {
    expect(normalizeListItems([{
      id: "Rec2",
      fields: [{
        key: "rich_text_notes",
        rich_text: [{
          type: "rich_text",
          elements: [{
            type: "rich_text_section",
            elements: [{ type: "text", text: "From rich text" }],
          }],
        }],
      }],
    }])).toEqual([{ id: "Rec2", title: "From rich text", completed: false }]);
  });

  test("posts missing-scope instructions without throwing", async () => {
    const channel = seedChannel();
    const calls: Array<{ method: string; args: any }> = [];
    const err: any = new Error("missing_scope");
    err.data = { error: "missing_scope", needed: "lists:write" };
    const client = {
      slackLists: {
        create: async () => {
          throw err;
        },
      },
      chat: {
        postEphemeral: async (args: any) => {
          calls.push({ method: "chat.postEphemeral", args });
          return { ok: true };
        },
      },
    };

    const itemId = await appendListItem({ client, channel, text: "x", source: "todo", user: "U1" });

    expect(itemId).toBeNull();
    expect(calls[0].args.text).toContain("lists:write");
    expect(calls[0].args.text).toContain("reinstall the app");
  });
});

