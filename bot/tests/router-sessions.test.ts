import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRouterSessionsArgs } from "../scripts/router-sessions";

const source = { channel_id: "C123ABC", message_ts: "1756000002.000003" };
const sourceFlags = ["--source-channel", source.channel_id, "--source-ts", source.message_ts];
const nativeSource = { input_id: "accepted-native-input", run_id: "82000000-0000-4000-8000-000000000001" };
const nativeSourceFlags = ["--source-input", nativeSource.input_id, "--source-run", nativeSource.run_id];
const sourceVariants = [{ source, sourceFlags }, { source: nativeSource, sourceFlags: nativeSourceFlags }];
const address = "concierge:opaque/session+address==";
const requestId = "request-exact-correlation";
const text = "  Question one?\n\nKeep **these bytes** and `$(literal)`.\n";
const commands = sourceVariants.flatMap(({ source, sourceFlags }) => [
  { args: ["search", ...sourceFlags, "--limit", "7", "--", "concept one", "concept two"],
    operation: "search", body: { source, concepts: ["concept one", "concept two"], limit: 7 } },
  { args: ["context", address, ...sourceFlags], operation: "context", body: { source, address } },
  { args: ["ask", address, ...sourceFlags, "--action-id", "ask-1", "--after-request", "earlier-1", "--after-request", "earlier-2", "--", text],
    operation: "ask", body: { source, action_id: "ask-1", address, text, after: ["earlier-1", "earlier-2"] } },
  { args: ["reply", requestId, ...sourceFlags, "--action-id", "reply-1", "--", text],
    operation: "reply", body: { source, action_id: "reply-1", request_id: requestId, text, final: true } },
  { args: ["reply", requestId, ...sourceFlags, "--action-id", "reply-2", "--partial", "--", text],
    operation: "reply", body: { source, action_id: "reply-2", request_id: requestId, text, final: false } },
  { args: ["get", requestId, ...sourceFlags], operation: "get", body: { source, request_id: requestId } },
]);

test.each(commands)("parses exact %s command identities and content", command => {
  expect(parseRouterSessionsArgs(command.args)).toEqual({ operation: command.operation, body: command.body });
});

test("omits optional fields and preserves source timestamps as strings", () => {
  expect(parseRouterSessionsArgs(["search", ...sourceFlags, "--", "concept"])).toEqual({
    operation: "search", body: { source, concepts: ["concept"] },
  });
  expect(parseRouterSessionsArgs(["ask", address, ...sourceFlags, "--action-id", "stable-action", "--", "--option-shaped text"])).toEqual({
    operation: "ask", body: { source, address, action_id: "stable-action", text: "--option-shaped text" },
  });
});

const invalidCommands = [
  [], ["steer"], ["resume"], ["search"], ["search", "--", "concept"],
  ["search", ...sourceFlags, "concept"],
  ["search", ...sourceFlags, "--"],
  ["search", ...sourceFlags, "--", " "],
  ["search", ...sourceFlags, "--", ...Array(9).fill("concept")],
  ["search", ...sourceFlags, "--limit", "0", "--", "concept"],
  ["search", ...sourceFlags, "--limit", "1.5", "--", "concept"],
  ["search", ...sourceFlags, "--limit", "9007199254740992", "--", "concept"],
  ["search", ...sourceFlags, "--limit", "--", "concept"],
  ["search", ...sourceFlags, "--limit", "2", "--limit", "3", "--", "concept"],
  ["search", ...sourceFlags, "--action-id", "unexpected", "--", "concept"],
  ["search", "--source-channel", "target", "--source-ts", source.message_ts, "--", "concept"],
  ["search", "--source-channel", source.channel_id, "--source-ts", "not-a-timestamp", "--", "concept"],
  ["context", ...sourceFlags],
  ["context", address, ...sourceFlags, "extra"],
  ["context", address, ...sourceFlags, "--"],
  ["context", address, ...sourceFlags, "--limit", "2"],
  ["context", address, ...sourceFlags, "--source-channel", source.channel_id],
  ["get", requestId, "--source-channel", source.channel_id],
  ["get", requestId, ...sourceFlags, "--source-ts", source.message_ts],
  ["get", requestId, ...sourceFlags, "--", "extra"],
  ["ask", address, ...sourceFlags, "--", "text"],
  ["ask", address, ...sourceFlags, "--action-id", "a", "text"],
  ["ask", address, ...sourceFlags, "--action-id", "a", "--", "text", "extra"],
  ["ask", address, ...sourceFlags, "--action-id", "a", "--", ""],
  ["ask", address, ...sourceFlags, "--action-id", "a", "--action-id", "b", "--", "text"],
  ["ask", address, ...sourceFlags, "--action-id", "a", "--partial", "--", "text"],
  ["ask", address, ...sourceFlags, "--action-id", "a", "--after-request", "r", "--after-request", "r", "--", "text"],
  ["ask", address, ...sourceFlags, "--action-id", "a", "--after-request", "--", "text"],
  ["reply", requestId, ...sourceFlags, "--", "text"],
  ["reply", requestId, ...sourceFlags, "--action-id", "a", "--partial", "--partial", "--", "text"],
  ["reply", requestId, ...sourceFlags, "--action-id", "a", "--after-request", "r", "--", "text"],
  ["ask", address, ...nativeSourceFlags, "--", "text"],
  ["search", "--source-input", nativeSource.input_id, "--", "concept"],
  ["search", "--source-run", nativeSource.run_id, "--", "concept"],
  ["search", ...nativeSourceFlags, ...sourceFlags, "--", "concept"],
  ["search", ...nativeSourceFlags, "--source-channel", source.channel_id, "--", "concept"],
  ["search", ...nativeSourceFlags, "--source-ts", source.message_ts, "--", "concept"],
  ["search", ...sourceFlags, "--source-input", nativeSource.input_id, "--", "concept"],
  ["search", ...sourceFlags, "--source-run", nativeSource.run_id, "--", "concept"],
  ["search", ...nativeSourceFlags, "--source-input", "another-input", "--", "concept"],
  ["search", ...nativeSourceFlags, "--source-run", "another-run", "--", "concept"],
  ["context", address, ...nativeSourceFlags, "--provider", "codex"],
  ["ask", address, ...nativeSourceFlags, "--action-id", "a", "--delivery", "steer", "--", "text"],
  ["ask", address, ...nativeSourceFlags, "--action-id", "a", "--expected-run", "newest", "--", "text"],
];

