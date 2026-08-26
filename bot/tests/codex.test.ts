import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexControlRequestError,
  codexAppServerArgs,
  codexTurnDurationMs,
  findCodexForksByThreadSource,
  findCodexTurnIdsByReplayText,
  forkCodexSession,
  runCodexTurn,
} from "../src/codex";
import {
  CodexAppServerClientError,
  codexAppServerSocketPath,
  type CodexAppServerClientLike,
} from "../src/codex-app-server-client";
import type { SteeringSender } from "../src/steering";

function fakeCodex(dir: string, lines: string[]) {
  const executable = join(dir, "codex");
  writeFileSync(executable, ["#!/bin/sh", ...lines].join("\n"));
  chmodSync(executable, 0o755);
  return executable;
}

const initializeHandshake = [
  "IFS= read -r initialize",
  "case \"$initialize\" in *'\"method\":\"initialize\"'*'\"experimentalApi\":true'*) ;; *) exit 11;; esac",
  "printf '%s\\n' '{\"id\":1,\"result\":{\"userAgent\":\"fake\"}}'",
  "IFS= read -r initialized",
  "case \"$initialized\" in *'\"method\":\"initialized\"'*) ;; *) exit 12;; esac",
];

class ScriptedSharedClient implements CodexAppServerClientLike {
  generation = 0;
  connected = false;
  interruptCalls = 0;
  historyStatus: "inProgress" | "completed" | "interrupted" = "inProgress";
  historyTiming: { durationMs?: number; startedAt?: number; completedAt?: number } = {};
  turnStartError: CodexAppServerClientError | null = null;
  onTurnStart?: (client: ScriptedSharedClient) => void;
  readonly requests: string[] = [];
  readonly requestParams: Array<{ method: string; params: any }> = [];
  private readonly notifications = new Set<(event: any) => void>();
  private readonly disconnects = new Set<(error: Error, generation: number) => void>();

  async connect() {
    if (!this.connected) {
      this.connected = true;
      this.generation += 1;
    }
    return this.generation;
  }

  async request(method: string, params: any) {
    this.requests.push(method);
    this.requestParams.push({ method, params });
    if (method === "thread/start" || method === "thread/resume") {
      return { thread: { id: params.threadId || "shared-thread" } };
    }
    if (method === "turn/start") {
      queueMicrotask(() => this.onTurnStart?.(this));
      if (this.turnStartError) throw this.turnStartError;
      return { turn: { id: "shared-turn" } };
    }
    if (method === "thread/read") {
      return {
        thread: {
          turns: [{
            id: "shared-turn",
            status: this.historyStatus,
            ...this.historyTiming,
            error: this.historyStatus === "interrupted" ? { message: "interrupted" } : null,
            items: [
              {
                id: "shared-user",
                type: "userMessage",
                clientId: "slack-concierge:turn:shared",
                content: [{ type: "text", text: "shared request" }],
              },
              {
                id: "shared-commentary",
                type: "agentMessage",
                phase: "commentary",
                text: "Investigating once.",
              },
              ...(this.historyStatus === "completed" ? [{
                id: "shared-answer",
                type: "agentMessage",
                phase: "final_answer",
                text: "TL;DR: recovered exact turn",
              }] : []),
            ],
          }],
        },
      };
    }
    if (method === "turn/interrupt") {
      this.interruptCalls += 1;
      this.historyStatus = "interrupted";
      return {};
    }
    throw new Error(`unexpected method ${method}`);
  }

  async notify() {}

