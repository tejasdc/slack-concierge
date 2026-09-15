import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { forkClaudeHistory, readClaudeHistory, readClaudeHistoryDetail, readCodexHistory,
  readCodexHistoryDetail } from "../src/provider-history";
import { codexConsultationConfig } from "../src/provider-policy";

describe("native provider history", () => {
  test("Codex keeps native identities, order and exact tool details without starting or resuming a thread", async () => {
    const calls: Array<{ method: string; params: any }> = [];
    const tool = { id: "tool-native", type: "commandExecution", command: "exact historical command", status: "completed" };
    const request = async (method: string, params: any) => {
      calls.push({ method, params });
      if (params.turnId) return { data: [{ turnId: "turn-native", item: tool }], nextCursor: null };
      if (params.cursor) return { data: [{ turnId: "earlier", item: { id: "user-native", type: "userMessage", clientId: "accepted-input", content: [{ type: "text", text: "Exact question\n" }] } }], nextCursor: null };
      return { data: [
        { turnId: "turn-native", item: { id: "answer-native", type: "agentMessage", phase: "final_answer", text: "  Exact answer  " } },
        { turnId: "turn-native", item: tool },
      ], nextCursor: "native-cursor" };
    };
    const input = { sessionUuid: "thread-native", cwd: "/tmp", cursor: null, limit: 2 };
    const page = await readCodexHistory(input, request);
    expect(page.messages.map(message => message.id)).toEqual(["tool-native", "answer-native"]);
    expect(page.messages[1]).toMatchObject({ turnId: "turn-native", content: "  Exact answer  ", phase: "final_answer" });
    expect(await readCodexHistory({ ...input, cursor: page.nextCursor }, request)).toMatchObject({ messages: [
      { id: "user-native", role: "user", submissionId: "accepted-input", turnId: "earlier", content: "Exact question\n" },
    ], nextCursor: null });
    const detail = { sessionUuid: input.sessionUuid, cwd: input.cwd, detailKey: page.messages[0]!.detailKey! };
    expect(await readCodexHistoryDetail(detail, request)).toEqual({ content: JSON.stringify(tool) });
    expect(calls.every(call => call.method === "thread/items/list")).toBeTrue();
    expect(calls.at(-1)?.params).toMatchObject({ threadId: input.sessionUuid, turnId: "turn-native" });
    const reads = calls.length;
    await expect(readCodexHistory({ ...input, sessionUuid: "other-thread", cursor: page.nextCursor }, request)).rejects.toThrow("INVALID_HISTORY_REFERENCE");
    await expect(readCodexHistoryDetail({ ...detail, sessionUuid: "other-thread" }, request)).rejects.toThrow("INVALID_HISTORY_REFERENCE");
    expect(calls).toHaveLength(reads);
  });

  test("Codex reports omitted native media and rejects missing or wrong-turn detail", async () => {
    const input = { sessionUuid: "thread", cwd: "/tmp", cursor: null, limit: 2 };
    const page = await readCodexHistory(input, async () => ({ data: [
      { turnId: "one", item: { id: "tool", type: "futureNativeTool", status: "completed" } },
      { turnId: "one", item: { id: "user", type: "userMessage", content: [{ type: "image", url: "private" }] } },
    ], nextCursor: null }));
    expect(page.coverage).toMatchObject({ complete: false });
    await expect(readCodexHistoryDetail({ ...input, detailKey: page.messages[1]!.detailKey! }, async () => ({
      data: [{ turnId: "other", item: { id: "tool", type: "futureNativeTool" } }], nextCursor: null,
    }))).rejects.toThrow("PROVIDER_HISTORY_ITEM_NOT_FOUND");
    await expect(readCodexHistory(input, async () => ({ data: [], nextCursor: undefined }))).rejects.toThrow("PROVIDER_HISTORY_INVALID");
  });

  test("Claude pagination follows native ancestry and rejects changed anchors and cross-session detail", async () => {
    const sessionUuid = "claude-native";
    const rows: SessionMessage[] = [
      { type: "user", uuid: "user-native", message: { content: "Initial question" } },
      { type: "assistant", uuid: "assistant-native", message: { content: [{ type: "tool_use", id: "tool-native", name: "Read", input: { file_path: "retained-path" } }] } },
      { type: "user", uuid: "tool-result-native", message: { content: [{ type: "tool_result", tool_use_id: "tool-native", content: "Exact result" }] } },
      { type: "assistant", uuid: "final-native", message: { content: [{ type: "text", text: "  Answer\n" }] } },
    ].map(row => ({ ...row, session_id: sessionUuid, parent_tool_use_id: null, parent_agent_id: null } as SessionMessage));
    const calls: any[] = [];
    const read = async (id: string, options: any = {}) => {
      calls.push({ id, options });
      return rows.slice(options.offset ?? 0, options.limit === undefined ? undefined : (options.offset ?? 0) + options.limit);
    };
    const input = { sessionUuid, cwd: "/workspace", cursor: null, limit: 2 };
    const page = await readClaudeHistory(input, read);
    expect(page.messages.map(message => message.id)).toEqual(["tool-native:result", "final-native"]);
    expect(page.messages[0]).toMatchObject({ toolCallId: "tool-native", turnId: "tool-result-native" });
    expect(page.messages[1]!.content).toBe("  Answer\n");
    const earlier = await readClaudeHistory({ ...input, cursor: page.nextCursor }, read);
    expect(earlier.messages.map(message => message.id)).toEqual(["user-native", "tool-native"]);
    expect(earlier.messages[0]!.submissionId).toBe("user-native");
    expect(earlier.nextCursor).toBeNull();
    const detail = { sessionUuid, cwd: input.cwd, detailKey: page.messages[0]!.detailKey! };
    expect(await readClaudeHistoryDetail(detail, read)).toEqual({ content: JSON.stringify((rows[2]!.message as any).content[0]) });
    expect(calls.every(call => call.id === sessionUuid && call.options.dir === input.cwd)).toBeTrue();
    const count = calls.length;
    await expect(readClaudeHistoryDetail({ ...detail, sessionUuid: "other" }, read)).rejects.toThrow("INVALID_HISTORY_REFERENCE");
    expect(calls).toHaveLength(count);
    rows[2] = { ...rows[2]!, uuid: "changed-branch" };
    await expect(readClaudeHistory({ ...input, cursor: page.nextCursor }, read)).rejects.toThrow("STALE_HISTORY_CURSOR");
    await expect(readClaudeHistoryDetail(detail, read)).rejects.toThrow("STALE_HISTORY_CURSOR");
  });

  test("Claude exact fork passes only a verified native message boundary and refuses restricted forks before reads", async () => {
    let forks = 0;
    let reads = 0;
    const native = {
      async read() { reads++; return [{ session_id: "source", uuid: "native-message" } as SessionMessage]; },
      async fork(id: string, options: any) {
        forks++;
        expect(id).toBe("source");
        expect(options).toEqual({ dir: "/workspace", upToMessageId: "native-message" });
        return { sessionId: "child" };
      },
    };
    const input = { sessionUuid: "source", cwd: "/workspace", boundary: "native-message" };
    expect(await forkClaudeHistory(input, native)).toMatchObject({ sessionUUID: "child", providerTurnId: null, toolsUsed: [] });
    await expect(forkClaudeHistory({ ...input, boundary: "guessed-provider-turn" }, native)).rejects.toThrow("PROVIDER_FORK_BOUNDARY_NOT_FOUND");
    expect(forks).toBe(1);
    expect(reads).toBe(2);
    await expect(forkClaudeHistory({ ...input, interactionPolicy: "consultation-only" }, native)).rejects.toThrow("information-only");
    expect(reads).toBe(2);
  });

  test("the pinned Claude SDK reads and forks an exact synthetic native parent chain without a model run", async () => {
    const root = mkdtempSync(join(tmpdir(), "concierge-claude-history-"));
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = join(root, "config");
      const cwd = join(root, "workspace");
      mkdirSync(cwd);
      const project = join(process.env.CLAUDE_CONFIG_DIR, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(project, { recursive: true });
      const sessionUuid = randomUUID();
      const first = randomUUID();
      const boundary = randomUUID();
      const after = randomUUID();
      const messages = [
        { type: "user", uuid: first, parentUuid: null, message: { role: "user", content: "First" } },
        { type: "assistant", uuid: boundary, parentUuid: first, message: { role: "assistant", content: [{ type: "text", text: "Boundary answer" }] } },
        { type: "user", uuid: after, parentUuid: boundary, message: { role: "user", content: "After boundary" } },
      ].map(message => ({ ...message, sessionId: sessionUuid, cwd, isSidechain: false, timestamp: "2026-09-15T00:00:00.000Z", version: "2.1.263" }));
      const path = join(project, `${sessionUuid}.jsonl`);
      const original = messages.map(message => JSON.stringify(message)).join("\n") + "\n";
      writeFileSync(path, original);
      const page = await readClaudeHistory({ sessionUuid, cwd, cursor: null, limit: 10 });
      expect(page.messages.map(message => message.turnId)).toEqual([first, boundary, after]);
      const child = await forkClaudeHistory({ sessionUuid, cwd, boundary });
      expect(child.sessionUUID).not.toBe(sessionUuid);
      const fork = await readClaudeHistory({ sessionUuid: child.sessionUUID!, cwd, cursor: null, limit: 10 });
      expect(fork.messages.map(message => message.content)).toEqual(["First", "Boundary answer"]);
      expect(readFileSync(path, "utf8")).toBe(original);
    } finally {
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfig;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("consultation disables configured MCP names without interpreting dots as config traversal", () => {
    const config = codexConsultationConfig({ mcp_servers: { "session.actions": {}, "a\"b": {} } });
    expect(config.mcp_servers).toEqual({ "session.actions": { enabled: false }, 'a"b': { enabled: false } });
    expect(config["permissions.concierge-consultation.filesystem"]).toEqual({ ":root": "deny" });
  });
});
