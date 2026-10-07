#!/usr/bin/env bun
/**
 * Execution host: custody of one provider process, so the agent outlives the Concierge
 * coordinator that started it (design docs/plans/2026-10-07-agent-work-and-updates-without-waiting.md
 * §2, protocol in docs/architecture/EXECUTION-HOST.md).
 *
 * It does exactly this and nothing else: start the frozen launch manifest; hold the provider's
 * stdin open until an identified Close; write identified Submit lines and record each before
 * writing; record every stdout line and stderr chunk with a sequence before publishing it; serve
 * one attached coordinator at a time over a private socket, replaying from any sequence; report
 * the exact exit; keep the record until the coordinator releases it. Every policy (inactivity,
 * steering, settlement, what a frame means) lives in the coordinator, which a restart replaces;
 * a running host is never patched, so it must stay this small.
 *
 * Crash-only: no state lives only in memory that the journal cannot rebuild, and nothing is owed
 * if it dies mid-step. It imports nothing from the application and never opens the ledger.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync, chmodSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";

import HOST_PROTOCOLS from "../src/host-protocols.json";
export const HOST_PROTOCOL_VERSION: number = HOST_PROTOCOLS.current;
/** A record nobody comes back for is kept this long after the provider exited, then the host leaves. */
const ABANDONED_TERMINAL_MS = 7 * 24 * 60 * 60_000;
/** One frame line from a client may not exceed this; a provider message is far smaller. */
const MAX_COMMAND_BYTES = 16 * 1024 * 1024;

type Manifest = {
  version: 1; executionId: string; executable: string; args: string[]; cwd: string;
  environment?: Record<string, string>; initialInput: string; initialMeta?: Record<string, unknown>;
};
type Frame = { s: number; t: number; k: "o" | "e" | "i" | "c" | "x" | "h"; d: unknown };

const directory = process.argv[2];
if (!directory) { console.error("usage: execution-host <execution-directory>"); process.exit(2); }
const manifestPath = join(directory, "manifest.json");
const journalPath = join(directory, "journal");
const socketPath = join(directory, "host.sock");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
if (manifest.version !== 1 || !manifest.executionId || !manifest.executable || !Array.isArray(manifest.args)) {
  console.error("execution-host: unreadable manifest"); process.exit(2);
}
// The environment carries the coordinator's secrets; it is needed only to start the provider,
// so it leaves the disk as soon as the provider is started (the digest stays in the ledger).
const environment = manifest.environment ?? {};

if (existsSync(journalPath)) {
  // A journal already here means this execution was started before: one execution, one start.
  console.error("execution-host: this execution already has a journal; refusing a second start"); process.exit(3);
}
const journal = openSync(journalPath, "wx", 0o600);
let sequence = 0;
let journalError: string | null = null;
const live = new Set<(frame: Frame) => void>();

// Frames not yet fully on disk, oldest first, with how many of the first one's bytes are written.
// A frame is published only once it is persisted; a failed write is resumed where it stopped, so a
// torn tail never swallows the frame after it.
const unwritten: Array<{ frame: Frame; bytes: Buffer }> = [];
const persistedWaiters: Array<() => void> = [];
/** Resolves once every frame recorded so far is on disk. */
const whenPersisted = () => new Promise<void>(resolve => { if (!unwritten.length) resolve(); else persistedWaiters.push(resolve); });
let unwrittenOffset = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
function flush(): boolean {
  while (unwritten.length) {
    const head = unwritten[0]!;
    try {
      while (unwrittenOffset < head.bytes.length) unwrittenOffset += writeSync(journal, head.bytes, unwrittenOffset);
    } catch (error) {
      // A full disk stops the host from reading the provider (backpressure) and stays visible in
      // `status`; the event loop keeps answering, so Stop and status still work.
      journalError = error instanceof Error ? error.message : String(error);
      provider?.stdout?.pause(); provider?.stderr?.pause();
      flushTimer ??= setTimeout(() => { flushTimer = null; flush(); }, 1_000);
      return false;
    }
    unwritten.shift(); unwrittenOffset = 0;
    for (const send of live) send(head.frame);
  }
  journalError = null;
  for (const waiter of persistedWaiters.splice(0)) waiter();
  if (provider?.stdout?.isPaused()) { provider.stdout.resume(); provider.stderr?.resume(); }
  return true;
}
/** Records a frame; true when it is already on disk (and published), false when it waits for space. */
function append(k: Frame["k"], d: unknown): Frame & { persisted: boolean } {
  const frame: Frame = { s: ++sequence, t: Date.now(), k, d };
  unwritten.push({ frame, bytes: Buffer.from(`${JSON.stringify(frame)}\n`) });
  return { ...frame, persisted: flush() };
}

