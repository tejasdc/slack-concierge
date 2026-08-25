import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { isAbsolute, relative, resolve } from "node:path";
import { CodexAppServerClientError, type CodexAppServerClientLike } from "./codex-app-server-client";
import {
  PROVIDER_BROKER_MAX_FRAME_BYTES,
  PROVIDER_BROKER_PROTOCOL_VERSION,
  createBoundedJsonlReader,
  type CodexBrokerOperation,
} from "./provider-broker-protocol";

interface ProviderProjectRecord {
  id: string;
  stable_path: string;
  socket_path: string;
}

interface ProviderProjectRegistry {
  schema_version: 1;
  projects: ProviderProjectRecord[];
}

const CODEX_OPERATIONS: Record<string, CodexBrokerOperation> = {
  "model/list": "codex.model_list",
  "thread/start": "codex.thread_start",
  "thread/resume": "codex.thread_resume",
  "thread/read": "codex.thread_read",
  "thread/list": "codex.thread_list",
  "thread/fork": "codex.thread_fork",
  "turn/start": "codex.turn_start",
  "turn/steer": "codex.turn_steer",
  "turn/interrupt": "codex.turn_interrupt",
};

const BROKER_OBSERVER_METHOD = "broker/observe";

export interface ProviderBrokerSessionRoute {
  provider_thread_uuid: string;
  provider_binding_token: string | null;
  project_path: string;
}

export function providerBrokerEnabled() {
  return process.env.CONCIERGE_PROVIDER_BROKER_ENABLED === "1";
}

