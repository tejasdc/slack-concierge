import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { acquireDatabaseTestLock } from "./db-lock";

// CONCIERGE_STATE_DIR is set by bunfig.toml's [test].preload → tests/preload.ts.
// state.ts's hard guard refuses to open any DB inside $HOME under
// CONCIERGE_TEST_MODE=1, so the destructive DELETEs below can never touch
// production. See tests/state-isolation.test.ts for the invariant proof.
const state = require("../src/state");
const {
  appendListItem,
  buildListPromptContext,
  completeListItem,
  ensureChannelList,
  listItems,
  normalizeListItems,
  slackMessageSourceUrl,
} = require("../src/lists");

const { db, getChannel, updateChannelListState, upsertChannel } = state;
const { slackBucket } = require("../src/rate-limit");
const IDENTITY_SECRET = "lists-test-signing-secret";
const IDENTITY_OWNER_ID = "U_BOT";
let releaseDatabaseTestLock: (() => void) | null = null;

function authenticatedListMarker(channelId: string, listId: string, intentId: string) {
  const signature = createHmac("sha256", IDENTITY_SECRET)
    .update(JSON.stringify(["slack-concierge:list:v3", channelId, listId, intentId]))
    .digest("hex");
  return `Concierge channel list v3: ${channelId}:${listId}:${intentId}:${signature}`;
}

