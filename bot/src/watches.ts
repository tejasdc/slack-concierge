/**
 * The durable watch: "wake this conversation when this file or directory changes, when this
 * command finishes, or at a deadline", with no model awake while it waits. File watches can opt
 * into owner-managed renewal so an interrupted wake cannot leave the condition unwatched
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
import { db,globalPauseState,getSessionById } from "./state";
import { MAX_DIRECTORY_ENTRIES, versionChange, type PathVersion } from "./path-version";
export { WATCH_HASH_LIMIT_BYTES, observePath, versionChange, type PathVersion } from "./path-version";
import {sessionMetadata} from './session-inputs';
import {inboxThreadRoot,postForwardedThreadAnswer} from './session-inbox';
import { log, errorFields } from "./log";
import { nextRetry } from "./retry-core";
import { RETRY_POLICIES } from "./retry-policies";
import { providerOwnerEnvironment } from "./provider-owner-environment";
import { forgetWatchObservation, loadWatchObservationCursors, observationForWatch, recordWatchObservation,
  startWatchObservationWorker, stopWatchObservationWorker, waitForWatchObservationWorker } from './watch-observation';
import { executionHostsEnabled, hostProcessorSeconds, newExecutionId } from "./execution-host-client";
import { localWatchMachine, ordinaryCommandEnvironment, runnerWatchMachine, type WatchMachine } from "./watch-machine";
import { runnerMachineCall } from "./runner-machine-calls";
import { releaseIncludesCommit } from "./release-watch-condition";

export const WATCH_POLL_MS = 5_000;
/** Three missed polls: a longer silence is a pause (a restart, a sleeping Mac) and is recorded as a gap. */
export const WATCH_GAP_MS = 3 * WATCH_POLL_MS;
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
  renew_ms            INTEGER,
  series_id           TEXT,
  created_at_ms       INTEGER NOT NULL,
  UNIQUE (origin_input_id, action_id)
);
`);
if (process.env.CONCIERGE_READ_WORKER !== "1") {
  const columns = db.query("PRAGMA table_info(watches)").all() as { name: string }[];
  if (!columns.some(column => column.name === "renew_ms")) db.exec("ALTER TABLE watches ADD COLUMN renew_ms INTEGER");
  if (!columns.some(column => column.name === "series_id")) db.exec("ALTER TABLE watches ADD COLUMN series_id TEXT");
  // The runner whose machine holds the watched path or command; NULL is this owner's own machine.
  if (!columns.some(column => column.name === "runner")) db.exec("ALTER TABLE watches ADD COLUMN runner TEXT");
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS one_renewing_file_watch
    ON watches(session_id, condition_json)
    WHERE kind='file' AND renew_ms IS NOT NULL AND state IN ('accepted','observing')`);
  db.exec(`CREATE INDEX IF NOT EXISTS standing_armed_watches ON watches(session_id,watch_id)
    WHERE state IN ('accepted','observing')`);
  // Every request-liveness check, handoff inventory and five-second watch poll filtered the whole
  // table: on 2026-11-04 the owner re-read all 2,160 watches about ten times a second during a
  // busy burst. Each index carries the exact condition its queries use, so Bun's SQLite takes it.
  db.exec(`CREATE INDEX IF NOT EXISTS watches_session_live ON watches(session_id)
    WHERE state IN ('accepted','observing') OR delivery_state='pending'`);
  db.exec(`CREATE INDEX IF NOT EXISTS watches_open ON watches(state) WHERE state IN ('accepted','observing')`);
  db.exec(`CREATE INDEX IF NOT EXISTS watches_delivery_due ON watches(terminal_at_ms) WHERE delivery_state='pending'`);
  db.exec(`CREATE INDEX IF NOT EXISTS watches_host_active ON watches(host_state) WHERE host_state IN ('intended','live','stopping')`);
}

export type WatchRow = {
  watch_id: string; session_id: number; origin_input_id: string; origin_run_id: string; action_id: string; request_hash: string;
  kind: "file" | "command"; condition_json: string; baseline_json: string; baseline_mode: string; deadline_ms: number;
  state: "accepted" | "observing" | "fired" | "expired" | "failed" | "cancelled"; last_observed_ms: number | null; gaps_json: string;
  terminal_event: string | null; terminal_at_ms: number | null; observation_json: string | null; message_text: string | null;
  delivery_state: "pending" | "accepted" | null; delivery_input_id: string | null; delivery_attempts: number; delivery_next_ms: number | null;
  host_execution_id: string | null; host_directory: string | null; host_unit: string | null; host_script: string | null;
  host_protocol: number | null; host_state: "intended" | "live" | "stopping" | "released" | "gone" | null; host_stop_at_ms: number | null;
  host_killed: number; host_pruned: number; renew_ms: number | null; series_id: string | null; runner?: string | null; created_at_ms: number;
};
type Gap = { fromMs: number; toMs: number };
const gapsOf = (row: WatchRow): Gap[] => JSON.parse(row.gaps_json);
const isOpen = (row: WatchRow) => row.state === "accepted" || row.state === "observing";
const iso = (ms: number) => new Date(ms).toISOString();

