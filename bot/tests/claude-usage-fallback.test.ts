import { expect, test } from "bun:test";
import { runClaudeCodeTurn, type ClaudeCodeTransport } from "../src/claude-code";
import { CLAUDE_USAGE_FALLBACK_CHAIN, claudeUsageFallbackModels } from "../src/aliases";
import { ProviderDispatchError, ProviderTurnCancelledError } from "../src/provider-failures";
import type { SteeringSender } from "../src/steering";

const sessionId = "11111111-1111-4111-8111-111111111111";
const creditError = "You're out of usage credits. Switch to another model, or manage usage credits to continue.";

function fixture(options: {
  model?: string; failures?: number; error?: string; structured?: boolean;
  switchMode?: "reject" | "silent" | "cancel" | "missing-replay" | "transport-error" | "steer";
} = {}) {
  const writes: any[] = [];
  const preferred: string[] = [];
  const progress: any[] = [];
  let terminals = 0;
  let cancel: (() => Promise<void>) | undefined;
  let steer: SteeringSender | undefined;
  let steering: Promise<void> | undefined;
  const transport: ClaudeCodeTransport = { async run(input) {
    let model = options.model || "claude-fable-5-1";
    let requestCount = 0;
    const closed = Promise.withResolvers<{ code: number; signal: null }>();
    const emit = (event: any) => input.onStdout(JSON.stringify({ session_id: sessionId, ...event }) + "\n");
    const respond = (message: any) => {
      if (options.switchMode !== "missing-replay" || requestCount === 0) emit(message);
      if (requestCount++ === 0) emit({ type: "assistant", message: { model, content: [{ type: "tool_use", name: "Read", id: "once" }] } });
      const error = requestCount <= (options.failures ?? 1);
      if (options.structured) emit({ type: "rate_limit_event", rate_limit_info: { status: error ? "rejected" : "allowed" } });
      if (!error) emit({ type: "assistant", message: { model, content: [{ type: "text", text: "TL;DR: preserved context" }] } });
      emit({ type: "result", is_error: error, result: error ? options.error || creditError : "TL;DR: preserved context", duration_ms: error ? 999 : 123 });
    };
    input.onStdinReady?.(async (line) => {
      const event = JSON.parse(line); writes.push(event);
      if (event.request?.subtype === "interrupt") {
        emit({ type: "control_response", response: { request_id: event.request_id, subtype: "success" } });
        return;
      }
      if (event.type === "control_request") {
        if (options.switchMode === "silent") return;
        if (options.switchMode === "transport-error") { closed.reject(new Error("transport disconnected")); return; }
        if (options.switchMode === "cancel") { await cancel?.(); return; }
        if (options.switchMode === "steer") steering = steer?.({ text: "Latest user guidance", clientMessageId: "guidance" });
        model = event.request.model;
        // Real set_model emits a local-command user replay before its response.
        emit({ type: "user", message: { content: `<local-command-stdout>Set model to ${model}</local-command-stdout>` } });
        emit({ type: "control_response", response: { request_id: event.request_id, subtype: options.switchMode === "reject" ? "error" : "success", error: "model blocked" } });
        emit({ type: "system", subtype: "init", model });
      } else respond(event);
    }, () => closed.resolve({ code: 0, signal: null }));
    emit({ type: "system", subtype: "init", model });
    respond(JSON.parse(input.stdin));
    return closed.promise;
  } };
  const result = runClaudeCodeTurn({ prompt: "Original user request", cwd: "/tmp", additionalDirs: [], sessionUUID: sessionId,
    transport, modelSwitchTimeoutMs: 10,
    onPreferredModel: model => preferred.push(model), onProgress: event => progress.push(event),
    onProviderTerminal: () => { terminals++; }, onCancellationReady: value => { cancel = value; },
    onSteeringReady: value => { steer = value; },
  });
  return { result, writes, preferred, progress, terminals: () => terminals, steering: () => steering };
}

