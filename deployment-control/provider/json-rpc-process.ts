import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createBoundedJsonlReader } from "../../bot/src/provider-broker-protocol";

const MAX_LINE_BYTES = 4 * 1024 * 1024;

export class JsonRpcProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 0;
  private initialized: Promise<void> | null = null;
  private stderr = "";
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private readonly listeners = new Set<(notification: Record<string, unknown>) => void>();

  constructor(private readonly input: {
    command: string[];
    cwd: string;
    environment: Record<string, string>;
    timeoutMs?: number;
  }) {}

  async request(method: string, params: Record<string, unknown>) {
    await this.start();
    return this.rawRequest(method, params);
  }

  onNotification(listener: (notification: Record<string, unknown>) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close() {
    const child = this.child;
    this.child = null;
    this.initialized = null;
    if (!child) return;
    child.stdin.end();
    child.kill("SIGTERM");
  }

  private start() {
    if (this.initialized) return this.initialized;
    const starting = this.startProcess();
    this.initialized = starting;
    void starting.catch(() => {
      if (this.initialized === starting) this.initialized = null;
    });
    return starting;
  }

  private async startProcess() {
    const child = spawn(this.input.command[0], this.input.command.slice(1), {
      cwd: this.input.cwd,
      env: this.input.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    createBoundedJsonlReader(
      child.stdout,
      (line) => this.receive(line),
      (error) => {
        this.fail(error, child);
        child.kill("SIGKILL");
      },
      MAX_LINE_BYTES,
    );
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-8_000);
    });
    child.once("error", (error) => this.fail(error, child));
    child.once("exit", (code, signal) => {
      this.fail(new Error(`Provider App Server exited (${signal || code || "unknown"}): ${this.stderr}`), child);
    });
    await this.rawRequest("initialize", {
      clientInfo: { name: "slack_concierge_provider_broker", title: "Slack Concierge Provider Broker", version: "1" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.send({ method: "initialized", params: {} });
  }

  private rawRequest(method: string, params: Record<string, unknown>) {
    const id = ++this.nextId;
    return new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Provider App Server ${method} timed out.`));
      }, this.input.timeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private receive(line: string) {
    let message: Record<string, any>;
    try {
      message = JSON.parse(line);
    } catch {
      const child = this.child;
      if (child) child.kill("SIGKILL");
      return this.fail(new Error("Provider App Server emitted malformed JSONL."), child);
    }
    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(Number(message.id));
      if (message.error) pending.reject(new Error(String(message.error.message || "Provider request rejected.")));
      else pending.resolve(message.result);
      return;
    }
    if (Object.hasOwn(message, "id") && message.method) {
      this.send({
        id: message.id,
        error: { code: -32601, message: `Provider broker cannot answer ${String(message.method)}.` },
      });
      return;
    }
    if (typeof message.method === "string") {
      for (const listener of this.listeners) listener(message);
    }
  }

  private send(message: unknown) {
    if (!this.child?.stdin.writable) throw new Error("Provider App Server stdin is not writable.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private fail(error: Error, child: ChildProcessWithoutNullStreams | null = this.child) {
    if (child && this.child !== child) return;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.child = null;
    this.initialized = null;
  }
}