// File and directory versions live in path-version.ts, which a runner runs too.
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

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

export type WatchRegistration = { sessionId: number; originInputId: string; originRunId: string; actionId: string; until: string; renew?: boolean;
  /** The runner the registering agent runs on: its path or command is on that machine, not this one. */
  runner?: string | null }
  & ({ kind: "file"; path: string; requiredCommit?: string } | { kind: "command"; argv: string[]; cwd: string });

const RELEASE_LINK = "/var/lib/slack-concierge-deployment/current";
const RELEASE_REPO = "/var/lib/slack-concierge-deployment/source";
type FileCondition = { path: string; requiredCommit?: string };

/** A scoped release is ready only after its installed commit has a successful deployment receipt. */
async function installedReleaseIncludes(commit: string): Promise<"included" | "excluded" | "unconfirmed"> {
  try {
    return await releaseIncludesCommit({ requiredCommit: commit, manifestPath: `${RELEASE_LINK}/manifest.json`,
      repositoryRoot: process.env.CONCIERGE_REPO || RELEASE_REPO,
      succeeded: (installed, artifact) => !!db.query(`SELECT 1 FROM deployment_releases release
        JOIN deployment_runs run ON run.id=release.run_id
        WHERE release.artifact_digest=? AND release.git_commit=? AND release.state='lkg'
          AND run.status='succeeded' AND run.deployed_commit=? LIMIT 1`).get(artifact, installed, installed) });
  } catch (error) {
    log("warn", "scoped_release_unconfirmed", errorFields(error));
    return "unconfirmed";
  }
}

export function watchView(row: WatchRow) {
  const condition = JSON.parse(row.condition_json);
  const observation = isOpen(row) ? observationForWatch(row) :
    { lastObservedAt: row.last_observed_ms ?? row.created_at_ms, gapsJson: row.gaps_json };
  return {
    id: row.watch_id, kind: row.kind, condition,
    state: isOpen(row) && observation.lastObservedAt > row.created_at_ms ? 'observing' : row.state,
    baseline: { mode: row.baseline_mode, ...(row.kind === "file" ? { description: describeBaseline(JSON.parse(row.baseline_json)) } : {}) },
    registeredAt: iso(row.created_at_ms), deadline: iso(row.deadline_ms),
    lastObservedAt: observation.lastObservedAt ? iso(observation.lastObservedAt) : null,
    renewEveryMs: row.renew_ms, seriesId: row.series_id,
    ...(row.kind === "command" && row.host_execution_id && isOpen(row) && !row.runner
      ? { processorSeconds: hostProcessorSeconds(row.host_execution_id) } : {}),
    gaps: (JSON.parse(observation.gapsJson) as Gap[]).map(gap => ({ from: iso(gap.fromMs), to: iso(gap.toMs) })),
    terminalEvent: row.terminal_event, endedAt: row.terminal_at_ms ? iso(row.terminal_at_ms) : null,
    delivery: row.delivery_state, deliveredAs: row.delivery_input_id,
  };
}

/** This session, the Claude session it continues after usage ran out, and every continuation of either. */
function recoveryLineage(sessionId: number): number[] {
  const rows = db.query(`SELECT source_session_id AS id FROM provider_recovery_sessions WHERE successor_session_id=?
    UNION SELECT successor_session_id FROM provider_recovery_sessions WHERE source_session_id IN
      (SELECT ? UNION SELECT source_session_id FROM provider_recovery_sessions WHERE successor_session_id=?)`)
    .all(sessionId, sessionId, sessionId) as { id: number }[];
  return [...new Set([sessionId, ...rows.map(row => row.id)])];
}

