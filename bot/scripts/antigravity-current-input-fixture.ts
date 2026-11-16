import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mock } from "bun:test";

const state = await mkdtemp(join(tmpdir(), "antigravity-current-input-"));
Object.assign(process.env, { CONCIERGE_STATE_DIR: state, CONCIERGE_CAPTURE_STATE_DIR: join(state, "capture"),
  CONCIERGE_TURN_RUNNERS: "marked" });
let refreshCalls = 0;
let noticeCalls = 0;
mock.module("../src/provider-account-usage", () => ({
  scheduleProviderAccountUsageRefreshAfterCurrent: async () => { refreshCalls++; },
  providerAccountUsage: () => null,
  storedProviderAccountLabels: () => [],
}));
mock.module("../src/state-database", () => ({ db: {} }));
mock.module("../src/provider-free-notice", () => ({ publishProviderFreeNotice: () => { noticeCalls++; } }));
mock.module("../src/google-quota-disagreement", () => ({ googleQuotaDisagreement: () => ({ text: "fixture notice" }) }));
const { runAntigravityTurn } = await import("../src/antigravity");
const conversationId = "cac65334-e28b-4bd3-a223-80e0b7a361d7";
const quota = "Individual quota reached. Resets in 3h18m12s.";
const init = { event: "init", conversation_id: conversationId, init: { permission_mode: "always-proceed" } };
const userInput = (step_index: number) => ({ event: "step_update", step_update: { step_index, step_type: "user_input", state: "DONE" } });
const response = (step_index: number, text: string) => [
  { event: "step_update", step_update: { step_index, step_type: "agent_response", state: "ACTIVE", text_delta: text.slice(0, 7) } },
  { event: "step_update", step_update: { step_index, step_type: "agent_response", state: "DONE", text_delta: text.slice(7) } },
];
const result = (text: string, error = quota, status = "ERROR") => ({ event: "result", result: {
  conversation_id: conversationId, status, response: text, error, num_turns: 512, usage: { total_tokens: 46_670_921 },
} });

function transport(events: unknown[], options: { replayed?: boolean; onFeed?: (feed: (event: unknown) => void, callbacks: any) => Promise<void> } = {}) {
  return { async run(input: any) {
    const callbacks: any = {};
    input.onStdinReady((line: string) => { callbacks.writes = (callbacks.writes ?? 0) + 1; callbacks.lastLine = line; return Promise.resolve(); },
      () => { callbacks.closed = true; });
    input.onInterruptReady(() => Promise.resolve());
    const feed = (event: unknown) => input.onStdout(`${JSON.stringify(event)}\n`);
    if (options.replayed) input.onReplayedInput?.("{}\n", { kind: "steering", clientMessageId: "adopted-1", commandId: "fixture" }, 1, "written");
    for (const event of events) feed(event);
    if (options.onFeed) await options.onFeed(feed, callbacks);
    if (options.replayed) input.onReplayEnd?.();
    return { code: 0, signal: null };
  } };
}

const run = (events: unknown[], overrides: Record<string, unknown> = {}) => runAntigravityTurn({
  prompt: "sanitized fixture input", cwd: "/tmp", additionalDirs: [], environment: {}, model: "gemini-3.8-flash-high",
  transport: transport(events) as any, ...overrides,
} as any);
const rejected = async (events: unknown[], overrides: Record<string, unknown> = {}) => {
  try { await run(events, overrides); assert.fail("expected the current input to fail"); }
  catch (error) { assert.notEqual((error as Error).message, "expected the current input to fail"); return error as Error & Record<string, any>; }
};

