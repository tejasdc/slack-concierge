/**
 * The coordinator's side of an execution host (bot/scripts/execution-host.ts): starting one under
 * the machine's own supervisor, and the connection that attaches to it, replays its record and
 * sends it commands. Protocol and states: docs/architecture/EXECUTION-HOST.md.
 */
import { spawnSync } from "node:child_process";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
/** The host was certainly not started: nothing to take custody of. */
export class HostNotStartedError extends HostUnavailableError {}

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
  // Everything before the supervisor is asked is a definite refusal: nothing can be running.
  let bytes: string, hostScript: string;
  try {
    mkdirSync(join(input.stateDir, "exec"), { recursive: true, mode: 0o700 });
    mkdirSync(directory, { mode: 0o700 });
    const manifest = { version: 1, executionId: input.executionId, ...input.manifest };
    bytes = JSON.stringify(manifest);
    writeFileSync(join(directory, "manifest.json"), bytes, { mode: 0o600, flag: "wx" });
    chmodSync(directory, 0o700);
    hostScript = hostScriptPath(input.routerBotDir);
  } catch (error) { throw new HostNotStartedError(error instanceof Error ? error.message : String(error)); }
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
    // A refusal the supervisor stated means no unit; a timeout or a lost answer does not, and is
    // left to custody (hostCustody), which asks the supervisor what actually exists.
    if (result.error || result.signal) throw new HostUnavailableError(`systemd-run did not answer: ${String(result.error ?? result.signal)}`);
    if (result.status !== 0) throw new HostNotStartedError(`systemd-run refused the host: ${(result.stderr || result.stdout).trim()}`);
  } else {
    throw new HostNotStartedError(`no execution host supervisor on ${process.platform} yet`);
  }
  return { executionId: input.executionId, directory, unit, hostScript, runtime,
    manifestDigest: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * What the machine's supervisor says about an execution's host. Only an answer it gave counts:
 * a query that failed or timed out is `unknown`, never "gone".
 */
export type SupervisorView = "alive" | "gone" | "unknown";
export function hostSupervisorView(executionId: string): SupervisorView {
  if (process.platform !== "linux") return "unknown";
  const result = spawnSync("systemctl", ["show", `${executionUnit(executionId)}.service`, "--property=ActiveState", "--property=LoadState"],
    { encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0 || result.error) return "unknown";
  // Read by name: systemd prints properties in its own order, not the order asked for.
  const properties = new Map(result.stdout.trim().split("\n").map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()] as const));
  const active = properties.get("ActiveState") ?? "", load = properties.get("LoadState") ?? "";
  if (["active", "activating", "deactivating", "reloading", "refreshing"].includes(active)) return "alive";
  // A transient unit that ended is collected: it reads as not found and inactive.
  if ((active === "inactive" || active === "failed") && (load === "not-found" || load === "loaded")) return "gone";
  return "unknown";
}

/**
 * The one decision about a host that does not answer, used at startup and by a live run that lost
 * its connection: alive or unknown keeps custody (the agent may still act); positively gone settles
 * from the record when it holds the provider's exit, and only otherwise is the run lost.
 */
export type HostCustody = "answering" | "held" | "settle-from-record" | "dead";
export async function hostCustody(directory: string, executionId: string): Promise<HostCustody> {
  try {
    const connection = await HostConnection.connect(hostSocketPath(directory), 3_000);
    try { if ((await connection.status()).executionId === executionId) return "answering"; }
    finally { connection.close(); }
  } catch { /* decided by the supervisor and the record */ }
  if (hostSupervisorView(executionId) !== "gone") return "held";
  try { if (readJournal(directory).some(frame => frame.k === "x")) return "settle-from-record"; } catch {}
  return "dead";
}

