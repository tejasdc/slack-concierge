import { beforeEach, describe, expect, test } from "bun:test";

process.env.CONCIERGE_STATE_DIR = "/tmp/concierge-state-fork-lock-test";

const state = require("../src/state");
const {
  acquireSessionTurn,
  attachBotMessage,
  createOrGetSession,
  db,
  finishTurn,
  getSession,
  resolveForkParentSession,
  setSessionStatus,
  upsertSession,
} = state;

beforeEach(() => {
  db.query("DELETE FROM turns").run();
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM channels").run();
});

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
});
