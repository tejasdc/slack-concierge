// Fault injection for docs/incidents/2026-11-12-codex-connection-loss-parked-unsent-turns.md:
// the shared Codex App Server connection closes while a turn is still connecting, and again while
// its thread/resume waits. Nothing has been sent, so the turn must wait the loss out on the same
// attempt and finish, sending its input exactly once. A turn taken back whose thread history never
// shows it (`--adopted`, about 70 s) must come back as a safe retry, not as a park.
// Scratch state and a fake client only; it never touches the live ledger or the real App Server.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "concierge-codex-connection-loss-"));
process.env.CONCIERGE_STATE_DIR = scratch;
const { runCodexTurn } = await import("../src/codex");
const { CodexAppServerClientError } = await import("../src/codex-app-server-client");
const { ProviderDispatchError } = await import("../src/provider-failures");

const closed = () => new CodexAppServerClientError("Codex app-server WebSocket closed.", "ambiguous");
function fakeClient(script: { connectFailures: number; resumeFailures: number; turns?: any[] }) {
  const notifications = new Set<(event: any) => void>();
  const requests: string[] = [];
  let connects = 0;
  return { requests, get connects() { return connects; }, client: {
    async connect() { connects++; if (script.connectFailures-- > 0) throw closed(); return connects; },
    async request(method: string, params: any) {
      requests.push(method);
      if (method === "config/read") return { config: {} };
      if (method === "thread/resume") {
        if (script.resumeFailures-- > 0) throw closed();
        return { thread: { id: params.threadId }, model: "gpt-fixture" };
      }
      if (method === "thread/turns/list") return { data: script.turns ?? [], nextCursor: null };
      if (method === "turn/start") {
        queueMicrotask(() => { for (const listener of notifications) listener({ method: "turn/completed", params: {
          threadId: params.threadId, turn: { id: "fixture-turn", status: "completed", items: [] } } }); });
        return { turn: { id: "fixture-turn" } };
      }
      throw new Error(`unexpected method ${method}`);
    },
    async notify() {},
    onNotification(listener: (event: any) => void) { notifications.add(listener); return () => notifications.delete(listener); },
    onDisconnect() { return () => true; },
    waitForDisconnect() { return new Promise<void>(() => {}); },
  } };
}

try {
  const lost = fakeClient({ connectFailures: 1, resumeFailures: 1 });
  await runCodexTurn({ prompt: "fixture", cwd: scratch, additionalDirs: [], sessionUUID: "fixture-thread",
    appServerClient: lost.client as any, requestTimeoutMs: 1_000, clientUserMessageId: "slack-concierge:turn:9001:attempt:1" });
  assert.equal(lost.requests.filter(method => method === "turn/start").length, 1, "the input is sent exactly once");
  assert.equal(lost.requests.filter(method => method === "thread/resume").length, 2, "the lost resume is asked again");
  assert.ok(lost.connects >= 2, "the lost connect is tried again");
  console.log("codex connection loss fixture: a turn still connecting waited out two lost connections and finished");

  if (process.argv.includes("--adopted")) {
    const absent = fakeClient({ connectFailures: 0, resumeFailures: 0, turns: [] });
    const failure = await runCodexTurn({ prompt: "fixture", cwd: scratch, additionalDirs: [], sessionUUID: "fixture-thread",
      appServerClient: absent.client as any, requestTimeoutMs: 1_000, clientUserMessageId: "slack-concierge:turn:9002:attempt:1",
      adoptTurn: { threadId: "fixture-thread", turnId: null } } as any).then(() => null, error => error);
    assert.ok(failure instanceof ProviderDispatchError, `expected a dispatch error, got ${failure}`);
    assert.equal(failure.failureClass, "retryable");
    assert.equal(failure.terminalConfirmed, true, "a turn absent from its thread's history is safe to send again");
    assert.equal(absent.requests.includes("turn/start"), false, "taking a turn back never sends it");
    console.log("codex connection loss fixture: a taken-back turn its thread never recorded came back as a safe retry");
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(0);