/** Idempotent by (origin input, action id): a retry returns the first registration and never makes a second. */
export async function registerWatch(input: WatchRegistration, now = Date.now()): Promise<{ watch: ReturnType<typeof watchView>; duplicate: boolean; takenOverFrom?: string }> {
  if (!input.actionId || input.actionId.length > 200) throw new Error("A stable action id is required.");
  if (input.kind === "file" && input.requiredCommit !== undefined) {
    if (input.path !== RELEASE_LINK || !input.renew || input.runner || process.env.CONCIERGE_PEER_NAME === "mac")
      throw new Error("--required-commit needs a renewing watch on this server's Concierge current-release link.");
    if (!/^[0-9a-f]{40}$/.test(input.requiredCommit)) throw new Error("--required-commit needs a full lowercase Git commit SHA.");
  }
  const condition = input.kind === "file" ? { path: input.path, ...(input.requiredCommit !== undefined ? { requiredCommit: input.requiredCommit } : {}) }
    : { argv: input.argv, cwd: input.cwd };
  if (input.renew && input.kind !== "file") throw new Error("Only file watches can renew.");
  if (input.renew && !/^(?:(?:\d+)d)?(?:(?:\d+)h)?(?:(?:\d+)m)?(?:(?:\d+)s)?$/.test(input.until.trim()))
    throw new Error("A renewing watch needs a duration, not an absolute deadline.");
  const requestHash = sha256(JSON.stringify({ kind: input.kind, condition, until: input.until.trim(), renew: !!input.renew }));
  const prior = db.query("SELECT * FROM watches WHERE origin_input_id=? AND action_id=?").get(input.originInputId, input.actionId) as WatchRow | null;
  if (prior) {
    if (prior.request_hash !== requestHash || prior.session_id !== input.sessionId) throw new Error("Idempotency conflict: this action id already registered a different watch.");
    return { watch: watchView(prior), duplicate: true };
  }
  const deadline = parseUntil(input.until, now);
  const renewMs = input.renew ? deadline - now : null;
  if (renewMs !== null) {
    // A Claude session and the Codex sessions that continue its work after its allowance ran out
    // keep one renewing series per file between them: the one registering takes the series over,
    // so its wakes reach the session now doing the work, and cancel, listing and request waits
    // still see one owning session. A second series on the same path woke both for one change
    // (the email-reader batch reviewed twice into one checkout, 2026-11-03).
    const lineage = recoveryLineage(input.sessionId);
    const active = db.query(`SELECT * FROM watches WHERE session_id IN (${lineage.map(() => "?").join(",")}) AND kind='file'
      AND condition_json=? AND renew_ms IS NOT NULL AND state IN ('accepted','observing')
      ORDER BY session_id=? DESC, created_at_ms LIMIT 1`).get(...lineage, JSON.stringify(condition), input.sessionId) as WatchRow | null;
    if (active && active.session_id !== input.sessionId) {
      db.query("UPDATE watches SET session_id=? WHERE watch_id=? AND state IN ('accepted','observing')").run(input.sessionId, active.watch_id);
      log("info", "watch_series_taken_over", { watch_id: active.watch_id, from_session_id: active.session_id, to_session_id: input.sessionId });
      return { watch: watchView({ ...active, session_id: input.sessionId }), duplicate: true, takenOverFrom: `concierge:${active.session_id}` };
    }
    if (active) return { watch: watchView(active), duplicate: true };
  }
  const runner = input.runner?.trim() || null;
  if (runner && !/^[A-Za-z0-9._-]{1,64}$/.test(runner)) throw new Error("That runner name is not valid.");
  const machine = machineFor({ runner });
  let baseline: unknown, mode: string;
  if (input.kind === "file") {
    if (!input.path.startsWith("/")) throw new Error("A watched path must be absolute.");
    const version = await machine.observe(input.path);
    if (version.type === "directory" && version.digest?.startsWith("too-many:"))
      throw new Error(`That directory has more than ${MAX_DIRECTORY_ENTRIES} entries; watch a narrower one.`);
    baseline = version; mode = version.mode;
  } else {
    if (!input.argv.length || input.argv.length > 256 || input.argv.some(item => typeof item !== "string") || input.argv.join("").length > 65_536)
      throw new Error("A command watch needs an explicit argument list (at most 256 arguments).");
    if (!input.argv[0]!.includes("/")) throw new Error("The command must be a path; the helper resolves a bare name before sending it.");
    if (!input.cwd.startsWith("/") || !await machine.isDirectory(input.cwd)) throw new Error("--cwd must be an existing absolute directory.");
    if (!runner && !executionHostsEnabled()) throw new Error("This machine cannot run a command apart from Concierge, so it cannot watch one.");
    baseline = { notStarted: true }; mode = "launch-record";
  }
  // A retry may have registered while this one read the baseline on the runner.
  const raced = db.query("SELECT * FROM watches WHERE origin_input_id=? AND action_id=?").get(input.originInputId, input.actionId) as WatchRow | null;
  if (raced) {
    if (raced.request_hash !== requestHash || raced.session_id !== input.sessionId) throw new Error("Idempotency conflict: this action id already registered a different watch.");
    return { watch: watchView(raced), duplicate: true };
  }
  const watchId = randomBytes(6).toString("hex");
  // The baseline is part of the same row as the registration, so it exists before the caller hears yes.
  try {
    db.query(`INSERT INTO watches (watch_id, session_id, origin_input_id, origin_run_id, action_id, request_hash, kind, condition_json,
        baseline_json, baseline_mode, deadline_ms, state, last_observed_ms, renew_ms, runner, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?)`)
      .run(watchId, input.sessionId, input.originInputId, input.originRunId, input.actionId, requestHash, input.kind, JSON.stringify(condition),
        JSON.stringify(baseline), mode, deadline, now, renewMs, runner, now);
  } catch (error) {
    // Another renewing registration of this path won while this one read the baseline on a runner.
    const winner = renewMs !== null ? db.query(`SELECT * FROM watches WHERE session_id=? AND kind='file' AND condition_json=?
      AND renew_ms IS NOT NULL AND state IN ('accepted','observing')`).get(input.sessionId, JSON.stringify(condition)) as WatchRow | null : null;
    if (winner) return { watch: watchView(winner), duplicate: true };
    throw error;
  }
  wakeWatchWorker();
  return { watch: watchView(db.query("SELECT * FROM watches WHERE watch_id=?").get(watchId) as WatchRow), duplicate: false };
}

