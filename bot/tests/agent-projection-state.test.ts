import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { acquireDatabaseTestLock } from "./db-lock";

const state = require("../src/state");
const {
  acquireSessionTurn,
  beginTurnProgressStream,
  claimSlackRootSummaryProjection,
  claimSlackAgentSessionStatusProjection,
  claimSlackAgentSessionTitleProjection,
  claimNextQueuedTurn,
  createOrGetSession,
  db,
  getSlackRootSummaryProjection,
  getSlackAgentSessionStatusProjection,
  getSlackAgentSessionTitleProjection,
  getAgentSessionDashboardRowForUser,
  getTurnProgressStream,
  getTurnStatusProjection,
  listPendingTurnStatusProjections,
  markTurnStatusProjectionDelivered,
  markTurnDelivering,
  markSlackRootSummaryProjectionDelivered,
  parkSlackRootSummaryProjection,
  markSlackAgentSessionStatusProjectionDelivered,
  markSlackAgentSessionTitleProjectionDelivered,
  markTurnProgressStreamStopped,
  recordTurnProgressStreamStarted,
  recordTurnProgressActivity,
  requestAgentStopForSession,
  requestSlackRootSummaryProjection,
  requestTurnStatusProjection,
  requeueParkedSlackRootSummaryLengthFailures,
  requeueParkedComparisonRootOwnershipFailures,
  getComparisonRequestForRoot,
  rewriteSlackRootSummaryProjectionText,
  requestSlackAgentSessionStatusProjection,
  requestSlackAgentSessionTitleProjection,
  observeSlackAgentSessionTitle,
  requestTurnProgressStreamStop,
  retryRunningTurnAfterProviderFailure,
  sessionOwnsCompletedProviderTurn,
  upsertChannel,
} = state;

let releaseDatabaseLock: (() => void) | null = null;

beforeEach(async () => {
  releaseDatabaseLock = await acquireDatabaseTestLock();
  db.query("DELETE FROM slack_agent_session_status_projections").run();
  db.query("DELETE FROM slack_agent_session_title_projections").run();
  db.query("DELETE FROM slack_root_summary_projections").run();
  db.query("DELETE FROM comparison_requests").run();
  db.query("DELETE FROM slack_user_input_claims").run();
  db.query("DELETE FROM turn_delivery_chunks").run();
  db.query("DELETE FROM turns").run();
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM channels").run();
  upsertChannel({
    slack_channel_id: "C-agent",
    slack_channel_name: "agent",
    group_name: null,
    name: "Agent",
    vault_path: "/tmp/agent-projection",
    code_path: "/tmp/agent-projection",
  });
});

afterEach(() => {
  releaseDatabaseLock?.();
  releaseDatabaseLock = null;
});

function createAgentTurn() {
  const session = createOrGetSession("C-agent", "100.000001", "codex");
  const turn = acquireSessionTurn(
    session.id,
    "100.000001",
    "Build the feature",
    "runtime-1",
    undefined,
    "100.000001",
    { userId: "U1", projectionMode: "agent" },
  );
  expect(turn.acquired).toBeTrue();
  return turn.id;
}

