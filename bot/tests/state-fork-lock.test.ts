import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { acquireDatabaseTestLock } from "./db-lock";
import { runDurableNoticeWorker } from "../src/durable-notice-worker";
import {
  effectiveSessionModeForMessage,
  persistentSessionThreadTs,
  resolveMessageRouting,
} from "../src/routing";
import { postThreadStatusThroughAnchor, turnStatusClientMessageId } from "../src/turn-status-projection";
import { runSlackThreadStatusProjection } from "../src/thread-status";

// CONCIERGE_STATE_DIR is set by tests/preload.ts; state.ts hard-refuses
// production paths under CONCIERGE_TEST_MODE=1. Destructive DELETEs
// below are safe by construction.
const state = require("../src/state");
const {
  acquireSessionTurn,
  claimNextQueuedTurn,
  associateLegacyTurnsWithSlackThread,
  attachComparisonThread,
  attachComparisonTurn,
  attachBotMessage,
  beginInlineCapture,
  claimComparisonRequest,
  claimForkRequest,
  beginForkRequest,
  claimForkRequestBinding,
  claimForkRequestDelivery,
  completeForkRequestDelivery,
  markForkRequestAnchorPosted,
  claimSlackUserInput,
  claimSlackInputRecoveryNotice,
  claimSteeringFailureNotice,
  classifySlackUserInput,
  createOrGetSession,
  createTurnSteeringMessage,
  db,
  finishTurn,
  failRunningTurnAndReleaseSession,
  finishDeliveredTurn,
  finishComparisonRequest,
  finishComparisonFromTurnOutcome,
  findLegacySlackThreadStatusMessage,
  getSession,
  getSessionByUuid,
  getSessionForThread,
  getSessionForSlackMessage,
  getProviderTurnBoundaryForSlackMessage,
  turnHasAcceptedSteering,
  getForkRequest,
  getSlackUserInputClaim,
  getSlackInputRecoveryNotice,
  getInlineCaptureConfirmation,
  getSlackThreadStatus,
  getSteeringMessageForSlackMessage,
  listSessionUserPrompts,
  listSlackThreadResponses,
  resolveComparisonSourceSession,
  reconcileComparisonRequests,
  recoverSteeringFailureNoticeClaims,
  recoverDeferredSteeringFailureNotices,
  recoverSlackInputRecoveryNoticeClaims,
  resolveForkParentSession,
  setSessionStatus,
  setSlackThreadStatusMessage,
  setTurnReplayInput,
  upsertSession,
  updateTurnSteeringReplayText,
  interruptOrphanedTurn,
  listOrphanedSlackInputClaims,
  listRecoverableTurns,
  listPendingSteeringFailureNotices,
  listPendingSlackInputRecoveryNotices,
  listPendingInlineCaptureConfirmations,
  listPendingTurnStatusProjections,
  markInlineCaptureVaultDone,
  markInlineCaptureListDone,
  markInlineCaptureListSkipped,
  finishInlineCapture,
  claimInlineCaptureConfirmation,
  markInlineCaptureConfirmationDelivered,
  markInlineCaptureConfirmationRetry,
  recoverInlineCaptureConfirmationClaims,
  markSlackInputRecoveryNoticeDelivered,
  markSlackInputRecoveryNoticeRetry,
  parkSlackInputRecoveryNotice,
  markSteeringFailureNoticeDelivered,
  markSteeringFailureNoticeFailed,
  markTurnResponseDelivered,
  markTurnDelivering,
  markTurnProviderStarted,
  recordTurnProviderTurnId,
  markForkRequestCreated,
  markTurnSteeringMessageFailed,
  markTurnSteeringMessageAmbiguous,
  finalizeTurnSteeringMessageAmbiguity,
  markTurnSteeringMessageSending,
  markTurnSteeringMessageSent,
  registerProcessInstance,
  recoverUnsettledSteeringMessages,
  releaseOrphanedSlackInputClaims,
  releasePendingSlackUserInput,
  failPendingSlackUserInput,
  clearAbandonedDrain,
  deliveredChunkIndexes,
  markDeliveryChunkDelivered,
  requestSlackThreadStatusProjection,
  claimSlackThreadStatusProjection,
  claimTurnStatusProjection,
  getTurnStatusProjection,
  markSlackThreadStatusProjectionDelivered,
  markTurnStatusProjectionDelivered,
  recordTurnStatusMessage,
  recordSlackThreadStatusMessage,
  replaceMissingTurnStatusMessage,
  replaceMissingSlackThreadStatusMessage,
  recoverTurnStatusProjectionClaims,
  recoverSlackThreadStatusProjectionClaims,
  requestTurnStatusProjection,
  bindChannelDefaultSessionUuid,
  backfillSlackThreadStatusAnchors,
  reserveSessionForThread,
} = state;

let releaseDatabaseTestLock: (() => void) | null = null;
beforeEach(async () => {
  releaseDatabaseTestLock = await acquireDatabaseTestLock();
  db.query("DELETE FROM deployment_drain").run();
  db.query("DELETE FROM comparison_requests").run();
  db.query("DELETE FROM fork_requests").run();
  db.query("DELETE FROM slack_thread_statuses").run();
  db.query("DELETE FROM slack_user_input_claims").run();
  db.query("DELETE FROM turn_steering_messages").run();
  db.query("DELETE FROM turn_delivery_chunks").run();
  db.query("DELETE FROM turns").run();
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM process_instances").run();
  db.query("DELETE FROM channels").run();
});
afterEach(() => { releaseDatabaseTestLock?.(); releaseDatabaseTestLock = null; });

async function runInputRecoveryNotice(
  userMessageTs: string,
  deliver: () => Promise<void>,
  isRetryable: (error: unknown) => boolean,
) {
  const normalize = (row: any) => row && ({
    ...row,
    noticeStatus: row.recovery_notice_status,
    attempts: row.recovery_notice_attempts,
    nextAttemptMs: row.recovery_notice_next_attempt_ms,
  });
  return runDurableNoticeWorker({
    load: () => normalize(getSlackInputRecoveryNotice("C1", userMessageTs)),
    claim: (nowMs) => normalize(claimSlackInputRecoveryNotice("C1", userMessageTs, nowMs)),
    deliver,
    markDelivered: () => markSlackInputRecoveryNoticeDelivered("C1", userMessageTs),
    markRetry: (error, nextAttemptMs) => markSlackInputRecoveryNoticeRetry(
      "C1", userMessageTs, error, nextAttemptMs,
    ),
    markParked: (error) => parkSlackInputRecoveryNotice("C1", userMessageTs, error),
    isRetryable,
    wait: async () => {},
    initialDelayMs: 0,
  });
}

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

  test("maps a selected Slack message to the exact persisted Codex turn boundary", () => {
    upsertSession("C1", "112.000001", "codex", "parent-boundary", { status: "idle" });
    const session = getSession("C1", "112.000001", "codex");
    const turn = acquireSessionTurn(session.id, "112.000002", "selected reply");
    attachBotMessage(turn.id, "112.000003");
    recordTurnProviderTurnId(turn.id, "codex-turn-selected");
    finishTurn(turn.id, "done", "done");

    expect(getProviderTurnBoundaryForSlackMessage("C1", "112.000002")).toEqual({
      turnId: turn.id,
      providerTurnId: "codex-turn-selected",
      replayText: null,
      sourceKind: "user",
    });
    expect(getProviderTurnBoundaryForSlackMessage("C1", "112.000003")).toEqual({
      turnId: turn.id,
      providerTurnId: "codex-turn-selected",
      replayText: null,
      sourceKind: "outcome",
    });
  });

  test("identifies when an original request precedes accepted steering in the same Codex turn", () => {
    upsertSession("C1", "113.000001", "codex", "parent-steered", { status: "idle" });
    const session = getSession("C1", "113.000001", "codex");
    const turn = acquireSessionTurn(session.id, "113.000001", "original request", "owner");
    const steering = createTurnSteeringMessage(
      turn.id,
      "113.000002",
      "accepted guidance",
      "accepted guidance",
    );
    markTurnSteeringMessageSending(steering.row.id);
    markTurnSteeringMessageSent(steering.row.id);
    attachBotMessage(turn.id, "113.000003");
    finishTurn(turn.id, "done", "done");

    expect(getProviderTurnBoundaryForSlackMessage("C1", "113.000001")?.sourceKind).toBe("user");
    expect(getProviderTurnBoundaryForSlackMessage("C1", "113.000003")?.sourceKind).toBe("outcome");
    expect(turnHasAcceptedSteering(turn.id)).toBe(true);
  });

  test("rejects every fork boundary in a session containing ambiguous steering", () => {
    upsertSession("C1", "333.000001", "codex", "uncertain-parent", { status: "idle" });
    const session = getSession("C1", "333.000001", "codex");
    const turn = acquireSessionTurn(session.id, "333.000001", "initial", "owner");
    const steering = createTurnSteeringMessage(turn.id, "333.000002", "uncertain", "uncertain");
    markTurnSteeringMessageSending(steering.row.id);
    markTurnSteeringMessageAmbiguous(steering.row.id, "ack race");
    attachBotMessage(turn.id, "333.000003");
    finishTurn(turn.id, "done", "final");
    setSessionStatus(session.id, "idle");

    expect(resolveForkParentSession("C1", "333.000001")).toBeNull();
    expect(resolveForkParentSession("C1", "333.000003")).toBeNull();
    expect(resolveForkParentSession("C1")).toBeNull();
  });

  test("rejects active sessions and permits settled sent steering through later boundaries", () => {
    upsertSession("C1", "444.000001", "codex", "settled-parent", { status: "idle" });
    const session = getSession("C1", "444.000001", "codex");
    const turn = acquireSessionTurn(session.id, "444.000001", "initial", "owner");
    const steering = createTurnSteeringMessage(turn.id, "444.000002", "accepted", "accepted");

    expect(resolveForkParentSession("C1", "444.000001")).toBeNull();
    markTurnSteeringMessageSending(steering.row.id);
    expect(resolveForkParentSession("C1", "444.000001")).toBeNull();
    markTurnSteeringMessageSent(steering.row.id);
    attachBotMessage(turn.id, "444.000003");
    finishTurn(turn.id, "done", "final");
    setSessionStatus(session.id, "idle");

    expect(resolveForkParentSession("C1", "444.000002")).toBeNull();
    expect(resolveForkParentSession("C1", "444.000003")?.id).toBe(session.id);
  });
});

