import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexControlRequestError,
  codexAppServerArgs,
  codexTurnDurationMs,
  findCodexForksByThreadSource,
  findCodexTurnIdsByReplayText,
  forkCodexSession,
  runCodexTurn,
  type ProgressEvent,
} from "../src/codex";
import {
  CodexAppServerClientError,
  codexAppServerSocketPath,
  type CodexAppServerClientLike,
} from "../src/codex-app-server-client";
import type { SteeringSender } from "../src/steering";
import { readCodexHistory, readCodexHistoryDetail, type ProviderHistoryMessage } from "../src/provider-history";
import { codexConsultationConfig } from "../src/provider-policy";
import { ProviderTurnCancelledError } from "../src/provider-failures";

// Codex rust-v0.153.4 config/src/overrides.rs splits paths literally on dots;
// config/src/merge.rs then recursively merges tables, preserving nested keys.
function applyCodexConfigOverrides(base: any, overrides: Record<string, unknown>): any {
  const merge = (original: any, overlay: any): any => {
    if (!original || !overlay || typeof original !== "object" || typeof overlay !== "object"
      || Array.isArray(original) || Array.isArray(overlay)) return structuredClone(overlay);
    return Object.fromEntries([...new Set([...Object.keys(original), ...Object.keys(overlay)])].map(key => [key,
      Object.hasOwn(overlay, key)
        ? merge(Object.hasOwn(original, key) ? original[key] : undefined, overlay[key])
        : structuredClone(original[key]),
    ]));
  };
  const layer = Object.entries(overrides).reduce((result, [path, value]) => merge(result,
    path.split(".").reduceRight<unknown>((nested, segment) => ({ [segment]: nested }), value)), {});
  return merge(base, layer);
}

function fakeCodex(dir: string, lines: string[]) {
  const executable = join(dir, "codex");
  writeFileSync(executable, ["#!/bin/sh", ...lines].join("\n"));
  chmodSync(executable, 0o755);
  return executable;
}

const initializeHandshake = [
  "IFS= read -r initialize",
  "case \"$initialize\" in *'\"method\":\"initialize\"'*'\"experimentalApi\":true'*) ;; *) exit 11;; esac",
  "printf '%s\\n' '{\"id\":1,\"result\":{\"userAgent\":\"fake\"}}'",
  "IFS= read -r initialized",
  "case \"$initialized\" in *'\"method\":\"initialized\"'*) ;; *) exit 12;; esac",
];

class ScriptedSharedClient implements CodexAppServerClientLike {
  model: unknown;
  generation = 0;
  connected = false;
  interruptCalls = 0;
  historyStatus: "inProgress" | "completed" | "interrupted" = "inProgress";
  historyTiming: { durationMs?: number; startedAt?: number; completedAt?: number } = {};
  consultationResponse: any = { approvalPolicy: "never", activePermissionProfile: { id: "concierge-consultation" },
    sandbox: { type: "readOnly", networkAccess: false } };
  effectiveConfig: any = { mcp_servers: { external: { command: "fixture-tool", enabled: true } } };
  turnStartError: CodexAppServerClientError | null = null;
  onTurnStart?: (client: ScriptedSharedClient) => void;
  onSteer?: (client: ScriptedSharedClient, params: any) => void;
  readonly requests: string[] = [];
  readonly requestParams: Array<{ method: string; params: any }> = [];
  private readonly notifications = new Set<(event: any) => void>();
  private readonly disconnects = new Set<(error: Error, generation: number) => void>();

  async connect() {
    if (!this.connected) {
      this.connected = true;
      this.generation += 1;
    }
    return this.generation;
  }

