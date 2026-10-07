/**
 * Which host holds which execution: the ledger's side of hosted provider processes
 * (design docs/plans/2026-10-07-agent-work-and-updates-without-waiting.md §1.3, §3.1 step 4;
 * protocol docs/architecture/EXECUTION-HOST.md). The host's journal holds what the provider said;
 * this table holds custody and what a later coordinator needs to take the run back.
 * `turns.owner_instance_id` stays the coordinator's claim on the turn and nothing else.
 */
import { rmSync } from "node:fs";
import { db, executionChanged, queuedTurnClaimRow, type QueuedTurnClaimRow } from "./state";
import { log, errorFields } from "./log";
import { ADOPTABLE_HOST_PROTOCOLS, HOST_PROTOCOL_VERSION, executionUnit, hostCustody, hostScriptDigest, hostSupervisorView, releaseHost, type HostLaunch } from "./execution-host-client";

db.exec(`
CREATE TABLE IF NOT EXISTS executions (
  execution_id            TEXT PRIMARY KEY,
  turn_id                 INTEGER NOT NULL REFERENCES turns(id),
  dispatch_attempt        INTEGER NOT NULL,
  session_id              INTEGER NOT NULL,
  provider                TEXT NOT NULL,
  host_protocol           INTEGER NOT NULL,
  supervisor              TEXT NOT NULL,
  directory               TEXT NOT NULL,
  unit                    TEXT,
  host_script             TEXT,
  runtime                 TEXT,
  manifest_digest         TEXT,
  processor_json          TEXT NOT NULL,
  state                   TEXT NOT NULL CHECK (state IN ('intended', 'live', 'exited', 'released', 'lost')),
  coordinator_instance_id TEXT,
  adoptions               INTEGER NOT NULL DEFAULT 0,
  exit_code               INTEGER,
  exit_signal             TEXT,
  detail                  TEXT,
  created_at_ms           INTEGER NOT NULL,
  updated_at_ms           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS executions_open ON executions(turn_id) WHERE state IN ('intended', 'live', 'exited');
`);
// Set only when a later coordinator took the run over while its provider was still running: the
// evidence that this kind of run survives a restart (execution-survival.ts). A run settled from
// a finished record, or one merely claimed, proves nothing about survival.
if (!(db.query("SELECT 1 FROM pragma_table_info('executions') WHERE name='adopted_live'").get()))
  db.exec("ALTER TABLE executions ADD COLUMN adopted_live INTEGER NOT NULL DEFAULT 0");
// The host program's content digest at launch; "on the previous version" compares this, never the
// release folder, so an update that did not change the host leaves no run on a previous version.
if (!(db.query("SELECT 1 FROM pragma_table_info('executions') WHERE name='host_digest'").get()))
  db.exec("ALTER TABLE executions ADD COLUMN host_digest TEXT");

/** This coordinator took the run over while its provider was still running. */
export function recordLiveAdoption(executionId: string) {
  db.query("UPDATE executions SET adopted_live=1, updated_at_ms=? WHERE execution_id=?").run(Date.now(), executionId);
}

export type ExecutionRow = {
  execution_id: string; turn_id: number; dispatch_attempt: number; session_id: number; provider: string;
  host_protocol: number; supervisor: string; directory: string; unit: string | null; host_script: string | null;
  runtime: string | null; manifest_digest: string | null; processor_json: string; state: string;
  coordinator_instance_id: string | null; adoptions: number; exit_code: number | null; exit_signal: string | null;
  detail: string | null; created_at_ms: number; updated_at_ms: number;
};