  onNotification(listener: (event: any) => void) {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  onDisconnect(listener: (error: Error, generation: number) => void) {
    this.disconnects.add(listener);
    return () => this.disconnects.delete(listener);
  }

  async waitForDisconnect() {}

  emit(event: any) {
    for (const listener of this.notifications) listener(event);
  }

  disconnect() {
    const disconnectedGeneration = this.generation;
    this.connected = false;
    for (const listener of this.disconnects) {
      listener(new Error("scripted bridge disconnect"), disconnectedGeneration);
    }
  }
}

describe("codex app-server", () => {
  test("uses only provider duration or valid provider timestamps, never local elapsed time", () => {
    expect(codexTurnDurationMs({ durationMs: 1_122_123, startedAt: 100, completedAt: 200 })).toBe(1_122_123);
    expect(codexTurnDurationMs({ durationMs: 0, startedAt: 100, completedAt: 200 })).toBe(0);
    expect(codexTurnDurationMs({ durationMs: null, startedAt: 100, completedAt: 200 })).toBe(100_000);
    expect(codexTurnDurationMs({ startedAt: 100, completedAt: 100 })).toBe(0);
    for (const turn of [
      {}, { durationMs: null }, { durationMs: -1 }, { durationMs: Infinity },
      { durationMs: NaN }, { durationMs: "1000" }, { durationMs: 1.5 },
      { startedAt: 200, completedAt: 100 }, { startedAt: null, completedAt: 100 },
      { startedAt: 0, completedAt: Number.MAX_SAFE_INTEGER }, { startedAt: 100 },
    ]) expect(codexTurnDurationMs(turn)).toBeUndefined();
  });

  test("keeps shared terminal timing scoped to the exact provider turn", async () => {
    const client = new ScriptedSharedClient();
    client.onTurnStart = active => {
      for (const [threadId, turnId, durationMs] of [
        ["other-thread", "shared-turn", 10],
        ["shared-thread", "other-turn", 20],
        ["shared-thread", "shared-turn", 1_122_000],
      ]) active.emit({ method: "turn/completed", params: {
        threadId, turn: { id: turnId, status: "completed", durationMs },
      } });
    };
    const result = await runCodexTurn({
      prompt: "shared request", cwd: "/tmp", additionalDirs: [], sessionUUID: null,
      appServerClient: client, requestTimeoutMs: 100, inactivityTimeoutMs: 1_000,
    });
    expect(result.durationMs).toBe(1_122_000);
    expect(result.providerTurnId).toBe("shared-turn");
  });

  test("uses the bidirectional app-server transport", () => {
    expect(codexAppServerArgs()).toEqual(["app-server", "--stdio"]);
  });

  test("uses the managed daemon control socket for production clients", () => {
    const previousSocket = process.env.CONCIERGE_CODEX_APP_SERVER_SOCKET;
    try {
      process.env.CONCIERGE_CODEX_APP_SERVER_SOCKET = "/tmp/codex.sock";
      expect(codexAppServerSocketPath()).toBe("/tmp/codex.sock");
    } finally {
      if (previousSocket === undefined) delete process.env.CONCIERGE_CODEX_APP_SERVER_SOCKET;
      else process.env.CONCIERGE_CODEX_APP_SERVER_SOCKET = previousSocket;
    }
  });

  test("reconciles an accepted daemon turn after the shared connection disconnects", async () => {
    const client = new ScriptedSharedClient();
    client.historyTiming = { startedAt: 100, completedAt: 142 };
    const narration: string[] = [];
    let providerTerminal = false;
    client.onTurnStart = (active) => {
      active.emit({
        method: "turn/completed",
        params: {
          threadId: "shared-thread",
          turn: {
            id: "unrelated-remote-turn",
            status: "completed",
            items: [{
              id: "unrelated-answer",
              type: "agentMessage",
              phase: "final_answer",
              text: "WRONG TURN",
            }],
          },
        },
      });
      active.emit({
        method: "item/completed",
        params: {
          threadId: "shared-thread",
          turnId: "shared-turn",
          item: {
            id: "shared-commentary",
            type: "agentMessage",
            phase: "commentary",
            text: "Investigating once.",
          },
        },
      });
      active.historyStatus = "completed";
      active.disconnect();
    };

    const result = await runCodexTurn({
      prompt: "shared request",
      cwd: "/tmp",
      additionalDirs: [],
      sessionUUID: null,
      clientUserMessageId: "slack-concierge:turn:shared",
      appServerClient: client,
      requestTimeoutMs: 100,
      inactivityTimeoutMs: 1_000,
      onProgress: (event) => {
        if (event.type === "narration" && event.text) narration.push(event.text);
      },
      onProviderTerminal: () => { providerTerminal = true; },
    });

    expect(result).toMatchObject({
      text: "TL;DR: recovered exact turn",
      sessionUUID: "shared-thread",
      providerTurnId: "shared-turn",
      durationMs: 42_000,
    });
    expect(client.generation).toBe(2);
    expect(narration).toEqual(["Investigating once.", "TL;DR: recovered exact turn"]);
    expect(providerTerminal).toBeTrue();
  });

  test("recovers an accepted turn after a non-definitive turn/start JSON-RPC error", async () => {
    const client = new ScriptedSharedClient();
    client.turnStartError = new CodexAppServerClientError(
      "internal failure after commit",
      "ambiguous",
      -32603,
    );
    client.historyStatus = "completed";
    let providerTurnPersistenceCalls = 0;

    const result = await runCodexTurn({
      prompt: "shared request",
      cwd: "/tmp",
      additionalDirs: [],
      sessionUUID: null,
      clientUserMessageId: "slack-concierge:turn:shared",
      appServerClient: client,
      requestTimeoutMs: 100,
      inactivityTimeoutMs: 1_000,
      onProviderTurnStarted: () => {
        providerTurnPersistenceCalls += 1;
        if (providerTurnPersistenceCalls === 1) throw new Error("sqlite busy");
      },
    });

    expect(result.text).toBe("TL;DR: recovered exact turn");
    expect(result.providerTurnId).toBe("shared-turn");
    expect(providerTurnPersistenceCalls).toBe(2);
  });

  test("binds a new provider thread before it submits the first turn", async () => {
    const client = new ScriptedSharedClient();
    let boundThreadId: string | null = null;
    client.historyStatus = "completed";
    client.onTurnStart = (active) => {
      expect(boundThreadId).toBe("shared-thread");
      active.disconnect();
    };

    await runCodexTurn({
      prompt: "shared request",
      cwd: "/tmp",
      additionalDirs: [],
      sessionUUID: null,
      clientUserMessageId: "slack-concierge:turn:shared",
      appServerClient: client,
      requestTimeoutMs: 100,
      inactivityTimeoutMs: 1_000,
      onProviderThreadStarted: (threadId) => { boundThreadId = threadId; },
    });

    expect(client.requests.indexOf("thread/start")).toBeLessThan(client.requests.indexOf("turn/start"));
    expect(boundThreadId).toBe("shared-thread");
  });

  test("passes native turn context through the managed app-server environment policy", async () => {
    const client = new ScriptedSharedClient();
    client.historyStatus = "completed";
    client.onTurnStart = (active) => active.disconnect();

    await runCodexTurn({
      prompt: "verify deployment",
      cwd: "/tmp",
      additionalDirs: [],
      sessionUUID: "existing-thread",
      clientUserMessageId: "slack-concierge:turn:deployment",
      environment: {
        CONCIERGE_TURN_KIND: "deployment_verification",
        CONCIERGE_DEPLOYMENT_RUN_ID: "run-1",
      },
      appServerClient: client,
      requestTimeoutMs: 100,
      inactivityTimeoutMs: 1_000,
    });

    const resume = client.requestParams.find(({ method }) => method === "thread/resume");
    expect(resume?.params).toMatchObject({
      threadId: "existing-thread",
      config: {
        shell_environment_policy: {
          inherit: "all",
          set: {
            CONCIERGE_TURN_KIND: "deployment_verification",
            CONCIERGE_DEPLOYMENT_RUN_ID: "run-1",
          },
        },
      },
    });
  });

  test("waits for exact terminal state after an inactivity interrupt loses its event", async () => {
    const client = new ScriptedSharedClient();
    let providerTerminal = false;
    client.onTurnStart = (active) => active.emit({
      method: "turn/started",
      params: {
        threadId: "shared-thread",
        turn: { id: "shared-turn", status: "inProgress" },
      },
    });

    await expect(runCodexTurn({
      prompt: "shared request",
      cwd: "/tmp",
      additionalDirs: [],
      sessionUUID: null,
      clientUserMessageId: "slack-concierge:turn:shared",
      appServerClient: client,
      requestTimeoutMs: 100,
      inactivityTimeoutMs: 10,
      onProviderTerminal: () => { providerTerminal = true; },
    })).rejects.toThrow("no turn activity");

    expect(client.interruptCalls).toBe(1);
    expect(providerTerminal).toBeTrue();
  });

  test("forks a session through thread/fork and returns the new thread id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const sourceThreadId = "01a015f2-b17c-7801-b185-3b078fb26800";
    const forkedThreadId = "01a015f2-b17c-7801-b185-3b078fb26801";
    const lastTurnId = "turn-selected";
    const threadSource = "slack-concierge-fork:test";
    const additionalDir = join(dir, "shared");
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r fork",
      `case "$fork" in *'"method":"thread/fork"'*'"threadId":"${sourceThreadId}"'*'"cwd":"${dir}"'*'"runtimeWorkspaceRoots":["${dir}","${additionalDir}"]'*'"approvalPolicy":"never"'*'"sandbox":"danger-full-access"'*'"deferGoalContinuation":true'*'"excludeTurns":true'*'"lastTurnId":"${lastTurnId}"'*'"threadSource":"${threadSource}"'*) ;; *) exit 13;; esac`,
      `printf '%s\\n' '{"id":2,"result":{"thread":{"id":"${forkedThreadId}"}}}'`,
    ]);

    try {
      const result = await forkCodexSession({
        sessionUUID: sourceThreadId,
        cwd: dir,
        additionalDirs: [additionalDir],
        executable,
        lastTurnId,
        threadSource,
      });

      expect(result).toEqual({
        text: "Fork created.",
        sessionUUID: forkedThreadId,
        toolsUsed: [],
        providerTurnId: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a thread/fork response that reuses the source thread id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const sourceThreadId = "01a015f2-b17c-7801-b185-3b078fb26800";
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r fork",
      `printf '%s\\n' '{"id":2,"result":{"thread":{"id":"${sourceThreadId}"}}}'`,
    ]);

    try {
      await expect(forkCodexSession({
        sessionUUID: sourceThreadId,
        cwd: dir,
        additionalDirs: [],
        executable,
      })).rejects.toThrow("did not return a distinct new thread id");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("classifies an explicit thread/fork JSON-RPC rejection as definitive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r fork",
      "printf '%s\\n' '{\"id\":2,\"error\":{\"code\":-32602,\"message\":\"unknown thread\"}}'",
    ]);

    try {
      let failure: unknown;
      try {
        await forkCodexSession({
          sessionUUID: "missing-thread",
          cwd: dir,
          additionalDirs: [],
          executable,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(CodexControlRequestError);
      expect((failure as CodexControlRequestError).outcome).toBe("rejected");
      expect(String(failure)).toContain("unknown thread");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("classifies a silent thread/fork timeout as ambiguous", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r fork",
      "sleep 1",
    ]);

    try {
      let failure: unknown;
      try {
        await forkCodexSession({
          sessionUUID: "source-thread",
          cwd: dir,
          additionalDirs: [],
          executable,
          requestTimeoutMs: 20,
          shutdownGraceMs: 5,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(CodexControlRequestError);
      expect((failure as CodexControlRequestError).outcome).toBe("ambiguous");
      expect(String(failure)).toContain("timed out");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("classifies an internal thread/fork JSON-RPC error as ambiguous", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r fork",
      "printf '%s\\n' '{\"id\":2,\"error\":{\"code\":-32603,\"message\":\"internal failure after commit\"}}'",
    ]);

    try {
      let failure: unknown;
      try {
        await forkCodexSession({
          sessionUUID: "source-thread",
          cwd: dir,
          additionalDirs: [],
          executable,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(CodexControlRequestError);
      expect((failure as CodexControlRequestError).outcome).toBe("ambiguous");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recovers the exact fork child by its durable thread source marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const sourceThreadId = "source-thread";
    const forkedThreadId = "forked-thread";
    const threadSource = "slack-concierge-fork:durable-request";
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r list",
      `case "$list" in *'"method":"thread/list"'*'"sourceKinds":["vscode"]'*) ;; *) exit 13;; esac`,
      "case \"$list\" in *'\"parentThreadId\"'*) exit 14;; *) ;; esac",
      `printf '%s\\n' '{"id":2,"result":{"data":[{"id":"${forkedThreadId}","forkedFromId":"${sourceThreadId}","threadSource":"${threadSource}"},{"id":"other","forkedFromId":"${sourceThreadId}","threadSource":"different"}],"nextCursor":null}}'`,
    ]);

    try {
      expect(await findCodexForksByThreadSource({
        sourceSessionUUID: sourceThreadId,
        threadSource,
        cwd: dir,
        executable,
      })).toEqual([forkedThreadId]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("backfills a legacy Slack turn only when its canonical input uniquely matches Codex history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const replayText = "the exact legacy Slack request";
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r read_thread",
      "case \"$read_thread\" in *'\"method\":\"thread/read\"'*'\"includeTurns\":true'*) ;; *) exit 13;; esac",
      `printf '%s\\n' '{"id":2,"result":{"thread":{"turns":[{"id":"turn-selected","items":[{"type":"userMessage","content":[{"type":"text","text":"injected system context\\n\\n${replayText}"}]}]},{"id":"turn-other","items":[{"type":"userMessage","content":[{"type":"text","text":"different request"}]}]}]}}}'`,
    ]);

    try {
      expect(await findCodexTurnIdsByReplayText({
        sessionUUID: "legacy-session",
        replayText,
        cwd: dir,
        executable,
      })).toEqual(["turn-selected"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns only final-answer text while reporting commentary as progress", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r thread",
      "printf '%s\\n' '{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread-final\"}}}'",
      "IFS= read -r turn",
      "printf '%s\\n' '{\"id\":3,\"result\":{\"turn\":{\"id\":\"turn-final\"}}}'",
      "printf '%s\\n' '{\"method\":\"turn/started\",\"params\":{\"threadId\":\"thread-final\",\"turn\":{\"id\":\"turn-final\",\"status\":\"inProgress\"}}}'",
      "printf '%s\\n' '{\"method\":\"item/completed\",\"params\":{\"threadId\":\"thread-final\",\"turnId\":\"turn-final\",\"item\":{\"id\":\"commentary\",\"type\":\"agentMessage\",\"phase\":\"commentary\",\"text\":\"I am still investigating.\"}}}'",
      "printf '%s\\n' '{\"method\":\"item/completed\",\"params\":{\"threadId\":\"thread-final\",\"turnId\":\"turn-final\",\"item\":{\"id\":\"answer\",\"type\":\"agentMessage\",\"phase\":\"final_answer\",\"text\":\"TL;DR: Final summary.\\n\\nDone.\"}}}'",
      "printf '%s\\n' '{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"thread-final\",\"turn\":{\"id\":\"turn-final\",\"status\":\"completed\",\"durationMs\":1122000}}}'",
    ]);
    const narration: string[] = [];

    try {
      const result = await runCodexTurn({
        prompt: "work",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: null,
        executable,
        onProgress: (event) => {
          if (event.type === "narration" && event.text) narration.push(event.text);
        },
      });

      expect(result.text).toBe("TL;DR: Final summary.\n\nDone.");
      expect(result.durationMs).toBe(1_122_000);
      expect(narration).toEqual(["I am still investigating.", "TL;DR: Final summary.\n\nDone."]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("passes an explicit model without overriding reasoning effort", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r thread",
      "case \"$thread\" in *'\"method\":\"thread/start\"'*'\"model\":\"gpt-5.6-luna\"'*) ;; *) exit 13;; esac",
      "case \"$thread\" in *'reasoningEffort'*) exit 14;; *) ;; esac",
      "printf '%s\\n' '{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread-model\"}}}'",
      "IFS= read -r turn",
      "printf '%s\\n' '{\"id\":3,\"result\":{\"turn\":{\"id\":\"turn-model\"}}}'",
      "printf '%s\\n' '{\"method\":\"turn/started\",\"params\":{\"threadId\":\"thread-model\",\"turn\":{\"id\":\"turn-model\",\"status\":\"inProgress\"}}}'",
      "printf '%s\\n' '{\"method\":\"item/completed\",\"params\":{\"threadId\":\"thread-model\",\"turnId\":\"turn-model\",\"item\":{\"id\":\"answer\",\"type\":\"agentMessage\",\"phase\":\"final_answer\",\"text\":\"done\"}}}'",
      "printf '%s\\n' '{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"thread-model\",\"turn\":{\"id\":\"turn-model\",\"status\":\"completed\"}}}'",
    ]);

    try {
      const result = await runCodexTurn({
        prompt: "work",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: null,
        executable,
        model: "gpt-5.6-luna",
      });

      expect(result.sessionUUID).toBe("thread-model");
      expect(result.text).toBe("done");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("starts a thread and steers its active turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r thread",
      "case \"$thread\" in *'\"method\":\"thread/start\"'*'\"sandbox\":\"danger-full-access\"'*) case \"$thread\" in *'\"developerInstructions\"'*) exit 13;; *) ;; esac ;; *) exit 13;; esac",
      "printf '%s\\n' '{\"id\":2,\"result\":{\"thread\":{\"id\":\"019fde26-53ca-7e51-9aa6-3a8c1fe0762c\"}}}'",
      "IFS= read -r turn",
      "case \"$turn\" in *'\"method\":\"turn/start\"'*'initial prompt'*'\"clientUserMessageId\":\"slack-concierge:turn:1\"'*'\"additionalContext\":{\"slack-concierge\":{\"value\":\"Project instructions\",\"kind\":\"application\"}}'*) ;; *) exit 14;; esac",
      "printf '%s\\n' '{\"id\":3,\"result\":{\"turn\":{\"id\":\"turn-1\"}}}'",
      "printf '%s\\n' '{\"method\":\"turn/started\",\"params\":{\"threadId\":\"019fde26-53ca-7e51-9aa6-3a8c1fe0762c\",\"turn\":{\"id\":\"turn-1\",\"status\":\"inProgress\"}}}'",
      "IFS= read -r steer",
      "case \"$steer\" in *'\"method\":\"turn/steer\"'*'\"expectedTurnId\":\"turn-1\"'*'focus on tests'*) ;; *) exit 15;; esac",
      "printf '%s\\n' '{\"id\":4,\"result\":{\"turnId\":\"turn-1\"}}'",
      "printf '%s\\n' '{\"method\":\"item/completed\",\"params\":{\"threadId\":\"019fde26-53ca-7e51-9aa6-3a8c1fe0762c\",\"turnId\":\"turn-1\",\"item\":{\"id\":\"message-stale\",\"type\":\"agentMessage\",\"text\":\"STALE\"}}}'",
      "printf '%s\\n' '{\"method\":\"item/started\",\"params\":{\"threadId\":\"019fde26-53ca-7e51-9aa6-3a8c1fe0762c\",\"turnId\":\"turn-1\",\"item\":{\"id\":\"user-steer-1\",\"type\":\"userMessage\",\"clientId\":\"slack:C1:1.2\",\"content\":[{\"type\":\"text\",\"text\":\"focus on tests\"}]}}}'",
      "printf '%s\\n' '{\"method\":\"item/completed\",\"params\":{\"threadId\":\"019fde26-53ca-7e51-9aa6-3a8c1fe0762c\",\"turnId\":\"turn-1\",\"item\":{\"id\":\"message-1\",\"type\":\"agentMessage\",\"text\":\"FIRST\"}}}'",
      "IFS= read -r steer_again",
      "case \"$steer_again\" in *'\"method\":\"turn/steer\"'*'\"expectedTurnId\":\"turn-1\"'*'final answer only'*) ;; *) exit 16;; esac",
      "printf '%s\\n' '{\"id\":5,\"result\":{\"turnId\":\"turn-1\"}}'",
      "printf '%s\\n' '{\"method\":\"item/completed\",\"params\":{\"threadId\":\"019fde26-53ca-7e51-9aa6-3a8c1fe0762c\",\"turnId\":\"turn-1\",\"item\":{\"id\":\"message-first-late\",\"type\":\"agentMessage\",\"text\":\"FIRST-LATE\"}}}'",
      "printf '%s\\n' '{\"method\":\"item/started\",\"params\":{\"threadId\":\"019fde26-53ca-7e51-9aa6-3a8c1fe0762c\",\"turnId\":\"turn-1\",\"item\":{\"id\":\"user-steer-2\",\"type\":\"userMessage\",\"clientId\":\"slack:C1:1.3\",\"content\":[{\"type\":\"text\",\"text\":\"final answer only\"}]}}}'",
      "printf '%s\\n' '{\"method\":\"item/completed\",\"params\":{\"threadId\":\"019fde26-53ca-7e51-9aa6-3a8c1fe0762c\",\"turnId\":\"turn-1\",\"item\":{\"id\":\"message-final\",\"type\":\"agentMessage\",\"text\":\"PONG\"}}}'",
      "printf '%s\\n' '{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"019fde26-53ca-7e51-9aa6-3a8c1fe0762c\",\"turn\":{\"id\":\"turn-1\",\"status\":\"completed\"}}}'",
    ]);
    let sender: SteeringSender | null = null;
    let providerTerminal = false;
    let startedProviderTurnId: string | null = null;
    let ready!: () => void;
    const steeringReady = new Promise<void>((resolve) => { ready = resolve; });

    try {
      const running = runCodexTurn({
        prompt: "initial prompt",
        cwd: dir,
        additionalDirs: ["/tmp/extra"],
        sessionUUID: null,
        executable,
        applicationInstructions: "Project instructions",
        clientUserMessageId: "slack-concierge:turn:1",
        onSteeringReady: (registered) => {
          sender = registered;
          ready();
        },
        onProviderTerminal: () => { providerTerminal = true; },
        onProviderTurnStarted: (providerTurnId) => { startedProviderTurnId = providerTurnId; },
      });
      await steeringReady;
      await sender!({ clientMessageId: "slack:C1:1.2", text: "focus on tests" });
      await sender!({ clientMessageId: "slack:C1:1.3", text: "final answer only" });

      expect(await running).toEqual({
        text: "PONG",
        sessionUUID: "019fde26-53ca-7e51-9aa6-3a8c1fe0762c",
        toolsUsed: [],
        providerTurnId: "turn-1",
      });
      expect(providerTerminal).toBe(true);
      expect(startedProviderTurnId).toBe("turn-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps replacement output when its user boundary precedes the steer response", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r thread",
      "printf '%s\\n' '{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread-order\"}}}'",
      "IFS= read -r turn",
      "printf '%s\\n' '{\"id\":3,\"result\":{\"turn\":{\"id\":\"turn-order\"}}}'",
      "printf '%s\\n' '{\"method\":\"turn/started\",\"params\":{\"threadId\":\"thread-order\",\"turn\":{\"id\":\"turn-order\",\"status\":\"inProgress\"}}}'",
      "IFS= read -r steer",
      "printf '%s\\n' '{\"method\":\"item/started\",\"params\":{\"threadId\":\"thread-order\",\"turnId\":\"turn-order\",\"item\":{\"id\":\"user-order\",\"type\":\"userMessage\",\"clientId\":\"slack:C1:1.2\",\"content\":[]}}}'",
      "printf '%s\\n' '{\"method\":\"item/completed\",\"params\":{\"threadId\":\"thread-order\",\"turnId\":\"turn-order\",\"item\":{\"id\":\"replacement-early\",\"type\":\"agentMessage\",\"text\":\"EARLY\"}}}'",
      "printf '%s\\n' '{\"id\":4,\"result\":{\"turnId\":\"turn-order\"}}'",
      "printf '%s\\n' '{\"method\":\"item/completed\",\"params\":{\"threadId\":\"thread-order\",\"turnId\":\"turn-order\",\"item\":{\"id\":\"replacement-final\",\"type\":\"agentMessage\",\"text\":\"FINAL\"}}}'",
      "printf '%s\\n' '{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"thread-order\",\"turn\":{\"id\":\"turn-order\",\"status\":\"completed\"}}}'",
    ]);
    let sender: SteeringSender | null = null;
    let ready!: () => void;
    const steeringReady = new Promise<void>((resolve) => { ready = resolve; });
    try {
      const running = runCodexTurn({
        prompt: "initial",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: null,
        executable,
        onSteeringReady: (value) => { sender = value; ready(); },
      });
      await steeringReady;
      await sender!({ clientMessageId: "slack:C1:1.2", text: "replacement" });
      expect((await running).text).toBe("EARLY\n\nFINAL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a steer acknowledgement for a different turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r thread",
      "printf '%s\\n' '{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread-audit\"}}}'",
      "IFS= read -r turn",
      "printf '%s\\n' '{\"id\":3,\"result\":{\"turn\":{\"id\":\"turn-audit\"}}}'",
      "printf '%s\\n' '{\"method\":\"turn/started\",\"params\":{\"threadId\":\"thread-audit\",\"turn\":{\"id\":\"turn-audit\",\"status\":\"inProgress\"}}}'",
      "IFS= read -r steer",
      "printf '%s\\n' '{\"id\":4,\"result\":{\"turnId\":\"wrong-turn\"}}'",
      "printf '%s\\n' '{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"thread-audit\",\"turn\":{\"id\":\"turn-audit\",\"status\":\"completed\"}}}'",
    ]);
    let sender: SteeringSender | null = null;
    let ready!: () => void;
    const steeringReady = new Promise<void>((resolve) => { ready = resolve; });

    try {
      const running = runCodexTurn({
        prompt: "initial",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: null,
        executable,
        onSteeringReady: (value) => { sender = value; ready(); },
      });
      await steeringReady;
      await expect(sender!({ clientMessageId: "slack:C1:1.2", text: "replacement" }))
        .rejects.toThrow("unexpected turn wrong-turn");
      expect((await running).text).toBe("(agent completed without a text reply)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resumes the requested thread and keeps its id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const sessionUUID = "019fde0c-d3e9-79f0-ac77-8cdab34a1be1";
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r thread",
      `case \"$thread\" in *'\"method\":\"thread/resume\"'*'\"threadId\":\"${sessionUUID}\"'*) ;; *) exit 13;; esac`,
      `printf '%s\\n' '{\"id\":2,\"result\":{\"thread\":{\"id\":\"${sessionUUID}\"}}}'`,
      "IFS= read -r turn",
      "printf '%s\\n' '{\"id\":3,\"result\":{\"turn\":{\"id\":\"turn-2\"}}}'",
      `printf '%s\\n' '{\"method\":\"turn/started\",\"params\":{\"threadId\":\"${sessionUUID}\",\"turn\":{\"id\":\"turn-2\",\"status\":\"inProgress\"}}}'`,
      `printf '%s\\n' '{\"method\":\"item/completed\",\"params\":{\"threadId\":\"${sessionUUID}\",\"turnId\":\"turn-2\",\"item\":{\"id\":\"message-2\",\"type\":\"agentMessage\",\"text\":\"CONTINUED\"}}}'`,
      `printf '%s\\n' '{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"${sessionUUID}\",\"turn\":{\"id\":\"turn-2\",\"status\":\"completed\"}}}'`,
    ]);

    try {
      const result = await runCodexTurn({
        prompt: "continue",
        cwd: dir,
        additionalDirs: [],
        sessionUUID,
        executable,
      });
      expect(result.sessionUUID).toBe(sessionUUID);
      expect(result.text).toBe("CONTINUED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports every supported Codex tool item once as live progress", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const item = (method: string, value: object) =>
      `printf '%s\\n' '${JSON.stringify({ method, params: { threadId: "thread-3", turnId: "turn-3", item: value } })}'`;
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r thread",
      "printf '%s\\n' '{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread-3\"}}}'",
      "IFS= read -r turn",
      "printf '%s\\n' '{\"id\":3,\"result\":{\"turn\":{\"id\":\"turn-3\"}}}'",
      "printf '%s\\n' '{\"method\":\"turn/started\",\"params\":{\"threadId\":\"thread-3\",\"turn\":{\"id\":\"turn-3\",\"status\":\"inProgress\"}}}'",
      "printf '%s\\n' '{\"method\":\"turn/started\",\"params\":{\"threadId\":\"subagent-thread\",\"turn\":{\"id\":\"subagent-turn\",\"status\":\"inProgress\"}}}'",
      item("item/completed", { id: "foreign-message", type: "agentMessage", text: "FOREIGN" }).replace('"threadId":"thread-3"', '"threadId":"subagent-thread"').replace('"turnId":"turn-3"', '"turnId":"subagent-turn"'),
      item("item/started", { id: "cmd-1", type: "commandExecution", command: "/bin/pwd" }),
      item("item/completed", { id: "cmd-1", type: "commandExecution", command: "/bin/pwd" }),
      item("item/started", { id: "mcp-1", type: "mcpToolCall", tool: "search" }),
      item("item/completed", { id: "mcp-1", type: "mcpToolCall", tool: "search" }),
      item("item/completed", { id: "file-1", type: "fileChange" }),
      item("item/completed", { id: "message-3", type: "agentMessage", text: "DONE" }),
      "printf '%s\\n' '{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"thread-3\",\"turn\":{\"id\":\"turn-3\",\"status\":\"completed\"}}}'",
    ]);
    const progress: string[] = [];

    try {
      const result = await runCodexTurn({
        prompt: "continue",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: null,
        executable,
        onProgress: (event) => {
          if (event.type === "tool_use") progress.push(event.toolName || "unknown");
        },
      });
      expect(progress).toEqual(["/bin/pwd", "search", "fileChange"]);
      expect(result.toolsUsed).toEqual(["/bin/pwd", "search", "fileChange"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects instead of crashing when the app server closes during initialization", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const executable = fakeCodex(dir, ["exit 1"]);

    try {
      await expect(runCodexTurn({
        prompt: "hello",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: null,
        executable,
      })).rejects.toThrow("codex app-server");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects promptly when the app server exits before turn/started", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r thread",
      "printf '%s\\n' '{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread-without-start\"}}}'",
      "IFS= read -r turn",
      "printf '%s\\n' '{\"id\":3,\"result\":{\"turn\":{\"id\":\"turn-without-start\"}}}'",
      "exit 19",
    ]);

    try {
      await expect(Promise.race([
        runCodexTurn({
          prompt: "hello",
          cwd: dir,
          additionalDirs: [],
          sessionUUID: null,
          executable,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 1_000)),
      ])).rejects.toThrow("codex app-server exited 19");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("times out a live app server that never answers JSON-RPC", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const executable = fakeCodex(dir, [
      "IFS= read -r initialize",
      "IFS= read -r forever",
    ]);

    try {
      await expect(runCodexTurn({
        prompt: "hello",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: null,
        executable,
        requestTimeoutMs: 20,
        inactivityTimeoutMs: 1_000,
        shutdownGraceMs: 10,
      })).rejects.toThrow("initialize timed out");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("terminates an active turn after provider protocol inactivity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r thread",
      "printf '%s\\n' '{\"id\":2,\"result\":{\"thread\":{\"id\":\"silent-thread\"}}}'",
      "IFS= read -r turn",
      "printf '%s\\n' '{\"id\":3,\"result\":{\"turn\":{\"id\":\"silent-turn\"}}}'",
      "printf '%s\\n' '{\"method\":\"turn/started\",\"params\":{\"threadId\":\"silent-thread\",\"turn\":{\"id\":\"silent-turn\",\"status\":\"inProgress\"}}}'",
      "while :; do printf '%s\\n' 'stderr noise' >&2; sleep 0.005; done",
    ]);

    try {
      await expect(runCodexTurn({
        prompt: "hello",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: null,
        executable,
        requestTimeoutMs: 1_000,
        inactivityTimeoutMs: 20,
        shutdownGraceMs: 10,
      })).rejects.toThrow("no protocol activity");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
