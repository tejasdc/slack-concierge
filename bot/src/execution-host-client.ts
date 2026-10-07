/**
 * The coordinator's side of an execution host (bot/scripts/execution-host.ts): starting one under
 * the machine's own supervisor, and the connection that attaches to it, replays its record and
 * sends it commands. Protocol and states: docs/architecture/EXECUTION-HOST.md.
 */
import { spawnSync } from "node:child_process";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import type { ClaudeCodeTransport, TransportFrameMeta } from "./claude-code";

export const HOST_PROTOCOL_VERSION = 1;
/** Every host protocol this coordinator can adopt; a release must keep each one any live execution still speaks. */
export const ADOPTABLE_HOST_PROTOCOLS: readonly number[] = [1];

export type HostFrame = { s: number; t: number; k: "o" | "e" | "i" | "c" | "x" | "h"; d: any };
export type HostStatus = { protocol: number; executionId: string; hostPid: number; providerPid: number | null;
  lastSeq: number; exit: { code: number | null; signal: string | null; at: number } | null; journalError: string | null };

export function newExecutionId() { return randomBytes(8).toString("hex"); }

/**
 * New Claude runs start in a host on a machine whose supervisor can hold one apart from the
 * coordinator (Linux today; the Mac's launchd host is its own delivery). `CONCIERGE_EXECUTION_HOSTS=0`
 * returns new runs to direct child processes without touching hosts already running.
 */
export function executionHostsEnabled() {
  return process.platform === "linux" && process.env.CONCIERGE_EXECUTION_HOSTS !== "0";
}

/** The Claude CLI by absolute path, resolved by the coordinator; a host's supervisor gives it no PATH. */
export function claudeExecutable() {
  const configured = process.env.CONCIERGE_CLAUDE_CODE_EXECUTABLE || "claude";
  const found = configured.includes("/") ? configured : Bun.which(configured);
  if (!found) throw new HostUnavailableError(`cannot find the Claude CLI (${configured}) on this coordinator's PATH`);
  return found;
}
export function executionDirectory(stateDir: string, executionId: string) { return join(stateDir, "exec", executionId); }
export function hostSocketPath(directory: string) { return join(directory, "host.sock"); }
export function executionUnit(executionId: string) { return `concierge-exec-${executionId}`; }

export class HostUnavailableError extends Error {}

/** One line-delimited JSON connection to a host. */
export class HostConnection {
  private buffer = "";
  private waiting = new Map<string, { resolve: (message: any) => void; reject: (error: Error) => void }>();
  private statusWaiters: Array<(message: any) => void> = [];
  private attachWaiter: ((message: any) => void) | null = null;
  private onFrame: ((frame: HostFrame) => void) | null = null;
  private closedHandlers: Array<(reason: string) => void> = [];
  private closed = false;
  fenced = false;

