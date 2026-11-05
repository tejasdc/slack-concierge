/**
 * Everything a durable watch does on the machine where its file or command is
 * (docs/architecture/WATCHES.md, docs/architecture/RUNNERS.md "Watches on a runner"). No ledger:
 * the owner's watch worker decides and records; this only reads paths and runs one command's
 * execution host. The owner uses it directly for its own machine (`localWatchMachine`) and through a
 * runner's call channel for a runner (`runnerWatchMachine`), and the runner serves those calls with
 * the same local functions under its own state folder and release.
 */
import { closeSync, existsSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { observePath, type PathVersion } from "./path-version";
import { HOST_PROTOCOL_VERSION, HostConnection, executionDirectory, executionUnit, hostSocketPath, hostSupervisorView, releaseHost,
  retireHostJob, startHost, streamJournal, HostNotStartedError } from "./execution-host-client";
import { runnerMachineCall } from "./runner-machine-calls";

const OUTPUT_TAIL_CHARS = 1_500;
const EXECUTION_ID = /^[0-9a-f]{16}$/;

/** The environment a watched command gets: the ordinary user variables, never Concierge's own secrets. */
export function ordinaryCommandEnvironment(): Record<string, string> {
  const names = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "SHELL", "TMPDIR", "TZ", "XDG_RUNTIME_DIR"];
  return Object.fromEntries(names.filter(name => process.env[name]).map(name => [name, process.env[name]!]));
}

export type CommandState = { state: "running" } | { state: "exited"; code: number | null; signal: string | null } | { state: "lost" } | { state: "unknown" };
export type CommandLaunch = { executionId: string; argv: string[]; cwd: string; environment: Record<string, string> };

export interface WatchMachine {
  /** The runner's name, or null for the owner's own machine. */
  readonly runner: string | null;
  observe(path: string): Promise<PathVersion>;
  isDirectory(path: string): Promise<boolean>;
  /** Where the host's record will live on that machine, before anything starts. */
  hostRecord(executionId: string): Promise<{ directory: string; unit: string; protocol: number }>;
  /** Starts the command's host; a `notStarted` answer proves nothing runs. */
  launch(input: CommandLaunch): Promise<{ hostScript: string } | { notStarted: string }>;
  commandState(executionId: string, directory: string): Promise<CommandState>;
  /** After a lost start: alive, gone without a journal (it never ran), gone with one, or unknown. */
  startOutcome(executionId: string, directory: string): Promise<"alive" | "never-ran" | "ran" | "unknown">;
  outputTail(directory: string): Promise<string>;
  signal(executionId: string, directory: string, signal: "SIGTERM" | "SIGKILL", commandId: string): Promise<void>;
  release(executionId: string, directory: string): Promise<boolean>;
  retire(executionId: string): Promise<void>;
  prune(directory: string): Promise<void>;
}

/** The last stretch of what a finished command wrote, read from the end of its journal. */
function outputTail(directory: string): string {
  try {
    const path = join(directory, "journal");
    const size = statSync(path).size, length = Math.min(size, 128 * 1024);
    const buffer = Buffer.alloc(length), fd = openSync(path, "r");
    try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
    const lines = buffer.toString("utf8").split("\n");
    if (size > length) lines.shift();
    let text = "";
    for (const line of lines) {
      if (!line) continue;
      try { const frame = JSON.parse(line); if (frame.k === "o") text += `${frame.d}\n`; else if (frame.k === "e") text += String(frame.d); } catch { /* torn tail */ }
    }
    return text.length > OUTPUT_TAIL_CHARS ? `…${text.slice(-OUTPUT_TAIL_CHARS)}` : text;
  } catch { return ""; }
}