/** A session's own watches, newest first. */
export function listWatches(sessionId: number) {
  return (db.query("SELECT * FROM watches WHERE session_id=? ORDER BY created_at_ms DESC, rowid DESC LIMIT 50").all(sessionId) as WatchRow[]).map(watchView);
}

/** Only the registering session may cancel; a watch already over is returned as it ended. */
export function cancelWatch(sessionId: number, watchId: string, now = Date.now()) {
  let row = db.query("SELECT * FROM watches WHERE watch_id=?").get(watchId) as WatchRow | null;
  if (!row || row.session_id !== sessionId) throw new Error("No such watch for this session.");
  if (!isOpen(row) && (row.series_id || row.renew_ms !== null)) {
    const successor = db.query(`SELECT * FROM watches WHERE session_id=? AND series_id=? AND state IN ('accepted','observing')`)
      .get(sessionId, row.series_id ?? row.watch_id) as WatchRow | null;
    if (successor) row = successor;
  }
  if (isOpen(row)) settle(row.watch_id, "cancelled", { observedAt: null, now, detail: "You cancelled it." });
  wakeWatchWorker();
  return watchView(db.query("SELECT * FROM watches WHERE watch_id=?").get(row.watch_id) as WatchRow);
}

// ---- settling and the words ---------------------------------------------------------------------

type Settlement = { observedAt: number | null; now: number; detail: string; observed?: unknown };

function gapsText(gaps: Gap[], row: WatchRow, endedAt: number) {
  if (!gaps.length) return `Observation gaps: none. Concierge polled every ${WATCH_POLL_MS / 1000} s from ${iso(row.created_at_ms)} to ${iso(endedAt)} with no silence longer than ${WATCH_GAP_MS / 1000} s.`;
  const list = gaps.map(gap => `${iso(gap.fromMs)} to ${iso(gap.toMs)} (${Math.round((gap.toMs - gap.fromMs) / 1000)} s)`).join("; ");
  // A started command lives in its own execution host, which a Concierge restart does not stop, and
  // its exit is read from the host afterwards; a gap only delays reading it. Saying a change could
  // have been missed sent the canvas reviewers (2026-11-05, 22 gaps from releases) looking for a loss.
  if (row.kind === "command" && row.host_state === "live") {
    return `Concierge was not polling ${gaps.length} time${gaps.length === 1 ? "" : "s"}: ${list}, most likely while it restarted. The command kept running in its own process through each of these, and its exit and output are kept by its host, so nothing the command reported was lost; a gap only delays when Concierge reads the result. Calls the command itself made to Concierge during a gap would have failed, and handling that is up to the command.`;
  }
  return `Observation gaps: ${gaps.length}. Coverage cannot be proven during ${list}; Concierge may have been restarting, the machine may have been asleep or unreachable, or an observation could not be recorded. A change that was made and undone inside a gap cannot be known; what is stated here is what was found when observation resumed.`;
}

/**
 * A waiter's processor use in words, so the session that wrote it sees what its waiting cost. It
 * runs at the lowest priority, so this is time nothing else wanted, but a waiter that polls
 * expensively (the 2026-11-03 journal re-read) shows up here instead of only in host alerts.
 */
