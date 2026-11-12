import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDirectory = mkdtempSync(join(tmpdir(), "concierge-codex-presubmit-"));
process.env.CONCIERGE_STATE_DIR = stateDirectory;
process.env.CONCIERGE_SLACK_ENABLED = "0";

const [{ runCodexTurn }, { CodexAppServerClientError }, { ProviderDispatchError }, { db }] = await Promise.all([
  import("../src/codex"),
  import("../src/codex-app-server-client"),
  import("../src/provider-failures"),
  import("../src/state"),
]);

class FixtureClient {
  generation = 0;
  connected = false;
  readonly requests: string[] = [];
  private readonly notifications = new Set<(event: any) => void>();
  private readonly disconnects = new Set<(error: Error, generation: number) => void>();

  constructor(readonly fault: "connect" | "config" | "thread-response-close" | "turn-start-ambiguous-history-rejected" | "none") {}

  async connect() {
    if (this.fault === "connect") {
      throw new CodexAppServerClientError("fixture setup WebSocket closure", "ambiguous");
    }
    if (!this.connected) {
      this.connected = true;
      this.generation += 1;
    }
    return this.generation;
  }

  async request(method: string, params: any) {
    this.requests.push(method);
    if (method === "config/read") {
      if (this.fault === "config") {
        throw new CodexAppServerClientError("fixture config WebSocket closure", "ambiguous");
      }
      return { config: {} };
    }
    if (method === "thread/start" || method === "thread/resume") {
      if (method === "thread/start" && this.fault === "thread-response-close") this.disconnect();
      return {
        thread: { id: params.threadId ?? "fixture-thread" },
        ...(params.permissions ? {
          approvalPolicy: "never",
          activePermissionProfile: { id: "concierge-consultation" },
          sandbox: { type: "readOnly", networkAccess: false },
        } : {}),
      };
    }
    if (method === "turn/start") {
      if (this.fault === "turn-start-ambiguous-history-rejected") {
        throw new CodexAppServerClientError("fixture lost turn/start response", "ambiguous");
      }
      queueMicrotask(() => {
        this.emit({ method: "turn/started", params: {
          threadId: params.threadId,
          turn: { id: "fixture-turn", status: "inProgress" },
        } });
        this.emit({ method: "turn/completed", params: {
          threadId: params.threadId,
          turn: { id: "fixture-turn", status: "completed", items: [] },
        } });
      });
      return { turn: { id: "fixture-turn" } };
    }
    if (method === "thread/turns/list") {
      if (this.fault === "turn-start-ambiguous-history-rejected") {
        throw new CodexAppServerClientError("fixture unsupported turn history", "rejected", -32601);
      }
      return { data: [], nextCursor: null };
    }
    if (method === "thread/items/list") return { data: [], nextCursor: null };
    throw new Error(`Unexpected fixture request ${method}`);
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
  emit(event: any) { for (const listener of this.notifications) listener(event); }
  disconnect(error = new CodexAppServerClientError("fixture setup WebSocket closure", "ambiguous")) {
    const generation = this.generation;
    this.connected = false;
    for (const listener of this.disconnects) listener(error, generation);
  }
}

function input(client: FixtureClient, extra: Record<string, unknown> = {}) {
  return {
    prompt: "fixture request",
    cwd: "/tmp",
    additionalDirs: [],
    sessionUUID: null,
    usageProbe: true,
    appServerClient: client,
    ...extra,
  } as any;
}

async function expectRetryableSetupFailure(client: FixtureClient, extra: Record<string, unknown> = {}) {
  await assert.rejects(runCodexTurn(input(client, extra)), error => {
    assert.ok(error instanceof ProviderDispatchError);
    assert.equal(error.failureClass, "retryable");
    assert.equal(error.terminalConfirmed, true);
    return true;
  });
  assert.ok(!client.requests.includes("turn/start"), "setup failure must precede turn/start");
}

try {
  const connectFailure = new FixtureClient("connect");
  await expectRetryableSetupFailure(connectFailure);
  assert.deepEqual(connectFailure.requests, [], "connect failure sends no provider request");

  const configFailure = new FixtureClient("config");
  await expectRetryableSetupFailure(configFailure, { interactionPolicy: "consultation-only" });
  assert.deepEqual(configFailure.requests, ["config/read"]);

  const threadDisconnect = new FixtureClient("thread-response-close");
  await expectRetryableSetupFailure(threadDisconnect);
  assert.deepEqual(threadDisconnect.requests, ["thread/start"]);

  const laterAttempt = new FixtureClient("none");
  const completed = await runCodexTurn(input(laterAttempt));
  assert.equal(completed.sessionUUID, "fixture-thread");
  assert.equal(laterAttempt.requests.filter(method => method === "turn/start").length, 1);

  const adopted = new FixtureClient("connect");
  await assert.rejects(runCodexTurn(input(adopted, {
    adopted: true,
    adoptTurn: { threadId: "existing-thread", turnId: "existing-turn" },
  })), error => {
    assert.ok(error instanceof CodexAppServerClientError);
    assert.equal(error.outcome, "ambiguous");
    assert.ok(!(error instanceof ProviderDispatchError), "adopted work is never declared unsent");
    return true;
  });
  assert.deepEqual(adopted.requests, []);

  let stopBeforeSubmit!: () => void;
  const stopped = new FixtureClient("none");
  await assert.rejects(runCodexTurn(input(stopped, {
    onCancellationReady: (stop: () => Promise<void>) => {
      stopBeforeSubmit = () => { void stop(); };
      stopBeforeSubmit();
    },
  })), error => {
    assert.match(String(error), /stopped/i);
    return true;
  });
  assert.deepEqual(stopped.requests, [], "Stop before submission sends no provider request");

  const admitted = new FixtureClient("turn-start-ambiguous-history-rejected");
  await assert.rejects(runCodexTurn(input(admitted)), error => {
    assert.ok(error instanceof ProviderDispatchError);
    assert.equal(error.terminalConfirmed, false, "unresolved admitted work remains ambiguous");
    return true;
  });
  assert.equal(admitted.requests.filter(method => method === "turn/start").length, 1,
    "an ambiguous admitted start is never replayed");
  assert.ok(admitted.requests.includes("thread/turns/list"), "post-submission failure uses exact history");

  console.log("PASS: pre-submit connect/config/thread faults are retryable; Stop submits nothing; an admitted ambiguous start remains unresolved and is never replayed; adopted reconnect failure stays ambiguous.");
} finally {
  db.close();
  rmSync(stateDirectory, { recursive: true, force: true });
}