/** This machine: hosts under `stateDir`, helpers from `routerBotDir`. */
export function localWatchMachine(stateDir: string, routerBotDir: () => string, hiddenPaths: string[] = []): WatchMachine {
  return {
    runner: null,
    observe: async path => observePath(path),
    isDirectory: async path => existsSync(path) && statSync(path).isDirectory(),
    hostRecord: async executionId => ({ directory: executionDirectory(stateDir, executionId), unit: executionUnit(executionId), protocol: HOST_PROTOCOL_VERSION }),
    async launch(input) {
      try {
        const launch = await startHost({ stateDir, executionId: input.executionId, routerBotDir: routerBotDir(), priority: "waiter",
          ...(hiddenPaths.length ? { hiddenPaths } : {}), manifest: {
          executable: "/bin/sh", args: ["-c", 'exec "$@" </dev/null', "concierge-watch", ...input.argv], cwd: input.cwd,
          environment: input.environment, initialInput: "" } });
        return { hostScript: launch.hostScript };
      } catch (error) {
        if (error instanceof HostNotStartedError) return { notStarted: error.message };
        throw error;
      }
    },
    async commandState(executionId, directory) {
      try {
        const connection = await HostConnection.connect(hostSocketPath(directory), 3_000);
        try {
          const status = await connection.status();
          if (status.executionId !== executionId) return { state: "unknown" };
          return status.exit ? { state: "exited", code: status.exit.code, signal: status.exit.signal } : { state: "running" };
        } finally { connection.close(); }
      } catch { /* the host does not answer: the supervisor and the record decide */ }
      const view = await hostSupervisorView(executionId);
      if (view === "unknown") return { state: "unknown" };
      try {
        for await (const frame of streamJournal(directory)) if (frame.k === "x")
          return { state: "exited", code: frame.d?.code ?? null, signal: frame.d?.signal ?? null };
      } catch { /* no journal */ }
      return view === "gone" ? { state: "lost" } : { state: "unknown" };
    },
    async startOutcome(executionId, directory) {
      const view = await hostSupervisorView(executionId);
      if (view === "alive") return "alive";
      if (view === "unknown") return "unknown";
      return existsSync(join(directory, "journal")) ? "ran" : "never-ran";
    },
    outputTail: async directory => outputTail(directory),
    async signal(_executionId, directory, signal, commandId) {
      const connection = await HostConnection.connect(hostSocketPath(directory), 3_000);
      try {
        await connection.attach(Number.MAX_SAFE_INTEGER, () => {});
        await connection.command({ op: "signal", id: commandId, signal });
      } finally { connection.close(); }
    },
    release: (executionId, directory) => releaseHost(directory, executionId),
    retire: executionId => retireHostJob(executionId),
    prune: async directory => { rmSync(directory, { recursive: true, force: true }); },
  };
}

/** A runner's machine, through its call channel; any failure to reach it is an error the worker treats as not knowing. */
export function runnerWatchMachine(runner: string): WatchMachine {
  const call = (method: string, params: Record<string, unknown>) => runnerMachineCall(runner, `watch.${method}`, params);
  return {
    runner,
    observe: path => call("observe", { path }),
    isDirectory: path => call("isDirectory", { path }),
    hostRecord: executionId => call("hostRecord", { executionId }),
    launch: input => call("launch", input),
    commandState: (executionId, directory) => call("commandState", { executionId, directory }),
    startOutcome: (executionId, directory) => call("startOutcome", { executionId, directory }),
    outputTail: directory => call("outputTail", { directory }),
    signal: (executionId, directory, signal, commandId) => call("signal", { executionId, directory, signal, commandId }),
    release: (executionId, directory) => call("release", { executionId, directory }),
    retire: executionId => call("retire", { executionId }),
    prune: directory => call("prune", { directory }),
  };
}

/**
 * The runner's side: one call from the owner, answered by this machine's own functions. A path the
 * owner names for a host record must be inside this runner's execution folder, so a call can never
 * remove or signal something else on the runner.
 */
export async function serveWatchCall(machine: WatchMachine, stateDir: string, method: string, params: any): Promise<unknown> {
  const inExecutions = (directory: unknown) => {
    if (typeof directory !== "string" || dirname(directory) !== join(stateDir, "exec") || !EXECUTION_ID.test(basename(directory)))
      throw new Error("that host record is not this runner's");
    return directory;
  };
  const executionId = (value: unknown) => { if (typeof value !== "string" || !EXECUTION_ID.test(value)) throw new Error("not an execution id"); return value; };
  switch (method) {
    case "observe": return machine.observe(String(params.path));
    case "isDirectory": return machine.isDirectory(String(params.path));
    case "hostRecord": return machine.hostRecord(executionId(params.executionId));
    // The command gets this machine's ordinary variables, never the owner's.
    case "launch": return machine.launch({ executionId: executionId(params.executionId), argv: params.argv, cwd: String(params.cwd), environment: ordinaryCommandEnvironment() });
    case "commandState": return machine.commandState(String(params.executionId), inExecutions(params.directory));
    case "startOutcome": return machine.startOutcome(String(params.executionId), inExecutions(params.directory));
    case "outputTail": return machine.outputTail(inExecutions(params.directory));
    case "signal": return machine.signal(String(params.executionId), inExecutions(params.directory), params.signal === "SIGKILL" ? "SIGKILL" : "SIGTERM", String(params.commandId));
    case "release": return machine.release(String(params.executionId), inExecutions(params.directory));
    case "retire": return machine.retire(String(params.executionId));
    case "prune": return machine.prune(inExecutions(params.directory));
  }
  throw new Error(`unknown watch call ${method}`);
}