  private constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.read(chunk));
    socket.on("error", () => {});
    socket.on("close", () => this.end(this.fenced ? "fenced" : "connection closed"));
  }

  static connect(socketPath: string, timeoutMs = 5_000): Promise<HostConnection> {
    return new Promise((resolve, reject) => {
      if (!existsSync(socketPath)) { reject(new HostUnavailableError(`no host socket at ${socketPath}`)); return; }
      const socket = createConnection(socketPath);
      const timer = setTimeout(() => { socket.destroy(); reject(new HostUnavailableError("host did not accept the connection")); }, timeoutMs);
      socket.once("connect", () => { clearTimeout(timer); resolve(new HostConnection(socket)); });
      socket.once("error", error => { clearTimeout(timer); reject(new HostUnavailableError(error.message)); });
    });
  }

  private read(chunk: string) {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: any; try { message = JSON.parse(line); } catch { continue; }
      if (message.op === "frame") { this.onFrame?.(message as HostFrame); continue; }
      if (message.op === "attached" || (message.op === "refused" && this.attachWaiter && !message.id)) {
        const waiter = this.attachWaiter; this.attachWaiter = null; waiter?.(message); continue;
      }
      if (message.op === "status") { this.statusWaiters.shift()?.(message); continue; }
      if (message.op === "fenced") { this.fenced = true; continue; }
      if (typeof message.id === "string" && this.waiting.has(message.id)) {
        const waiter = this.waiting.get(message.id)!; this.waiting.delete(message.id);
        if (message.op === "refused") waiter.reject(new Error(`host refused: ${message.reason}`));
        else waiter.resolve(message);
      }
    }
  }

  private send(message: unknown) {
    if (this.closed) throw new HostUnavailableError("host connection is closed");
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  status(timeoutMs = 3_000): Promise<HostStatus> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new HostUnavailableError("host status timed out")), timeoutMs);
      this.statusWaiters.push(message => { clearTimeout(timer); resolve(message); });
      try { this.send({ op: "status" }); } catch (error) { clearTimeout(timer); reject(error); }
    });
  }

  /** Attach as the one coordinator of this execution; frames from `from` onward, replay then live. */
  attach(from: number, onFrame: (frame: HostFrame) => void): Promise<HostStatus & { until: number }> {
    this.onFrame = onFrame;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new HostUnavailableError("host did not answer the attach")), 10_000);
      this.attachWaiter = message => {
        clearTimeout(timer);
        if (message.op === "refused") reject(new HostUnavailableError(`host refused the attach: ${message.reason}`));
        else resolve(message);
      };
      try { this.send({ op: "attach", protocol: HOST_PROTOCOL_VERSION, from }); } catch (error) { clearTimeout(timer); reject(error); }
    });
  }

  command(message: { op: string; id: string; [key: string]: unknown }): Promise<any> {
    return new Promise((resolve, reject) => {
      this.waiting.set(message.id, { resolve, reject });
      try { this.send(message); } catch (error) { this.waiting.delete(message.id); reject(error as Error); }
    });
  }

  onClosed(handler: (reason: string) => void) { if (this.closed) handler("connection closed"); else this.closedHandlers.push(handler); }

  private end(reason: string) {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiting.values()) waiter.reject(new HostUnavailableError(`host connection ended: ${reason}`));
    this.waiting.clear();
    for (const handler of this.closedHandlers) handler(reason);
  }

  close() { this.socket.end(); }
}

export type HostLaunch = {
  executionId: string; directory: string; unit: string; hostScript: string; runtime: string;
  manifestDigest: string;
};

/** Where a host for this release lives: beside the router helpers this run is pinned to. */
export function hostScriptPath(routerBotDir: string) {
  for (const name of ["scripts/execution-host.js", "scripts/execution-host.ts"]) {
    const path = join(routerBotDir, name);
    if (existsSync(path)) return path;
  }
  throw new HostUnavailableError(`no execution host in ${routerBotDir}`);
}

/**
 * Start the host under the machine's supervisor, outside the coordinator's own lifetime.
 * Linux: one transient system service per execution, its unit name the one-start lock.
 */
export function startHost(input: {
  stateDir: string; executionId: string; routerBotDir: string; runtime?: string;
  manifest: { executable: string; args: string[]; cwd: string; environment: Record<string, string>; initialInput: string; initialMeta?: Record<string, unknown> };
}): HostLaunch {
  const directory = executionDirectory(input.stateDir, input.executionId);
  mkdirSync(join(input.stateDir, "exec"), { recursive: true, mode: 0o700 });
  mkdirSync(directory, { mode: 0o700 });
  const manifest = { version: 1, executionId: input.executionId, ...input.manifest };
  const bytes = JSON.stringify(manifest);
  writeFileSync(join(directory, "manifest.json"), bytes, { mode: 0o600, flag: "wx" });
  chmodSync(directory, 0o700);
  const hostScript = hostScriptPath(input.routerBotDir);
  const runtime = input.runtime ?? process.execPath;
  const unit = executionUnit(input.executionId);
  if (process.platform === "linux") {
    const result = spawnSync("systemd-run", [
      `--unit=${unit}`, "--service-type=exec", "--collect", "--quiet",
      "--property=Restart=no", "--property=KillMode=control-group",
      `--description=Concierge agent execution ${input.executionId}`,
      `--working-directory=${directory}`,
      runtime, "run", hostScript, directory,
    ], { encoding: "utf8", timeout: 30_000 });
    if (result.status !== 0) throw new HostUnavailableError(`systemd-run refused the host: ${(result.stderr || result.stdout || String(result.error)).trim()}`);
  } else {
    throw new HostUnavailableError(`no execution host supervisor on ${process.platform} yet`);
  }
  return { executionId: input.executionId, directory, unit, hostScript, runtime,
    manifestDigest: createHash("sha256").update(bytes).digest("hex") };
}

