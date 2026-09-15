import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChatGptDispatchError,
  SessionCapabilityClient,
  SessionCapabilityError,
  type CapabilityEvidence,
  type ChatGptRunContext,
} from "../src/session-capability-client";
import type { AgentProvider } from "../src/providers";

type WireCase = { name: string; request: { method: string; path: string; body: any }; response: { status: number; body: any }; ownerReceipt?: any; ownerSession?: any };
function fixtures(name: string): WireCase[] {
  return JSON.parse(readFileSync(new URL(`../../docs/contracts/session-owner-v1/${name}.json`, import.meta.url), "utf8")).cases;
}
const sources = fixtures("sources");
const chatgpt = fixtures("chatgpt");
const byName = (name: string) => chatgpt.find(value => value.name === name)!;
const startCase = byName("start-exact-owned-run");
const observeCase = byName("observe-exact-effect");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function socketFixture(handler: (input: { method: string; path: string; body: any }, request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "capability-wire-"));
  const socketPath = join(root, "peer.sock");
  const calls: { method: string; path: string; body: any }[] = [];
  const failures: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = { method: request.method!, path: request.url!, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
      calls.push(input);
      await handler(input, request, response);
    } catch (error) {
      failures.push(error);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "FIXTURE_ERROR", message: "Fixture handler failed." } }));
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  cleanup.push(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    rmSync(root, { recursive: true, force: true });
    expect(failures).toEqual([]);
  });
  return { client: new SessionCapabilityClient({ socketPath }), calls };
}

