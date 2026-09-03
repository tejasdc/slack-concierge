import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDatabaseTestLock } from "./db-lock";

const state = require("../src/state");
const {
  acquireSessionTurn,
  claimNextQueuedTurn,
  claimComparisonRequest,
  createTurnArtifactBatch,
  createOrGetSession,
  db,
  finishComparisonFromTurnOutcome,
  finishDeliveredTurn,
  finishTurn,
  getTurnStatusProjection,
  getTurnArtifactBatch,
  getTurnReactionCleanup,
  parkRunningTurnAfterProviderFailure,
  markTurnDelivering,
  markTurnResponseDelivered,
  resumeBlockedParkedHeadTurns,
  resumeParkedSessionTurn,
  retryRunningTurnAfterProviderFailure,
} = state;

let releaseDatabaseTestLock: (() => void) | null = null;
let scratchDir = "";

beforeEach(async () => {
  releaseDatabaseTestLock = await acquireDatabaseTestLock();
  db.query("DELETE FROM deployment_drain").run();
  db.query("DELETE FROM comparison_requests").run();
  db.query("DELETE FROM slack_thread_statuses").run();
  db.query("DELETE FROM slack_user_input_claims").run();
  db.query("DELETE FROM turn_steering_messages").run();
  db.query("DELETE FROM turn_delivery_chunks").run();
  db.query("DELETE FROM turns").run();
  db.query("DELETE FROM sessions").run();
  scratchDir = mkdtempSync(join(tmpdir(), "concierge-provider-retention-"));
});