/** The release file a running host was started from, read from the process itself. */
export function hostScriptOfProcess(hostPid: number): string | null {
  try { return readFileSync(`/proc/${hostPid}/cmdline`, "utf8").split("\0")[2] || null; } catch { return null; }
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
  /** Start a new execution, attach to one still running, or settle one whose host left a finished record. */
  mode: "launch" | "adopt" | "adopt-record";
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
    const directory = executionDirectory(execution.stateDir, execution.executionId);
    const socketPath = hostSocketPath(directory);
    if (execution.mode === "adopt-record") return this.runFromRecord(input);
    return new Promise((resolve, reject) => {
      let connection: HostConnection | null = null;
      let settled = false, exited = false, inputClosing = false;
      let terminationError: Error | null = null;
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
      // No provider activity is the provider's silence, not the host's: a host that stopped reading
      // because its disk is full is waiting on space, and the timer waits with it.
      const resetInactivity = () => {
        if (!replayEnded) return;
        if (inactivity) clearTimeout(inactivity);
        inactivity = setTimeout(() => {
          if (settled) return;
          void (connection?.status().catch(() => null) ?? Promise.resolve(null)).then(status => {
            if (status?.journalError) { resetInactivity(); return; }
            terminateWithError(new Error(`claude-code produced no provider activity for ${inactivityMs}ms`));
          });
        }, inactivityMs);
      };
      const write = (value: string, meta?: TransportFrameMeta) => {
        if (!connection || inputClosing || exited) return Promise.reject(new HostWriteRefusedError("claude-code stdin is closed"));
        const line = value.endsWith("\n") ? value.slice(0, -1) : value;
        return connection.command({ op: "submit", id: meta?.commandId ?? randomUUID(), line, meta: meta ?? null }).then(receipt => {
          if (receipt.written === true) return;
          // `false` is the host's record that the line was never written; anything else is not proof.
          if (receipt.written === false) throw new HostWriteRefusedError(`claude-code stdin refused the write: ${receipt.error ?? "not written"}`);
          throw new WriteOutcomeUnknownError("the host has not confirmed this write");
        }, error => { throw new WriteOutcomeUnknownError(`the host connection ended before confirming this write: ${error instanceof Error ? error.message : String(error)}`); });
      };

      // ---- frames -------------------------------------------------------------------------
      // Frames up to the host's sequence at attach (`replayUntil`) are the predecessor's history.
      // They are collected whole, so each recorded write is replayed with its recorded outcome,
      // and handed over only after this run's writer exists; then the run is told the history
      // ended. Nothing in between can act on the live process (design §3.1 step 4).
      let replayUntil = 0, ready = false, replayEnded = false, lastSeen = 0, received = 0;
      // Frames can arrive in the same chunk as the attach answer, before the history's end is known
      // here; they wait unsorted until it is (`early`), then are sorted once.
      const early: HostFrame[] = [];
      const history: HostFrame[] = [];
      const pendingLive: HostFrame[] = [];
      const handle = (frame: HostFrame, replayed: boolean, outcomes?: Map<string, "written" | "failed">) => {
        lastSeen = frame.s;
        if (frame.k === "o") input.onStdout(`${frame.d}\n`, replayed ? frame.t : undefined);
        else if (frame.k === "e") input.onStderr(String(frame.d));
        else if (frame.k === "i" && replayed && frame.d?.id !== "initial") {
          const outcome = outcomes?.get(frame.d.id) ?? "unknown";
          // A write the host recorded as failed never reached the provider and rebuilds nothing.
          if (outcome !== "failed") input.onReplayedInput?.(frame.d.line, frame.d.meta ?? null, frame.t, outcome);
        } else if (frame.k === "x") {
          exited = true;
          const exit = { code: frame.d?.code ?? null, signal: (frame.d?.signal ?? null) as NodeJS.Signals | null };
          execution.onExited?.(exit);
          // The host keeps its record until the turn's result is durably settled; the turn's owner
          // releases it afterwards (releaseHost), so a crash in between still finds it.
          if (!replayEnded) { replayEnded = true; input.onReplayEnd?.(); }
          if (terminationError) finish(terminationError); else finish(null, exit);
          return;
        }
        if (!replayed && (frame.k === "o" || frame.k === "e")) resetInactivity();
      };
      const endHistory = () => {
        if (replayEnded || !ready) return;
        // Sequences are contiguous, so the history is complete exactly when the last frame sorted
        // into it reaches the boundary; what has merely been received (perhaps in one chunk with
        // the attach answer) does not count until it has been sorted.
        if ((history.at(-1)?.s ?? lastSeen) < replayUntil) return;
        const outcomes = new Map<string, "written" | "failed">();
        for (const frame of history) if (frame.k === "c" && typeof frame.d?.id === "string") {
          if (frame.d.op === "written") outcomes.set(frame.d.id, "written");
          if (frame.d.op === "write-failed") outcomes.set(frame.d.id, "failed");
        }
        for (const frame of history.splice(0)) { if (settled) return; try { handle(frame, true, outcomes); } catch (error) { terminateWithError(error); } }
        if (!replayEnded) { replayEnded = true; input.onReplayEnd?.(); }
        resetInactivity();
        for (const frame of pendingLive.splice(0)) sort(frame);
      };
      // Every frame is taken once, in sequence, whichever connection carried it.
      const dispatch = (frame: HostFrame) => {
        if (frame.s <= received || settled) return;
        received = frame.s;
        sort(frame);
      };
      const sort = (frame: HostFrame) => {
        if (!ready) { early.push(frame); return; }
        if (frame.s <= replayUntil && !replayEnded) { history.push(frame); endHistory(); return; }
        if (!replayEnded) { pendingLive.push(frame); return; }
        try { handle(frame, false); } catch (error) { terminateWithError(error); }
      };

      // ---- connection and custody ------------------------------------------------------------
      const attachTo = async (next: HostConnection) => {
        connection = next;
        const attached = await next.attach(received + 1, dispatch);
        next.onClosed(reason => {
          if (settled) return;
          if (next.fenced) { finish(new HostUnavailableError("another Concierge attached to this execution")); return; }
          void keepCustody(reason);
        });
        return attached;
      };
      // The host keeps the provider when only the connection breaks. Whether it is still there is
      // decided the same way as at startup: answering reattaches, alive or unknown keeps trying
      // (the run stays held; the agent may still be acting), positively gone settles from its
      // record when the record holds the exit, and only otherwise is the run lost.
      const keepCustody = async (reason: string) => {
        for (let attempt = 0; !settled; attempt++) {
          const custody = await hostCustody(directory, execution.executionId);
          if (custody === "answering") {
            try { await establish(await HostConnection.connect(socketPath, 3_000)); return; } catch { /* decide again */ }
          } else if (custody === "settle-from-record") {
            // The record is the evidence; no socket is needed to read it. A run that never attached
            // gets its boundary and a writer that refuses (the provider has exited) from the record.
            const record = readJournal(directory);
            if (!ready) {
              if (execution.mode === "adopt") replayUntil = record.at(-1)?.s ?? 0;
              input.onStdinReady?.(() => Promise.reject(new HostWriteRefusedError("the provider has exited")), () => {});
              ready = true;
              for (const frame of early.splice(0)) sort(frame);
            }
            for (const frame of record) dispatch(frame);
            endHistory();
            if (!settled) finish(new HostUnavailableError("the execution host left a record that ends without the provider's exit"));
            return;
          } else if (custody === "dead") {
            finish(new HostLostError(`the execution host stopped without recording the provider's exit (${reason})`));
            return;
          }
          await new Promise(resolve => setTimeout(resolve, attempt < 3 ? 1_000 : 30_000));
        }
      };

      let launched = false;
      // The first attachment, whichever path reaches it, sets the history boundary and hands the
      // run its writer; later attachments only continue the frames.
      const establish = async (next: HostConnection) => {
        const attached = await attachTo(next);
        if (ready) return;
        // The host computes `until` in the same synchronous step that starts the replay, so it is
        // exactly the predecessor's history; anything later is live. A launch has no history.
        if (execution.mode === "adopt") replayUntil = attached.until;
        execution.onAttached?.(attached);
        input.onStdinReady?.((value: string, meta?: TransportFrameMeta) => write(value, meta), () => closeInput());
        input.onProtocolActivityReady?.(resetInactivity);
        ready = true;
        for (const frame of early.splice(0)) sort(frame);
        endHistory();
      };
      const begin = async () => {
        if (execution.mode === "launch") {
          const executable = execution.executable;
          const routerBotDir = execution.routerBotDir ?? input.environment?.CONCIERGE_ROUTER_BOT_DIR;
          if (!routerBotDir) throw new HostUnavailableError("the run names no release helper folder to start its host from");
          // From here a host may exist even if this call fails (a supervisor that accepted the start
          // but whose answer was lost); only startHost's own definite refusals mean it does not.
          launched = true;
          const launch = startHost({ stateDir: execution.stateDir, executionId: execution.executionId, routerBotDir,
            manifest: { executable, args: input.args, cwd: input.cwd,
              environment: { ...(input.inheritEnvironment === false ? {} : process.env as Record<string, string>), ...input.environment },
              initialInput: input.stdin.endsWith("\n") ? input.stdin.slice(0, -1) : input.stdin,
              initialMeta: { kind: "initial" } } });
          execution.onLaunched?.(launch);
          await establish(await connectWhenReady(socketPath, Date.now() + 15_000));
        } else {
          await establish(await HostConnection.connect(socketPath));
        }
      };
      begin().catch(error => {
        // Once a host may exist, no failure to reach or record it unwinds the run: custody decides.
        if ((execution.mode === "adopt" || (launched && !(error instanceof HostNotStartedError))) && !settled) {
          void keepCustody(error instanceof Error ? error.message : String(error)); return;
        }
        finish(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  /**
   * The host is gone but its record holds the provider's exit: the run is rebuilt from the record
   * alone and settles from its own evidence, never as an interruption (it cannot write any more).
   */
  private runFromRecord(input: Parameters<ClaudeCodeTransport["run"]>[0]): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    const frames = readJournal(executionDirectory(this.execution.stateDir, this.execution.executionId));
    const exit = frames.find(frame => frame.k === "x");
    if (!exit) return Promise.reject(new HostUnavailableError("the execution's record holds no exit"));
    const outcomes = new Map<string, "written" | "failed">();
    for (const frame of frames) if (frame.k === "c" && typeof frame.d?.id === "string") {
      if (frame.d.op === "written") outcomes.set(frame.d.id, "written");
      if (frame.d.op === "write-failed") outcomes.set(frame.d.id, "failed");
    }
    input.onStdinReady?.(() => Promise.reject(new HostWriteRefusedError("the provider has exited")), () => {});
    for (const frame of frames) {
      if (frame.k === "o") input.onStdout(`${frame.d}\n`, frame.t);
      else if (frame.k === "e") input.onStderr(String(frame.d));
      else if (frame.k === "i" && frame.d?.id !== "initial") {
        const outcome = outcomes.get(frame.d.id) ?? "unknown";
        if (outcome !== "failed") input.onReplayedInput?.(frame.d.line, frame.d.meta ?? null, frame.t, outcome);
      }
    }
    input.onReplayEnd?.();
    this.execution.onExited?.({ code: exit.d?.code ?? null, signal: exit.d?.signal ?? null });
    return Promise.resolve({ code: exit.d?.code ?? null, signal: (exit.d?.signal ?? null) as NodeJS.Signals | null });
  }
}

/** The host is positively gone and recorded no exit: what the provider did is unconfirmed. */
export class HostLostError extends Error {}

/** Every complete frame of an execution's journal, in order; a torn tail is skipped. */
export function readJournal(directory: string): HostFrame[] {
  const frames: HostFrame[] = [];
  for (const line of readFileSync(join(directory, "journal"), "utf8").split("\n")) {
    if (!line) continue;
    try { frames.push(JSON.parse(line)); } catch { /* torn tail */ }
  }
  return frames;
}

/** Ends a host's custody once the turn's outcome is durably the owner's; refused while it still runs. */
export async function releaseHost(directory: string, executionId: string): Promise<boolean> {
  try {
    const connection = await HostConnection.connect(hostSocketPath(directory), 3_000);
    try { await connection.attach(Number.MAX_SAFE_INTEGER, () => {}); await connection.command({ op: "release", id: `release-${executionId}` }); return true; }
    finally { connection.close(); }
  } catch { return false; }
}

/** A write the host recorded as never made: the input provably did not reach the provider. */
export class HostWriteRefusedError extends Error {}
/** A write whose outcome nobody recorded (connection lost, unconfirmed): it may have reached the provider. */
export class WriteOutcomeUnknownError extends Error {}