describe("Agent projection state", () => {
  test("binds Stop to the exact turn, channel, thread, and event boundary", () => {
    const turnId = createAgentTurn();
    expect(beginTurnProgressStream(turnId).progress_stream_state).toBe("starting");
    expect(recordTurnProgressStreamStarted(turnId, "100.000010").progress_stream_state).toBe("streaming");

    expect(requestAgentStopForSession({
      turnId,
      channel: "C-agent",
      threadTs: "100.000001",
      eventTs: "100.000009",
    })).toBeFalse();
    expect(requestAgentStopForSession({
      turnId,
      channel: "C-agent",
      threadTs: "100.000001",
      eventTs: "100.000010",
    })).toBeTrue();
    expect(getTurnProgressStream(turnId).stop_requested_at).not.toBeNull();
    expect(requestTurnProgressStreamStop(turnId).progress_stream_state).toBe("stopping");
    expect(markTurnProgressStreamStopped(turnId).progress_stream_state).toBe("stopped");
  });

  test("lets a persisted Stop win atomically over response delivery", () => {
    const turnId = createAgentTurn();
    beginTurnProgressStream(turnId);
    recordTurnProgressStreamStarted(turnId, "100.000010");
    expect(requestAgentStopForSession({
      turnId,
      channel: "C-agent",
      threadTs: "100.000001",
      eventTs: "100.000010",
    })).toBeTrue();

    expect(markTurnDelivering(turnId, "final", "final", 1, "final")).toBeFalse();
    expect(db.query("SELECT status FROM turns WHERE id=?").get(turnId)).toMatchObject({ status: "running" });
    expect(db.query("SELECT COUNT(*) AS count FROM turn_delivery_chunks WHERE turn_id=?").get(turnId))
      .toMatchObject({ count: 0 });
  });

  test("reuses the same durable stream when a provider retry reclaims the turn", () => {
    const turnId = createAgentTurn();
    beginTurnProgressStream(turnId);
    recordTurnProgressStreamStarted(turnId, "100.000020", "activity-original");
    const attempt = db.query("SELECT dispatch_attempt FROM turns WHERE id=?").get(turnId) as {
      dispatch_attempt: number;
    };
    expect(retryRunningTurnAfterProviderFailure({
      turnId,
      ownerInstanceId: "runtime-1",
      dispatchAttempt: attempt.dispatch_attempt,
      error: "temporary provider outage",
      nextAttemptMs: 0,
    })).toBeTrue();

    expect(claimNextQueuedTurn("runtime-2", Date.now())?.turn_id).toBe(turnId);
    expect(getTurnProgressStream(turnId)).toMatchObject({
      progress_stream_ts: "100.000020",
      progress_stream_state: "streaming",
      progress_activity_id: "activity-original",
    });
  });

  test("records text boundaries only for the exact open stream", () => {
    const turnId = createAgentTurn();
    beginTurnProgressStream(turnId);
    recordTurnProgressStreamStarted(turnId, "100.000020", "activity-original");
    expect(() => recordTurnProgressActivity(turnId, "wrong-stream", null)).toThrow("no longer owns");
    expect(getTurnProgressStream(turnId).progress_activity_id).toBe("activity-original");
    recordTurnProgressActivity(turnId, "100.000020", null);
    expect(getTurnProgressStream(turnId).progress_activity_id).toBeNull();
    recordTurnProgressActivity(turnId, "100.000020", "activity-after-text");
    requestTurnProgressStreamStop(turnId);
    markTurnProgressStreamStopped(turnId);
    expect(() => recordTurnProgressActivity(turnId, "100.000020", "late")).toThrow("no longer owns");
    expect(getTurnProgressStream(turnId).progress_activity_id).toBe("activity-after-text");
  });

  test("keeps root summaries monotonic by desired revision", () => {
    const turnId = createAgentTurn();
    const first = requestSlackRootSummaryProjection({
      channel: "C-agent",
      threadTs: "100.000001",
      turnId,
      text: "Concierge TL;DR: First",
    });
    const claimed = claimSlackRootSummaryProjection("C-agent", "100.000001", Date.now());
    expect(claimed?.desired_revision).toBe(first.desired_revision);
    const second = requestSlackRootSummaryProjection({
      channel: "C-agent",
      threadTs: "100.000001",
      turnId,
      text: "Concierge TL;DR: Latest",
    });
    markSlackRootSummaryProjectionDelivered(
      "C-agent",
      "100.000001",
      claimed.desired_revision,
    );
    expect(getSlackRootSummaryProjection("C-agent", "100.000001")).toMatchObject({
      desired_text: "Concierge TL;DR: Latest",
      desired_revision: second.desired_revision,
      projected_revision: first.desired_revision,
      projection_status: "pending",
    });
  });

  test("requeues only deterministic root-summary length failures and rewrites the claimed payload", () => {
    const turnId = createAgentTurn();
    requestSlackRootSummaryProjection({
      channel: "C-agent",
      threadTs: "100.000001",
      turnId,
      text: "oversized root",
    });
    const claimed = claimSlackRootSummaryProjection("C-agent", "100.000001", Date.now())!;
    parkSlackRootSummaryProjection(
      "C-agent",
      "100.000001",
      claimed.desired_revision,
      "Error: An API error occurred: msg_too_long",
    );
    db.query(`
      UPDATE slack_root_summary_projections
      SET historical_length_repair_attempted=0
      WHERE slack_channel_id='C-agent' AND slack_thread_ts='100.000001'
    `).run();
    requestSlackRootSummaryProjection({
      channel: "C-agent",
      threadTs: "100.000002",
      turnId,
      text: "uneditable root",
    });
    const unrelated = claimSlackRootSummaryProjection("C-agent", "100.000002", Date.now())!;
    parkSlackRootSummaryProjection(
      "C-agent",
      "100.000002",
      unrelated.desired_revision,
      "Error: cant_update_message",
    );

    const requeued = requeueParkedSlackRootSummaryLengthFailures();

    expect(requeued).toHaveLength(1);
    expect(requeued[0]).toMatchObject({
      slack_thread_ts: "100.000001",
      projection_status: "pending",
      projection_attempts: 0,
      projection_error: null,
    });
    expect(getSlackRootSummaryProjection("C-agent", "100.000002")).toMatchObject({
      projection_status: "parked",
      projection_error: "Error: cant_update_message",
    });
    const repairedClaim = claimSlackRootSummaryProjection("C-agent", "100.000001", Date.now())!;
    expect(rewriteSlackRootSummaryProjectionText(
      "C-agent",
      "100.000001",
      repairedClaim.desired_revision,
      "fitted root",
    )).toBeTrue();
    expect(getSlackRootSummaryProjection("C-agent", "100.000001")?.desired_text)
      .toBe("fitted root");
    parkSlackRootSummaryProjection(
      "C-agent",
      "100.000001",
      repairedClaim.desired_revision,
      "Error: An API error occurred: msg_too_long",
    );
    expect(requeueParkedSlackRootSummaryLengthFailures()).toEqual([]);
  });

  test("repairs only historical bot-authored comparison roots once and keeps newer revisions monotonic", () => {
    const turnId = createAgentTurn();
    const root = "100.000011";
    db.query(`
      INSERT INTO comparison_requests (request_id, slack_channel_id, requested_by,
        source_session_id, source_message_ts, target_provider, comparison_thread_ts)
      VALUES ('comparison-repair', 'C-agent', 'U-human', 1, '99.000011', 'codex', ?)
    `).run(root);
    expect(getComparisonRequestForRoot("C-agent", root)?.request_id).toBe("comparison-repair");
    requestSlackRootSummaryProjection({ channel: "C-agent", threadTs: root, turnId, text: "old TL;DR" });
    const previous = claimSlackRootSummaryProjection("C-agent", root, Date.now())!;
    parkSlackRootSummaryProjection("C-agent", root, previous.desired_revision, "Error: cant_update_message");
    db.query(`
      UPDATE slack_root_summary_projections SET comparison_ownership_repair_attempted=0
      WHERE slack_channel_id='C-agent' AND slack_thread_ts=?
    `).run(root);
    const unrelatedRoot = "100.000012";
    requestSlackRootSummaryProjection({ channel: "C-agent", threadTs: unrelatedRoot, turnId, text: "other" });
    const unrelated = claimSlackRootSummaryProjection("C-agent", unrelatedRoot, Date.now())!;
    parkSlackRootSummaryProjection("C-agent", unrelatedRoot, unrelated.desired_revision, "Error: cant_update_message");

    const repaired = requeueParkedComparisonRootOwnershipFailures();
    expect(repaired).toHaveLength(1);
    expect(repaired[0]).toMatchObject({ slack_thread_ts: root, projection_status: "pending", projection_attempts: 0 });
    const claimed = claimSlackRootSummaryProjection("C-agent", root, Date.now())!;
    requestSlackRootSummaryProjection({ channel: "C-agent", threadTs: root, turnId, text: "new TL;DR" });
    markSlackRootSummaryProjectionDelivered("C-agent", root, claimed.desired_revision);
    expect(getSlackRootSummaryProjection("C-agent", root)).toMatchObject({
      desired_text: "new TL;DR", projection_status: "pending", projected_revision: claimed.desired_revision,
    });
    const latest = claimSlackRootSummaryProjection("C-agent", root, Date.now())!;
    parkSlackRootSummaryProjection("C-agent", root, latest.desired_revision, "Error: cant_update_message");
    expect(requeueParkedComparisonRootOwnershipFailures()).toEqual([]);
    expect(getSlackRootSummaryProjection("C-agent", unrelatedRoot)?.projection_status).toBe("parked");
  });

  test("persists an in-thread warning when an interrupted comparison repair parks after restart", () => {
    const turnId = createAgentTurn();
    db.query("UPDATE turns SET status='done', delivery_status='delivered' WHERE id=?").run(turnId);
    const root = "100.000021";
    db.query(`
      INSERT INTO comparison_requests (request_id, slack_channel_id, requested_by,
        source_session_id, source_message_ts, target_provider, comparison_thread_ts)
      VALUES ('comparison-interrupted', 'C-agent', 'U1', 1, '99.000021', 'codex', ?)
    `).run(root);
    requestSlackRootSummaryProjection({ channel: "C-agent", threadTs: root, turnId, text: "old summary" });
    const historicalClaim = claimSlackRootSummaryProjection("C-agent", root, Date.now())!;
    parkSlackRootSummaryProjection("C-agent", root, historicalClaim.desired_revision, "Error: cant_update_message");
    db.query(`
      UPDATE turns SET status_desired_text=NULL, status_desired_revision=0,
        status_projection_status='not_needed' WHERE id=?
    `).run(turnId);
    db.query(`
      UPDATE slack_root_summary_projections SET comparison_ownership_repair_attempted=0
      WHERE slack_channel_id='C-agent' AND slack_thread_ts=?
    `).run(root);

    expect(requeueParkedComparisonRootOwnershipFailures()).toHaveLength(1);
    expect(getSlackRootSummaryProjection("C-agent", root)?.projection_status).toBe("pending");
    expect(requeueParkedComparisonRootOwnershipFailures()).toEqual([]);

    const resumed = claimSlackRootSummaryProjection("C-agent", root, Date.now())!;
    parkSlackRootSummaryProjection("C-agent", root, resumed.desired_revision, "Error: cant_update_message");
    const notice = getTurnStatusProjection(turnId)!;
    expect(notice.projection_status).toBe("pending");
    expect(notice.desired_text).toContain(":warning: *Concierge sync error — Slack display out of date*");
    expect(notice.desired_text).toContain("Use the latest final response for current context; no resend is needed.");
    expect(listPendingTurnStatusProjections().map((row) => row.turn_id)).toContain(turnId);
    expect(getSlackRootSummaryProjection("C-agent", root)?.projection_status).toBe("parked");
    expect(requeueParkedComparisonRootOwnershipFailures()).toEqual([]);

    requestTurnStatusProjection(turnId, "Later terminal status with both errors");
    markTurnStatusProjectionDelivered(turnId, notice.desired_revision);
    expect(getTurnStatusProjection(turnId)).toMatchObject({
      desired_text: "Later terminal status with both errors",
      projection_status: "pending",
      projected_revision: notice.desired_revision,
    });
  });

  test("does not let an older processing heartbeat overwrite terminal active status", () => {
    const processing = requestSlackAgentSessionStatusProjection({
      channel: "C-agent",
      threadTs: "100.000001",
      status: "processing",
      initiatorUserId: "U-human",
      initialTitle: "Audit the Agent Sessions UI",
    });
    const claimed = claimSlackAgentSessionStatusProjection("C-agent", "100.000001", Date.now())!;
    expect(claimed.desired_revision).toBe(processing.desired_revision);
    const active = requestSlackAgentSessionStatusProjection({
      channel: "C-agent",
      threadTs: "100.000001",
      status: "active",
      initialTitle: "A later title must not replace the first",
    });
    markSlackAgentSessionStatusProjectionDelivered(
      "C-agent",
      "100.000001",
      claimed.desired_revision,
    );

    expect(getSlackAgentSessionStatusProjection("C-agent", "100.000001")).toMatchObject({
      desired_status: "active",
      initiator_user_id: "U-human",
      initial_title: "Audit the Agent Sessions UI",
      desired_revision: active.desired_revision,
      projected_revision: processing.desired_revision,
      projection_status: "pending",
    });
  });

  test("keeps dashboard renames monotonic and accepts native Slack title changes", () => {
    requestSlackAgentSessionTitleProjection({
      channel: "C-agent",
      threadTs: "100.000001",
      title: "First name",
    });
    const claimed = claimSlackAgentSessionTitleProjection("C-agent", "100.000001", Date.now())!;
    const latest = requestSlackAgentSessionTitleProjection({
      channel: "C-agent",
      threadTs: "100.000001",
      title: "Latest name",
    });
    observeSlackAgentSessionTitle({
      channel: "C-agent",
      threadTs: "100.000001",
      title: "Renamed in Slack",
    });
    markSlackAgentSessionTitleProjectionDelivered("C-agent", "100.000001", claimed.desired_revision);
    expect(getSlackAgentSessionTitleProjection("C-agent", "100.000001")).toMatchObject({
      desired_title: "Renamed in Slack",
      desired_revision: latest.desired_revision + 1,
      projection_status: "delivered",
    });
  });

  test("builds a user-scoped dashboard row from the existing session and turn records", () => {
    const turnId = createAgentTurn();
    requestSlackAgentSessionStatusProjection({
      channel: "C-agent",
      threadTs: "100.000001",
      status: "processing",
      initiatorUserId: "U1",
      initialTitle: "Build the feature",
    });
    db.query("UPDATE turns SET provider_model='gpt-test' WHERE id=?").run(turnId);
    const sessionId = (db.query("SELECT session_id FROM turns WHERE id=?").get(turnId) as { session_id: number }).session_id;

    expect(getAgentSessionDashboardRowForUser("U1", sessionId)).toMatchObject({
      slack_channel_id: "C-agent",
      title: "Build the feature",
      turn_id: turnId,
      turn_status: "running",
      provider_model: "gpt-test",
      retryable: false,
    });
    expect(getAgentSessionDashboardRowForUser("U-other", sessionId)).toBeNull();
  });

  test("keeps the latest completed provider boundary forkable while a later turn runs", () => {
    const firstTurnId = createAgentTurn();
    const sessionId = (db.query("SELECT session_id FROM turns WHERE id=?").get(firstTurnId) as {
      session_id: number;
    }).session_id;
    db.query(`UPDATE turns
      SET status='done', provider_turn_id='provider-turn-complete', ended_at=CURRENT_TIMESTAMP,
          owner_instance_id=NULL
      WHERE id=?`).run(firstTurnId);
    db.query("UPDATE sessions SET status='idle' WHERE id=?").run(sessionId);

    const secondTurn = acquireSessionTurn(
      sessionId,
      "101.000001",
      "Continue the feature",
      "runtime-2",
      undefined,
      "100.000001",
      { userId: "U1", projectionMode: "agent" },
    );
    expect(secondTurn.acquired).toBeTrue();

    expect(getAgentSessionDashboardRowForUser("U1", sessionId)).toMatchObject({
      turn_id: secondTurn.id,
      turn_status: "running",
      fork_provider_turn_id: "provider-turn-complete",
    });
    expect(sessionOwnsCompletedProviderTurn(sessionId, "provider-turn-complete")).toBeTrue();
    expect(sessionOwnsCompletedProviderTurn(sessionId, "missing-turn")).toBeFalse();
  });
});
