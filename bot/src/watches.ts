/**
 * The durable watch: "wake this conversation once, when this file or directory changes, when this
 * command finishes, or at a deadline", with no model awake while it waits
 * (design docs/plans/2026-10-07-agent-work-and-updates-without-waiting.md §4.4 and §7;
 * docs/architecture/WATCHES.md).
 *
 * Registrations are rows in the ledger. One worker per machine, inside this process, polls them.
 * It is crash-only: a restart or a sleeping Mac is a pause, and the next poll rechecks every
 * condition against the saved baseline and records the pause as a gap instead of pretending it
 * watched throughout. A watch ends in exactly one terminal event, written in the same transaction
 * that settles it and before anything is delivered; the event reaches the registering session as
 * one service input with the stable id `watch:<watch-id>:<event>`.
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { db } from "./state";
import { log, errorFields } from "./log";
import { nextRetry } from "./retry-core";
import { RETRY_POLICIES } from "./retry-policies";
import { providerOwnerEnvironment } from "./provider-owner-environment";
import { HOST_PROTOCOL_VERSION, HostConnection, executionDirectory, executionHostsEnabled, executionUnit,
  hostSocketPath, hostSupervisorView, newExecutionId, streamJournal, releaseHost, retireHostJob, startHost, HostNotStartedError } from "./execution-host-client";

export const WATCH_POLL_MS = 5_000;
/** Three missed polls: a longer silence is a pause (a restart, a sleeping Mac) and is recorded as a gap. */
export const WATCH_GAP_MS = 3 * WATCH_POLL_MS;
/** A file up to this size is versioned by its content; a bigger one by modification time and size. */
export const WATCH_HASH_LIMIT_BYTES = 4 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 20_000;
const NAMED_ENTRIES_LIMIT = 500;
const MIN_UNTIL_MS = 1_000;
const MAX_UNTIL_MS = 30 * 24 * 60 * 60_000;
const STOP_GRACE_MS = 10_000;
const RECORD_RETENTION_MS = 30 * 24 * 60 * 60_000;
const OUTPUT_TAIL_CHARS = 1_500;

if (process.env.CONCIERGE_READ_WORKER !== "1") db.exec(`
CREATE TABLE IF NOT EXISTS watches (
  watch_id            TEXT PRIMARY KEY,
  session_id          INTEGER NOT NULL,
  origin_input_id     TEXT NOT NULL,
  origin_run_id       TEXT NOT NULL,
  action_id           TEXT NOT NULL,
  request_hash        TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('file','command')),
  condition_json      TEXT NOT NULL,
  baseline_json       TEXT NOT NULL,
  baseline_mode       TEXT NOT NULL,
  deadline_ms         INTEGER NOT NULL,
  state               TEXT NOT NULL CHECK (state IN ('accepted','observing','fired','expired','failed','cancelled')),
  last_observed_ms    INTEGER,
  gaps_json           TEXT NOT NULL DEFAULT '[]',
  terminal_event      TEXT,
  terminal_at_ms      INTEGER,
  observation_json    TEXT,
  message_text        TEXT,
  delivery_state      TEXT CHECK (delivery_state IN ('pending','accepted')),
  delivery_input_id   TEXT,
  delivery_attempts   INTEGER NOT NULL DEFAULT 0,
  delivery_next_ms    INTEGER,
  host_execution_id   TEXT,
  host_directory      TEXT,
  host_unit           TEXT,
  host_script         TEXT,
  host_protocol       INTEGER,
  host_state          TEXT CHECK (host_state IN ('intended','live','stopping','released','gone')),
  host_stop_at_ms     INTEGER,
  host_killed         INTEGER NOT NULL DEFAULT 0,
  host_pruned         INTEGER NOT NULL DEFAULT 0,
  created_at_ms       INTEGER NOT NULL,
  UNIQUE (origin_input_id, action_id)
);
`);