/** Recorded before the host is started, so a coordinator that dies mid-launch leaves evidence, never a second launch. */
export function retainExecutionIntent(input: { executionId: string; turnId: number; dispatchAttempt: number; sessionId: number;
  provider: string; directory: string; processor: unknown; coordinatorInstanceId: string;
  /** `codex-daemon`: the provider's own daemon holds the turn, so there is no host; it is live at once. */
  supervisor?: "codex-daemon" }) {
  const now = Date.now();
  db.query(`INSERT INTO executions (execution_id, turn_id, dispatch_attempt, session_id, provider, host_protocol, supervisor,
      directory, processor_json, state, coordinator_instance_id, created_at_ms, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(input.executionId, input.turnId, input.dispatchAttempt, input.sessionId, input.provider, HOST_PROTOCOL_VERSION,
      input.supervisor ?? (process.platform === "darwin" ? "launchd" : "systemd"), input.directory, JSON.stringify(input.processor),
      input.supervisor ? "live" : "intended", input.coordinatorInstanceId, now, now);
  executionChanged();
}

export function recordExecutionLaunched(executionId: string, launch: HostLaunch) {
  db.query(`UPDATE executions SET unit=?, host_script=?, host_digest=?, runtime=?, manifest_digest=?, state='live', updated_at_ms=?
    WHERE execution_id=? AND state='intended'`)
    .run(launch.unit, launch.hostScript, hostScriptDigest(launch.hostScript), launch.runtime, launch.manifestDigest, Date.now(), executionId);
  // A run that now has independent custody no longer ends with this coordinator: a shutdown waiting
  // on it re-evaluates (index.ts observes execution changes).
  executionChanged();
}

export function recordExecutionExited(executionId: string, exit: { code: number | null; signal: string | null }) {
  db.query(`UPDATE executions SET state='exited', exit_code=?, exit_signal=?, updated_at_ms=?
    WHERE execution_id=? AND state IN ('intended','live')`).run(exit.code, exit.signal, Date.now(), executionId);
  executionChanged();
}

export function recordExecutionReleased(executionId: string) {
  db.query("UPDATE executions SET state='released', updated_at_ms=? WHERE execution_id=? AND state<>'released'").run(Date.now(), executionId);
}

export function recordExecutionLost(executionId: string, detail: string) {
  db.query(`UPDATE executions SET state='lost', detail=?, updated_at_ms=? WHERE execution_id=? AND state IN ('intended','live')`)
    .run(detail, Date.now(), executionId);
  executionChanged();
}

/** The live hosted execution of a turn this coordinator owns, if it has one. */
export function liveExecutionOfTurn(turnId: number): ExecutionRow | null {
  return db.query(`SELECT * FROM executions WHERE turn_id=? AND state IN ('intended','live') ORDER BY created_at_ms DESC LIMIT 1`)
    .get(turnId) as ExecutionRow | null;
}

/** Turns among `turnIds` whose provider process lives in a host and so survives this coordinator. */
export function hostedTurns(turnIds: Iterable<number>): Set<number> {
  const hosted = new Set<number>();
  // Starting, running and exited-but-unsettled runs all outlive this coordinator: the next one
  // decides each from its host and record.
  for (const turnId of turnIds) if (db.query("SELECT 1 FROM executions WHERE turn_id=? AND state IN ('intended','live','exited')").get(turnId)) hosted.add(turnId);
  return hosted;
}

/** Release files a live execution still runs from; a release cleanup must keep them. */
export function releaseFilesInUse(): string[] {
  return (db.query("SELECT DISTINCT host_script FROM executions WHERE state IN ('intended','live','exited') AND host_script IS NOT NULL").all() as { host_script: string }[])
    .map(row => row.host_script);
}

/** Every host protocol an admitted execution still speaks; a candidate release must adopt them all. */
export function hostProtocolsInUse(): number[] {
  return (db.query("SELECT DISTINCT host_protocol FROM executions WHERE state IN ('intended','live','exited')").all() as { host_protocol: number }[])
    .map(row => row.host_protocol);
}

/** A finished execution's record (its journal is the run's raw evidence) is kept this long. */
const EXECUTION_RECORD_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Removes the folders of executions that ended more than a month ago; their ledger rows stay. */
export function pruneExecutionRecords(nowMs = Date.now()) {
  const old = db.query(`SELECT execution_id, directory FROM executions WHERE state IN ('released','lost') AND updated_at_ms < ? AND detail IS NOT 'pruned'`)
    .all(nowMs - EXECUTION_RECORD_RETENTION_MS) as { execution_id: string; directory: string }[];
  for (const row of old) {
    try { rmSync(row.directory, { recursive: true, force: true }); db.query("UPDATE executions SET detail='pruned' WHERE execution_id=?").run(row.execution_id); }
    catch (error) { log("warn", "execution_record_prune_failed", { execution_id: row.execution_id, ...errorFields(error) }); }
  }
}

/** How a run is taken back: attached to its live host, or rebuilt from the record its gone host left. */
export type Adoption = { execution: ExecutionRow; claim: QueuedTurnClaimRow; processor: any; mode: "adopt" | "adopt-record" };

type HostProbe = "answering" | "unresponsive" | "gone-with-exit" | "gone";

async function probeHost(execution: ExecutionRow): Promise<HostProbe> {
  // The Codex daemon outlives Concierge on its own; the turn is followed by its exact thread, which
  // exists once the session is bound to it. Without that binding nothing can identify the turn.
  if (execution.supervisor === "codex-daemon")
    return (db.query("SELECT agent_session_uuid FROM sessions WHERE id=?").get(execution.session_id) as { agent_session_uuid: string | null } | null)
      ?.agent_session_uuid ? "answering" : "gone";
  // The same decision a live run makes when its connection breaks (hostCustody): the unit name is
  // derived from the execution id, so a launch that crashed before recording it is still checked.
  const custody = await hostCustody(execution.directory, execution.execution_id);
  return custody === "answering" ? "answering" : custody === "held" ? "unresponsive" : custody === "settle-from-record" ? "gone-with-exit" : "gone";
}

/**
 * Taking a run back makes it this coordinator's in one transaction: same turn, run and dispatch
 * attempt (adoption is never another attempt and never clears an acknowledgement).
 */
function claimExecutionTurn(execution: ExecutionRow, previousOwner: string | null, instanceId: string) {
  return db.transaction(() => {
    const changed = db.query(`UPDATE turns SET owner_instance_id=? WHERE id=? AND status='running' AND dispatch_attempt=? AND owner_instance_id IS ?`)
      .run(instanceId, execution.turn_id, execution.dispatch_attempt, previousOwner).changes === 1;
    if (changed) db.query(`UPDATE executions SET coordinator_instance_id=?, adoptions=adoptions+1, updated_at_ms=? WHERE execution_id=?`)
      .run(instanceId, Date.now(), execution.execution_id);
    return changed;
  })();
}

export type HeldExecution = { execution: ExecutionRow; reason: "unresponsive" | "protocol" };

/**
 * At startup, before steering or turn recovery can read a running turn as orphaned. Each open
 * execution of a still-running turn whose coordinator is gone is decided by evidence:
 * - its host answers: taken back live (`adopt`);
 * - its host is gone but recorded the provider's exit: settled from that record (`adopt-record`);
 * - its host still runs but does not answer, or speaks a protocol this coordinator cannot adopt:
 *   held by this coordinator in a degraded state, so recovery never reads it as dead while the
 *   agent may still act; nothing else waits on it (`held`);
 * - its host is gone with no exit: left to ordinary recovery, interrupted and unconfirmed.
 */
export async function claimAdoptableExecutions(input: { instanceId: string;
  isOwnerAlive(identity: { pid: number; bootId: string; startTicks: string }): boolean }): Promise<{ adopted: Adoption[]; held: HeldExecution[] }> {
  const ownerAlive = (owner: string) => {
    const process = db.query("SELECT pid, boot_id AS bootId, process_start_ticks AS startTicks FROM process_instances WHERE instance_id=?").get(owner) as any;
    return !!process && input.isOwnerAlive(process);
  };
  const adopted: Adoption[] = [], held: HeldExecution[] = [];
  const open = db.query(`SELECT e.* FROM executions e JOIN turns t ON t.id=e.turn_id
      WHERE e.state IN ('intended','live','exited') AND t.status='running' AND t.dispatch_attempt=e.dispatch_attempt
      ORDER BY e.created_at_ms`).all() as ExecutionRow[];
  for (const execution of open) {
    const turn = db.query("SELECT owner_instance_id FROM turns WHERE id=?").get(execution.turn_id) as { owner_instance_id: string | null } | null;
    if (!turn) continue;
    if (turn.owner_instance_id && turn.owner_instance_id !== input.instanceId && ownerAlive(turn.owner_instance_id)) continue;
    const probe = await probeHost(execution);
    if (probe === "gone") {
      recordExecutionLost(execution.execution_id, "The execution host was gone, with no recorded exit, when Concierge started.");
      continue;
    }
    if (!claimExecutionTurn(execution, turn.owner_instance_id, input.instanceId)) continue;
    const protocolKnown = ADOPTABLE_HOST_PROTOCOLS.includes(execution.host_protocol);
    if (probe === "unresponsive" || !protocolKnown) {
      // Containment, not success: the run stays this coordinator's, its agent keeps its process and
      // its record, and it is never reported adopted until it actually is.
      const reason = protocolKnown ? "unresponsive" as const : "protocol" as const;
      db.query("UPDATE executions SET detail=?, updated_at_ms=? WHERE execution_id=?").run(`held: ${reason}`, Date.now(), execution.execution_id);
      log("error", reason === "protocol" ? "execution_host_protocol_unadoptable" : "execution_host_unresponsive",
        { execution_id: execution.execution_id, turn_id: execution.turn_id, host_protocol: execution.host_protocol });
      held.push({ execution, reason });
      continue;
    }
    // A host found answering for a launch whose record stopped at its intent is the custody the
    // launch would have recorded: it is live from here, for shutdown and adoption alike.
    if (execution.state === "intended" && probe === "answering")
      db.query("UPDATE executions SET state='live', unit=?, updated_at_ms=? WHERE execution_id=? AND state='intended'")
        .run(executionUnit(execution.execution_id), Date.now(), execution.execution_id);
    const claim = queuedTurnClaimRow(execution.turn_id);
    if (!claim) continue;
    const mode = probe === "gone-with-exit" ? "adopt-record" as const : "adopt" as const;
    log("info", "execution_adopted", { execution_id: execution.execution_id, turn_id: execution.turn_id, mode,
      previous_coordinator: turn.owner_instance_id, adoptions: execution.adoptions + 1 });
    adopted.push({ execution, claim, processor: JSON.parse(execution.processor_json), mode });
  }
  if (adopted.length || held.length) executionChanged();
  await releaseSettledExecutions();
  pruneExecutionRecords();
  return { adopted, held };
}

/**
 * Keeps trying a held execution: once its host answers it is taken back, once the supervisor has
 * let it go it is settled from its record or, with no recorded exit, interrupted as unconfirmed.
 * A held run never blocks other sessions; only its own session waits, as it would on its agent.
 */
export function watchHeldExecution(held: HeldExecution, handlers: {
  stopped(): boolean;
  adopt(adoption: Adoption): void;
  interrupt(turnId: number, reason: string): void;
}) {
  if (held.reason === "protocol") return; // only a compatible coordinator can take it; it adopts on its own start
  const attempt = async () => {
    if (handlers.stopped()) return;
    const probe = await probeHost(held.execution);
    const claim = queuedTurnClaimRow(held.execution.turn_id);
    if (!claim) return;
    if (probe === "answering" || probe === "gone-with-exit") {
      log("info", "execution_adopted", { execution_id: held.execution.execution_id, turn_id: held.execution.turn_id, after_hold: true });
      handlers.adopt({ execution: held.execution, claim, processor: JSON.parse(held.execution.processor_json), mode: probe === "answering" ? "adopt" : "adopt-record" });
      return;
    }
    if (probe === "gone") {
      recordExecutionLost(held.execution.execution_id, "The execution host stopped without recording an exit.");
      handlers.interrupt(held.execution.turn_id, "The agent's execution host stopped without recording how the run ended; what it did is unconfirmed.");
      return;
    }
    setTimeout(() => void attempt(), 30_000).unref?.();
  };
  setTimeout(() => void attempt(), 30_000).unref?.();
}

/** Hosts still holding the record of a run whose turn has already settled let it go. */
async function releaseSettledExecutions() {
  const settled = db.query(`SELECT e.* FROM executions e JOIN turns t ON t.id=e.turn_id
      WHERE e.state IN ('live','exited') AND (t.status NOT IN ('running','delivering') OR t.dispatch_attempt<>e.dispatch_attempt)`).all() as ExecutionRow[];
  for (const execution of settled) await releaseExecution(execution);
}

/**
 * Ends custody of a run whose outcome is durably settled: the host lets its record go, and a host
 * the supervisor positively reports gone needs no socket to be let go of.
 */
export async function releaseExecution(execution: ExecutionRow) {
  if (execution.supervisor === "codex-daemon") { recordExecutionReleased(execution.execution_id); return; }
  if (execution.state === "exited" && await releaseHost(execution.directory, execution.execution_id)) { recordExecutionReleased(execution.execution_id); return; }
  if (hostSupervisorView(execution.execution_id) === "gone") recordExecutionReleased(execution.execution_id);
}

