import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { isAncestorProcess, isProcessIdentityAlive, processIdentity } from "../src/runtime-identity";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ADOPTABLE_HOST_PROTOCOLS, HOST_PROTOCOL_VERSION } from "../src/execution-host-client";
import { provenRunKinds, turnContinuesThroughRestart } from "../src/execution-survival";

function finish(code: number, payload: Record<string, unknown>): never {
  console.log(JSON.stringify(payload));
  process.exit(code);
}

/**
 * Another release's host protocols, asked of that release itself. Releases from before this command
 * existed answer with a usage error: those that ship an execution host speak and adopt protocol 1,
 * and those without one start no hosts and adopt none.
 */
function releaseHostProtocols(artifact: string, stateDir: string): { current: number | null; adoptable: number[] } {
  const script = join(artifact, "control/drain-status.js");
  if (!existsSync(script)) throw new Error(`${artifact} is not a release (no control/drain-status.js)`);
  const asked = spawnSync(process.execPath, ["run", script, "host-protocols"],
    { encoding: "utf8", timeout: 30_000, env: { ...process.env, CONCIERGE_STATE_DIR: stateDir } });
  let answer: any = null;
  try { answer = JSON.parse((asked.stdout ?? "").trim().split("\n").at(-1) ?? ""); } catch {}
  if (asked.status === 0 && answer?.status === "host-protocols") {
    const valid = (value: unknown) => Number.isInteger(value) && (value as number) > 0;
    if (valid(answer.current) && Array.isArray(answer.adoptable) && answer.adoptable.every(valid) && answer.adoptable.includes(answer.current))
      return { current: answer.current, adoptable: answer.adoptable };
    throw new Error(`${artifact} answered host-protocols with an invalid contract: ${asked.stdout.slice(0, 300)}`);
  }
  // Only the exact refusal of a release that predates the command is read as its generation;
  // a timeout, crash or any other answer is unknown and refuses the activation.
  const predates = asked.status === 1 && answer?.status === "error" && typeof answer.error === "string"
    && answer.error.startsWith("usage: bun scripts/drain-status.ts <") && !answer.error.includes("host-protocols");
  if (!predates) throw new Error(`could not learn the host protocols of ${artifact}: ${String(asked.error ?? asked.signal ?? asked.stdout ?? "").slice(0, 300)}`);
  return existsSync(join(artifact, "control/bot/scripts/execution-host.js")) ? { current: 1, adoptable: [1] } : { current: null, adoptable: [] };
}

/**
 * A host-protocols.json contract read from a file, validated. `current: null` with nothing adoptable
 * describes code that starts no hosts.
 */
function readContract(path: string): { current: number | null; adoptable: number[] } {
  const contract = JSON.parse(readFileSync(path, "utf8"));
  const valid = (value: unknown) => Number.isInteger(value) && (value as number) > 0;
  const adoptable = contract?.adoptable;
  if (!Array.isArray(adoptable) || !adoptable.every(valid)) throw new Error(`${path} is not a host-protocols contract`);
  if (contract.current === null && adoptable.length === 0) return { current: null, adoptable: [] };
  if (!valid(contract.current) || !adoptable.includes(contract.current)) throw new Error(`${path} is not a host-protocols contract`);
  return { current: contract.current, adoptable };
}

const flag = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] || null : null; };

