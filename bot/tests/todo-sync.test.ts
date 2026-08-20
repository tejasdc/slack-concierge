import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitTodoSyncState,
  getChannel,
  getTodoSyncState,
  updateChannelListState,
  upsertChannel,
} from "../src/state";
import {
  parseTodosMarkdown,
  projectTodoRows,
  renderTodosMarkdown,
  TodoProjectionManager,
  type TodoRow,
} from "../src/todo-sync";
import { TodoFileWatcher } from "../src/todo-file-watcher";
import { resetSlackListBucketsForTests, slackBucket } from "../src/rate-limit";

const temporaryDirectories: string[] = [];

beforeEach(() => {
  slackBucket.reset();
  resetSlackListBucketsForTests();
});

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function projectableChannel(name: string, markdown: string) {
  const root = mkdtempSync(join(tmpdir(), `concierge-${name}-`));
  temporaryDirectories.push(root);
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "notes", "TODOS.md"), markdown);
  const channelId = `C_${name}_${Date.now()}_${Math.random()}`;
  upsertChannel({
    slack_channel_id: channelId,
    slack_channel_name: name,
    group_name: null,
    name,
    vault_path: root,
    code_path: root,
  });
  updateChannelListState(channelId, {
    listId: `F_${name}`,
    titleColumnId: "ColTitle",
    completedColumnId: "ColDone",
    accessLevel: "read",
  });
  return { root, channelId, channel: getChannel(channelId)! };
}

function listClient(rows: TodoRow[], counters = { reads: 0, creates: 0, updates: 0, deletes: 0 }) {
  return {
    counters,
    client: {
      slackLists: {
        access: { set: async () => ({ ok: true }) },
        items: {
          list: async () => {
            counters.reads += 1;
            return {
              ok: true,
              items: rows.map((row) => ({
                id: row.id,
                fields: [
                  { key: "title", column_id: "ColTitle", text: row.title },
                  { key: "todo_completed", column_id: "ColDone", checkbox: [row.completed] },
                ],
              })),
            };
          },
          create: async (args: any) => {
            counters.creates += 1;
            const title = args.initial_fields[0].rich_text[0].elements[0].elements[0].text;
            const row = { id: `Rec${rows.length + 1}`, title, completed: false };
            rows.push(row);
            return { ok: true, item: { id: row.id } };
          },
          update: async (args: any) => {
            counters.updates += 1;
            for (const cell of args.cells) {
              const row = rows.find((candidate) => candidate.id === cell.row_id)!;
              if (cell.rich_text) row.title = cell.rich_text[0].elements[0].elements[0].text;
              if (cell.checkbox !== undefined) row.completed = Boolean(cell.checkbox[0]);
            }
            return { ok: true };
          },
          delete: async (args: any) => {
            counters.deletes += 1;
            const index = rows.findIndex((row) => row.id === args.id);
            if (index >= 0) rows.splice(index, 1);
            return { ok: true };
          },
        },
      },
    },
  };
}