function authenticatedItemSourceUrl(input: {
  channelId: string;
  listId: string;
  source: "todo" | "note" | "agent";
  title: string;
  sourceUrl: string;
}) {
  const signature = createHmac("sha256", IDENTITY_SECRET)
    .update(JSON.stringify([
      "slack-concierge:list-item:v1",
      input.channelId,
      input.listId,
      input.source,
      input.sourceUrl,
      input.title,
    ]))
    .digest("hex");
  return `${input.sourceUrl}#concierge-v1-${signature}`;
}

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
      files: {
        list: async (args: any) => {
          calls.push({ method: "files.list", args });
          return { ok: true, files: [], paging: { page: 1, pages: 1 } };
        },
      },
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
        update: async (args: any) => {
          calls.push({ method: "slackLists.update", args });
          return { ok: true };
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

beforeEach(async () => {
  releaseDatabaseTestLock = await acquireDatabaseTestLock();
  slackBucket.reset();
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

describe("Slack List helpers", () => {
  test("requires a concise TL;DR before the detailed Slack response", () => {
    const prompt = buildListPromptContext("# Project list");

    expect(prompt).toContain("Start every final response with `TL;DR:` followed by a concise summary.");
    expect(prompt).toContain("After the TL;DR, provide the full detailed response.");
  });

  test("creates a per-channel List and writes todo rows with rich_text", async () => {
    const channel = seedChannel();
    const { client, calls } = mockClient();

    const itemId = await appendListItem({
      client, channel, text: "Ship Canvas", source: "todo", user: "U1",
      identitySecret: IDENTITY_SECRET, identityOwnerId: IDENTITY_OWNER_ID,
    });

    expect(itemId).toBe("Rec1");
    expect(calls.map((call) => call.method)).toEqual([
      "files.list",
      "files.list",
      "slackLists.create",
      "slackLists.update",
      "slackLists.access.set",
      "slackLists.items.create",
    ]);
    expect(calls[5].args).toMatchObject({
      list_id: "F_LIST",
      initial_fields: [{ column_id: "ColTitle" }],
    });
    expect(calls[5].args.initial_fields[0].rich_text[0].elements[0].elements[0].text).toBe("Ship Canvas");
    const pendingDescription = calls[2].args.description_blocks[0].elements[0].elements[0].text;
    const intentId = pendingDescription.match(/^Concierge channel list pending v3: C1:([^:]+):/)?.[1];
    expect(intentId).toBeTruthy();
    if (!intentId) throw new Error("missing List creation intent");
    expect(calls[3].args.description_blocks[0].elements[0].elements[0].text)
      .toStartWith(authenticatedListMarker("C1", "F_LIST", intentId));
    expect(getChannel("C1").list_id).toBe("F_LIST");
    expect(getChannel("C1").list_title_column_id).toBe("ColTitle");
  });

  test("retries a transient channel-access grant from persisted List state", async () => {
    const channel = seedChannel();
    const { client, calls } = mockClient();
    let accessAttempts = 0;
    client.slackLists.access.set = async (args: any) => {
      calls.push({ method: "slackLists.access.set", args });
      accessAttempts += 1;
      if (accessAttempts === 1) {
        throw Object.assign(new Error("temporary Slack failure"), {
          code: "slack_webapi_request_error",
        });
      }
      return { ok: true };
    };

    await expect(ensureChannelList({
      client,
      channel,
      identitySecret: IDENTITY_SECRET,
      identityOwnerId: IDENTITY_OWNER_ID,
    })).rejects.toThrow("temporary Slack failure");
    expect(getChannel("C1")).toMatchObject({
      list_id: "F_LIST",
      list_title_column_id: "ColTitle",
    });

    await ensureChannelList({
      client,
      channel: getChannel("C1"),
      identitySecret: IDENTITY_SECRET,
      identityOwnerId: IDENTITY_OWNER_ID,
    });

    expect(accessAttempts).toBe(2);
    expect(calls.filter((call) => call.method === "slackLists.create")).toHaveLength(1);
  });

  test("repairs channel access after restart finds List state persisted before the grant", async () => {
    const channel = seedChannel();
    updateChannelListState("C1", {
      listId: "F_PERSISTED",
      titleColumnId: "ColPersistedTitle",
      completedColumnId: "ColPersistedDone",
    });
    const { client, calls } = mockClient();

    await ensureChannelList({
      client,
      channel: getChannel("C1") || channel,
      identitySecret: IDENTITY_SECRET,
      identityOwnerId: IDENTITY_OWNER_ID,
    });

    expect(calls).toEqual([{
      method: "slackLists.access.set",
      args: {
        list_id: "F_PERSISTED",
        access_level: "write",
        channel_ids: ["C1"],
      },
    }]);
  });

  test("reads and normalizes List rows", async () => {
    seedChannel();
    db.query(`
      UPDATE channels
      SET list_id='F_LIST', list_title_column_id='ColTitle', list_completed_column_id='ColDone'
      WHERE slack_channel_id='C1'
    `).run();
    const { client } = mockClient();

    const items = await listItems({
      client, channel: getChannel("C1"), user: "U1",
      identitySecret: IDENTITY_SECRET, identityOwnerId: IDENTITY_OWNER_ID,
    });

    expect(items).toEqual([{ id: "Rec1", title: "Ship Lists", completed: false }]);
  });

  test("reuses a List row linked to the same Slack capture after a crash", async () => {
    seedChannel();
    db.query(`
      UPDATE channels
      SET list_id='F_LIST', list_title_column_id='ColTitle', list_completed_column_id='ColDone'
      WHERE slack_channel_id='C1'
    `).run();
    const sourceUrl = slackMessageSourceUrl("C1", "123.456789");
    const authenticatedSourceUrl = authenticatedItemSourceUrl({
      channelId: "C1",
      listId: "F_LIST",
      source: "todo",
      title: "Keep once",
      sourceUrl,
    });
    const calls: string[] = [];
    const client = {
      slackLists: { items: {
        list: async () => {
          calls.push("list");
          return {
            ok: true,
            items: [{
              id: "RecExisting",
              created_by: IDENTITY_OWNER_ID,
              fields: [{
                key: "title",
                rich_text: [{
                  type: "rich_text",
                  elements: [{
                    type: "rich_text_section",
                    elements: [
                      { type: "text", text: "Keep once" },
                      { type: "text", text: " " },
                      { type: "link", url: authenticatedSourceUrl, text: "↗" },
                    ],
                  }],
                }],
              }],
            }],
          };
        },
        create: async () => { throw new Error("duplicate create must not run"); },
      } },
    };

    const itemId = await appendListItem({
      client,
      channel: getChannel("C1"),
      text: "Keep once",
      source: "todo",
      user: "U1",
      sourceMessage: { channel: "C1", ts: "123.456789" },
      identitySecret: IDENTITY_SECRET,
      identityOwnerId: IDENTITY_OWNER_ID,
    });

    expect(itemId).toBe("RecExisting");
    expect(calls).toEqual(["list"]);
    expect(normalizeListItems([{
      id: "RecExisting",
      fields: [{
        key: "title",
        rich_text: [{
          type: "rich_text",
          elements: [{
            type: "rich_text_section",
            elements: [
              { type: "text", text: "Keep once" },
              { type: "text", text: " " },
              { type: "link", url: authenticatedSourceUrl, text: "↗" },
            ],
          }],
        }],
      }],
    }])).toEqual([{ id: "RecExisting", title: "Keep once", completed: false }]);
  });

  test("reconciles a remotely-created channel List after local persistence fails", async () => {
    const channel = seedChannel();
    const remoteFiles: any[] = [];
    let createCalls = 0;
    const client = {
      files: {
        list: async () => ({ ok: true, files: remoteFiles, paging: { page: 1, pages: 1 } }),
      },
      slackLists: {
        create: async (args: any) => {
          createCalls += 1;
          const listMetadata = {
            schema: [
              { key: "title", id: "ColRecoveredTitle", type: "text", is_primary_column: true },
              { key: "todo_completed", id: "ColRecoveredDone", type: "todo_completed" },
            ],
            description_blocks: args.description_blocks,
          };
          remoteFiles.push({
            id: "F_RECOVERED",
            user: IDENTITY_OWNER_ID,
            title: args.name,
            filetype: "list",
            mimetype: "application/vnd.slack-list",
            created: 1,
            list_metadata: listMetadata,
          });
          return { ok: true, list_id: "F_RECOVERED", list_metadata: listMetadata };
        },
        update: async (args: any) => {
          const remote = remoteFiles.find((file) => file.id === args.id);
          remote.list_metadata.description_blocks = args.description_blocks;
          return { ok: true };
        },
        access: { set: async () => ({ ok: true }) },
      },
    };
    db.exec(`
      CREATE TEMP TRIGGER fail_channel_list_persistence
      BEFORE UPDATE OF list_id ON channels
      WHEN NEW.list_id IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'simulated local persistence failure');
      END;
    `);

    try {
      await expect(ensureChannelList({
        client, channel, user: "U1", identitySecret: IDENTITY_SECRET, identityOwnerId: IDENTITY_OWNER_ID,
      }))
        .rejects.toThrow("simulated local persistence failure");
    } finally {
      db.exec("DROP TRIGGER fail_channel_list_persistence");
    }
    expect(getChannel("C1").list_id).toBeNull();

    const recovered = await ensureChannelList({
      client, channel: getChannel("C1"), user: "U1",
      identitySecret: IDENTITY_SECRET, identityOwnerId: IDENTITY_OWNER_ID,
    });

    expect(recovered).toEqual({
      listId: "F_RECOVERED",
      titleColumnId: "ColRecoveredTitle",
      completedColumnId: "ColRecoveredDone",
    });
    expect(createCalls).toBe(1);
    expect(getChannel("C1")).toMatchObject({
      list_id: "F_RECOVERED",
      list_title_column_id: "ColRecoveredTitle",
      list_completed_column_id: "ColRecoveredDone",
    });
  });

  test("recovers a durable creation intent after create succeeds before identity binding", async () => {
    const channel = seedChannel();
    const remoteFiles: any[] = [];
    let createCalls = 0;
    let updateCalls = 0;
    const client = {
      files: {
        list: async () => ({ ok: true, files: remoteFiles, paging: { page: 1, pages: 1 } }),
      },
      slackLists: {
        create: async (args: any) => {
          createCalls += 1;
          const listMetadata = {
            schema: [{ key: "title", id: "ColPendingTitle", type: "text", is_primary_column: true }],
            description_blocks: args.description_blocks,
          };
          remoteFiles.push({
            id: "F_PENDING",
            user: IDENTITY_OWNER_ID,
            filetype: "list",
            created: Math.floor(Date.now() / 1_000),
            list_metadata: listMetadata,
          });
          return { ok: true, list_id: "F_PENDING", list_metadata: listMetadata };
        },
        update: async (args: any) => {
          updateCalls += 1;
          if (updateCalls === 1) throw new Error("simulated crash before List identity binding");
          remoteFiles[0].list_metadata.description_blocks = args.description_blocks;
          return { ok: true };
        },
        access: { set: async () => ({ ok: true }) },
      },
    };

    await expect(ensureChannelList({
      client, channel, user: "U1", identitySecret: IDENTITY_SECRET, identityOwnerId: IDENTITY_OWNER_ID,
    })).rejects.toThrow("simulated crash before List identity binding");
    expect(getChannel("C1")).toMatchObject({
      list_id: null,
      list_creation_intent_id: expect.any(String),
    });

    const recovered = await ensureChannelList({
      client,
      channel: getChannel("C1"),
      user: "U1",
      identitySecret: IDENTITY_SECRET,
      identityOwnerId: IDENTITY_OWNER_ID,
    });

    expect(recovered?.listId).toBe("F_PENDING");
    expect(createCalls).toBe(1);
    expect(updateCalls).toBe(2);
    expect(getChannel("C1")).toMatchObject({
      list_id: "F_PENDING",
      list_creation_intent_id: null,
    });
  });

  test("ignores copied List markers from another object even when the bot owns it", async () => {
    const channel = seedChannel();
    let createCalls = 0;
    const copiedAuthenticatedMarker = authenticatedListMarker("C1", "F_ORIGINAL", "copied-intent");
    const client = {
      files: {
        list: async () => ({
          ok: true,
          files: [{
            id: "F_COPIED",
            user: IDENTITY_OWNER_ID,
            filetype: "list",
            created: 1,
            list_metadata: {
              description_blocks: [{
                type: "rich_text",
                elements: [{
                  type: "rich_text_section",
                  elements: [{ type: "text", text: copiedAuthenticatedMarker }],
                }],
              }],
              schema: [{ key: "title", id: "ColAttack", type: "text" }],
            },
          }],
          paging: { page: 1, pages: 1 },
        }),
      },
      slackLists: {
        create: async () => {
          createCalls += 1;
          return {
            ok: true,
            list_id: "F_AUTHENTIC",
            list_metadata: { schema: [{ key: "title", id: "ColAuthentic", type: "text" }] },
          };
        },
        update: async () => ({ ok: true }),
        access: { set: async () => ({ ok: true }) },
      },
    };

    const created = await ensureChannelList({
      client, channel, user: "U1", identitySecret: IDENTITY_SECRET, identityOwnerId: IDENTITY_OWNER_ID,
    });

    expect(created?.listId).toBe("F_AUTHENTIC");
    expect(createCalls).toBe(1);
    expect(getChannel("C1").list_id).toBe("F_AUTHENTIC");
  });

  test("replaces a deleted cached List before writing the capture row", async () => {
    seedChannel();
    db.query(`
      UPDATE channels
      SET list_id='F_DELETED', list_title_column_id='ColDeleted'
      WHERE slack_channel_id='C1'
    `).run();
    let createListCalls = 0;
    let createItemCalls = 0;
    const client = {
      files: {
        list: async () => ({
          ok: true,
          files: [{
            id: "F_OLDER",
            user: IDENTITY_OWNER_ID,
            filetype: "list",
            created: 1,
            list_metadata: {
              description_blocks: [{
                type: "rich_text",
                elements: [{
                  type: "rich_text_section",
                  elements: [{ type: "text", text: authenticatedListMarker("C1", "F_OLDER", "older-intent") }],
                }],
              }],
              schema: [{ key: "title", id: "ColOlder", type: "text" }],
            },
          }],
          paging: { page: 1, pages: 1 },
        }),
      },
      slackLists: {
        create: async () => {
          createListCalls += 1;
          return {
            ok: true,
            list_id: "F_REPLACEMENT",
            list_metadata: { schema: [{ key: "title", id: "ColReplacement", type: "text" }] },
          };
        },
        update: async () => ({ ok: true }),
        access: { set: async () => ({ ok: true }) },
        items: {
          list: async ({ list_id }: any) => {
            if (list_id === "F_DELETED") {
              throw Object.assign(new Error("list_not_found"), { data: { error: "list_not_found" } });
            }
            return { ok: true, items: [] };
          },
          create: async ({ list_id }: any) => {
            expect(list_id).toBe("F_REPLACEMENT");
            createItemCalls += 1;
            return { ok: true, item: { id: "RecReplacement" } };
          },
        },
      },
    };

    const itemId = await appendListItem({
      client,
      channel: getChannel("C1"),
      text: "Recover capture",
      source: "todo",
      user: "U1",
      sourceMessage: { channel: "C1", ts: "234.567890" },
      identitySecret: IDENTITY_SECRET,
      identityOwnerId: IDENTITY_OWNER_ID,
    });

    expect(itemId).toBe("RecReplacement");
    expect(createListCalls).toBe(1);
    expect(createItemCalls).toBe(1);
    expect(getChannel("C1")).toMatchObject({
      list_id: "F_REPLACEMENT",
      list_title_column_id: "ColReplacement",
    });
  });

  test("retries SQLite contention while clearing a stale cached List", async () => {
    seedChannel();
    db.query(`
      UPDATE channels
      SET list_id='F_DELETED', list_title_column_id='ColDeleted'
      WHERE slack_channel_id='C1'
    `).run();
    const statePath = `${process.env.CONCIERGE_STATE_DIR}/state.db`;
    const locker = new Database(statePath);
    let lockReleased = false;
    db.exec("PRAGMA busy_timeout=20");
    locker.exec("BEGIN IMMEDIATE");
    locker.query("UPDATE channels SET name=name WHERE slack_channel_id='C1'").run();
    const releaseLock = setTimeout(() => {
      locker.exec("ROLLBACK");
      locker.close();
      lockReleased = true;
    }, 30);
    const client = {
      files: { list: async () => ({ ok: true, files: [], paging: { page: 1, pages: 1 } }) },
      slackLists: {
        create: async () => ({
          ok: true,
          list_id: "F_REPLACEMENT",
          list_metadata: { schema: [{ key: "title", id: "ColReplacement", type: "text" }] },
        }),
        update: async () => ({ ok: true }),
        access: { set: async () => ({ ok: true }) },
        items: {
          list: async ({ list_id }: any) => {
            if (list_id === "F_DELETED") {
              throw Object.assign(new Error("list_not_found"), { data: { error: "list_not_found" } });
            }
            return { ok: true, items: [] };
          },
          create: async () => ({ ok: true, item: { id: "RecAfterLock" } }),
        },
      },
    };

    try {
      const itemId = await appendListItem({
        client,
        channel: getChannel("C1"),
        text: "Persist after lock",
        source: "todo",
        sourceMessage: { channel: "C1", ts: "700.000001" },
        identitySecret: IDENTITY_SECRET,
        identityOwnerId: IDENTITY_OWNER_ID,
      });
      expect(itemId).toBe("RecAfterLock");
      expect(lockReleased).toBeTrue();
      expect(getChannel("C1").list_id).toBe("F_REPLACEMENT");
    } finally {
      clearTimeout(releaseLock);
      if (!lockReleased) {
        locker.exec("ROLLBACK");
        locker.close();
      }
      db.exec("PRAGMA busy_timeout=5000");
    }
  });

  test("does not accept an unrelated row containing only the public source permalink", async () => {
    seedChannel();
    db.query(`
      UPDATE channels
      SET list_id='F_LIST', list_title_column_id='ColTitle'
      WHERE slack_channel_id='C1'
    `).run();
    const sourceUrl = slackMessageSourceUrl("C1", "777.000001");
    let createdRichText: any = null;
    const client = { slackLists: { items: {
      list: async () => ({
        ok: true,
        items: [{
          id: "RecUnrelated",
          created_by: IDENTITY_OWNER_ID,
          fields: [{ rich_text: [{ elements: [{ elements: [{ type: "link", url: sourceUrl }] }] }] }],
        }],
      }),
      create: async (args: any) => {
        createdRichText = args.initial_fields[0].rich_text;
        return { ok: true, item: { id: "RecAuthenticated" } };
      },
    } } };

    const itemId = await appendListItem({
      client,
      channel: getChannel("C1"),
      text: "Victim todo",
      source: "todo",
      sourceMessage: { channel: "C1", ts: "777.000001" },
      identitySecret: IDENTITY_SECRET,
      identityOwnerId: IDENTITY_OWNER_ID,
    });

    expect(itemId).toBe("RecAuthenticated");
    const createdLink = createdRichText[0].elements[0].elements.find((element: any) => element.type === "link");
    expect(createdLink.url).toStartWith(`${sourceUrl}#concierge-v1-`);
    expect(createdLink.url).not.toBe(sourceUrl);
  });

  test("serializes concurrent appends for the same Slack source message", async () => {
    seedChannel();
    db.query(`
      UPDATE channels
      SET list_id='F_LIST', list_title_column_id='ColTitle'
      WHERE slack_channel_id='C1'
    `).run();
    let releaseScan!: () => void;
    const scanReleased = new Promise<void>((resolve) => { releaseScan = resolve; });
    let reportScanStarted!: () => void;
    const scanStarted = new Promise<void>((resolve) => { reportScanStarted = resolve; });
    let scanCalls = 0;
    let createCalls = 0;
    const client = { slackLists: { items: {
      list: async () => {
        scanCalls += 1;
        reportScanStarted();
        await scanReleased;
        return { ok: true, items: [] };
      },
      create: async () => {
        createCalls += 1;
        return { ok: true, item: { id: "RecOnly" } };
      },
    } } };
    const input = {
      client,
      channel: getChannel("C1"),
      text: "Keep once",
      source: "todo" as const,
      user: "U1",
      sourceMessage: { channel: "C1", ts: "345.678901" },
      identitySecret: IDENTITY_SECRET,
      identityOwnerId: IDENTITY_OWNER_ID,
    };

    const first = appendListItem(input);
    await scanStarted;
    const second = appendListItem(input);
    releaseScan();
    const ids = await Promise.all([first, second]);

    expect(ids).toEqual(["RecOnly", "RecOnly"]);
    expect(scanCalls).toBe(1);
    expect(createCalls).toBe(1);
  });

  test("marks rows complete with the cached todo_completed column", async () => {
    seedChannel();
    db.query(`
      UPDATE channels
      SET list_id='F_LIST', list_title_column_id='ColTitle', list_completed_column_id='ColDone'
      WHERE slack_channel_id='C1'
    `).run();
    const { client, calls } = mockClient();

    expect(await completeListItem({
      client,
      channel: getChannel("C1"),
      itemId: "Rec1",
      user: "U1",
      identitySecret: IDENTITY_SECRET,
      identityOwnerId: IDENTITY_OWNER_ID,
    })).toBe(true);

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
      files: {
        list: async () => ({ ok: true, files: [], paging: { page: 1, pages: 1 } }),
      },
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

    const itemId = await appendListItem({
      client, channel, text: "x", source: "todo", user: "U1",
      identitySecret: IDENTITY_SECRET, identityOwnerId: IDENTITY_OWNER_ID,
    });

    expect(itemId).toBeNull();
    expect(calls[0].args.text).toContain("lists:write");
    expect(calls[0].args.text).toContain("reinstall the app");
  });
});