export type WatchRow = {
  watch_id: string; session_id: number; origin_input_id: string; origin_run_id: string; action_id: string; request_hash: string;
  kind: "file" | "command"; condition_json: string; baseline_json: string; baseline_mode: string; deadline_ms: number;
  state: "accepted" | "observing" | "fired" | "expired" | "failed" | "cancelled"; last_observed_ms: number | null; gaps_json: string;
  terminal_event: string | null; terminal_at_ms: number | null; observation_json: string | null; message_text: string | null;
  delivery_state: "pending" | "accepted" | null; delivery_input_id: string | null; delivery_attempts: number; delivery_next_ms: number | null;
  host_execution_id: string | null; host_directory: string | null; host_unit: string | null; host_script: string | null;
  host_protocol: number | null; host_state: "intended" | "live" | "stopping" | "released" | "gone" | null; host_stop_at_ms: number | null;
  host_killed: number; host_pruned: number; created_at_ms: number;
};
type Gap = { fromMs: number; toMs: number };
const gapsOf = (row: WatchRow): Gap[] => JSON.parse(row.gaps_json);
const isOpen = (row: WatchRow) => row.state === "accepted" || row.state === "observing";
const iso = (ms: number) => new Date(ms).toISOString();

// ---- file and directory versions ---------------------------------------------------------------

export type PathVersion = {
  type: "absent" | "file" | "directory" | "other";
  mode: "absent" | "content-hash" | "mtime-size" | "directory-entries";
  size: number | null; mtimeMs: number | null; digest: string | null;
  entryCount: number | null;
  /** name -> [size, mtimeMs]; kept only for a small directory, to name what changed. */
  entries: Record<string, [number, number]> | null;
};
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** What is at `path` now. A missing path is a version (`absent`), not an error: appearing is a change. */
export function observePath(path: string): PathVersion {
  let stat;
  try { stat = statSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR")
      return { type: "absent", mode: "absent", size: null, mtimeMs: null, digest: null, entryCount: null, entries: null };
    throw error;
  }
  if (stat.isDirectory()) {
    const names = readdirSync(path);
    if (names.length > MAX_DIRECTORY_ENTRIES)
      return { type: "directory", mode: "directory-entries", size: null, mtimeMs: null, digest: `too-many:${names.length}`, entryCount: names.length, entries: null };
    const entries: Record<string, [number, number]> = {};
    for (const name of names.sort()) {
      try { const entry = lstatSync(join(path, name)); entries[name] = [entry.size, entry.mtimeMs]; }
      catch { /* removed while listing: it is simply not there */ }
    }
    const digest = sha256(Object.entries(entries).map(([name, [size, mtime]]) => `${name}\0${size}\0${mtime}`).join("\n"));
    return { type: "directory", mode: "directory-entries", size: null, mtimeMs: null, digest, entryCount: Object.keys(entries).length,
      entries: Object.keys(entries).length <= NAMED_ENTRIES_LIMIT ? entries : null };
  }
  if (stat.isFile() && stat.size <= WATCH_HASH_LIMIT_BYTES)
    return { type: "file", mode: "content-hash", size: stat.size, mtimeMs: stat.mtimeMs, digest: sha256(readFileSync(path)), entryCount: null, entries: null };
  return { type: stat.isFile() ? "file" : "other", mode: "mtime-size", size: stat.size, mtimeMs: stat.mtimeMs, digest: null, entryCount: null, entries: null };
}

/** Why `now` is not the baseline version, or null when it is the same version. */
export function versionChange(baseline: PathVersion, now: PathVersion): string | null {
  if (baseline.type !== now.type) {
    if (now.type === "absent") return `it was deleted (it was a ${baseline.type})`;
    if (baseline.type === "absent") return `it appeared (a ${now.type})`;
    return `it changed from a ${baseline.type} to a ${now.type}`;
  }
  if (now.type === "absent") return null;
  if (now.type === "directory") {
    if (now.digest === baseline.digest) return null;
    if (baseline.entries && now.entries) {
      const added = Object.keys(now.entries).filter(name => !baseline.entries![name]);
      const removed = Object.keys(baseline.entries).filter(name => !now.entries![name]);
      const modified = Object.keys(now.entries).filter(name => baseline.entries![name]
        && (baseline.entries![name]![0] !== now.entries![name]![0] || baseline.entries![name]![1] !== now.entries![name]![1]));
      const list = (label: string, names: string[]) => names.length ? `${label} ${names.slice(0, 10).join(", ")}${names.length > 10 ? ` and ${names.length - 10} more` : ""}` : "";
      return `its entries changed: ${[list("added", added), list("removed", removed), list("modified", modified)].filter(Boolean).join("; ")}`;
    }
    return `its entries changed (${baseline.entryCount} entries before, ${now.entryCount} now)`;
  }
  if (baseline.size !== now.size) return `its size changed from ${baseline.size} to ${now.size} bytes`;
  if (baseline.mode === "content-hash") return now.digest !== baseline.digest ? "its content changed" : null;
  return baseline.mtimeMs !== now.mtimeMs ? "its modification time changed (size unchanged; a version by modification time and size cannot prove the content differs)" : null;
}

