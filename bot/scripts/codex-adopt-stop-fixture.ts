// Replays retained Stop across adopted Codex work with a disposable client and scratch state.
// No provider process, account, credential, or live ledger is involved.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "concierge-codex-adopt-stop-"));
process.env.CONCIERGE_STATE_DIR = scratch;

const [{ runCodexTurn }, { TurnCancellationController }, { ProviderDispatchError }]
  = await Promise.all([
    import("../src/codex"),
    import("../src/turn-dispatch-seams"),
    import("../src/provider-failures"),
  ]);

type Turn = { id: string; status: string; items: Array<{ type: string; clientId?: string }> };
function fakeClient(options: { turn: Turn | null; resumeError?: Error }) {
  const calls: Array<{ method: string; params?: any }> = [];
  const historyStatuses: string[] = [];
  const listeners = new Set<(event: any) => void>();
  let interruptSeen = false;
  let postInterruptHistoryReads = 0;
  const client = {
    async connect() { return 1; },
    async request(method: string, params: any) {
      calls.push({ method, params });
      if (method === "config/read") return { config: {} };
      if (method === "thread/resume") {
        if (options.resumeError) throw options.resumeError;
        return { thread: { id: params.threadId }, model: "gpt-fixture" };
      }
      if (method === "thread/turns/list") {
        const data = options.turn ? [{ ...options.turn, items: [...options.turn.items] }] : [];
        if (options.turn) historyStatuses.push(options.turn.status);
        if (interruptSeen && ++postInterruptHistoryReads === 1 && options.turn)
          options.turn.status = "interrupted";
        return { data, nextCursor: null };
      }
      if (method === "turn/interrupt") {
        // The interrupt acknowledgement is deliberately not terminal evidence. The next history
        // page models a later provider observation, independently of this RPC response.
        interruptSeen = true;
        return { accepted: true };
      }
      if (method === "thread/items/list") return { data: [], nextCursor: null };
      throw new Error(`Unexpected Codex request: ${method}`);
    },
    async notify() {},
    onNotification(listener: (event: any) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    onDisconnect() { return () => true; },
    waitForDisconnect() { return new Promise<void>(() => {}); },
  };
  return { client, calls, historyStatuses };
}

async function retainedStop(client: any, adopted?: { threadId: string; turnId: string | null }) {
  const cancellation = new TurnCancellationController();
  const ownerStopCompletion = cancellation.request();
  const result = await runCodexTurn({
    prompt: "already accepted work",
    cwd: scratch,
    additionalDirs: [],
    sessionUUID: "retained-thread-fixture",
    interactionPolicy: "standard",
    appServerClient: client,
    clientUserMessageId: "retained-client-message-fixture",
    ...(adopted ? { adoptTurn: adopted } : {}),
    onCancellationReady: (cancel) => cancellation.register(cancel),
  }).then((value) => ({ value, error: null as Error | null }),
    (error) => ({ value: null, error: error as Error }));
  const stopError=await ownerStopCompletion.then(()=>null,(error)=>error as Error);
  return {...result,stopError,client};
}

try {
  // Control: work with no retained provider submission is canceled before any RPC.
  const unsent = fakeClient({ turn: null });
  const unsentResult = await retainedStop(unsent.client);
  assert.equal(unsentResult.error?.name, "ProviderTurnCancelledError");
  assert.deepEqual(unsent.calls, [], "ordinary pre-submission Stop does not connect or submit");

  // Exact stored provider turn ID: interruption is followed by terminal history before settlement.
  const exact = fakeClient({ turn: { id: "retained-provider-turn", status: "inProgress", items: [] } });
  const exactResult = await retainedStop(exact.client, {
    threadId: "retained-thread-fixture", turnId: "retained-provider-turn",
  });
  assert.equal(exactResult.error?.name, "ProviderTurnCancelledError");
  const exactInterrupt = exact.calls.find((call) => call.method === "turn/interrupt");
  assert.deepEqual(exactInterrupt?.params, {
    threadId: "retained-thread-fixture", turnId: "retained-provider-turn",
  }, "Stop interrupts the exact adopted thread and provider turn");
  assert.ok(exact.calls.filter((call) => call.method === "thread/turns/list").length >= 2,
    "the turn is read again after interrupt");
  assert.ok(exact.historyStatuses.includes("interrupted"), "terminal settlement follows provider history");
  assert.equal(exact.calls.some((call) => call.method === "turn/start"), false,
    "adoption never resubmits accepted work");

  // Missing provider turn ID: recovery discovers it only through the retained client message ID.
  const discovered = fakeClient({ turn: { id: "history-discovered-turn", status: "inProgress",
    items: [{ type: "userMessage", clientId: "retained-client-message-fixture" }] } });
  const discoveredResult = await retainedStop(discovered.client, {
    threadId: "retained-thread-fixture", turnId: null,
  });
  assert.equal(discoveredResult.error?.name, "ProviderTurnCancelledError");
  assert.deepEqual(discovered.calls.find((call) => call.method === "turn/interrupt")?.params, {
    threadId: "retained-thread-fixture", turnId: "history-discovered-turn",
  }, "history identity supplies the exact turn ID when adoption retained only the client message ID");
  assert.equal(discovered.calls.some((call) => call.method === "turn/start"), false);

  // Missing identity plus refused history remains uncertain, even when the Stop callback completes.
  const { CodexAppServerClientError } = await import("../src/codex-app-server-client");
  const uncertain = fakeClient({ turn: null,
    resumeError: new CodexAppServerClientError("fixture history unavailable", "ambiguous", -32603) });
  const uncertainResult = await retainedStop(uncertain.client, {
    threadId: "retained-thread-fixture", turnId: null,
  });
  assert.ok(uncertainResult.error instanceof ProviderDispatchError);
  assert.equal(uncertainResult.error.terminalConfirmed, false,
    "callback completion and unavailable history do not fake provider terminal proof");
  assert.equal(uncertain.calls.some((call) => call.method === "turn/interrupt"), false,
    "no interrupt is sent without an exact provider turn identity");
  assert.equal(uncertain.calls.some((call) => call.method === "turn/start"), false,
    "uncertain adopted work is never resubmitted");
  assert.ok(uncertainResult.stopError instanceof ProviderDispatchError,
    "the retained Stop callback carries uncertain provider outcome into the owner receipt");

  // Empty history is distinct from a refused history RPC. Accelerate only the fixture's bounded
  // history retry delays; long inactivity timers remain real and are cleared by settlement.
  const nativeSetTimeout=globalThis.setTimeout;
  (globalThis as any).setTimeout=(callback:()=>void,delay?:number,...args:unknown[])=>
    typeof delay==='number'&&delay<=5_000?nativeSetTimeout(callback,0,...args as []):nativeSetTimeout(callback,delay,...args as []);
  let emptyHistory;
  try {
    const empty=fakeClient({turn:null});
    emptyHistory=await retainedStop(empty.client,{threadId:'retained-thread-fixture',turnId:null});
    assert.ok(emptyHistory.error instanceof ProviderDispatchError);
    assert.equal(emptyHistory.error.terminalConfirmed,false,'an empty history search does not prove the accepted turn was unsent');
    assert.ok(emptyHistory.stopError instanceof ProviderDispatchError,'empty-history uncertainty reaches the retained Stop callback');
    assert.equal(emptyHistory.stopError.terminalConfirmed,false);
    assert.equal(empty.calls.some((call)=>call.method==='turn/start'),false);
  } finally { globalThis.setTimeout=nativeSetTimeout; }
  assert.equal((emptyHistory as any).value,null);

  console.log("codex adopted Stop fixture: exact and history-discovered turns were interrupted and terminally reconciled; unsent Stop and empty/refused uncertain history stayed safe");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