function processorText(seconds: number, fromMs: number, toMs: number) {
  const share = toMs > fromMs ? (seconds * 1000) / (toMs - fromMs) : 0;
  return `The command and its host used ${seconds < 120 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60)} min`} of processor time (${(share * 100).toFixed(share < 0.01 ? 2 : 1)}% of one core since registration).`;
}

/**
 * Ends a watch in one terminal event. The state change, the event, its observation and the words
 * for the session are one transaction, so a deadline and a change that race produce exactly one
 * event, and the event exists before anything is delivered.
 */
/**
 * Whether requests waited on this renewing series and every one of them has since closed. Such a
 * series was registered for those requests (the request protocol has a worker watch the release
 * link and name it with --waiting-on-watch), so renewing it after they close only wakes a session
 * whose work is over: on 2026-11-04 four finished requests' release watches renewed at every
 * Concierge release. A series no request ever named is a standing condition and is left alone.
 */
function everyWaitingRequestClosed(row: WatchRow): boolean {
  const series = (db.query("SELECT watch_id FROM watches WHERE coalesce(series_id,watch_id)=?").all(row.series_id ?? row.watch_id) as { watch_id: string }[])
    .map(watch => watch.watch_id);
  const marks = series.map(() => "?").join(",");
  const waits = db.query(`
    SELECT request.outcome IS NULL AS open FROM session_communication_events reply
      JOIN session_communication_requests request ON request.request_id=reply.request_id
      WHERE reply.kind='progress' AND json_extract(reply.payload_json,'$.waitingOnWatch') IN (${marks})
    UNION ALL
    SELECT request.closed_at_ms IS NULL AS open FROM session_peer_replies reply
      JOIN session_peer_deliveries request ON request.request_id=reply.request_id
      WHERE reply.kind='progress' AND json_extract(reply.payload_json,'$.waitingOnWatch') IN (${marks})
    UNION ALL
    SELECT request.outcome IS NULL AS open FROM session_external_replies reply
      JOIN session_external_requests request ON request.request_id=reply.request_id
      WHERE reply.final=0 AND json_extract(reply.payload_json,'$.waitingOnWatch') IN (${marks})`)
    .all(...series, ...series, ...series) as { open: number }[];
  return waits.length > 0 && waits.every(wait => !wait.open);
}

function settle(watchId: string, event: "fired" | "expired" | "failed" | "cancelled", settlement: Settlement): boolean {
  const settled = db.transaction(() => {
    const row = db.query("SELECT * FROM watches WHERE watch_id=?").get(watchId) as WatchRow | null;
    if (!row || !isOpen(row)) return false;
    // Ends the series quietly in place of renewing and waking: no request is left to wake it for.
    const requestsOver = event !== "cancelled" && row.renew_ms !== null && everyWaitingRequestClosed(row);
    if (requestsOver) {
      settlement = { ...settlement, detail: `every request that waited on it has closed, so it ended instead of renewing and woke no one (it would have reported: ${settlement.detail})` };
      event = "cancelled";
    }
    const observation = observationForWatch(row);
    const gaps = JSON.parse(observation.gapsJson) as Gap[];
    const resumedAt = settlement.observedAt ?? settlement.now;
    const last = observation.lastObservedAt;
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
    const processor = row.kind === "command" && row.host_execution_id && !row.runner ? hostProcessorSeconds(row.host_execution_id) : null;
    const text = `${headline}${late} It watched ${what}, registered ${iso(row.created_at_ms)} with a deadline of ${iso(row.deadline_ms)}. ${gapsText(gaps, row, resumedAt)}${
      processor !== null ? ` ${processorText(processor, row.created_at_ms, resumedAt)}` : ""}${
      settlement.observed && typeof (settlement.observed as any).outputTail === "string" && (settlement.observed as any).outputTail
        ? `\nLast output of the command (stdout and stderr):\n${(settlement.observed as any).outputTail}` : ""}
