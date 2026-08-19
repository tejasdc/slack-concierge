import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getChannel,
  getTodoSyncState,
  commitTodoSyncState,
  markTodoSyncConflictNoticeDelivered,
  updateChannelListState,
  upsertChannel,
} from "../src/state";
import { mergeTodoRows, parseTodosMarkdown, renderTodosMarkdown, TodoSyncManager } from "../src/todo-sync";
import { slackBucket } from "../src/rate-limit";

const temporaryDirectories: string[] = [];

beforeEach(() => slackBucket.reset());

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("canonical TODO synchronization", () => {
  test("parses stable Slack row IDs without exposing capture markers as titles", () => {
    expect(parseTodosMarkdown([
      "# todos",
      "- [ ] First <!-- RecOne -->",
      "- [x] Second <!-- concierge-capture-v1:abc -->",
    ].join("\n"))).toEqual([
      { id: "RecOne", title: "First", completed: false },
      { id: "local:0", title: "Second", completed: true },
    ]);
  });

  test("updates task lines while preserving surrounding Markdown and nested details", () => {
    const markdown = [
      "# Working notes",
      "",
      "Keep this prose exactly.",
      "<!-- editorial comment -->",
      "- [ ] Old title <!-- RecOne -->",
      "  Nested detail for the original task.",
      "",
      "## Later section",
      "Unrelated ending.",
      "",
    ].join("\r\n");
    const rendered = renderTodosMarkdown({ slack_channel_name: "unused" } as any, [
      { id: "RecOne", title: "New title", completed: true },
      { id: "RecTwo", title: "Slack-created task", completed: false },
    ], markdown);

    expect(rendered).toContain("Keep this prose exactly.\r\n<!-- editorial comment -->");
    expect(rendered).toContain("- [x] New title <!-- RecOne -->\r\n  Nested detail for the original task.");
    expect(rendered).toContain("## Later section\r\nUnrelated ending.");
    expect(rendered).toEndWith("- [ ] Slack-created task <!-- RecTwo -->\r\n");
    expect(rendered.replaceAll("\r\n", "")).not.toContain("\n");
  });

  test("recognizes only top-level todos and preserves Markdown code, quotes, HTML, nesting, and line endings", () => {
    const markdown = [
      "# todos\r\n",
      "- [ ] Real task <!-- RecReal -->\n",
      "  - [ ] Nested task\r\n",
      "> - [ ] Quoted task\n",
      "    - [ ] Indented code task\r\n",
      "```md\n- [ ] Backtick code task\n```\r\n",
      "~~~\r\n- [ ] Tilde code task\r\n~~~\n",
      "<!--\r\n- [ ] Comment task\r\n-->\n",
      "<pre>\n- [ ] Raw HTML task\n</pre>\r\n",
      "<div>\r\n- [ ] HTML block task\r\n</div>\r\n\r\n",
      "Ending prose\n",
    ].join("");

    expect(parseTodosMarkdown(markdown)).toEqual([
      { id: "RecReal", title: "Real task", completed: false },
    ]);
    const rendered = renderTodosMarkdown({ slack_channel_name: "unused" } as any, [
      { id: "RecReal", title: "Updated real task", completed: true },
    ], markdown);
    expect(rendered).toContain("- [x] Updated real task <!-- RecReal -->\n");
    for (const protectedLine of [
      "  - [ ] Nested task\r\n",
      "> - [ ] Quoted task\n",
      "    - [ ] Indented code task\r\n",
      "- [ ] Backtick code task\n",
      "- [ ] Tilde code task\r\n",
      "- [ ] Comment task\r\n",
      "- [ ] Raw HTML task\n",
      "- [ ] HTML block task\r\n",
    ]) expect(rendered).toContain(protectedLine);
  });

  test("merges independent fields and lets the file win same-field conflicts", () => {
    const base = [{ id: "Rec1", title: "Original", completed: false }];
    expect(mergeTodoRows(
      base,
      [{ id: "Rec1", title: "File title", completed: false }],
      [{ id: "Rec1", title: "Original", completed: true }],
    )).toEqual({
      rows: [{ id: "Rec1", title: "File title", completed: true }],
      deleteSlackIds: [],
      conflicts: [],
    });
    expect(mergeTodoRows(
      base,
      [{ id: "Rec1", title: "File title", completed: false }],
      [{ id: "Rec1", title: "Slack title", completed: false }],
    ).conflicts).toEqual(["Rec1: file title won over a simultaneous Slack title edit"]);
  });

  test("recovers a newly created file todo even if completion projection was interrupted", async () => {
    const root = mkdtempSync(join(tmpdir(), "concierge-todo-recovery-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, "notes"), { recursive: true });
    writeFileSync(join(root, "notes", "TODOS.md"), "# todos\n\n- [x] Already created\n");
    const channelId = `C_TODO_RECOVERY_${Date.now()}`;
    upsertChannel({
      slack_channel_id: channelId,
      slack_channel_name: "todo-recovery",
      group_name: null,
      name: "Todo recovery",
      vault_path: root,
      code_path: join(root, "different-code-path"),
    });
    updateChannelListState(channelId, {
      listId: "F_RECOVERY",
      titleColumnId: "ColTitle",
      completedColumnId: "ColDone",
    });
    const rows = [{ id: "RecExisting", title: "Already created", completed: false }];
    let creates = 0;
    const client = {
      slackLists: {
        access: { set: async () => ({ ok: true }) },
        items: {
          list: async () => ({
            ok: true,
            items: rows.map((row) => ({
              id: row.id,
              fields: [
                { key: "title", column_id: "ColTitle", text: row.title },
                { key: "todo_completed", column_id: "ColDone", checkbox: [row.completed] },
              ],
            })),
          }),
          create: async () => {
            creates += 1;
            return { ok: true, item: { id: "Unexpected" } };
          },
          update: async (args: any) => {
            for (const cell of args.cells) {
              const row = rows.find((candidate) => candidate.id === cell.row_id)!;
              if (cell.checkbox !== undefined) row.completed = Boolean(cell.checkbox[0]);
            }
            return { ok: true };
          },
          delete: async () => ({ ok: true }),
        },
      },
    };

    await new TodoSyncManager({ identitySecret: "secret", identityOwnerId: "U_BOT" })
      .reconcile({ client, channel: getChannel(channelId)! });

    expect(creates).toBe(0);
    expect(rows[0].completed).toBeTrue();
    expect(readFileSync(join(root, "notes", "TODOS.md"), "utf8")).toContain(
      "Already created <!-- RecExisting -->",
    );
  });

  test("projects Slack edits into the file and posts one conflict notice", async () => {
    const root = mkdtempSync(join(tmpdir(), "concierge-todo-sync-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, "notes"), { recursive: true });
    writeFileSync(join(root, "notes", "TODOS.md"), "# todos\n\n- [ ] File title <!-- Rec1 -->\n");
    const channelId = `C_TODO_${Date.now()}`;
    upsertChannel({
      slack_channel_id: channelId,
      slack_channel_name: "todo-sync",
      group_name: null,
      name: "Todo sync",
      vault_path: root,
      code_path: root,
    });
    updateChannelListState(channelId, {
      listId: "F_LIST",
      titleColumnId: "ColTitle",
      completedColumnId: "ColDone",
    });
    commitTodoSyncState({
      slackChannelId: channelId,
      baseJson: JSON.stringify([{ id: "Rec1", title: "Original", completed: false }]),
      conflictSignature: null,
    });

    const rows = [{ id: "Rec1", title: "Slack title", completed: false }];
    const notices: string[] = [];
    const client = {
      slackLists: {
        access: { set: async () => ({ ok: true }) },
        items: {
          list: async () => ({
            ok: true,
            items: rows.map((row) => ({
              id: row.id,
              fields: [
                { key: "title", column_id: "ColTitle", text: row.title },
                { key: "todo_completed", column_id: "ColDone", checkbox: [row.completed] },
              ],
            })),
          }),
          create: async (args: any) => {
            const text = args.initial_fields[0].rich_text[0].elements[0].elements[0].text;
            const created = { id: `Rec${rows.length + 1}`, title: text, completed: false };
            rows.push(created);
            return { ok: true, item: { id: created.id } };
          },
          update: async (args: any) => {
            for (const cell of args.cells) {
              const row = rows.find((candidate) => candidate.id === cell.row_id)!;
              if (cell.rich_text) row.title = cell.rich_text[0].elements[0].elements[0].text;
              if (cell.checkbox !== undefined) row.completed = Array.isArray(cell.checkbox)
                ? Boolean(cell.checkbox[0])
                : Boolean(cell.checkbox);
            }
            return { ok: true };
          },
          delete: async (args: any) => {
            const index = rows.findIndex((row) => row.id === args.id);
            if (index >= 0) rows.splice(index, 1);
            return { ok: true };
          },
        },
      },
      chat: {
        postMessage: async (args: any) => {
          notices.push(args.text);
          return { ok: true, ts: "notice-1" };
        },
      },
    };
    let acknowledgementAttempts = 0;
    const manager = new TodoSyncManager(
      { identitySecret: "secret", identityOwnerId: "U_BOT" },
      {
        markConflictNoticeDelivered(slackChannelId, conflictSignature, slackMessageTs, ownerInstanceId) {
          acknowledgementAttempts += 1;
          if (acknowledgementAttempts === 1) throw new Error("sqlite busy after Slack ack");
          if (acknowledgementAttempts === 2) return false;
          return markTodoSyncConflictNoticeDelivered(
            slackChannelId,
            conflictSignature,
            slackMessageTs,
            ownerInstanceId,
          );
        },
        waitBeforeLocalRetry: async () => {},
      },
    );
    const channel = getChannel(channelId)!;

    await manager.reconcile({ client, channel, user: "U1" });
    expect(rows).toEqual([{ id: "Rec1", title: "File title", completed: false }]);
    expect(readFileSync(join(root, "notes", "TODOS.md"), "utf8")).toContain("File title <!-- Rec1 -->");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("file title won");
    expect(acknowledgementAttempts).toBe(3);

    await manager.reconcile({ client, channel, user: "U1" });
    expect(notices).toHaveLength(1);

    rows[0].title = "Edited in Slack";
    await manager.reconcile({ client, channel, user: "U1" });
    expect(readFileSync(join(root, "notes", "TODOS.md"), "utf8")).toContain("Edited in Slack <!-- Rec1 -->");
  });

  test("ignores historical capture rows once but keeps later prefix edits on bound todos", async () => {
    const root = mkdtempSync(join(tmpdir(), "concierge-todo-prefix-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, "notes"), { recursive: true });
    const path = join(root, "notes", "TODOS.md");
    writeFileSync(path, "# todos\n\n- [ ] Real todo <!-- Rec1 -->\n");
    const channelId = `C_TODO_PREFIX_${Date.now()}`;
    upsertChannel({
      slack_channel_id: channelId,
      slack_channel_name: "todo-prefix",
      group_name: null,
      name: "Todo prefix",
      vault_path: root,
      code_path: root,
    });
    updateChannelListState(channelId, {
      listId: "F_PREFIX",
      titleColumnId: "ColTitle",
      completedColumnId: "ColDone",
    });
    const rows = [
      { id: "RecLegacy", title: "[note] historical capture", completed: false },
      { id: "Rec1", title: "Real todo", completed: false },
    ];
    const client = {
      slackLists: {
        access: { set: async () => ({ ok: true }) },
        items: {
          list: async () => ({
            ok: true,
            items: rows.map((row) => ({
              id: row.id,
              fields: [
                { key: "title", column_id: "ColTitle", text: row.title },
                { key: "todo_completed", column_id: "ColDone", checkbox: [row.completed] },
              ],
            })),
          }),
          create: async () => { throw new Error("unexpected create"); },
          update: async () => ({ ok: true }),
          delete: async () => ({ ok: true }),
        },
      },
    };
    const manager = new TodoSyncManager({ identitySecret: "secret", identityOwnerId: "U_BOT" });
    const channel = getChannel(channelId)!;

    await manager.reconcile({ client, channel });
    expect(readFileSync(path, "utf8")).toContain("Real todo <!-- Rec1 -->");
    expect(readFileSync(path, "utf8")).not.toContain("historical capture");
    expect(JSON.parse(getTodoSyncState(channelId)!.ignored_slack_item_ids_json)).toEqual(["RecLegacy"]);

    rows[1].title = "[note] legitimate todo";
    await manager.reconcile({ client, channel });
    expect(readFileSync(path, "utf8")).toContain("[note] legitimate todo <!-- Rec1 -->");

    rows.splice(1, 1);
    await manager.reconcile({ client, channel });
    expect(readFileSync(path, "utf8")).not.toContain("Rec1");
    expect(rows).toEqual([{ id: "RecLegacy", title: "[note] historical capture", completed: false }]);
  });

  test("reruns from a fresh snapshot when the file changes during Slack projection", async () => {
    const root = mkdtempSync(join(tmpdir(), "concierge-todo-race-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, "notes"), { recursive: true });
    const path = join(root, "notes", "TODOS.md");
    writeFileSync(path, "# todos\n\n- [ ] File title <!-- Rec1 -->\n");
    const channelId = `C_TODO_RACE_${Date.now()}`;
    upsertChannel({
      slack_channel_id: channelId,
      slack_channel_name: "todo-race",
      group_name: null,
      name: "Todo race",
      vault_path: root,
      code_path: root,
    });
    updateChannelListState(channelId, {
      listId: "F_RACE",
      titleColumnId: "ColTitle",
      completedColumnId: "ColDone",
    });
    commitTodoSyncState({
      slackChannelId: channelId,
      baseJson: JSON.stringify([{ id: "Rec1", title: "Original", completed: false }]),
      conflictSignature: null,
    });

    const rows = [{ id: "Rec1", title: "Original", completed: false }];
    let releaseFirstUpdate!: () => void;
    let observeFirstUpdate!: () => void;
    const firstUpdateStarted = new Promise<void>((resolve) => { observeFirstUpdate = resolve; });
    const firstUpdateRelease = new Promise<void>((resolve) => { releaseFirstUpdate = resolve; });
    let updateCount = 0;
    const client = {
      slackLists: {
        access: { set: async () => ({ ok: true }) },
        items: {
          list: async () => ({
            ok: true,
            items: rows.map((row) => ({
              id: row.id,
              fields: [
                { key: "title", column_id: "ColTitle", text: row.title },
                { key: "todo_completed", column_id: "ColDone", checkbox: [row.completed] },
              ],
            })),
          }),
          create: async (args: any) => {
            const title = args.initial_fields[0].rich_text[0].elements[0].elements[0].text;
            const row = { id: `Rec${rows.length + 1}`, title, completed: false };
            rows.push(row);
            return { ok: true, item: { id: row.id } };
          },
          update: async (args: any) => {
            updateCount += 1;
            if (updateCount === 1) {
              observeFirstUpdate();
              await firstUpdateRelease;
            }
            for (const cell of args.cells) {
              const row = rows.find((candidate) => candidate.id === cell.row_id)!;
              if (cell.rich_text) row.title = cell.rich_text[0].elements[0].elements[0].text;
            }
            return { ok: true };
          },
          delete: async () => ({ ok: true }),
        },
      },
    };
    const manager = new TodoSyncManager({ identitySecret: "secret", identityOwnerId: "U_BOT" });
    const reconciliation = manager.reconcile({ client, channel: getChannel(channelId)! });
    await firstUpdateStarted;
    appendFileSync(path, "- [ ] Concurrent idea\n");
    releaseFirstUpdate();
    await reconciliation;

    expect(readFileSync(path, "utf8")).toContain("Concurrent idea <!-- Rec2 -->");
    expect(rows.map((row) => row.title)).toEqual(["File title", "Concurrent idea"]);
  });

  test("preserves a write arriving after the snapshot check and retains the already-projected conflict notice", async () => {
    const root = mkdtempSync(join(tmpdir(), "concierge-todo-replace-race-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, "notes"), { recursive: true });
    const path = join(root, "notes", "TODOS.md");
    writeFileSync(path, "# todos\n\n- [ ] File title <!-- Rec1 -->\n");
    const channelId = `C_TODO_REPLACE_RACE_${Date.now()}`;
    upsertChannel({
      slack_channel_id: channelId,
      slack_channel_name: "todo-replace-race",
      group_name: null,
      name: "Todo replace race",
      vault_path: root,
      code_path: root,
    });
    updateChannelListState(channelId, {
      listId: "F_REPLACE_RACE",
      titleColumnId: "ColTitle",
      completedColumnId: "ColDone",
    });
    commitTodoSyncState({
      slackChannelId: channelId,
      baseJson: JSON.stringify([{ id: "Rec1", title: "Original", completed: false }]),
      conflictSignature: null,
    });

    const rows = [{ id: "Rec1", title: "Slack title", completed: false }];
    const notices: string[] = [];
    const client = {
      slackLists: {
        access: { set: async () => ({ ok: true }) },
        items: {
          list: async () => ({
            ok: true,
            items: rows.map((row) => ({
              id: row.id,
              fields: [
                { key: "title", column_id: "ColTitle", text: row.title },
                { key: "todo_completed", column_id: "ColDone", checkbox: [row.completed] },
              ],
            })),
          }),
          create: async (args: any) => {
            const title = args.initial_fields[0].rich_text[0].elements[0].elements[0].text;
            const row = { id: `Rec${rows.length + 1}`, title, completed: false };
            rows.push(row);
            return { ok: true, item: { id: row.id } };
          },
          update: async (args: any) => {
            for (const cell of args.cells) {
              const row = rows.find((candidate) => candidate.id === cell.row_id)!;
              if (cell.rich_text) row.title = cell.rich_text[0].elements[0].elements[0].text;
            }
            return { ok: true };
          },
          delete: async () => ({ ok: true }),
        },
      },
      chat: {
        postMessage: async (args: any) => {
          notices.push(args.text);
          return { ok: true, ts: "unexpected-notice" };
        },
      },
    };
    let injectedConcurrentWrite = false;
    const manager = new TodoSyncManager(
      { identitySecret: "secret", identityOwnerId: "U_BOT" },
      {
        afterTodoFileSnapshotCheck(checkedPath) {
          if (injectedConcurrentWrite) return;
          injectedConcurrentWrite = true;
          appendFileSync(checkedPath, "- [ ] Arrived after compare\n");
        },
      },
    );

    await manager.reconcile({ client, channel: getChannel(channelId)!, user: "U1" });

    expect(readFileSync(path, "utf8")).toContain("Arrived after compare <!-- Rec2 -->");
    expect(rows.map((row) => row.title)).toEqual(["File title", "Arrived after compare"]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("file title won");
  });

  test("recovers deterministically after a crash immediately following the atomic file exchange", async () => {
    const root = mkdtempSync(join(tmpdir(), "concierge-todo-exchange-crash-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, "notes"), { recursive: true });
    const path = join(root, "notes", "TODOS.md");
    writeFileSync(path, "# todos\n\n- [ ] Survives crash\n");
    const channelId = `C_TODO_EXCHANGE_CRASH_${Date.now()}`;
    upsertChannel({
      slack_channel_id: channelId,
      slack_channel_name: "todo-exchange-crash",
      group_name: null,
      name: "Todo exchange crash",
      vault_path: root,
      code_path: root,
    });
    updateChannelListState(channelId, {
      listId: "F_EXCHANGE_CRASH",
      titleColumnId: "ColTitle",
      completedColumnId: "ColDone",
    });
    const rows = [{ id: "Rec1", title: "Survives crash", completed: false }];
    const client = {
      slackLists: {
        access: { set: async () => ({ ok: true }) },
        items: {
          list: async () => ({
            ok: true,
            items: rows.map((row) => ({
              id: row.id,
              fields: [
                { key: "title", column_id: "ColTitle", text: row.title },
                { key: "todo_completed", column_id: "ColDone", checkbox: [row.completed] },
              ],
            })),
          }),
          create: async () => { throw new Error("duplicate creation"); },
          update: async () => ({ ok: true }),
          delete: async () => ({ ok: true }),
        },
      },
    };
    let crashed = false;
    const crashingManager = new TodoSyncManager(
      { identitySecret: "secret", identityOwnerId: "U_BOT" },
      {
        afterTodoFileExchange() {
          if (crashed) return;
          crashed = true;
          throw new Error("simulated process crash after exchange");
        },
      },
    );

    await expect(crashingManager.reconcile({ client, channel: getChannel(channelId)! }))
      .rejects.toThrow("simulated process crash");
    expect(existsSync(`${path}.concierge-exchange`)).toBeTrue();
    expect(existsSync(`${path}.concierge-exchange.json`)).toBeTrue();

    await new TodoSyncManager({ identitySecret: "secret", identityOwnerId: "U_BOT" })
      .reconcile({ client, channel: getChannel(channelId)! });
    expect(readFileSync(path, "utf8")).toContain("Survives crash <!-- Rec1 -->");
    expect(existsSync(`${path}.concierge-exchange`)).toBeFalse();
    expect(existsSync(`${path}.concierge-exchange.json`)).toBeFalse();
  });

  test("leaves the canonical file and merge base untouched when Slack reads are unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "concierge-todo-fail-closed-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, "notes"), { recursive: true });
    const path = join(root, "notes", "TODOS.md");
    const originalFile = "# todos\n\n- [ ] Preserve me <!-- Rec1 -->\n";
    const originalBase = JSON.stringify([{ id: "Rec1", title: "Preserve me", completed: false }]);
    writeFileSync(path, originalFile);
    const channelId = `C_TODO_FAIL_${Date.now()}`;
    upsertChannel({
      slack_channel_id: channelId,
      slack_channel_name: "todo-fail-closed",
      group_name: null,
      name: "Todo fail closed",
      vault_path: root,
      code_path: root,
    });
    updateChannelListState(channelId, {
      listId: "F_FAIL",
      titleColumnId: "ColTitle",
      completedColumnId: "ColDone",
    });
    commitTodoSyncState({ slackChannelId: channelId, baseJson: originalBase, conflictSignature: null });
    const channel = getChannel(channelId)!;

    for (const failure of [
      { data: { error: "missing_scope", needed: "lists:read" } },
      { data: { error: "paid_feature_required" } },
      null,
    ]) {
      const client = {
        slackLists: {
          access: { set: async () => ({ ok: true }) },
          items: {
            list: async () => {
              if (failure) throw failure;
              return { ok: true };
            },
          },
        },
      };
      await expect(new TodoSyncManager({ identitySecret: "secret", identityOwnerId: "U_BOT" })
        .reconcile({ client, channel })).rejects.toBeTruthy();
      expect(readFileSync(path, "utf8")).toBe(originalFile);
      expect(getTodoSyncState(channelId)?.base_json).toBe(originalBase);
    }
  });

  test("refuses synchronization before Slack side effects while a legacy root TODO file remains", async () => {
    const root = mkdtempSync(join(tmpdir(), "concierge-todo-legacy-"));
    temporaryDirectories.push(root);
    writeFileSync(join(root, "TODOS.md"), "# legacy\n\n- [ ] Preserve legacy\n");
    const channelId = `C_TODO_LEGACY_${Date.now()}`;
    upsertChannel({
      slack_channel_id: channelId,
      slack_channel_name: "todo-legacy",
      group_name: null,
      name: "Todo legacy",
      vault_path: root,
      code_path: root,
    });
    let slackCalls = 0;
    const client = {
      files: { list: async () => { slackCalls += 1; return { ok: true, files: [] }; } },
    };

    await expect(new TodoSyncManager({ identitySecret: "secret", identityOwnerId: "U_BOT" })
      .reconcile({ client, channel: getChannel(channelId)! })).rejects.toThrow("requires scaffold migration");
    expect(slackCalls).toBe(0);
    expect(readFileSync(join(root, "TODOS.md"), "utf8")).toContain("Preserve legacy");
    expect(getTodoSyncState(channelId)).toBeNull();
  });
});