describe("getSessionByUuid", () => {
  test("scopes a persistent session lookup to its Slack channel", () => {
    upsertSession("C1", "111.000001", "codex", "persistent-session", { status: "idle" });

    expect(getSessionByUuid("C1", "persistent-session")?.slack_thread_ts).toBe("111.000001");
    expect(getSessionByUuid("C2", "persistent-session")).toBeNull();
  });
});

describe("durable fork requests", () => {
  test("persists the provider child before Slack delivery and atomically creates its top-level session", () => {
    upsertSession("C1", "500.000001", "codex", "source-session", { status: "idle" });
    const source = getSession("C1", "500.000001", "codex");
    const firstClaim = claimForkRequest({
      requestId: "trigger-1",
      channelId: "C1",
      requestedBy: "U1",
      sourceSessionId: source.id,
      sourceMessageTs: "500.000003",
      providerId: "codex",
      sourceProviderSessionUUID: "source-session",
      lastProviderTurnId: "turn-1",
      cwd: "/tmp/project",
      additionalDirs: ["/tmp/shared"],
    });
    const duplicateClaim = claimForkRequest({
      requestId: "trigger-1",
      channelId: "C1",
      requestedBy: "U1",
      sourceSessionId: source.id,
      sourceMessageTs: "500.000003",
      providerId: "codex",
      sourceProviderSessionUUID: "source-session",
      lastProviderTurnId: "turn-1",
      cwd: "/tmp/project",
      additionalDirs: ["/tmp/shared"],
    });

    expect(firstClaim.claimed).toBe(true);
    expect(duplicateClaim.claimed).toBe(false);
    expect(duplicateClaim.row.provider_request_key).toBe(firstClaim.row.provider_request_key);
    expect(beginForkRequest("trigger-1", "owner-1")?.status).toBe("forking");
    markForkRequestCreated("trigger-1", "owner-1", "forked-session");
    expect(getForkRequest("trigger-1")?.status).toBe("forked");
    expect(getSessionByUuid("C1", "forked-session")).toBeNull();

    expect(claimForkRequestDelivery("trigger-1", "owner-1")?.status).toBe("delivering");
    expect(markForkRequestAnchorPosted("trigger-1", "owner-1", "600.000001").status).toBe("binding");
    expect(claimForkRequestBinding("trigger-1", "owner-1")?.status).toBe("binding");
    const child = completeForkRequestDelivery("trigger-1", "owner-1");

    expect(child.slack_thread_ts).toBe("600.000001");
    expect(child.agent_session_uuid).toBe("forked-session");
    expect(child.parent_session_id).toBe(source.id);
    expect(getForkRequest("trigger-1")?.status).toBe("delivered");
    expect(getForkRequest("trigger-1")?.slack_message_ts).toBe("600.000001");

    db.query(`UPDATE channels
              SET session_mode='single-persistent', default_session_uuid='source-session'
              WHERE slack_channel_id='C1'`).run();
    const visibleChild = getSessionForThread("C1", "600.000001");
    const routing = resolveMessageRouting({
      replyThreadTs: "600.000001",
      sessionMode: effectiveSessionModeForMessage({
        channelSessionMode: "single-persistent",
        hasVisibleThreadSession: Boolean(visibleChild),
      }),
      anchorThreadTs: source.slack_thread_ts,
    });
    expect(getSessionForThread("C1", routing.sessionThreadTs)?.agent_session_uuid).toBe("forked-session");
  });

  test("never overwrites a session that appeared before fork binding completed", () => {
    upsertSession("C1", "700.000001", "codex", "source-session", { status: "idle" });
    const source = getSession("C1", "700.000001", "codex");
    claimForkRequest({
      requestId: "binding-conflict",
      channelId: "C1",
      requestedBy: "U1",
      sourceSessionId: source.id,
      providerId: "codex",
      sourceProviderSessionUUID: "source-session",
      cwd: "/tmp/project",
      additionalDirs: [],
    });
    beginForkRequest("binding-conflict", "owner-1");
    markForkRequestCreated("binding-conflict", "owner-1", "forked-session");
    claimForkRequestDelivery("binding-conflict", "owner-1");
    markForkRequestAnchorPosted("binding-conflict", "owner-1", "800.000001");
    upsertSession("C1", "800.000001", "codex", "competing-session", { status: "running" });
    claimForkRequestBinding("binding-conflict", "owner-1");

    expect(() => completeForkRequestDelivery("binding-conflict", "owner-1"))
      .toThrow("already bound to a different session");
    expect(getSessionForThread("C1", "800.000001")?.agent_session_uuid).toBe("competing-session");
    expect(getSessionForThread("C1", "800.000001")?.status).toBe("running");
    expect(getForkRequest("binding-conflict")?.status).toBe("binding");
  });

  test("never binds a fork beside a different-provider session at the same visible root", () => {
    upsertSession("C1", "900.000001", "codex", "source-session", { status: "idle" });
    const source = getSession("C1", "900.000001", "codex");
    claimForkRequest({
      requestId: "cross-provider-binding-conflict",
      channelId: "C1",
      requestedBy: "U1",
      sourceSessionId: source.id,
      providerId: "codex",
      sourceProviderSessionUUID: "source-session",
      cwd: "/tmp/project",
      additionalDirs: [],
    });
    beginForkRequest("cross-provider-binding-conflict", "owner-1");
    markForkRequestCreated("cross-provider-binding-conflict", "owner-1", "forked-session");
    claimForkRequestDelivery("cross-provider-binding-conflict", "owner-1");
    markForkRequestAnchorPosted("cross-provider-binding-conflict", "owner-1", "910.000001");
    upsertSession("C1", "910.000001", "claude-code", "competing-session", { status: "running" });
    claimForkRequestBinding("cross-provider-binding-conflict", "owner-1");

    expect(() => completeForkRequestDelivery("cross-provider-binding-conflict", "owner-1"))
      .toThrow("already bound to a different session");
    expect(getSessionForThread("C1", "910.000001")?.agent_session_uuid).toBe("competing-session");
    expect(getSession("C1", "910.000001", "codex")).toBeNull();
    expect(getForkRequest("cross-provider-binding-conflict")?.status).toBe("binding");
  });
});