describe("canonical TODO file projection", () => {
  test("parses indented continuation paragraphs as one task and ignores nested tasks", () => {
    expect(parseTodosMarkdown([
      "# todos",
      "- [ ] First <!-- RecOne -->",
      "  continued on the same paragraph",
      "",
      "  Second paragraph",
      "  - [ ] Nested",
      "> - [ ] Quoted",
      "```md",
      "- [ ] Code",
      "```",
      "- [x] Second <!-- concierge-capture-v1:abc -->",
    ].join("\n"))).toEqual([
      {
        id: "RecOne",
        title: "First continued on the same paragraph\n\nSecond paragraph",
        completed: false,
      },
      { id: "local:0", title: "Second", completed: true },
    ]);
  });

  test("rewrites multi-paragraph task rows while preserving unowned Markdown and line endings", () => {
    const markdown = [
      "# Working notes",
      "",
      "Keep this prose exactly.",
      "- [ ] Old title <!-- RecOne -->",
      "",
      "  Old second paragraph.",
      "  - [ ] Nested task remains unowned.",
      "",
    ].join("\r\n");
    const rendered = renderTodosMarkdown({ slack_channel_name: "unused" } as any, [
      { id: "RecOne", title: "New title\n\nNew second paragraph.", completed: true },
      { id: "RecTwo", title: "New task", completed: false },
    ], markdown);

    expect(rendered).toContain("Keep this prose exactly.\r\n- [x] New title <!-- RecOne -->");
    expect(rendered).toContain("<!-- RecOne -->\r\n\r\n  New second paragraph.");
    expect(rendered).toContain("  - [ ] Nested task remains unowned.");
    expect(rendered).toEndWith("- [ ] New task <!-- RecTwo -->\r\n");
    expect(rendered.replaceAll("\r\n", "")).not.toContain("\n");
  });

  test("preserves capture idempotency while binding a Slack row ID", () => {
    const captureMarker = "<!-- concierge-capture-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->";
    const markdown = `# todos\n\n- [ ] Captured once ${captureMarker}\n`;
    const rendered = renderTodosMarkdown({ slack_channel_name: "unused" } as any, [
      { id: "RecBound", title: "Captured once", completed: false },
    ], markdown);

    expect(rendered).toContain(`Captured once ${captureMarker} <!-- RecBound -->`);
    expect(parseTodosMarkdown(rendered)).toEqual([
      { id: "RecBound", title: "Captured once", completed: false },
    ]);
  });

  test("treats the file as the whole desired List state", () => {
    expect(projectTodoRows(
      [{ id: "Rec1", title: "File value", completed: true }],
      [
        { id: "Rec1", title: "Slack edit", completed: false },
        { id: "Rec2", title: "Slack-only row", completed: false },
      ],
    )).toEqual({
      rows: [{ id: "Rec1", title: "File value", completed: true }],
      deleteSlackIds: ["Rec2"],
    });
  });

  test("projects file edits outward and never imports later Slack edits", async () => {
    const { root, channelId, channel } = projectableChannel(
      "file-wins",
      "# todos\n\n- [x] File value <!-- Rec1 -->\n",
    );
    commitTodoSyncState({
      slackChannelId: channelId,
      baseJson: JSON.stringify([{ id: "Rec1", title: "Old value", completed: false }]),
      conflictSignature: null,
    });
    const rows = [
      { id: "Rec1", title: "Slack edit", completed: false },
      { id: "Rec2", title: "Slack-only row", completed: false },
    ];
    const { client, counters } = listClient(rows);
    const manager = new TodoProjectionManager({ identitySecret: "secret", identityOwnerId: "U_BOT" });

    await manager.reconcile({ client, channel });
    expect(rows).toEqual([{ id: "Rec1", title: "File value", completed: true }]);
    expect(counters).toEqual({ reads: 1, creates: 0, updates: 1, deletes: 1 });

    rows[0].title = "Another Slack edit";
    await manager.reconcile({ client, channel: getChannel(channelId)! });
    expect(counters.reads).toBe(1);
    expect(readFileSync(join(root, "notes", "TODOS.md"), "utf8")).toContain("File value <!-- Rec1 -->");
  });

  test("binds a new file task to its created Slack row and records the projection", async () => {
    const { root, channelId, channel } = projectableChannel("new-row", "# todos\n\n- [x] New task\n");
    const rows: TodoRow[] = [];
    const { client, counters } = listClient(rows);

    await new TodoProjectionManager({ identitySecret: "secret", identityOwnerId: "U_BOT" })
      .reconcile({ client, channel });

    expect(rows).toEqual([{ id: "Rec1", title: "New task", completed: true }]);
    expect(counters.creates).toBe(1);
    expect(readFileSync(join(root, "notes", "TODOS.md"), "utf8")).toContain("New task <!-- Rec1 -->");
    expect(JSON.parse(getTodoSyncState(channelId)!.base_json)).toEqual(rows);
  });

  test("recovers a remotely-created row whose ID was not bound before interruption", async () => {
    const { root, channel } = projectableChannel("new-row-recovery", "# todos\n\n- [x] Already created\n");
    const rows = [{ id: "RecExisting", title: "Already created", completed: false }];
    const { client, counters } = listClient(rows);

    await new TodoProjectionManager({ identitySecret: "secret", identityOwnerId: "U_BOT" })
      .reconcile({ client, channel });

    expect(counters.creates).toBe(0);
    expect(rows).toEqual([{ id: "RecExisting", title: "Already created", completed: true }]);
    expect(readFileSync(join(root, "notes", "TODOS.md"), "utf8"))
      .toContain("Already created <!-- RecExisting -->");
  });

  test("startup scan performs no Slack call when the projected file is unchanged", async () => {
    const { channelId, channel } = projectableChannel(
      "unchanged",
      "# todos\n\n- [ ] Stable <!-- Rec1 -->\n",
    );
    commitTodoSyncState({
      slackChannelId: channelId,
      baseJson: JSON.stringify([{ id: "Rec1", title: "Stable", completed: false }]),
      conflictSignature: null,
    });
    const client = new Proxy({}, {
      get() { throw new Error("unchanged startup projection touched Slack"); },
    });

    await new TodoProjectionManager({ identitySecret: "secret", identityOwnerId: "U_BOT" })
      .reconcile({ client, channel });
  });

  test("coalesces repeated schedules and watches atomic file changes", async () => {
    const { root, channel } = projectableChannel("watcher", "# todos\n");
    const calls: string[] = [];
    const watcher = new TodoFileWatcher(async (_channel, reason) => {
      calls.push(reason);
    }, 20);
    watcher.watchChannel(channel);

    watcher.schedule(channel, "capture");
    watcher.schedule(channel, "capture");
    const replacement = join(root, "notes", "TODOS.md.next");
    writeFileSync(replacement, "# todos\n- [ ] Watched\n");
    renameSync(replacement, join(root, "notes", "TODOS.md"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    watcher.close();

    expect(calls).toHaveLength(1);
  });

  test("retries a failed background projection without another file edit", async () => {
    const { channel } = projectableChannel("watcher-retry", "# todos\n");
    let attempts = 0;
    const watcher = new TodoFileWatcher(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary projection failure");
    }, 5, 10);

    watcher.schedule(channel, "capture");
    await new Promise((resolve) => setTimeout(resolve, 60));
    watcher.close();

    expect(attempts).toBe(2);
  });

  test("reruns from a fresh snapshot when the file changes during Slack projection", async () => {
    const { root, channelId, channel } = projectableChannel(
      "projection-race",
      "# todos\n\n- [ ] File title <!-- Rec1 -->\n",
    );
    commitTodoSyncState({
      slackChannelId: channelId,
      baseJson: JSON.stringify([{ id: "Rec1", title: "Original", completed: false }]),
      conflictSignature: null,
    });
    const rows = [{ id: "Rec1", title: "Original", completed: false }];
    const { client } = listClient(rows);
    const originalUpdate = client.slackLists.items.update;
    let releaseFirstUpdate!: () => void;
    let observeFirstUpdate!: () => void;
    const firstUpdateStarted = new Promise<void>((resolve) => { observeFirstUpdate = resolve; });
    const firstUpdateRelease = new Promise<void>((resolve) => { releaseFirstUpdate = resolve; });
    let updateCount = 0;
    client.slackLists.items.update = async (args: any) => {
      updateCount += 1;
      if (updateCount === 1) {
        observeFirstUpdate();
        await firstUpdateRelease;
      }
      return await originalUpdate(args);
    };
    const manager = new TodoProjectionManager({ identitySecret: "secret", identityOwnerId: "U_BOT" });
    const path = join(root, "notes", "TODOS.md");

    const projection = manager.reconcile({ client, channel });
    await firstUpdateStarted;
    appendFileSync(path, "- [ ] Concurrent idea\n");
    releaseFirstUpdate();
    await projection;

    expect(readFileSync(path, "utf8")).toContain("Concurrent idea <!-- Rec2 -->");
    expect(rows.map((row) => row.title)).toEqual(["File title", "Concurrent idea"]);
  });

  test("preserves a write arriving after the snapshot check", async () => {
    const { root, channelId, channel } = projectableChannel(
      "exchange-race",
      "# todos\n\n- [ ] File title <!-- Rec1 -->\n",
    );
    commitTodoSyncState({
      slackChannelId: channelId,
      baseJson: JSON.stringify([{ id: "Rec1", title: "Original", completed: false }]),
      conflictSignature: null,
    });
    const rows = [{ id: "Rec1", title: "Original", completed: false }];
    const { client } = listClient(rows);
    const path = join(root, "notes", "TODOS.md");
    let injectedWrite = false;
    const manager = new TodoProjectionManager(
      { identitySecret: "secret", identityOwnerId: "U_BOT" },
      {
        afterTodoFileSnapshotCheck(checkedPath) {
          if (injectedWrite) return;
          injectedWrite = true;
          appendFileSync(checkedPath, "- [ ] Arrived after compare\n");
        },
      },
    );

    await manager.reconcile({ client, channel });

    expect(readFileSync(path, "utf8")).toContain("Arrived after compare <!-- Rec2 -->");
    expect(rows.map((row) => row.title)).toEqual(["File title", "Arrived after compare"]);
  });

  test("recovers deterministically after a crash immediately following atomic exchange", async () => {
    const { root, channel } = projectableChannel("exchange-crash", "# todos\n\n- [ ] Survives crash\n");
    const rows = [{ id: "Rec1", title: "Survives crash", completed: false }];
    const { client, counters } = listClient(rows);
    const path = join(root, "notes", "TODOS.md");
    let crashed = false;
    const crashingManager = new TodoProjectionManager(
      { identitySecret: "secret", identityOwnerId: "U_BOT" },
      {
        afterTodoFileExchange() {
          if (crashed) return;
          crashed = true;
          throw new Error("simulated process crash after exchange");
        },
      },
    );

    await expect(crashingManager.reconcile({ client, channel }))
      .rejects.toThrow("simulated process crash");
    expect(existsSync(`${path}.concierge-exchange`)).toBeTrue();
    expect(existsSync(`${path}.concierge-exchange.json`)).toBeTrue();

    await new TodoProjectionManager({ identitySecret: "secret", identityOwnerId: "U_BOT" })
      .reconcile({ client, channel: getChannel(channel.slack_channel_id)! });
    expect(counters.creates).toBe(0);
    expect(readFileSync(path, "utf8")).toContain("Survives crash <!-- Rec1 -->");
    expect(existsSync(`${path}.concierge-exchange`)).toBeFalse();
    expect(existsSync(`${path}.concierge-exchange.json`)).toBeFalse();
  });

  test("leaves the canonical file and projection base untouched when Slack reads fail", async () => {
    const originalFile = "# todos\n\n- [ ] Preserve me <!-- Rec1 -->\n- [ ] Changed locally\n";
    const { root, channelId, channel } = projectableChannel("fail-closed", originalFile);
    const originalBase = JSON.stringify([{ id: "Rec1", title: "Preserve me", completed: false }]);
    commitTodoSyncState({ slackChannelId: channelId, baseJson: originalBase, conflictSignature: null });
    const client = {
      slackLists: {
        items: { list: async () => { throw new Error("Slack unavailable"); } },
      },
    };

    await expect(new TodoProjectionManager({ identitySecret: "secret", identityOwnerId: "U_BOT" })
      .reconcile({ client, channel })).rejects.toThrow("Slack unavailable");
    expect(readFileSync(join(root, "notes", "TODOS.md"), "utf8")).toBe(originalFile);
    expect(getTodoSyncState(channelId)?.base_json).toBe(originalBase);
  });

  test("refuses projection before Slack side effects while a legacy root TODO file remains", async () => {
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
    const client = { files: { list: async () => { slackCalls += 1; return { ok: true, files: [] }; } } };

    await expect(new TodoProjectionManager({ identitySecret: "secret", identityOwnerId: "U_BOT" })
      .reconcile({ client, channel: getChannel(channelId)! })).rejects.toThrow("requires scaffold migration");
    expect(slackCalls).toBe(0);
    expect(getTodoSyncState(channelId)).toBeNull();
  });
});