let provider: ChildProcess | null = null;
let exit: { code: number | null; signal: string | null; at: number } | null = null;
const receipts = new Map<string, Record<string, unknown>>();

append("h", { protocol: HOST_PROTOCOL_VERSION, executionId: manifest.executionId, hostPid: process.pid, started: Date.now() });
provider = spawn(manifest.executable, manifest.args, {
  cwd: manifest.cwd, env: environment, stdio: ["pipe", "pipe", "pipe"],
  // Its own process group, so Stop's signal reaches the tools it started too.
  detached: true,
});
const providerPid = provider.pid ?? null;
append("h", { providerPid });
try {
  const { environment: _secrets, ...kept } = manifest;
  writeFileSync(`${manifestPath}.tmp`, JSON.stringify(kept), { mode: 0o600 });
  renameSync(`${manifestPath}.tmp`, manifestPath);
} catch { /* the manifest stays private (0600) if it cannot be rewritten */ }

let stdoutRest = "";
provider.stdout!.setEncoding("utf8");
provider.stdout!.on("data", (chunk: string) => {
  stdoutRest += chunk;
  const lines = stdoutRest.split("\n");
  stdoutRest = lines.pop() ?? "";
  for (const line of lines) append("o", line);
});
provider.stderr!.setEncoding("utf8");
provider.stderr!.on("data", (chunk: string) => append("e", chunk));
provider.stdin!.on("error", error => append("c", { op: "stdin-error", error: error.message }));
provider.on("error", error => append("c", { op: "spawn-error", error: error.message }));
provider.on("close", (code, signal) => {
  if (stdoutRest) { append("o", stdoutRest); stdoutRest = ""; }
  exit = { code, signal, at: Date.now() };
  append("x", exit);
  setTimeout(() => leave("abandoned"), ABANDONED_TERMINAL_MS).unref();
});

function writeLine(line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stdin = provider?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) { reject(new Error("provider stdin is closed")); return; }
    stdin.write(`${line}\n`, error => error ? reject(error) : resolve());
  });
}
// The opening input is written before any coordinator attaches, so the host never depends on
// one being present; it is recorded like every other write.
const initial = append("i", { id: "initial", line: manifest.initialInput, meta: { kind: "initial", ...(manifest.initialMeta ?? {}) } });
receipts.set("initial", { op: "receipt", id: "initial", seq: initial.s, written: "pending" });
// Like every write, the opening one is made only once its attempt is on disk; a full disk at
// launch delays the agent's start rather than starting it without a record.
whenPersisted().then(() => writeLine(manifest.initialInput))
  .then(() => { append("c", { op: "written", id: "initial" }); receipts.set("initial", { op: "receipt", id: "initial", seq: initial.s, written: true }); })
  .catch(error => { receipts.set("initial", { op: "receipt", id: "initial", seq: initial.s, written: false, error: error.message }); append("c", { op: "write-failed", id: "initial", error: error.message }); });