describe("visible Slack thread status", () => {
  test("retries an ambiguous per-turn status create with one stable operation identity", () => {
    const session = createOrGetSession("C1", "visible.050001", "codex");
    const turn = acquireSessionTurn(
      session.id,
      "visible.050001",
      "work",
      null,
      undefined,
      "visible.050001",
    );
    requestTurnStatusProjection(turn.id, "working");
    expect(listPendingTurnStatusProjections().map((row: any) => row.turn_id)).toContain(turn.id);

    const firstClaim = claimTurnStatusProjection(turn.id, 0)!;
    const firstClientMessageId = turnStatusClientMessageId(
      firstClaim.turn_id,
      firstClaim.message_generation,
    );
    expect(firstClaim.slack_status_msg_ts).toBe("");

    expect(recoverTurnStatusProjectionClaims()).toBe(1);
    const recoveredClaim = claimTurnStatusProjection(turn.id, 0)!;
    expect(turnStatusClientMessageId(
      recoveredClaim.turn_id,
      recoveredClaim.message_generation,
    )).toBe(firstClientMessageId);

    recordTurnStatusMessage(turn.id, recoveredClaim.message_generation, "visible.050002");
    markTurnStatusProjectionDelivered(turn.id, recoveredClaim.desired_revision);

    expect(getTurnStatusProjection(turn.id)).toMatchObject({
      slack_status_msg_ts: "visible.050002",
      message_generation: 0,
      projection_status: "delivered",
    });
    expect(getSlackThreadStatus("C1", "visible.050001")?.slack_status_msg_ts)
      .toBe("visible.050002");
    expect(listPendingTurnStatusProjections().map((row: any) => row.turn_id)).not.toContain(turn.id);
  });

  test("durably recovers an interrupted projection and never settles an older revision over a newer one", () => {
    const session = createOrGetSession("C1", "visible.100001", "codex");
    const turn = acquireSessionTurn(session.id, "visible.100001", "work");
    attachBotMessage(turn.id, "visible.100003");
    requestSlackThreadStatusProjection({
      channel: "C1",
      threadTs: "visible.100001",
      turnId: turn.id,
      legacyMessageTs: "visible.100002",
      text: "working",
    });
    expect((db.query("SELECT slack_bot_msg_ts FROM turns WHERE id=?").get(turn.id) as any).slack_bot_msg_ts)
      .toBe("visible.100003");

    const firstClaim = claimSlackThreadStatusProjection("C1", "visible.100001", 0)!;
    expect(firstClaim.projection_status).toBe("sending");
    expect(recoverSlackThreadStatusProjectionClaims()).toBe(1);
    const recoveredClaim = claimSlackThreadStatusProjection("C1", "visible.100001", 0)!;

    requestSlackThreadStatusProjection({
      channel: "C1",
      threadTs: "visible.100001",
      turnId: turn.id,
      text: "done",
    });
    markSlackThreadStatusProjectionDelivered("C1", "visible.100001", recoveredClaim.desired_revision);
    expect(getSlackThreadStatus("C1", "visible.100001")).toMatchObject({
      desired_text: "done",
      desired_revision: 2,
      projected_revision: 1,
      projection_status: "pending",
    });

    const finalClaim = claimSlackThreadStatusProjection("C1", "visible.100001", 0)!;
    markSlackThreadStatusProjectionDelivered("C1", "visible.100001", finalClaim.desired_revision);
    expect(getSlackThreadStatus("C1", "visible.100001")).toMatchObject({
      projected_revision: 2,
      projection_status: "delivered",
    });
  });

  test("rebinds both projections to one replacement when the first dual-purpose status is deleted", () => {
    const threadTs = "visible.150001";
    const deletedStatusTs = "visible.150002";
    const replacementStatusTs = "visible.150003";
    const session = createOrGetSession("C1", threadTs, "codex");
    const turn = acquireSessionTurn(session.id, threadTs, "request", null, undefined, threadTs);

    requestTurnStatusProjection(turn.id, "working");
    const initialTurnClaim = claimTurnStatusProjection(turn.id, 0)!;
    recordTurnStatusMessage(turn.id, initialTurnClaim.message_generation, deletedStatusTs);
    markTurnStatusProjectionDelivered(turn.id, initialTurnClaim.desired_revision);
    requestSlackThreadStatusProjection({
      channel: "C1",
      threadTs,
      turnId: turn.id,
      text: "TL;DR: done",
    });
    const initialThreadClaim = claimSlackThreadStatusProjection("C1", threadTs, 0)!;
    markSlackThreadStatusProjectionDelivered("C1", threadTs, initialThreadClaim.desired_revision);
    finishTurn(turn.id, "done", "first answer");
    const followUp = acquireSessionTurn(
      session.id,
      "visible.150010",
      "follow-up",
      null,
      undefined,
      threadTs,
    );
    requestTurnStatusProjection(followUp.id, "working follow-up");
    const followUpClaim = claimTurnStatusProjection(followUp.id, 0)!;
    recordTurnStatusMessage(followUp.id, followUpClaim.message_generation, "visible.150011");
    markTurnStatusProjectionDelivered(followUp.id, followUpClaim.desired_revision);

    expect(getSlackThreadStatus("C1", threadTs)).toMatchObject({
      slack_status_msg_ts: deletedStatusTs,
      anchor_turn_id: turn.id,
    });

    replaceMissingSlackThreadStatusMessage(
      "C1",
      threadTs,
      initialThreadClaim.message_generation,
      deletedStatusTs,
    );
    expect(getTurnStatusProjection(turn.id)).toMatchObject({
      slack_status_msg_ts: "",
      projection_status: "pending",
    });
    expect(getSlackThreadStatus("C1", threadTs)).toMatchObject({
      slack_status_msg_ts: "",
      projection_status: "pending",
    });

    const replacementTurnClaim = claimTurnStatusProjection(turn.id, 0)!;
    recordTurnStatusMessage(turn.id, replacementTurnClaim.message_generation, replacementStatusTs);
    markTurnStatusProjectionDelivered(turn.id, replacementTurnClaim.desired_revision);
    const replacementThreadClaim = claimSlackThreadStatusProjection("C1", threadTs, 0)!;
    recordSlackThreadStatusMessage(
      "C1",
      threadTs,
      replacementThreadClaim.message_generation,
      replacementStatusTs,
    );
    markSlackThreadStatusProjectionDelivered("C1", threadTs, replacementThreadClaim.desired_revision);

    expect(getTurnStatusProjection(turn.id)?.slack_status_msg_ts).toBe(replacementStatusTs);
    expect(getSlackThreadStatus("C1", threadTs)?.slack_status_msg_ts).toBe(replacementStatusTs);
    expect(getTurnStatusProjection(followUp.id)?.slack_status_msg_ts).toBe("visible.150011");

    db.query(`
      UPDATE slack_thread_statuses SET anchor_turn_id=NULL
      WHERE slack_channel_id=? AND slack_thread_ts=?
    `).run("C1", threadTs);
    replaceMissingTurnStatusMessage(
      turn.id,
      replacementTurnClaim.message_generation,
      replacementStatusTs,
    );
    expect(getTurnStatusProjection(turn.id)?.slack_status_msg_ts).toBe("");
    expect(getSlackThreadStatus("C1", threadTs)?.slack_status_msg_ts).toBe("");
  });

  test("backfills an upgraded shared-status anchor before competing restart workers repair deletion", async () => {
    const threadTs = "visible.160001";
    const deletedStatusTs = "visible.160002";
    const replacementStatusTs = "visible.160003";
    const session = createOrGetSession("C1", threadTs, "codex");
    const turn = acquireSessionTurn(session.id, threadTs, "request", null, undefined, threadTs);

    requestTurnStatusProjection(turn.id, "working");
    const initialTurnClaim = claimTurnStatusProjection(turn.id, 0)!;
    recordTurnStatusMessage(turn.id, initialTurnClaim.message_generation, deletedStatusTs);
    markTurnStatusProjectionDelivered(turn.id, initialTurnClaim.desired_revision);
    requestSlackThreadStatusProjection({
      channel: "C1",
      threadTs,
      turnId: turn.id,
      text: "TL;DR: working",
    });
    const initialThreadClaim = claimSlackThreadStatusProjection("C1", threadTs, 0)!;
    markSlackThreadStatusProjectionDelivered("C1", threadTs, initialThreadClaim.desired_revision);

    requestTurnStatusProjection(turn.id, "TL;DR: done\n\nStatus: done");
    requestSlackThreadStatusProjection({
      channel: "C1",
      threadTs,
      turnId: turn.id,
      text: "TL;DR: done",
    });
    db.query(`UPDATE turns SET status_projection_status='sending' WHERE id=?`).run(turn.id);
    db.query(`
      UPDATE slack_thread_statuses
      SET anchor_turn_id=NULL, projection_status='sending'
      WHERE slack_channel_id=? AND slack_thread_ts=?
    `).run("C1", threadTs);

    expect(backfillSlackThreadStatusAnchors()).toBe(1);
    expect(recoverTurnStatusProjectionClaims()).toBe(1);
    expect(recoverSlackThreadStatusProjectionClaims()).toBe(1);
    expect(getSlackThreadStatus("C1", threadTs)?.anchor_turn_id).toBe(turn.id);

    const visibleMessages = new Set<string>();
    let posts = 0;
    const updateMessage = async (messageTs: string) => {
      if (messageTs === deletedStatusTs || !visibleMessages.has(messageTs)) {
        throw Object.assign(new Error("status message was deleted"), { code: "message_not_found" });
      }
    };
    const postMessage = async () => {
      posts += 1;
      visibleMessages.add(replacementStatusTs);
      return { ts: replacementStatusTs };
    };

    let activeTurnWorker: Promise<"delivered" | "stopped" | "permanent_failure"> | null = null;
    const scheduleTurnWorker = () => {
      if (activeTurnWorker) return activeTurnWorker;
      const worker = runSlackThreadStatusProjection({
        load: () => getTurnStatusProjection(turn.id),
        claim: (nowMs) => claimTurnStatusProjection(turn.id, nowMs),
        update: (row) => updateMessage(row.slack_status_msg_ts),
        post: postMessage,
        recordMessage: (row, messageTs) => {
          recordTurnStatusMessage(turn.id, row.message_generation, messageTs);
        },
        replaceMissingMessage: (row) => {
          replaceMissingTurnStatusMessage(turn.id, row.message_generation, row.slack_status_msg_ts);
        },
        markDelivered: (row) => markTurnStatusProjectionDelivered(turn.id, row.desired_revision),
        markRetry: () => { throw new Error("unexpected retry"); },
        markParked: () => { throw new Error("unexpected park"); },
        isMissingUpdateError: (error) => (error as any)?.code === "message_not_found",
        isMissingDuplicateError: () => false,
        isRetryable: () => false,
        wait: async () => {},
        now: () => 0,
        clientMessageId: (row) => turnStatusClientMessageId(turn.id, row.message_generation),
      }).finally(() => {
        if (activeTurnWorker === worker) activeTurnWorker = null;
      });
      activeTurnWorker = worker;
      return worker;
    };

    const threadWorker = runSlackThreadStatusProjection({
      load: () => getSlackThreadStatus("C1", threadTs),
      claim: (nowMs) => claimSlackThreadStatusProjection("C1", threadTs, nowMs),
      update: (row) => updateMessage(row.slack_status_msg_ts),
      post: (row) => postThreadStatusThroughAnchor({
        anchorTurnId: row.anchor_turn_id,
        projectAnchorTurn: async (turnId) => {
          expect(turnId).toBe(turn.id);
          await scheduleTurnWorker();
        },
        loadStatusMessageTs: () => getSlackThreadStatus("C1", threadTs)?.slack_status_msg_ts || "",
        updateAnchoredMessage: updateMessage,
        postNewMessage: postMessage,
      }),
      recordMessage: (row, messageTs) => {
        recordSlackThreadStatusMessage("C1", threadTs, row.message_generation, messageTs);
      },
      replaceMissingMessage: (row) => {
        replaceMissingSlackThreadStatusMessage(
          "C1",
          threadTs,
          row.message_generation,
          row.slack_status_msg_ts,
        );
      },
      markDelivered: (row) => {
        markSlackThreadStatusProjectionDelivered("C1", threadTs, row.desired_revision);
      },
      markRetry: () => { throw new Error("unexpected retry"); },
      markParked: () => { throw new Error("unexpected park"); },
      isMissingUpdateError: (error) => (error as any)?.code === "message_not_found",
      isMissingDuplicateError: () => false,
      isRetryable: () => false,
      wait: async () => {},
      now: () => 0,
    });

    expect(await Promise.all([scheduleTurnWorker(), threadWorker])).toEqual(["delivered", "delivered"]);
    expect(posts).toBe(1);
    expect(getTurnStatusProjection(turn.id)?.slack_status_msg_ts).toBe(replacementStatusTs);
    expect(getSlackThreadStatus("C1", threadTs)?.slack_status_msg_ts).toBe(replacementStatusTs);
  });

  test("keeps per-turn status messages distinct while advancing one thread summary after delivery", () => {
    const session = createOrGetSession("C1", "provider-anchor.000001", "codex");
    const first = acquireSessionTurn(
      session.id,
      "visible.000001",
      "first request",
      null,
      undefined,
      "visible.000001",
    );
    setTurnReplayInput(first.id, "first request", 0);
    markTurnProviderStarted(first.id);
    setSlackThreadStatusMessage("C1", "visible.000001", "visible.000002");
    attachBotMessage(first.id, "visible.000002");
    markTurnDelivering(first.id, "first answer", "first answer", 1, "Completed the first request.");

    expect(getSlackThreadStatus("C1", "visible.000001")?.thread_tldr).toBeNull();
    expect(markTurnResponseDelivered(first.id)).toMatchObject({
      slack_status_msg_ts: "visible.000002",
      thread_tldr: "Completed the first request.",
      summary_through_turn_id: first.id,
    });
    finishDeliveredTurn(first.id);

    const second = acquireSessionTurn(
      session.id,
      "visible.000003",
      "follow-up",
      null,
      undefined,
      "visible.000001",
    );
    setTurnReplayInput(second.id, "follow-up", 0);
    markTurnProviderStarted(second.id);
    expect(getSlackThreadStatus("C1", "visible.000001")?.slack_status_msg_ts).toBe("visible.000002");
    attachBotMessage(second.id, "visible.000004");
    markTurnDelivering(
      second.id,
      "second answer",
      "second answer",
      1,
      "Completed the first request and its follow-up.",
    );
    markTurnResponseDelivered(second.id);
    finishDeliveredTurn(second.id);

    expect(getSlackThreadStatus("C1", "visible.000001")).toMatchObject({
      slack_status_msg_ts: "visible.000002",
      thread_tldr: "Completed the first request and its follow-up.",
      summary_through_turn_id: second.id,
    });
    expect(db.query("SELECT slack_bot_msg_ts FROM turns WHERE id=?").get(second.id)).toEqual({
      slack_bot_msg_ts: "visible.000004",
    });
    expect(listSlackThreadResponses("C1", "visible.000001")).toEqual([
      { turn_id: first.id, user_text: "first request", response_tldr: "Completed the first request.", agent_text: "first answer" },
      {
        turn_id: second.id,
        user_text: "follow-up",
        response_tldr: "Completed the first request and its follow-up.",
        agent_text: "second answer",
      },
    ]);
    expect(resolveComparisonSourceSession("C1", "visible.000002")?.id).toBe(session.id);
    expect(listSessionUserPrompts(session.id, "visible.000002").map((row: any) => row.user_text))
      .toEqual(["first request", "follow-up"]);
  });

  test("adopts the earliest legacy per-turn status reply", () => {
    const session = createOrGetSession("C1", "legacy.000001", "codex");
    const first = acquireSessionTurn(session.id, "legacy.000001", "first");
    attachBotMessage(first.id, "legacy.000002");
    finishTurn(first.id, "done", "TL;DR: First.");
    setSessionStatus(session.id, "idle");
    const second = acquireSessionTurn(session.id, "legacy.000003", "second");
    attachBotMessage(second.id, "legacy.000004");
    finishTurn(second.id, "done", "TL;DR: Second.");

    expect(findLegacySlackThreadStatusMessage("C1", "legacy.000001")).toBe("legacy.000002");
  });

  test("keeps legacy single-persistent visible threads isolated and hydrates their replies", () => {
    db.query(`INSERT INTO channels (
      slack_channel_id, slack_channel_name, name, vault_path, session_mode
    ) VALUES ('C1', 'test', 'test', '/tmp/test', 'single-persistent')`).run();
    const session = createOrGetSession("C1", "provider-anchor.200001", "codex");

    const first = acquireSessionTurn(session.id, "visible-a.200001", "first");
    attachBotMessage(first.id, "visible-a.200002");
    finishTurn(first.id, "done", "TL;DR: Visible A.");
    setSessionStatus(session.id, "idle");
    const second = acquireSessionTurn(session.id, "visible-b.200001", "second");
    attachBotMessage(second.id, "visible-b.200002");
    finishTurn(second.id, "done", "TL;DR: Visible B root.");
    setSessionStatus(session.id, "idle");
    const reply = acquireSessionTurn(session.id, "visible-b.200003", "reply");
    finishTurn(reply.id, "done", "TL;DR: Visible B reply.");

    db.query("UPDATE turns SET slack_reply_thread_ts=NULL").run();
    db.query("UPDATE slack_user_input_claims SET reply_thread_ts=NULL WHERE kind='turn'").run();

    expect(findLegacySlackThreadStatusMessage("C1", "visible-a.200001")).toBe("visible-a.200002");
    expect(findLegacySlackThreadStatusMessage("C1", "visible-b.200001")).toBe("visible-b.200002");
    expect(listSlackThreadResponses("C1", "provider-anchor.200001")).toEqual([]);

    expect(associateLegacyTurnsWithSlackThread("C1", "visible-b.200001", [
      "visible-b.200001",
      "visible-b.200003",
    ])).toBe(2);
    expect(listSlackThreadResponses("C1", "visible-b.200001")).toEqual([
      { turn_id: second.id, user_text: "second", response_tldr: null, agent_text: "TL;DR: Visible B root." },
      { turn_id: reply.id, user_text: "reply", response_tldr: null, agent_text: "TL;DR: Visible B reply." },
    ]);
    expect(listSlackThreadResponses("C1", "visible-a.200001")).toEqual([
      { turn_id: first.id, user_text: "first", response_tldr: null, agent_text: "TL;DR: Visible A." },
    ]);
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

    expect(listSessionUserPrompts(session.id, "123.000003")).toEqual([
      {
        slack_user_msg_ts: "123.000001", user_text: "first prompt", source_text: "first prompt",
        replay_ready: 1, status: "done", unreplayable_attachment_count: 0,
      },
      {
        slack_user_msg_ts: "123.000003", user_text: "second prompt", source_text: "second prompt",
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
      source_text: "",
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
      source_text: "<@UBOT> raw request",
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

  test("interleaves provider-accepted steering messages into canonical history", () => {
    const session = createOrGetSession("C1", "126.000001", "codex");
    const turn = acquireSessionTurn(session.id, "126.000001", "initial raw");
    setTurnReplayInput(turn.id, "initial canonical", 0);
    markTurnProviderStarted(turn.id);
    const sent = createTurnSteeringMessage(turn.id, "126.000002", "sent raw", "sent raw before hydration");
    const failed = createTurnSteeringMessage(turn.id, "126.000003", "failed raw", "failed canonical");
    updateTurnSteeringReplayText(sent.row.id, "sent canonical");
    markTurnSteeringMessageSending(sent.row.id);
    markTurnSteeringMessageSent(sent.row.id);
    markTurnSteeringMessageFailed(failed.row.id, "turn ended");
    finishTurn(turn.id, "done", "answer");
    setSessionStatus(session.id, "idle");

    expect(listSessionUserPrompts(session.id)).toEqual([
      {
        slack_user_msg_ts: "126.000001", user_text: "initial canonical", source_text: "initial raw", replay_ready: 1,
        status: "done", unreplayable_attachment_count: 0,
      },
      {
        slack_user_msg_ts: "126.000002", user_text: "sent canonical", source_text: "sent raw", replay_ready: 1,
        status: "sent", unreplayable_attachment_count: 0,
      },
      {
        slack_user_msg_ts: "126.000003", user_text: "failed canonical", source_text: "failed raw", replay_ready: 0,
        status: "steering_failed", unreplayable_attachment_count: 0,
      },
    ]);
    expect(getSessionForSlackMessage("C1", "126.000002")?.id).toBe(session.id);
    expect(resolveForkParentSession("C1", "126.000002")).toBeNull();
    expect(getSessionForSlackMessage("C1", "126.000003")).toBeNull();
    expect(resolveComparisonSourceSession("C1", "126.000002")?.id).toBe(session.id);
    expect(resolveComparisonSourceSession("C1", "126.000003")?.id).toBe(session.id);
    const failedReply = { ts: "126.000003", thread_ts: "126.000001" };
    expect(resolveForkParentSession("C1", failedReply.thread_ts)?.id).toBe(session.id);
    expect(resolveForkParentSession("C1", failedReply.ts)).toBeNull();
    expect(getSteeringMessageForSlackMessage("C1", failedReply.ts)?.status).toBe("failed");
  });
});

describe("global Slack user input ownership", () => {
  test("a retry can never change between an ordinary turn and steering", () => {
    const session = createOrGetSession("C1", "800.000001", "codex");
    const initial = acquireSessionTurn(session.id, "800.000001", "initial");
    setTurnReplayInput(initial.id, "initial canonical", 0);
    markTurnProviderStarted(initial.id);

    const initiatingRetry = createTurnSteeringMessage(
      initial.id,
      "800.000001",
      "initial",
      "initial",
    );
    expect(initiatingRetry).toEqual({ row: null, duplicate: true });
    expect(getSlackUserInputClaim("C1", "800.000001")).toMatchObject({
      kind: "turn",
      turn_id: initial.id,
    });

    const steering = createTurnSteeringMessage(
      initial.id,
      "800.000002",
      "change direction",
      "change direction",
    );
    expect(steering.duplicate).toBeFalse();
    if (steering.duplicate) throw new Error("Expected the steering message to own its Slack input");
    markTurnSteeringMessageSending(steering.row.id);
    markTurnSteeringMessageSent(steering.row.id);
    finishTurn(initial.id, "done", "answer");
    setSessionStatus(session.id, "idle");

    const retryAfterClose = acquireSessionTurn(session.id, "800.000002", "change direction");
    expect(retryAfterClose).toEqual({
      id: initial.id,
      duplicate: true,
      acquired: false,
      queued: false,
    });

    const later = acquireSessionTurn(session.id, "800.000003", "later turn");
    expect(later).toMatchObject({ duplicate: false, acquired: true });
    const retryDuringLaterTurn = createTurnSteeringMessage(
      later.id,
      "800.000002",
      "change direction",
      "change direction",
    );
    expect(retryDuringLaterTurn.duplicate).toBeTrue();

    expect((db.query(`SELECT COUNT(*) AS count FROM turns WHERE slack_user_msg_ts='800.000002'`).get() as any).count)
      .toBe(0);
    expect((db.query(`SELECT COUNT(*) AS count FROM turn_steering_messages
                      WHERE slack_user_msg_ts='800.000002'`).get() as any).count)
      .toBe(1);
    expect(listSessionUserPrompts(session.id, "800.000002")
      .filter((prompt: any) => prompt.slack_user_msg_ts === "800.000002"))
      .toEqual([{
        slack_user_msg_ts: "800.000002",
        user_text: "change direction",
        source_text: "change direction",
        replay_ready: 1,
        status: "sent",
        unreplayable_attachment_count: 0,
      }]);
  });

  test("reserves ingress before routing and finalizes the winning handler token", () => {
    registerProcessInstance("runtime-input", 123, "boot-input", "ticks-input");
    const first = claimSlackUserInput("C1", "801.000001", "token-first", "runtime-input");
    const retry = claimSlackUserInput("C1", "801.000001", "token-retry", "runtime-input");

    expect(first.claimed).toBeTrue();
    expect(retry.claimed).toBeFalse();
    expect(classifySlackUserInput("C1", "801.000001", "token-retry", "ignored")).toBeFalse();
    expect(classifySlackUserInput("C1", "801.000001", "token-first", "capture")).toBeTrue();
    expect(getSlackUserInputClaim("C1", "801.000001")?.kind).toBe("capture");
  });

  test("replays steering in actual enqueue order and slices by the selected input", () => {
    const session = createOrGetSession("C1", "802.000001", "codex");
    const turn = acquireSessionTurn(session.id, "802.000001", "initial");
    setTurnReplayInput(turn.id, "initial", 0);
    markTurnProviderStarted(turn.id);

    const arrivedFirst = createTurnSteeringMessage(turn.id, "802.000003", "B", "B");
    const arrivedSecond = createTurnSteeringMessage(turn.id, "802.000002", "A", "A");
    if (arrivedFirst.duplicate || arrivedSecond.duplicate) throw new Error("Expected unique steering inputs");
    markTurnSteeringMessageSending(arrivedFirst.row.id);
    markTurnSteeringMessageSent(arrivedFirst.row.id);
    markTurnSteeringMessageSending(arrivedSecond.row.id);
    markTurnSteeringMessageSent(arrivedSecond.row.id);
    finishTurn(turn.id, "done", "answer");
    setSessionStatus(session.id, "idle");

    expect(listSessionUserPrompts(session.id, "802.000002").map((prompt: any) => prompt.user_text))
      .toEqual(["initial", "B", "A"]);
  });

  test("keeps an acknowledgement crash gap explicitly ambiguous and non-replayable", () => {
    const session = createOrGetSession("C1", "803.000001", "codex");
    const turn = acquireSessionTurn(session.id, "803.000001", "initial");
    const steering = createTurnSteeringMessage(turn.id, "803.000002", "uncertain", "uncertain");
    if (steering.duplicate) throw new Error("Expected unique steering input");
    markTurnSteeringMessageSending(steering.row.id);
    markTurnSteeringMessageAmbiguous(steering.row.id, "service stopped after provider delivery");

    expect(listSessionUserPrompts(session.id, "803.000002")[1]).toMatchObject({
      status: "steering_ambiguous",
      replay_ready: 0,
    });
    expect(getSteeringMessageForSlackMessage("C1", "803.000002")).toMatchObject({
      status: "ambiguous",
      notice_status: "deferred",
    });
    expect(claimSteeringFailureNotice(steering.row.id)).toBeNull();
    expect(finalizeTurnSteeringMessageAmbiguity(steering.row.id)).toBeTrue();
    expect(getSteeringMessageForSlackMessage("C1", "803.000002")?.notice_status).toBe("pending");
  });

  test("does not finalize a provisional ambiguity while its exact provider owner lives", () => {
    registerProcessInstance("live-steering", 500, "boot-live", "ticks-live");
    const session = createOrGetSession("C1", "803.100001", "codex");
    const turn = acquireSessionTurn(session.id, "803.100001", "initial", "live-steering");
    const steering = createTurnSteeringMessage(turn.id, "803.100002", "uncertain", "uncertain");
    if (steering.duplicate) throw new Error("Expected unique steering input");
    markTurnSteeringMessageSending(steering.row.id);
    markTurnSteeringMessageAmbiguous(steering.row.id, "completion raced acknowledgement");

    expect(recoverDeferredSteeringFailureNotices((identity: any) => identity.pid === 500)).toBe(0);
    expect(getSteeringMessageForSlackMessage("C1", "803.100002")?.notice_status).toBe("deferred");
    expect(recoverDeferredSteeringFailureNotices(() => false)).toBe(1);
    expect(getSteeringMessageForSlackMessage("C1", "803.100002")?.notice_status).toBe("pending");
  });

  test("settles orphaned queued and sending guidance across every terminal turn phase", () => {
    registerProcessInstance("dead-steering-owner", 700, "dead-boot", "dead-ticks");
    const terminalStatuses = ["delivering", "done", "error", "delivery_parked"];
    const steeringRows: Array<{ ts: string; expected: string }> = [];
    for (const [index, status] of terminalStatuses.entries()) {
      for (const sending of [false, true]) {
        const threadTs = `810.${index}${sending ? "2" : "1"}0001`;
        const session = createOrGetSession("C1", threadTs, "codex");
        const turn = acquireSessionTurn(session.id, threadTs, "initial", "dead-steering-owner");
        db.query("UPDATE turns SET status=? WHERE id=?").run(status, turn.id);
        const messageTs = `${threadTs}-steer`;
        const steering = createTurnSteeringMessage(turn.id, messageTs, "guidance", "guidance");
        if (steering.duplicate) throw new Error("Expected unique steering input");
        if (sending) markTurnSteeringMessageSending(steering.row.id);
        steeringRows.push({ ts: messageTs, expected: sending ? "ambiguous" : "failed" });
      }
    }

    expect(recoverUnsettledSteeringMessages(() => false)).toEqual({ failed: 4, ambiguous: 4 });
    for (const row of steeringRows) {
      expect(getSteeringMessageForSlackMessage("C1", row.ts)).toMatchObject({
        status: row.expected,
        notice_status: "pending",
      });
    }
    expect(listPendingSteeringFailureNotices()).toHaveLength(8);
  });

  test("does not settle guidance while its exact provider owner is alive", () => {
    registerProcessInstance("live-steering-owner", 701, "live-boot", "live-ticks");
    const session = createOrGetSession("C1", "811.000001", "codex");
    const turn = acquireSessionTurn(session.id, "811.000001", "initial", "live-steering-owner");
    db.query("UPDATE turns SET status='done' WHERE id=?").run(turn.id);
    const steering = createTurnSteeringMessage(turn.id, "811.000002", "guidance", "guidance");
    if (steering.duplicate) throw new Error("Expected unique steering input");
    markTurnSteeringMessageSending(steering.row.id);

    expect(recoverUnsettledSteeringMessages((identity: any) => identity.pid === 701))
      .toEqual({ failed: 0, ambiguous: 0 });
    expect(getSteeringMessageForSlackMessage("C1", "811.000002")?.status).toBe("sending");
  });

  test("preserves and surfaces pending ingress owned by a dead runtime", () => {
    registerProcessInstance("dead-input-runtime", 321, "dead-boot", "dead-ticks");
    claimSlackUserInput("C1", "804.000001", "dead-token", "dead-input-runtime", {
      replyThreadTs: "804.000000",
      userId: "U1",
      userText: "please continue",
      files: [{ id: "F1" }],
    });
    claimSlackUserInput("C1", "804.000002", "live-token", "live-input-runtime");
    registerProcessInstance("live-input-runtime", 654, "live-boot", "live-ticks");

    const released = releaseOrphanedSlackInputClaims((identity: any) => identity.pid === 654);

    expect(released).toBe(1);
    expect(getSlackUserInputClaim("C1", "804.000001")).toMatchObject({
      kind: "ignored",
      reply_thread_ts: "804.000000",
      user_id: "U1",
      user_text: "please continue",
      files_json: '[{"id":"F1"}]',
      inline_capture: 0,
      recovery_notice_status: "pending",
    });
    expect(getSlackUserInputClaim("C1", "804.000002")?.claim_token).toBe("live-token");
    expect(listPendingSlackInputRecoveryNotices()).toHaveLength(1);
    expect(claimSlackInputRecoveryNotice("C1", "804.000001")).toMatchObject({
      recovery_notice_status: "sending",
      slack_thread_ts: "804.000000",
    });
    markSlackInputRecoveryNoticeRetry("C1", "804.000001", "Slack unavailable", 0);
    expect(recoverSlackInputRecoveryNoticeClaims()).toBe(0);
    expect(claimSlackInputRecoveryNotice("C1", "804.000001")).not.toBeNull();
    markSlackInputRecoveryNoticeDelivered("C1", "804.000001");
    expect(getSlackInputRecoveryNotice("C1", "804.000001")?.recovery_notice_status).toBe("delivered");
  });

  test("identifies recoverable inline captures before generic orphan release", () => {
    registerProcessInstance("dead-capture-runtime", 777, "dead-boot", "dead-ticks");
    claimSlackUserInput("C1", "804.100001", "capture-token", "dead-capture-runtime", {
      replyThreadTs: "804.100000",
      userId: "U1",
      userText: "/todo preserve me",
    });
    beginInlineCapture("C1", "804.100001", "capture-token");

    expect(listOrphanedSlackInputClaims(() => false)).toEqual([
      expect.objectContaining({
        slack_user_msg_ts: "804.100001",
        inline_capture: 1,
        kind: "pending",
      }),
    ]);
    expect(releaseOrphanedSlackInputClaims(() => false)).toBe(0);
    expect(getSlackUserInputClaim("C1", "804.100001")).toMatchObject({
      kind: "pending",
      capture_vault_status: "pending",
      capture_list_status: "pending",
      recovery_notice_status: "not_needed",
    });
  });

  test("does not make command-shaped input recoverable as capture before routing commits", () => {
    registerProcessInstance("dead-command-runtime", 778, "dead-boot", "dead-ticks");
    claimSlackUserInput("C1", "804.150001", "command-token", "dead-command-runtime", {
      replyThreadTs: "804.150000",
      userId: "U1",
      userText: "/todo intended as live steering",
    });

    expect(getSlackUserInputClaim("C1", "804.150001")).toMatchObject({
      inline_capture: 0,
      capture_vault_status: "not_needed",
      capture_list_status: "not_needed",
    });
    expect(listOrphanedSlackInputClaims(() => false)).toEqual([
      expect.objectContaining({
        slack_user_msg_ts: "804.150001",
        inline_capture: 0,
      }),
    ]);
    expect(releaseOrphanedSlackInputClaims(() => false)).toBe(1);
    expect(getSlackUserInputClaim("C1", "804.150001")).toMatchObject({
      kind: "ignored",
      recovery_notice_status: "pending",
    });
  });

  test("keeps command-shaped steering exclusively owned by its steering row", () => {
    const session = createOrGetSession("C1", "804.160000", "codex");
    const turn = acquireSessionTurn(session.id, "804.160000", "initial", "runtime-live");
    claimSlackUserInput("C1", "804.160001", "steering-token", "runtime-live", {
      replyThreadTs: "804.160000",
      userId: "U1",
      userText: "/note focus the active agent",
    });
    const steering = createTurnSteeringMessage(
      turn.id,
      "804.160001",
      "/note focus the active agent",
      "/note focus the active agent",
      "steering-token",
      "804.160000",
    );
    if (steering.duplicate) throw new Error("Expected unique steering input");

    expect(beginInlineCapture("C1", "804.160001", "steering-token")).toBeFalse();
    expect(getSlackUserInputClaim("C1", "804.160001")).toMatchObject({
      kind: "steering",
      inline_capture: 0,
      capture_vault_status: "not_needed",
      capture_list_status: "not_needed",
      turn_id: turn.id,
    });
  });

  test("finishes inline capture only after every sink and durably leases its confirmation", () => {
    claimSlackUserInput("C1", "804.200001", "capture-token", "runtime-live", {
      replyThreadTs: "804.200000",
      userId: "U1",
      userText: "/todo persist every phase",
    });
    beginInlineCapture("C1", "804.200001", "capture-token");

    expect(markInlineCaptureVaultDone("C1", "804.200001", "capture-token")).toBeTrue();
    expect(finishInlineCapture("C1", "804.200001", "capture-token")).toBeFalse();
    expect(markInlineCaptureListDone("C1", "804.200001", "capture-token", "list-item-1")).toBeTrue();
    expect(finishInlineCapture("C1", "804.200001", "capture-token")).toBeTrue();
    expect(getSlackUserInputClaim("C1", "804.200001")).toMatchObject({
      kind: "capture",
      capture_vault_status: "done",
      capture_list_status: "done",
      capture_list_item_id: "list-item-1",
      capture_confirmation_status: "pending",
    });
    expect(listPendingInlineCaptureConfirmations()).toHaveLength(1);

    expect(claimInlineCaptureConfirmation("C1", "804.200001")).toMatchObject({
      capture_confirmation_status: "sending",
      capture_confirmation_attempts: 1,
      slack_thread_ts: "804.200000",
    });
    expect(claimInlineCaptureConfirmation("C1", "804.200001")).toBeNull();
    markInlineCaptureConfirmationRetry("C1", "804.200001", "Slack unavailable", 0);
    expect(claimInlineCaptureConfirmation("C1", "804.200001")).toMatchObject({
      capture_confirmation_status: "sending",
      capture_confirmation_attempts: 2,
    });
    markInlineCaptureConfirmationDelivered("C1", "804.200001");
    expect(getInlineCaptureConfirmation("C1", "804.200001")?.capture_confirmation_status).toBe("delivered");
    expect(listPendingInlineCaptureConfirmations()).toEqual([]);
  });

  test("records an unsupported List sink explicitly and recovers interrupted confirmations", () => {
    claimSlackUserInput("C1", "804.300001", "capture-token", "runtime-live", {
      userId: "U1",
      userText: "/note vault-only fallback",
    });
    beginInlineCapture("C1", "804.300001", "capture-token");
    markInlineCaptureVaultDone("C1", "804.300001", "capture-token");
    expect(markInlineCaptureListSkipped(
      "C1", "804.300001", "capture-token", "Slack Lists unavailable",
    )).toBeTrue();
    expect(finishInlineCapture("C1", "804.300001", "capture-token")).toBeTrue();
    expect(claimInlineCaptureConfirmation("C1", "804.300001")).not.toBeNull();

    expect(recoverInlineCaptureConfirmationClaims()).toBe(1);
    expect(getInlineCaptureConfirmation("C1", "804.300001")).toMatchObject({
      capture_list_status: "skipped",
      processing_error: "Slack Lists unavailable",
      capture_confirmation_status: "pending",
    });
  });

  test("keeps failure notices pending until Slack delivery is recorded", () => {
    const session = createOrGetSession("C1", "805.000001", "codex");
    const turn = acquireSessionTurn(session.id, "805.000001", "initial");
    const steering = createTurnSteeringMessage(turn.id, "805.000002", "late", "late");
    if (steering.duplicate) throw new Error("Expected unique steering input");
    markTurnSteeringMessageFailed(steering.row.id, "turn ended");

    expect(listPendingSteeringFailureNotices()).toHaveLength(1);
    expect(claimSteeringFailureNotice(steering.row.id)?.notice_status).toBe("sending");
    expect(claimSteeringFailureNotice(steering.row.id)).toBeNull();
    markSteeringFailureNoticeFailed(steering.row.id, "Slack unavailable");
    expect(listPendingSteeringFailureNotices()[0]).toMatchObject({
      notice_status: "pending",
      notice_attempts: 1,
      notice_error: "Slack unavailable",
    });
    expect(claimSteeringFailureNotice(steering.row.id)).not.toBeNull();
    markSteeringFailureNoticeDelivered(steering.row.id);
    expect(listPendingSteeringFailureNotices()).toEqual([]);
  });

  test("recovers interrupted notice claims and preserves the visible reply thread", () => {
    const session = createOrGetSession("C1", "anchor.000001", "codex");
    const turn = acquireSessionTurn(session.id, "visible.000001", "initial");
    const steering = createTurnSteeringMessage(
      turn.id, "visible.000002", "late", "late", undefined, "visible.000001",
    );
    if (steering.duplicate) throw new Error("Expected unique steering input");
    markTurnSteeringMessageFailed(steering.row.id, "turn ended");
    expect(claimSteeringFailureNotice(steering.row.id)?.slack_thread_ts).toBe("visible.000001");

    expect(recoverSteeringFailureNoticeClaims()).toBe(1);
    expect(listPendingSteeringFailureNotices()[0].slack_thread_ts).toBe("visible.000001");
  });

  test("a same-process failure releases only its own pending ingress token", () => {
    claimSlackUserInput("C1", "806.000001", "winning-token", "runtime-live");

    expect(releasePendingSlackUserInput("C1", "806.000001", "wrong-token")).toBe(false);
    expect(releasePendingSlackUserInput("C1", "806.000001", "winning-token")).toBe(true);
    expect(claimSlackUserInput("C1", "806.000001", "retry-token", "runtime-live").claimed).toBe(true);
  });

  test("a same-process exception preserves its input envelope for recovery", () => {
    claimSlackUserInput("C1", "807.000001", "winning-token", "runtime-live", {
      replyThreadTs: "807.000000",
      userId: "U2",
      userText: "do not lose me",
    });

    expect(failPendingSlackUserInput(
      "C1",
      "807.000001",
      "winning-token",
      "unexpected handler failure",
    )).toBeTrue();
    expect(getSlackUserInputClaim("C1", "807.000001")).toMatchObject({
      kind: "ignored",
      processing_error: "unexpected handler failure",
      recovery_notice_status: "pending",
      reply_thread_ts: "807.000000",
      user_id: "U2",
      user_text: "do not lose me",
    });
  });

  test("waits through a second SQLite writer instead of losing an acknowledgement", async () => {
    const session = createOrGetSession("C1", "808.000001", "codex");
    const turn = acquireSessionTurn(session.id, "808.000001", "initial");
    const steering = createTurnSteeringMessage(turn.id, "808.000002", "guidance", "guidance");
    if (steering.duplicate) throw new Error("Expected unique steering input");
    markTurnSteeringMessageSending(steering.row.id);

    const child = Bun.spawn([
      process.execPath,
      "-e",
      'import { Database } from "bun:sqlite"; const db = new Database(process.env.CONCIERGE_STATE_DIR + "/state.db"); db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE"); console.log("locked"); setTimeout(() => { db.exec("ROLLBACK"); db.close(); }, 250);',
    ], { env: process.env, stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    const firstOutput = await reader.read();
    expect(new TextDecoder().decode(firstOutput.value)).toContain("locked");

    markTurnSteeringMessageSent(steering.row.id);
    await child.exited;
    expect(getSteeringMessageForSlackMessage("C1", "808.000002")?.status).toBe("sent");
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
    markTurnResponseDelivered(deliveryTurn.id);
    finishDeliveredTurn(deliveryTurn.id);

    expect(reconcileComparisonRequests()).toEqual({ done: 0, error: 2, pending: 0 });
    expect(db.query("SELECT request_id, status FROM comparison_requests ORDER BY request_id").all()).toEqual([
      { request_id: "claim-crash", status: "error" },
      { request_id: "delivery-crash", status: "done" },
      { request_id: "provider-crash", status: "error" },
    ]);
  });
});

describe("acquireSessionTurn", () => {
  test("serializes first-turn admission and UUID binding for a persistent channel", () => {
    db.query(`INSERT INTO channels (slack_channel_id, slack_channel_name, vault_path, session_mode)
              VALUES ('C1', 'concierge', '/tmp/concierge', 'single-persistent')`).run();
    const sessionThreadTs = persistentSessionThreadTs("C1");
    const firstReservation = reserveSessionForThread("C1", sessionThreadTs, "codex");
    const firstSession = firstReservation.session;
    const firstTurn = acquireSessionTurn(
      firstSession.id,
      "900.000001",
      "first request",
      "runtime-1",
      undefined,
      "900.000001",
    );

    const secondReservation = reserveSessionForThread("C1", sessionThreadTs, "claude-code");
    const secondSession = secondReservation.session;
    const secondTurn = acquireSessionTurn(
      secondSession.id,
      "901.000001",
      "competing request",
      "runtime-2",
      undefined,
      "901.000001",
    );

    expect(firstTurn).toMatchObject({ acquired: true, queued: false });
    expect(secondTurn).toMatchObject({ acquired: false, queued: true });
    expect(firstReservation.created).toBeTrue();
    expect(secondReservation.created).toBeFalse();
    expect(secondSession.id).toBe(firstSession.id);
    expect(secondSession.provider_id).toBe("codex");
    expect((db.query("SELECT COUNT(*) AS count FROM sessions WHERE slack_channel_id='C1'").get() as any).count)
      .toBe(1);
    expect(bindChannelDefaultSessionUuid("C1", "provider-session-1")).toBe("provider-session-1");
    expect(bindChannelDefaultSessionUuid("C1", "provider-session-2")).toBe("provider-session-1");
  });

  test("preserves a second Pebble-style top-level input for restart execution in its own thread", () => {
    db.query(`INSERT INTO channels (
      slack_channel_id, slack_channel_name, vault_path, provider_default, mode, session_mode
    ) VALUES ('C1', 'slack-inbox', '/tmp/slack-inbox', 'claude-code', 'agent-auto', 'single-persistent')`).run();
    const sessionThreadTs = persistentSessionThreadTs("C1");
    const session = createOrGetSession("C1", sessionThreadTs, "claude-code");
    claimSlackUserInput("C1", "1787196473.089489", "claim-a", "runtime-1", {
      replyThreadTs: "1787196473.089489",
      userId: "U1",
      userText: "Click it on my link.",
    });
    claimSlackUserInput("C1", "1787196473.317689", "claim-b", "runtime-1", {
      replyThreadTs: "1787196473.317689",
      userId: "U1",
      userText: "Hey, what restaurants are open around me? I'm in New York, 26th and Third.",
    });

    const first = acquireSessionTurn(
      session.id,
      "1787196473.089489",
      "Click it on my link.",
      "runtime-1",
      "claim-a",
      "1787196473.089489",
    );
    const second = acquireSessionTurn(
      session.id,
      "1787196473.317689",
      "Hey, what restaurants are open around me? I'm in New York, 26th and Third.",
      "runtime-1",
      "claim-b",
      "1787196473.317689",
    );

    expect(first.acquired).toBeTrue();
    expect(second.queued).toBeTrue();
    expect(getTurnStatusProjection(second.id)).toMatchObject({
      slack_thread_ts: "1787196473.317689",
      projection_status: "pending",
    });
    upsertSession("C1", sessionThreadTs, "claude-code", "provider-session-1", { status: "running" });
    finishTurn(first.id, "done", "first done");

    expect(claimNextQueuedTurn("runtime-2")).toMatchObject({
      turn_id: second.id,
      slack_channel_id: "C1",
      session_thread_ts: sessionThreadTs,
      provider_id: "claude-code",
      agent_session_uuid: "provider-session-1",
      slack_user_msg_ts: "1787196473.317689",
      reply_thread_ts: "1787196473.317689",
      user_id: "U1",
      turn_user_text: "Hey, what restaurants are open around me? I'm in New York, 26th and Third.",
      claim_user_text: "Hey, what restaurants are open around me? I'm in New York, 26th and Third.",
      files_json: "[]",
    });
  });

  test("durably queues rapid turns and promotes them in FIFO order", () => {
    const session = createOrGetSession("C1", "333.000001", "codex");

    const first = acquireSessionTurn(session.id, "333.000002", "first", "runtime-1");
    const second = acquireSessionTurn(session.id, "333.000003", "second", "runtime-1");
    const third = acquireSessionTurn(session.id, "333.000004", "third", "runtime-1");
    const runningTurns = db.query("SELECT COUNT(*) AS count FROM turns WHERE status='running'").get() as any;
    const queuedTurns = db.query("SELECT COUNT(*) AS count FROM turns WHERE status='queued'").get() as any;

    expect(first).toMatchObject({ duplicate: false, acquired: true, queued: false });
    expect(second).toMatchObject({ duplicate: false, acquired: false, queued: true });
    expect(third).toMatchObject({ duplicate: false, acquired: false, queued: true });
    expect(runningTurns.count).toBe(1);
    expect(queuedTurns.count).toBe(2);
    expect(getTurnStatusProjection(second.id)).toMatchObject({
      desired_text: "Status: queued - another turn is using this agent session; this will start automatically",
      desired_revision: 1,
      projection_status: "pending",
    });
    const queuedProjection = claimTurnStatusProjection(second.id, Date.now());
    expect(queuedProjection?.desired_revision).toBe(1);
    requestTurnStatusProjection(second.id, "Status: working - promoted");
    markTurnStatusProjectionDelivered(second.id, 1);
    expect(getTurnStatusProjection(second.id)).toMatchObject({
      desired_text: "Status: working - promoted",
      desired_revision: 2,
      projected_revision: 1,
      projection_status: "pending",
    });
    expect((db.query("SELECT status FROM sessions WHERE id=?").get(session.id) as any).status).toBe("running");

    finishTurn(first.id, "done", "first done");
    const promotedSecond = claimNextQueuedTurn("runtime-2");
    expect(promotedSecond).toMatchObject({ turn_id: second.id, session_id: session.id });
    expect((db.query("SELECT status, owner_instance_id FROM turns WHERE id=?").get(second.id) as any))
      .toEqual({ status: "running", owner_instance_id: "runtime-2" });
    expect(claimNextQueuedTurn("runtime-2")).toBeNull();

    finishTurn(second.id, "done", "second done");
    const promotedThird = claimNextQueuedTurn("runtime-3");
    expect(promotedThird).toMatchObject({ turn_id: third.id, session_id: session.id });
  });

  test("does not promote queued work through the deployment gate", () => {
    const session = createOrGetSession("C1", "334.000001", "codex");
    const first = acquireSessionTurn(session.id, "334.000002", "first", "runtime-1");
    const second = acquireSessionTurn(session.id, "334.000003", "second", "runtime-1");
    finishTurn(first.id, "done", "first done");
    db.query(`INSERT INTO deployment_drain
      (singleton, token, owner_pid, owner_boot_id, owner_start_ticks)
      VALUES (1, 'deploy-token', 123, 'boot', '456')`).run();

    expect(second.queued).toBeTrue();
    expect(claimNextQueuedTurn("runtime-2")).toBeNull();
    expect((db.query("SELECT status, owner_instance_id FROM turns WHERE id=?").get(second.id) as any))
      .toEqual({ status: "queued", owner_instance_id: null });

    db.query("DELETE FROM deployment_drain WHERE singleton=1").run();
    expect(claimNextQueuedTurn("runtime-2")).toMatchObject({ turn_id: second.id });
  });

  test("claims different sessions independently while preserving each session FIFO", () => {
    const firstSession = createOrGetSession("C1", "334.100001", "codex");
    const secondSession = createOrGetSession("C1", "334.200001", "codex");
    const firstLive = acquireSessionTurn(firstSession.id, "334.100002", "first-a", "runtime-1");
    const secondLive = acquireSessionTurn(secondSession.id, "334.200002", "first-b", "runtime-1");
    const firstQueued = acquireSessionTurn(firstSession.id, "334.100003", "second-a", "runtime-1");
    const secondQueued = acquireSessionTurn(secondSession.id, "334.200003", "second-b", "runtime-1");
    finishTurn(firstLive.id, "done", "done-a");
    finishTurn(secondLive.id, "done", "done-b");

    const firstClaim = claimNextQueuedTurn("runtime-2");
    const secondClaim = claimNextQueuedTurn("runtime-2");

    expect(firstClaim).toMatchObject({ turn_id: firstQueued.id, session_id: firstSession.id });
    expect(secondClaim).toMatchObject({ turn_id: secondQueued.id, session_id: secondSession.id });
  });

  test("promotes restart work only after its orphaned predecessor is recovered", () => {
    const session = createOrGetSession("C1", "334.300001", "codex");
    const predecessor = acquireSessionTurn(session.id, "334.300002", "first", "dead-runtime");
    const successor = acquireSessionTurn(session.id, "334.300003", "second", "dead-runtime");

    expect(successor.queued).toBeTrue();
    expect(claimNextQueuedTurn("runtime-2")).toBeNull();
    expect(interruptOrphanedTurn(predecessor.id, "dead-runtime", "owner died")).toBeTrue();
    expect(claimNextQueuedTurn("runtime-2")).toMatchObject({
      turn_id: successor.id,
      agent_session_uuid: null,
    });
  });

  test("atomically fails a running turn and releases its session", () => {
    const session = createOrGetSession("C1", "335.000001", "codex");
    const turn = acquireSessionTurn(session.id, "335.000002", "work", "runtime-1");

    expect(failRunningTurnAndReleaseSession(
      turn.id,
      "runtime-1",
      "setup failed",
      "Status: error - setup failed",
    )).toBeTrue();
    expect(db.query(`SELECT status, agent_text, owner_instance_id, status_desired_text
                     FROM turns WHERE id=?`).get(turn.id)).toEqual({
      status: "error",
      agent_text: "setup failed",
      owner_instance_id: null,
      status_desired_text: "Status: error - setup failed",
    });
    expect((db.query("SELECT status FROM sessions WHERE id=?").get(session.id) as any).status).toBe("error");
    expect(failRunningTurnAndReleaseSession(turn.id, "runtime-1", "again")).toBeFalse();
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

  test("atomically refuses a preclaimed production input after the drain gate wins", () => {
    const session = createOrGetSession("C1", "445.000001", "codex");
    claimSlackUserInput("C1", "445.000002", "claim-token", "runtime-1");
    db.query(`INSERT INTO deployment_drain
      (singleton, token, owner_pid, owner_boot_id, owner_start_ticks)
      VALUES (1, 'deploy-token', 123, 'boot', '456')`).run();

    const turn = acquireSessionTurn(
      session.id, "445.000002", "during deploy", "runtime-1", "claim-token",
    );

    expect(turn).toMatchObject({ acquired: false, draining: true });
    expect(getSlackUserInputClaim("C1", "445.000002")).toMatchObject({
      kind: "draining",
      recovery_notice_status: "pending",
      recovery_notice_next_attempt_ms: 0,
    });
    expect(listPendingSlackInputRecoveryNotices()).toEqual([
      expect.objectContaining({
        slack_channel_id: "C1",
        slack_user_msg_ts: "445.000002",
        slack_thread_ts: "445.000002",
        kind: "draining",
      }),
    ]);
    expect((db.query("SELECT COUNT(*) AS count FROM turns").get() as any).count).toBe(0);
  });

  test("atomically queues a drain notice when the in-process gate rejects an input", () => {
    claimSlackUserInput("C1", "446.000002", "claim-token", "runtime-1", {
      replyThreadTs: "446.000001",
      userId: "U1",
      userText: "during shutdown",
    });

    expect(classifySlackUserInput("C1", "446.000002", "claim-token", "draining")).toBeTrue();
    expect(getSlackUserInputClaim("C1", "446.000002")).toMatchObject({
      kind: "draining",
      recovery_notice_status: "pending",
      recovery_notice_next_attempt_ms: 0,
    });
    expect(claimSlackUserInput("C1", "446.000002", "duplicate-token", "runtime-2")).toMatchObject({
      claimed: false,
      row: expect.objectContaining({
        kind: "draining",
        recovery_notice_status: "pending",
      }),
    });
  });

  test("recovers an interrupted drain notice and keeps duplicate delivery idempotent", () => {
    claimSlackUserInput("C1", "447.000002", "claim-token", "runtime-1", {
      replyThreadTs: "447.000001",
      userId: "U1",
      userText: "during shutdown",
    });
    classifySlackUserInput("C1", "447.000002", "claim-token", "draining");

    expect(claimSlackInputRecoveryNotice("C1", "447.000002")).toMatchObject({
      recovery_notice_status: "sending",
      recovery_notice_attempts: 1,
      kind: "draining",
    });
    expect(recoverSlackInputRecoveryNoticeClaims()).toBe(1);
    expect(claimSlackInputRecoveryNotice("C1", "447.000002")).toMatchObject({
      recovery_notice_status: "sending",
      recovery_notice_attempts: 2,
    });
    markSlackInputRecoveryNoticeDelivered("C1", "447.000002");
    expect(claimSlackInputRecoveryNotice("C1", "447.000002")).toBeNull();
    expect(listPendingSlackInputRecoveryNotices()).toEqual([]);
  });

  for (const route of ["in-process", "database"] as const) {
    test(`${route} drain notices survive transient, permanent, restart, and duplicate delivery paths`, async () => {
      if (route === "database") {
        db.query(`INSERT INTO deployment_drain
          (singleton, token, owner_pid, owner_boot_id, owner_start_ticks)
          VALUES (1, 'deploy-token', 123, 'boot', '456')`).run();
      }
      const rejectForDrain = (userMessageTs: string) => {
        claimSlackUserInput("C1", userMessageTs, `claim-${userMessageTs}`, "runtime-1", {
          replyThreadTs: "448.000001",
          userId: "U1",
          userText: `request ${userMessageTs}`,
        });
        if (route === "in-process") {
          expect(classifySlackUserInput(
            "C1", userMessageTs, `claim-${userMessageTs}`, "draining",
          )).toBeTrue();
          return;
        }
        const session = createOrGetSession("C1", userMessageTs, "codex");
        expect(acquireSessionTurn(
          session.id,
          userMessageTs,
          `request ${userMessageTs}`,
          "runtime-1",
          `claim-${userMessageTs}`,
        )).toMatchObject({ acquired: false, draining: true });
      };

      rejectForDrain("448.000002");
      let transientDeliveryAttempts = 0;
      expect(await runInputRecoveryNotice(
        "448.000002",
        async () => {
          transientDeliveryAttempts += 1;
          if (transientDeliveryAttempts === 1) {
            throw Object.assign(new Error("Slack temporarily unavailable"), { code: "transient" });
          }
        },
        (error) => (error as any)?.code === "transient",
      )).toBe("delivered");
      expect(transientDeliveryAttempts).toBe(2);

      let duplicateDeliveryAttempts = 0;
      expect(await runInputRecoveryNotice(
        "448.000002",
        async () => { duplicateDeliveryAttempts += 1; },
        () => false,
      )).toBe("delivered");
      expect(duplicateDeliveryAttempts).toBe(0);
      expect(claimSlackUserInput(
        "C1", "448.000002", "duplicate-token", "runtime-2",
      ).claimed).toBeFalse();

      rejectForDrain("448.000003");
      expect(await runInputRecoveryNotice(
        "448.000003",
        async () => { throw new Error("Slack permanently rejected the notice"); },
        () => false,
      )).toBe("permanent_failure");
      expect(getSlackInputRecoveryNotice("C1", "448.000003")).toMatchObject({
        kind: "draining",
        recovery_notice_status: "parked",
        recovery_notice_attempts: 1,
      });

      rejectForDrain("448.000004");
      expect(claimSlackInputRecoveryNotice("C1", "448.000004")?.recovery_notice_status).toBe("sending");
      expect(recoverSlackInputRecoveryNoticeClaims()).toBe(1);
      expect(await runInputRecoveryNotice(
        "448.000004",
        async () => {},
        () => false,
      )).toBe("delivered");
      expect(getSlackInputRecoveryNotice("C1", "448.000004")).toMatchObject({
        kind: "draining",
        recovery_notice_status: "delivered",
        recovery_notice_attempts: 2,
      });
    });
  }

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
    createTurnSteeringMessage(turn.id, "666.000003", "queued", "raw before hydration");

    interruptOrphanedTurn(turn.id, "dead-runtime", "service stopped");

    expect((db.query("SELECT status, delivery_status FROM turns WHERE id=?").get(turn.id) as any))
      .toMatchObject({ status: "interrupted", delivery_status: "not_available" });
    expect((db.query("SELECT status FROM sessions WHERE id=?").get(session.id) as any).status).toBe("idle");
    expect((db.query("SELECT status, error, replay_text FROM turn_steering_messages WHERE turn_id=?").get(turn.id) as any))
      .toEqual({ status: "failed", error: "service stopped", replay_text: "raw before hydration" });
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

    markTurnResponseDelivered(turn.id);
    expect((db.query("SELECT status, delivery_status FROM turns WHERE id=?").get(turn.id) as any))
      .toMatchObject({ status: "delivering", delivery_status: "delivered" });
    expect((db.query("SELECT status FROM sessions WHERE id=?").get(session.id) as any).status).toBe("running");
    finishDeliveredTurn(turn.id);
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