const describeBaseline = (version: PathVersion) =>
  version.mode === "content-hash" ? `content hash of a ${version.size}-byte file`
    : version.mode === "directory-entries" ? `names, sizes and modification times of ${version.entryCount} direct entries`
      : version.mode === "absent" ? "the path does not exist yet; its appearing counts as a change"
        : `modification time and size (${version.size} bytes; the file is too large to hash, so a change that keeps both is not seen)`;

// ---- registration ------------------------------------------------------------------------------

/** "90s", "30m", "2h", "1d", "1h30m", or an ISO-8601 time. */
export function parseUntil(value: string, now: number): number {
  const text = value.trim();
  const compound = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  const ms = compound && text ? (Number(compound[1] ?? 0) * 86_400 + Number(compound[2] ?? 0) * 3_600 + Number(compound[3] ?? 0) * 60 + Number(compound[4] ?? 0)) * 1_000 : null;
  const deadline = ms !== null ? now + ms : Date.parse(text);
  if (!Number.isFinite(deadline)) throw new Error("--until takes an ISO-8601 time or a duration such as 90s, 30m, 2h, 1d or 1h30m.");
  if (deadline - now < MIN_UNTIL_MS) throw new Error("--until must be in the future.");
  if (deadline - now > MAX_UNTIL_MS) throw new Error("--until is at most 30 days away.");
  return deadline;
}

export type WatchRegistration = { sessionId: number; originInputId: string; originRunId: string; actionId: string; until: string }
  & ({ kind: "file"; path: string } | { kind: "command"; argv: string[]; cwd: string });

export function watchView(row: WatchRow) {
  const condition = JSON.parse(row.condition_json);
  return {
    id: row.watch_id, kind: row.kind, condition, state: row.state,
    baseline: { mode: row.baseline_mode, ...(row.kind === "file" ? { description: describeBaseline(JSON.parse(row.baseline_json)) } : {}) },
    registeredAt: iso(row.created_at_ms), deadline: iso(row.deadline_ms),
    lastObservedAt: row.last_observed_ms ? iso(row.last_observed_ms) : null,
    gaps: gapsOf(row).map(gap => ({ from: iso(gap.fromMs), to: iso(gap.toMs) })),
    terminalEvent: row.terminal_event, endedAt: row.terminal_at_ms ? iso(row.terminal_at_ms) : null,
    delivery: row.delivery_state, deliveredAs: row.delivery_input_id,
  };
}