// ---- the coordinator connection -------------------------------------------------------------
let attached: Socket | null = null;
function send(socket: Socket, message: unknown) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}
function status() {
  return { op: "status", protocol: HOST_PROTOCOL_VERSION, executionId: manifest.executionId, hostPid: process.pid,
    providerPid, lastSeq: sequence, exit, journalError, attached: !!attached };
}
async function command(socket: Socket, message: any) {
  const id = typeof message.id === "string" && message.id ? message.id : null;
  if (message.op === "status") return send(socket, status());
  if (message.op === "attach") {
    if (message.protocol !== HOST_PROTOCOL_VERSION) return send(socket, { op: "refused", reason: `host protocol ${HOST_PROTOCOL_VERSION}` });
    // One coordinator holds the execution at a time: a newer attach fences the older one, whose
    // commands are refused from then on (two coordinators overlapping during recovery).
    if (attached && attached !== socket) { send(attached, { op: "fenced" }); attached.end(); }
    attached = socket;
    const from = Number.isSafeInteger(message.from) && message.from > 0 ? message.from : 1;
    send(socket, { ...status(), op: "attached", until: sequence });
    // Replay and the switch to live delivery happen in one synchronous step, so no frame
    // written meanwhile can fall between them.
    const text = readFileSync(journalPath, "utf8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      let frame: Frame; try { frame = JSON.parse(line); } catch { continue; } // a torn tail is never sent
      if (frame.s >= from) send(socket, { op: "frame", ...frame });
    }
    const deliver = (frame: Frame) => { if (attached === socket) send(socket, { op: "frame", ...frame }); };
    live.add(deliver);
    socket.once("close", () => { live.delete(deliver); if (attached === socket) attached = null; });
    return;
  }
  if (socket !== attached) return send(socket, { op: "refused", id, reason: "not the attached coordinator" });
  if (!id) return send(socket, { op: "refused", reason: "a command needs its id" });
  // A repeated command returns what the first one did, never acts twice.
  const prior = receipts.get(id);
  if (prior) return send(socket, prior);
  if (message.op === "submit") {
    if (typeof message.line !== "string" || message.line.includes("\n")) return send(socket, { op: "refused", id, reason: "one line" });
    // A write is recorded before it is made; a record that cannot be kept means no write, and the
    // receipt says so (unsent, never ambiguous).
    if (unwritten.length) return send(socket, { op: "receipt", id, written: false, error: `journal unavailable: ${journalError}` });
    const frame = append("i", { id, line: message.line, meta: message.meta ?? null });
    if (!frame.persisted) {
      append("c", { op: "write-failed", id, error: "journal unavailable; not written" });
      receipts.set(id, { op: "receipt", id, seq: frame.s, written: false, error: `journal unavailable: ${journalError}` });
      return send(socket, receipts.get(id));
    }
    const pending = { op: "receipt", id, seq: frame.s, written: "pending" };
    receipts.set(id, pending);
    try {
      await writeLine(message.line);
      // Attempted and completed are separate facts: this one proves the pipe accepted the line.
      append("c", { op: "written", id });
      receipts.set(id, { ...pending, written: true });
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      append("c", { op: "write-failed", id, error: failure });
      receipts.set(id, { ...pending, written: false, error: failure });
    }
    return send(socket, receipts.get(id));
  }
  if (message.op === "close") {
    const frame = append("c", { op: "close", id });
    if (provider?.stdin && !provider.stdin.writableEnded) provider.stdin.end();
    receipts.set(id, { op: "receipt", id, seq: frame.s, done: true });
    return send(socket, receipts.get(id));
  }
  if (message.op === "signal") {
    const signal = ["SIGINT", "SIGTERM", "SIGKILL"].includes(message.signal) ? message.signal as NodeJS.Signals : null;
    if (!signal) return send(socket, { op: "refused", id, reason: "SIGINT, SIGTERM or SIGKILL" });
    const frame = append("c", { op: "signal", id, signal });
    let delivered = false;
    if (!exit && providerPid) { try { process.kill(-providerPid, signal); delivered = true; } catch { try { process.kill(providerPid, signal); delivered = true; } catch {} } }
    receipts.set(id, { op: "receipt", id, seq: frame.s, delivered });
    return send(socket, receipts.get(id));
  }
  if (message.op === "release") {
    // Custody ends only after the exit is recorded and the coordinator says it has it.
    if (!exit) return send(socket, { op: "refused", id, reason: "the provider is still running" });
    if (unwritten.length) return send(socket, { op: "refused", id, reason: "the record is not fully on disk yet" });
    append("c", { op: "release", id });
    send(socket, { op: "receipt", id, released: true });
    return leave("released");
  }
  send(socket, { op: "refused", id, reason: `unknown operation ${String(message.op)}` });
}

try { if (existsSync(socketPath)) unlinkSync(socketPath); } catch {}
const server = createServer(socket => {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_COMMAND_BYTES) { send(socket, { op: "refused", reason: "command too large" }); socket.destroy(); return; }
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message: unknown;
      try { message = JSON.parse(line); } catch { send(socket, { op: "refused", reason: "not JSON" }); continue; }
      void command(socket, message).catch(error => send(socket, { op: "refused", reason: String(error) }));
    }
  });
  socket.on("error", () => {});
});
server.listen(socketPath, () => { try { chmodSync(socketPath, 0o600); } catch {} });

let leaving = false;
function leave(reason: string) {
  if (leaving) return;
  leaving = true;
  try { append("c", { op: "host-exit", reason }); } catch {}
  try { closeSync(journal); } catch {}
  server.close();
  try { unlinkSync(socketPath); } catch {}
  process.exit(0);
}
// The supervisor stopping the host (a reboot, a unit stop) ends the provider with it: the unit's
// KillMode takes the whole group, so nothing is left running without its transport owner.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => {
  try { append("c", { op: "host-signal", signal }); } catch {}
  if (providerPid && !exit) { try { process.kill(-providerPid, "SIGTERM"); } catch {} }
  setTimeout(() => leave(`signal ${signal}`), 2_000).unref();
});
