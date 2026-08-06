import { describe, expect, test } from "bun:test";
import { claudeCodeArgs, parseClaudeCodeOutput } from "../src/claude-code";
import { providerFromText } from "../src/providers";

describe("parseClaudeCodeOutput", () => {
  test("extracts session id and assistant text from stream-json", () => {
    const output = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "c0f2ec4e-5099-4dd2-9960-03b102478f80" }),
      JSON.stringify({
        type: "assistant",
        session_id: "c0f2ec4e-5099-4dd2-9960-03b102478f80",
        message: { content: [{ type: "text", text: "PONG" }] },
      }),
      JSON.stringify({ type: "result", session_id: "c0f2ec4e-5099-4dd2-9960-03b102478f80", result: "PONG" }),
    ].join("\n");

    expect(parseClaudeCodeOutput(output)).toEqual({
      text: "PONG",
      sessionUUID: "c0f2ec4e-5099-4dd2-9960-03b102478f80",
      toolsUsed: [],
      isError: false,
    });
  });

  test("counts tool_use blocks and skips tool results from assistant text", () => {
    const output = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "6d462b18-6b96-4595-91c1-d9c3d2abecda" }),
      JSON.stringify({
        type: "assistant",
        session_id: "6d462b18-6b96-4595-91c1-d9c3d2abecda",
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "echo TOOL_SAMPLE" } }] },
      }),
      JSON.stringify({
        type: "user",
        session_id: "6d462b18-6b96-4595-91c1-d9c3d2abecda",
        message: { content: [{ type: "tool_result", content: "TOOL_SAMPLE" }] },
      }),
      JSON.stringify({
        type: "assistant",
        session_id: "6d462b18-6b96-4595-91c1-d9c3d2abecda",
        message: { content: [{ type: "text", text: "DONE" }] },
      }),
    ].join("\n");

    const parsed = parseClaudeCodeOutput(output);
    expect(parsed.text).toBe("DONE");
    expect(parsed.toolsUsed).toEqual(["Bash"]);
  });

  test("parses json output arrays and marks auth errors", () => {
    const output = JSON.stringify([
      { type: "system", subtype: "init", session_id: "97b01eb0-6c4e-4f14-a46e-c37be11fbd9f" },
      {
        type: "assistant",
        session_id: "97b01eb0-6c4e-4f14-a46e-c37be11fbd9f",
        message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] },
        error: "authentication_failed",
      },
      {
        type: "result",
        session_id: "97b01eb0-6c4e-4f14-a46e-c37be11fbd9f",
        is_error: true,
        result: "Not logged in · Please run /login",
      },
    ]);

    const parsed = parseClaudeCodeOutput(output);
    expect(parsed.text).toBe("Not logged in · Please run /login");
    expect(parsed.sessionUUID).toBe("97b01eb0-6c4e-4f14-a46e-c37be11fbd9f");
    expect(parsed.isError).toBe(true);
  });

  test("falls back to plain text when stream-json is unavailable", () => {
    expect(parseClaudeCodeOutput("PONG\n", "existing-session")).toEqual({
      text: "PONG",
      sessionUUID: "existing-session",
      toolsUsed: [],
      isError: false,
    });
  });
});

describe("claudeCodeArgs", () => {
  test("places variadic add-dir flags after the prompt", () => {
    expect(claudeCodeArgs({
      prompt: "hello",
      additionalDirs: ["/tmp/one", "/tmp/two"],
      sessionUUID: "c0f2ec4e-5099-4dd2-9960-03b102478f80",
    })).toEqual([
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--resume",
      "c0f2ec4e-5099-4dd2-9960-03b102478f80",
      "hello",
      "--add-dir",
      "/tmp/one",
      "--add-dir",
      "/tmp/two",
    ]);
  });

  test("adds fork-session for Claude fork transport", () => {
    expect(claudeCodeArgs({
      prompt: "fork",
      additionalDirs: [],
      sessionUUID: "c0f2ec4e-5099-4dd2-9960-03b102478f80",
      forkSession: true,
    })).toContain("--fork-session");
  });
});

describe("providerFromText", () => {
  test("selects claude-code only for top-level selector mentions", () => {
    expect(providerFromText("@claude-code do it", "codex", { topLevel: true })).toBe("claude-code");
    expect(providerFromText("@claude-code do it", "codex", { topLevel: false })).toBe("codex");
  });

  test("selects configured distinct claude bot user id", () => {
    expect(providerFromText("<@UCLAUDE> do it", "codex", {
      topLevel: true,
      claudeCodeBotUserId: "UCLAUDE",
    })).toBe("claude-code");
  });
});