/** Idempotent by (origin input, action id): a retry returns the first registration and never makes a second. */
export function registerWatch(input: WatchRegistration, now = Date.now()): { watch: ReturnType<typeof watchView>; duplicate: boolean } {
  if (!input.actionId || input.actionId.length > 200) throw new Error("A stable action id is required.");
  const condition = input.kind === "file" ? { path: input.path } : { argv: input.argv, cwd: input.cwd };
  const requestHash = sha256(JSON.stringify({ kind: input.kind, condition, until: input.until.trim() }));
  const prior = db.query("SELECT * FROM watches WHERE origin_input_id=? AND action_id=?").get(input.originInputId, input.actionId) as WatchRow | null;
  if (prior) {
    if (prior.request_hash !== requestHash || prior.session_id !== input.sessionId) throw new Error("Idempotency conflict: this action id already registered a different watch.");
    return { watch: watchView(prior), duplicate: true };
  }
  const deadline = parseUntil(input.until, now);
  let baseline: unknown, mode: string;
  if (input.kind === "file") {
    if (!input.path.startsWith("/")) throw new Error("A watched path must be absolute.");
    const version = observePath(input.path);
    if (version.type === "directory" && version.digest?.startsWith("too-many:"))
      throw new Error(`That directory has more than ${MAX_DIRECTORY_ENTRIES} entries; watch a narrower one.`);
    baseline = version; mode = version.mode;
  } else {
    if (!input.argv.length || input.argv.length > 256 || input.argv.some(item => typeof item !== "string") || input.argv.join("").length > 65_536)
      throw new Error("A command watch needs an explicit argument list (at most 256 arguments).");
    if (!input.argv[0]!.includes("/")) throw new Error("The command must be a path; the helper resolves a bare name before sending it.");
    if (!input.cwd.startsWith("/") || !existsSync(input.cwd) || !statSync(input.cwd).isDirectory()) throw new Error("--cwd must be an existing absolute directory.");
    if (!executionHostsEnabled()) throw new Error("This machine cannot run a command apart from Concierge, so it cannot watch one.");
    baseline = { notStarted: true }; mode = "launch-record";
  }
  const watchId = randomBytes(6).toString("hex");
  // The baseline is part of the same row as the registration, so it exists before the caller hears yes.
  db.query(`INSERT INTO watches (watch_id, session_id, origin_input_id, origin_run_id, action_id, request_hash, kind, condition_json,
      baseline_json, baseline_mode, deadline_ms, state, last_observed_ms, created_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?)`)
    .run(watchId, input.sessionId, input.originInputId, input.originRunId, input.actionId, requestHash, input.kind, JSON.stringify(condition),
      JSON.stringify(baseline), mode, deadline, now, now);
  wakeWatchWorker();
  return { watch: watchView(db.query("SELECT * FROM watches WHERE watch_id=?").get(watchId) as WatchRow), duplicate: false };
}

/** A session's own watches, newest first. */
export function listWatches(sessionId: number) {
  return (db.query("SELECT * FROM watches WHERE session_id=? ORDER BY created_at_ms DESC, rowid DESC LIMIT 50").all(sessionId) as WatchRow[]).map(watchView);
}

/** Only the registering session may cancel; a watch already over is returned as it ended. */
export function cancelWatch(sessionId: number, watchId: string, now = Date.now()) {
  const row = db.query("SELECT * FROM watches WHERE watch_id=?").get(watchId) as WatchRow | null;
  if (!row || row.session_id !== sessionId) throw new Error("No such watch for this session.");
  if (isOpen(row)) settle(watchId, "cancelled", { observedAt: null, now, detail: "You cancelled it." });
  wakeWatchWorker();
  return watchView(db.query("SELECT * FROM watches WHERE watch_id=?").get(watchId) as WatchRow);
}

// ---- settling and the words ---------------------------------------------------------------------

type Settlement = { observedAt: number | null; now: number; detail: string; observed?: unknown };

function gapsText(gaps: Gap[], row: WatchRow, endedAt: number) {
  if (!gaps.length) return `Observation gaps: none. Concierge polled every ${WATCH_POLL_MS / 1000} s from ${iso(row.created_at_ms)} to ${iso(endedAt)} with no silence longer than ${WATCH_GAP_MS / 1000} s.`;
  const list = gaps.map(gap => `${iso(gap.fromMs)} to ${iso(gap.toMs)} (${Math.round((gap.toMs - gap.fromMs) / 1000)} s)`).join("; ");
  return `Observation gaps: ${gaps.length}. Nothing was observed during ${list}, because Concierge was restarting or the machine was asleep or unreachable. A change that was made and undone inside a gap cannot be known; what is stated here is what was found when observation resumed.`;
}

/**
 * Ends a watch in one terminal event. The state change, the event, its observation and the words
 * for the session are one transaction, so a deadline and a change that race produce exactly one
 * event, and the event exists before anything is delivered.
 */
