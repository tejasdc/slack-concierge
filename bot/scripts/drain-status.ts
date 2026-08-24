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
  if (!['check', 'claim', 'resume-held', 'hold', 'verify-held', 'release-live', 'release'].includes(command)) {
    finish(1, { status: "error", error: "usage: bun scripts/drain-status.ts <check|claim|resume-held TOKEN|hold TOKEN|verify-held TOKEN|release-live TOKEN|release TOKEN>" });
  }
  const database = new Database(`${stateDir}/state.db`, { readonly: command === "check", strict: true });
  let drainHasMode = (database.query("PRAGMA table_info(deployment_drain)").all() as Array<{ name: string }>)
    .some((column) => column.name === "mode");
  if (command !== "check") {
    if (!drainHasMode) {
      database.exec("ALTER TABLE deployment_drain ADD COLUMN mode TEXT NOT NULL DEFAULT 'live' CHECK(mode IN ('live', 'held'))");
      drainHasMode = true;
    }
  }
  if (command === "release" || command === "release-live") {
    const token = process.argv[3];
    if (!token) finish(1, { status: "error", error: `${command} requires a token` });
    const released = database.query(command === "release"
      ? "DELETE FROM deployment_drain WHERE singleton=1 AND token=?"
      : "DELETE FROM deployment_drain WHERE singleton=1 AND token=? AND mode='live'").run(token).changes;
    const retained = database.query("SELECT mode FROM deployment_drain WHERE singleton=1 AND token=?")
      .get(token) as { mode: string } | null;
    database.close();
    finish(released === 1 || (command === "release-live" && retained?.mode === "held") ? 0 : 1,
      released === 1 ? { status: "released", token }
        : retained?.mode === "held" ? { status: "retained_held", token }
          : { status: "error", error: "drain token did not match" });
  }

  if (command === "hold") {
    const token = process.argv[3];
    if (!token) finish(1, { status: "error", error: "hold requires a token" });
    const held = database.query("UPDATE deployment_drain SET mode='held' WHERE singleton=1 AND token=?")
      .run(token).changes;
    database.close();
    finish(held === 1 ? 0 : 1, held === 1
      ? { status: "held", token }
      : { status: "error", error: "drain token did not match" });
  }

  if (command === "verify-held") {
    const token = process.argv[3];
    if (!token) finish(1, { status: "error", error: "verify-held requires a token" });
    const gate = database.query("SELECT token, mode FROM deployment_drain WHERE singleton=1").get() as any;
    database.close();
    finish(gate?.token === token && gate.mode === "held" ? 0 : 1,
      gate?.token === token && gate.mode === "held"
        ? { status: "held", token }
        : { status: "error", error: "exact held drain token did not match" });
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
    const gate = database.query(`SELECT token, ${drainHasMode ? "mode" : "'live' AS mode"}
      FROM deployment_drain WHERE singleton=1`).get() as any;
    database.close();
    if (result.active.length > 0) finish(10, { status: "active", ...result });
    if (result.stale.length > 0) finish(20, { status: "stale", ...result });
    finish(0, { status: "drained", gate_claimed: Boolean(gate), gate_mode: gate?.mode || null, ...result });
  }

  const ownerPidFlag = process.argv.indexOf("--owner-pid");
  const ownerPid = Number(ownerPidFlag >= 0 ? process.argv[ownerPidFlag + 1] : NaN);
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 1 || !isAncestorProcess(ownerPid)) {
    database.close();
    finish(1, { status: "error", error: `${command} requires --owner-pid with a live ancestor PID` });
  }
  // Derive kernel identity ourselves; caller supplies only its PID.
  const identity = processIdentity(ownerPid);
  if (command === "resume-held") {
    const token = process.argv[3];
    if (!token) {
      database.close();
      finish(1, { status: "error", error: "resume-held requires a token" });
    }
    const resumed = database.transaction(() => {
      const result = inspect();
      if (result.active.length > 0) return { resumed: false, blocked: true, ...result };
      const existing = database.query("SELECT * FROM deployment_drain WHERE singleton=1").get() as any;
      if (!existing || existing.token !== token || existing.mode !== "held") {
        return { resumed: false, blocked: false, ...result };
      }
      if (existing.owner_pid === identity.pid && existing.owner_boot_id === identity.bootId
        && existing.owner_start_ticks === identity.startTicks) {
        return { resumed: true, blocked: false, ...result };
      }
      if (isProcessIdentityAlive({
        pid: existing.owner_pid,
        bootId: existing.owner_boot_id,
        startTicks: existing.owner_start_ticks,
      })) return { resumed: false, blocked: true, ...result };
      const changed = database.query(`UPDATE deployment_drain
        SET owner_pid=?, owner_boot_id=?, owner_start_ticks=?, claimed_at=CURRENT_TIMESTAMP
        WHERE singleton=1 AND token=? AND mode='held'
          AND owner_pid=? AND owner_boot_id=? AND owner_start_ticks=?`).run(
        identity.pid,
        identity.bootId,
        identity.startTicks,
        token,
        existing.owner_pid,
        existing.owner_boot_id,
        existing.owner_start_ticks,
      ).changes;
      return { resumed: changed === 1, blocked: false, ...result };
    })();
    database.close();
    finish(resumed.resumed ? 0 : resumed.blocked ? 10 : 1, resumed.resumed
      ? { status: "resumed_held", token, active: resumed.active, stale: resumed.stale }
      : { status: resumed.blocked ? "active" : "error", error: resumed.blocked ? undefined : "exact held drain token did not match", ...resumed });
  }

  const token = randomUUID();
  const adoptHeld = process.argv.includes("--adopt-held");
  const claimed = database.transaction(() => {
    const result = inspect();
    if (result.active.length > 0) return { claimed: false, ...result };
    const existing = database.query("SELECT * FROM deployment_drain WHERE singleton=1").get() as any;
    if (existing) {
      const existingOwnerAlive = isProcessIdentityAlive({
        pid: existing.owner_pid,
        bootId: existing.owner_boot_id,
        startTicks: existing.owner_start_ticks,
      });
      if (existing.mode !== "held" || existingOwnerAlive || !adoptHeld) {
        return { claimed: false, ...result };
      }
      database.query(`UPDATE deployment_drain SET token=?, owner_pid=?, owner_boot_id=?,
        owner_start_ticks=?, mode='live', claimed_at=CURRENT_TIMESTAMP
        WHERE singleton=1 AND token=? AND mode='held'`).run(
        token, identity.pid, identity.bootId, identity.startTicks, existing.token,
      );
      const adopted = database.query("SELECT token FROM deployment_drain WHERE singleton=1").get() as any;
      return { claimed: adopted?.token === token, ...result };
    }
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
