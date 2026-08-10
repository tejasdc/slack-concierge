import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAppServerArgs, runCodexTurn } from "../src/codex";
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

describe("codex app-server", () => {
  test("uses the bidirectional app-server transport", () => {
    expect(codexAppServerArgs()).toEqual(["app-server", "--stdio"]);
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
      "printf '%s\\n' '{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"thread-final\",\"turn\":{\"id\":\"turn-final\",\"status\":\"completed\"}}}'",
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
      expect(narration).toEqual(["I am still investigating.", "TL;DR: Final summary.\n\nDone."]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("starts a thread and steers its active turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r thread",
      "case \"$thread\" in *'\"method\":\"thread/start\"'*'\"sandbox\":\"danger-full-access\"'*) ;; *) exit 13;; esac",
      "printf '%s\\n' '{\"id\":2,\"result\":{\"thread\":{\"id\":\"019fde26-53ca-7e51-9aa6-3a8c1fe0762c\"}}}'",
      "IFS= read -r turn",
      "case \"$turn\" in *'\"method\":\"turn/start\"'*'initial prompt'*) ;; *) exit 14;; esac",
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
    let ready!: () => void;
    const steeringReady = new Promise<void>((resolve) => { ready = resolve; });

    try {
      const running = runCodexTurn({
        prompt: "initial prompt",
        cwd: dir,
        additionalDirs: ["/tmp/extra"],
        sessionUUID: null,
        executable,
        onSteeringReady: (registered) => {
          sender = registered;
          ready();
        },
        onProviderTerminal: () => { providerTerminal = true; },
      });
      await steeringReady;
      await sender!({ clientMessageId: "slack:C1:1.2", text: "focus on tests" });
      await sender!({ clientMessageId: "slack:C1:1.3", text: "final answer only" });

      expect(await running).toEqual({
        text: "PONG",
        sessionUUID: "019fde26-53ca-7e51-9aa6-3a8c1fe0762c",
        toolsUsed: [],
      });
      expect(providerTerminal).toBe(true);
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
    await expect(runCodexTurn({
      prompt: "hello",
      cwd: tmpdir(),
      additionalDirs: [],
      sessionUUID: null,
      executable: "/bin/false",
    })).rejects.toThrow("codex app-server");
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