You do not need to reply to this.`;
    const result = db.query(`UPDATE watches SET state=?, terminal_event=?, terminal_at_ms=?, observation_json=?, message_text=?, gaps_json=?,
        last_observed_ms=?, delivery_state=?, delivery_input_id=?, delivery_attempts=0, delivery_next_ms=NULL
      WHERE watch_id=? AND state IN ('accepted','observing')`)
      .run(event, event, settlement.now, JSON.stringify({ detail: settlement.detail, observedAt: settlement.observedAt ? iso(settlement.observedAt) : null, ...(settlement.observed ? { observed: settlement.observed } : {}) }),
        text, JSON.stringify(gaps), settlement.observedAt ?? last, requestsOver ? null : "pending", requestsOver ? null : `watch:${watchId}:${event}`, watchId);
    if (result.changes !== 1) return false;
    if (requestsOver) log("info", "watch_series_ended_with_requests", { watch_id: watchId, series_id: row.series_id ?? row.watch_id, session_id: row.session_id });
    if (event !== "cancelled" && row.renew_ms !== null) {
      const nextId = randomBytes(6).toString("hex");
      const baseline = settlement.observed && typeof settlement.observed === "object" && "version" in settlement.observed
        ? (settlement.observed as { version: PathVersion }).version : JSON.parse(row.baseline_json) as PathVersion;
      db.query(`INSERT INTO watches (watch_id,session_id,origin_input_id,origin_run_id,action_id,request_hash,kind,
          condition_json,baseline_json,baseline_mode,deadline_ms,state,last_observed_ms,renew_ms,series_id,runner,created_at_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'accepted',?,?,?,?,?)`)
        .run(nextId,row.session_id,row.origin_input_id,row.origin_run_id,`renew:${row.watch_id}`,row.request_hash,'file',
          row.condition_json,JSON.stringify(baseline),baseline.mode,settlement.now+row.renew_ms,settlement.now,
          row.renew_ms,row.series_id??row.watch_id,row.runner??null,settlement.now);
    }
    return true;
  })();
  if (settled) forgetWatchObservation(watchId);
  return settled;
}

// ---- the worker --------------------------------------------------------------------------------

export type WatchAdmission = {
  sessionId: number; inputId: string; origin: "service"; sourceInputId: string; sourceRunId: string; requestId: string; text: string; threadReplyNotRequired: true;
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

/** The machine a watch's path or command is on: this owner's, or its runner's through the call channel. */
let localMachine: WatchMachine | null = null;
/** This poll's reachable runners; one that stops answering mid-poll is dropped for the rest of it. */
let pollReachable: Set<string> | null = null;
function machineFor(row: { runner?: string | null }): WatchMachine {
  if (row.runner) { const runner = row.runner; return runnerWatchMachine(runner, () => pollReachable?.delete(runner)); }
  localMachine ??= localWatchMachine(process.env.CONCIERGE_STATE_DIR!, () => providerOwnerEnvironment().CONCIERGE_ROUTER_BOT_DIR!);
  return localMachine;
}

function update(watchId: string, set: string, ...params: unknown[]) {
  db.query(`UPDATE watches SET ${set} WHERE watch_id=?`).run(...params, watchId);
}

function describeExit(exit: { code: number | null; signal: string | null }) {
  return exit.signal ? `the command ended on signal ${exit.signal}` : `the command exited with code ${exit.code}`;
}

async function observeFile(row: WatchRow, now: number) {
  const condition = JSON.parse(row.condition_json) as FileCondition;
  const baseline = JSON.parse(row.baseline_json) as PathVersion;
  let current: PathVersion;
  try { current = await machineFor(row).observe(condition.path); }
  catch (error) {
    // Unreadable now: nothing was observed, so the silence is recorded as a gap when observation resumes.
    log("warn", "watch_unreadable", { watch_id: row.watch_id, ...errorFields(error) });
    if (condition.requiredCommit) {
      if (everyWaitingRequestClosed(row)) settle(row.watch_id, "cancelled", { observedAt: null, now, detail: "every request that waited on it has closed" });
      else if (now >= row.deadline_ms) update(row.watch_id, "deadline_ms=?", now + row.renew_ms!);
      return;
    }
    if (now >= row.deadline_ms) settle(row.watch_id, "expired", { observedAt: null, now, detail: "no change was observed, but the path could not be read at the end" });
    return;
  }
  const change = versionChange(baseline, current);
  if (condition.requiredCommit) {
    if (everyWaitingRequestClosed(row)) {
      settle(row.watch_id, "cancelled", { observedAt: now, now, detail: "every request that waited on it has closed" });
      return;
    }
    // Also check the registration baseline once: the repair may already be installed before
    // the caller binds this watch to its request. Later polls read Git only after a link swap.
    if (change || row.state === "accepted") {
      const match = await installedReleaseIncludes(condition.requiredCommit);
      if (match === "included") {
        settle(row.watch_id, "fired", { observedAt: now, now,
          detail: `installed release includes commit ${condition.requiredCommit}`, observed: { version: current } });
        return;
      }
      // An incomplete activation is retried against the same baseline. An unrelated installed
      // release becomes the new baseline without producing a turn or a new watch ID.
      if (match === "excluded" && change) update(row.watch_id, "baseline_json=?, baseline_mode=?", JSON.stringify(current), current.mode);
      if (match === "unconfirmed") {
        if (now >= row.deadline_ms) update(row.watch_id, "deadline_ms=?", now + row.renew_ms!);
        await markObserved(row, now);
        return;
      }
    }
    // A scoped dependency's duration is a storage lease, not a reason to spend an agent turn.
    if (now >= row.deadline_ms) update(row.watch_id, "deadline_ms=?", now + row.renew_ms!);
    if (row.state === "accepted") update(row.watch_id, "state='observing'");
    await markObserved(row, now);
    return;
  }
  if (change) { settle(row.watch_id, "fired", { observedAt: now, now, detail: `${condition.path}: ${change}`, observed: { version: current } }); return; }
  if (now >= row.deadline_ms) { settle(row.watch_id, "expired", { observedAt: now, now, detail: `no change to ${condition.path} was observed (still ${describeBaseline(baseline)})` }); return; }
  await markObserved(row, now);
}

function markObserved(row: WatchRow, now: number) {
  return recordWatchObservation(row, now, WATCH_GAP_MS);
}

async function launchCommand(row: WatchRow, deps: WatchWorkerDeps, now: number) {
  const condition = JSON.parse(row.condition_json) as { argv: string[]; cwd: string };
  const machine = machineFor(row);
  if (now >= row.deadline_ms) { settle(row.watch_id, "expired", { observedAt: null, now, detail: "its deadline passed before the command could be started, so it was never started" }); return; }
  if (!await machine.isDirectory(condition.cwd)) { settle(row.watch_id, "failed", { observedAt: now, now, detail: `the working directory ${condition.cwd} no longer exists, so the command was not started` }); return; }
  const executionId = newExecutionId();
  const record = await machine.hostRecord(executionId);
  // The intent is recorded before the supervisor is asked, so a crash in between leaves evidence.
  update(row.watch_id, "host_execution_id=?, host_directory=?, host_unit=?, host_protocol=?, host_state='intended'",
    executionId, record.directory, record.unit, record.protocol);
  let launch: Awaited<ReturnType<WatchMachine["launch"]>>;
  try { launch = await machine.launch({ executionId, argv: condition.argv, cwd: condition.cwd, environment: ordinaryCommandEnvironment() }); }
  catch (error) { log("warn", "watch_command_start_unconfirmed", { watch_id: row.watch_id, runner: row.runner ?? null, ...errorFields(error) }); return; }
  if ("notStarted" in launch) {
    update(row.watch_id, "host_state='gone'");
    settle(row.watch_id, "failed", { observedAt: now, now, detail: `the command could not be started: ${launch.notStarted}` });
    return;
  }
  update(row.watch_id, "host_script=?, host_state='live'", launch.hostScript);
  log("info", "watch_command_started", { watch_id: row.watch_id, execution_id: executionId, runner: row.runner ?? null });
  await markObserved(row, now);
}

/** What the host says about the command; a machine that cannot be reached is not knowing, this poll. */
async function commandState(row: WatchRow): ReturnType<WatchMachine["commandState"]> {
  try { return await machineFor(row).commandState(row.host_execution_id!, row.host_directory!); }
  catch (error) { log("warn", "watch_command_state_unread", { watch_id: row.watch_id, runner: row.runner ?? null, ...errorFields(error) }); return { state: "unknown" }; }
}

async function observeCommand(row: WatchRow, deps: WatchWorkerDeps, now: number) {
  if (!row.host_execution_id) { await launchCommand(row, deps, now); return; }
  if (row.host_state === "intended") {
    // A coordinator died between recording the intent and learning the result.
    const outcome = await machineFor(row).startOutcome(row.host_execution_id, row.host_directory!).catch(() => "unknown" as const);
    if (outcome === "never-ran" && row.runner && now < row.deadline_ms) {
      // The call that started it went unanswered (a slow runner or a dropped channel), and the runner,
      // which knows its own starts in flight, says it never started: start it afresh.
      update(row.watch_id, "host_execution_id=NULL, host_directory=NULL, host_unit=NULL, host_protocol=NULL, host_state=NULL");
      log("warn", "watch_command_restarted_after_unanswered_start", { watch_id: row.watch_id, runner: row.runner, execution_id: row.host_execution_id });
      return;
    }
    if (outcome === "never-ran") {
      update(row.watch_id, "host_state='gone'");
      settle(row.watch_id, "failed", { observedAt: now, now, detail: "Concierge restarted while starting the command, and no trace of it was found; it did not run" });
      return;
    } else if (outcome === "unknown") return;
    else update(row.watch_id, "host_state='live'");
  }
  const state = await commandState(row);
  if (state.state === "exited") {
    let tail: string;
    try { tail = await machineFor(row).outputTail(row.host_directory!); }
    catch (error) { log("warn", "watch_output_unread", { watch_id: row.watch_id, runner: row.runner ?? null, ...errorFields(error) }); return; }
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
  await markObserved(row, now);
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
    if (await machineFor(row).release(row.host_execution_id, row.host_directory!)) {
      update(row.watch_id, "host_state='released'");
      // launchd keeps a finished job loaded; it is removed once it reports stopped.
      setTimeout(() => { void machineFor(row).retire(row.host_execution_id!).catch(error =>
        log("warn", "watch_host_retire_failed", { watch_id: row.watch_id, error: String(error) })); }, 10_000).unref?.();
    }
  } else if (state.state === "lost") update(row.watch_id, "host_state='gone'");
}

async function signalHost(row: WatchRow, signal: "SIGTERM" | "SIGKILL") {
  try { await machineFor(row).signal(row.host_execution_id!, row.host_directory!, signal, `watch-${signal}-${row.watch_id}`); }
  catch (error) { log("warn", "watch_command_signal_failed", { watch_id: row.watch_id, signal, runner: row.runner ?? null, ...errorFields(error) }); }
}

function deliverPending(deps: WatchWorkerDeps, now: number) {
  const due = db.query("SELECT * FROM watches WHERE delivery_state='pending' AND (delivery_next_ms IS NULL OR delivery_next_ms<=?) ORDER BY terminal_at_ms LIMIT 20").all(now) as WatchRow[];
  for (const row of due) {
    try {
      const session=getSessionById(row.session_id);
      const root=session&&sessionMetadata(session).inbox?inboxThreadRoot(row.session_id,row.origin_input_id):null;
      if(row.terminal_event!=='fired'&&root&&db.query('SELECT 1 FROM inbox_topic_roots WHERE root_input_id=?').get(root)){
        postForwardedThreadAnswer({inboxSessionId:row.session_id,eventId:row.delivery_input_id!,requestId:`watch:${row.watch_id}`,
          root,inboxInputId:root,respondingSessionId:`concierge:${row.session_id}`,text:row.message_text!,attachments:[],
          stalled:true,final:true,workDisposition:null});
        update(row.watch_id,"delivery_state='accepted', delivery_next_ms=NULL");
        log('info','watch_posted_to_thread',{watch_id:row.watch_id,event:row.terminal_event,thread:root});
        continue;
      }
      // Admission is idempotent on this input id and the words are fixed in the row, so a retry
      // after a lost answer reaches the same input. A paused or archived session holds it.
      const admissionStarted = performance.now();
      deps.admit({ sessionId: row.session_id, inputId: row.delivery_input_id!, origin: "service", sourceInputId: row.origin_input_id,
        sourceRunId: row.origin_run_id, requestId: row.delivery_input_id!, text: row.message_text!, threadReplyNotRequired: true });
      const admissionMs = performance.now() - admissionStarted;
      update(row.watch_id, "delivery_state='accepted', delivery_next_ms=NULL");
      log("info", "watch_delivered", { watch_id: row.watch_id, event: row.terminal_event, admission_ms: Math.round(admissionMs) });
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

async function pruneRecords(now: number) {
  const old = db.query(`SELECT * FROM watches WHERE host_directory IS NOT NULL AND host_pruned=0 AND host_state IN ('released','gone')
    AND terminal_at_ms<?`).all(now - RECORD_RETENTION_MS) as WatchRow[];
  for (const row of old) {
    try { await machineFor(row).prune(row.host_directory!); update(row.watch_id, "host_pruned=1"); }
    catch (error) { log("warn", "watch_record_prune_failed", { watch_id: row.watch_id, ...errorFields(error) }); }
  }
}

const endedCommands = () => db.query("SELECT * FROM watches WHERE kind='command' AND state NOT IN ('accepted','observing') AND host_state IN ('intended','live','stopping')").all() as WatchRow[];

/** The runners among these that answer a short check now, each asked once per poll, together. */
async function reachableRunners(names: (string | null | undefined)[]): Promise<Set<string>> {
  const runners = [...new Set(names.filter((name): name is string => !!name))];
  const answers = await Promise.all(runners.map(runner => runnerMachineCall(runner, "ping", {}, 3_000).then(() => runner, () => null)));
  for (const runner of runners) if (!answers.includes(runner)) log("warn", "watch_runner_unreachable", { runner });
  return new Set(answers.filter((name): name is string => !!name));
}

/** One poll. `now` is a parameter so a pause can be simulated exactly. */
export async function runWatchTick(deps: WatchWorkerDeps, now = Date.now()) {
  const pause=globalPauseState();
  const open = db.query(`SELECT * FROM watches WHERE state IN ('accepted','observing')
    AND (?=0 OR EXISTS (SELECT 1 FROM global_pause_exceptions allowed WHERE allowed.generation=?
      AND allowed.machine=? AND allowed.session_id=watches.session_id)) ORDER BY created_at_ms`)
    .all(pause.paused?1:0,pause.generation,process.env.CONCIERGE_PEER_NAME==='mac'?'mac':'cloud') as WatchRow[];
  const started = performance.now();
  deliverPending(deps, now);
  const reachable = pollReachable = await reachableRunners([...open.map(row => row.runner), ...endedCommands().map(row => row.runner)]);
  const pingMs = performance.now() - started;
  let slowest: { row: WatchRow; ms: number } | null = null;
  for (const row of open) {
    const watchStarted = performance.now();
    // An unreachable runner's watches are not observed this poll; the silence becomes a recorded gap.
    if (row.runner && !reachable.has(row.runner)) {
      if (now >= row.deadline_ms) settle(row.watch_id, "expired", { observedAt: null, now, detail:
        row.kind === "file" ? `no change was observed, but runner ${row.runner} could not be reached at the end`
          : row.host_execution_id ? `the command's state could not be read at the deadline: runner ${row.runner} could not be reached`
            : "its deadline passed before the command could be started, so it was never started" });
      continue;
    }
    try {
      if (row.kind === "file") await observeFile(row, now);
      else await observeCommand(row, deps, now);
    } catch (error) { log("error", "watch_poll_failed", { watch_id: row.watch_id, ...errorFields(error) }); }
    const ms = performance.now() - watchStarted;
    if (!slowest || ms > slowest.ms) slowest = { row, ms };
  }
  for (const row of endedCommands()) {
    if (row.runner && !reachable.has(row.runner)) continue;
    try { await cleanUpHost(row, now); } catch (error) { log("warn", "watch_host_cleanup_failed", { watch_id: row.watch_id, ...errorFields(error) }); }
  }
  deliverPending(deps, now);
  // A poll longer than the gap threshold is itself a recorded gap; this names what it waited on.
  const durationMs = performance.now() - started;
  if (durationMs > WATCH_GAP_MS) log("warn", "watch_poll_slow", { duration_ms: Math.round(durationMs), open_watches: open.length,
    ping_ms: Math.round(pingMs), slowest_watch_id: slowest?.row.watch_id ?? null, slowest_kind: slowest?.row.kind ?? null,
    slowest_runner: slowest?.row.runner ?? null, slowest_ms: slowest ? Math.round(slowest.ms) : null });
}

/** Starts this machine's one watch worker; returns its stop function. */
export function startWatchWorker(deps: WatchWorkerDeps): () => void {
  localMachine = localWatchMachine(deps.stateDir, deps.routerBotDir);
  const openWatchIds = db.query("SELECT watch_id FROM watches WHERE state IN ('accepted','observing')")
    .all() as { watch_id: string }[];
  loadWatchObservationCursors(openWatchIds.map(row => row.watch_id));
  startWatchObservationWorker();
  // A restart retries any delivery that had run out of attempts.
  db.query("UPDATE watches SET delivery_attempts=0, delivery_next_ms=NULL WHERE delivery_state='pending'").run();
  void pruneRecords(Date.now());
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
  void waitForWatchObservationWorker().then(() => poll()).catch(error =>
    log('warn', 'watch_observation_worker_unavailable', errorFields(error)));
  arm();
  return () => { stopped = true; if (timer) clearTimeout(timer); wakeRequested = null; stopWatchObservationWorker(); };
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
