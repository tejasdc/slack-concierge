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
});
