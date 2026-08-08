import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { acquireDatabaseTestLock } from "./db-lock";

// CONCIERGE_STATE_DIR is set by tests/preload.ts; state.ts hard-refuses
// production paths under CONCIERGE_TEST_MODE=1. Destructive DELETEs
// below are safe by construction.
const state = require("../src/state");
const {
  acquireSessionTurn,
  attachComparisonThread,
  attachComparisonTurn,
  attachBotMessage,
  claimComparisonRequest,
  createOrGetSession,
  db,
  finishTurn,
  finishComparisonRequest,
  finishComparisonFromTurnOutcome,
  getSession,
  getSessionByUuid,
  listSessionUserPrompts,
  resolveComparisonSourceSession,
  reconcileComparisonRequests,
  resolveForkParentSession,
  setSessionStatus,
  setTurnReplayInput,
  upsertSession,
  interruptOrphanedTurn,
  listRecoverableTurns,
  markTurnDelivered,
  markTurnDelivering,
  markTurnProviderStarted,
  registerProcessInstance,
  clearAbandonedDrain,
  deliveredChunkIndexes,
  markDeliveryChunkDelivered,
} = state;

let releaseDatabaseTestLock: (() => void) | null = null;
beforeEach(async () => {
  releaseDatabaseTestLock = await acquireDatabaseTestLock();
  db.query("DELETE FROM deployment_drain").run();
  db.query("DELETE FROM comparison_requests").run();
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

describe("listSessionUserPrompts", () => {
  test("returns chronological user-only turns through the selected Slack message", () => {
    const session = createOrGetSession("C1", "123.000001", "codex");
    const first = acquireSessionTurn(session.id, "123.000001", "first prompt");
    setTurnReplayInput(first.id, "first prompt", 0);
    markTurnProviderStarted(first.id);
    finishTurn(first.id, "done", "first agent response");
    setSessionStatus(session.id, "idle");
    const second = acquireSessionTurn(session.id, "123.000003", "second prompt");
    setTurnReplayInput(second.id, "second prompt", 0);
    markTurnProviderStarted(second.id);
    finishTurn(second.id, "done", "second agent response");
    setSessionStatus(session.id, "idle");
    const later = acquireSessionTurn(session.id, "123.000007", "later prompt");
    setTurnReplayInput(later.id, "later prompt", 0);
    markTurnProviderStarted(later.id);
    finishTurn(later.id, "done", "later agent response");
    setSessionStatus(session.id, "idle");

    expect(listSessionUserPrompts(session.id, "123.000004")).toEqual([
      {
        slack_user_msg_ts: "123.000001", user_text: "first prompt",
        replay_ready: 1, status: "done", unreplayable_attachment_count: 0,
      },
      {
        slack_user_msg_ts: "123.000003", user_text: "second prompt",
        replay_ready: 1, status: "done", unreplayable_attachment_count: 0,
      },
    ]);
  });

  test("prefers canonical transcript replay text and marks non-audio files", () => {
    const session = createOrGetSession("C1", "124.000001", "codex");
    const turn = acquireSessionTurn(session.id, "124.000001", "");
    setTurnReplayInput(turn.id, "Audio clip transcription:\nspoken request", 1);
    markTurnProviderStarted(turn.id);
    finishTurn(turn.id, "done", "answer");

    expect(listSessionUserPrompts(session.id)).toEqual([{
      slack_user_msg_ts: "124.000001",
      user_text: "Audio clip transcription:\nspoken request",
      replay_ready: 1,
      status: "done",
      unreplayable_attachment_count: 1,
    }]);
  });

  test("does not substitute raw Slack text when canonical replay is unavailable", () => {
    const session = createOrGetSession("C1", "125.000001", "codex");
    const turn = acquireSessionTurn(session.id, "125.000001", "<@UBOT> raw request");
    finishTurn(turn.id, "error", "hydration failed");

    expect(listSessionUserPrompts(session.id)).toEqual([{
      slack_user_msg_ts: "125.000001",
      user_text: null,
      replay_ready: 0,
      status: "error",
      unreplayable_attachment_count: 0,
    }]);

    setTurnReplayInput(turn.id, "canonical but never sent", 0);
    expect(listSessionUserPrompts(session.id)[0]).toMatchObject({
      user_text: "canonical but never sent",
      replay_ready: 0,
    });
  });
});

describe("comparison request state", () => {
  test("resolves exact delivered message ownership before a colliding thread session", () => {
    upsertSession("C1", "123.000001", "codex", "old-thread", { status: "idle" });
    upsertSession("C1", "999.000001", "claude-code", "persistent", { status: "idle" });
    const persistent = getSession("C1", "999.000001", "claude-code");
    const turn = acquireSessionTurn(persistent.id, "123.000003", "persistent prompt");
    attachBotMessage(turn.id, "123.000004");
    markTurnDelivering(turn.id, "answer", "answer", 1);
    markDeliveryChunkDelivered(turn.id, 0, "123.000005");

    expect(resolveComparisonSourceSession("C1", "123.000005")?.agent_session_uuid)
      .toBe("persistent");
  });

  test("does not fall back to a thread session for an unowned message", () => {
    upsertSession("C1", "123.000001", "codex", "thread-session", { status: "idle" });

    expect(resolveComparisonSourceSession("C1", "123.000099")).toBeNull();
  });

  test("atomically claims one full-power run for duplicate modal submissions", async () => {
    const input = {
      requestId: "V123",
      channelId: "C1",
      requestedBy: "U1",
      sourceSessionId: 42,
      sourceMessageTs: "123.000004",
      targetProvider: "codex" as const,
      targetModel: "gpt-5.6-codex",
    };

    const attempts = await Promise.all([
      Promise.resolve().then(() => claimComparisonRequest(input)),
      Promise.resolve().then(() => claimComparisonRequest(input)),
    ]);
    expect(attempts.filter((attempt) => attempt.claimed)).toHaveLength(1);
    expect(attempts.filter((attempt) => !attempt.claimed)).toHaveLength(1);

    attachComparisonThread("V123", "200.000001");
    finishComparisonRequest("V123", "done");
    expect(db.query("SELECT status, comparison_thread_ts FROM comparison_requests WHERE request_id='V123'").get())
      .toEqual({ status: "done", comparison_thread_ts: "200.000001" });
  });

  test("records terminal turn outcomes on the durable request row", () => {
    const outcomes = [
      { requestId: "delivered", outcome: { status: "delivered" }, expected: "done" },
      { requestId: "draining", outcome: { status: "draining" }, expected: "error" },
      { requestId: "provider", outcome: { status: "error", error: "provider failed" }, expected: "error" },
      { requestId: "stopped", outcome: { status: "delivery_stopped" }, expected: "error" },
      { requestId: "parked", outcome: { status: "delivery_parked" }, expected: "error" },
    ];
    for (const entry of outcomes) {
      claimComparisonRequest({
        requestId: entry.requestId,
        channelId: "C1",
        requestedBy: "U1",
        sourceSessionId: 42,
        sourceMessageTs: "123.000004",
        targetProvider: "codex",
        targetModel: null,
      });
      finishComparisonFromTurnOutcome(entry.requestId, entry.outcome);
      expect((db.query("SELECT status FROM comparison_requests WHERE request_id=?")
        .get(entry.requestId) as any).status).toBe(entry.expected);
    }
  });

  test("reconciles comparison requests after claim, provider, and delivery crashes", () => {
    claimComparisonRequest({
      requestId: "claim-crash", channelId: "C1", requestedBy: "U1", sourceSessionId: 1,
      sourceMessageTs: "1", targetProvider: "codex", targetModel: null,
    });

    const providerSession = createOrGetSession("C1", "200.000001", "codex");
    const providerTurn = acquireSessionTurn(providerSession.id, "200.000001", "provider crash");
    claimComparisonRequest({
      requestId: "provider-crash", channelId: "C1", requestedBy: "U1", sourceSessionId: 1,
      sourceMessageTs: "2", targetProvider: "codex", targetModel: null,
    });
    attachComparisonTurn("provider-crash", providerTurn.id);
    finishTurn(providerTurn.id, "interrupted", "service stopped");

    const deliverySession = createOrGetSession("C1", "300.000001", "codex");
    const deliveryTurn = acquireSessionTurn(deliverySession.id, "300.000001", "delivery crash");
    claimComparisonRequest({
      requestId: "delivery-crash", channelId: "C1", requestedBy: "U1", sourceSessionId: 1,
      sourceMessageTs: "3", targetProvider: "codex", targetModel: null,
    });
    attachComparisonTurn("delivery-crash", deliveryTurn.id);
    markTurnDelivering(deliveryTurn.id, "answer", "answer", 1);
    markTurnDelivered(deliveryTurn.id);

    expect(reconcileComparisonRequests()).toEqual({ done: 1, error: 2, pending: 0 });
    expect(db.query("SELECT request_id, status FROM comparison_requests ORDER BY request_id").all()).toEqual([
      { request_id: "claim-crash", status: "error" },
      { request_id: "delivery-crash", status: "done" },
      { request_id: "provider-crash", status: "error" },
    ]);
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
