import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { runClaudeCodeTurn } from "../src/claude-code";
import { claudeHistoryMessages, readClaudeHistory, readClaudeHistoryDetail, type ProviderHistoryMessage } from "../src/provider-history";
import type { SteeringSender } from "../src/steering";

const session = "native-session";
function row(type: "user" | "assistant", uuid: string, content: unknown, extra: Record<string, unknown> = {}) {
  return { type, uuid, session_id: session, parent_tool_use_id: null,
    message: { role: type, content }, ...extra };
}

for (const sessionUUID of [null, session]) for (const echoFormat of ["string", "blocks"]) {
  test(`Claude native messages follow the exact current echo, steering and final, resume=${sessionUUID}, echo=${echoFormat}`, async () => {
    const text = "  Current request\n";
    const initial = row("user", "initial-native", echoFormat === "string" ? text : [{ type: "text", text }]);
    const tool = { type: "tool_use", id: "tool-native", name: "Read", input: { file_path: "exact native path" } };
    const otherTool = { type: "tool_use", id: "other-tool-native", name: "Read", input: { file_path: "second native path" } };
    const assistant = row("assistant", "assistant-native", [{ type: "text", text: "  Working\n" }, tool, otherTool]);
    const guidance = row("user", "steering-native", [{ type: "text", text: "Current guidance" }]);
    const result = { type: "tool_result", tool_use_id: "tool-native", content: "  Exact tool result\n" };
    const otherResult = { type: "tool_result", tool_use_id: "other-tool-native", content: [{ type: "text", text: "Second result" }] };
    const results = row("user", "results-native", [result, otherResult]);
    const final = row("assistant", "final-native", [{ type: "text", text: "  Final answer\n" }]);
    const ownedRows = [initial, assistant, guidance, results, final];
    const messages: ProviderHistoryMessage[] = [];
    const bindings: string[] = [];
    let acknowledged = 0;
    let ready!: () => void;
    let finish!: () => void;
    let sender!: SteeringSender;
    const registered = new Promise<void>(resolve => { ready = resolve; });
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const running = runClaudeCodeTurn({ prompt: text, cwd: "/tmp", additionalDirs: [], sessionUUID,
      onInputAcknowledged: () => { acknowledged++; },
      onProviderThreadStarted: id => { expect(acknowledged).toBe(1); bindings.push(id); },
      onProviderMessage: message => { expect(bindings).toEqual([session]); messages.push(message); },
      onSteeringReady: value => { sender = value; ready(); },
      transport: { async run(input) {
        const emit = (event: unknown) => input.onStdout(JSON.stringify(event) + "\n");
        input.onStdinReady?.(async line => {
          const request = JSON.parse(line);
          if (request.type === "control_request") {
            emit({ type: "control_response", response: { subtype: "success", request_id: request.request_id } });
            return;
          }
          emit(guidance);
          emit(results);
          emit(final);
          emit(final);
          emit({ type: "result", uuid: "terminal-receipt-is-not-a-history-message", session_id: session, result: "Final answer", is_error: false });
          finish();
        }, () => {});
        emit({ type: "system", subtype: "init", session_id: session });
        emit(row("user", "old-user", [{ type: "text", text: "Old notification" }]));
        emit(row("assistant", "old-assistant", [{ type: "text", text: "Old answer" }, tool]));
        emit({ type: "result", result: "Old failure", is_error: true });
        emit({ ...initial, uuid: "child-echo", parent_tool_use_id: "subagent-tool" });
        emit({ ...initial, uuid: "other-session-echo", session_id: "other-session" });
        expect(acknowledged).toBe(0);
        expect(messages).toEqual([]);
        emit(initial);
        emit(initial);
        emit(assistant);
        emit({ ...assistant, uuid: "subagent-message", parent_tool_use_id: "subagent-tool" });
        emit({ ...assistant, uuid: "other-session-message", session_id: "other-session" });
        emit(row("user", "unowned-notification", [{ type: "text", text: "Another background request" }]));
        emit(row("assistant", "unowned-answer", [{ type: "text", text: "Background answer" }]));
        await finished;
        return { code: 0, signal: null };
      } },
    });
    await Promise.race([registered, running.then(() => { throw new Error("Ended before steering"); })]);
    await sender({ text: "Current guidance", clientMessageId: "accepted-steering" });
    expect((await running).text).toBe("Final answer");
    expect(acknowledged).toBe(1);
    expect(messages.map(message => message.id)).toEqual([
      "initial-native", "assistant-native", "tool-native", "other-tool-native", "steering-native",
      "tool-native:result", "other-tool-native:result", "final-native",
    ]);
    const read = async () => ownedRows as SessionMessage[];
    const history = await readClaudeHistory({ sessionUuid: session, cwd: "/tmp", cursor: null, limit: 20 }, read);
    expect(messages).toEqual(history.messages);
    expect(messages[1]!.content).toBe("  Working\n");
    expect(messages.at(-1)!.content).toBe("  Final answer\n");
    for (const [messageId, part] of [["tool-native", tool], ["other-tool-native", otherTool],
      ["tool-native:result", result], ["other-tool-native:result", otherResult]] as const) {
      const message = messages.find(message => message.id === messageId)!;
      expect(message.content).toBe(JSON.stringify(part));
      expect(await readClaudeHistoryDetail({ sessionUuid: session, cwd: "/tmp", detailKey: message.detailKey! }, read))
        .toEqual({ content: JSON.stringify(part) });
    }
  });
}