test.each(invalidCommands.map(args => ({ args })))("rejects missing, repeated, or misplaced arguments (%#)", ({ args }) => {
  expect(() => parseRouterSessionsArgs(args)).toThrow();
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

type SocketCall = { path: string; method: string; body: Record<string, unknown> | null; authorization: string | null };

function socketFixture(respond: (call: SocketCall) => Response) {
  const directory = mkdtempSync(join(tmpdir(), "router-sessions-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const stateDirectory = join(directory, "state");
  mkdirSync(stateDirectory);
  const stateAlias = join(directory, "state-alias");
  symlinkSync(stateDirectory, stateAlias);
  const calls: SocketCall[] = [];
  const server = Bun.serve({
    unix: join(stateDirectory, "requests.sock"),
    async fetch(request) {
      const call = { path: new URL(request.url).pathname, method: request.method,
        body: request.method === "POST" ? await request.json() : null,
        authorization: request.headers.get("authorization") };
      calls.push(call);
      return respond(call);
    },
  });
  cleanups.push(() => server.stop(true));
  const run = async (args: string[], verb = "sessions") => {
    const env = { ...process.env, CONCIERGE_ROUTER_BOT_DIR: join(import.meta.dir, ".."),
      CONCIERGE_STATE_DB: join(stateAlias, "state.db"), CONCIERGE_SLACK_CONFIG: "/must-not-read-slack-credentials",
      CONCIERGE_SOURCE_INPUT_ID: "unrelated-ambient-input", CONCIERGE_SOURCE_RUN_ID: "unrelated-ambient-run",
      CONCIERGE_SOURCE_CHANNEL: "C999OTHER", CONCIERGE_SOURCE_TS: "1.000001" };
    delete env.BUN_OPTIONS;
    const child = Bun.spawn(["bash", join(import.meta.dir, "../../systemd/router-actions.sh"), verb, ...args], {
      env, stdout: "pipe", stderr: "pipe",
    });
    cleanups.push(() => { if (child.exitCode === null) child.kill(); });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { stdout, stderr, exitCode };
  };
  return { calls, run, server };
}

test.each(commands)("shell dispatch sends one exact %s request through the existing private socket", async command => {
  const receipt = { request_id: requestId, status: "recorded", address, detail: { queued: true } };
  const fixture = socketFixture(() => Response.json(receipt, { status: 202 }));
  const result = await fixture.run(command.args);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual(receipt);
  expect(fixture.calls).toEqual([{ path: `/session-communication/${command.operation}`, method: "POST", body: command.body, authorization: null }]);
});

test("native discovery, questions, replies and inspection retain independent exact identities through the wrapper", async () => {
  const discoveredAddress = "session:WzIsMTIzLDdd";
  const firstRequest = "question-one-receipt";
  const secondRequest = "question-two-receipt";
  const answerSource = { input_id: "recipient-accepted-input", run_id: "82000000-0000-4000-8000-000000000002" };
  const answerFlags = ["--source-input", answerSource.input_id, "--source-run", answerSource.run_id];
  const firstReceipt = { request_id: firstRequest, status: "recorded", outcome: null };
  const secondReceipt = { request_id: secondRequest, status: "recorded", outcome: null };
  const asked = ["ask", discoveredAddress, ...nativeSourceFlags, "--action-id", "question-one", "--", text];
  const answer = ["reply", firstRequest, ...answerFlags, "--action-id", "answer-one", "--", "Final one"];
  const finalReceipt = { request_id: firstRequest, status: "settled", outcome: "answered",
    result: { text: "Final one", final: true }, events: [{ kind: "progress" }, { kind: "final" }] };
  const conflict = { error: "Idempotency conflict: this source/action already names a different request.", request_id: firstRequest };
  const steps = [
    { args: ["search", ...nativeSourceFlags, "--", "the target"], operation: "search",
      body: { source: nativeSource, concepts: ["the target"] },
      receipt: { results: [{ address: discoveredAddress, session_id: "concierge:123" }], coverage: { complete: true } } },
    { args: ["context", discoveredAddress, ...nativeSourceFlags], operation: "context",
      body: { source: nativeSource, address: discoveredAddress },
      receipt: { address: discoveredAddress, session_id: "concierge:123", binding_generation: 7 } },
    { args: asked, operation: "ask", body: { source: nativeSource, address: discoveredAddress, action_id: "question-one", text }, receipt: firstReceipt },
    { args: ["ask", discoveredAddress, ...nativeSourceFlags, "--action-id", "question-two", "--", "Second question"], operation: "ask",
      body: { source: nativeSource, address: discoveredAddress, action_id: "question-two", text: "Second question" }, receipt: secondReceipt },
    { args: asked, operation: "ask", body: { source: nativeSource, address: discoveredAddress, action_id: "question-one", text }, receipt: firstReceipt },
    { args: [...asked.slice(0, -1), "Changed question"], operation: "ask",
      body: { source: nativeSource, address: discoveredAddress, action_id: "question-one", text: "Changed question" }, receipt: conflict, status: 409 },
    { args: ["reply", firstRequest, ...answerFlags, "--action-id", "answer-progress", "--partial", "--", "Partial one"], operation: "reply",
      body: { source: answerSource, request_id: firstRequest, action_id: "answer-progress", text: "Partial one", final: false },
      receipt: { request_id: firstRequest, status: "admitted", outcome: null, events: [{ kind: "progress" }] } },
    { args: answer, operation: "reply",
      body: { source: answerSource, request_id: firstRequest, action_id: "answer-one", text: "Final one", final: true }, receipt: finalReceipt },
    { args: answer, operation: "reply",
      body: { source: answerSource, request_id: firstRequest, action_id: "answer-one", text: "Final one", final: true }, receipt: finalReceipt },
    { args: ["get", firstRequest, ...nativeSourceFlags], operation: "get",
      body: { source: nativeSource, request_id: firstRequest }, receipt: finalReceipt },
    { args: ["get", secondRequest, ...nativeSourceFlags], operation: "get",
      body: { source: nativeSource, request_id: secondRequest }, receipt: secondReceipt },
  ];
  let index = 0;
  const fixture = socketFixture(() => {
    const step = steps[index++]!;
    return Response.json(step.receipt, { status: step.status ?? 200 });
  });
  for (const step of steps) {
    const result = await fixture.run(step.args);
    const failed = (step.status ?? 200) >= 400;
    expect(result.exitCode, result.stderr).toBe(failed ? 1 : 0);
    expect(JSON.parse(failed ? result.stderr : result.stdout)).toEqual(step.receipt);
    expect(failed ? result.stdout : result.stderr).toBe("");
  }
  expect(fixture.calls).toEqual(steps.map(step => ({ path: `/session-communication/${step.operation}`,
    method: "POST", body: step.body, authorization: null })));
});

test.each([
  "Source must identify this admitted input and its exact live run.",
  "Consultation-only sessions cannot send requests or replies.",
  "The addressed session binding changed. Discover the intended session again.",
  "Only the exact recipient session/conversation can reply.",
])("native authority refusal is returned unchanged without another action: %s", async error => {
  const receipt = { error, request_id: requestId, source: nativeSource, action_id: "exact-action" };
  const fixture = socketFixture(() => Response.json(receipt, { status: 409 }));
  const result = await fixture.run(["reply", requestId, ...nativeSourceFlags, "--action-id", "exact-action", "--", text]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr)).toEqual(receipt);
  expect(fixture.calls).toEqual([{ path: "/session-communication/reply", method: "POST",
    body: { source: nativeSource, request_id: requestId, action_id: "exact-action", text, final: true }, authorization: null }]);
});

test.each(["recorded", "admitted", "parked"])("preserves %s receipt without initiating another action", async status => {
  const receipt = { request_id: requestId, status, turn_id: null, failure: { reason: "exact evidence" } };
  const fixture = socketFixture(() => Response.json(receipt));
  const result = await fixture.run(["ask", address, ...sourceFlags, "--action-id", "stable-ask", "--", text]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(receipt);
  expect(fixture.calls).toHaveLength(1);
});

test("preserves every non-success API field and does not retry an unresolved action", async () => {
  const receipt = { ok: false, error: "request_conflict", request_id: requestId, status: "parked",
    delivery: "ambiguous", action_id: "stable-ask", retry_after_ms: 2000, detail: { original_request_id: "original" } };
  const fixture = socketFixture(() => Response.json(receipt, { status: 409 }));
  const result = await fixture.run(["ask", address, ...sourceFlags, "--action-id", "stable-ask", "--", text]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr)).toEqual(receipt);
  expect(fixture.calls).toHaveLength(1);
});

test.each([
  ["ask", address, ...sourceFlags, "--", text],
  ["search", "--", "concept"],
  ["search", "--source-input", nativeSource.input_id, "--", "concept"],
  ["search", "--source-run", nativeSource.run_id, "--", "concept"],
  ["search", ...nativeSourceFlags, ...sourceFlags, "--", "concept"],
].map(args => ({ args })))("invalid or mixed source arguments fail before contacting the socket (%#)", async ({ args }) => {
  const fixture = socketFixture(() => Response.json({ unexpected: true }));
  const result = await fixture.run(args);
  expect(result.exitCode).toBe(2);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: "invalid_session_arguments" });
  expect(fixture.calls).toEqual([]);
});

test("session help does not contact the service", async () => {
  const fixture = socketFixture(() => Response.json({ unexpected: true }));
  const result = await fixture.run(["--help"]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("sessions reply <request-id>");
  expect(result.stdout).toContain("--source-input <inputId> --source-run <runId>");
  expect(result.stdout).toContain("--source-channel <channelId> --source-ts <messageTs>");
  expect(result.stdout).toContain("No source or run is inferred");
  expect(fixture.calls).toEqual([]);
});

test.each(sourceVariants)("an unreadable response preserves exact source and request correlation (%#)", async ({ source, sourceFlags }) => {
  const fixture = socketFixture(() => new Response("not JSON", { status: 502 }));
  const result = await fixture.run(["reply", requestId, ...sourceFlags, "--action-id", "reply-final", "--", text]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: "session_communication_unavailable",
    operation: "reply", source, action_id: "reply-final", request_id: requestId });
  expect(result.stderr).not.toContain(text);
  expect(fixture.calls).toHaveLength(1);
});

test.each(sourceVariants)("an unavailable socket preserves the original source and action identity (%#)", async ({ source, sourceFlags }) => {
  const fixture = socketFixture(() => Response.json({ unexpected: true }));
  fixture.server.stop(true);
  const result = await fixture.run(["ask", address, ...sourceFlags, "--action-id", "stable-ask", "--", text]);
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: "session_communication_unavailable",
    operation: "ask", source, action_id: "stable-ask", address });
  expect(fixture.calls).toEqual([]);
});

test("existing work client keeps its success and error behavior after transport extraction", async () => {
  let fail = false;
  const fixture = socketFixture(() => fail
    ? Response.json({ error: "existing request failure", request_id: requestId }, { status: 409 })
    : Response.json({ request_id: requestId, status: "admitted" }));
  const success = await fixture.run(["request", requestId], "work");
  expect(success.exitCode, success.stderr).toBe(0);
  expect(JSON.parse(success.stdout)).toEqual({ request_id: requestId, status: "admitted" });
  fail = true;
  const failure = await fixture.run(["request", requestId], "work");
  expect(failure.exitCode).toBe(1);
  expect(failure.stdout).toBe("");
  expect(JSON.parse(failure.stderr)).toEqual({ error: "Error: existing request failure" });
  expect(fixture.calls).toEqual(Array.from({ length: 2 }, () => ({
    path: `/requests/${requestId}`, method: "GET", body: null, authorization: null,
  })));
});
