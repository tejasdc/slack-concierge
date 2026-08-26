import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeCodeArgs,
  claudeCodeInterruptRequest,
  claudeCodeUserMessage,
  parseClaudeCodeOutput,
  runClaudeCodeTurn,
  SubprocessClaudeCodeTransport,
} from "../src/claude-code";
import { providerFromText } from "../src/providers";
import { ProviderDispatchError } from "../src/provider-failures";
import { TurnSteeringController, type SteeringSender } from "../src/steering";

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

  test("prefers the terminal result over earlier assistant commentary", () => {
    const output = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Still investigating." }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "TL;DR: Final summary.\n\nDone." }] } }),
      JSON.stringify({ type: "result", is_error: false, result: "TL;DR: Final summary.\n\nDone." }),
    ].join("\n");

    expect(parseClaudeCodeOutput(output).text).toBe("TL;DR: Final summary.\n\nDone.");
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

  test("returns only the replacement response after an interrupted turn", () => {
    const output = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "STALE" }] },
      }),
      JSON.stringify({
        type: "result",
        is_error: true,
        terminal_reason: "aborted_streaming",
        subtype: "error_during_execution",
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "REPLACEMENT" }] },
      }),
      JSON.stringify({ type: "result", is_error: false, result: "REPLACEMENT" }),
    ].join("\n");

    expect(parseClaudeCodeOutput(output).text).toBe("REPLACEMENT");
    expect(parseClaudeCodeOutput(output).isError).toBe(false);
  });

  test("segments output at replayed guidance after a completed response race", () => {
    const output = [
      JSON.stringify({ type: "user", isReplay: true, message: { content: [{ type: "text", text: "INITIAL" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ORIGINAL" }] } }),
      JSON.stringify({ type: "result", is_error: false, terminal_reason: "completed", result: "ORIGINAL" }),
      JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "steer" } }),
      JSON.stringify({ type: "user", isReplay: true, message: { content: [{ type: "text", text: "REPLACE" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "STEERED" }] } }),
      JSON.stringify({ type: "result", is_error: false, terminal_reason: "completed", result: "STEERED" }),
    ].join("\n");

    expect(parseClaudeCodeOutput(output).text).toBe("STEERED");
  });

  test("treats tool interruption as a superseded output boundary", () => {
    const output = [
      JSON.stringify({ type: "user", isReplay: true, message: { content: [{ type: "text", text: "INITIAL" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "STALE" }] } }),
      JSON.stringify({ type: "result", is_error: true, terminal_reason: "aborted_tools" }),
      JSON.stringify({ type: "user", isReplay: true, message: { content: [{ type: "text", text: "REPLACE" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "STEERED" }] } }),
      JSON.stringify({ type: "result", is_error: false, terminal_reason: "completed", result: "STEERED" }),
    ].join("\n");

    expect(parseClaudeCodeOutput(output).text).toBe("STEERED");
  });

  test("returns only the final segment after multiple accepted guidance messages", () => {
    const output = [
      JSON.stringify({ type: "user", isReplay: true, message: { content: [{ type: "text", text: "INITIAL" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ORIGINAL" }] } }),
      JSON.stringify({ type: "user", isReplay: true, message: { content: [{ type: "text", text: "FIRST STEER" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "FIRST" }] } }),
      JSON.stringify({ type: "user", isReplay: true, message: { content: [{ type: "text", text: "SECOND STEER" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "FINAL" }] } }),
      JSON.stringify({ type: "result", is_error: false, terminal_reason: "completed", result: "FINAL" }),
    ].join("\n");

    expect(parseClaudeCodeOutput(output).text).toBe("FINAL");
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
      "--input-format",
      "stream-json",
      "--replay-user-messages",
      "--resume",
      "c0f2ec4e-5099-4dd2-9960-03b102478f80",
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

  test("keeps session instructions out of the user message", () => {
    const args = claudeCodeArgs({
      prompt: "clean user request",
      additionalDirs: [],
      sessionUUID: null,
      systemPrompt: "session contract",
    });
    expect(args).toContain("--append-system-prompt");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("session contract");
    expect(claudeCodeUserMessage("clean user request")).not.toContain("session contract");
  });

  test("selects a model for a fresh comparison session", () => {
    const args = claudeCodeArgs({
      prompt: "compare",
      additionalDirs: [],
      sessionUUID: null,
      model: "claude-sonnet-4-6",
    });
    expect(args).toContain("--model");
    expect(args).toContain("claude-sonnet-4-6");
  });

  test("writes prompts as stream-json user messages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-claude-test-"));
    const oldPath = process.env.PATH || "";
    const fakeClaude = join(dir, "claude");
    writeFileSync(fakeClaude, [
      "#!/bin/sh",
      "IFS= read -r prompt",
      "case \"$prompt\" in *'\"type\":\"user\"'*'\"text\":\"stdin prompt\"'*) ;; *) exit 2;; esac",
      "printf '%s\\n' '{\"type\":\"user\",\"isReplay\":true,\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"stdin prompt\"}]}}'",
      "printf '%s\\n' '{\"type\":\"result\",\"session_id\":\"c0f2ec4e-5099-4dd2-9960-03b102478f80\",\"result\":\"PONG\"}'",
    ].join("\n"));
    chmodSync(fakeClaude, 0o755);

    try {
      process.env.PATH = `${dir}:${oldPath}`;
      const result = await runClaudeCodeTurn({
        prompt: "stdin prompt",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: null,
      });
      expect(result.text).toBe("PONG");
      expect(claudeCodeUserMessage("stdin prompt")).toContain('"type":"user"');
    } finally {
      process.env.PATH = oldPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("passes native turn context into the Claude subprocess environment", async () => {
    let observedEnvironment: Record<string, string> | undefined;
    const result = await runClaudeCodeTurn({
      prompt: "verify deployment",
      cwd: tmpdir(),
      additionalDirs: [],
      sessionUUID: "c0f2ec4e-5099-4dd2-9960-03b102478f80",
      environment: {
        CONCIERGE_TURN_KIND: "deployment_verification",
        CONCIERGE_DEPLOYMENT_RUN_ID: "run-1",
      },
      transport: {
        async run(input) {
          observedEnvironment = input.environment;
          input.onProtocolActivityReady?.(() => {});
          input.onStdinReady?.(async () => {}, () => {});
          input.onStdout(`${JSON.stringify({
            type: "user",
            isReplay: true,
            message: { content: [{ type: "text", text: "verify deployment" }] },
          })}\n`);
          input.onStdout(`${JSON.stringify({
            type: "result",
            session_id: "c0f2ec4e-5099-4dd2-9960-03b102478f80",
            result: "TL;DR: verified",
          })}\n`);
          return { code: 0, signal: null };
        },
      },
    });

    expect(result.text).toBe("TL;DR: verified");
    expect(observedEnvironment).toEqual({
      CONCIERGE_TURN_KIND: "deployment_verification",
      CONCIERGE_DEPLOYMENT_RUN_ID: "run-1",
    });
  });

  for (const [message, failureClass] of [
    [
      "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.",
      "retryable",
    ],
    [
      "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access",
      "parked_access",
    ],
  ] as const) {
    test(`tags terminal provider failure as ${failureClass}`, async () => {
      let failure: unknown;
      try {
        await runClaudeCodeTurn({
          prompt: "initial",
          cwd: tmpdir(),
          additionalDirs: [],
          sessionUUID: null,
          transport: {
            async run(input) {
              input.onProtocolActivityReady?.(() => {});
              input.onStdinReady?.(async () => {}, () => {});
              input.onStdout(`${JSON.stringify({
                type: "user",
                isReplay: true,
                message: { content: [{ type: "text", text: "initial" }] },
              })}\n`);
              input.onStdout(`${JSON.stringify({
                type: "result",
                is_error: true,
                session_id: "c0f2ec4e-5099-4dd2-9960-03b102478f80",
                result: message,
              })}\n`);
              return { code: 1, signal: null };
            },
          },
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ProviderDispatchError);
      expect((failure as ProviderDispatchError).failureClass).toBe(failureClass);
      expect((failure as ProviderDispatchError).terminalConfirmed).toBeTrue();
      expect((failure as ProviderDispatchError).providerSessionId)
        .toBe("c0f2ec4e-5099-4dd2-9960-03b102478f80");
    });
  }

  test("does not report provider start without an exact replay of the initial prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-claude-test-"));
    const fakeClaude = join(dir, "claude");
    writeFileSync(fakeClaude, [
      "#!/bin/sh",
      "IFS= read -r prompt",
      "printf '%s\\n' '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"c0f2ec4e-5099-4dd2-9960-03b102478f80\"}'",
      "printf '%s\\n' '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"unrelated chatter\"}]}}'",
      "printf '%s\\n' '{\"type\":\"result\",\"session_id\":\"c0f2ec4e-5099-4dd2-9960-03b102478f80\",\"result\":\"PONG\"}'",
    ].join("\n"));
    chmodSync(fakeClaude, 0o755);
    const progress: string[] = [];

    try {
      await expect(runClaudeCodeTurn({
        prompt: "initial",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: null,
        transport: new SubprocessClaudeCodeTransport(fakeClaude),
        onProgress: (event) => progress.push(event.type),
      })).rejects.toThrow("before acknowledging the initial user message");
      expect(progress).not.toContain("started");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const exitCode of [0, 17]) {
    test(`rejects partial assistant output without a terminal result at exit ${exitCode}`, async () => {
      const progress: string[] = [];
      await expect(runClaudeCodeTurn({
        prompt: "initial",
        cwd: tmpdir(),
        additionalDirs: [],
        sessionUUID: null,
        transport: {
          async run(input) {
            input.onProtocolActivityReady?.(() => {});
            input.onStdinReady?.(async () => {}, () => {});
            input.onStdout(`${JSON.stringify({
              type: "user",
              isReplay: true,
              message: { content: [{ type: "text", text: "initial" }] },
            })}\n`);
            input.onStdout(`${JSON.stringify({
              type: "assistant",
              message: { content: [{ type: "text", text: "PARTIAL" }] },
            })}\n`);
            return { code: exitCode, signal: null };
          },
        },
        onProgress: (event) => progress.push(event.type),
      })).rejects.toThrow("before producing a terminal result");
      expect(progress).toContain("started");
      expect(progress).not.toContain("done");
    });
  }

  test("interrupts the active Claude turn before sending steering guidance", async () => {
    const consumedGuidance: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "concierge-claude-test-"));
    const fakeClaude = join(dir, "claude");
    writeFileSync(fakeClaude, [
      "#!/bin/sh",
      "IFS= read -r prompt",
      "case \"$prompt\" in *'\"text\":\"initial\"'*) ;; *) exit 2;; esac",
      "printf '%s\\n' '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"c0f2ec4e-5099-4dd2-9960-03b102478f80\"}'",
      "printf '%s\\n' '{\"type\":\"user\",\"isReplay\":true,\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"initial\"}]}}'",
      "IFS= read -r interrupt",
      "case \"$interrupt\" in *'\"type\":\"control_request\"'*'\"subtype\":\"interrupt\"'*) ;; *) exit 3;; esac",
      "printf '%s\\n' '{\"type\":\"control_response\",\"response\":{\"subtype\":\"success\",\"request_id\":\"concierge_steer_1\",\"response\":{\"still_queued\":[]}}}'",
      "printf '%s\\n' '{\"type\":\"assistant\",\"session_id\":\"c0f2ec4e-5099-4dd2-9960-03b102478f80\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"STALE\"}]}}'",
      "printf '%s\\n' '{\"type\":\"result\",\"is_error\":true,\"terminal_reason\":\"aborted_streaming\",\"subtype\":\"error_during_execution\",\"session_id\":\"c0f2ec4e-5099-4dd2-9960-03b102478f80\"}'",
      "IFS= read -r steering",
      "case \"$steering\" in *'\"text\":\"focus on tests\"'*) ;; *) exit 3;; esac",
      "printf '%s\\n' '{\"type\":\"user\",\"isReplay\":true,\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"focus on tests\"}]}}'",
      "sleep 0.05",
      "printf '%s\\n' '{\"type\":\"assistant\",\"session_id\":\"c0f2ec4e-5099-4dd2-9960-03b102478f80\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"STEERED\"}]}}'",
      "printf '%s\\n' '{\"type\":\"result\",\"session_id\":\"c0f2ec4e-5099-4dd2-9960-03b102478f80\",\"result\":\"STEERED\"}'",
    ].join("\n"));
    chmodSync(fakeClaude, 0o755);
    let sendSteering: ((input: { clientMessageId: string; text: string }) => Promise<void>) | null = null;
    let providerTerminal = false;
    let ready!: () => void;
    const steeringReady = new Promise<void>((resolve) => { ready = resolve; });

    try {
      const running = runClaudeCodeTurn({
        prompt: "initial",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: null,
        transport: new SubprocessClaudeCodeTransport(fakeClaude),
        onProgress: event => { if (event.type === "steering") consumedGuidance.push(event.clientMessageId); },
        onSteeringReady: (sender) => {
          sendSteering = sender;
          ready();
        },
        onProviderTerminal: () => { providerTerminal = true; },
      });
      await steeringReady;
      await sendSteering!({ clientMessageId: "slack:C1:1.2", text: "focus on tests" });
      expect(providerTerminal).toBe(false);
      expect((await running).text).toBe("STEERED");
      expect(providerTerminal).toBe(true);
      expect(consumedGuidance).toEqual(["slack:C1:1.2"]);
      expect(claudeCodeInterruptRequest("request-1")).toContain('"subtype":"interrupt"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps the replacement turn open when the old aborted result follows its replay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-claude-test-"));
    const fakeClaude = join(dir, "claude");
    writeFileSync(fakeClaude, [
      "#!/bin/sh",
      "IFS= read -r prompt",
      "printf '%s\\n' '{\"type\":\"user\",\"isReplay\":true,\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"initial\"}]}}'",
      "IFS= read -r interrupt",
      "printf '%s\\n' '{\"type\":\"control_response\",\"response\":{\"subtype\":\"success\",\"request_id\":\"concierge_steer_1\",\"response\":{}}}'",
      "IFS= read -r steering",
      "printf '%s\\n' '{\"type\":\"user\",\"isReplay\":true,\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"replacement\"}]}}'",
      "printf '%s\\n' '{\"type\":\"result\",\"is_error\":true,\"terminal_reason\":\"aborted_streaming\"}'",
      "sleep 0.05",
      "printf '%s\\n' '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"FINAL\"}]}}'",
      "printf '%s\\n' '{\"type\":\"result\",\"is_error\":false,\"result\":\"FINAL\"}'",
    ].join("\n"));
    chmodSync(fakeClaude, 0o755);
    let sender: SteeringSender | null = null;
    let ready!: () => void;
    const steeringReady = new Promise<void>((resolve) => { ready = resolve; });
    try {
      const running = runClaudeCodeTurn({
        prompt: "initial",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: null,
        transport: new SubprocessClaudeCodeTransport(fakeClaude, { inactivityMs: 1_000, shutdownGraceMs: 20 }),
        onSteeringReady: (value) => { sender = value; ready(); },
      });
      await steeringReady;
      await sender!({ clientMessageId: "slack:C1:1.2", text: "replacement" });
      expect((await running).text).toBe("FINAL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects steering that was written but not acknowledged before the result", async () => {
    let sendSteering: ((input: { clientMessageId: string; text: string }) => Promise<void>) | null = null;
    let providerTerminalCalls = 0;
    let providerWasTerminalWhenInputClosed = false;
    let ready!: () => void;
    const steeringReady = new Promise<void>((resolve) => { ready = resolve; });
    const running = runClaudeCodeTurn({
      prompt: "initial",
      cwd: tmpdir(),
      additionalDirs: [],
      sessionUUID: null,
      transport: {
        async run(transportInput) {
          let finishTransport!: () => void;
          const transportClosed = new Promise<void>((resolve) => { finishTransport = resolve; });
          transportInput.onProtocolActivityReady?.(() => {});
          transportInput.onStdinReady?.(async (value) => {
            if (value.includes('"subtype":"interrupt"')) {
              transportInput.onStdout(`${JSON.stringify({
                type: "control_response",
                response: { subtype: "success", request_id: "concierge_steer_1", response: {} },
              })}\n`);
            } else {
              transportInput.onStdout(`${JSON.stringify({
                type: "result",
                session_id: "c0f2ec4e-5099-4dd2-9960-03b102478f80",
                result: "UNSTEERED",
              })}\n`);
            }
          }, () => {
            providerWasTerminalWhenInputClosed = providerTerminalCalls === 1;
            finishTransport();
          });
          transportInput.onStdout(`${JSON.stringify({
            type: "user",
            isReplay: true,
            message: { content: [{ type: "text", text: "initial" }] },
          })}\n`);
          await transportClosed;
          return { code: 0, signal: null };
        },
      },
      onSteeringReady: (sender) => {
        sendSteering = sender;
        ready();
      },
      onProviderTerminal: () => { providerTerminalCalls += 1; },
      steeringAcknowledgementGraceMs: 20,
    });
    await steeringReady;
    await expect(sendSteering!({
      clientMessageId: "slack:C1:1.2",
      text: "focus on tests",
    })).rejects.toThrow("did not acknowledge steering");
    expect(providerTerminalCalls).toBe(1);
    expect(providerWasTerminalWhenInputClosed).toBe(true);
    expect((await running).text).toBe("UNSTEERED");
  });

  test("refuses later identical guidance after replay correlation is lost", async () => {
    const controller = new TurnSteeringController();
    const writes: string[] = [];
    const sent: string[] = [];
    const failed: string[] = [];
    const ambiguous: string[] = [];
    let emitLateReplay!: () => void;
    let finishProvider!: () => void;
    let senderReady!: () => void;
    const ready = new Promise<void>((resolve) => { senderReady = resolve; });
    let secondSettled!: () => void;
    const secondDone = new Promise<void>((resolve) => { secondSettled = resolve; });
    const running = runClaudeCodeTurn({
      prompt: "initial",
      cwd: tmpdir(),
      additionalDirs: [],
      sessionUUID: null,
      steeringAcknowledgementTimeoutMs: 20,
      transport: {
        async run(transportInput) {
          let closeTransport!: () => void;
          const closed = new Promise<void>((resolve) => { closeTransport = resolve; });
          transportInput.onProtocolActivityReady?.(() => {});
          transportInput.onStdinReady?.(async (value) => {
            writes.push(value);
            const request = JSON.parse(value);
            if (request.type === "control_request") {
              transportInput.onStdout(`${JSON.stringify({
                type: "control_response",
                response: { subtype: "success", request_id: request.request_id },
              })}\n`);
            }
          }, closeTransport);
          transportInput.onStdout(`${JSON.stringify({
            type: "user",
            isReplay: true,
            message: { content: [{ type: "text", text: "initial" }] },
          })}\n`);
          emitLateReplay = () => transportInput.onStdout(`${JSON.stringify({
            type: "user",
            isReplay: true,
            message: { content: [{ type: "text", text: "repeat" }] },
          })}\n`);
          finishProvider = () => transportInput.onStdout(`${JSON.stringify({
            type: "result",
            is_error: false,
            result: "DONE",
          })}\n`);
          await closed;
          return { code: 0, signal: null };
        },
      },
      onSteeringReady: (sender) => {
        controller.registerSender(sender);
        senderReady();
      },
    });
    await ready;
    const enqueue = (id: string) => controller.enqueue({
      clientMessageId: id,
      text: "repeat",
      onSent: () => { sent.push(id); },
      onError: () => {
        failed.push(id);
        if (id === "second") secondSettled();
      },
      onAmbiguous: () => { ambiguous.push(id); },
    });
    expect(enqueue("first")).toBeTrue();
    expect(enqueue("second")).toBeTrue();
    await secondDone;
    emitLateReplay();
    finishProvider();

    expect((await running).text).toBe("DONE");
    expect(ambiguous).toEqual(["first"]);
    expect(failed).toEqual(["second"]);
    expect(sent).toEqual([]);
    expect(writes.filter((value) => value.includes('"subtype":"interrupt"'))).toHaveLength(1);
  });

  test("rejects instead of crashing when a provider closes during a large stdin write", async () => {
    const progress: string[] = [];
    await expect(runClaudeCodeTurn({
      prompt: "x".repeat(1_000_000),
      cwd: tmpdir(),
      additionalDirs: [],
      sessionUUID: null,
      transport: new SubprocessClaudeCodeTransport("/bin/false"),
      onProgress: (event) => progress.push(event.type),
    })).rejects.toThrow();
    expect(progress).not.toContain("started");
  });

  test("kills a provider that emits a result but ignores input closure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-claude-test-"));
    const fakeClaude = join(dir, "claude");
    writeFileSync(fakeClaude, [
      "#!/bin/sh",
      "IFS= read -r prompt",
      "printf '%s\\n' '{\"type\":\"user\",\"isReplay\":true,\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"initial\"}]}}'",
      "printf '%s\\n' '{\"type\":\"result\",\"session_id\":\"c0f2ec4e-5099-4dd2-9960-03b102478f80\",\"result\":\"DONE\"}'",
      "trap '' TERM",
      "while :; do printf '%s\\n' 'stderr noise' >&2; sleep 0.005; done",
    ].join("\n"));
    chmodSync(fakeClaude, 0o755);

    try {
      const result = await runClaudeCodeTurn({
        prompt: "initial",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: null,
        transport: new SubprocessClaudeCodeTransport(fakeClaude, {
          inactivityMs: 1_000,
          shutdownGraceMs: 20,
        }),
      });
      expect(result.text).toBe("DONE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps an empty successful result when the completed provider must be killed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-claude-test-"));
    const fakeClaude = join(dir, "claude");
    writeFileSync(fakeClaude, [
      "#!/bin/sh",
      "IFS= read -r prompt",
      "printf '%s\\n' '{\"type\":\"user\",\"isReplay\":true,\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"initial\"}]}}'",
      "printf '%s\\n' '{\"type\":\"result\",\"is_error\":false,\"session_id\":\"c0f2ec4e-5099-4dd2-9960-03b102478f80\",\"result\":\"\"}'",
      "trap '' TERM",
      "while :; do printf '%s\\n' 'stderr noise' >&2; sleep 0.005; done",
    ].join("\n"));
    chmodSync(fakeClaude, 0o755);

    try {
      const result = await runClaudeCodeTurn({
        prompt: "initial",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: null,
        transport: new SubprocessClaudeCodeTransport(fakeClaude, {
          inactivityMs: 1_000,
          shutdownGraceMs: 20,
        }),
      });
      expect(result.text).toBe("(agent completed without a text reply)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("terminates a silent live provider after inactivity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-claude-test-"));
    const fakeClaude = join(dir, "claude");
    writeFileSync(fakeClaude, [
      "#!/bin/sh",
      "IFS= read -r prompt",
      "trap '' TERM",
      "while :; do printf '%s\\n' 'stderr noise' >&2; sleep 0.005; done",
    ].join("\n"));
    chmodSync(fakeClaude, 0o755);

    try {
      await expect(runClaudeCodeTurn({
        prompt: "initial",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: null,
        transport: new SubprocessClaudeCodeTransport(fakeClaude, {
          inactivityMs: 20,
          shutdownGraceMs: 20,
        }),
      })).rejects.toThrow("no provider activity");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("renews the inactivity lease for Claude keep-alive and tool progress events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-claude-test-"));
    const fakeClaude = join(dir, "claude");
    writeFileSync(fakeClaude, [
      "#!/bin/sh",
      "IFS= read -r prompt",
      "printf '%s\\n' '{\"type\":\"user\",\"isReplay\":true,\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"initial\"}]}}'",
      "sleep 0.01",
      "printf '%s\\n' '{\"type\":\"keep_alive\"}'",
      "sleep 0.01",
      "printf '%s\\n' '{\"type\":\"tool_progress\",\"elapsed_time_seconds\":1}'",
      "sleep 0.01",
      "printf '%s\\n' '{\"type\":\"stream_event\",\"event\":{}}'",
      "sleep 0.01",
      "printf '%s\\n' '{\"type\":\"tool_use_summary\",\"summary\":\"working\"}'",
      "sleep 0.01",
      "printf '%s\\n' '{\"type\":\"result\",\"is_error\":false,\"result\":\"DONE\"}'",
    ].join("\n"));
    chmodSync(fakeClaude, 0o755);

    try {
      const result = await runClaudeCodeTurn({
        prompt: "initial",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: null,
        transport: new SubprocessClaudeCodeTransport(fakeClaude, {
          inactivityMs: 25,
          shutdownGraceMs: 20,
        }),
      });
      expect(result.text).toBe("DONE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not renew the inactivity lease for malformed stdout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-claude-test-"));
    const fakeClaude = join(dir, "claude");
    writeFileSync(fakeClaude, [
      "#!/bin/sh",
      "IFS= read -r prompt",
      "printf '%s\\n' '{\"type\":\"user\",\"isReplay\":true,\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"initial\"}]}}'",
      "trap '' TERM",
      "while :; do printf '%s\\n' 'not-json'; sleep 0.005; done",
    ].join("\n"));
    chmodSync(fakeClaude, 0o755);

    try {
      await expect(runClaudeCodeTurn({
        prompt: "initial",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: null,
        transport: new SubprocessClaudeCodeTransport(fakeClaude, {
          inactivityMs: 20,
          shutdownGraceMs: 20,
        }),
      })).rejects.toThrow("no provider activity");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("providerFromText", () => {
  test("selects the cc alias only for top-level selector mentions", () => {
    expect(providerFromText("@cc do it", "codex", { topLevel: true })).toBe("claude-code");
    expect(providerFromText("@cc do it", "codex", { topLevel: false })).toBe("codex");
  });

  test("selects configured distinct claude bot user id", () => {
    expect(providerFromText("<@UCLAUDE> do it", "codex", {
      topLevel: true,
      claudeCodeBotUserId: "UCLAUDE",
    })).toBe("claude-code");
  });
});