test("usage fallback preserves session, completed tools, preferred model and one terminal boundary", async () => {
  const run = fixture();
  expect(await run.result).toEqual({ text: "TL;DR: preserved context", model: "claude-opus-5", sessionUUID: sessionId, toolsUsed: ["Read"], durationMs: 123 });
  expect(run.preferred).toEqual(["claude-fable-5-1"]);
  expect(run.terminals()).toBe(1);
  expect(run.writes.map(event => event.request?.model).filter(Boolean)).toEqual(["claude-opus-5"]);
  expect(run.writes.filter(event => event.type === "user").map(event => event.message.content[0].text))
    .toEqual([expect.stringContaining("\n\nOriginal user request")]);
  expect(run.progress.filter(event => event.type === "done")).toHaveLength(1);
  expect(run.progress.some(event => event.type === "steering")).toBe(false);
});

test("structured usage rejection walks the ordered chain once and parks when exhausted", async () => {
  const run = fixture({ failures: 4, structured: true, error: "Usage exhausted" });
  const failure = await run.result.catch(error => error);
  expect(failure).toBeInstanceOf(ProviderDispatchError);
  expect(failure.failureClass).toBe('parked_terminal');
  expect(failure.message).toContain('Retry after usage resets, or ask the DM router to continue with Codex');
  expect(run.writes.filter(event => event.request?.model).map(event => event.request.model)).toEqual(["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"]);
  const replays = run.writes.filter(event => event.type === "user").map(event => event.message.content[0].text);
  expect(replays).toHaveLength(3);
  expect(new Set(replays).size).toBe(1);
  expect(replays[0]).toContain("\n\nOriginal user request");
  expect(run.terminals()).toBe(1);
});

test.each(["Invalid API key", "Subscription access disabled", "HTTP 429 rate limit", "ECONNRESET", "Your credit card was declined", "You've hit your tool-call limit", "Server error while displaying: You're out of usage credits"])("unrelated failure does not switch models: %s", async error => {
  const run = fixture({ error });
  await expect(run.result).rejects.toBeInstanceOf(ProviderDispatchError);
  expect(run.writes).toEqual([]);
});

test.each([
  ["reject", "model blocked"], ["silent", "did not acknowledge the fallback model switch"],
  ["missing-replay", "before acknowledging the fallback continuation"], ["transport-error", "transport disconnected"],
] as const)("%s never retries an ambiguous model switch", async (switchMode, message) => {
  const run = fixture({ switchMode });
  await expect(run.result).rejects.toThrow(message);
  expect(run.writes.filter(event => event.request?.model)).toHaveLength(1);
});

test("Stop during a model switch cancels without sending a continuation", async () => {
  const run = fixture({ switchMode: "cancel" });
  await expect(run.result).rejects.toBeInstanceOf(ProviderTurnCancelledError);
  expect(run.writes.some(event => event.type === "user")).toBe(false);
});

test("steering received during a model switch waits and retains its exact acknowledgement", async () => {
  const run = fixture({ switchMode: "steer" });
  await run.result;
  await run.steering();
  expect(run.progress.filter(event => event.type === "steering")).toEqual([{ type: "steering", clientMessageId: "guidance" }]);
  expect(run.writes.at(-1).message.content[0].text).toBe("Latest user guidance");
  expect(run.terminals()).toBe(1);
});

test("healthy or unknown models do not switch; smaller selections only fall downward", async () => {
  const healthy = fixture({ failures: 0 }); await healthy.result;
  expect(healthy.writes).toEqual([]);
  const unknown = fixture({ model: "custom-model" }); await expect(unknown.result).rejects.toBeInstanceOf(ProviderDispatchError);
  expect(unknown.writes).toEqual([]);
  expect(claudeUsageFallbackModels("claude-opus-5")).toEqual(["claude-sonnet-5", "claude-haiku-4-5-20251001"]);
  expect(claudeUsageFallbackModels("claude-sonnet-5")).toEqual(["claude-haiku-4-5-20251001"]);
  expect(claudeUsageFallbackModels("claude-haiku-4-5")).toEqual([]);
});

test("fallback configuration uses exact IDs and explicitly covers the existing Fable 5 session", async () => {
  expect(CLAUDE_USAGE_FALLBACK_CHAIN).toEqual(["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"]);
  for (const model of ["fable", "claude-fable-6", "claude-opus-4-6", "claude-sonnet-custom", "claude-haiku-4-5-20251001"]) {
    expect(claudeUsageFallbackModels(model)).toEqual([]);
  }
  const legacy = fixture({ model: "claude-fable-5" });
  expect(await legacy.result).toMatchObject({ model: "claude-opus-5", sessionUUID: sessionId });
  expect(legacy.preferred).toEqual(["claude-fable-5"]);
});

