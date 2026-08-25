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
    const rows = database.query(`
    SELECT t.id AS turn_id, t.status AS turn_status, t.owner_instance_id,
           p.pid, p.boot_id, p.process_start_ticks
    FROM turns t
    LEFT JOIN process_instances p ON p.instance_id=t.owner_instance_id
    WHERE t.status IN ('running', 'delivering')
    ORDER BY t.id
    `).all() as any[];
    const active: any[] = [];
    const stale: any[] = [];
    for (const row of rows) {
      const summary = { turn_id: row.turn_id, turn_status: row.turn_status, owner_instance_id: row.owner_instance_id };
      if (isProcessIdentityAlive({ pid: row.pid, bootId: row.boot_id, startTicks: row.process_start_ticks })) active.push(summary);
      else stale.push(summary);
    }
    return { active, stale };
  };

  if (command === "check") {
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
    const result = inspect();
    if (result.active.length > 0) return { claimed: false, ...result };
    database.query(`INSERT INTO deployment_drain
      (singleton, token, owner_pid, owner_boot_id, owner_start_ticks) VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO NOTHING`).run(token, identity.pid, identity.bootId, identity.startTicks);
    const gate = database.query("SELECT token FROM deployment_drain WHERE singleton=1").get() as any;
    return { claimed: gate?.token === token, ...result };
  })();
  database.close();
  if (!claimed.claimed) finish(claimed.active.length ? 10 : 1, {
    status: claimed.active.length ? "active" : "error", error: claimed.active.length ? undefined : "another drain claim exists", ...claimed,
  });
  finish(0, { status: claimed.stale.length ? "claimed_stale" : "claimed_drained", token, ...claimed });
} catch (error) {
  finish(1, { status: "error", error: error instanceof Error ? error.message : String(error) });
}
