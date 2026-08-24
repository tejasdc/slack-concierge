import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

const DEFAULT_SOCKET_PATH = "/root/.codex/app-server-control/app-server-control.sock";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class CodexAppServerClientError extends Error {
  constructor(
    message: string,
    readonly outcome: "rejected" | "ambiguous",
    readonly code?: number,
  ) {
    super(message);
    this.name = "CodexAppServerClientError";
  }
}

interface PendingRequest {
  connectionGeneration: number;
  method: string;
  resolve(value: any): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
  onAccepted?(value: any): void;
}

interface ActiveConnection {
  generation: number;
  process: ChildProcessWithoutNullStreams;
  disconnected: Promise<void>;
  resolveDisconnected(): void;
  exited: Promise<void>;
  resolveExited(): void;
  ready: Promise<void>;
  resolveReady(): void;
  rejectReady(error: Error): void;
  stderr: string;
}

type NotificationListener = (event: any) => void;
type DisconnectListener = (error: Error, generation: number) => void;

export interface CodexAppServerClientLike {
  connect(): Promise<number>;
  request(
    method: string,
    params: unknown,
    options?: { requestTimeoutMs?: number; onAccepted?: (value: any) => void },
  ): Promise<any>;
  notify(method: string, params?: unknown): Promise<void>;
  onNotification(listener: NotificationListener): () => boolean;
  onDisconnect(listener: DisconnectListener): () => boolean;
  waitForDisconnect(generation: number): Promise<void>;
  refreshProjectSubscriptions?(): Promise<void>;
  close?(): Promise<void>;
}

export function codexAppServerSocketPath() {
  return process.env.CONCIERGE_CODEX_APP_SERVER_SOCKET?.trim() || DEFAULT_SOCKET_PATH;
}

export class CodexAppServerClient {
  private active: ActiveConnection | null = null;
  private connecting: Promise<number> | null = null;
  private generation = 0;
  private requestId = 0;
  private closed = false;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly disconnectListeners = new Set<DisconnectListener>();

  constructor(
    private readonly socketPath = codexAppServerSocketPath(),
    private readonly nodeExecutable = process.env.CONCIERGE_NODE_BIN?.trim() || "/usr/bin/node",
    private readonly options: {
      bridgePath?: string;
      shutdownGraceMs?: number;
    } = {},
  ) {}

  connect(): Promise<number> {
    if (this.closed) {
      return Promise.reject(new CodexAppServerClientError("Codex app-server client is closed.", "ambiguous"));
    }
    if (this.connecting) return this.connecting;
    if (this.active) return Promise.resolve(this.active.generation);
    const connection = this.createConnection();
    this.active = connection;
    const connecting = this.initializeConnection(connection).finally(() => {
      if (this.connecting === connecting) this.connecting = null;
    });
    this.connecting = connecting;
    return connecting;
  }