/** Whether the machine's supervisor still runs this execution's host. */
export function hostUnitActive(unit: string): boolean {
  if (process.platform !== "linux") return false;
  const result = spawnSync("systemctl", ["is-active", "--quiet", `${unit}.service`], { timeout: 10_000 });
  return result.status === 0;
}

async function connectWhenReady(socketPath: string, deadlineMs: number): Promise<HostConnection> {
  let last: unknown = null;
  while (Date.now() < deadlineMs) {
    try { return await HostConnection.connect(socketPath); }
    catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  throw new HostUnavailableError(`the execution host never opened its socket: ${last instanceof Error ? last.message : String(last)}`);
}

export type HostedExecution = {
  /** Start a new execution with this id, or attach to one already running. */
  mode: "launch" | "adopt";
  executionId: string;
  /** The provider CLI by absolute path: the host's supervisor gives it no PATH of its own. */
  executable: string;
  stateDir: string;
  /** The release's helper folder the host program is taken from; by default the run's own pinned one. */
  routerBotDir?: string;
  /** Ledger custody steps; each is called once, in order, never for a replayed fact. */
  onLaunched?: (launch: HostLaunch) => void;
  onAttached?: (status: HostStatus & { until: number }) => void;
  onExited?: (exit: { code: number | null; signal: string | null }) => void;
  onReleased?: () => void;
};

/**
 * A provider transport whose process lives in a host. Within one coordinator it behaves exactly
 * like a child process: lines out, lines in, close, signals, exit. Across a coordinator restart
 * the next coordinator attaches in `adopt` mode, and the frames already recorded are replayed
 * through the same handlers with their original times, so its state is rebuilt, not guessed.
 */
export class HostedClaudeCodeTransport implements ClaudeCodeTransport {
  constructor(private readonly execution: HostedExecution,
    private readonly timeouts: { inactivityMs?: number; shutdownGraceMs?: number } = {}) {}

  run(input: Parameters<ClaudeCodeTransport["run"]>[0]): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    const execution = this.execution;
    const inactivityMs = this.timeouts.inactivityMs ?? 30 * 60_000;
    const shutdownGraceMs = this.timeouts.shutdownGraceMs ?? 2_000;
    return new Promise((resolve, reject) => {
      let connection: HostConnection | null = null;
      let settled = false, exited = false, inputClosing = false;
      let terminationError: Error | null = null;
      let replayUntil = 0;
      let inactivity: ReturnType<typeof setTimeout> | null = null;
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      const clear = () => { if (inactivity) clearTimeout(inactivity); inactivity = null; for (const timer of timers.splice(0)) clearTimeout(timer); };
      const finish = (error: Error | null, exit?: { code: number | null; signal: NodeJS.Signals | null }) => {
        if (settled) return;
        settled = true; clear();
        if (error) reject(error); else resolve(exit!);
      };
      const signal = (name: "SIGTERM" | "SIGKILL") => {
        if (exited || !connection) return;
        void connection.command({ op: "signal", id: `signal-${name}-${randomUUID()}`, signal: name }).catch(() => {});
      };
      const scheduleKill = () => { timers.push(setTimeout(() => signal("SIGKILL"), shutdownGraceMs)); };
      const terminateWithError = (error: unknown) => {
        if (terminationError || exited) return;
        terminationError = error instanceof Error ? error : new Error(String(error));
        if (inactivity) clearTimeout(inactivity); inactivity = null;
        closeInput(false);
        signal("SIGTERM"); scheduleKill();
      };
      const closeInput = (graceful = true) => {
        if (inputClosing || !connection) return;
        inputClosing = true;
        void connection.command({ op: "close", id: `close-${execution.executionId}` }).catch(() => {});
        if (graceful) timers.push(setTimeout(() => { signal("SIGTERM"); scheduleKill(); }, shutdownGraceMs));
      };
      const resetInactivity = () => {
        if (inactivity) clearTimeout(inactivity);
        inactivity = setTimeout(() => {
          if (!settled) terminateWithError(new Error(`claude-code produced no provider activity for ${inactivityMs}ms`));
        }, inactivityMs);
      };
      const write = (value: string, meta?: TransportFrameMeta) => {
        if (!connection || inputClosing || exited) return Promise.reject(new Error("claude-code stdin is closed"));
        const line = value.endsWith("\n") ? value.slice(0, -1) : value;
        return connection.command({ op: "submit", id: meta?.commandId ?? randomUUID(), line, meta: meta ?? null }).then(receipt => {
          if (receipt.written !== true) throw new Error(`claude-code stdin refused the write: ${receipt.error ?? "not written"}`);
        });
      };
      const onFrame = (frame: HostFrame) => {
        const replaying = frame.s <= replayUntil;
        if (frame.k === "o") input.onStdout(`${frame.d}\n`, replaying ? frame.t : undefined);
        else if (frame.k === "e") input.onStderr(String(frame.d));
        else if (frame.k === "i") {
          // In a launch this coordinator wrote these itself. In an adoption, the ones recorded before
          // it attached are its predecessor's writes, replayed so its state includes them.
          if (execution.mode === "adopt" && replaying && frame.d?.id !== "initial") input.onReplayedInput?.(frame.d.line, frame.d.meta ?? null, frame.t);
        } else if (frame.k === "x") {
          exited = true;
          const exit = { code: frame.d?.code ?? null, signal: (frame.d?.signal ?? null) as NodeJS.Signals | null };
          execution.onExited?.(exit);
          void connection?.command({ op: "release", id: `release-${execution.executionId}` })
            .then(() => execution.onReleased?.()).catch(() => {});
          if (terminationError) finish(terminationError); else finish(null, exit);
          return;
        }
        if (!replaying && (frame.k === "o" || frame.k === "e")) resetInactivity();
      };
      // Frames are taken once each, in sequence, whichever connection carried them.
      let lastSeen = 0;
      const dispatch = (frame: HostFrame) => {
        if (frame.s <= lastSeen) return;
        lastSeen = frame.s;
        try { onFrame(frame); } catch (error) { terminateWithError(error); }
      };
      const socketPath = hostSocketPath(executionDirectory(execution.stateDir, execution.executionId));
      let reattachments = 0;
      const attachTo = async (next: HostConnection) => {
        connection = next;
        const attached = await next.attach(lastSeen + 1, dispatch);
        next.onClosed(reason => {
          if (settled || next.fenced) {
            // Another coordinator took this execution over; it owns the turn from here.
            if (next.fenced) finish(new HostUnavailableError("another Concierge attached to this execution"));
            return;
          }
          // The host keeps the provider when only the connection breaks, so reattach; a host that is
          // truly gone ends the run as lost, never as a confirmed failure of the provider.
          void (async () => {
            while (reattachments++ < 3 && !settled) {
              try { await attachTo(await HostConnection.connect(socketPath, 3_000)); return; }
              catch { await new Promise(resolve => setTimeout(resolve, 1_000)); }
            }
            finish(new HostUnavailableError(`the execution host ended without recording an exit (${reason})`));
          })();
        });
        return attached;
      };
      const begin = async () => {
        if (execution.mode === "launch") {
          const executable = execution.executable;
          const routerBotDir = execution.routerBotDir ?? input.environment?.CONCIERGE_ROUTER_BOT_DIR;
          if (!routerBotDir) throw new HostUnavailableError("the run names no release helper folder to start its host from");
          const launch = startHost({ stateDir: execution.stateDir, executionId: execution.executionId, routerBotDir,
            manifest: { executable, args: input.args, cwd: input.cwd,
              environment: { ...(input.inheritEnvironment === false ? {} : process.env as Record<string, string>), ...input.environment },
              initialInput: input.stdin.endsWith("\n") ? input.stdin.slice(0, -1) : input.stdin,
              initialMeta: { kind: "initial" } } });
          execution.onLaunched?.(launch);
          // The replay boundary must be known before the first frame is handled.
          replayUntil = 0;
          const attached = await attachTo(await connectWhenReady(socketPath, Date.now() + 15_000));
          execution.onAttached?.(attached);
        } else {
          const first = await HostConnection.connect(socketPath);
          const status = await first.status();
          replayUntil = status.lastSeq;
          const attached = await attachTo(first);
          // Frames the host wrote between the status and the attach are live, not replayed.
          execution.onAttached?.(attached);
        }
        input.onStdinReady?.((value: string, meta?: TransportFrameMeta) => write(value, meta), () => closeInput());
        input.onProtocolActivityReady?.(resetInactivity);
        resetInactivity();
      };
      begin().catch(error => finish(error instanceof Error ? error : new Error(String(error))));
    });
  }
}
