#!/root/.bun/bin/bun
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { isAncestorProcess, isProcessIdentityAlive, processIdentity } from "../src/runtime-identity";

function finish(code: number, payload: Record<string, unknown>): never {
  console.log(JSON.stringify(payload));
  process.exit(code);
}

try {
  const command = process.argv[2];
  const stateDir = process.env.CONCIERGE_CAPTURE_STATE_DIR;
  if (!stateDir) finish(1, { status: "error", error: "CONCIERGE_CAPTURE_STATE_DIR is required" });
  if (!["check", "claim", "hold", "recover", "release-live", "release"].includes(command)) {
    finish(1, { status: "error", error: "usage: capture-drain-status.ts <check|claim|hold TOKEN|recover|release-live TOKEN|release TOKEN>" });
  }
  mkdirSync(stateDir, { recursive: true });
  const database = new Database(`${stateDir}/state.db`, { create: true, strict: true });
  database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS capture_delivery_gate (
      singleton INTEGER PRIMARY KEY CHECK (singleton=1),
      token TEXT NOT NULL,
      owner_pid INTEGER NOT NULL,
      owner_boot_id TEXT NOT NULL,
      owner_start_ticks TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'live' CHECK(mode IN ('live', 'held')),
      claimed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const addColumnIfMissing = (table: string, column: string, declaration: string) => {
    const columns = database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((candidate) => candidate.name === column)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
    }
  };
  addColumnIfMissing("capture_delivery_gate", "mode", "TEXT NOT NULL DEFAULT 'live' CHECK(mode IN ('live', 'held'))");
  const captureEventsTable = database.query(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='capture_events'",
  ).get();
  if (captureEventsTable) {
    addColumnIfMissing("capture_events", "delivery_owner_pid", "INTEGER");
    addColumnIfMissing("capture_events", "delivery_owner_boot_id", "TEXT");
    addColumnIfMissing("capture_events", "delivery_owner_start_ticks", "TEXT");
  }

  const clearStaleGate = () => {
    const gate = database.query("SELECT * FROM capture_delivery_gate WHERE singleton=1").get() as any;
    if (gate && gate.mode !== "held" && !isProcessIdentityAlive({ pid: gate.owner_pid, bootId: gate.owner_boot_id, startTicks: gate.owner_start_ticks })) {
      database.query("DELETE FROM capture_delivery_gate WHERE singleton=1 AND token=?").run(gate.token);
    }
  };
  const recoverDeadDeliveries = () => {
    if (!captureEventsTable) return 0;
    const sending = database.query(`
      SELECT event_id, delivery_owner_pid, delivery_owner_boot_id, delivery_owner_start_ticks
      FROM capture_events
      WHERE status='sending'
        AND delivery_owner_pid IS NOT NULL
        AND delivery_owner_boot_id IS NOT NULL
        AND delivery_owner_start_ticks IS NOT NULL
    `).all() as Array<{
      event_id: string;
      delivery_owner_pid: number;
      delivery_owner_boot_id: string;
      delivery_owner_start_ticks: string;
    }>;
    let recovered = 0;
    for (const event of sending) {
      const owner = {
        pid: event.delivery_owner_pid,
        bootId: event.delivery_owner_boot_id,
        startTicks: event.delivery_owner_start_ticks,
      };
      if (isProcessIdentityAlive(owner)) continue;
      recovered += database.query(`
        UPDATE capture_events
        SET status='pending', next_attempt_ms=NULL,
            delivery_error=COALESCE(delivery_error, 'delivery owner exited before completion'),
            delivery_owner_pid=NULL, delivery_owner_boot_id=NULL,
            delivery_owner_start_ticks=NULL, updated_at=CURRENT_TIMESTAMP
        WHERE event_id=? AND status='sending'
          AND delivery_owner_pid=? AND delivery_owner_boot_id=?
          AND delivery_owner_start_ticks=?
      `).run(event.event_id, owner.pid, owner.bootId, owner.startTicks).changes;
    }
    return recovered;
  };
  const sendingCount = () => {
    if (!captureEventsTable) return 0;
    return Number((database.query(
      "SELECT COUNT(*) AS count FROM capture_events WHERE status='sending'",
    ).get() as any).count);
  };

  if (command === "release" || command === "release-live") {
    const token = process.argv[3];
    if (!token) finish(1, { status: "error", error: `${command} requires a token` });
    const released = database.query(
      command === "release"
        ? "DELETE FROM capture_delivery_gate WHERE singleton=1 AND token=?"
        : "DELETE FROM capture_delivery_gate WHERE singleton=1 AND token=? AND mode='live'",
    ).run(token).changes;
    const retained = database.query(
      "SELECT mode FROM capture_delivery_gate WHERE singleton=1 AND token=?",
    ).get(token) as { mode: string } | null;
    database.close();
    finish(released === 1 || (command === "release-live" && retained?.mode === "held") ? 0 : 1, released === 1
      ? { status: "released", token }
      : retained?.mode === "held"
        ? { status: "retained_held", token }
      : { status: "error", error: "capture drain token did not match" });
  }

  if (command === "recover") {
    const gate = database.query("SELECT * FROM capture_delivery_gate WHERE singleton=1").get() as any;
    if (!gate) {
      database.close();
      finish(0, { status: "clear" });
    }
    if (isProcessIdentityAlive({ pid: gate.owner_pid, bootId: gate.owner_boot_id, startTicks: gate.owner_start_ticks })) {
      database.close();
      finish(10, { status: "active", error: "capture gate still has a live owner" });
    }
    database.query("DELETE FROM capture_delivery_gate WHERE singleton=1 AND token=?").run(gate.token);
    database.close();
    finish(0, { status: "recovered", prior_mode: gate.mode });
  }

  if (command === "hold") {
    const token = process.argv[3];
    if (!token) finish(1, { status: "error", error: "hold requires a token" });
    const held = database.query(
      "UPDATE capture_delivery_gate SET mode='held' WHERE singleton=1 AND token=?",
    ).run(token).changes;
    database.close();
    finish(held === 1 ? 0 : 1, held === 1
      ? { status: "held", token }
      : { status: "error", error: "capture drain token did not match" });
  }

  if (command === "check") {
    clearStaleGate();
    const recovered = recoverDeadDeliveries();
    const sending = sendingCount();
    const gate = database.query("SELECT token, mode FROM capture_delivery_gate WHERE singleton=1").get() as any;
    database.close();
    finish(sending > 0 || Boolean(gate) ? 10 : 0, {
      status: sending > 0 || gate ? "active" : "drained",
      sending_captures: sending,
      gate_claimed: Boolean(gate),
      gate_mode: gate?.mode || null,
      recovered_captures: recovered,
    });
  }

  const ownerPidFlag = process.argv.indexOf("--owner-pid");
  const ownerPid = Number(ownerPidFlag >= 0 ? process.argv[ownerPidFlag + 1] : NaN);
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 1 || !isAncestorProcess(ownerPid)) {
    database.close();
    finish(1, { status: "error", error: "claim requires --owner-pid with a live ancestor PID" });
  }
  const identity = processIdentity(ownerPid);
  const token = randomUUID();
  const adoptHeld = process.argv.includes("--adopt-held");
  const claim = database.transaction(() => {
    clearStaleGate();
    const recovered = recoverDeadDeliveries();
    const sending = sendingCount();
    if (sending > 0) return { claimed: false, sending, recovered, blocked: true };
    const existing = database.query("SELECT * FROM capture_delivery_gate WHERE singleton=1").get() as any;
    if (existing) {
      const existingOwnerAlive = isProcessIdentityAlive({
        pid: existing.owner_pid,
        bootId: existing.owner_boot_id,
        startTicks: existing.owner_start_ticks,
      });
      if (existing.mode !== "held" || existingOwnerAlive || !adoptHeld) {
        return { claimed: false, sending, recovered, blocked: true };
      }
      database.query(`
        UPDATE capture_delivery_gate
        SET token=?, owner_pid=?, owner_boot_id=?, owner_start_ticks=?,
            mode='live', claimed_at=CURRENT_TIMESTAMP
        WHERE singleton=1 AND token=? AND mode='held'
      `).run(token, identity.pid, identity.bootId, identity.startTicks, existing.token);
      const adopted = database.query("SELECT token FROM capture_delivery_gate WHERE singleton=1").get() as any;
      return { claimed: adopted?.token === token, sending, recovered, blocked: false };
    }
    database.query(`
      INSERT INTO capture_delivery_gate
        (singleton, token, owner_pid, owner_boot_id, owner_start_ticks, mode)
      VALUES (1, ?, ?, ?, ?, 'live')
      ON CONFLICT(singleton) DO NOTHING
    `).run(token, identity.pid, identity.bootId, identity.startTicks);
    const gate = database.query("SELECT token FROM capture_delivery_gate WHERE singleton=1").get() as any;
    return { claimed: gate?.token === token, sending, recovered, blocked: false };
  });
  const result = claim.immediate();
  database.close();
  if (!result.claimed) finish(result.blocked ? 10 : 1, {
    status: result.blocked ? "active" : "error",
    error: result.blocked ? undefined : "capture drain claim failed",
    sending_captures: result.sending,
    recovered_captures: result.recovered,
  });
  finish(0, { status: "claimed_drained", token, sending_captures: 0, recovered_captures: result.recovered });
} catch (error) {
  finish(1, { status: "error", error: error instanceof Error ? error.message : String(error) });
}