afterEach(() => {
  releaseDatabaseTestLock?.();
  releaseDatabaseTestLock = null;
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

describe("durable provider dispatch retention", () => {
  test("retries the same turn after its due time with a new fenced attempt", () => {
    const session = createOrGetSession("C1", "1787555393.054739", "claude-code");
    const turn = acquireSessionTurn(session.id, "1787555393.054739", "monologue", "runtime-1");
    expect(turn).toMatchObject({ acquired: true, dispatchAttempt: 1 });
    createTurnArtifactBatch(turn.id, "attempt-1", "/tmp/attempt-1");

    expect(retryRunningTurnAfterProviderFailure({
      turnId: turn.id,
      ownerInstanceId: "runtime-1",
      dispatchAttempt: 1,
      error: "API Error: 529 Overloaded",
      nextAttemptMs: 20_000,
    })).toBeTrue();
    expect(claimNextQueuedTurn("runtime-2", 19_999)).toBeNull();
    expect(claimNextQueuedTurn("runtime-2", 20_000)).toMatchObject({
      turn_id: turn.id,
      dispatch_attempt: 2,
    });
    createTurnArtifactBatch(turn.id, "attempt-2", "/tmp/attempt-2");
    expect(getTurnArtifactBatch(turn.id)).toMatchObject({
      ownership_token: "attempt-2",
      directory_path: "/tmp/attempt-2",
      status: "collecting",
    });
    expect(retryRunningTurnAfterProviderFailure({
      turnId: turn.id,
      ownerInstanceId: "runtime-2",
      dispatchAttempt: 1,
      error: "stale attempt",
      nextAttemptMs: 30_000,
    })).toBeFalse();
  });

  test("parks access failures without losing FIFO and resumes the exact turn", () => {
    const session = createOrGetSession("C1", "1787545232.697419", "claude-code");
    const parked = acquireSessionTurn(session.id, "1787545232.697419", "original input", "runtime-1");
    expect(parkRunningTurnAfterProviderFailure({
      turnId: parked.id,
      ownerInstanceId: "runtime-1",
      dispatchAttempt: 1,
      failureClass: "parked_access",
      error: "Your organization has disabled Claude subscription access for Claude Code",
    })).toBeTrue();

    const successor = acquireSessionTurn(session.id, "1787545233.000000", "later input", "runtime-2");
    expect(successor.queued).toBeTrue();
    expect(claimNextQueuedTurn("runtime-2", 99_000)).toBeNull();
    expect(getTurnStatusProjection(parked.id)?.desired_text).toContain(`input preserved as turn ${parked.id}`);
    expect(getTurnReactionCleanup(parked.id)).not.toBeNull();

    expect(resumeParkedSessionTurn(parked.id)).toBe("resumed");
    expect(getTurnReactionCleanup(parked.id)).toBeNull();
    expect(resumeParkedSessionTurn(parked.id)).toBe("already_queued");
    expect(claimNextQueuedTurn("runtime-3", 99_000)).toMatchObject({ turn_id: parked.id });
    finishTurn(parked.id, "done", "recovered");
    expect(claimNextQueuedTurn("runtime-3", 99_000)).toMatchObject({ turn_id: successor.id });
  });

  test("refuses to resume a parked turn with staged artifact state", () => {
    const session = createOrGetSession("C1", "artifact-root", "claude-code");
    const turn = acquireSessionTurn(session.id, "artifact-message", "create a file", "runtime-1");
    const artifactDirectory = join(scratchDir, "reserved-artifacts");
    mkdirSync(artifactDirectory);
    createTurnArtifactBatch(turn.id, "attempt-1", artifactDirectory);
    expect(parkRunningTurnAfterProviderFailure({
      turnId: turn.id,
      ownerInstanceId: "runtime-1",
      dispatchAttempt: 1,
      failureClass: "parked_access",
      error: "provider access disabled",
    })).toBeTrue();
    writeFileSync(join(artifactDirectory, "preserved.txt"), "do not orphan me");

    expect(resumeParkedSessionTurn(turn.id)).toBe("unsafe");
    expect(getTurnArtifactBatch(turn.id)).toMatchObject({
      ownership_token: "attempt-1",
      directory_path: artifactDirectory,
      status: "collecting",
    });
  });

  test("settles a retried comparison after delivery without requiring restart reconciliation", () => {
    claimComparisonRequest({
      requestId: "comparison-retry",
      channelId: "C1",
      requestedBy: "U1",
      sourceSessionId: 42,
      sourceMessageTs: "source-message",
      targetProvider: "claude-code",
      targetModel: null,
    });
    const session = createOrGetSession("C1", "comparison-root", "claude-code");
    const turn = acquireSessionTurn(
      session.id,
      "comparison-root",
      "comparison prompt",
      "runtime-1",
      undefined,
      "comparison-root",
      { turnKind: "comparison", comparisonRequestId: "comparison-retry" },
    );
    expect(retryRunningTurnAfterProviderFailure({
      turnId: turn.id,
      ownerInstanceId: "runtime-1",
      dispatchAttempt: 1,
      error: "API Error: 529 Overloaded",
      nextAttemptMs: 20_000,
    })).toBeTrue();
    expect(claimNextQueuedTurn("runtime-2", 20_000)).toMatchObject({ turn_id: turn.id });

    markTurnDelivering(turn.id, "answer", "answer", 1);
    markTurnResponseDelivered(turn.id);
    expect(finishDeliveredTurn(turn.id)).toBeTrue();
    expect(db.query("SELECT status FROM comparison_requests WHERE request_id='comparison-retry'").get())
      .toEqual({ status: "done" });
  });

  test("keeps retrying and parked comparison outcomes nonterminal", () => {
    expect(finishComparisonFromTurnOutcome("missing-request", { status: "retry_queued" }))
      .toEqual({ status: "pending" });
    expect(finishComparisonFromTurnOutcome("missing-request", { status: "provider_parked" }))
      .toEqual({ status: "pending" });
  });

  test("auto-resumes a parked head turn only when a queued successor exists", () => {
    const session = createOrGetSession("C1", "auto-resume-root", "claude-code");
    const parked = acquireSessionTurn(session.id, "auto-resume-1", "first input", "runtime-1");
    expect(parkRunningTurnAfterProviderFailure({
      turnId: parked.id,
      ownerInstanceId: "runtime-1",
      dispatchAttempt: 1,
      failureClass: "parked_terminal",
      error: "Failed to authenticate: OAuth session expired and could not be refreshed",
    })).toBeTrue();

    expect(resumeBlockedParkedHeadTurns()).toEqual([]);

    const successor = acquireSessionTurn(session.id, "auto-resume-2", "second input", "runtime-1");
    expect(successor.queued).toBeTrue();
    expect(resumeBlockedParkedHeadTurns(session.id)).toEqual([parked.id]);

    expect(claimNextQueuedTurn("runtime-2", 99_000)).toMatchObject({ turn_id: parked.id });
    finishTurn(parked.id, "done", "recovered");
    expect(claimNextQueuedTurn("runtime-2", 99_000)).toMatchObject({ turn_id: successor.id });
  });

  test("a successor queued while the head is still running resumes only once the head parks", () => {
    // This is the settle-window sequence the index.ts deferred grant bridges:
    // at admission the head is running (cannot be resumed), and only a later
    // settlement, once the head has parked, can resume it.
    const session = createOrGetSession("C1", "settle-window-root", "claude-code");
    const head = acquireSessionTurn(session.id, "settle-window-1", "first input", "runtime-1");
    expect(head.acquired).toBeTrue();
    const successor = acquireSessionTurn(session.id, "settle-window-2", "second input", "runtime-1");
    expect(successor.queued).toBeTrue();

    // Admission-time boundary: the running head cannot be resumed yet.
    expect(resumeBlockedParkedHeadTurns(session.id)).toEqual([]);

    expect(parkRunningTurnAfterProviderFailure({
      turnId: head.id,
      ownerInstanceId: "runtime-1",
      dispatchAttempt: 1,
      failureClass: "parked_terminal",
      error: "Failed to authenticate: OAuth session expired and could not be refreshed",
    })).toBeTrue();

    // Settlement boundary: now the parked head with a queued successor resumes.
    expect(resumeBlockedParkedHeadTurns(session.id)).toEqual([head.id]);
    expect(claimNextQueuedTurn("runtime-2", 99_000)).toMatchObject({ turn_id: head.id });
  });

  test("grants one auto-resume per recovery boundary so a broken provider is not hammered", () => {
    const session = createOrGetSession("C1", "single-grant-root", "claude-code");
    const parked = acquireSessionTurn(session.id, "single-grant-1", "first input", "runtime-1");
    expect(parkRunningTurnAfterProviderFailure({
      turnId: parked.id,
      ownerInstanceId: "runtime-1",
      dispatchAttempt: 1,
      failureClass: "parked_terminal",
      error: "still broken",
    })).toBeTrue();
    acquireSessionTurn(session.id, "single-grant-2", "second input", "runtime-1");

    expect(resumeBlockedParkedHeadTurns(session.id)).toEqual([parked.id]);
    expect(claimNextQueuedTurn("runtime-2", 99_000)).toMatchObject({ turn_id: parked.id });
    expect(parkRunningTurnAfterProviderFailure({
      turnId: parked.id,
      ownerInstanceId: "runtime-2",
      dispatchAttempt: 2,
      failureClass: "parked_terminal",
      error: "still broken",
    })).toBeTrue();

    expect(resumeBlockedParkedHeadTurns(session.id)).toEqual([parked.id]);
  });

  test("resuming an agent-mode parked turn settles the orphaned pending legacy projection", () => {
    const session = createOrGetSession("C1", "agent-resume-root", "claude-code");
    const parked = acquireSessionTurn(session.id, "agent-resume-1", "agent input", "runtime-1", undefined, undefined, {
      projectionMode: "agent",
    });
    // park writes status_projection_status='pending'; the agent path normally
    // delivers the action notice afterward, but a restart can resume before that
    // happens, leaving the pending row for a worker that never selects it.
    expect(parkRunningTurnAfterProviderFailure({
      turnId: parked.id,
      ownerInstanceId: "runtime-1",
      dispatchAttempt: 1,
      failureClass: "parked_terminal",
      error: "Failed to authenticate: OAuth session expired and could not be refreshed",
    })).toBeTrue();
    expect(
      (db.query("SELECT status_projection_status FROM turns WHERE id=?").get(parked.id) as { status_projection_status: string })
        .status_projection_status,
    ).toBe("pending");
    acquireSessionTurn(session.id, "agent-resume-2", "later input", "runtime-1", undefined, undefined, {
      projectionMode: "agent",
    });

    expect(resumeBlockedParkedHeadTurns(session.id)).toEqual([parked.id]);
    const resumed = db.query("SELECT status, status_projection_status FROM turns WHERE id=?").get(parked.id);
    expect(resumed).toMatchObject({ status: "queued" });
    // The agent surface owns visible state on the re-running turn, so the
    // orphaned legacy projection must be settled rather than left pending.
    expect((resumed as { status_projection_status: string }).status_projection_status).toBe("not_needed");
  });

  test("resuming an agent-mode parked turn leaves an already-delivered attention notice intact", () => {
    const session = createOrGetSession("C1", "agent-delivered-root", "claude-code");
    const parked = acquireSessionTurn(session.id, "agent-delivered-1", "agent input", "runtime-1", undefined, undefined, {
      projectionMode: "agent",
    });
    expect(parkRunningTurnAfterProviderFailure({
      turnId: parked.id,
      ownerInstanceId: "runtime-1",
      dispatchAttempt: 1,
      failureClass: "parked_terminal",
      error: "Failed to authenticate: OAuth session expired and could not be refreshed",
    })).toBeTrue();
    db.query("UPDATE turns SET status_projection_status='delivered' WHERE id=?").run(parked.id);
    acquireSessionTurn(session.id, "agent-delivered-2", "later input", "runtime-1", undefined, undefined, {
      projectionMode: "agent",
    });

    expect(resumeBlockedParkedHeadTurns(session.id)).toEqual([parked.id]);
    expect(
      (db.query("SELECT status_projection_status FROM turns WHERE id=?").get(parked.id) as { status_projection_status: string })
        .status_projection_status,
    ).toBe("delivered");
  });

  test("leaves ambiguous parked turns and busy sessions alone", () => {
    const ambiguousSession = createOrGetSession("C1", "ambiguous-root", "claude-code");
    const ambiguous = acquireSessionTurn(ambiguousSession.id, "ambiguous-1", "ambiguous input", "runtime-1");
    expect(parkRunningTurnAfterProviderFailure({
      turnId: ambiguous.id,
      ownerInstanceId: "runtime-1",
      dispatchAttempt: 1,
      failureClass: "parked_ambiguous",
      error: "outcome unknown",
    })).toBeTrue();
    acquireSessionTurn(ambiguousSession.id, "ambiguous-2", "later input", "runtime-1");

    const runningSession = createOrGetSession("C1", "running-root", "claude-code");
    const running = acquireSessionTurn(runningSession.id, "running-1", "active input", "runtime-1");
    expect(running.acquired).toBeTrue();
    acquireSessionTurn(runningSession.id, "running-2", "queued input", "runtime-1");

    expect(resumeBlockedParkedHeadTurns()).toEqual([]);
    expect(db.query("SELECT status FROM turns WHERE id=?").get(ambiguous.id))
      .toEqual({ status: "parked" });
  });
});
