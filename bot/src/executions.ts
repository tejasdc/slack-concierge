/**
 * Which host holds which execution: the ledger's side of hosted provider processes
 * (design docs/plans/2026-10-07-agent-work-and-updates-without-waiting.md §1.3, §3.1 step 4;
 * protocol docs/architecture/EXECUTION-HOST.md). The host's journal holds what the provider said;
 * this table holds custody and what a later coordinator needs to take the run back.
 * `turns.owner_instance_id` stays the coordinator's claim on the turn and nothing else.
 */
import { rm } from "node:fs/promises";
import { db, executionChanged, queuedTurnClaimRow, settleSupersededParkedTurn, type QueuedTurnClaimRow } from "./state";
import { log, errorFields } from "./log";
import { unpinCodexThreadHooks } from "./hook-pins";
import { watchHostsInUse } from "./watches";
import { RUNNER_SUPERVISOR, RunnerHostAccess, turnJobId } from "./runner-host-access";
import { runnerLedger } from "./runner-ledger";
import { ADOPTABLE_HOST_PROTOCOLS, HOST_PROTOCOL_VERSION, executionUnit, hostCustody, hostScriptDigest, hostSupervisorView, releaseHost, retireHostJob, stopSupersededHost, HOST_SUPERVISOR, type HostLaunch } from "./execution-host-client";

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
  /** `codex-daemon`: the provider's own daemon holds the turn, so there is no host; it is live at once.
   * `capability-host`: Thinkering's ChatGPT capability holds the send and its answer; also live at once. */
  supervisor?: "codex-daemon" | "capability-host" | typeof RUNNER_SUPERVISOR }) {
  const now = Date.now();
  db.query(`INSERT INTO executions (execution_id, turn_id, dispatch_attempt, session_id, provider, host_protocol, supervisor,
      directory, processor_json, state, coordinator_instance_id, created_at_ms, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(input.executionId, input.turnId, input.dispatchAttempt, input.sessionId, input.provider, HOST_PROTOCOL_VERSION,
      input.supervisor ?? HOST_SUPERVISOR, input.directory, JSON.stringify(input.processor),
      input.supervisor && input.supervisor !== RUNNER_SUPERVISOR ? "live" : "intended", input.coordinatorInstanceId, now, now);
  executionChanged();
}

export function recordExecutionLaunched(executionId: string, launch: HostLaunch) {
  // A runner's host program is on the runner; this machine holds no release file for it.
  db.query(`UPDATE executions SET unit=?, host_script=?, host_digest=?, runtime=?, manifest_digest=?, state='live', updated_at_ms=?
    WHERE execution_id=? AND state='intended'`)
    .run(launch.unit, launch.hostScript || null, launch.hostScript ? hostScriptDigest(launch.hostScript) : null, launch.runtime || null,
      launch.manifestDigest, Date.now(), executionId);
  if (launch.protocol !== undefined)
    db.query("UPDATE executions SET host_protocol=? WHERE execution_id=?").run(launch.protocol, executionId);
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
  const runs = (db.query("SELECT DISTINCT host_script FROM executions WHERE state IN ('intended','live','exited') AND host_script IS NOT NULL").all() as { host_script: string }[])
    .map(row => row.host_script);
  return [...new Set([...runs, ...watchHostsInUse().scripts])];
}

/** Every host protocol an admitted execution still speaks; a candidate release must adopt them all. */
export function hostProtocolsInUse(): number[] {
  const runs = (db.query("SELECT DISTINCT host_protocol FROM executions WHERE state IN ('intended','live','exited')").all() as { host_protocol: number }[])
    .map(row => row.host_protocol);
  return [...new Set([...runs, ...watchHostsInUse().protocols])];
}

/** A finished execution's record (its journal is the run's raw evidence) is kept this long. */
const EXECUTION_RECORD_RETENTION_MS = 30 * 24 * 60 * 60_000;

/**
 * Prune old hosted records after the owner is serving. Custody recovery needs only open
 * executions; scanning every historical release before the request entrance opens made a
 * no-op cleanup cost seconds on a cold ledger. A primary-key page bounds each owner-loop read.
 */
export async function pruneExecutionRecordsInPages(shouldStop: () => boolean, nowMs = Date.now()) {
  type PruneRow = { execution_id: string; directory: string; state: string; updated_at_ms: number; detail: string | null };
  let after = '';
  let scanned = 0;
  let pruned = 0;
  const cutoff = nowMs - EXECUTION_RECORD_RETENTION_MS;
  while (!shouldStop()) {
    const page = db.query(`SELECT execution_id,directory,state,updated_at_ms,detail FROM executions
      WHERE execution_id>? ORDER BY execution_id LIMIT 64`).all(after) as PruneRow[];
    if (!page.length) break;
    let handled = 0;
    let changed = 0;
    for (const row of page) {
      if (shouldStop()) return;
      handled++;
      after = row.execution_id;
      scanned++;
      if (!(['released', 'lost'].includes(row.state) && row.updated_at_ms < cutoff && row.detail !== 'pruned')) continue;
      changed++;
      // A prior directory removal yielded to foreground work. Recheck this row under the
      // serving owner's ledger before applying the next destructive step.
      const eligible = () => !!db.query(`SELECT 1 FROM executions WHERE execution_id=? AND directory=?
        AND state IN ('released','lost') AND updated_at_ms<? AND detail IS NOT 'pruned'`)
        .get(row.execution_id, row.directory, cutoff);
      // A runner's record is its job's events in this ledger: they and the job's payload (its prompt
      // and attachment bytes) go after the same month a local journal is kept.
      if (!row.directory) {
        const removed = db.transaction(() => {
          if (!eligible()) return false;
          db.query(`DELETE FROM runner_events WHERE attempt_id IN (SELECT attempt_id FROM runner_attempts WHERE job_id=?)`).run(turnJobId(row.execution_id));
          db.query(`UPDATE runner_jobs SET payload_json='null' WHERE job_id=? AND state IN ('finished','unconfirmed')`).run(turnJobId(row.execution_id));
          db.query("UPDATE executions SET detail='pruned' WHERE execution_id=?").run(row.execution_id);
          return true;
        })();
        if (removed) pruned++;
      } else {
        if (!eligible()) continue;
        try {
          await rm(row.directory, { recursive: true, force: true });
          const marked = db.query(`UPDATE executions SET detail='pruned' WHERE execution_id=? AND directory=?
            AND state IN ('released','lost') AND updated_at_ms<? AND detail IS NOT 'pruned'`)
            .run(row.execution_id, row.directory, cutoff);
          if (marked.changes) pruned++;
        } catch (error) {
          log("warn", "execution_record_prune_failed", { execution_id: row.execution_id, ...errorFields(error) });
        }
      }
      if (changed >= 2) break;
    }
    if (handled === page.length && page.length < 64) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  log('info', 'execution_record_prune_completed', { scanned, pruned });
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
  // A ChatGPT send lives in Thinkering's capability, keyed by its run id from before the send: the
  // next coordinator asks it for that exact run (reconcile, then observe), so it is always followable.
  if (execution.supervisor === "capability-host") return "answering";
  if (execution.supervisor === RUNNER_SUPERVISOR) {
    const custody = await new RunnerHostAccess(execution.execution_id).custody();
    return custody === "answering" ? "answering" : custody === "held" ? "unresponsive" : custody === "settle-from-record" ? "gone-with-exit" : "gone";
  }
  // The same decision a live run makes when its connection breaks (hostCustody): the unit name is
  // derived from the execution id, so a launch that crashed before recording it is still checked.
  const custody = await hostCustody(execution.directory, execution.execution_id);
  return custody === "answering" ? "answering" : custody === "held" ? "unresponsive" : custody === "settle-from-record" ? "gone-with-exit" : "gone";
}

/**
 * Taking a run back makes it this coordinator's in one transaction: same turn, run and dispatch
 * attempt (adoption is never another attempt and never clears an acknowledgement).
 */
export function claimExecutionTurn(execution: ExecutionRow, previousOwner: string | null, instanceId: string, parked = false) {
  return db.transaction(() => {
    const changed = parked
      ? db.query(`UPDATE turns SET status='running', owner_instance_id=?, ended_at=NULL,
          agent_text=NULL, dispatch_failure_class=NULL
          WHERE id=? AND status='parked' AND dispatch_failure_class='parked_ambiguous'
            AND dispatch_attempt=? AND owner_instance_id IS NULL
            AND stop_requested_at IS NULL
            AND EXISTS (SELECT 1 FROM sessions session WHERE session.id=? AND session.status<>'archived')
            AND NOT EXISTS (SELECT 1 FROM turns later WHERE later.session_id=? AND later.id>turns.id
              AND (later.provider_admission_intended_at IS NOT NULL OR later.provider_started_at IS NOT NULL
                OR later.provider_input_acknowledged_at IS NOT NULL))
            AND NOT EXISTS (SELECT 1 FROM turns other WHERE other.session_id=? AND other.id<>? AND other.status IN ('running','delivering'))`)
          .run(instanceId, execution.turn_id, execution.dispatch_attempt, execution.session_id, execution.session_id, execution.session_id, execution.turn_id).changes === 1
      : db.query(`UPDATE turns SET owner_instance_id=? WHERE id=? AND status='running' AND dispatch_attempt=? AND owner_instance_id IS ?`)
          .run(instanceId, execution.turn_id, execution.dispatch_attempt, previousOwner).changes === 1;
    if (changed && parked) db.query(`UPDATE sessions SET status='running' WHERE id=? AND status='idle'`).run(execution.session_id);
    // A Codex turn followed through the daemon is released when it parks; taking it back makes it live again.
    if (changed) db.query(`UPDATE executions SET coordinator_instance_id=?, adoptions=adoptions+1, updated_at_ms=?,
        state=CASE WHEN supervisor='codex-daemon' THEN 'live' ELSE state END WHERE execution_id=?`)
      .run(instanceId, Date.now(), execution.execution_id);
    return changed;
  })();
}

/** How long after parking a Codex turn is still taken back, how many times, and how many per sweep. */
export const PARKED_CODEX_FOLLOW_WINDOW_MS = 24 * 60 * 60_000;
export const PARKED_CODEX_FOLLOW_LIMIT = 3;
export const PARKED_CODEX_PER_SWEEP = 2;

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
export async function claimAdoptableExecutions(input: { instanceId: string; onlyParked?: boolean;
  isOwnerAlive(identity: { pid: number; bootId: string; startTicks: string }): boolean }): Promise<{ adopted: Adoption[]; held: HeldExecution[] }> {
  const ownerAlive = (owner: string) => {
    const process = db.query("SELECT pid, boot_id AS bootId, process_start_ticks AS startTicks FROM process_instances WHERE instance_id=?").get(owner) as any;
    return !!process && input.isOwnerAlive(process);
  };
  const adopted: Adoption[] = [], held: HeldExecution[] = [];
  // The time this owner was down never counts against a runner that kept its agents waiting for it.
  if (!input.onlyParked) runnerLedger().extendLiveLeases();
  // An old parked host must not keep writing a Claude conversation after a newer turn has
  // entered it. Stop only the old provider; keep the newer turn and its request custody.
  const superseded = db.query(`SELECT e.* FROM executions e JOIN turns t ON t.id=e.turn_id
    WHERE t.status='parked' AND t.dispatch_failure_class='parked_ambiguous'
      AND e.supervisor IN ('systemd','launchd','runner') AND e.state IN ('intended','live','exited') AND e.dispatch_attempt=t.dispatch_attempt
      AND EXISTS (SELECT 1 FROM turns later WHERE later.session_id=t.session_id AND later.id>t.id
        AND (later.provider_admission_intended_at IS NOT NULL OR later.provider_started_at IS NOT NULL
          OR later.provider_input_acknowledged_at IS NOT NULL))`)
    .all() as ExecutionRow[];
  await Promise.all(superseded.map(async execution => {
    try {
      const probe = await probeHost(execution);
      if ((probe === 'answering' || probe === 'unresponsive')
        && !await (execution.supervisor === RUNNER_SUPERVISOR ? new RunnerHostAccess(execution.execution_id).stopSuperseded()
          : stopSupersededHost(execution.directory,execution.execution_id))) return;
      if (probe === 'gone') recordExecutionLost(execution.execution_id,'The superseded execution host stopped without a recorded exit.');
      if (settleSupersededParkedTurn(execution.turn_id))
        log('warn','superseded_parked_execution_stopped',{turn_id:execution.turn_id,execution_id:execution.execution_id});
      if (probe !== 'gone') await releaseExecution({...execution,state:'exited'});
    } catch (error) { log('error','superseded_parked_execution_stop_failed',{turn_id:execution.turn_id,execution_id:execution.execution_id,...errorFields(error)}); }
  }));
  // A Codex turn that parked while this Concierge ran had its record released at once, so before
  // 2026-11-12 nothing took it back: ten turns parked by a lost App Server connection waited 50
  // minutes for an agent to notice. A recently parked one is followed again from its thread's history
  // (finished, still running, or never landed and retried), a few times at most and a few per sweep.
  // A turn he stopped is left parked: following it could only resend or swallow that Stop.
  const parkedTurnFollowable = `t.status='parked' AND t.dispatch_failure_class='parked_ambiguous'
          AND t.turn_kind='native' AND t.stop_requested_at IS NULL AND session.status<>'archived'
          AND NOT EXISTS (SELECT 1 FROM turns later WHERE later.session_id=t.session_id AND later.id>t.id
            AND (later.provider_admission_intended_at IS NOT NULL OR later.provider_started_at IS NOT NULL
              OR later.provider_input_acknowledged_at IS NOT NULL))`;
  const open = (db.query(`SELECT e.* FROM executions e JOIN turns t ON t.id=e.turn_id
      JOIN sessions session ON session.id=t.session_id
      WHERE e.state IN ('intended','live','exited') AND t.dispatch_attempt=e.dispatch_attempt
        AND ((?=0 AND t.status='running') OR (${parkedTurnFollowable}))
      ORDER BY e.created_at_ms`).all(input.onlyParked ? 1 : 0) as ExecutionRow[]).concat(!input.onlyParked ? [] :
    db.query(`SELECT e.* FROM executions e INDEXED BY executions_released_codex JOIN turns t ON t.id=e.turn_id
      JOIN sessions session ON session.id=t.session_id
      WHERE e.supervisor='codex-daemon' AND e.state='released' AND e.updated_at_ms>? AND e.adoptions<?
        AND t.dispatch_attempt=e.dispatch_attempt AND t.stop_requested_at IS NULL AND ${parkedTurnFollowable}
      ORDER BY e.created_at_ms`).all(Date.now() - PARKED_CODEX_FOLLOW_WINDOW_MS, PARKED_CODEX_FOLLOW_LIMIT) as ExecutionRow[]);
  let parkedCodexTaken = 0;
  for (const execution of open) {
    if (execution.state === "released" && parkedCodexTaken >= PARKED_CODEX_PER_SWEEP) continue;
    const turn = db.query("SELECT owner_instance_id,status FROM turns WHERE id=?").get(execution.turn_id) as { owner_instance_id: string | null; status: string } | null;
    if (!turn) continue;
    const parked = turn.status === "parked";
    if (!parked && turn.owner_instance_id === input.instanceId) continue;
    if (!parked && turn.owner_instance_id && turn.owner_instance_id !== input.instanceId && ownerAlive(turn.owner_instance_id)) continue;
    const probe = await probeHost(execution);
    if (probe === "gone") {
      recordExecutionLost(execution.execution_id, "The execution host was gone, with no recorded exit, when Concierge started.");
      continue;
    }
    if (!claimExecutionTurn(execution, turn.owner_instance_id, input.instanceId, parked)) continue;
    if (execution.state === "released") parkedCodexTaken++;
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
        .run(execution.supervisor === RUNNER_SUPERVISOR ? "runner" : executionUnit(execution.execution_id), Date.now(), execution.execution_id);
    const claim = queuedTurnClaimRow(execution.turn_id);
    if (!claim) continue;
    const mode = probe === "gone-with-exit" ? "adopt-record" as const : "adopt" as const;
    log("info", "execution_adopted", { execution_id: execution.execution_id, turn_id: execution.turn_id, mode,
      previous_coordinator: turn.owner_instance_id, adoptions: execution.adoptions + 1 });
    adopted.push({ execution, claim, processor: JSON.parse(execution.processor_json), mode });
  }
  if (adopted.length || held.length) executionChanged();
  if (!input.onlyParked) {
    await releaseSettledExecutions();
    await retireFinishedHostJobs();
  }
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
  // Match the existing partial index's predicate before narrowing to settled-host states.
  // Otherwise SQLite scans every historical released execution during owner recovery.
  const settled = db.query(`SELECT e.* FROM executions e JOIN turns t ON t.id=e.turn_id
      WHERE e.state IN ('intended','live','exited') AND e.state IN ('live','exited')
        AND (t.status NOT IN ('running','delivering') OR t.dispatch_attempt<>e.dispatch_attempt)`).all() as ExecutionRow[];
  for (const execution of settled) await releaseExecution(execution);
}

/**
 * Ends custody of a run whose outcome is durably settled: the host lets its record go, and a host
 * the supervisor positively reports gone needs no socket to be let go of.
 */
export async function releaseExecution(execution: ExecutionRow) {
  if (execution.supervisor === "capability-host") { recordExecutionReleased(execution.execution_id); return; }
  if (execution.supervisor === "codex-daemon") {
    recordExecutionReleased(execution.execution_id);
    // The turn is settled: its conversation's filed helpers go, unless a later turn filed its own.
    const thread = (db.query("SELECT agent_session_uuid FROM sessions WHERE id=?").get(execution.session_id) as { agent_session_uuid: string | null } | null)?.agent_session_uuid;
    if (thread && process.env.CONCIERGE_STATE_DIR) unpinCodexThreadHooks(process.env.CONCIERGE_STATE_DIR, thread, execution.execution_id);
    return;
  }
  if (execution.supervisor === RUNNER_SUPERVISOR) {
    // The runner lets the host go only on this command, sent after the turn is settled; a job that
    // already ended (its lease passed, or released before) holds nothing.
    const access = new RunnerHostAccess(execution.execution_id);
    if (await access.release()) recordExecutionReleased(execution.execution_id);
    return;
  }
  if (execution.state === "exited" && await releaseHost(execution.directory, execution.execution_id)) recordExecutionReleased(execution.execution_id);
  else if (await hostSupervisorView(execution.execution_id) === "gone") recordExecutionReleased(execution.execution_id);
  // A released host leaves within moments; its launchd job is removed once launchd reports it stopped.
  if (execution.supervisor === "launchd") setTimeout(() => {
    void retireFinishedHostJobs().catch(error => log("warn", "execution_host_retire_failed", errorFields(error)));
  }, 10_000).unref?.();
}

/**
 * launchd keeps a per-execution job loaded after its process ends. Jobs of released or lost runs are
 * removed; retireHostJob removes only a job launchd reports as stopped, never a running one.
 */
export async function retireFinishedHostJobs() {
  if (process.platform !== "darwin") return;
  const ended = db.query(`SELECT execution_id FROM executions WHERE supervisor='launchd' AND state IN ('released','lost')
      AND detail IS NOT 'job retired' AND updated_at_ms > ?`).all(Date.now() - EXECUTION_RECORD_RETENTION_MS) as { execution_id: string }[];
  for (const { execution_id } of ended)
    if (await retireHostJob(execution_id)) db.query("UPDATE executions SET detail='job retired' WHERE execution_id=? AND detail IS NOT 'pruned'").run(execution_id);
}

