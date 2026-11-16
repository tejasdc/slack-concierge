// Disposable original-native recovery/consumer contract. No provider, service unit or account access.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws-node";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mock } from "bun:test";
const scratch = mkdtempSync(join(tmpdir(), "codex-callback-consumption-"));
process.env.CONCIERGE_STATE_DIR = scratch;
mock.module("../src/provider-usage", () => ({ usageAttempt: () => ({ provider: "codex", scope: "fixture", label: "fixture", generation: 0, revision: 0 }),
  assertUsageAvailable() {}, recordUsageSuccess() {}, recordUsageExhaustion() {}, codexUsageReset: () => null,
  cachedUsageLimit:()=>null,resetEpochMilliseconds:()=>null,usageLimitMessage:()=>"fixture" }));
const { runCodexTurn } = await import("../src/codex");
const { CodexAppServerClient } = await import("../src/codex-app-server-client");
const { enableLedgerAdmission, maintainLedger, runLedgerSegment } = await import("../src/ledger-admission");
const latch = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const socketPath = join(scratch, "native.sock"), server = createServer(), web = new WebSocketServer({ noServer: true });
let current: any, peer: WebSocket | null = null, nativeStarts = 0, nativeSteers = 0;
server.on("upgrade", (request, socket, head) => web.handleUpgrade(request, socket, head, socket => web.emit("connection", socket, request)));
web.on("connection", socket => { peer = socket; socket.on("message", data => {
  const request = JSON.parse(String(data)); let result: any;
  if (request.method === "initialize") result = {};
  else if (!request.id) return;
  else if (request.method === "config/read") result = { config: {} };
  else if (request.method === "thread/resume") result = { thread: { id: current.thread }, model: "gpt-fixture" };
  else if (request.method === "thread/turns/list") result = { data: [
    { id: "unrelated-newer-turn", status: "completed", items: [] },
    { id: current.turn, status: current.terminal ? "completed" : "inProgress", items: [current.items[0]] },
  ], nextCursor: null };
  else if (request.method === "thread/items/list") {
    assert.equal(request.params.threadId, current.thread); assert.equal(request.params.turnId, current.turn);
    assert.equal(request.params.sortDirection, "asc");
    if (request.params.cursor) { current.secondPages++; result = { data: current.items.slice(3).map((item: any) => ({ turnId: current.turn, item })), nextCursor: null }; }
    else result = { data: current.items.slice(0, 3).map((item: any) => ({ turnId: current.turn, item })), nextCursor: "native-next-page" };
  } else if (request.method === "turn/start") { nativeStarts++; throw Error("Adoption cannot resubmit"); }
  else if (request.method === "turn/steer") { nativeSteers++; throw Error("Recovery cannot resend steering"); }
  else if (request.method === "fixture/probe") result = { originalPublisher: true };
  else throw Error("Unexpected native request " + request.method);
  socket.send(JSON.stringify({ id: request.id, result }));
}); });
await new Promise<void>(resolve => server.listen(socketPath, resolve));
enableLedgerAdmission();
async function runCase(rejectCallback: boolean) {
  const ready = latch(), materialEntered = latch(), materialRelease = latch(), frozen = latch(), gate = latch(), steeringEntered = latch(), steeringRelease = latch();
  const original = rejectCallback ? "original-rejected-input" : "original-input", steering = "original-steering";
  current = { thread: "original-thread", turn: "original-turn", terminal: false, secondPages: 0, items: [
    { id: "native-original-user", type: "userMessage", clientId: original, content: [{ type: "text", text: "original prompt" }] },
    { id: "native-commentary", type: "agentMessage", phase: "commentary", text: "original full material item" },
    { id: "native-steered-user", type: "userMessage", clientId: steering, content: [{ type: "text", text: "original steering words" }] },
    { id: "native-final", type: "agentMessage", phase: "final_answer", text: "original final full answer" },
  ] };
  const state = current, projected: Array<{ id: string; input: string }> = [], sequence: string[] = [];
  let actingInput = original, returned = false, firstMaterial = true;
  const failure = Error("deliberate asynchronous callback failure");
  const client = new CodexAppServerClient(socketPath, process.env.CONCIERGE_NODE_BIN || Bun.which("node") || "/usr/bin/node", { relayRunner: "disposable-fixture", bridgePath: join(import.meta.dir, "../src/codex-app-server-bridge.mjs") });
  try {
    let notificationConsumers=0;const subscribe=client.onNotification.bind(client);client.onNotification=(listener,options)=>subscribe(event=>{notificationConsumers++;return listener(event)},options);
    const running = runCodexTurn({ prompt: "original prompt", cwd: scratch, additionalDirs: [], sessionUUID: state.thread,
      clientUserMessageId: original, appServerClient: client,
      adoptTurn: { threadId: state.thread, turnId: rejectCallback ? null : state.turn }, recoveredSteeringClientIds: [steering],
      onInputAcknowledged: () => { sequence.push("initial-ack"); ready.release(); },
      onProviderMessage: async message => {
        if (message.id === "native-commentary" && firstMaterial) { firstMaterial = false; materialEntered.release(); await materialRelease.promise; }
        if (message.id === "native-final" && rejectCallback) throw failure;
        await runLedgerSegment(() => { projected.push({ id: message.id, input: actingInput }); sequence.push("message:" + message.id); });
      },
      onProgress: async progress => {
        if (progress.type !== "steering") return;
        assert.equal(progress.clientMessageId, steering); steeringEntered.release(); await steeringRelease.promise;
        await runLedgerSegment(() => { actingInput = steering; sequence.push("steering-ack"); });
      },
      onRecoveredSteering: (id, outcome) => { assert.equal(id, steering); assert.equal(outcome, "acknowledged"); },
      onProviderTerminal: () => { sequence.push("terminal"); },
    }).then(result => { returned = true; return result; }, error => { returned = true; throw error; });
    // Register a rejection observer immediately; the final assertion checks exact failure custody.
    void running.catch(() => {});
    await ready.promise;
    peer!.send(JSON.stringify({ method: "item/completed", params: { threadId: state.thread, turnId: state.turn, item: state.items[1] } }));
    await materialEntered.promise;
    const maintenance = maintainLedger(async () => { frozen.release(); await gate.promise; }); await frozen.promise;
    state.terminal = true;
    for (const [threadId, turnId, item] of [
      ["foreign-thread", state.turn, { id: "foreign", type: "agentMessage", text: "wrong" }],
      [state.thread, "stale-prior-turn", { id: "stale", type: "agentMessage", text: "wrong" }],
      [state.thread, state.turn, state.items[2]], [state.thread, state.turn, state.items[3]],
    ]) peer!.send(JSON.stringify({ method: "item/completed", params: { threadId, turnId, item } }));
    peer!.send(JSON.stringify({ method: "turn/completed", params: { threadId: state.thread, turn: { id: state.turn, status: "completed", items: [] } } }));
    assert.deepEqual(await client.request("fixture/probe", {}), { originalPublisher: true });
    assert.equal(returned, false); assert.equal(sequence.includes("terminal"), false); assert.equal(state.secondPages, 0);assert.equal(notificationConsumers,1,"one original notification consumer while later hints require native recovery");
    gate.release(); await maintenance; materialRelease.release();
    await steeringEntered.promise; assert.equal(state.secondPages, 0, "native page two waits for admitted page-one callbacks"); assert.equal(returned, false);
    steeringRelease.release();
    if (rejectCallback) await assert.rejects(running, error => error === failure);
    else {
      const result = await running; assert.equal(result.text, "original final full answer");
      assert.deepEqual(projected.map(value => value.id), state.items.map((item: any) => item.id));
      assert.equal(projected.at(-1)!.input, steering); assert.equal(sequence.at(-1), "terminal");
    }
    assert.equal(projected.some(value => ["foreign", "stale"].includes(value.id)), false);
    assert.equal(nativeStarts, 0); assert.equal(nativeSteers, 0);
    return { rejectCallback, secondPages: state.secondPages, projected: projected.map(value => value.id), failureBeforeSuccess: rejectCallback, notificationConsumers, nativeStarts, nativeSteers };
  } finally { materialRelease.release(); steeringRelease.release(); gate.release(); await client.close().catch(() => {}); }
}
try {
  const successful = await runCase(false), rejected = await runCase(true);
  console.log(JSON.stringify({ actualClientAndUnchangedBridge: true, originalNativeHistoryOnly: true, controlsWhileFrozen: true,
    onePageBeforeDrain: true, negativeRecipientsRefused: true, oldPublisherNotRestarted: true, successful, rejected }));
} finally { for (const socket of web.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); web.close(); rmSync(scratch, { recursive: true, force: true }); }