function settle(watchId: string, event: "fired" | "expired" | "failed" | "cancelled", settlement: Settlement): boolean {
  return db.transaction(() => {
    const row = db.query("SELECT * FROM watches WHERE watch_id=?").get(watchId) as WatchRow | null;
    if (!row || !isOpen(row)) return false;
    const gaps = gapsOf(row);
    const resumedAt = settlement.observedAt ?? settlement.now;
    const last = row.last_observed_ms ?? row.created_at_ms;
    if (resumedAt - last > WATCH_GAP_MS) gaps.push({ fromMs: last, toMs: resumedAt });
    const condition = JSON.parse(row.condition_json);
    const what = row.kind === "file" ? `${condition.path}` : `the command ${JSON.stringify(condition.argv)} in ${condition.cwd}`;
    const late = settlement.now > row.deadline_ms && event === "fired"
      ? ` The deadline (${iso(row.deadline_ms)}) had already passed when this was observed (${iso(settlement.now)}); the change may have come either side of it.` : "";
    const headline = event === "fired"
      ? `Watch ${watchId} fired: ${settlement.detail}.`
      : event === "expired" ? `Watch ${watchId} expired at ${iso(settlement.now)}: ${settlement.detail}.`
        : event === "failed" ? `Watch ${watchId} failed: ${settlement.detail}.`
          : `Watch ${watchId} was cancelled: ${settlement.detail}`;
    const text = `${headline}${late} It watched ${what}, registered ${iso(row.created_at_ms)} with a deadline of ${iso(row.deadline_ms)}. ${gapsText(gaps, row, resumedAt)}${
      settlement.observed && typeof (settlement.observed as any).outputTail === "string" && (settlement.observed as any).outputTail
        ? `\nLast output of the command (stdout and stderr):\n${(settlement.observed as any).outputTail}` : ""}
You do not need to reply to this.`;
    const result = db.query(`UPDATE watches SET state=?, terminal_event=?, terminal_at_ms=?, observation_json=?, message_text=?, gaps_json=?,
        last_observed_ms=?, delivery_state='pending', delivery_input_id=?, delivery_attempts=0, delivery_next_ms=NULL
      WHERE watch_id=? AND state IN ('accepted','observing')`)
      .run(event, event, settlement.now, JSON.stringify({ detail: settlement.detail, observedAt: settlement.observedAt ? iso(settlement.observedAt) : null, ...(settlement.observed ? { observed: settlement.observed } : {}) }),
        text, JSON.stringify(gaps), settlement.observedAt ?? row.last_observed_ms, `watch:${watchId}:${event}`, watchId);
    return result.changes === 1;
  })();
}

// ---- the worker --------------------------------------------------------------------------------

export type WatchAdmission = {
  sessionId: number; inputId: string; origin: "service"; sourceInputId: string; sourceRunId: string; requestId: string; text: string;
};
export type WatchWorkerDeps = {
  admit: (input: WatchAdmission) => unknown;
  stateDir: string;
  /** The release's helper folder an execution host is taken from. */
  routerBotDir: () => string;
  stopped?: () => boolean;
};

let wakeRequested: (() => void) | null = null;
/** A registration or cancel asks the worker to look now instead of at the next poll. */
export function wakeWatchWorker() { queueMicrotask(() => wakeRequested?.()); }

/** The environment a watched command gets: the ordinary user variables, never Concierge's own secrets. */
function commandEnvironment(): Record<string, string> {
  const names = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "SHELL", "TMPDIR", "TZ", "XDG_RUNTIME_DIR"];
  return Object.fromEntries(names.filter(name => process.env[name]).map(name => [name, process.env[name]!]));
}

