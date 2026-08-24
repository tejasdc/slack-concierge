import { Database } from "bun:sqlite";
import { isProcessIdentityAlive, type ProcessIdentity } from "../../bot/src/runtime-identity";

export interface ActivationGateEnvironment {
  applicationStatePath: string;
  captureStatePath: string;
}

export type ActivationGateHoldOutcome =
  | { status: "held"; staleTurns: number; recoveredCaptures: number }
  | { status: "waiting"; activeTurns: number; sendingCaptures: number };

function addColumn(database: Database, table: string, name: string, declaration: string) {
  const columns = database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === name)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
  }
}

function holdApplicationGate(path: string, token: string, owner: ProcessIdentity) {
  const database = new Database(path, { create: false, strict: true });
  database.exec("PRAGMA busy_timeout=5000");
  try {
    addColumn(database, "deployment_drain", "mode", "TEXT NOT NULL DEFAULT 'live' CHECK(mode IN ('live', 'held'))");
    return database.transaction(() => {
      const turns = database.query(`SELECT t.id, p.pid, p.boot_id, p.process_start_ticks
        FROM turns t LEFT JOIN process_instances p ON p.instance_id=t.owner_instance_id
        WHERE t.status IN ('running', 'delivering')`).all() as Array<{
        id: number;
        pid: number | null;
        boot_id: string | null;
        process_start_ticks: string | null;
      }>;
      const activeTurns = turns.filter((turn) => isProcessIdentityAlive({
        pid: turn.pid || 0,
        bootId: turn.boot_id || "",
        startTicks: turn.process_start_ticks || "",
      })).length;
      if (activeTurns) return { held: false, activeTurns, staleTurns: turns.length - activeTurns };
      const existing = database.query("SELECT * FROM deployment_drain WHERE singleton=1").get() as any;
      if (existing?.token === token && existing.mode === "held") {
        return { held: true, activeTurns: 0, staleTurns: turns.length };
      }
      if (existing) {
        const alive = isProcessIdentityAlive({
          pid: existing.owner_pid,
          bootId: existing.owner_boot_id,
          startTicks: existing.owner_start_ticks,
        });
        if (existing.mode === "held" || alive) {
          throw new Error("Application admission is owned by another live or durable hold.");
        }
        database.query("DELETE FROM deployment_drain WHERE singleton=1 AND token=?").run(existing.token);
      }
      database.query(`INSERT INTO deployment_drain
        (singleton, token, owner_pid, owner_boot_id, owner_start_ticks, mode)
        VALUES (1, ?, ?, ?, ?, 'held')`).run(
        token,
        owner.pid,
        owner.bootId,
        owner.startTicks,
      );
      return { held: true, activeTurns: 0, staleTurns: turns.length };
    }).immediate();
  } finally {
    database.close();
  }
}

function holdCaptureGate(path: string, token: string, owner: ProcessIdentity) {
  const database = new Database(path, { create: true, strict: true });
  database.exec("PRAGMA busy_timeout=5000");
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS capture_delivery_gate (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), token TEXT NOT NULL,
      owner_pid INTEGER NOT NULL, owner_boot_id TEXT NOT NULL, owner_start_ticks TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'live' CHECK(mode IN ('live', 'held')),
      claimed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    addColumn(database, "capture_delivery_gate", "mode", "TEXT NOT NULL DEFAULT 'live' CHECK(mode IN ('live', 'held'))");
    const hasEvents = Boolean(database.query(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='capture_events'",
    ).get());
    return database.transaction(() => {
      let recoveredCaptures = 0;
      if (hasEvents) {
        const sending = database.query(`SELECT event_id, delivery_owner_pid, delivery_owner_boot_id,
          delivery_owner_start_ticks FROM capture_events WHERE status='sending'`).all() as Array<any>;
        for (const event of sending) {
          if (isProcessIdentityAlive({
            pid: event.delivery_owner_pid || 0,
            bootId: event.delivery_owner_boot_id || "",
            startTicks: event.delivery_owner_start_ticks || "",
          })) continue;
          recoveredCaptures += database.query(`UPDATE capture_events SET status='pending',
            next_attempt_ms=NULL, delivery_error=COALESCE(delivery_error, 'delivery owner exited before completion'),
            delivery_owner_pid=NULL, delivery_owner_boot_id=NULL, delivery_owner_start_ticks=NULL,
            updated_at=CURRENT_TIMESTAMP WHERE event_id=? AND status='sending'`).run(event.event_id).changes;
        }
        const active = Number((database.query(
          "SELECT COUNT(*) AS count FROM capture_events WHERE status='sending'",
        ).get() as any).count);
        if (active) return { held: false, sendingCaptures: active, recoveredCaptures };
      }
      const existing = database.query("SELECT * FROM capture_delivery_gate WHERE singleton=1").get() as any;
      if (existing?.token === token && existing.mode === "held") {
        return { held: true, sendingCaptures: 0, recoveredCaptures };
      }
      if (existing) {
        const alive = isProcessIdentityAlive({
          pid: existing.owner_pid,
          bootId: existing.owner_boot_id,
          startTicks: existing.owner_start_ticks,
        });
        if (existing.mode === "held" || alive) {
          throw new Error("Capture admission is owned by another live or durable hold.");
        }
        database.query("DELETE FROM capture_delivery_gate WHERE singleton=1 AND token=?").run(existing.token);
      }
      database.query(`INSERT INTO capture_delivery_gate
        (singleton, token, owner_pid, owner_boot_id, owner_start_ticks, mode)
        VALUES (1, ?, ?, ?, ?, 'held')`).run(token, owner.pid, owner.bootId, owner.startTicks);
      return { held: true, sendingCaptures: 0, recoveredCaptures };
    }).immediate();
  } finally {
    database.close();
  }
}

