import { describe, expect, test } from "bun:test";
import { codexPlanProgress, codexProgressActivity } from "../src/codex";

describe("native activity labels", () => {
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
