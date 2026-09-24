import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { isAncestorProcess, isProcessIdentityAlive, processIdentity } from "../src/runtime-identity";

function finish(code: number, payload: Record<string, unknown>): never {
  console.log(JSON.stringify(payload));
  process.exit(code);
}

try {
  const command = process.argv[2];
  const stateDir = process.env.CONCIERGE_STATE_DIR;
  if (!stateDir) finish(1, { status: "error", error: "CONCIERGE_STATE_DIR is required" });
  if (!["check", "claim", "recover", "release"].includes(command)) {
    finish(1, { status: "error", error: "usage: bun scripts/drain-status.ts <check|claim|recover|release TOKEN>" });
  }
  const database = new Database(`${stateDir}/state.db`, { readonly: command === "check", strict: true });
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

  const inspect = () => {
    const hasBackgroundJobs = !!database.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_job_status'").get();
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
      if (isProcessIdentityAlive({ pid: row.pid, bootId: row.boot_id, startTicks: row.process_start_ticks })) active.push(summary);
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
    return { active, stale };
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