function respond(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function exchange(wire: WireCase) {
  return socketFixture((input, _request, response) => {
    expect(input).toEqual(wire.request);
    respond(response, wire.response.body, wire.response.status);
  });
}

function runContext(onEvidence: ChatGptRunContext["onEvidence"], overrides: Partial<ChatGptRunContext> = {}): ChatGptRunContext {
  const { providerInput, ...run } = structuredClone(startCase.request.body);
  return { run, admission: structuredClone(startCase.ownerReceipt.admission), attachments: providerInput.attachments, onEvidence, ...overrides };
}

function providerInput(overrides: Partial<Parameters<AgentProvider["run"]>[0]> = {}): Parameters<AgentProvider["run"]>[0] {
  return { prompt: startCase.request.body.providerInput.prompt, cwd: "/fixture/host-only", additionalDirs: ["/fixture/private"],
    environment: { PRIVATE_FIXTURE_SECRET: "do-not-forward" }, systemPrompt: "host-only system prompt",
    sessionUUID: startCase.request.body.providerInput.nativeBinding.sessionId, model: "chat", ...overrides };
}

function sourceCall(client: SessionCapabilityClient, wire: WireCase) {
  const body = wire.request.body;
  switch (wire.request.path) {
    case "/sources/search": return client.searchSources(body);
    case "/sources/context": return client.sourceContext(body);
    case "/sources/import": return client.importSource(body);
    case "/sources/history": return client.sourceHistory(body);
    case "/sources/refresh": return client.refreshSources();
    default: throw new Error("Missing fixture route");
  }
}

function providerCall(client: SessionCapabilityClient, wire: WireCase) {
  const body = wire.request.body;
  switch (wire.request.path.split("/").at(-1)) {
    case "start": return client.start(body, body.providerInput);
    case "observe": return client.observe(body, body.after);
    case "reconcile": return client.reconcile(body);
    case "stop": return client.stop(body);
    case "history": return client.history(body);
    case "detail": return client.detail(body);
    case "bind": return client.bind(body);
    case "snapshot": return client.snapshot(body);
    case "artifact": return client.artifact(body);
    default: throw new Error("Missing fixture route");
  }
}

describe("configured source capability over real Unix HTTP", () => {
  for (const wire of sources) {
    test(wire.name, async () => {
      const { client, calls } = await exchange(wire);
      if (wire.response.status >= 400) {
        const error = await sourceCall(client, wire).catch(error => error);
        expect(error).toBeInstanceOf(SessionCapabilityError);
        expect(error.code).toBe(wire.response.body.error.code);
        expect(error.status).toBe(wire.response.status);
      } else expect(await sourceCall(client, wire)).toEqual(wire.response.body);
      expect(calls).toHaveLength(1);
    });
  }

  test("source reads reject nearby branch, version and tampered evidence without retry", async () => {
    const wire = sources.find(value => value.name === "context-exact-source-version")!;
    for (const tamper of [
      (body: any) => { body.source.branch = "another-branch"; },
      (body: any) => { body.source.version = "0".repeat(64); },
      (body: any) => { body.evidence[0].text += "\n"; },
      (body: any) => { body.evidence[0].sourceId = "another-source"; },
    ]) {
      const body = structuredClone(wire.response.body);
      tamper(body);
      const { client, calls } = await socketFixture((_input, _request, response) => respond(response, body));
      await expect(client.sourceContext(wire.request.body)).rejects.toBeInstanceOf(SessionCapabilityError);
      expect(calls).toHaveLength(1);
    }
  });

  test("import hashes UTF8 bytes without newline or Unicode normalization", async () => {
    const wire = sources.find(value => value.name === "import-exact-utf8")!;
    const { client } = await socketFixture((_input, _request, response) => respond(response, wire.response.body));
    await expect(client.importSource({ ...wire.request.body, content: wire.request.body.content.trimEnd() })).rejects.toThrow("exact UTF8");
    await expect(client.importSource({ ...wire.request.body, content: wire.request.body.content + "e\u0301" })).rejects.toThrow("exact UTF8");
  });

  test("history preserves rich native content but refuses substituted source evidence", async () => {
    const wire = sources.find(value => value.name === "history-source-pins")!;
    const body = structuredClone(wire.response.body);
    body.messages[0].source.sourceVersion = "0".repeat(64);
    const { client } = await socketFixture((_input, _request, response) => respond(response, body));
    await expect(client.sourceHistory(wire.request.body)).rejects.toThrow("pinned source/version");
  });

  test("context does not quietly replace an exact requested event with its neighbor", async () => {
    const wire = sources.find(value => value.name === "context-exact-source-version")!;
    const body = structuredClone(wire.response.body);
    body.evidence = body.evidence.filter((value: any) => value.eventId !== wire.request.body.eventId);
    const { client } = await socketFixture((_input, _request, response) => respond(response, body));
    await expect(client.sourceContext(wire.request.body)).rejects.toThrow("exact requested event");
  });
});

describe("pinned ChatGPT capability fixture transport", () => {
  test("every session-view example explicitly distinguishes retained native bindings from source identity", () => {
    const views: any[] = [];
    function inspect(value: any) {
      if (!value || typeof value !== "object") return;
      if (!Array.isArray(value) && Object.hasOwn(value, "runtimeThreadId")) views.push(value);
      for (const child of Object.values(value)) inspect(child);
    }
    for (const name of ["surface", "chatgpt", "sources"]) inspect(fixtures(name));
    expect(views.length).toBeGreaterThan(0);
    expect(views.some(view => view.origin === "imported" && view.nativeBinding !== null && view.interactionPolicy === "standard")).toBe(true);
    for (const view of views) {
      expect(Object.hasOwn(view, "nativeBinding")).toBe(true);
      if (view.provider !== "chatgpt" || view.runtimeThreadId === null) {
        expect(view.nativeBinding).toBeNull();
        if (view.origin === "imported") expect(view.capabilities.send).toBe(false);
      } else {
        expect(view.nativeBinding).toEqual(startCase.ownerSession.nativeBinding);
        expect(view.nativeBinding.sessionId).toBe(view.runtimeThreadId);
      }
    }
    const unproven = fixtures("surface").find(value => value.name === "get-chatgpt-import-retains-unproven-binding")!.response.body.session;
    expect(unproven.nativeKey).toContain("chatgpt:");
    expect(unproven.nativeBinding).toBeNull();
    expect(unproven.capabilities.send).toBe(false);
    expect(byName("reject-native-account-change").ownerSession.nativeBinding.accountScope)
      .not.toBe(byName("reject-native-account-change").request.body.providerInput.nativeBinding.accountScope);
  });

  test("read-only history uses the current retained session binding after the run ends", async () => {
    const wire = byName("history-exact-native-binding");
    const { client, calls } = await exchange(wire);
    expect(wire.ownerSession.activeRunId).toBeNull();
    expect(wire.ownerSession.execution).toBe("completed");
    expect(wire.ownerReceipt).toBeUndefined();
    const view = wire.ownerSession;
    expect(await client.history({ sessionId: view.id, bindingGeneration: view.bindingGeneration,
      binding: view.nativeBinding, cursor: null, limit: 50 })).toEqual(wire.response.body);
    expect(calls).toHaveLength(1);
  });

  test("initial imported bind names the durable human operation while the native binding is still null", async () => {
    const wire = byName("bind-original-conversation-anchor");
    const { client, calls } = await exchange(wire);
    expect(wire.ownerSession.nativeBinding).toBeNull();
    expect(wire.ownerReceipt.kind).toBe("bind");
    expect(wire.ownerReceipt.origin).toBe("human");
    expect(wire.ownerReceipt.inputId).toBeNull();
    expect(wire.ownerReceipt.runId).toBeNull();
    expect(wire.ownerReceipt.admission).toEqual({ bindingGeneration: wire.request.body.bindingGeneration, reference: wire.request.body.reference });
    expect(await client.bind(wire.request.body)).toEqual(wire.response.body);
    expect(calls[0]!.body.operationId).toBe(wire.ownerReceipt.operationId);
  });

  test("bind cannot omit the accepted control identity or substitute an execution run for its request fields", async () => {
    const { client, calls } = await exchange(byName("bind-original-conversation-anchor"));
    const { operationId: _operation, ...withoutIntent } = byName("bind-original-conversation-anchor").request.body;
    await expect(client.bind(withoutIntent)).rejects.toThrow("exact owner bind operation");
    expect(calls).toHaveLength(0);
  });

  for (const wire of chatgpt) {
    test(wire.name, async () => {
      const localRejection = ["reject-caller-cwd", "reject-provider-run-id-change"].includes(wire.name);
      const { client, calls } = await exchange(wire);
      if (wire.response.status >= 400) {
        const error = await providerCall(client, wire).catch(error => error);
        expect(error).toBeInstanceOf(SessionCapabilityError);
        if (!localRejection) {
          expect(error.code).toBe(wire.response.body.error.code);
          expect(error.status).toBe(wire.response.status);
        }
      } else expect(await providerCall(client, wire)).toEqual(wire.response.body);
      expect(calls).toHaveLength(localRejection ? 0 : 1);
    });
  }

  test("rejects another account returned by bind and altered artifact/snapshot bytes", async () => {
    for (const name of ["bind-original-conversation-anchor", "artifact-exact-message-file", "snapshot-retains-source-version"]) {
      const wire = byName(name), body = structuredClone(wire.response.body);
      if (body.binding) body.binding.accountScope = "another-account";
      if (body.base64) body.base64 = Buffer.from("different bytes").toString("base64");
      if (body.content) body.content = body.content.trimEnd() + "changed";
      const { client } = await socketFixture((_input, _request, response) => respond(response, body));
      await expect(providerCall(client, wire)).rejects.toBeInstanceOf(SessionCapabilityError);
    }
  });
});

describe("ChatGPT adapter under the existing run executor", () => {
  test("runs the exact effect, retains messages/artifacts and omits all host authority fields", async () => {
    const evidence: CapabilityEvidence[] = [], reportedThreads: string[] = [], reportedTurns: string[] = [];
    let acknowledgements = 0, terminal = 0, cancellation = 0, steering = 0;
    const { client, calls } = await socketFixture((input, _request, response) => {
      const wire = input.path.endsWith("/start") ? startCase : observeCase;
      expect(input).toEqual(wire.request);
      respond(response, wire.response.body, wire.response.status);
    });
    const adapter: AgentProvider = client.createChatGptProvider(runContext(value => { evidence.push(value); }));
    const result = await adapter.run(providerInput({
      onProviderThreadStarted: id => { reportedThreads.push(id); }, onProviderTurnStarted: id => { reportedTurns.push(id); },
      onInputAcknowledged: () => { acknowledgements++; }, onProviderTerminal: () => { terminal++; },
      onCancellationReady: () => { cancellation++; }, onSteeringReady: () => { steering++; },
    }));
    expect(result).toEqual({ text: observeCase.response.body.result.text, sessionUUID: observeCase.response.body.result.sessionId,
      providerTurnId: "user-2", toolsUsed: [] });
    expect(result.model).toBeUndefined();
    expect(reportedThreads.every(id => id === result.sessionUUID)).toBe(true);
    expect(reportedTurns).toEqual(["user-2"]);
    expect(evidence.map(value => value.kind)).toEqual(["start", "observe"]);
    expect((evidence[1] as any).observation.events[1].payload.message.richContent).toEqual(observeCase.response.body.events[1].payload.message.richContent);
    expect(acknowledgements).toBe(0);
    expect(terminal).toBe(1);
    expect(cancellation).toBe(0);
    expect(steering).toBe(0);
    expect(JSON.stringify(calls)).not.toContain("do-not-forward");
    expect(calls).toHaveLength(2);
  });

  test("new conversation persists its verified identity before exposing native progress", async () => {
    const newStart = byName("start-new-native-conversation"), order: string[] = [];
    const { client } = await socketFixture((input, _request, response) => {
      const wire = input.path.endsWith("/start") ? newStart : observeCase;
      expect(input).toEqual(wire.request);
      respond(response, wire.response.body, wire.response.status);
    });
    const context = runContext(value => { order.push(value.kind); }, {
      admission: structuredClone(newStart.ownerReceipt.admission), onNativeBinding: () => { order.push("binding"); },
    });
    const result = await client.createChatGptProvider(context).run(providerInput({ sessionUUID: null, onProviderThreadStarted: () => { order.push("thread"); } }));
    expect(result.sessionUUID).toBe(observeCase.response.body.result.sessionId);
    expect(order.indexOf("binding")).toBeGreaterThan(order.indexOf("observe"));
    expect(order.indexOf("binding")).toBeLessThan(order.indexOf("thread"));
  });

  test("pins preparation, attachment bytes/order and policy before any socket call", async () => {
    const { client, calls } = await socketFixture((_input, _request, response) => respond(response, startCase.response.body));
    for (const mutate of [
      (context: ChatGptRunContext) => { context.admission.promptHash = hash("different prompt"); },
      (context: ChatGptRunContext) => { context.admission.runId = "different-run"; },
      (context: ChatGptRunContext) => { context.admission.model = "work"; },
      (context: ChatGptRunContext) => { context.attachments[0]!.base64 = Buffer.from("different").toString("base64"); },
      (context: ChatGptRunContext) => { context.admission.nativeBinding!.sessionId = "different-conversation"; },
      (context: ChatGptRunContext) => { (context.admission as any).policy = "consultation-only"; },
      (context: ChatGptRunContext) => { (context.admission as any).purpose = "extract"; },
      (context: ChatGptRunContext) => { context.admission.attachments[0]!.id = "different-custody"; },
    ]) {
      const context = runContext(() => {});
      mutate(context);
      const error = await client.createChatGptProvider(context).run(providerInput()).catch(error => error);
      expect(error).toBeInstanceOf(ChatGptDispatchError);
      expect(error.terminalConfirmed).toBe(true);
      expect(error.failureClass).toBe("parked_terminal");
    }
    await expect(client.createChatGptProvider(runContext(() => {})).run(providerInput({ interactionPolicy: "consultation-only" }))).rejects.toThrow("standard chat admission");
    expect(calls).toHaveLength(0);
  });

  test("retained factory context cannot be changed by later caller mutation", async () => {
    const wire = byName("repeat-start-terminal-inspects-same-effect");
    const { client, calls } = await exchange(wire);
    const context = runContext(() => {});
    const provider = client.createChatGptProvider(context);
    context.run.runId = "retargeted-run";
    context.attachments.length = 0;
    context.admission.model = "work";
    expect((await provider.run(providerInput())).text).toBe(wire.response.body.result.text);
    expect(calls).toHaveLength(1);
  });

  test("uncertain start is parked once without observing or resubmitting", async () => {
    const wire = byName("repeat-uncertain-start-never-replays"), evidence: CapabilityEvidence[] = [];
    const { client, calls } = await exchange(wire);
    const error = await client.createChatGptProvider(runContext(value => { evidence.push(value); })).run(providerInput()).catch(error => error);
    expect(error).toBeInstanceOf(ChatGptDispatchError);
    expect(error.terminalConfirmed).toBe(false);
    expect(error.failureClass).toBe("parked_terminal");
    expect(error.evidence.code).toBe("CHATGPT_SEND_UNCONFIRMED");
    expect(evidence.map(value => value.kind)).toEqual(["start", "failure"]);
    expect(calls).toHaveLength(1);
  });

  test("disconnected start preserves uncertainty and sends no second request", async () => {
    const evidence: CapabilityEvidence[] = [];
    const { client, calls } = await socketFixture((_input, request) => { request.socket.destroy(); });
    const error = await client.createChatGptProvider(runContext(value => { evidence.push(value); })).run(providerInput()).catch(error => error);
    expect(error).toBeInstanceOf(ChatGptDispatchError);
    expect(error.terminalConfirmed).toBe(false);
    expect(error.evidence.code).toBe("CAPABILITY_DISCONNECTED");
    expect(evidence).toEqual([error.evidence]);
    expect(calls).toHaveLength(1);
  });

  test("explicit provider refusals stay failures without provider substitution or retry", async () => {
    for (const name of ["reject-unavailable-owner-before-send", "reject-new-send-after-stop", "reject-binding-generation-change"]) {
      const wire = byName(name), evidence: CapabilityEvidence[] = [];
      const { client, calls } = await exchange(wire);
      const error = await client.createChatGptProvider(runContext(value => { evidence.push(value); })).run(providerInput()).catch(error => error);
      expect(error.terminalConfirmed).toBe(true);
      expect(error.failureClass).toBe("parked_terminal");
      expect(error.evidence.code).toBe(wire.response.body.error.code);
      expect(calls).toHaveLength(1);
    }
  });

  test("continues only advancing observations and retains cursor on disconnect", async () => {
    const evidence: CapabilityEvidence[] = [];
    let observations = 0;
    const { client, calls } = await socketFixture((input, request, response) => {
      if (input.path.endsWith("/start")) { respond(response, startCase.response.body, 202); return; }
      observations++;
      if (observations === 1) {
        expect(input.body.after).toBeNull();
        respond(response, { ...observeCase.response.body, events: [observeCase.response.body.events[0]], nextCursor: "1", complete: false, result: null });
      } else {
        expect(input.body.after).toBe("1");
        request.socket.destroy();
      }
    });
    const error = await client.createChatGptProvider(runContext(value => { evidence.push(value); })).run(providerInput()).catch(error => error);
    expect(error.terminalConfirmed).toBe(false);
    expect(error.providerTurnId).toBe("user-2");
    expect(error.evidence.after).toBe("1");
    expect(evidence.map(value => value.kind)).toEqual(["start", "observe", "failure"]);
    expect(calls).toHaveLength(3);
  });

  test("empty active response parks instead of inventing an idle polling loop", async () => {
    const { client, calls } = await socketFixture((input, _request, response) => respond(response, input.path.endsWith("/start") ? startCase.response.body : {
      runId: startCase.request.body.runId, events: [], nextCursor: null, complete: false, result: null,
    }));
    const error = await client.createChatGptProvider(runContext(() => {})).run(providerInput()).catch(error => error);
    expect(error.terminalConfirmed).toBe(false);
    expect(error.evidence.code).toBe("CAPABILITY_PROTOCOL_ERROR");
    expect(calls).toHaveLength(2);
  });

  test("a refused observation cannot establish native failure after admitted dispatch", async () => {
    const { client, calls } = await socketFixture((input, _request, response) => {
      if (input.path.endsWith("/start")) respond(response, startCase.response.body, 202);
      else respond(response, { error: { code: "EFFECT_NOT_FOUND", message: "Receipt unavailable." } }, 404);
    });
    const error = await client.createChatGptProvider(runContext(() => {})).run(providerInput()).catch(error => error);
    expect(error.terminalConfirmed).toBe(false);
    expect(calls).toHaveLength(2);
  });

  test("rejects events from another run and never projects another session result", async () => {
    for (const mutate of [
      (body: any) => { body.events[0].runId = "another-run"; },
      (body: any) => { body.events[0].inputId = "another-input"; },
      (body: any) => { body.events[0].payload.nativeBinding.accountScope = "another-account"; },
      (body: any) => { body.result.sessionId = "another-conversation"; },
    ]) {
      const body = structuredClone(observeCase.response.body);
      mutate(body);
      const evidence: CapabilityEvidence[] = [];
      const { client } = await socketFixture((input, _request, response) => respond(response, input.path.endsWith("/start") ? startCase.response.body : body));
      const error = await client.createChatGptProvider(runContext(value => { evidence.push(value); })).run(providerInput()).catch(error => error);
      expect(error).toBeInstanceOf(ChatGptDispatchError);
      expect(error.terminalConfirmed).toBe(false);
      expect(evidence.map(value => value.kind)).toEqual(["start", "failure"]);
    }
  });

  test("a failed native result retains its partial output and exact identity without retry", async () => {
    const evidence: CapabilityEvidence[] = [];
    const body = structuredClone(observeCase.response.body);
    body.result.state = "failed";
    body.result.error = { code: "CHATGPT_NATIVE_FAILURE", message: "Synthetic native failure." };
    body.events[2].payload = structuredClone(body.result);
    const { client, calls } = await socketFixture((input, _request, response) => respond(response, input.path.endsWith("/start") ? startCase.response.body : body));
    const error = await client.createChatGptProvider(runContext(value => { evidence.push(value); })).run(providerInput()).catch(error => error);
    expect(error.terminalConfirmed).toBe(true);
    expect(error.providerSessionId).toBe(body.result.sessionId);
    expect(error.providerTurnId).toBe(body.result.turnId);
    expect(error.message).toBe("Synthetic native failure.");
    expect((evidence[1] as any).observation.result).toEqual(body.result);
    expect(calls).toHaveLength(2);
  });

  test("acknowledgement requires the explicit native receipt and never comes from transport acceptance", async () => {
    let acknowledgements = 0;
    const receipt = structuredClone(byName("repeat-start-terminal-inspects-same-effect").response.body);
    receipt.acknowledgedAt = "2026-09-15T12:00:01.000Z";
    const { client, calls } = await socketFixture((_input, _request, response) => respond(response, receipt));
    await client.createChatGptProvider(runContext(() => {})).run(providerInput({ onInputAcknowledged: () => { acknowledgements++; } }));
    expect(acknowledgements).toBe(1);
    expect(calls).toHaveLength(1);
  });

  test("durable evidence failure stops observation and carries the failure back to the owner", async () => {
    const { client, calls } = await exchange(startCase);
    const error = await client.createChatGptProvider(runContext(() => { throw new Error("Synthetic durable write failure"); })).run(providerInput()).catch(error => error);
    expect(error).toBeInstanceOf(ChatGptDispatchError);
    expect(error.terminalConfirmed).toBe(false);
    expect(error.evidence.code).toBe("CAPABILITY_HOST_FAILURE");
    expect(calls).toHaveLength(1);
  });

  test("a new observation waits for provider evidence with no additional request or timer", async () => {
    let release!: () => void, notifyObservation!: () => void;
    const observed = new Promise<void>(resolve => { notifyObservation = resolve; });
    const ready = new Promise<void>(resolve => { release = resolve; });
    const { client, calls } = await socketFixture(async (input, _request, response) => {
      if (input.path.endsWith("/start")) { respond(response, startCase.response.body, 202); return; }
      notifyObservation();
      await ready;
      respond(response, observeCase.response.body);
    });
    const running = client.createChatGptProvider(runContext(() => {})).run(providerInput());
    await observed;
    expect(calls).toHaveLength(2);
    release();
    expect((await running).text).toBe(observeCase.response.body.result.text);
    expect(calls).toHaveLength(2);
  });

  test("invalid JSON after a send remains uncertain without replay", async () => {
    const { client, calls } = await socketFixture((_input, _request, response) => {
      response.writeHead(202, { "content-type": "application/json" });
      response.end('{"runId":');
    });
    const error = await client.createChatGptProvider(runContext(() => {})).run(providerInput()).catch(error => error);
    expect(error.terminalConfirmed).toBe(false);
    expect(error.evidence.code).toBe("CAPABILITY_PROTOCOL_ERROR");
    expect(calls).toHaveLength(1);
  });

  test("abort ends only local observation and never invokes native Stop", async () => {
    const controller = new AbortController();
    const { client, calls } = await socketFixture((input, _request, response) => {
      if (input.path.endsWith("/start")) respond(response, startCase.response.body, 202);
      else controller.abort();
    });
    const error = await client.createChatGptProvider(runContext(() => {}, { signal: controller.signal })).run(providerInput()).catch(error => error);
    expect(error.terminalConfirmed).toBe(false);
    expect(error.evidence.code).toBe("CAPABILITY_OBSERVATION_ABORTED");
    expect(calls.map(call => call.path)).toEqual([startCase.request.path, observeCase.request.path]);
  });

  test("explicit unsupported fork never acquires a transport or native control", async () => {
    const { client, calls } = await socketFixture((_input, _request, response) => respond(response, {}));
    await expect(client.createChatGptProvider(runContext(() => {})).fork({ cwd: "/fixture", additionalDirs: [], sessionUUID: "native-id" })).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE", status: 409 });
    expect(calls).toHaveLength(0);
  });
});