try {
  // Sanitized retained-shape regression: conversation aggregates say ERROR and retain quota prose,
  // while a later current response is complete and has no current error step.
  const successfulText = "sanitized-final-response-1141";
  const staleSuccess = await run([init, userInput(7209), ...response(7225, successfulText), result(successfulText)]);
  assert.equal(staleSuccess.text, successfulText);
  assert.equal(staleSuccess.toolsUsed.length, 0);
  assert.equal(noticeCalls, 0, "historical quota aggregate creates no quota notice");

  // The CLI terminal response concatenates every response step in the input interval, including
  // narration before and after tools, rather than containing only the final response step.
  const narratedParts = ["N".repeat(158), "M".repeat(161), "F".repeat(2040)];
  const narratedResponse = narratedParts.join("");
  const narratedEvents = [init, userInput(7209), ...response(7210, narratedParts[0]!),
    { event: "step_update", step_update: { step_index: 7211, step_type: "tool", state: "ACTIVE", tool_name: "read" } },
    { event: "step_update", step_update: { step_index: 7211, step_type: "tool", state: "DONE", tool_name: "read" } },
    ...response(7212, narratedParts[1]!), ...response(7213, narratedParts[2]!)];
  const narratedSuccess = await run([...narratedEvents, result(narratedResponse, "", "SUCCESS")]);
  assert.equal(narratedSuccess.text, narratedResponse);
  assert.deepEqual(narratedSuccess.toolsUsed, ["read"]);
  const narratedStaleError = await run([...narratedEvents, result(narratedResponse)]);
  assert.equal(narratedStaleError.text, narratedResponse);
  assert.deepEqual(narratedStaleError.toolsUsed, ["read"]);
  const narratedMismatch = await rejected([...narratedEvents, result(`${narratedResponse}!`)]);
  assert.match(narratedMismatch.message, /unconfirmed/i);
  assert.doesNotMatch(narratedMismatch.message, /quota|Resets in/i);
  assert.equal(narratedMismatch.terminalConfirmed, false);
  assert.equal(noticeCalls, 0, "mismatched historical quota aggregate creates no quota notice");

  // An aggregate ERROR without a complete match must not leak old quota prose to failure routing.
  const incomplete = await rejected([init, userInput(7209), ...response(7225, "different-current-response"), result("historical-terminal-response")]);
  assert.match(incomplete.message, /unconfirmed/i);
  assert.doesNotMatch(incomplete.message, /quota|Resets in/i);
  assert.equal(incomplete.terminalConfirmed, false);
  const missingFinal = await rejected([init, userInput(7209), ...response(7225, ""), result("")]);
  assert.match(missingFinal.message, /unconfirmed/i);
  assert.equal(missingFinal.terminalConfirmed, false);
  const wrongConversation = await rejected([init, { event: "step_update", step_update: {
    step_index: 7209, step_type: "user_input", state: "DONE", conversation_id: "11111111-1111-4111-8111-111111111111",
  } }]);
  assert.match(wrongConversation.message, /different conversation/);
  const canceled = await rejected([init, userInput(7209), ...response(7225, "current response"), result("current response", "", "CANCELED")]);
  assert.match(canceled.message, /unconfirmed/i, "a complete response cannot override a non-ERROR terminal status");

  // A true current error remains a failure after tool activity; empty error-step payload uses the
  // terminal's detail. The fixture uses a non-quota diagnostic to avoid any account refresh call.
  const currentFailure = await rejected([init, userInput(7209),
    { event: "step_update", step_update: { step_index: 7210, step_type: "tool", state: "ACTIVE", tool_name: "read" } },
    { event: "step_update", step_update: { step_index: 7210, step_type: "tool", state: "DONE", tool_name: "read" } },
    { event: "step_update", step_update: { step_index: 7211, step_type: "error_message", state: "DONE" } },
    result("", "current tool failure", "ERROR")]);
  assert.match(currentFailure.message, /current tool failure/);
  assert.deepEqual(currentFailure.toolsUsed, ["read"]);

  // Current quota evidence still takes the existing refresh/notice and confirmed-refusal path.
  const quotaBeforeWork = await rejected([init, userInput(7209),
    { event: "step_update", step_update: { step_index: 7210, step_type: "error_message", state: "DONE", text_delta: quota } },
    { event: "result", result: { conversation_id: conversationId, status: "ERROR", response: "", error: quota,
      num_turns: 1, usage: { total_tokens: 0 } } }]);
  assert.match(quotaBeforeWork.message, /quota/);
  assert.equal(quotaBeforeWork.terminalConfirmed, true);
  const quotaAfterTools = await rejected([init, userInput(7209),
    { event: "step_update", step_update: { step_index: 7210, step_type: "tool", state: "ACTIVE", tool_name: "read" } },
    { event: "step_update", step_update: { step_index: 7210, step_type: "tool", state: "DONE", tool_name: "read" } },
    { event: "step_update", step_update: { step_index: 7211, step_type: "error_message", state: "DONE" } },
    { event: "result", result: { conversation_id: conversationId, status: "ERROR", response: "", error: quota,
      num_turns: 512, usage: { total_tokens: 46_670_921 } } }]);
  assert.match(quotaAfterTools.message, /quota/);
  assert.equal(quotaAfterTools.terminalConfirmed, true);
  assert.deepEqual(quotaAfterTools.toolsUsed, ["read"]);
  assert.equal(refreshCalls, 2);
  assert.equal(noticeCalls, 2);

  // Model-unavailable refusal before init remains a definite pre-start failure with its detail.
  const refusedBeforeStart = await rejected([{ event: "result", result: { status: "ERROR", error: "model unavailable",
    num_turns: 0, usage: { total_tokens: 0 } } }]);
  assert.match(refusedBeforeStart.message, /model unavailable/);
  assert.equal(refusedBeforeStart.terminalConfirmed, true);

  // An earlier current failure remains authoritative after a later FIFO input succeeds.
  const earlierFailure = await rejected([init, userInput(7209),
    { event: "step_update", step_update: { step_index: 7210, step_type: "error_message", state: "DONE", text_delta: "first input failed" } },
    { event: "result", result: { conversation_id: conversationId, status: "ERROR", error: "first input failed", num_turns: 512 } },
    userInput(7226), ...response(7227, "later completed response"), result("later completed response")]);
  assert.match(earlierFailure.message, /first input failed/);
  const earlierUnconfirmed = await rejected([init, userInput(7209), ...response(7210, "not the terminal response"),
    result("unmatched response"), userInput(7226), ...response(7227, "later valid response"),
    { event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: "later valid response",
      num_turns: 513, usage: { total_tokens: 46_919_902 } } }]);
  assert.match(earlierUnconfirmed.message, /unconfirmed/i);

  // Two FIFO steering inputs each get their own current-input response despite aggregate errors.
  let steer!: (input: { text: string; clientMessageId: string }) => Promise<void>;
  const steerTransport = transport([init, userInput(7209), ...response(7210, "first sanitized response")], {
    onFeed: async (feed, callbacks) => {
      void callbacks;
      const first = steer({ text: "first steering", clientMessageId: "steer-1" });
      const second = steer({ text: "second steering", clientMessageId: "steer-2" });
      await Promise.resolve();
      feed(result("first sanitized response"));
      feed(userInput(7226));
      feed(response(7227, "second sanitized response")[0]);
      feed(response(7227, "second sanitized response")[1]);
      feed(result("second sanitized response"));
      feed(userInput(7243));
      feed(response(7244, "third sanitized response")[0]);
      feed(response(7244, "third sanitized response")[1]);
      feed(result("third sanitized response"));
      await Promise.all([first, second]);
    },
  });
  const messages: string[] = [];
  const sequential = await runAntigravityTurn({ prompt: "initial", cwd: "/tmp", additionalDirs: [], environment: {},
    transport: steerTransport as any, onSteeringReady: (handler: typeof steer) => { steer = handler; },
    onProviderMessage: event => messages.push(event.content), } as any);
  assert.equal(sequential.text, "third sanitized response");
  assert.deepEqual(messages, ["first sanitized response", "second sanitized response", "third sanitized response"]);

  // Adopted output reconstructs the accepted steering input and acknowledges pickup without writing it again.
  const recovered: string[] = [];
  const adopted = await runAntigravityTurn({ prompt: "initial", cwd: "/tmp", additionalDirs: [], environment: {}, adopted: true,
    transport: transport([init, userInput(7209), userInput(7226), ...response(7227, "adopted sanitized response"),
      result("adopted sanitized response")], { replayed: true }) as any,
    onRecoveredSteering: (id, outcome) => recovered.push(`${id}:${outcome}`), } as any);
  assert.equal(adopted.text, "adopted sanitized response");
  assert.deepEqual(recovered, ["adopted-1:acknowledged"]);
} finally {
  await rm(state, { recursive: true, force: true });
}
  console.log("antigravity-current-input-fixture: stale aggregate, missing/mismatched final, non-ERROR terminal, current quota before/after tools, retained earlier failure, pre-start refusal, FIFO steering and adopted replay passed; all account/notice effects stubbed.");
