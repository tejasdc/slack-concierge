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
import { ADOPTABLE_HOST_PROTOCOLS, HOST_PROTOCOL_VERSION, HostConnection, hostSocketPath, type HostLaunch } from "./execution-host-client";

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

export type ExecutionRow = {
  execution_id: string; turn_id: number; dispatch_attempt: number; session_id: number; provider: string;
  host_protocol: number; supervisor: string; directory: string; unit: string | null; host_script: string | null;
  runtime: string | null; manifest_digest: string | null; processor_json: string; state: string;
  coordinator_instance_id: string | null; adoptions: number; exit_code: number | null; exit_signal: string | null;
  detail: string | null; created_at_ms: number; updated_at_ms: number;
};

/** Recorded before the host is started, so a coordinator that dies mid-launch leaves evidence, never a second launch. */
export function retainExecutionIntent(input: { executionId: string; turnId: number; dispatchAttempt: number; sessionId: number;
  provider: string; directory: string; processor: unknown; coordinatorInstanceId: string }) {
  const now = Date.now();
  db.query(`INSERT INTO executions (execution_id, turn_id, dispatch_attempt, session_id, provider, host_protocol, supervisor,
      directory, processor_json, state, coordinator_instance_id, created_at_ms, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'intended', ?, ?, ?)`)
    .run(input.executionId, input.turnId, input.dispatchAttempt, input.sessionId, input.provider, HOST_PROTOCOL_VERSION,
      process.platform === "darwin" ? "launchd" : "systemd", input.directory, JSON.stringify(input.processor),
      input.coordinatorInstanceId, now, now);
  executionChanged();
}

export function recordExecutionLaunched(executionId: string, launch: HostLaunch) {
  db.query(`UPDATE executions SET unit=?, host_script=?, runtime=?, manifest_digest=?, state='live', updated_at_ms=?
    WHERE execution_id=? AND state='intended'`)
    .run(launch.unit, launch.hostScript, launch.runtime, launch.manifestDigest, Date.now(), executionId);
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
  for (const turnId of turnIds) if (db.query("SELECT 1 FROM executions WHERE turn_id=? AND state='live'").get(turnId)) hosted.add(turnId);
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

export type Adoption = { execution: ExecutionRow; claim: QueuedTurnClaimRow; processor: any };

/**
 * At startup, before any recovery reads a running turn as orphaned: every hosted execution whose
 * coordinator is gone and whose host still answers becomes this coordinator's again, under the same
 * turn, run and dispatch attempt (adoption never counts as another attempt and never clears an
 * acknowledgement). A host that does not answer is left to the ordinary recovery, which keeps the
 * run interrupted and unconfirmed, as it would a process that died.
 */
export async function claimAdoptableExecutions(input: { instanceId: string;
  isOwnerAlive(identity: { pid: number; bootId: string; startTicks: string }): boolean }): Promise<Adoption[]> {
  const ownerAlive = (owner: string) => {
    const process = db.query("SELECT pid, boot_id AS bootId, process_start_ticks AS startTicks FROM process_instances WHERE instance_id=?").get(owner) as any;
    return !!process && input.isOwnerAlive(process);
  };
  const adopted: Adoption[] = [];
  const open = db.query(`SELECT e.* FROM executions e JOIN turns t ON t.id=e.turn_id
      WHERE e.state IN ('intended','live','exited') AND t.status='running' AND t.dispatch_attempt=e.dispatch_attempt
      ORDER BY e.created_at_ms`).all() as ExecutionRow[];
  for (const execution of open) {
    const turn = db.query("SELECT owner_instance_id FROM turns WHERE id=?").get(execution.turn_id) as { owner_instance_id: string | null } | null;
    if (!turn) continue;
    if (turn.owner_instance_id && turn.owner_instance_id !== input.instanceId && ownerAlive(turn.owner_instance_id)) continue;
    if (!ADOPTABLE_HOST_PROTOCOLS.includes(execution.host_protocol)) {
      // Containment, not success: the host keeps running with its record, nothing else waits on it.
      log("error", "execution_host_protocol_unadoptable", { execution_id: execution.execution_id, turn_id: execution.turn_id, host_protocol: execution.host_protocol });
      continue;
    }
    let reachable = false;
    try {
      const connection = await HostConnection.connect(hostSocketPath(execution.directory), 3_000);
      try { reachable = (await connection.status()).executionId === execution.execution_id; } finally { connection.close(); }
    } catch (error) {
      log("warn", "execution_host_unreachable", { execution_id: execution.execution_id, turn_id: execution.turn_id, ...errorFields(error) });
    }
    if (!reachable) {
      recordExecutionLost(execution.execution_id, "The execution host was not running when Concierge started.");
      continue;
    }
    const claimed = db.transaction(() => {
      const changed = db.query(`UPDATE turns SET owner_instance_id=? WHERE id=? AND status='running' AND dispatch_attempt=? AND owner_instance_id IS ?`)
        .run(input.instanceId, execution.turn_id, execution.dispatch_attempt, turn.owner_instance_id).changes === 1;
      if (changed) db.query(`UPDATE executions SET coordinator_instance_id=?, adoptions=adoptions+1, updated_at_ms=? WHERE execution_id=?`)
        .run(input.instanceId, Date.now(), execution.execution_id);
      return changed;
    })();
    if (!claimed) continue;
    const claim = queuedTurnClaimRow(execution.turn_id);
    if (!claim) continue;
    log("info", "execution_adopted", { execution_id: execution.execution_id, turn_id: execution.turn_id,
      previous_coordinator: turn.owner_instance_id, adoptions: execution.adoptions + 1 });
    adopted.push({ execution, claim, processor: JSON.parse(execution.processor_json) });
  }
  if (adopted.length) executionChanged();
  pruneExecutionRecords();
  return adopted;
}
