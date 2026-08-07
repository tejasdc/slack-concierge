import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { acquireDatabaseTestLock } from "./db-lock";

// CONCIERGE_STATE_DIR is set by tests/preload.ts; state.ts hard-refuses
// production paths under CONCIERGE_TEST_MODE=1. Destructive DELETEs
// below are safe by construction.
const state = require("../src/state");
const {
  acquireSessionTurn,
  attachBotMessage,
  createOrGetSession,
  db,
  finishTurn,
  getSession,
  getSessionByUuid,
  resolveForkParentSession,
  setSessionStatus,
  upsertSession,
  interruptOrphanedTurn,
  listRecoverableTurns,
  markTurnDelivered,
  markTurnDelivering,
  registerProcessInstance,
  clearAbandonedDrain,
  deliveredChunkIndexes,
  markDeliveryChunkDelivered,
} = state;

let releaseDatabaseTestLock: (() => void) | null = null;
beforeEach(async () => {
  releaseDatabaseTestLock = await acquireDatabaseTestLock();
  db.query("DELETE FROM deployment_drain").run();
  db.query("DELETE FROM turn_delivery_chunks").run();
  db.query("DELETE FROM turns").run();
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM process_instances").run();
  db.query("DELETE FROM channels").run();
});
afterEach(() => { releaseDatabaseTestLock?.(); releaseDatabaseTestLock = null; });

describe("resolveForkParentSession", () => {
  test("uses the supplied thread timestamp instead of the latest channel session", () => {
    upsertSession("C1", "111.000001", "codex", "parent-old", { status: "idle" });
    upsertSession("C1", "222.000001", "codex", "parent-latest", { status: "idle" });
    db.query("UPDATE sessions SET last_turn_at='2026-08-05 10:00:00' WHERE slack_thread_ts='111.000001'").run();
    db.query("UPDATE sessions SET last_turn_at='2026-08-05 11:00:00' WHERE slack_thread_ts='222.000001'").run();

    const parent = resolveForkParentSession("C1", "111.000001");

    expect(parent?.slack_thread_ts).toBe("111.000001");
    expect(parent?.agent_session_uuid).toBe("parent-old");
  });

  test("maps a supplied message timestamp through turns to its owning session", () => {
    upsertSession("C1", "111.000001", "codex", "parent-old", { status: "idle" });
    upsertSession("C1", "222.000001", "codex", "parent-latest", { status: "idle" });
    const selected = getSession("C1", "111.000001", "codex");
    const turn = acquireSessionTurn(selected.id, "111.000009", "reply in older thread");
    attachBotMessage(turn.id, "111.000010");
    finishTurn(turn.id, "done", "done");
    setSessionStatus(selected.id, "idle");

    expect(resolveForkParentSession("C1", "111.000009")?.agent_session_uuid).toBe("parent-old");
    expect(resolveForkParentSession("C1", "111.000010")?.agent_session_uuid).toBe("parent-old");
  });
});

describe("getSessionByUuid", () => {
  test("scopes a persistent session lookup to its Slack channel", () => {
    upsertSession("C1", "111.000001", "codex", "persistent-session", { status: "idle" });

    expect(getSessionByUuid("C1", "persistent-session")?.slack_thread_ts).toBe("111.000001");
    expect(getSessionByUuid("C2", "persistent-session")).toBeNull();
  });
});

