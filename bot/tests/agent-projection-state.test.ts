import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { acquireDatabaseTestLock } from "./db-lock";

const state = require("../src/state");
const {
  acquireSessionTurn,
  beginTurnProgressStream,
  claimSlackRootSummaryProjection,
  claimSlackAgentSessionStatusProjection,
  claimNextQueuedTurn,
  createOrGetSession,
  db,
  getSlackRootSummaryProjection,
  getSlackAgentSessionStatusProjection,
  getTurnProgressStream,
  markTurnDelivering,
  markSlackRootSummaryProjectionDelivered,
  markSlackAgentSessionStatusProjectionDelivered,
  markTurnProgressStreamStopped,
  recordTurnProgressStreamStarted,
  requestAgentStopForProgressStream,
  requestSlackRootSummaryProjection,
  requestSlackAgentSessionStatusProjection,
  requestTurnProgressStreamStop,
  retryRunningTurnAfterProviderFailure,
  upsertChannel,
} = state;

let releaseDatabaseLock: (() => void) | null = null;

beforeEach(async () => {
  releaseDatabaseLock = await acquireDatabaseTestLock();
  db.query("DELETE FROM slack_agent_session_status_projections").run();
  db.query("DELETE FROM slack_root_summary_projections").run();
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
  test("binds Stop to the exact channel, thread, and stream", () => {
    const turnId = createAgentTurn();
    expect(beginTurnProgressStream(turnId).progress_stream_state).toBe("starting");
    expect(recordTurnProgressStreamStarted(turnId, "100.000010").progress_stream_state).toBe("streaming");

    expect(requestAgentStopForProgressStream({
      channel: "C-agent",
      threadTs: "100.000001",
      streamTs: "wrong",
    })).toBeNull();
    expect(requestAgentStopForProgressStream({
      channel: "C-agent",
      threadTs: "100.000001",
      streamTs: "100.000010",
    })).toBe(turnId);
    expect(getTurnProgressStream(turnId).stop_requested_at).not.toBeNull();
    expect(requestTurnProgressStreamStop(turnId).progress_stream_state).toBe("stopping");
    expect(markTurnProgressStreamStopped(turnId).progress_stream_state).toBe("stopped");
  });

  test("lets a persisted Stop win atomically over response delivery", () => {
    const turnId = createAgentTurn();
    beginTurnProgressStream(turnId);
    recordTurnProgressStreamStarted(turnId, "100.000010");
    expect(requestAgentStopForProgressStream({
      channel: "C-agent",
      threadTs: "100.000001",
      streamTs: "100.000010",
    })).toBe(turnId);

    expect(markTurnDelivering(turnId, "final", "final", 1, "final")).toBeFalse();
    expect(db.query("SELECT status FROM turns WHERE id=?").get(turnId)).toMatchObject({ status: "running" });
    expect(db.query("SELECT COUNT(*) AS count FROM turn_delivery_chunks WHERE turn_id=?").get(turnId))
      .toMatchObject({ count: 0 });
  });

  test("reuses the same durable stream when a provider retry reclaims the turn", () => {
    const turnId = createAgentTurn();
    beginTurnProgressStream(turnId);
    recordTurnProgressStreamStarted(turnId, "100.000020");
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
    });
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

  test("does not let an older processing heartbeat overwrite terminal active status", () => {
    const processing = requestSlackAgentSessionStatusProjection({
      channel: "C-agent",
      threadTs: "100.000001",
      status: "processing",
    });
    const claimed = claimSlackAgentSessionStatusProjection("C-agent", "100.000001", Date.now())!;
    expect(claimed.desired_revision).toBe(processing.desired_revision);
    const active = requestSlackAgentSessionStatusProjection({
      channel: "C-agent",
      threadTs: "100.000001",
      status: "active",
    });
    markSlackAgentSessionStatusProjectionDelivered(
      "C-agent",
      "100.000001",
      claimed.desired_revision,
    );

    expect(getSlackAgentSessionStatusProjection("C-agent", "100.000001")).toMatchObject({
      desired_status: "active",
      desired_revision: active.desired_revision,
      projected_revision: processing.desired_revision,
      projection_status: "pending",
    });
  });
});
