import { describe, expect, test } from "bun:test";
import { codexExecArgs } from "../src/codex";

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
});
