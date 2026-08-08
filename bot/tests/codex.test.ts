import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexExecArgs, runCodexTurn } from "../src/codex";

describe("codexExecArgs", () => {
  test("passes add-dir flags to fresh exec sessions", () => {
    expect(codexExecArgs({
      prompt: "hello",
      cwd: "/workspace/project",
      additionalDirs: ["/tmp/one", "/tmp/two"],
      sessionUUID: null,
    })).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "--add-dir",
      "/tmp/one",
      "--add-dir",
      "/tmp/two",
      "-C",
      "/workspace/project",
      "hello",
    ]);
  });

  test("omits unsupported workspace flags when resuming a session", () => {
    expect(codexExecArgs({
      prompt: "continue",
      cwd: "/workspace/project",
      additionalDirs: ["/tmp/one"],
      sessionUUID: "019fde0c-d3e9-79f0-ac77-8cdab34a1be1",
    })).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "019fde0c-d3e9-79f0-ac77-8cdab34a1be1",
      "continue",
    ]);
  });

  test("keeps the existing session id when a resumed turn emits no new thread id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const oldPath = process.env.PATH || "";
    const fakeCodex = join(dir, "codex");
    writeFileSync(fakeCodex, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"type\":\"turn.started\"}'",
      "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"PONG\"}}'",
      "printf '%s\\n' '{\"type\":\"turn.completed\"}'",
    ].join("\n"));
    chmodSync(fakeCodex, 0o755);

    try {
      process.env.PATH = `${dir}:${oldPath}`;
      const result = await runCodexTurn({
        prompt: "continue",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: "019fde0c-d3e9-79f0-ac77-8cdab34a1be1",
      });

      expect(result).toEqual({
        text: "PONG",
        sessionUUID: "019fde0c-d3e9-79f0-ac77-8cdab34a1be1",
        toolsUsed: [],
      });
    } finally {
      process.env.PATH = oldPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses a new thread id when Codex emits one during a resumed turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const oldPath = process.env.PATH || "";
    const fakeCodex = join(dir, "codex");
    writeFileSync(fakeCodex, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"019fde26-53ca-7e51-9aa6-3a8c1fe0762c\"}'",
      "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"PONG\"}}'",
      "printf '%s\\n' '{\"type\":\"turn.completed\"}'",
    ].join("\n"));
    chmodSync(fakeCodex, 0o755);

    try {
      process.env.PATH = `${dir}:${oldPath}`;
      const result = await runCodexTurn({
        prompt: "continue",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: "019fde0c-d3e9-79f0-ac77-8cdab34a1be1",
      });

      expect(result.sessionUUID).toBe("019fde26-53ca-7e51-9aa6-3a8c1fe0762c");
    } finally {
      process.env.PATH = oldPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports every supported Codex tool item once as live progress", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const oldPath = process.env.PATH || "";
    const fakeCodex = join(dir, "codex");
    writeFileSync(fakeCodex, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"type\":\"turn.started\"}'",
      "printf '%s\\n' '{\"type\":\"item.started\",\"item\":{\"id\":\"cmd-1\",\"type\":\"command_execution\",\"command\":\"/bin/pwd\"}}'",
      "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"id\":\"cmd-1\",\"type\":\"command_execution\",\"command\":\"/bin/pwd\"}}'",
      "printf '%s\\n' '{\"type\":\"item.started\",\"item\":{\"id\":\"mcp-1\",\"type\":\"mcp_tool_call\",\"tool\":\"search\"}}'",
      "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"id\":\"mcp-1\",\"type\":\"mcp_tool_call\",\"tool\":\"search\"}}'",
      "printf '%s\\n' '{\"type\":\"item.started\",\"item\":{\"id\":\"collab-1\",\"type\":\"collab_tool_call\",\"tool\":\"wait\"}}'",
      "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"id\":\"collab-1\",\"type\":\"collab_tool_call\",\"tool\":\"wait\"}}'",
      "printf '%s\\n' '{\"type\":\"item.started\",\"item\":{\"id\":\"web-1\",\"type\":\"web_search\"}}'",
      "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"id\":\"web-1\",\"type\":\"web_search\"}}'",
      "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"id\":\"file-1\",\"type\":\"file_change\"}}'",
      "printf '%s\\n' '{\"type\":\"item.started\",\"item\":{\"id\":\"dynamic-1\",\"type\":\"dynamic_tool_call\",\"name\":\"exec\"}}'",
      "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"id\":\"dynamic-1\",\"type\":\"dynamic_tool_call\",\"name\":\"exec\"}}'",
      "printf '%s\\n' '{\"type\":\"item.started\",\"item\":{\"id\":\"reason-1\",\"type\":\"reasoning\"}}'",
      "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"id\":\"reason-1\",\"type\":\"reasoning\"}}'",
      "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"id\":\"todo-1\",\"type\":\"todo_list\"}}'",
      "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"id\":\"error-1\",\"type\":\"error\"}}'",
      "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"PONG\"}}'",
      "printf '%s\\n' '{\"type\":\"turn.completed\"}'",
    ].join("\n"));
    chmodSync(fakeCodex, 0o755);
    const progress: string[] = [];

    try {
      process.env.PATH = `${dir}:${oldPath}`;
      const result = await runCodexTurn({
        prompt: "continue",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: "019fde0c-d3e9-79f0-ac77-8cdab34a1be1",
        onProgress: (event) => {
          if (event.type === "tool_use") progress.push(event.toolName || "unknown");
        },
      });

      expect(progress).toEqual(["/bin/pwd", "search", "wait", "web_search", "file_change", "exec"]);
      expect(result.toolsUsed).toEqual(["/bin/pwd", "search", "wait", "web_search", "file_change", "exec"]);
    } finally {
      process.env.PATH = oldPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