test.each(["You've hit your limit · resets tomorrow", "You've hit your weekly limit", "You’re out of usage credits"])("explicit usage exhaustion switches models: %s", async error => {
  expect(await fixture({ error }).result).toMatchObject({ model: "claude-opus-5", sessionUUID: sessionId });
});

test("fallback replays the complete accepted input and acknowledged steering in order", async () => {
  const original = "Original voice transcript\n\nKeep the exact 🔑 marker and spacing.\n";
  const guidance = "Correction: use the second destination.\nDo not repeat completed work.";
  const writes: any[] = [];
  let steering!: Promise<void>;
  const transport: ClaudeCodeTransport = { async run(input) {
    const closed = Promise.withResolvers<{ code: number; signal: null }>();
    const emit = (event: any) => input.onStdout(JSON.stringify({ session_id: sessionId, ...event }) + "\n");
    input.onStdinReady?.(async line => {
      const event = JSON.parse(line); writes.push(event);
      if (event.type === "control_request") {
        emit({ type: "control_response", response: { request_id: event.request_id, subtype: "success" } });
        return;
      }
      emit(event);
      const rejected = event.message.content[0].text === guidance;
      emit({ type: "result", is_error: rejected, result: rejected ? creditError : "TL;DR: continued the corrected task" });
    }, () => closed.resolve({ code: 0, signal: null }));
    emit({ type: "system", subtype: "init", model: "claude-fable-5-1" });
    emit(JSON.parse(input.stdin));
    return closed.promise;
  } };
  await runClaudeCodeTurn({ prompt: original, cwd: "/tmp", additionalDirs: [], sessionUUID: sessionId, transport,
    onSteeringReady: sender => { steering = sender({ text: guidance, clientMessageId: "corrected-task" }); },
  });
  await steering;
  const retry = writes.filter(event => event.type === "user").at(-1).message.content[0].text;
  expect(retry).toEndWith(`\n\n${original}\n\n${guidance}`);
  expect(writes.filter(event => event.request?.subtype === "set_model")).toHaveLength(1);
});

test.each([false, true])("steering replaces old usage evidence while retaining a new rejection before replay (%s)", async (newRejection) => {
  const writes: any[] = [];
  let sender!: SteeringSender;
  let steering!: Promise<void>;
  const transport: ClaudeCodeTransport = { async run(input) {
    const closed = Promise.withResolvers<{ code: number; signal: null }>();
    const emit = (event: any) => input.onStdout(JSON.stringify({ session_id: sessionId, ...event }) + "\n");
    let interruptId = "";
    input.onStdinReady?.(async line => {
      const event = JSON.parse(line); writes.push(event);
      if (event.request?.subtype === "interrupt") { interruptId = event.request_id; return; }
      if (event.request?.subtype === "set_model") {
        emit({ type: "control_response", response: { request_id: event.request_id, subtype: "error", error: "model unavailable" } });
        return;
      }
      if (newRejection) emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } });
      emit(event);
      emit({ type: "result", is_error: true, result: newRejection ? "Usage exhausted" : "Invalid API key" });
    }, () => closed.resolve({ code: 0, signal: null }));
    emit({ type: "system", subtype: "init", model: "claude-fable-5-1" });
    emit(JSON.parse(input.stdin));
    steering = sender({ text: "Latest guidance", clientMessageId: "latest" });
    emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } });
    emit({ type: "result", is_error: true, result: creditError });
    queueMicrotask(() => emit({ type: "control_response", response: { request_id: interruptId, subtype: "success" } }));
    return closed.promise;
  } };
  await expect(runClaudeCodeTurn({ prompt: "Original", cwd: "/tmp", additionalDirs: [], sessionUUID: sessionId,
    transport, onSteeringReady: value => { sender = value; },
  })).rejects.toThrow(newRejection ? "model unavailable" : "Invalid API key");
  await steering;
  expect(writes.filter(event => event.request?.subtype === "set_model")).toHaveLength(newRejection ? 1 : 0);
});
