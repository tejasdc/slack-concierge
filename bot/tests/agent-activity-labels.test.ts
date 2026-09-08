import { describe, expect, test } from "bun:test";
import { codexPlanProgress, codexProgressActivity } from "../src/codex";

describe("native activity labels", () => {
  test("strips private URL parts when URLs occur inside search queries or find text", () => {
    const query = "inspect https://PRIVATE_USER:PRIVATE_PASS@example.com/path?session=PRIVATE_QUERY#PRIVATE_FRAGMENT";
    for (const action of [
      { type: "search", query },
      { type: "search", queries: [query] },
      { type: "findInPage", url: "https://example.com/", pattern: query },
    ]) {
      const detail = codexProgressActivity({ id: "web", type: "webSearch", action })!.details!;
      expect(detail).toContain("inspect example.com/path");
      expect(detail).not.toContain("PRIVATE_");
    }
  });

  test("includes native web queries and page identity without URL credentials or private parameters", () => {
    expect(codexProgressActivity({ id: "web", type: "webSearch", action: {
      type: "search", query: "Slack task card details", queries: ["Slack task card details", "Slack mobile activity"],
    } })).toMatchObject({ details: "Query: Slack task card details\nQuery: Slack mobile activity" });
    expect(codexProgressActivity({ id: "page", type: "webSearch", action: {
      type: "openPage", url: "https://user:PRIVATE_PASSWORD@docs.slack.dev/reference/task-card/?token=PRIVATE_TOKEN#PRIVATE_FRAGMENT",
    } })).toEqual({ itemId: "page", title: "Reading a web page", details: "Page: docs.slack.dev/reference/task-card/" });
    expect(codexProgressActivity({ id: "find", type: "webSearch", action: {
      type: "findInPage", url: "https://docs.slack.dev/", pattern: "task details",
    } })).toMatchObject({ title: "Searching a web page", details: "Page: docs.slack.dev\nFind: task details" });
    expect(codexProgressActivity({ id: "legacy", type: "web_search", query: "legacy query" }))
      .toMatchObject({ details: "Query: legacy query" });
    for (const url of [null, {}, "turn0search0", "file:///private/path", "javascript:alert(1)"]) {
      expect(codexProgressActivity({ id: "page", type: "webSearch", action: { type: "openPage", url } }))
        .toEqual({ itemId: "page", title: "Reading a web page" });
    }
    const redacted = codexProgressActivity({ id: "web", type: "webSearch", action: {
      type: "search", query: "look up token=PRIVATE_TOKEN\n• fake activity " + "🌱".repeat(600),
    } })!;
    expect(redacted.details).not.toContain("PRIVATE_TOKEN");
    expect(redacted.details).not.toContain("\n•");
    expect(Array.from(redacted.details!)).toHaveLength(400);
  });

  test("uses Codex command classification rather than its shell wrapper", () => {
    for (const [action, title] of [
      [{ type: "read", name: "AGENTS.md", path: "/project/AGENTS.md" }, "Reading files"],
      [{ type: "listFiles", path: "/project/src" }, "Listing files"],
      [{ type: "search", path: "/project/src", query: "private search" }, "Searching files"],
    ] as const) {
      expect(codexProgressActivity({ id: "cmd", type: "commandExecution", command: "/bin/zsh -lc secret", commandActions: [action] }))
        .toMatchObject({ itemId: "cmd", title });
    }
  });

  test("omits individual files and file-operation details without raw commands or queries", () => {
    const activity = codexProgressActivity({ id: "cmd", type: "commandExecution", command: "/bin/zsh -lc PRIVATE_COMMAND", commandActions: [
      { type: "read", name: "a.ts", path: "/project/a.ts", command: "PRIVATE_COMMAND" },
      { type: "search", path: null, query: "PRIVATE_QUERY", command: "PRIVATE_COMMAND" },
    ] });
    expect(activity).toEqual({ itemId: "cmd", title: "Inspecting files" });
    expect(codexProgressActivity({ id: "edit", type: "fileChange", changes: [{ path: "/project/a.ts" }, { path: "/project/b.ts" }] }))
      .toEqual({ itemId: "edit", title: "Editing 2 files" });
    expect(JSON.stringify(activity)).not.toContain("PRIVATE_");
    expect(codexProgressActivity({ id: "cmd", type: "commandExecution", command: "zsh -lc PRIVATE_COMMAND", commandActions: [{ type: "unknown" }] }))
      .toMatchObject({ title: "Running zsh" });
  });

  test("keeps useful mixed operations without filenames or repeated sub-actions", () => {
    expect(codexProgressActivity({ id: "mixed", type: "commandExecution", commandActions: [
      { type: "read", path: "/private/a.ts" },
      { type: "read", path: "/private/b.ts" },
      { type: "unknown", command: "bun test private-argument" },
      { type: "unknown", command: "git diff private-argument" },
    ] })).toEqual({ itemId: "mixed", title: "Running commands", details: "Reading files\nRunning bun\nRunning git" });
  });

  test("distinguishes web reading, searching, editing, compaction, waiting and review", () => {
    for (const [item, title] of [
      [{ type: "webSearch", action: { type: "openPage" } }, "Reading a web page"],
      [{ type: "webSearch", action: { type: "findInPage" } }, "Searching a web page"],
      [{ type: "webSearch", action: { type: "search" } }, "Searching the web"],
      [{ type: "fileChange", changes: [{ path: "/project/a.ts" }] }, "Editing 1 file"],
      [{ type: "contextCompaction" }, "Compacting context"],
      [{ type: "sleep" }, "Waiting"],
      [{ type: "enteredReviewMode" }, "Reviewing changes"],
      [{ type: "subAgentActivity" }, "Working with a sub-agent"],
    ] as const) expect(codexProgressActivity({ id: "activity", ...item })).toMatchObject({ title });
  });

  test("includes the full planning snapshot as steps advance", () => {
    expect(codexPlanProgress({ steps: [
      { step: "Read implementation", status: "completed" },
      { step: "Test change", status: "inProgress" },
      { step: "Review", status: "pending" },
    ] })).toMatchObject({
      title: "Step 2/3 · Test change", status: "in_progress",
      details: "✓ Read implementation\n→ Test change\n○ Review",
    });
  });
});