test("missing optional Claude UUIDs never block acknowledgement or manufacture native message IDs", async () => {
  const messages: ProviderHistoryMessage[] = [];
  let acknowledged = 0;
  await runClaudeCodeTurn({ prompt: "Current", cwd: "/tmp", additionalDirs: [], sessionUUID: null,
    onInputAcknowledged: () => { acknowledged++; }, onProviderMessage: message => messages.push(message),
    transport: { async run(input) {
      input.onStdinReady?.(async () => {}, () => {});
      for (const event of [
        { type: "system", subtype: "init", session_id: session },
        { type: "user", message: { content: [{ type: "text", text: "Current" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "No native UUID" }] } },
        { ...row("assistant", "real-final-id", [{ type: "text", text: "Real final" }]), session_id: undefined },
        { type: "result", session_id: session, result: "Real final", is_error: false },
      ]) input.onStdout(JSON.stringify(event) + "\n");
      return { code: 0, signal: null };
    } },
  });
  expect(acknowledged).toBe(1);
  expect(messages).toEqual([{ id: "real-final-id", role: "assistant", turnId: "real-final-id", content: "Real final", tool: null, phase: null }]);
});

test("Claude live detail uses exact UUID and native tool identity, never a guessed row offset or path", async () => {
  const part = { type: "tool_use", id: "exact-tool", name: "Read", input: { file_path: "/not-an-authorized-host-read" } };
  const message = row("assistant", "exact-message", [part]);
  const normalized = claudeHistoryMessages(message, session)[0]!;
  const calls: any[] = [];
  const read = async (id: string, options: any) => {
    calls.push({ id, options });
    return [row("user", "earlier", "Before"), { ...message, message: { content: [{ type: "text", text: "Added native text" }, part] } }] as SessionMessage[];
  };
  expect(await readClaudeHistoryDetail({ sessionUuid: session, cwd: "/trusted/workspace", detailKey: normalized.detailKey! }, read))
    .toEqual({ content: JSON.stringify(part) });
  expect(calls).toEqual([{ id: session, options: { dir: "/trusted/workspace" } }]);
  await expect(readClaudeHistoryDetail({ sessionUuid: "wrong-session", cwd: "/trusted/workspace", detailKey: normalized.detailKey! }, read))
    .rejects.toThrow("INVALID_HISTORY_REFERENCE");
  expect(calls).toHaveLength(1);
  const legacy = Buffer.from(JSON.stringify({ version: 1, sessionUuid: session, offset: 0, uuid: "exact-message", index: 0 })).toString("base64url");
  expect(await readClaudeHistoryDetail({ sessionUuid: session, cwd: "/trusted/workspace", detailKey: legacy }, async (_id, options) => {
    expect(options).toEqual({ dir: "/trusted/workspace", offset: 0, limit: 1 });
    return [message] as SessionMessage[];
  })).toEqual({ content: JSON.stringify(part) });
  await expect(readClaudeHistoryDetail({ sessionUuid: session, cwd: "/trusted/workspace", detailKey: normalized.detailKey! }, async () => [
    { ...message, message: { content: [{ ...part, id: "different-tool" }] } } as SessionMessage,
  ])).rejects.toThrow("PROVIDER_HISTORY_ITEM_NOT_FOUND");
});

test("live Claude tool keys resolve through the pinned SDK against the exact retained native transcript", async () => {
  const root = mkdtempSync(join(tmpdir(), "concierge-native-message-detail-"));
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = join(root, "config");
    const cwd = join(root, "workspace");
    mkdirSync(cwd);
    const project = join(process.env.CLAUDE_CONFIG_DIR, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(project, { recursive: true });
    const sessionUuid = randomUUID();
    const first = randomUUID(), assistant = randomUUID(), result = randomUUID();
    const call = { type: "tool_use", id: "tool_sdk_exact", name: "Read", input: { file_path: "native-evidence-only" } };
    const output = { type: "tool_result", tool_use_id: call.id, content: "  Retained output\n" };
    const rows = [
      { type: "user", uuid: first, parentUuid: null, message: { role: "user", content: "Question" } },
      { type: "assistant", uuid: assistant, parentUuid: first, message: { role: "assistant", content: [call] } },
      { type: "user", uuid: result, parentUuid: assistant, message: { role: "user", content: [output] } },
    ].map(message => ({ ...message, sessionId: sessionUuid, cwd, isSidechain: false, timestamp: "2026-09-15T00:00:00.000Z", version: "2.1.263" }));
    const path = join(project, `${sessionUuid}.jsonl`);
    const original = rows.map(message => JSON.stringify(message)).join("\n") + "\n";
    writeFileSync(path, original);
    const live = rows.flatMap(message => claudeHistoryMessages({ ...message, session_id: sessionUuid }, sessionUuid));
    expect((await readClaudeHistory({ sessionUuid, cwd, cursor: null, limit: 10 })).messages).toEqual(live);
    for (const message of live.filter(message => message.role === "tool")) {
      expect(await readClaudeHistoryDetail({ sessionUuid, cwd, detailKey: message.detailKey! }))
        .toEqual({ content: message.content });
    }
    expect(readFileSync(path, "utf8")).toBe(original);
  } finally {
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    rmSync(root, { recursive: true, force: true });
  }
});