  async request(
    method: string,
    params: unknown,
    options: { requestTimeoutMs?: number; onAccepted?: (value: any) => void } = {},
  ): Promise<any> {
    const generation = await this.connect();
    const connection = this.active;
    if (!connection || connection.generation !== generation) {
      throw new CodexAppServerClientError(`Codex app-server disconnected before ${method}.`, "ambiguous");
    }
    const id = ++this.requestId;
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerClientError(
          `Codex app-server ${method} timed out after ${requestTimeoutMs}ms.`,
          "ambiguous",
        ));
      }, requestTimeoutMs);
      this.pending.set(id, {
        connectionGeneration: connection.generation,
        method,
        resolve,
        reject,
        timeout,
        onAccepted: options.onAccepted,
      });
      void this.send(connection, { type: "request", id, method, params }).catch((error) => {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async notify(method: string, params: unknown = {}) {
    const generation = await this.connect();
    const connection = this.active;
    if (!connection || connection.generation !== generation) {
      throw new CodexAppServerClientError(`Codex app-server disconnected before ${method}.`, "ambiguous");
    }
    await this.send(connection, { type: "notification", method, params });
  }

  onNotification(listener: NotificationListener) {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onDisconnect(listener: DisconnectListener) {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  waitForDisconnect(generation: number) {
    const connection = this.active;
    return connection?.generation === generation ? connection.disconnected : Promise.resolve();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const connection = this.active;
    if (!connection) return;
    try {
      await this.send(connection, { type: "close" });
    } catch {}
    this.failConnection(
      connection,
      new CodexAppServerClientError("Codex app-server client closed.", "ambiguous"),
    );
    const shutdownGraceMs = this.options.shutdownGraceMs ?? 1_000;
    if (await this.waitForExit(connection, shutdownGraceMs)) return;
    connection.process.kill("SIGTERM");
    if (await this.waitForExit(connection, shutdownGraceMs)) return;
    connection.process.kill("SIGKILL");
    if (!await this.waitForExit(connection, shutdownGraceMs)) {
      throw new CodexAppServerClientError(
        "Codex app-server bridge did not exit after SIGKILL.",
        "ambiguous",
      );
    }
  }

  private createConnection(): ActiveConnection {
    const generation = ++this.generation;
    const bridgePath = this.options.bridgePath
      || new URL("./codex-app-server-bridge.mjs", import.meta.url).pathname;
    const child = spawn(this.nodeExecutable, [bridgePath, this.socketPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let resolveDisconnected!: () => void;
    const disconnected = new Promise<void>((resolve) => { resolveDisconnected = resolve; });
    let resolveExited!: () => void;
    const exited = new Promise<void>((resolve) => { resolveExited = resolve; });
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const connection: ActiveConnection = {
      generation,
      process: child,
      disconnected,
      resolveDisconnected,
      exited,
      resolveExited,
      ready,
      resolveReady,
      rejectReady,
      stderr: "",
    };
    const output = createInterface({ input: child.stdout });
    output.on("line", (line) => this.receive(connection, line));
    child.stderr.on("data", (chunk) => {
      connection.stderr = `${connection.stderr}${String(chunk)}`.slice(-4_000);
    });
    child.stdin.on("error", (error) => this.failConnection(connection, error));
    child.once("error", (error) => {
      connection.resolveExited();
      this.failConnection(connection, error);
    });
    child.once("exit", (code, signal) => {
      connection.resolveExited();
      this.failConnection(
        connection,
        new CodexAppServerClientError(
          `Codex app-server bridge exited (${signal || (code ?? "unknown")})${connection.stderr ? `: ${connection.stderr.trim()}` : ""}`,
          "ambiguous",
        ),
      );
    });
    return connection;
  }

  private async initializeConnection(connection: ActiveConnection) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        connection.ready,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new CodexAppServerClientError(
            "Codex app-server bridge initialization timed out.",
            "ambiguous",
          )), DEFAULT_REQUEST_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      this.failConnection(connection, error);
      connection.process.kill("SIGTERM");
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (this.active !== connection) {
      throw new CodexAppServerClientError("Codex app-server connection was replaced during initialization.", "ambiguous");
    }
    return connection.generation;
  }

  private send(connection: ActiveConnection, message: unknown): Promise<void> {
    if (this.active !== connection || !connection.process.stdin.writable) {
      return Promise.reject(new CodexAppServerClientError(
        "Codex app-server bridge is not writable.",
        "ambiguous",
      ));
    }
    return new Promise((resolve, reject) => {
      connection.process.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          reject(new CodexAppServerClientError(error.message, "ambiguous"));
        } else {
          resolve();
        }
      });
    });
  }

  private waitForExit(connection: ActiveConnection, milliseconds: number) {
    return Promise.race([
      connection.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), milliseconds)),
    ]);
  }

  private receive(connection: ActiveConnection, line: string) {
    if (this.active !== connection) return;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === "ready") {
      connection.resolveReady();
      return;
    }
    if (event.type === "disconnect") {
      this.failConnection(connection, new CodexAppServerClientError(
        event.error || "Codex app-server bridge disconnected.",
        "ambiguous",
      ));
      connection.process.kill("SIGTERM");
      return;
    }
    if (event.type === "response") {
      const id = Number(event.id);
      const pending = this.pending.get(id);
      if (!pending || pending.connectionGeneration !== connection.generation) return;
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      if (event.error) {
        const errorCode = Number(event.error.code);
        pending.reject(new CodexAppServerClientError(
          `Codex app-server ${pending.method} failed: ${event.error.message || JSON.stringify(event.error)}`,
          errorCode === -32602 ? "rejected" : "ambiguous",
          errorCode,
        ));
        return;
      }
      try {
        pending.onAccepted?.(event.result);
        pending.resolve(event.result);
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    if (event.type !== "event" || !event.event?.method) return;
    for (const listener of this.notificationListeners) {
      try {
        listener(event.event);
      } catch {}
    }
  }

  private failConnection(connection: ActiveConnection, cause: unknown) {
    if (this.active !== connection) return;
    const error = cause instanceof CodexAppServerClientError
      ? cause
      : new CodexAppServerClientError(
        cause instanceof Error ? cause.message : String(cause),
        "ambiguous",
      );
    this.active = null;
    connection.rejectReady(error);
    for (const [id, pending] of this.pending) {
      if (pending.connectionGeneration !== connection.generation) continue;
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      pending.reject(error);
    }
    connection.resolveDisconnected();
    for (const listener of this.disconnectListeners) {
      try {
        listener(error, connection.generation);
      } catch {}
    }
  }
}

let sharedClient: CodexAppServerClient | null = null;

export function sharedCodexAppServerClient() {
  sharedClient ??= new CodexAppServerClient();
  return sharedClient;
}

export async function verifySharedCodexAppServerReady() {
  await sharedCodexAppServerClient().request("model/list", {}, { requestTimeoutMs: 10_000 });
}

export async function closeSharedCodexAppServerClient() {
  await sharedClient?.close();
  sharedClient = null;
}