  async request(method: string, params: any) {
    this.requests.push(method);
    this.requestParams.push({ method, params });
    if (method === "config/read") return { config: this.effectiveConfig };
    if (method === "thread/start" || method === "thread/resume") {
      return { thread: { id: params.threadId || "shared-thread" }, model: this.model,
        ...(params.permissions ? this.consultationResponse : {}) };
    }
    if (method === "turn/start") {
      queueMicrotask(() => this.onTurnStart?.(this));
      if (this.turnStartError) throw this.turnStartError;
      return { turn: { id: "shared-turn" } };
    }
    if (method === "thread/read") {
      return {
        thread: {
          turns: [{
            id: "shared-turn",
            status: this.historyStatus,
            ...this.historyTiming,
            error: this.historyStatus === "interrupted" ? { message: "interrupted" } : null,
            items: [
              {
                id: "shared-user",
                type: "userMessage",
                clientId: "slack-concierge:turn:shared",
                content: [{ type: "text", text: "shared request" }],
              },
              {
                id: "shared-commentary",
                type: "agentMessage",
                phase: "commentary",
                text: "Investigating once.",
              },
              ...(this.historyStatus === "completed" ? [{
                id: "shared-answer",
                type: "agentMessage",
                phase: "final_answer",
                text: "TL;DR: recovered exact turn",
              }] : []),
            ],
          }],
        },
      };
    }
    if (method === "turn/steer") {
      this.onSteer?.(this, params);
      return { turnId: "shared-turn" };
    }
    if (method === "turn/interrupt") {
      this.interruptCalls += 1;
      this.historyStatus = "interrupted";
      return {};
    }
    throw new Error(`unexpected method ${method}`);
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

  emit(event: any) {
    for (const listener of this.notifications) listener(event);
  }

  disconnect() {
    const disconnectedGeneration = this.generation;
    this.connected = false;
    for (const listener of this.disconnects) {
      listener(new Error("scripted bridge disconnect"), disconnectedGeneration);
    }
  }
}

describe("codex app-server", () => {
  test.each([
    { context7: { url: "https://example.invalid/mcp", enabled: true }, local_tool: { command: "fixture-tool" } },
    { ordinary: { command: "fixture-tool", enabled: false }, "ordinary.dotted": { url: "https://example.invalid/mcp" }, 'quoted"name': { command: "fixture-tool" } },
  ])("consultation disables the exact configured MCP transports through native override parsing: %j", servers => {
    const effective = { mcp_servers: servers };
    const unchanged = structuredClone(effective);
    const parsed = applyCodexConfigOverrides(effective, codexConsultationConfig(effective));
    expect(parsed.mcp_servers).toEqual(Object.fromEntries(Object.entries(servers).map(([name, transport]) => [name,
      { ...transport, enabled: false },
    ])));
    expect(effective).toEqual(unchanged);
  });

  for (const transport of ["shared", "stdio"] as const) for (const sessionUUID of [null, "shared-thread"]) {
    test(`native message observations retain exact input/tool/final identities across ${transport} steering and resume=${sessionUUID}`, async () => {
      const client = new ScriptedSharedClient();
      const user = { id: "user-native", type: "userMessage", clientId: "initial-owned-client", content: [{ type: "text", text: "  Exact initial\n" }] };
      const toolStart = { id: "tool-native", type: "commandExecution", command: "native command", status: "inProgress" };
      const toolEnd = { ...toolStart, status: "completed", aggregatedOutput: "  Exact output\n" };
      const commentary = { id: "commentary-native", type: "agentMessage", phase: "commentary", text: "  Exact commentary\n" };
      const steer = { id: "steered-native", type: "userMessage", clientId: "steering-native-client", content: [{ type: "text", text: "Exact guidance" }] };
      const final = { id: "final-native", type: "agentMessage", phase: "final_answer", text: "  Exact final\n" };
      const itemEvent = (item: any, method = "item/completed", threadId = "shared-thread", turnId = "shared-turn") => ({
        method, params: { threadId, turnId, item },
      });
      const initialEvents = [
        itemEvent({ ...user, id: "old-input" }, "item/completed", "shared-thread", "old-turn"),
        itemEvent({ ...user, id: "other-session-input" }, "item/completed", "other-thread"),
        itemEvent({ type: "agentMessage", text: "Missing native identity" }),
        itemEvent(user, "item/started"), itemEvent(user), itemEvent(toolStart, "item/started"),
        itemEvent(commentary), itemEvent(commentary),
      ];
      const finalItems = [user, toolEnd, commentary, steer, final];
      const terminal = { method: "turn/completed", params: { threadId: "shared-thread", turn: { id: "shared-turn", status: "completed", items: finalItems } } };
      const afterSteering = [itemEvent(steer, "item/started"), itemEvent(steer), itemEvent(toolEnd), itemEvent(final)];
      client.onTurnStart = active => {
        active.emit({ method: "turn/started", params: { threadId: "shared-thread", turn: { id: "shared-turn", status: "inProgress" } } });
        for (const event of initialEvents) active.emit(event);
      };
      client.onSteer = active => { for (const event of afterSteering) active.emit(event); };
      const request = client.request.bind(client);
      client.request = async (method, params) => method === "thread/read"
        ? { thread: { turns: [{ id: "old-turn", status: "completed", items: [{ ...final, id: "old-final" }] }, terminal.params.turn] } }
        : request(method, params);
      const directory = mkdtempSync(join(tmpdir(), "concierge-message-test-"));
      const output = (event: unknown) => `printf '%s\\n' '${JSON.stringify(event)}'`;
      const executable = fakeCodex(directory, [
        ...initializeHandshake,
        "IFS= read -r thread", output({ id: 2, result: { thread: { id: "shared-thread" } } }),
        "IFS= read -r turn", output({ id: 3, result: { turn: { id: "shared-turn" } } }),
        output({ method: "turn/started", params: { threadId: "shared-thread", turn: { id: "shared-turn", status: "inProgress" } } }),
        ...initialEvents.map(output), "IFS= read -r steer", output({ id: 4, result: { turnId: "shared-turn" } }),
        ...afterSteering.map(output), output(terminal),
      ]);
      let ready!: () => void;
      let sender!: SteeringSender;
      let boundTurn: string | null = null;
      const registered = new Promise<void>(resolve => { ready = resolve; });
      const messages: ProviderHistoryMessage[] = [];
      try {
        const running = runCodexTurn({ prompt: "  Exact initial\n", cwd: directory, additionalDirs: [], sessionUUID,
          clientUserMessageId: "initial-owned-client", ...(transport === "shared" ? { appServerClient: client } : { executable }),
          onProviderTurnStarted: turnId => { boundTurn = turnId; },
          onProviderMessage: message => { expect(boundTurn).toBe("shared-turn"); messages.push(message); },
          onSteeringReady: value => { sender = value; ready(); },
          requestTimeoutMs: 1_000, inactivityTimeoutMs: 1_000,
        });
        await Promise.race([registered, running.then(() => { throw new Error("Ended before steering"); })]);
        await sender({ clientMessageId: "steering-native-client", text: "Exact guidance" });
        if (transport === "shared") client.disconnect();
        await running;
        expect(messages.map(message => message.id)).toEqual([
          "user-native", "tool-native", "commentary-native", "steered-native", "tool-native", "final-native",
        ]);
        const historyRequest = async () => ({ data: finalItems.slice().reverse().map(item => ({ turnId: "shared-turn", item })), nextCursor: null });
        const history = await readCodexHistory({ sessionUuid: "shared-thread", cwd: directory, cursor: null, limit: 20 }, historyRequest);
        expect([...new Map(messages.map(message => [message.id, message])).values()]).toEqual(history.messages);
        expect(await readCodexHistoryDetail({ sessionUuid: "shared-thread", cwd: directory, detailKey: messages[1]!.detailKey! }, historyRequest))
          .toEqual({ content: JSON.stringify(toolEnd) });
        if (transport === "shared") expect(client.requests.filter(method => method === "turn/start")).toHaveLength(1);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    });
  }
  test.each([null, "shared-thread"])("consultation enforces policy on initial/follow-up and recovery, session=%s", async sessionUUID => {
    const client = new ScriptedSharedClient();
    client.historyStatus = "completed";
    client.onTurnStart = active => {
      active.effectiveConfig = { mcp_servers: { external: { command: "fixture-tool" }, "new.server": { url: "https://example.invalid/mcp" } } };
      active.disconnect();
    };
    await runCodexTurn({ prompt: "shared request", cwd: "/tmp", additionalDirs: ["/root"], sessionUUID,
      interactionPolicy: "consultation-only", appServerClient: client, clientUserMessageId: "slack-concierge:turn:shared",
      environment: { CONCIERGE_COMMIT_PROVENANCE: "must-not-reach-tools", ARBITRARY_ACTION_AUTHORITY: "never" } });
    const threads = client.requestParams.filter(({ method }) => method === "thread/start" || method === "thread/resume");
    expect(threads).toHaveLength(2);
    for (const { params } of threads) {
      expect(params).toMatchObject({ permissions: "concierge-consultation", approvalPolicy: "never", runtimeWorkspaceRoots: ["/tmp"] });
      expect(params.sandbox).toBeUndefined();
      expect(params.config["permissions.concierge-consultation.filesystem"]).toEqual({ ":root": "deny" });
      expect(params.config["permissions.concierge-consultation.network.enabled"]).toBeFalse();
      expect(params.config.shell_environment_policy).toEqual({ inherit: "none", set: {} });
      expect(applyCodexConfigOverrides({ mcp_servers: { external: { command: "fixture-tool" } } }, params.config)
        .mcp_servers.external).toEqual({ command: "fixture-tool", enabled: false });
      for (const tool of ["shell_tool", "unified_exec", "multi_agent_v2", "code_mode_host", "js_repl", "plugins", "browser_use", "memory_tool"]) {
        expect(params.config[`features.${tool}`]).toBeFalse();
      }
      expect(params.config.web_search).toBe("disabled");
    }
    if (sessionUUID === null) expect(threads[0]!.params.dynamicTools).toEqual([]);
    expect(applyCodexConfigOverrides(client.effectiveConfig, threads[1]!.params.config).mcp_servers).toEqual({
      external: { command: "fixture-tool", enabled: false },
      "new.server": { url: "https://example.invalid/mcp", enabled: false },
    });
    const turns = client.requestParams.filter(({ method }) => method === "turn/start");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.params.environments).toEqual([]);
    expect(turns[0]!.params).not.toHaveProperty("permissions");
  });

  test("inline consultation permissions survive initial, follow-up and recovery without a host profile", async () => {
    // rust-v0.153.4 turn_processor.rs reloads named turn permissions with
    // request_overrides=None; omitted permission overrides keep thread policy.
    class InlinePermissionClient extends ScriptedSharedClient {
      threadConfig: any;
      admittedPolicies: any[] = [];
      override async request(method: string, params: any) {
        if (method === "thread/resume" && this.admittedPolicies.length === 0) throw new CodexAppServerClientError(
          "Codex app-server thread/resume failed: no rollout found for thread id shared-thread", "ambiguous", -32600,
        );
        if (method === "thread/start" || method === "thread/resume") {
          this.threadConfig = applyCodexConfigOverrides(this.effectiveConfig, params.config);
        }
        if (method === "turn/start") {
          const permissionConfig = params.permissions ? this.effectiveConfig : this.threadConfig;
          const profile = permissionConfig.permissions?.[params.permissions || "concierge-consultation"];
          if (!profile) throw new CodexAppServerClientError(
            "Codex app-server turn/start failed: failed to load configuration: default_permissions requires a `[permissions]` table",
            "ambiguous", -32600,
          );
          this.admittedPolicies.push(structuredClone({ profile, config: this.threadConfig, environments: params.environments }));
        }
        return super.request(method, params);
      }
    }
    const client = new InlinePermissionClient();
    client.effectiveConfig = { mcp_servers: { context7: { command: "fixture-tool" }, "literal.dotted": { url: "https://example.invalid/mcp" } } };
    const hostConfig = structuredClone(client.effectiveConfig);
    client.historyStatus = "completed";
    client.onTurnStart = active => {
      if (client.admittedPolicies.length === 1) active.emit({ method: "turn/completed", params: {
        threadId: "shared-thread", turn: { id: "shared-turn", status: "completed", items: [] },
      } });
      else active.disconnect();
    };
    const initial = await runCodexTurn({ prompt: "shared request", cwd: "/tmp", additionalDirs: ["/root"], sessionUUID: null,
      interactionPolicy: "consultation-only", appServerClient: client });
    await runCodexTurn({ prompt: "shared request", cwd: "/tmp", additionalDirs: ["/root"], sessionUUID: initial.sessionUUID,
      interactionPolicy: "consultation-only", appServerClient: client, clientUserMessageId: "slack-concierge:turn:shared" });
    expect(initial.sessionUUID).toBe("shared-thread");
    expect(client.requests.filter(method => method === "thread/start")).toHaveLength(1);
    expect(client.requests.filter(method => method === "thread/resume")).toHaveLength(2);
    expect(client.requests.filter(method => method === "turn/start")).toHaveLength(2);
    expect(client.admittedPolicies).toHaveLength(2);
    for (const policy of client.admittedPolicies) {
      expect(policy.profile).toEqual({ filesystem: { ":root": "deny" }, network: { enabled: false } });
      expect(policy.environments).toEqual([]);
      expect(policy.config.shell_environment_policy).toEqual({ inherit: "none", set: {} });
      expect(policy.config.mcp_servers).toEqual({ context7: { command: "fixture-tool", enabled: false },
        "literal.dotted": { url: "https://example.invalid/mcp", enabled: false } });
      expect(policy.config.features).toMatchObject({ shell_tool: false, unified_exec: false, code_mode: false,
        code_mode_host: false, multi_agent: false, multi_agent_v2: false, browser_use: false, plugins: false, tool_search: false });
      expect(policy.config.web_search).toBe("disabled");
    }
    expect(client.effectiveConfig).toEqual(hostConfig);
    expect(client.effectiveConfig).not.toHaveProperty("permissions");
  });

  test.each(["missing-config", "wrong-policy", "network", "full-access"])("consultation refuses %s before provider admission", async failure => {
    const client = new ScriptedSharedClient();
    if (failure === "missing-config") client.effectiveConfig = null;
    if (failure === "wrong-policy") client.consultationResponse.activePermissionProfile.id = "default";
    if (failure === "network") client.consultationResponse.sandbox.networkAccess = true;
    if (failure === "full-access") client.consultationResponse.sandbox.type = "dangerFullAccess";
    await expect(runCodexTurn({ prompt: "consult", cwd: "/tmp", additionalDirs: [], sessionUUID: null,
      interactionPolicy: "consultation-only", appServerClient: client })).rejects.toThrow(/consultation|configuration|information-only/);
    expect(client.requests).not.toContain("turn/start");
  });

  test("recovery parks an unconfirmed consultation when the resumed permission policy changes", async () => {
    const client = new ScriptedSharedClient();
    client.onTurnStart = active => {
      active.consultationResponse.sandbox.type = "dangerFullAccess";
      active.disconnect();
    };
    await expect(runCodexTurn({ prompt: "shared request", cwd: "/tmp", additionalDirs: [], sessionUUID: null,
      interactionPolicy: "consultation-only", appServerClient: client })).rejects.toMatchObject({ terminalConfirmed: false });
    expect(client.requests.filter(method => method === "turn/start")).toHaveLength(1);
    expect(client.requests.filter(method => method === "thread/resume")).toHaveLength(1);
  });

  test("stdio consultation uses the same restricted thread and turn boundary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "consultation-stdio-"));
    const threadPath = join(dir, "thread.json");
    const turnPath = join(dir, "turn.json");
    const executable = fakeCodex(dir, [...initializeHandshake,
      "IFS= read -r config", "printf '%s\\n' '{\"id\":2,\"result\":{\"config\":{\"mcp_servers\":{\"external\":{\"command\":\"fixture-tool\"}}}}}'",
      "IFS= read -r thread", `printf '%s\\n' "$thread" > '${threadPath}'`,
      "printf '%s\\n' '{\"id\":3,\"result\":{\"thread\":{\"id\":\"restricted\"},\"approvalPolicy\":\"never\",\"activePermissionProfile\":{\"id\":\"concierge-consultation\"},\"sandbox\":{\"type\":\"readOnly\",\"networkAccess\":false}}}'",
      "IFS= read -r turn", `printf '%s\\n' "$turn" > '${turnPath}'`,
      "printf '%s\\n' '{\"id\":4,\"result\":{\"turn\":{\"id\":\"restricted-turn\"}}}'",
      "printf '%s\\n' '{\"method\":\"turn/started\",\"params\":{\"threadId\":\"restricted\",\"turn\":{\"id\":\"restricted-turn\"}}}'",
      "printf '%s\\n' '{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"restricted\",\"turn\":{\"id\":\"restricted-turn\",\"status\":\"completed\"}}}'",
    ]);
    try {
      await runCodexTurn({ prompt: "consult", cwd: dir, additionalDirs: ["/root"], sessionUUID: null,
        interactionPolicy: "consultation-only", executable });
      const thread = await Bun.file(threadPath).json();
      const turn = await Bun.file(turnPath).json();
      expect(thread.params).toMatchObject({ permissions: "concierge-consultation", dynamicTools: [], runtimeWorkspaceRoots: [dir] });
      expect(thread.params.config["features.shell_tool"]).toBeFalse();
      expect(applyCodexConfigOverrides({ mcp_servers: { external: { command: "fixture-tool" } } }, thread.params.config)
        .mcp_servers).toEqual({ external: { command: "fixture-tool", enabled: false } });
      expect(turn.params.environments).toEqual([]);
      expect(turn.params).not.toHaveProperty("permissions");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  for (const transport of ["shared", "stdio"]) test.each([false, true])(`initial receipt requires the matching user item, transport=${transport}, acknowledged=%s`, async acknowledged => {
    const client = new ScriptedSharedClient();
    const user = { type: "userMessage", id: "initial", clientId: "initial-request", content: [] };
    const events = [
      { method: "turn/started", params: { threadId: "shared-thread", turn: { id: "shared-turn", status: "inProgress" } } },
      ...["other-thread", "shared-thread"].map(threadId => ({ method: "item/started", params: { threadId, turnId: "shared-turn", item: { ...user, clientId: threadId === "other-thread" ? "initial-request" : "other-request" } } })),
      ...(acknowledged ? ["item/started", "item/completed"].map(method => ({ method, params: { threadId: "shared-thread", turnId: "shared-turn", item: user } })) : []),
      { method: "turn/completed", params: { threadId: "shared-thread", turn: { id: "shared-turn", status: "completed", items: acknowledged ? [user] : [] } } },
    ];
    client.onTurnStart = active => events.forEach(event => active.emit(event));
    const dir = mkdtempSync(join(tmpdir(), "concierge-input-ack-"));
    const output = (event: unknown) => `printf '%s\\n' '${JSON.stringify(event)}'`;
    const executable = fakeCodex(dir, [...initializeHandshake,
      "IFS= read -r thread", output({ id: 2, result: { thread: { id: "shared-thread" } } }),
      "IFS= read -r turn", output({ id: 3, result: { turn: { id: "shared-turn" } } }), ...events.map(output),
    ]);
    let receipts = 0;
    try {
      await runCodexTurn({ prompt: "request", cwd: dir, additionalDirs: [], sessionUUID: null,
        clientUserMessageId: "initial-request", onInputAcknowledged: () => { receipts++; },
        ...(transport === "shared" ? { appServerClient: client } : { executable }),
      });
      expect(receipts).toBe(acknowledged ? 1 : 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("reconnect proves initial receipt from exact native history without resubmitting", async () => {
    const client = new ScriptedSharedClient();
    client.historyStatus = "completed";
    client.onTurnStart = active => active.disconnect();
    let receipts = 0;
    await runCodexTurn({ prompt: "shared request", cwd: "/tmp", additionalDirs: [], sessionUUID: null,
      clientUserMessageId: "slack-concierge:turn:shared", appServerClient: client,
      onInputAcknowledged: () => { receipts++; },
    });
    expect(receipts).toBe(1);
    expect(client.requests.filter(method => method === "turn/start")).toHaveLength(1);
  });
  for (const transport of ["shared", "stdio"]) {
    for (const sessionUUID of [null, "shared-thread"]) {
      test.each([undefined, "gpt-6-astra", "rerouted"])(`reports the resolved model for ${transport}, session=${sessionUUID}, model=%s`, async (reportedModel) => {
        const client = new ScriptedSharedClient();
        client.model = reportedModel === "rerouted" ? "gpt-6-astra" : reportedModel;
        const events = [
          { method: "turn/started", params: { threadId: "shared-thread", turn: { id: "shared-turn", status: "inProgress" } } },
          ...(reportedModel === "rerouted" ? [{ method: "model/rerouted", params: { threadId: "shared-thread", turnId: "shared-turn", toModel: "gpt-5.6-sol" } }] : []),
          { method: "model/rerouted", params: { threadId: "other-thread", turnId: "shared-turn", toModel: "wrong-thread-model" } },
          { method: "model/rerouted", params: { threadId: "shared-thread", turnId: "other-turn", toModel: "wrong-turn-model" } },
          { method: "turn/completed", params: { threadId: "shared-thread", turn: { id: "shared-turn", status: "completed" } } },
        ];
        client.onTurnStart = active => events.forEach(event => active.emit(event));
        const dir = mkdtempSync(join(tmpdir(), "concierge-model-test-"));
        const output = (event: unknown) => `printf '%s\\n' '${JSON.stringify(event)}'`;
        const executable = fakeCodex(dir, [
          ...initializeHandshake,
          "IFS= read -r thread", output({ id: 2, result: { thread: { id: "shared-thread" }, model: client.model } }),
          "IFS= read -r turn", output({ id: 3, result: { turn: { id: "shared-turn" } } }),
          ...events.map(output),
        ]);
        try {
          const result = await runCodexTurn({
            prompt: "Report model", cwd: dir, additionalDirs: [], sessionUUID, model: "requested-alias",
            ...(transport === "shared" ? { appServerClient: client } : { executable }),
          });
          expect(result.model).toBe(reportedModel === "rerouted" ? "gpt-5.6-sol" : reportedModel);
        } finally { rmSync(dir, { recursive: true, force: true }); }
      });
    }
  }

  for (const transport of ["shared", "stdio"]) test(`projects both consumed guidance messages after early acknowledgements, transport=${transport}`, async () => {
    const client = new ScriptedSharedClient();
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const events = ["first-guidance", "second-guidance"].flatMap(id => ["item/started", "item/completed"].map(method => ({
      method, params: { threadId: "shared-thread", turnId: "shared-turn", item: { id, type: "userMessage", clientId: id, content: [] } },
    })));
    const terminal = { method: "turn/completed", params: { threadId: "shared-thread", turn: { id: "shared-turn", status: "completed" } } };
    const output = (event: unknown) => `printf '%s\\n' '${JSON.stringify(event)}'`;
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r thread", output({ id: 2, result: { thread: { id: "shared-thread" } } }),
      "IFS= read -r turn", output({ id: 3, result: { turn: { id: "shared-turn" } } }),
      output({ method: "turn/started", params: { threadId: "shared-thread", turn: { id: "shared-turn", status: "inProgress" } } }),
      "IFS= read -r first", output({ id: 4, result: { turnId: "shared-turn" } }),
      "IFS= read -r second", output({ id: 5, result: { turnId: "shared-turn" } }),
      ...events.map(output), output(terminal),
    ]);
    const progress: ProgressEvent[] = [];
    let sender!: SteeringSender;
    let ready!: () => void;
    const registered = new Promise<void>(resolve => { ready = resolve; });
    const running = runCodexTurn({
      prompt: "shared request", cwd: "/tmp", additionalDirs: [], sessionUUID: null,
      ...(transport === "shared" ? { appServerClient: client } : { executable }),
      requestTimeoutMs: 100, inactivityTimeoutMs: 1_000,
      onProgress: event => progress.push(event),
      onSteeringReady: value => { sender = value; ready(); },
    });
    await registered;
    await sender({ clientMessageId: "first-guidance", text: "first" });
    await sender({ clientMessageId: "second-guidance", text: "second" });
    try {
      if (transport === "shared") for (const event of [...events, terminal]) client.emit(event);
      await running;
      expect(progress.filter(e => e.type === "steering")).toEqual([
        { type: "steering", clientMessageId: "first-guidance" },
        { type: "steering", clientMessageId: "second-guidance" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const beforeAck of [true, false]) test(`shared steering starts one new progress interval at the consumed user item, beforeAck=${beforeAck}`, async () => {
    const client = new ScriptedSharedClient();
    const progress: ProgressEvent[] = [];
    let sender!: SteeringSender;
    let ready!: () => void;
    const registered = new Promise<void>(resolve => { ready = resolve; });
    client.onSteer = (active, params) => {
      const emit = () => {
        const item = { id: "steering-user", type: "userMessage", clientId: params.clientUserMessageId, content: [] };
        const notifyItem = (method: string, value: any) => active.emit({ method, params: { threadId: "shared-thread", turnId: "shared-turn", item: value } });
        notifyItem("item/started", { ...item, clientId: "unsubmitted" });
        notifyItem("item/started", item);
        notifyItem("item/completed", { id: "after-steer", type: "agentMessage", phase: "commentary", text: "Updated approach" });
        notifyItem("item/completed", item);
        active.emit({ method: "turn/completed", params: { threadId: "shared-thread", turn: { id: "shared-turn", status: "completed", items: [item] } } });
      };
      if (beforeAck) emit();
      else setTimeout(emit, 0);
    };
    const running = runCodexTurn({
      prompt: "shared request", cwd: "/tmp", additionalDirs: [], sessionUUID: null,
      appServerClient: client, requestTimeoutMs: 100, inactivityTimeoutMs: 1_000,
      onProgress: event => progress.push(event),
      onSteeringReady: value => { sender = value; ready(); },
    });
    await registered;
    await sender({ clientMessageId: "steer-new", text: "new guidance" });
    expect((await running).text).toBe("Updated approach");
    expect(progress.filter(e => e.type === "steering" || e.type === "commentary")).toEqual([
      { type: "steering", clientMessageId: "steer-new" },
      { type: "commentary", text: "Updated approach" },
    ]);
  });

  test("uses only provider duration or valid provider timestamps, never local elapsed time", () => {
    expect(codexTurnDurationMs({ durationMs: 1_122_123, startedAt: 100, completedAt: 200 })).toBe(1_122_123);
    expect(codexTurnDurationMs({ durationMs: 0, startedAt: 100, completedAt: 200 })).toBe(0);
    expect(codexTurnDurationMs({ durationMs: null, startedAt: 100, completedAt: 200 })).toBe(100_000);
    expect(codexTurnDurationMs({ startedAt: 100, completedAt: 100 })).toBe(0);
    for (const turn of [
      {}, { durationMs: null }, { durationMs: -1 }, { durationMs: Infinity },
      { durationMs: NaN }, { durationMs: "1000" }, { durationMs: 1.5 },
      { startedAt: 200, completedAt: 100 }, { startedAt: null, completedAt: 100 },
      { startedAt: 0, completedAt: Number.MAX_SAFE_INTEGER }, { startedAt: 100 },
    ]) expect(codexTurnDurationMs(turn)).toBeUndefined();
  });

  test("keeps shared terminal timing scoped to the exact provider turn", async () => {
    const client = new ScriptedSharedClient();
    client.onTurnStart = active => {
      for (const [threadId, turnId, durationMs] of [
        ["other-thread", "shared-turn", 10],
        ["shared-thread", "other-turn", 20],
        ["shared-thread", "shared-turn", 1_122_000],
      ]) active.emit({ method: "turn/completed", params: {
        threadId, turn: { id: turnId, status: "completed", durationMs },
      } });
    };
    const result = await runCodexTurn({
      prompt: "shared request", cwd: "/tmp", additionalDirs: [], sessionUUID: null,
      appServerClient: client, requestTimeoutMs: 100, inactivityTimeoutMs: 1_000,
    });
    expect(result.durationMs).toBe(1_122_000);
    expect(result.providerTurnId).toBe("shared-turn");
  });

  test("uses the bidirectional app-server transport", () => {
    expect(codexAppServerArgs()).toEqual(["app-server", "--stdio"]);
  });

  test("uses the managed daemon control socket for production clients", () => {
    const previousSocket = process.env.CONCIERGE_CODEX_APP_SERVER_SOCKET;
    try {
      process.env.CONCIERGE_CODEX_APP_SERVER_SOCKET = "/tmp/codex.sock";
      expect(codexAppServerSocketPath()).toBe("/tmp/codex.sock");
    } finally {
      if (previousSocket === undefined) delete process.env.CONCIERGE_CODEX_APP_SERVER_SOCKET;
      else process.env.CONCIERGE_CODEX_APP_SERVER_SOCKET = previousSocket;
    }
  });

  test("reconciles an accepted daemon turn after the shared connection disconnects", async () => {
    const client = new ScriptedSharedClient();
    client.historyTiming = { startedAt: 100, completedAt: 142 };
    const narration: string[] = [];
    let providerTerminal = false;
    client.onTurnStart = (active) => {
      active.emit({
        method: "turn/completed",
        params: {
          threadId: "shared-thread",
          turn: {
            id: "unrelated-remote-turn",
            status: "completed",
            items: [{
              id: "unrelated-answer",
              type: "agentMessage",
              phase: "final_answer",
              text: "WRONG TURN",
            }],
          },
        },
      });
      active.emit({
        method: "item/completed",
        params: {
          threadId: "shared-thread",
          turnId: "shared-turn",
          item: {
            id: "shared-commentary",
            type: "agentMessage",
            phase: "commentary",
            text: "Investigating once.",
          },
        },
      });
      active.historyStatus = "completed";
      active.disconnect();
    };

    const result = await runCodexTurn({
      prompt: "shared request",
      cwd: "/tmp",
      additionalDirs: [],
      sessionUUID: null,
      clientUserMessageId: "slack-concierge:turn:shared",
      appServerClient: client,
      requestTimeoutMs: 100,
      inactivityTimeoutMs: 1_000,
      onProgress: (event) => {
        if (event.type === "narration" && event.text) narration.push(event.text);
      },
      onProviderTerminal: () => { providerTerminal = true; },
    });

    expect(result).toMatchObject({
      text: "TL;DR: recovered exact turn",
      sessionUUID: "shared-thread",
      providerTurnId: "shared-turn",
      durationMs: 42_000,
    });
    expect(client.generation).toBe(2);
    expect(narration).toEqual(["Investigating once.", "TL;DR: recovered exact turn"]);
    expect(providerTerminal).toBeTrue();
  });

  test("recovers an accepted turn after a non-definitive turn/start JSON-RPC error", async () => {
    const client = new ScriptedSharedClient();
    client.turnStartError = new CodexAppServerClientError(
      "internal failure after commit",
      "ambiguous",
      -32603,
    );
    client.historyStatus = "completed";
    let providerTurnPersistenceCalls = 0;

    const result = await runCodexTurn({
      prompt: "shared request",
      cwd: "/tmp",
      additionalDirs: [],
      sessionUUID: null,
      clientUserMessageId: "slack-concierge:turn:shared",
      appServerClient: client,
      requestTimeoutMs: 100,
      inactivityTimeoutMs: 1_000,
      onProviderTurnStarted: () => {
        providerTurnPersistenceCalls += 1;
        if (providerTurnPersistenceCalls === 1) throw new Error("sqlite busy");
      },
    });

    expect(result.text).toBe("TL;DR: recovered exact turn");
    expect(result.providerTurnId).toBe("shared-turn");
    expect(providerTurnPersistenceCalls).toBe(2);
  });

  test.each(["thread/resume", "thread/read"])("parks the original uncertain start when reconciliation rejects %s", async method => {
    class UnsupportedHistoryClient extends ScriptedSharedClient {
      rejected = false;
      override async request(name: string, params: any) {
        const result = await super.request(name, params);
        if (name === method && !this.rejected) {
          this.rejected = true;
          throw new CodexAppServerClientError(`${name} failed: list_turns is not supported yet`, "ambiguous", -32601);
        }
        return result;
      }
    }
    const client = new UnsupportedHistoryClient();
    client.turnStartError = new CodexAppServerClientError("turn/start failed: original unconfirmed RPC failure", "ambiguous", -32603);
    client.onTurnStart = active => active.disconnect();
    client.historyStatus = "completed";
    let acknowledged = false, terminal = false;
    const outcome = await runCodexTurn({ prompt: "shared request", cwd: "/tmp", additionalDirs: [], sessionUUID: null,
      interactionPolicy: "consultation-only", appServerClient: client, clientUserMessageId: "slack-concierge:turn:shared",
      onInputAcknowledged: () => { acknowledged = true; }, onProviderTerminal: () => { terminal = true; },
    }).then(result => ({ result, error: null }), error => ({ result: null, error }));
    expect(outcome.error).toMatchObject({ terminalConfirmed: false, providerSessionId: "shared-thread", providerTurnId: null });
    expect(String(outcome.error)).toContain("original unconfirmed RPC failure");
    expect(String(outcome.error)).toContain("list_turns is not supported yet");
    expect(String(outcome.error)).toContain("turn/start failed: original unconfirmed RPC failure (JSON-RPC code -32603)");
    expect(String(outcome.error)).toContain(`${method} failed: list_turns is not supported yet (JSON-RPC code -32601)`);
    expect(client.requests.filter(value => value === "turn/start")).toHaveLength(1);
    expect(client.requests.filter(value => value === method)).toHaveLength(1);
    expect(acknowledged).toBeFalse();
    expect(terminal).toBeFalse();
  });

  test("Stop before provider submission does not start a Codex turn", async () => {
    class InterruptingClient extends ScriptedSharedClient {
      override async request(method: string, params: any) {
        const response = await super.request(method, params);
        if (method === "turn/interrupt") this.emit({ method: "turn/completed", params: {
          threadId: "shared-thread", turn: { id: "shared-turn", status: "interrupted", items: [] },
        } });
        return response;
      }
    }
    const client = new InterruptingClient();
    let stop: Promise<void> | undefined;
    await expect(runCodexTurn({ prompt: "shared request", cwd: "/tmp", additionalDirs: [], sessionUUID: null,
      interactionPolicy: "consultation-only", appServerClient: client,
      onCancellationReady: cancel => { stop = cancel(); },
    })).rejects.toBeInstanceOf(ProviderTurnCancelledError);
    await stop;
    expect(client.requests).not.toContain("turn/start");
    expect(client.interruptCalls).toBe(0);
  });

  test("Stop remains responsive before turn/start acknowledges an exact provider turn", async () => {
    let submitted!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { submitted = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    class PendingStartClient extends ScriptedSharedClient {
      override async request(method: string, params: any) {
        const response = await super.request(method, params);
        if (method === "turn/start") {
          submitted(); await pending;
          this.emit({ method: "turn/completed", params: {
            threadId: "shared-thread", turn: { id: "shared-turn", status: "completed", items: [] },
          } });
        }
        return response;
      }
    }
    const client = new PendingStartClient();
    let cancel: (() => Promise<void>) | undefined, terminal = false;
    const running = runCodexTurn({ prompt: "shared request", cwd: "/tmp", additionalDirs: [], sessionUUID: null,
      interactionPolicy: "consultation-only", appServerClient: client,
      onCancellationReady: value => { cancel = value; }, onProviderTerminal: () => { terminal = true; },
    }).then(result => ({ result, error: null }), error => ({ result: null, error }));
    await entered;
    const readyBeforeAcknowledgement = Boolean(cancel);
    const stopError = cancel ? await cancel().then(() => null, error => error) : null;
    release();
    const outcome = await running;
    expect(readyBeforeAcknowledgement).toBeTrue();
    expect(stopError).toMatchObject({ terminalConfirmed: false, providerSessionId: "shared-thread", providerTurnId: null });
    expect(outcome.error).toBe(stopError);
    expect(client.interruptCalls).toBe(0);
    expect(client.requests.filter(value => value === "turn/start")).toHaveLength(1);
    expect(terminal).toBeFalse();
  });

  test("Stop interrupts the exact known turn without waiting behind a pending recovery read", async () => {
    let reading!: () => void, release!: () => void, cancellationReady!: () => void;
    const entered = new Promise<void>(resolve => { reading = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { cancellationReady = resolve; });
    class PendingReadClient extends ScriptedSharedClient {
      override async request(method: string, params: any) {
        if (method === "thread/read") { reading(); await pending; }
        const response = await super.request(method, params);
        if (method === "turn/interrupt") this.emit({ method: "turn/completed", params: {
          threadId: "shared-thread", turn: { id: "shared-turn", status: "interrupted", items: [] },
        } });
        return response;
      }
    }
    const client = new PendingReadClient();
    client.onTurnStart = active => active.disconnect();
    let cancel!: () => Promise<void>;
    const running = runCodexTurn({ prompt: "shared request", cwd: "/tmp", additionalDirs: [], sessionUUID: null,
      interactionPolicy: "consultation-only", appServerClient: client,
      onCancellationReady: value => { cancel = value; cancellationReady(); },
    }).then(result => ({ result, error: null }), error => ({ result: null, error }));
    await Promise.all([entered, ready]);
    const stopping = cancel();
    const interruptsBeforeReadReturns = client.interruptCalls;
    release();
    await stopping;
    const outcome = await running;
    expect(interruptsBeforeReadReturns).toBe(1);
    expect(outcome.error).toBeInstanceOf(ProviderTurnCancelledError);
    expect(client.requestParams.filter(value => value.method === "turn/interrupt").map(value => value.params))
      .toEqual([{ threadId: "shared-thread", turnId: "shared-turn" }]);
    expect(client.requests.filter(value => value === "turn/start")).toHaveLength(1);
  });

  test("stopped reconciliation cannot attach a late history response to the parked execution", async () => {
    let reading!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { reading = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    class LateHistoryClient extends ScriptedSharedClient {
      override async request(method: string, params: any) {
        if (method === "thread/read") { reading(); await pending; }
        return super.request(method, params);
      }
    }
    const client = new LateHistoryClient();
    client.turnStartError = new CodexAppServerClientError("unconfirmed input submission", "ambiguous");
    client.historyStatus = "completed";
    let cancel!: () => Promise<void>, finished = false, providerTurns = 0, acknowledgements = 0;
    const running = runCodexTurn({ prompt: "shared request", cwd: "/tmp", additionalDirs: [], sessionUUID: null,
      interactionPolicy: "consultation-only", appServerClient: client, clientUserMessageId: "slack-concierge:turn:shared",
      onCancellationReady: value => { cancel = value; }, onProviderTurnStarted: () => { providerTurns += 1; },
      onInputAcknowledged: () => { acknowledgements += 1; },
    }).then(result => ({ result, error: null }), error => ({ result: null, error })).finally(() => { finished = true; });
    await entered;
    const stopError = await cancel().then(() => null, error => error);
    await new Promise(resolve => setImmediate(resolve));
    const finishedBeforeHistory = finished;
    release();
    const outcome = await running;
    await new Promise(resolve => setImmediate(resolve));
    expect(finishedBeforeHistory).toBeTrue();
    expect(outcome.error).toBe(stopError);
    expect(outcome.error).toMatchObject({ terminalConfirmed: false, providerTurnId: null });
    expect(providerTurns).toBe(0);
    expect(acknowledgements).toBe(0);
    expect(client.requests.filter(value => value === "turn/start")).toHaveLength(1);
  });

  test("binds a new provider thread before it submits the first turn", async () => {
    const client = new ScriptedSharedClient();
    let boundThreadId: string | null = null;
    client.historyStatus = "completed";
    client.onTurnStart = (active) => {
      expect(boundThreadId).toBe("shared-thread");
      active.disconnect();
    };

    await runCodexTurn({
      prompt: "shared request",
      cwd: "/tmp",
      additionalDirs: [],
      sessionUUID: null,
      clientUserMessageId: "slack-concierge:turn:shared",
      appServerClient: client,
      requestTimeoutMs: 100,
      inactivityTimeoutMs: 1_000,
      onProviderThreadStarted: (threadId) => { boundThreadId = threadId; },
    });

    expect(client.requests.indexOf("thread/start")).toBeLessThan(client.requests.indexOf("turn/start"));
    expect(boundThreadId).toBe("shared-thread");
  });

  test.each([null, "existing-thread"])("pins owner context through managed start/resume and reconnect, session=%s", async sessionUUID => {
    const client = new ScriptedSharedClient();
    client.historyStatus = "completed";
    client.onTurnStart = (active) => active.disconnect();

    await runCodexTurn({
      prompt: "verify deployment",
      cwd: "/tmp",
      additionalDirs: [],
      sessionUUID,
      clientUserMessageId: "slack-concierge:turn:deployment",
      environment: {
        CONCIERGE_TURN_KIND: "deployment_verification",
        CONCIERGE_DEPLOYMENT_RUN_ID: "run-1",
        CONCIERGE_COMMIT_PROVENANCE: "stale-if-persisted",
        CONCIERGE_STATE_DB: "/wrong/state.db",
        CONCIERGE_ROUTER_BOT_DIR: "/wrong/bot",
        CONCIERGE_SOURCE_INPUT_ID: "native-input",
        CONCIERGE_SOURCE_RUN_ID: "native-run",
      },
      appServerClient: client,
      requestTimeoutMs: 100,
      inactivityTimeoutMs: 1_000,
    });

    const threadCalls = client.requestParams.filter(({ method }) => method === "thread/start" || method === "thread/resume");
    expect(threadCalls).toHaveLength(2);
    for (const call of threadCalls) expect(call.params).toMatchObject({
      config: {
        shell_environment_policy: {
          inherit: "all",
          set: {
            CONCIERGE_TURN_KIND: "deployment_verification",
            CONCIERGE_DEPLOYMENT_RUN_ID: "run-1",
            CONCIERGE_STATE_DIR: process.env.CONCIERGE_STATE_DIR,
            CONCIERGE_STATE_DB: join(process.env.CONCIERGE_STATE_DIR!, "state.db"),
            CONCIERGE_ROUTER_BOT_DIR: join(import.meta.dir, ".."),
            CONCIERGE_SOURCE_INPUT_ID: "native-input",
            CONCIERGE_SOURCE_RUN_ID: "native-run",
          },
        },
      },
    });
    for (const call of threadCalls) expect(call.params.config.shell_environment_policy.set)
      .not.toHaveProperty("CONCIERGE_COMMIT_PROVENANCE");
    expect(client.requests.filter(method => method === "turn/start")).toHaveLength(1);
  });

  test("waits for exact terminal state after an inactivity interrupt loses its event", async () => {
    const client = new ScriptedSharedClient();
    let providerTerminal = false;
    client.onTurnStart = (active) => active.emit({
      method: "turn/started",
      params: {
        threadId: "shared-thread",
        turn: { id: "shared-turn", status: "inProgress" },
      },
    });

    await expect(runCodexTurn({
      prompt: "shared request",
      cwd: "/tmp",
      additionalDirs: [],
      sessionUUID: null,
      clientUserMessageId: "slack-concierge:turn:shared",
      appServerClient: client,
      requestTimeoutMs: 100,
      inactivityTimeoutMs: 10,
      onProviderTerminal: () => { providerTerminal = true; },
    })).rejects.toThrow("no turn activity");

    expect(client.interruptCalls).toBe(1);
    expect(providerTerminal).toBeTrue();
  });

  test("forks a session through thread/fork and returns the new thread id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const sourceThreadId = "01a015f2-b17c-7801-b185-3b078fb26800";
    const forkedThreadId = "01a015f2-b17c-7801-b185-3b078fb26801";
    const lastTurnId = "turn-selected";
    const threadSource = "slack-concierge-fork:test";
    const additionalDir = join(dir, "shared");
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r fork",
      `case "$fork" in *'"method":"thread/fork"'*'"threadId":"${sourceThreadId}"'*'"cwd":"${dir}"'*'"runtimeWorkspaceRoots":["${dir}","${additionalDir}"]'*'"approvalPolicy":"never"'*'"sandbox":"danger-full-access"'*'"deferGoalContinuation":true'*'"excludeTurns":true'*'"lastTurnId":"${lastTurnId}"'*'"threadSource":"${threadSource}"'*) ;; *) exit 13;; esac`,
      `printf '%s\\n' '{"id":2,"result":{"thread":{"id":"${forkedThreadId}"}}}'`,
    ]);

    try {
      const result = await forkCodexSession({
        sessionUUID: sourceThreadId,
        cwd: dir,
        additionalDirs: [additionalDir],
        executable,
        lastTurnId,
        threadSource,
      });

      expect(result).toEqual({
        text: "Fork created.",
        sessionUUID: forkedThreadId,
        toolsUsed: [],
        providerTurnId: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a thread/fork response that reuses the source thread id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const sourceThreadId = "01a015f2-b17c-7801-b185-3b078fb26800";
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r fork",
      `printf '%s\\n' '{"id":2,"result":{"thread":{"id":"${sourceThreadId}"}}}'`,
    ]);

    try {
      await expect(forkCodexSession({
        sessionUUID: sourceThreadId,
        cwd: dir,
        additionalDirs: [],
        executable,
      })).rejects.toThrow("did not return a distinct new thread id");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("classifies an explicit thread/fork JSON-RPC rejection as definitive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r fork",
      "printf '%s\\n' '{\"id\":2,\"error\":{\"code\":-32602,\"message\":\"unknown thread\"}}'",
    ]);

    try {
      let failure: unknown;
      try {
        await forkCodexSession({
          sessionUUID: "missing-thread",
          cwd: dir,
          additionalDirs: [],
          executable,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(CodexControlRequestError);
      expect((failure as CodexControlRequestError).outcome).toBe("rejected");
      expect(String(failure)).toContain("unknown thread");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("classifies a silent thread/fork timeout as ambiguous", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r fork",
      "sleep 1",
    ]);

    try {
      let failure: unknown;
      try {
        await forkCodexSession({
          sessionUUID: "source-thread",
          cwd: dir,
          additionalDirs: [],
          executable,
          requestTimeoutMs: 20,
          shutdownGraceMs: 5,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(CodexControlRequestError);
      expect((failure as CodexControlRequestError).outcome).toBe("ambiguous");
      expect(String(failure)).toContain("timed out");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("classifies an internal thread/fork JSON-RPC error as ambiguous", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r fork",
      "printf '%s\\n' '{\"id\":2,\"error\":{\"code\":-32603,\"message\":\"internal failure after commit\"}}'",
    ]);

    try {
      let failure: unknown;
      try {
        await forkCodexSession({
          sessionUUID: "source-thread",
          cwd: dir,
          additionalDirs: [],
          executable,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(CodexControlRequestError);
      expect((failure as CodexControlRequestError).outcome).toBe("ambiguous");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recovers the exact fork child by its durable thread source marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const sourceThreadId = "source-thread";
    const forkedThreadId = "forked-thread";
    const threadSource = "slack-concierge-fork:durable-request";
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r list",
      `case "$list" in *'"method":"thread/list"'*'"sourceKinds":["vscode"]'*) ;; *) exit 13;; esac`,
      "case \"$list\" in *'\"parentThreadId\"'*) exit 14;; *) ;; esac",
      `printf '%s\\n' '{"id":2,"result":{"data":[{"id":"${forkedThreadId}","forkedFromId":"${sourceThreadId}","threadSource":"${threadSource}"},{"id":"other","forkedFromId":"${sourceThreadId}","threadSource":"different"}],"nextCursor":null}}'`,
    ]);

    try {
      expect(await findCodexForksByThreadSource({
        sourceSessionUUID: sourceThreadId,
        threadSource,
        cwd: dir,
        executable,
      })).toEqual([forkedThreadId]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("backfills a legacy Slack turn only when its canonical input uniquely matches Codex history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const replayText = "the exact legacy Slack request";
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r read_thread",
      "case \"$read_thread\" in *'\"method\":\"thread/read\"'*'\"includeTurns\":true'*) ;; *) exit 13;; esac",
      `printf '%s\\n' '{"id":2,"result":{"thread":{"turns":[{"id":"turn-selected","items":[{"type":"userMessage","content":[{"type":"text","text":"injected system context\\n\\n${replayText}"}]}]},{"id":"turn-other","items":[{"type":"userMessage","content":[{"type":"text","text":"different request"}]}]}]}}}'`,
    ]);

    try {
      expect(await findCodexTurnIdsByReplayText({
        sessionUUID: "legacy-session",
        replayText,
        cwd: dir,
        executable,
      })).toEqual(["turn-selected"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns only final-answer text while reporting commentary as progress", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r thread",
      "printf '%s\\n' '{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread-final\"}}}'",
      "IFS= read -r turn",
      "printf '%s\\n' '{\"id\":3,\"result\":{\"turn\":{\"id\":\"turn-final\"}}}'",
      "printf '%s\\n' '{\"method\":\"turn/started\",\"params\":{\"threadId\":\"thread-final\",\"turn\":{\"id\":\"turn-final\",\"status\":\"inProgress\"}}}'",
      "printf '%s\\n' '{\"method\":\"item/completed\",\"params\":{\"threadId\":\"thread-final\",\"turnId\":\"turn-final\",\"item\":{\"id\":\"commentary\",\"type\":\"agentMessage\",\"phase\":\"commentary\",\"text\":\"I am still investigating.\"}}}'",
      "printf '%s\\n' '{\"method\":\"item/completed\",\"params\":{\"threadId\":\"thread-final\",\"turnId\":\"turn-final\",\"item\":{\"id\":\"answer\",\"type\":\"agentMessage\",\"phase\":\"final_answer\",\"text\":\"TL;DR: Final summary.\\n\\nDone.\"}}}'",
      "printf '%s\\n' '{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"thread-final\",\"turn\":{\"id\":\"turn-final\",\"status\":\"completed\",\"durationMs\":1122000}}}'",
    ]);
    const narration: string[] = [];

    try {
      const result = await runCodexTurn({
        prompt: "work",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: null,
        executable,
        onProgress: (event) => {
          if (event.type === "narration" && event.text) narration.push(event.text);
        },
      });

      expect(result.text).toBe("TL;DR: Final summary.\n\nDone.");
      expect(result.durationMs).toBe(1_122_000);
      expect(narration).toEqual(["I am still investigating.", "TL;DR: Final summary.\n\nDone."]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("passes an explicit model without overriding reasoning effort", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r thread",
      "case \"$thread\" in *'\"method\":\"thread/start\"'*'\"model\":\"gpt-5.6-luna\"'*) ;; *) exit 13;; esac",
      "case \"$thread\" in *'reasoningEffort'*) exit 14;; *) ;; esac",
      "printf '%s\\n' '{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread-model\"}}}'",
      "IFS= read -r turn",
      "printf '%s\\n' '{\"id\":3,\"result\":{\"turn\":{\"id\":\"turn-model\"}}}'",
      "printf '%s\\n' '{\"method\":\"turn/started\",\"params\":{\"threadId\":\"thread-model\",\"turn\":{\"id\":\"turn-model\",\"status\":\"inProgress\"}}}'",
      "printf '%s\\n' '{\"method\":\"item/completed\",\"params\":{\"threadId\":\"thread-model\",\"turnId\":\"turn-model\",\"item\":{\"id\":\"answer\",\"type\":\"agentMessage\",\"phase\":\"final_answer\",\"text\":\"done\"}}}'",
      "printf '%s\\n' '{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"thread-model\",\"turn\":{\"id\":\"turn-model\",\"status\":\"completed\"}}}'",
    ]);

    try {
      const result = await runCodexTurn({
        prompt: "work",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: null,
        executable,
        model: "gpt-5.6-luna",
      });

      expect(result.sessionUUID).toBe("thread-model");
      expect(result.text).toBe("done");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("starts a thread and steers its active turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r thread",
      "case \"$thread\" in *'\"method\":\"thread/start\"'*'\"sandbox\":\"danger-full-access\"'*) case \"$thread\" in *'\"developerInstructions\"'*) exit 13;; *) ;; esac ;; *) exit 13;; esac",
      "printf '%s\\n' '{\"id\":2,\"result\":{\"thread\":{\"id\":\"019fde26-53ca-7e51-9aa6-3a8c1fe0762c\"}}}'",
      "IFS= read -r turn",
      "case \"$turn\" in *'\"method\":\"turn/start\"'*'initial prompt'*'\"clientUserMessageId\":\"slack-concierge:turn:1\"'*'\"additionalContext\":{\"slack-concierge\":{\"value\":\"Project instructions\",\"kind\":\"application\"}}'*) ;; *) exit 14;; esac",
      "printf '%s\\n' '{\"id\":3,\"result\":{\"turn\":{\"id\":\"turn-1\"}}}'",
      "printf '%s\\n' '{\"method\":\"turn/started\",\"params\":{\"threadId\":\"019fde26-53ca-7e51-9aa6-3a8c1fe0762c\",\"turn\":{\"id\":\"turn-1\",\"status\":\"inProgress\"}}}'",
      "IFS= read -r steer",
      "case \"$steer\" in *'\"method\":\"turn/steer\"'*'\"expectedTurnId\":\"turn-1\"'*'focus on tests'*) ;; *) exit 15;; esac",
      "printf '%s\\n' '{\"id\":4,\"result\":{\"turnId\":\"turn-1\"}}'",
      "printf '%s\\n' '{\"method\":\"item/completed\",\"params\":{\"threadId\":\"019fde26-53ca-7e51-9aa6-3a8c1fe0762c\",\"turnId\":\"turn-1\",\"item\":{\"id\":\"message-stale\",\"type\":\"agentMessage\",\"text\":\"STALE\"}}}'",
      "printf '%s\\n' '{\"method\":\"item/started\",\"params\":{\"threadId\":\"019fde26-53ca-7e51-9aa6-3a8c1fe0762c\",\"turnId\":\"turn-1\",\"item\":{\"id\":\"user-steer-1\",\"type\":\"userMessage\",\"clientId\":\"slack:C1:1.2\",\"content\":[{\"type\":\"text\",\"text\":\"focus on tests\"}]}}}'",
      "printf '%s\\n' '{\"method\":\"item/completed\",\"params\":{\"threadId\":\"019fde26-53ca-7e51-9aa6-3a8c1fe0762c\",\"turnId\":\"turn-1\",\"item\":{\"id\":\"message-1\",\"type\":\"agentMessage\",\"text\":\"FIRST\"}}}'",
      "IFS= read -r steer_again",
      "case \"$steer_again\" in *'\"method\":\"turn/steer\"'*'\"expectedTurnId\":\"turn-1\"'*'final answer only'*) ;; *) exit 16;; esac",
      "printf '%s\\n' '{\"id\":5,\"result\":{\"turnId\":\"turn-1\"}}'",
      "printf '%s\\n' '{\"method\":\"item/completed\",\"params\":{\"threadId\":\"019fde26-53ca-7e51-9aa6-3a8c1fe0762c\",\"turnId\":\"turn-1\",\"item\":{\"id\":\"message-first-late\",\"type\":\"agentMessage\",\"text\":\"FIRST-LATE\"}}}'",
      "printf '%s\\n' '{\"method\":\"item/started\",\"params\":{\"threadId\":\"019fde26-53ca-7e51-9aa6-3a8c1fe0762c\",\"turnId\":\"turn-1\",\"item\":{\"id\":\"user-steer-2\",\"type\":\"userMessage\",\"clientId\":\"slack:C1:1.3\",\"content\":[{\"type\":\"text\",\"text\":\"final answer only\"}]}}}'",
      "printf '%s\\n' '{\"method\":\"item/completed\",\"params\":{\"threadId\":\"019fde26-53ca-7e51-9aa6-3a8c1fe0762c\",\"turnId\":\"turn-1\",\"item\":{\"id\":\"message-final\",\"type\":\"agentMessage\",\"text\":\"PONG\"}}}'",
      "printf '%s\\n' '{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"019fde26-53ca-7e51-9aa6-3a8c1fe0762c\",\"turn\":{\"id\":\"turn-1\",\"status\":\"completed\"}}}'",
    ]);
    let sender: SteeringSender | null = null;
    let providerTerminal = false;
    let startedProviderTurnId: string | null = null;
    let ready!: () => void;
    const steeringReady = new Promise<void>((resolve) => { ready = resolve; });

    try {
      const running = runCodexTurn({
        prompt: "initial prompt",
        cwd: dir,
        additionalDirs: ["/tmp/extra"],
        sessionUUID: null,
        executable,
        applicationInstructions: "Project instructions",
        clientUserMessageId: "slack-concierge:turn:1",
        onSteeringReady: (registered) => {
          sender = registered;
          ready();
        },
        onProviderTerminal: () => { providerTerminal = true; },
        onProviderTurnStarted: (providerTurnId) => { startedProviderTurnId = providerTurnId; },
      });
      await steeringReady;
      await sender!({ clientMessageId: "slack:C1:1.2", text: "focus on tests" });
      await sender!({ clientMessageId: "slack:C1:1.3", text: "final answer only" });

      expect(await running).toEqual({
        text: "PONG",
        sessionUUID: "019fde26-53ca-7e51-9aa6-3a8c1fe0762c",
        toolsUsed: [],
        providerTurnId: "turn-1",
      });
      expect(providerTerminal).toBe(true);
      expect(startedProviderTurnId).toBe("turn-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps replacement output when its user boundary precedes the steer response", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r thread",
      "printf '%s\\n' '{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread-order\"}}}'",
      "IFS= read -r turn",
      "printf '%s\\n' '{\"id\":3,\"result\":{\"turn\":{\"id\":\"turn-order\"}}}'",
      "printf '%s\\n' '{\"method\":\"turn/started\",\"params\":{\"threadId\":\"thread-order\",\"turn\":{\"id\":\"turn-order\",\"status\":\"inProgress\"}}}'",
      "IFS= read -r steer",
      "printf '%s\\n' '{\"method\":\"item/started\",\"params\":{\"threadId\":\"thread-order\",\"turnId\":\"turn-order\",\"item\":{\"id\":\"user-order\",\"type\":\"userMessage\",\"clientId\":\"slack:C1:1.2\",\"content\":[]}}}'",
      "printf '%s\\n' '{\"method\":\"item/completed\",\"params\":{\"threadId\":\"thread-order\",\"turnId\":\"turn-order\",\"item\":{\"id\":\"replacement-early\",\"type\":\"agentMessage\",\"text\":\"EARLY\"}}}'",
      "printf '%s\\n' '{\"id\":4,\"result\":{\"turnId\":\"turn-order\"}}'",
      "printf '%s\\n' '{\"method\":\"item/completed\",\"params\":{\"threadId\":\"thread-order\",\"turnId\":\"turn-order\",\"item\":{\"id\":\"replacement-final\",\"type\":\"agentMessage\",\"text\":\"FINAL\"}}}'",
      "printf '%s\\n' '{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"thread-order\",\"turn\":{\"id\":\"turn-order\",\"status\":\"completed\"}}}'",
    ]);
    let sender: SteeringSender | null = null;
    let ready!: () => void;
    const steeringReady = new Promise<void>((resolve) => { ready = resolve; });
    try {
      const running = runCodexTurn({
        prompt: "initial",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: null,
        executable,
        onSteeringReady: (value) => { sender = value; ready(); },
      });
      await steeringReady;
      await sender!({ clientMessageId: "slack:C1:1.2", text: "replacement" });
      expect((await running).text).toBe("EARLY\n\nFINAL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a steer acknowledgement for a different turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r thread",
      "printf '%s\\n' '{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread-audit\"}}}'",
      "IFS= read -r turn",
      "printf '%s\\n' '{\"id\":3,\"result\":{\"turn\":{\"id\":\"turn-audit\"}}}'",
      "printf '%s\\n' '{\"method\":\"turn/started\",\"params\":{\"threadId\":\"thread-audit\",\"turn\":{\"id\":\"turn-audit\",\"status\":\"inProgress\"}}}'",
      "IFS= read -r steer",
      "printf '%s\\n' '{\"id\":4,\"result\":{\"turnId\":\"wrong-turn\"}}'",
      "printf '%s\\n' '{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"thread-audit\",\"turn\":{\"id\":\"turn-audit\",\"status\":\"completed\"}}}'",
    ]);
    let sender: SteeringSender | null = null;
    let ready!: () => void;
    const steeringReady = new Promise<void>((resolve) => { ready = resolve; });

    try {
      const running = runCodexTurn({
        prompt: "initial",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: null,
        executable,
        onSteeringReady: (value) => { sender = value; ready(); },
      });
      await steeringReady;
      await expect(sender!({ clientMessageId: "slack:C1:1.2", text: "replacement" }))
        .rejects.toThrow("unexpected turn wrong-turn");
      expect((await running).text).toBe("(agent completed without a text reply)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resumes the requested thread and keeps its id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const sessionUUID = "019fde0c-d3e9-79f0-ac77-8cdab34a1be1";
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r thread",
      `case \"$thread\" in *'\"method\":\"thread/resume\"'*'\"threadId\":\"${sessionUUID}\"'*) ;; *) exit 13;; esac`,
      `printf '%s\\n' '{\"id\":2,\"result\":{\"thread\":{\"id\":\"${sessionUUID}\"}}}'`,
      "IFS= read -r turn",
      "printf '%s\\n' '{\"id\":3,\"result\":{\"turn\":{\"id\":\"turn-2\"}}}'",
      `printf '%s\\n' '{\"method\":\"turn/started\",\"params\":{\"threadId\":\"${sessionUUID}\",\"turn\":{\"id\":\"turn-2\",\"status\":\"inProgress\"}}}'`,
      `printf '%s\\n' '{\"method\":\"item/completed\",\"params\":{\"threadId\":\"${sessionUUID}\",\"turnId\":\"turn-2\",\"item\":{\"id\":\"message-2\",\"type\":\"agentMessage\",\"text\":\"CONTINUED\"}}}'`,
      `printf '%s\\n' '{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"${sessionUUID}\",\"turn\":{\"id\":\"turn-2\",\"status\":\"completed\"}}}'`,
    ]);

    try {
      const result = await runCodexTurn({
        prompt: "continue",
        cwd: dir,
        additionalDirs: [],
        sessionUUID,
        executable,
      });
      expect(result.sessionUUID).toBe(sessionUUID);
      expect(result.text).toBe("CONTINUED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports every supported Codex tool item once as live progress", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const item = (method: string, value: object) =>
      `printf '%s\\n' '${JSON.stringify({ method, params: { threadId: "thread-3", turnId: "turn-3", item: value } })}'`;
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r thread",
      "printf '%s\\n' '{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread-3\"}}}'",
      "IFS= read -r turn",
      "printf '%s\\n' '{\"id\":3,\"result\":{\"turn\":{\"id\":\"turn-3\"}}}'",
      "printf '%s\\n' '{\"method\":\"turn/started\",\"params\":{\"threadId\":\"thread-3\",\"turn\":{\"id\":\"turn-3\",\"status\":\"inProgress\"}}}'",
      "printf '%s\\n' '{\"method\":\"turn/started\",\"params\":{\"threadId\":\"subagent-thread\",\"turn\":{\"id\":\"subagent-turn\",\"status\":\"inProgress\"}}}'",
      item("item/completed", { id: "foreign-message", type: "agentMessage", text: "FOREIGN" }).replace('"threadId":"thread-3"', '"threadId":"subagent-thread"').replace('"turnId":"turn-3"', '"turnId":"subagent-turn"'),
      item("item/started", { id: "cmd-1", type: "commandExecution", command: "/bin/pwd" }),
      item("item/completed", { id: "cmd-1", type: "commandExecution", command: "/bin/pwd" }),
      item("item/started", { id: "mcp-1", type: "mcpToolCall", tool: "search" }),
      item("item/completed", { id: "mcp-1", type: "mcpToolCall", tool: "search" }),
      item("item/completed", { id: "file-1", type: "fileChange" }),
      item("item/completed", { id: "message-3", type: "agentMessage", text: "DONE" }),
      "printf '%s\\n' '{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"thread-3\",\"turn\":{\"id\":\"turn-3\",\"status\":\"completed\"}}}'",
    ]);
    const progress: string[] = [];

    try {
      const result = await runCodexTurn({
        prompt: "continue",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: null,
        executable,
        onProgress: (event) => {
          if (event.type === "tool_use") progress.push(event.toolName || "unknown");
        },
      });
      expect(progress).toEqual(["/bin/pwd", "search", "fileChange"]);
      expect(result.toolsUsed).toEqual(["/bin/pwd", "search", "fileChange"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects instead of crashing when the app server closes during initialization", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const executable = fakeCodex(dir, ["exit 1"]);

    try {
      await expect(runCodexTurn({
        prompt: "hello",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: null,
        executable,
      })).rejects.toThrow("codex app-server");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects promptly when the app server exits before turn/started", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r thread",
      "printf '%s\\n' '{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread-without-start\"}}}'",
      "IFS= read -r turn",
      "printf '%s\\n' '{\"id\":3,\"result\":{\"turn\":{\"id\":\"turn-without-start\"}}}'",
      "exit 19",
    ]);

    try {
      await expect(Promise.race([
        runCodexTurn({
          prompt: "hello",
          cwd: dir,
          additionalDirs: [],
          sessionUUID: null,
          executable,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 1_000)),
      ])).rejects.toThrow("codex app-server exited 19");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("times out a live app server that never answers JSON-RPC", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const executable = fakeCodex(dir, [
      "IFS= read -r initialize",
      "IFS= read -r forever",
    ]);

    try {
      await expect(runCodexTurn({
        prompt: "hello",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: null,
        executable,
        requestTimeoutMs: 20,
        inactivityTimeoutMs: 1_000,
        shutdownGraceMs: 10,
      })).rejects.toThrow("initialize timed out");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("terminates an active turn after provider protocol inactivity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-codex-test-"));
    const executable = fakeCodex(dir, [
      ...initializeHandshake,
      "IFS= read -r thread",
      "printf '%s\\n' '{\"id\":2,\"result\":{\"thread\":{\"id\":\"silent-thread\"}}}'",
      "IFS= read -r turn",
      "printf '%s\\n' '{\"id\":3,\"result\":{\"turn\":{\"id\":\"silent-turn\"}}}'",
      "printf '%s\\n' '{\"method\":\"turn/started\",\"params\":{\"threadId\":\"silent-thread\",\"turn\":{\"id\":\"silent-turn\",\"status\":\"inProgress\"}}}'",
      "while :; do printf '%s\\n' 'stderr noise' >&2; sleep 0.005; done",
    ]);

    try {
      await expect(runCodexTurn({
        prompt: "hello",
        cwd: dir,
        additionalDirs: [],
        sessionUUID: null,
        executable,
        requestTimeoutMs: 1_000,
        inactivityTimeoutMs: 20,
        shutdownGraceMs: 10,
      })).rejects.toThrow("no protocol activity");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