function update(watchId: string, set: string, ...params: unknown[]) {
  db.query(`UPDATE watches SET ${set} WHERE watch_id=?`).run(...params, watchId);
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

function describeExit(exit: { code: number | null; signal: string | null }) {
  return exit.signal ? `the command ended on signal ${exit.signal}` : `the command exited with code ${exit.code}`;
}

async function observeFile(row: WatchRow, now: number) {
  const baseline = JSON.parse(row.baseline_json) as PathVersion;
  let current: PathVersion;
  try { current = observePath(JSON.parse(row.condition_json).path); }
  catch (error) {
    // Unreadable now: nothing was observed, so the silence is recorded as a gap when observation resumes.
    log("warn", "watch_unreadable", { watch_id: row.watch_id, ...errorFields(error) });
    if (now >= row.deadline_ms) settle(row.watch_id, "expired", { observedAt: null, now, detail: "no change was observed, but the path could not be read at the end" });
    return;
  }
  const change = versionChange(baseline, current);
  if (change) { settle(row.watch_id, "fired", { observedAt: now, now, detail: `${JSON.parse(row.condition_json).path}: ${change}`, observed: { version: current } }); return; }
  if (now >= row.deadline_ms) { settle(row.watch_id, "expired", { observedAt: now, now, detail: `no change to ${JSON.parse(row.condition_json).path} was observed (still ${describeBaseline(baseline)})` }); return; }
  markObserved(row, now);
}

function markObserved(row: WatchRow, now: number) {
  const gaps = gapsOf(row), last = row.last_observed_ms ?? row.created_at_ms;
  if (now - last > WATCH_GAP_MS) gaps.push({ fromMs: last, toMs: now });
  db.query("UPDATE watches SET state='observing', last_observed_ms=?, gaps_json=? WHERE watch_id=? AND state IN ('accepted','observing')")
    .run(now, JSON.stringify(gaps), row.watch_id);
}

async function launchCommand(row: WatchRow, deps: WatchWorkerDeps, now: number) {
  const condition = JSON.parse(row.condition_json) as { argv: string[]; cwd: string };
  if (now >= row.deadline_ms) { settle(row.watch_id, "expired", { observedAt: null, now, detail: "its deadline passed before the command could be started, so it was never started" }); return; }
  if (!existsSync(condition.cwd)) { settle(row.watch_id, "failed", { observedAt: now, now, detail: `the working directory ${condition.cwd} no longer exists, so the command was not started` }); return; }
  const executionId = newExecutionId();
  // The intent is recorded before the supervisor is asked, so a crash in between leaves evidence.
  update(row.watch_id, "host_execution_id=?, host_directory=?, host_unit=?, host_protocol=?, host_state='intended'",
    executionId, executionDirectory(deps.stateDir, executionId), executionUnit(executionId), HOST_PROTOCOL_VERSION);
  try {
    const launch = await startHost({ stateDir: deps.stateDir, executionId, routerBotDir: deps.routerBotDir(), manifest: {
      executable: "/bin/sh", args: ["-c", 'exec "$@" </dev/null', "concierge-watch", ...condition.argv], cwd: condition.cwd,
      environment: commandEnvironment(), initialInput: "" } });
    update(row.watch_id, "host_script=?, host_state='live'", launch.hostScript);
    log("info", "watch_command_started", { watch_id: row.watch_id, execution_id: executionId });
    markObserved(row, now);
  } catch (error) {
    if (error instanceof HostNotStartedError) {
      update(row.watch_id, "host_state='gone'");
      settle(row.watch_id, "failed", { observedAt: now, now, detail: `the command could not be started: ${error.message}` });
    } else log("warn", "watch_command_start_unconfirmed", { watch_id: row.watch_id, ...errorFields(error) });
  }
}

/** What the host says about the command: its exit, still running, or not known this poll. */
async function commandState(row: WatchRow): Promise<{ state: "running" } | { state: "exited"; code: number | null; signal: string | null } | { state: "lost" } | { state: "unknown" }> {
  const directory = row.host_directory!, executionId = row.host_execution_id!;
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
    for await(const frame of streamJournal(directory))if(frame.k==="x")
      return { state: "exited", code: frame.d?.code ?? null, signal: frame.d?.signal ?? null };
  } catch { /* no journal */ }
  return view === "gone" ? { state: "lost" } : { state: "unknown" };
}