export function loadProviderProjectRegistry(
  path = process.env.CONCIERGE_PROVIDER_PROJECTS_PATH || "/var/lib/concierge-bot/provider-projects.json",
): ProviderProjectRegistry {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ProviderProjectRegistry;
  if (parsed.schema_version !== 1 || !Array.isArray(parsed.projects) || parsed.projects.length < 1) {
    throw new Error("Provider project registry is invalid.");
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  const sockets = new Set<string>();
  for (const project of parsed.projects) {
    if (!project || typeof project.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(project.id)
      || typeof project.stable_path !== "string" || !isAbsolute(project.stable_path)
      || typeof project.socket_path !== "string" || !isAbsolute(project.socket_path)
      || ids.has(project.id) || paths.has(resolve(project.stable_path)) || sockets.has(resolve(project.socket_path))) {
      throw new Error("Provider project registry contains an invalid or duplicate project.");
    }
    ids.add(project.id);
    paths.add(resolve(project.stable_path));
    sockets.add(resolve(project.socket_path));
  }
  return parsed;
}

export function resolveProviderProject(cwd: string, registry = loadProviderProjectRegistry()) {
  if (!isAbsolute(cwd)) throw new Error("Provider cwd must be absolute.");
  const canonical = resolve(cwd);
  const matches = registry.projects.filter((project) => {
    const projectRoot = resolve(project.stable_path);
    const pathFromRoot = relative(projectRoot, canonical);
    return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
  }).sort((left, right) => right.stable_path.length - left.stable_path.length);
  if (matches.length !== 1) throw new Error(`Provider cwd ${cwd} is not uniquely managed.`);
  return matches[0];
}

function brokerPayload(method: string, params: any) {
  if (["thread/start", "thread/resume", "thread/fork"].includes(method)) {
    return {
      ...(params?.threadId ? { threadId: params.threadId } : {}),
      ...(params?.runtimeWorkspaceRoots ? { runtimeWorkspaceRoots: params.runtimeWorkspaceRoots } : {}),
      ...(params?.model ? { model: params.model } : {}),
      ...(params?.reasoningEffort ? { reasoningEffort: params.reasoningEffort } : {}),
      ...(params?.lastTurnId ? { lastTurnId: params.lastTurnId } : {}),
      ...(params?.threadSource ? { threadSource: params.threadSource } : {}),
      ...(params?.deferGoalContinuation === true ? { deferGoalContinuation: true } : {}),
      ...(params?.excludeTurns === true ? { excludeTurns: true } : {}),
      ...(params?.config?.shell_environment_policy?.set
        ? { environment: params.config.shell_environment_policy.set }
        : {}),
    };
  }
  if (method === "thread/list") {
    const { cwd: _cwd, ...allowed } = params || {};
    return allowed;
  }
  return params || {};
}

export class BrokeredCodexAppServerClient implements CodexAppServerClientLike {
  private socket: Socket | null = null;
  private connecting: Promise<number> | null = null;
  private generation = 0;
  private nextId = 0;
  private closed = false;
  private currentBindingToken: string | null;
  private readonly pending = new Map<string, {
    method: string;
    resolve(value: any): void;
    reject(error: Error): void;
    timeout: ReturnType<typeof setTimeout>;
    onAccepted?(value: any): void;
  }>();
  private readonly notifications = new Set<(event: any) => void>();
  private readonly disconnects = new Set<(error: Error, generation: number) => void>();
  private disconnected = Promise.resolve();
  private resolveDisconnected: (() => void) | null = null;

  constructor(private readonly socketPath: string, bindingToken?: string | null) {
    this.currentBindingToken = bindingToken || null;
  }

  bindingToken() {
    return this.currentBindingToken;
  }

  connect() {
    if (this.closed) return Promise.reject(new CodexAppServerClientError("Provider broker client is closed.", "ambiguous"));
    if (this.socket) return Promise.resolve(this.generation);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<number>((resolveConnection, rejectConnection) => {
      const generation = ++this.generation;
      const socket = createConnection(this.socketPath);
      let connected = false;
      this.socket = socket;
      this.disconnected = new Promise<void>((resolve) => { this.resolveDisconnected = resolve; });
      createBoundedJsonlReader(
        socket,
        (line) => this.receive(line),
        (error) => socket.destroy(error),
        PROVIDER_BROKER_MAX_FRAME_BYTES,
      );
      socket.once("connect", () => {
        connected = true;
        resolveConnection(generation);
      });
      socket.once("error", (error) => {
        if (!connected) rejectConnection(error);
        this.fail(error, generation);
      });
      socket.once("close", () => this.fail(new Error("Provider broker disconnected."), generation));
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async request(
    method: string,
    params: unknown,
    options: { requestTimeoutMs?: number; onAccepted?: (value: any) => void } = {},
  ) {
    const operation = method === BROKER_OBSERVER_METHOD ? "codex.observe" : CODEX_OPERATIONS[method];
    if (!operation) throw new CodexAppServerClientError(`Provider broker method ${method} is forbidden.`, "rejected");
    await this.connect();
    const id = `codex:${++this.nextId}:${randomUUID()}`;
    return new Promise<any>((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new CodexAppServerClientError(`Provider broker ${method} timed out.`, "ambiguous"));
      }, options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, {
        method,
        resolve: resolveRequest,
        reject: rejectRequest,
        timeout,
        onAccepted: options.onAccepted,
      });
      this.socket!.write(`${JSON.stringify({
        protocol_version: PROVIDER_BROKER_PROTOCOL_VERSION,
        id,
        operation,
        binding_token: this.currentBindingToken,
        payload: brokerPayload(method, params),
      })}\n`);
    });
  }

  async notify() {
    throw new CodexAppServerClientError("Provider broker notifications are internal-only.", "rejected");
  }

  onNotification(listener: (event: any) => void) {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  onDisconnect(listener: (error: Error, generation: number) => void) {
    this.disconnects.add(listener);
    return () => this.disconnects.delete(listener);
  }

  waitForDisconnect(generation: number) {
    return generation === this.generation ? this.disconnected : Promise.resolve();
  }

  async close() {
    this.closed = true;
    this.socket?.end();
    this.socket = null;
  }

  private receive(line: string) {
    let message: Record<string, any>;
    try {
      message = JSON.parse(line);
    } catch {
      this.socket?.destroy(new Error("Provider broker emitted malformed JSONL."));
      return;
    }
    if (message.type === "event") {
      for (const listener of this.notifications) listener(message.event);
      return;
    }
    if (message.type !== "response") return;
    const pending = this.pending.get(String(message.id));
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(String(message.id));
    if (message.error) {
      pending.reject(new CodexAppServerClientError(
        `Provider broker ${pending.method} rejected: ${String(message.error)}`,
        "rejected",
      ));
      return;
    }
    const bindingToken = message.result?._broker?.bindingToken;
    if (typeof bindingToken === "string") this.currentBindingToken = bindingToken;
    try {
      pending.onAccepted?.(message.result);
      pending.resolve(message.result);
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(cause: unknown, generation: number) {
    if (generation !== this.generation) return;
    const error = cause instanceof Error ? cause : new Error(String(cause));
    this.socket = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new CodexAppServerClientError(error.message, "ambiguous"));
    }
    this.pending.clear();
    this.resolveDisconnected?.();
    for (const listener of this.disconnects) listener(error, generation);
  }
}

export function brokeredCodexAppServerClient(cwd: string, bindingToken?: string | null) {
  const project = resolveProviderProject(cwd);
  return new BrokeredCodexAppServerClient(project.socket_path, bindingToken);
}

export class BrokeredCodexObserverClient implements CodexAppServerClientLike {
  private generation = 0;
  private connecting: Promise<number> | null = null;
  private clients: BrokeredCodexAppServerClient[] = [];
  private readonly notifications = new Set<(event: any) => void>();
  private readonly disconnects = new Set<(error: Error, generation: number) => void>();
  private disconnected = Promise.resolve();
  private resolveDisconnected: (() => void) | null = null;

  constructor(private readonly routes: () => ProviderBrokerSessionRoute[]) {}

  async connect() {
    if (this.connecting) return this.connecting;
    if (this.clients.length > 0) return this.generation;
    this.connecting = this.connectFresh().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async connectFresh() {
    const generation = ++this.generation;
    this.disconnected = new Promise<void>((resolve) => { this.resolveDisconnected = resolve; });
    const registry = loadProviderProjectRegistry();
    const clients = registry.projects.map((project) => new BrokeredCodexAppServerClient(project.socket_path));
    this.clients = clients;
    try {
      await Promise.all(clients.map(async (client) => {
        client.onNotification((event) => {
          for (const listener of this.notifications) listener(event);
        });
        client.onDisconnect((error) => this.fail(error, generation));
        await client.connect();
        await client.request(BROKER_OBSERVER_METHOD, {}, { requestTimeoutMs: 10_000 });
      }));
      if (this.clients !== clients) throw new Error("Provider observer disconnected while establishing its project subscriptions.");
    } catch (error) {
      if (this.clients === clients) this.clients = [];
      await Promise.allSettled(clients.map((client) => client.close()));
      throw error;
    }
    return generation;
  }

  async request(method: string, params: any, options: { requestTimeoutMs?: number } = {}) {
    const threadId = typeof params?.threadId === "string" ? params.threadId : null;
    if (!threadId) throw new CodexAppServerClientError("Provider observer request requires a thread identity.", "rejected");
    const matches = this.routes().filter((route) => route.provider_thread_uuid === threadId);
    if (matches.length !== 1 || !matches[0].provider_binding_token) {
      throw new CodexAppServerClientError("Provider observer session route is not uniquely bound.", "rejected");
    }
    const route = matches[0];
    const project = resolveProviderProject(route.project_path);
    const client = new BrokeredCodexAppServerClient(project.socket_path, route.provider_binding_token);
    try {
      return await client.request(method, params, options);
    } finally {
      await client.close();
    }
  }

  async refreshProjectSubscriptions() {
    await Promise.all(this.clients.map((client) => (
      client.request(BROKER_OBSERVER_METHOD, {}, { requestTimeoutMs: 10_000 })
    )));
  }

  async notify() {
    throw new CodexAppServerClientError("Provider observer notifications are internal-only.", "rejected");
  }

  onNotification(listener: (event: any) => void) {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  onDisconnect(listener: (error: Error, generation: number) => void) {
    this.disconnects.add(listener);
    return () => this.disconnects.delete(listener);
  }

  waitForDisconnect(generation: number) {
    return generation === this.generation ? this.disconnected : Promise.resolve();
  }

  async close() {
    const clients = this.clients;
    this.clients = [];
    await Promise.allSettled(clients.map((client) => client.close()));
    this.resolveDisconnected?.();
  }

  private fail(error: Error, generation: number) {
    if (generation !== this.generation || this.clients.length === 0) return;
    const clients = this.clients;
    this.clients = [];
    void Promise.allSettled(clients.map((client) => client.close()));
    this.resolveDisconnected?.();
    for (const listener of this.disconnects) listener(error, generation);
  }
}

export async function verifyProviderBrokerReady() {
  const registry = loadProviderProjectRegistry();
  await Promise.all(registry.projects.map(async (project) => {
    const client = new BrokeredCodexAppServerClient(project.socket_path);
    try {
      await client.request("model/list", {}, { requestTimeoutMs: 10_000 });
    } finally {
      await client.close();
    }
  }));
}

export class BrokeredClaudeCodeTransport {
  private currentBindingToken: string | null;

  constructor(bindingToken?: string | null) {
    this.currentBindingToken = bindingToken || null;
  }

  bindingToken() {
    return this.currentBindingToken;
  }

  run(input: {
    args: string[];
    cwd: string;
    environment?: Record<string, string>;
    stdin: string;
    onStdout: (chunk: string) => void;
    onStderr: (chunk: string) => void;
    onStdinReady?: (write: (input: string) => Promise<void>, close: () => void) => void;
    onProtocolActivityReady?: (record: () => void) => void;
    broker?: {
      prompt: string;
      sessionUuid: string | null;
      forkSession?: boolean;
      model?: string;
      systemPrompt?: string;
      additionalDirs: string[];
    };
  }): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (!input.broker) return Promise.reject(new Error("Brokered Claude transport requires typed broker input."));
    const project = resolveProviderProject(input.cwd);
    const socket = createConnection(project.socket_path);
    const runId = `claude:${randomUUID()}`;
    let nextId = 0;
    let settled = false;
    let inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
    const resetInactivityTimeout = () => {
      if (inactivityTimeout) clearTimeout(inactivityTimeout);
      inactivityTimeout = setTimeout(() => {
        socket.destroy(new Error("claude-code produced no provider activity for 1800000ms"));
      }, 30 * 60_000);
    };
    const clearInactivityTimeout = () => {
      if (inactivityTimeout) clearTimeout(inactivityTimeout);
      inactivityTimeout = null;
    };
    input.onProtocolActivityReady?.(resetInactivityTimeout);
    const pending = new Map<string, {
      resolve(value: any): void;
      reject(error: Error): void;
    }>();
    const send = (operation: "claude.run" | "claude.stdin" | "claude.close", payload: Record<string, unknown>) => {
      const id = operation === "claude.run" ? runId : `${runId}:${++nextId}`;
      return new Promise<any>((resolveRequest, rejectRequest) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          rejectRequest(new Error(`Provider broker ${operation} timed out.`));
        }, 30_000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timeout);
            resolveRequest(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            rejectRequest(error);
          },
        });
        socket.write(`${JSON.stringify({
          protocol_version: PROVIDER_BROKER_PROTOCOL_VERSION,
          id,
          operation,
          binding_token: this.currentBindingToken,
          payload,
        })}\n`);
      });
    };
    return new Promise((resolveRun, rejectRun) => {
      socket.once("connect", () => {
        resetInactivityTimeout();
        const broker = input.broker!;
        void send("claude.run", {
          prompt: broker.prompt,
          sessionUuid: broker.sessionUuid,
          forkSession: broker.forkSession === true,
          model: broker.model,
          systemPrompt: broker.systemPrompt,
          environment: input.environment,
          additionalDirs: broker.additionalDirs,
        }).then((result) => {
          if (settled) return;
          settled = true;
          clearInactivityTimeout();
          socket.end();
          resolveRun(result);
        }).catch((error) => {
          if (settled) return;
          settled = true;
          clearInactivityTimeout();
          socket.destroy();
          rejectRun(error);
        });
      });
      createBoundedJsonlReader(socket, (line) => {
        resetInactivityTimeout();
        let message: Record<string, any>;
        try {
          message = JSON.parse(line);
        } catch {
          socket.destroy(new Error("Provider broker emitted malformed Claude JSONL."));
          return;
        }
        if (message.type === "binding" && message.provider === "claude-code") {
          this.currentBindingToken = String(message.binding_token || "") || this.currentBindingToken;
          return;
        }
        if (message.type === "claude.stream" && message.run_id === runId) {
          if (message.stream === "stdout") input.onStdout(String(message.chunk || ""));
          else input.onStderr(String(message.chunk || ""));
          return;
        }
        if (message.type === "claude.ready" && message.run_id === runId) {
          input.onStdinReady?.(
            (value) => send("claude.stdin", { run_id: runId, value }).then(() => undefined),
            () => { void send("claude.close", { run_id: runId }); },
          );
          return;
        }
        if (message.type !== "response") return;
        const request = pending.get(String(message.id));
        if (!request) return;
        pending.delete(String(message.id));
        if (message.error) request.reject(new Error(String(message.error)));
        else request.resolve(message.result);
      }, (error) => socket.destroy(error), PROVIDER_BROKER_MAX_FRAME_BYTES);
      socket.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearInactivityTimeout();
        for (const request of pending.values()) request.reject(error);
        pending.clear();
        rejectRun(error);
      });
      socket.once("close", () => {
        if (settled) return;
        settled = true;
        clearInactivityTimeout();
        const error = new Error("Provider broker disconnected during Claude run.");
        for (const request of pending.values()) request.reject(error);
        pending.clear();
        rejectRun(error);
      });
    });
  }
}