try {
  const command = process.argv[2];
  if (command === "host-protocols") finish(0, { status: "host-protocols", current: HOST_PROTOCOL_VERSION, adoptable: ADOPTABLE_HOST_PROTOCOLS });
  const stateDir = process.env.CONCIERGE_STATE_DIR;
  if (!stateDir) finish(1, { status: "error", error: "CONCIERGE_STATE_DIR is required" });
  if (!["check", "claim", "recover", "release", "adoptable-check"].includes(command)) {
    finish(1, { status: "error", error: "usage: bun scripts/drain-status.ts <check|claim|recover|release TOKEN|adoptable-check (--running ARTIFACT|--running-contract FILE) (--rollback ARTIFACT|--no-rollback) [--candidate-contract FILE]|host-protocols>" });
  }
  const database = new Database(`${stateDir}/state.db`, { readonly: command === "check" || command === "adoptable-check", strict: true });
  database.exec("PRAGMA busy_timeout=5000");
  if (command === "release") {
    const token = process.argv[3];
    if (!token) finish(1, { status: "error", error: "release requires a token" });
    const released = database.query("DELETE FROM deployment_drain WHERE singleton=1 AND token=?").run(token).changes;
    database.close();
    finish(released === 1 ? 0 : 1, released === 1 ? { status: "released", token } : { status: "error", error: "drain token did not match" });
  }
  if (command === "recover") {
    const gate = database.query("SELECT * FROM deployment_drain WHERE singleton=1").get() as any;
    if (!gate) {
      database.close();
      finish(0, { status: "clear" });
    }
    if (isProcessIdentityAlive({ pid: gate.owner_pid, bootId: gate.owner_boot_id, startTicks: gate.owner_start_ticks })) {
      database.close();
      finish(10, { status: "active", error: "deployment gate still has a live owner" });
    }
    database.query("DELETE FROM deployment_drain WHERE singleton=1 AND token=?").run(gate.token);
    database.close();
    finish(0, { status: "recovered" });
  }

  // A turn whose provider process lives in an execution host (or the Codex daemon) carries on
  // through the coordinator's restart and is taken back by the next one. It holds the update only
  // until its kind has been proven to survive a restart on this machine (survivableRunKinds in
  // state.ts, the same rule the queue uses), and only if this release can adopt its host protocol.
  const hasExecutions = !!database.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='executions'").get();
  const proven = provenRunKinds(database);
  const continuesThroughRestart = (turnId: number) => turnContinuesThroughRestart(database, turnId, proven);

  if (command === "adoptable-check") {
    // Run from a candidate release before it is activated, for every activation alike. Two releases
    // must take back hosts across this install: the candidate, and the release a failed candidate
    // rolls back to. Each must adopt every protocol already in use and the protocol the running
    // coordinator may still start before it stops; the rollback target must also adopt the
    // candidate's own, which it starts the moment it runs. Compared between the real releases.
    const inUse = hasExecutions ? (database.query("SELECT DISTINCT host_protocol FROM executions WHERE state IN ('intended','live','exited')").all() as { host_protocol: number }[]).map(row => row.host_protocol) : [];
    database.close();
    // Every party is required: an unknown one is never assumed compatible. The server names release
    // artifacts. The Mac updates a checkout in place, so it names the candidate's and the running
    // code's contract files and states that it has no rollback release (--no-rollback).
    const runningArtifact = flag("--running"), rollbackArtifact = flag("--rollback");
    const runningContract = flag("--running-contract"), candidateContract = flag("--candidate-contract");
    const noRollback = process.argv.includes("--no-rollback");
    if (!(runningArtifact || runningContract) || !(rollbackArtifact || noRollback))
      finish(1, { status: "incompatible", error: "adoptable-check needs the running release (--running or --running-contract) and the rollback release (--rollback, or --no-rollback where none exists)." });
    type Contract = ReturnType<typeof releaseHostProtocols>;
    let candidate: Contract = { current: HOST_PROTOCOL_VERSION, adoptable: [...ADOPTABLE_HOST_PROTOCOLS] };
    let running: Contract, rollback: Contract | null = null;
    try {
      if (candidateContract) candidate = readContract(candidateContract);
      running = runningContract ? readContract(runningContract) : releaseHostProtocols(runningArtifact!, stateDir!);
      if (rollbackArtifact) rollback = releaseHostProtocols(rollbackArtifact, stateDir!);
    } catch (error) { finish(1, { status: "incompatible", error: error instanceof Error ? error.message : String(error) }); }
    const beforeCandidate = [...inUse, ...(running.current != null ? [running.current] : [])];
    const refusals: string[] = [];
    const lacking = (adoptable: readonly number[], needed: number[]) => [...new Set(needed.filter(protocol => !adoptable.includes(protocol)))];
    const candidateLacks = lacking(candidate.adoptable, beforeCandidate);
    if (candidateLacks.length) refusals.push(`the candidate cannot take back hosts on protocol ${candidateLacks.join(", ")}`);
    if (rollback) {
      const rollbackLacks = lacking(rollback.adoptable, [...beforeCandidate, ...(candidate.current != null ? [candidate.current] : [])]);
      if (rollbackLacks.length) refusals.push(`the rollback release ${rollbackArtifact} could not take back hosts on protocol ${rollbackLacks.join(", ")}`);
    }
    const report = { in_use: inUse, candidate, running, rollback };
    if (refusals.length) finish(1, { status: "incompatible", ...report, error: `${refusals.join("; ")}.` });
    finish(0, { status: "compatible", ...report });
  }

  const inspect = () => {
    const hasBackgroundJobs = !!database.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_job_status'").get();
    const continuing: any[] = [];
    const rows = database.query(`
    SELECT t.id AS turn_id, t.status AS turn_status, t.owner_instance_id,
           t.session_id, s.native_metadata_json,
           p.pid, p.boot_id, p.process_start_ticks
    FROM turns t
    LEFT JOIN sessions s ON s.id=t.session_id
    LEFT JOIN process_instances p ON p.instance_id=t.owner_instance_id
    WHERE t.status IN ('running', 'delivering')
    ORDER BY t.id
    `).all() as any[];
    const active: any[] = [];
    const stale: any[] = [];
    for (const row of rows) {
      let title: string | null = null;
      try { title = JSON.parse(row.native_metadata_json || "{}").title || null; } catch {}
      const jobs = (hasBackgroundJobs ? database.query(`SELECT task_id,description,started_at_ms,told_30,told_60,holding_only
        FROM background_job_status WHERE turn_id=? ORDER BY started_at_ms`).all(row.turn_id) : []) as Array<{
        task_id: string; description: string; started_at_ms: number;
        told_30: number; told_60: number; holding_only: number;
      }>;
      const summary = { turn_id: row.turn_id, turn_status: row.turn_status,
        owner_instance_id: row.owner_instance_id, session_id: row.session_id,
        title, background_jobs: jobs.map(job => ({ id: job.task_id, description: job.description,
          started_at: new Date(job.started_at_ms).toISOString(), age_ms: Date.now() - job.started_at_ms,
          told_30: !!job.told_30, told_60: !!job.told_60, holding_only: !!job.holding_only })) };
      if (continuesThroughRestart(row.turn_id)) continuing.push(summary);
      else if (isProcessIdentityAlive({ pid: row.pid, bootId: row.boot_id, startTicks: row.process_start_ticks })) active.push(summary);
      else stale.push(summary);
    }
    if (database.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='routed_requests'").get()) {
      const publications = database.query(`SELECT request.request_id, request.status, request.owner_instance_id,
        process.pid, process.boot_id, process.process_start_ticks FROM routed_requests request
        LEFT JOIN process_instances process ON process.instance_id=request.owner_instance_id
        WHERE request.status IN ('accepted', 'publishing', 'confirmed')
          AND NOT EXISTS (SELECT 1 FROM routed_requests older
            WHERE older.channel_id=request.channel_id AND older.rowid<request.rowid
              AND older.status IN ('accepted', 'publishing', 'confirmed', 'parked'))`).all() as any[];
      for (const row of publications) {
        const summary = { request_id: row.request_id, request_status: row.status, owner_instance_id: row.owner_instance_id };
        if (isProcessIdentityAlive({ pid: row.pid, bootId: row.boot_id, startTicks: row.process_start_ticks })) active.push(summary);
        else stale.push(summary);
      }
    }
    // A sign-in he has started is work in progress. It holds the update the same way a
    // running turn does, because restarting through it discards the waiting process and his
    // pasted code then has nowhere to go — which is how many updates tonight each silently
    // threw a sign-in away. Its own expiry bounds the wait, so an abandoned one holds nothing.
    if (database.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pending_sign_ins'").get()) {
      const signIns = database.query(`SELECT sign_in.provider, sign_in.owner_instance_id, sign_in.expires_at_ms,
        process.pid, process.boot_id, process.process_start_ticks FROM pending_sign_ins sign_in
        LEFT JOIN process_instances process ON process.instance_id=sign_in.owner_instance_id
        WHERE sign_in.expires_at_ms > ?`).all(Date.now()) as any[];
      for (const row of signIns) {
        const summary = { pending_sign_in: row.provider, owner_instance_id: row.owner_instance_id,
          expires_at: new Date(row.expires_at_ms).toISOString() };
        if (isProcessIdentityAlive({ pid: row.pid, bootId: row.boot_id, startTicks: row.process_start_ticks })) active.push(summary);
        else stale.push(summary);
      }
    }
    return { active, stale, continuing };
  };

  if (command === "check") {
    const token = process.argv[3];
    if (token) {
      const gate = database.query("SELECT token FROM deployment_drain WHERE singleton=1").get() as any;
      if (gate?.token !== token) {
        database.close();
        finish(1, { status: "error", error: "deployment drain token did not match" });
      }
    }
    const result = inspect();
    database.close();
    if (result.active.length > 0) finish(10, { status: "active", ...result });
    if (result.stale.length > 0) finish(20, { status: "stale", ...result });
    finish(0, { status: "drained", ...result });
  }

  const token = randomUUID();
  const ownerPidFlag = process.argv.indexOf("--owner-pid");
  const ownerPid = Number(ownerPidFlag >= 0 ? process.argv[ownerPidFlag + 1] : NaN);
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 1 || !isAncestorProcess(ownerPid)) {
    database.close();
    finish(1, { status: "error", error: "claim requires --owner-pid with a live ancestor PID" });
  }
  // Derive kernel identity ourselves; caller supplies only its PID.
  const identity = processIdentity(ownerPid);
  const claimed = database.transaction(() => {
    // The gate write is the admission boundary. Inspect only after it wins the
    // SQLite writer order so no later turn can slip into the draining set.
    database.query(`INSERT INTO deployment_drain
      (singleton, token, owner_pid, owner_boot_id, owner_start_ticks) VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO NOTHING`).run(token, identity.pid, identity.bootId, identity.startTicks);
    const gate = database.query("SELECT token FROM deployment_drain WHERE singleton=1").get() as any;
    if (gate?.token !== token) return { claimed: false, active: [], stale: [] };
    return { claimed: true, ...inspect() };
  })();
  database.close();
  if (!claimed.claimed) finish(1, {
    status: "error", error: "another drain claim exists", ...claimed,
  });
  finish(0, {
    status: claimed.active.length ? "claimed_draining" : claimed.stale.length ? "claimed_stale" : "claimed_drained",
    token,
    ...claimed,
  });
} catch (error) {
  finish(1, { status: "error", error: error instanceof Error ? error.message : String(error) });
}