async function observeCommand(row: WatchRow, deps: WatchWorkerDeps, now: number) {
  if (!row.host_execution_id) { await launchCommand(row, deps, now); return; }
  if (row.host_state === "intended") {
    // A coordinator died between recording the intent and learning the result.
    const view = await hostSupervisorView(row.host_execution_id);
    if (view === "alive") update(row.watch_id, "host_state='live'");
    else if (view === "gone" && !existsSync(join(row.host_directory!, "journal"))) {
      update(row.watch_id, "host_state='gone'");
      settle(row.watch_id, "failed", { observedAt: now, now, detail: "Concierge restarted while starting the command, and no trace of it was found; it did not run" });
      return;
    } else if (view === "unknown") return;
    else update(row.watch_id, "host_state='live'");
  }
  const state = await commandState(row);
  if (state.state === "exited") {
    const tail = outputTail(row.host_directory!);
    settle(row.watch_id, "fired", { observedAt: now, now, detail: `${describeExit(state)}`, observed: { exit: { code: state.code, signal: state.signal }, outputTail: tail } });
    return;
  }
  if (state.state === "lost") {
    update(row.watch_id, "host_state='gone'");
    settle(row.watch_id, "failed", { observedAt: now, now, detail: "the command's supervisor is gone and left no record of how the command ended" });
    return;
  }
  if (state.state === "unknown") {
    if (now >= row.deadline_ms) settle(row.watch_id, "expired", { observedAt: null, now, detail: "the command's state could not be read at the deadline" });
    return;
  }
  if (now >= row.deadline_ms) { settle(row.watch_id, "expired", { observedAt: now, now, detail: "the command had not finished by the deadline, so it was stopped" }); return; }
  markObserved(row, now);
}

/** After a watch ends: stop a command that is still running, then let its host go. */
async function cleanUpHost(row: WatchRow, now: number) {
  if (!row.host_execution_id || !["live", "stopping", "intended"].includes(row.host_state ?? "")) return;
  const state = await commandState(row);
  if (state.state === "running") {
    if (!row.host_stop_at_ms) {
      await signalHost(row, "SIGTERM");
      update(row.watch_id, "host_state='stopping', host_stop_at_ms=?", now);
    } else if (!row.host_killed && now - row.host_stop_at_ms > STOP_GRACE_MS) {
      await signalHost(row, "SIGKILL");
      update(row.watch_id, "host_killed=1");
    }
    return;
  }
  if (state.state === "exited") {
    if (await releaseHost(row.host_directory!, row.host_execution_id)) {
      update(row.watch_id, "host_state='released'");
      // launchd keeps a finished job loaded; it is removed once it reports stopped.
      setTimeout(() => { void retireHostJob(row.host_execution_id!).catch(error =>
        log("warn", "watch_host_retire_failed", { watch_id: row.watch_id, error: String(error) })); }, 10_000).unref?.();
    }
  } else if (state.state === "lost") update(row.watch_id, "host_state='gone'");
}

async function signalHost(row: WatchRow, signal: "SIGTERM" | "SIGKILL") {
  try {
    const connection = await HostConnection.connect(hostSocketPath(row.host_directory!), 3_000);
    try {
      await connection.attach(Number.MAX_SAFE_INTEGER, () => {});
      await connection.command({ op: "signal", id: `watch-${signal}-${row.watch_id}`, signal });
    } finally { connection.close(); }
  } catch (error) { log("warn", "watch_command_signal_failed", { watch_id: row.watch_id, signal, ...errorFields(error) }); }
}

function deliverPending(deps: WatchWorkerDeps, now: number) {
  const due = db.query("SELECT * FROM watches WHERE delivery_state='pending' AND (delivery_next_ms IS NULL OR delivery_next_ms<=?) ORDER BY terminal_at_ms LIMIT 20").all(now) as WatchRow[];
  for (const row of due) {
    try {
      // Admission is idempotent on this input id and the words are fixed in the row, so a retry
      // after a lost answer reaches the same input. A paused or archived session holds it.
      deps.admit({ sessionId: row.session_id, inputId: row.delivery_input_id!, origin: "service", sourceInputId: row.origin_input_id,
        sourceRunId: row.origin_run_id, requestId: row.delivery_input_id!, text: row.message_text! });
      update(row.watch_id, "delivery_state='accepted', delivery_next_ms=NULL");
      log("info", "watch_delivered", { watch_id: row.watch_id, event: row.terminal_event });
    } catch (error) {
      const attempts = row.delivery_attempts + 1;
      const next = nextRetry({ policy: RETRY_POLICIES.watchDelivery, attempt: attempts, startedAtMs: row.terminal_at_ms ?? now, nowMs: now, classification: "transient" });
      if (next.action === "retry") update(row.watch_id, "delivery_attempts=?, delivery_next_ms=?", attempts, next.atMs);
      else {
        // Left pending, not dropped: the next Concierge start tries again from the beginning.
        update(row.watch_id, "delivery_attempts=?, delivery_next_ms=?", attempts, Number.MAX_SAFE_INTEGER);
        log("error", "watch_undelivered", { watch_id: row.watch_id, event: row.terminal_event, reason: next.reason, ...errorFields(error) });
      }
    }
  }
}