describe("acquireSessionTurn", () => {
  test("rejects a second rapid turn while the same session is running", () => {
    const session = createOrGetSession("C1", "333.000001", "codex");

    const first = acquireSessionTurn(session.id, "333.000002", "first");
    const second = acquireSessionTurn(session.id, "333.000003", "second");
    const runningTurns = db.query("SELECT COUNT(*) AS count FROM turns WHERE status='running'").get() as any;
    const cancelledTurns = db.query("SELECT COUNT(*) AS count FROM turns WHERE status='cancelled'").get() as any;

    expect(first).toMatchObject({ duplicate: false, acquired: true, busy: false });
    expect(second).toMatchObject({ duplicate: false, acquired: false, busy: true });
    expect(runningTurns.count).toBe(1);
    expect(cancelledTurns.count).toBe(1);
    expect((db.query("SELECT status FROM sessions WHERE id=?").get(session.id) as any).status).toBe("running");
  });

  test("atomically refuses admission while a deployment drain is claimed", () => {
    const session = createOrGetSession("C1", "444.000001", "codex");
    db.query(`INSERT INTO deployment_drain
      (singleton, token, owner_pid, owner_boot_id, owner_start_ticks)
      VALUES (1, 'deploy-token', 123, 'boot', '456')`).run();

    const turn = acquireSessionTurn(session.id, "444.000002", "during deploy", "runtime-1");

    expect(turn).toMatchObject({ acquired: false, draining: true });
    expect((db.query("SELECT COUNT(*) AS count FROM turns").get() as any).count).toBe(0);
  });

  test("persists exact process ownership for a running turn", () => {
    registerProcessInstance("runtime-1", 123, "boot-1", "ticks-1");
    const session = createOrGetSession("C1", "555.000001", "codex");

    acquireSessionTurn(session.id, "555.000002", "owned", "runtime-1");

    expect(listRecoverableTurns()[0]).toMatchObject({
      owner_instance_id: "runtime-1", owner_pid: 123,
      owner_boot_id: "boot-1", owner_process_start_ticks: "ticks-1",
    });
  });
});

describe("turn recovery and delivery", () => {
  test("interrupts an orphaned provider turn and releases its session", () => {
    const session = createOrGetSession("C1", "666.000001", "codex");
    const turn = acquireSessionTurn(session.id, "666.000002", "work", "dead-runtime");

    interruptOrphanedTurn(turn.id, "dead-runtime", "service stopped");

    expect((db.query("SELECT status, delivery_status FROM turns WHERE id=?").get(turn.id) as any))
      .toMatchObject({ status: "interrupted", delivery_status: "not_available" });
    expect((db.query("SELECT status FROM sessions WHERE id=?").get(session.id) as any).status).toBe("idle");
  });

  test("keeps completion pending until Slack delivery is durably recorded", () => {
    const session = createOrGetSession("C1", "777.000001", "codex");
    const turn = acquireSessionTurn(session.id, "777.000002", "work", "runtime-1");

    markTurnDelivering(turn.id, "finished output", "rendered output", 3);
    expect((db.query("SELECT status, delivery_status, agent_text FROM turns WHERE id=?").get(turn.id) as any))
      .toMatchObject({ status: "delivering", delivery_status: "pending", agent_text: "finished output" });
    expect((db.query("SELECT status FROM sessions WHERE id=?").get(session.id) as any).status).toBe("running");

    markDeliveryChunkDelivered(turn.id, 0, "777.000003");
    expect([...deliveredChunkIndexes(turn.id)]).toEqual([0]);

    markTurnDelivered(turn.id);
    expect((db.query("SELECT status, delivery_status, delivered_at FROM turns WHERE id=?").get(turn.id) as any))
      .toMatchObject({ status: "done", delivery_status: "delivered" });
    expect((db.query("SELECT status FROM sessions WHERE id=?").get(session.id) as any).status).toBe("idle");
  });
});

describe("deployment drain ownership", () => {
  test("survives startup while its exact deploy owner lives and clears after it dies", () => {
    db.query(`INSERT INTO deployment_drain
      (singleton, token, owner_pid, owner_boot_id, owner_start_ticks)
      VALUES (1, 'deploy-token', 321, 'boot-1', 'ticks-1')`).run();

    clearAbandonedDrain((identity: any) => identity.pid === 321 && identity.bootId === "boot-1" && identity.startTicks === "ticks-1");
    expect(db.query("SELECT token FROM deployment_drain WHERE singleton=1").get()).toEqual({ token: "deploy-token" });

    clearAbandonedDrain(() => false);
    expect(db.query("SELECT token FROM deployment_drain WHERE singleton=1").get()).toBeNull();
  });
});