export class ActivationGateManager {
  constructor(readonly environment: ActivationGateEnvironment) {}

  hold(input: {
    deploymentToken: string;
    captureToken: string;
    owner: ProcessIdentity;
  }): ActivationGateHoldOutcome {
    const application = holdApplicationGate(
      this.environment.applicationStatePath,
      input.deploymentToken,
      input.owner,
    );
    if (!application.held) {
      return { status: "waiting", activeTurns: application.activeTurns, sendingCaptures: 0 };
    }
    const capture = holdCaptureGate(this.environment.captureStatePath, input.captureToken, input.owner);
    if (!capture.held) {
      return { status: "waiting", activeTurns: 0, sendingCaptures: capture.sendingCaptures };
    }
    return {
      status: "held",
      staleTurns: application.staleTurns,
      recoveredCaptures: capture.recoveredCaptures,
    };
  }

  verify(input: { deploymentToken: string; captureToken: string }) {
    const application = new Database(this.environment.applicationStatePath, { readonly: true, strict: true });
    const capture = new Database(this.environment.captureStatePath, { readonly: true, strict: true });
    try {
      const deploymentGate = application.query(
        "SELECT token, mode FROM deployment_drain WHERE singleton=1",
      ).get() as any;
      const captureGate = capture.query(
        "SELECT token, mode FROM capture_delivery_gate WHERE singleton=1",
      ).get() as any;
      if (deploymentGate?.token !== input.deploymentToken || deploymentGate.mode !== "held"
        || captureGate?.token !== input.captureToken || captureGate.mode !== "held") {
        throw new Error("Activation admission hold no longer matches both exact durable tokens.");
      }
      return { deployment: "held", capture: "held" };
    } finally {
      application.close();
      capture.close();
    }
  }

  inspectOwned(input: { deploymentToken: string; captureToken: string }) {
    const application = new Database(this.environment.applicationStatePath, { readonly: true, strict: true });
    const capture = new Database(this.environment.captureStatePath, { readonly: true, strict: true });
    try {
      const deploymentGate = application.query(
        "SELECT token, mode FROM deployment_drain WHERE singleton=1",
      ).get() as any;
      const captureGate = capture.query(
        "SELECT token, mode FROM capture_delivery_gate WHERE singleton=1",
      ).get() as any;
      if (deploymentGate && (deploymentGate.token !== input.deploymentToken || deploymentGate.mode !== "held")) {
        throw new Error("Application admission is no longer owned by this rollout.");
      }
      if (captureGate && (captureGate.token !== input.captureToken || captureGate.mode !== "held")) {
        throw new Error("Capture admission is no longer owned by this rollout.");
      }
      return {
        deployment: deploymentGate ? "held" : "absent",
        capture: captureGate ? "held" : "absent",
      } as const;
    } finally {
      application.close();
      capture.close();
    }
  }

  release(input: { deploymentToken: string; captureToken: string }) {
    const application = new Database(this.environment.applicationStatePath, { create: false, strict: true });
    const capture = new Database(this.environment.captureStatePath, { create: false, strict: true });
    try {
      this.inspectOwned(input);
      application.query("DELETE FROM deployment_drain WHERE singleton=1 AND token=? AND mode='held'")
        .run(input.deploymentToken);
      capture.query("DELETE FROM capture_delivery_gate WHERE singleton=1 AND token=? AND mode='held'")
        .run(input.captureToken);
      return { deployment: "released", capture: "released" };
    } finally {
      application.close();
      capture.close();
    }
  }
}
