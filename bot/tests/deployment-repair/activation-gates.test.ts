import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivationGateManager } from "../../../deployment-control/kernel/activation-gates";
import { currentProcessIdentity } from "../../src/runtime-identity";

let directory = "";
let applicationPath = "";
let capturePath = "";

function createApplicationDatabase() {
  const database = new Database(applicationPath, { create: true, strict: true });
  database.exec(`
    CREATE TABLE process_instances (
      instance_id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      boot_id TEXT NOT NULL,
      process_start_ticks TEXT NOT NULL
    );
    CREATE TABLE turns (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      owner_instance_id TEXT
    );
    CREATE TABLE deployment_drain (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      token TEXT NOT NULL,
      owner_pid INTEGER NOT NULL,
      owner_boot_id TEXT NOT NULL,
      owner_start_ticks TEXT NOT NULL,
      claimed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  database.close();
}

function createCaptureDatabase() {
  const database = new Database(capturePath, { create: true, strict: true });
  database.exec(`
    CREATE TABLE capture_events (
      event_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      next_attempt_ms INTEGER,
      delivery_error TEXT,
      delivery_owner_pid INTEGER,
      delivery_owner_boot_id TEXT,
      delivery_owner_start_ticks TEXT,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  database.close();
}

function manager() {
  return new ActivationGateManager({ applicationStatePath: applicationPath, captureStatePath: capturePath });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "concierge-activation-gates-"));
  applicationPath = join(directory, "application.db");
  capturePath = join(directory, "capture.db");
  createApplicationDatabase();
  createCaptureDatabase();
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("activation admission gates", () => {
  test("durably holds, verifies, and releases both exact tokens", () => {
    const gates = manager();
    expect(gates.hold({
      deploymentToken: "deployment-token",
      captureToken: "capture-token",
      owner: currentProcessIdentity(),
    })).toEqual({ status: "held", staleTurns: 0, recoveredCaptures: 0 });

    expect(gates.verify({ deploymentToken: "deployment-token", captureToken: "capture-token" }))
      .toEqual({ deployment: "held", capture: "held" });
    expect(gates.release({ deploymentToken: "deployment-token", captureToken: "capture-token" }))
      .toEqual({ deployment: "released", capture: "released" });
    expect(gates.release({ deploymentToken: "deployment-token", captureToken: "capture-token" }))
      .toEqual({ deployment: "released", capture: "released" });
  });

  test("waits for a live application turn before claiming either gate", () => {
    const identity = currentProcessIdentity();
    const database = new Database(applicationPath, { strict: true });
    database.query("INSERT INTO process_instances VALUES (?, ?, ?, ?)")
      .run("live", identity.pid, identity.bootId, identity.startTicks);
    database.query("INSERT INTO turns VALUES (1, 'running', 'live')").run();
    database.close();

    expect(manager().hold({ deploymentToken: "deployment-token", captureToken: "capture-token", owner: identity }))
      .toEqual({ status: "waiting", activeTurns: 1, sendingCaptures: 0 });
    const application = new Database(applicationPath, { readonly: true, strict: true });
    const capture = new Database(capturePath, { readonly: true, strict: true });
    expect(application.query("SELECT * FROM deployment_drain").get()).toBeNull();
    expect(capture.query("SELECT 1 FROM sqlite_master WHERE name='capture_delivery_gate'").get()).toBeNull();
    application.close();
    capture.close();
  });

  test("resumes a partial hold after a live capture finishes", () => {
    const identity = currentProcessIdentity();
    const capture = new Database(capturePath, { strict: true });
    capture.query(`INSERT INTO capture_events
      (event_id, status, delivery_owner_pid, delivery_owner_boot_id, delivery_owner_start_ticks)
      VALUES ('capture-1', 'sending', ?, ?, ?)`).run(identity.pid, identity.bootId, identity.startTicks);
    capture.close();

    const gates = manager();
    expect(gates.hold({ deploymentToken: "deployment-token", captureToken: "capture-token", owner: identity }))
      .toEqual({ status: "waiting", activeTurns: 0, sendingCaptures: 1 });
    const application = new Database(applicationPath, { readonly: true, strict: true });
    expect(application.query("SELECT token, mode FROM deployment_drain").get())
      .toEqual({ token: "deployment-token", mode: "held" });
    application.close();

    const reopenedCapture = new Database(capturePath, { strict: true });
    reopenedCapture.query("UPDATE capture_events SET status='sent' WHERE event_id='capture-1'").run();
    reopenedCapture.close();
    expect(gates.hold({ deploymentToken: "deployment-token", captureToken: "capture-token", owner: identity }))
      .toEqual({ status: "held", staleTurns: 0, recoveredCaptures: 0 });
  });

  test("recovers a dead capture owner and rejects a mismatched release", () => {
    const identity = currentProcessIdentity();
    const capture = new Database(capturePath, { strict: true });
    capture.query(`INSERT INTO capture_events
      (event_id, status, delivery_owner_pid, delivery_owner_boot_id, delivery_owner_start_ticks)
      VALUES ('capture-1', 'sending', 999999, 'dead-boot', 'dead-ticks')`).run();
    capture.close();

    const gates = manager();
    expect(gates.hold({ deploymentToken: "deployment-token", captureToken: "capture-token", owner: identity }))
      .toEqual({ status: "held", staleTurns: 0, recoveredCaptures: 1 });
    expect(() => gates.release({ deploymentToken: "wrong-token", captureToken: "capture-token" }))
      .toThrow("Application admission is no longer owned by this rollout");
    expect(gates.verify({ deploymentToken: "deployment-token", captureToken: "capture-token" }))
      .toEqual({ deployment: "held", capture: "held" });
  });
});