function pruneRecords(now: number) {
  const old = db.query(`SELECT * FROM watches WHERE host_directory IS NOT NULL AND host_pruned=0 AND host_state IN ('released','gone')
    AND terminal_at_ms<?`).all(now - RECORD_RETENTION_MS) as WatchRow[];
  for (const row of old) {
    try { rmSync(row.host_directory!, { recursive: true, force: true }); update(row.watch_id, "host_pruned=1"); }
    catch (error) { log("warn", "watch_record_prune_failed", { watch_id: row.watch_id, ...errorFields(error) }); }
  }
}

/** One poll. `now` is a parameter so a pause can be simulated exactly. */
export async function runWatchTick(deps: WatchWorkerDeps, now = Date.now()) {
  const open = db.query("SELECT * FROM watches WHERE state IN ('accepted','observing') ORDER BY created_at_ms").all() as WatchRow[];
  for (const row of open) {
    try {
      if (row.kind === "file") await observeFile(row, now);
      else await observeCommand(row, deps, now);
    } catch (error) { log("error", "watch_poll_failed", { watch_id: row.watch_id, ...errorFields(error) }); }
  }
  const ended = db.query("SELECT * FROM watches WHERE kind='command' AND state NOT IN ('accepted','observing') AND host_state IN ('intended','live','stopping')").all() as WatchRow[];
  for (const row of ended) {
    try { await cleanUpHost(row, now); } catch (error) { log("warn", "watch_host_cleanup_failed", { watch_id: row.watch_id, ...errorFields(error) }); }
  }
  deliverPending(deps, now);
}

/** Starts this machine's one watch worker; returns its stop function. */
export function startWatchWorker(deps: WatchWorkerDeps): () => void {
  // A restart retries any delivery that had run out of attempts.
  db.query("UPDATE watches SET delivery_attempts=0, delivery_next_ms=NULL WHERE delivery_state='pending'").run();
  pruneRecords(Date.now());
  let running = false, again = false, timer: ReturnType<typeof setTimeout> | null = null, stopped = false;
  const poll = async () => {
    if (stopped || deps.stopped?.()) return;
    if (running) { again = true; return; }
    running = true;
    try { await runWatchTick(deps); }
    catch (error) { log("error", "watch_worker_failed", errorFields(error)); }
    finally { running = false; }
    if (again) { again = false; void poll(); }
  };
  const arm = () => { timer = setTimeout(() => { void poll().finally(() => { if (!stopped) arm(); }); }, WATCH_POLL_MS); };
  wakeRequested = () => { void poll(); };
  void poll();
  arm();
  return () => { stopped = true; if (timer) clearTimeout(timer); wakeRequested = null; };
}

// ---- what a release must not remove ------------------------------------------------------------

/** Host programs and protocols that live command watches still run; a release cleanup must keep them. */
export function watchHostsInUse(): { scripts: string[]; protocols: number[] } {
  const rows = db.query("SELECT DISTINCT host_script, host_protocol FROM watches WHERE host_state IN ('intended','live','stopping')").all() as { host_script: string | null; host_protocol: number | null }[];
  return { scripts: rows.map(row => row.host_script).filter((value): value is string => !!value), protocols: rows.map(row => row.host_protocol).filter((value): value is number => value !== null) };
}

/** What both runtime compositions call: this machine's one worker, delivering through the owner's admission. */
export function startMachineWatchWorker(admit: WatchWorkerDeps["admit"], stopped?: () => boolean): () => void {
  return startWatchWorker({ admit, stopped, stateDir: process.env.CONCIERGE_STATE_DIR!, routerBotDir: () => providerOwnerEnvironment().CONCIERGE_ROUTER_BOT_DIR! });
}
