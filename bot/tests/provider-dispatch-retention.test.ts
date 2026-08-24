import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { acquireDatabaseTestLock } from "./db-lock";

const state = require("../src/state");
const {
  acquireSessionTurn,
  claimNextQueuedTurn,
  createTurnArtifactBatch,
  createOrGetSession,
  db,
  finishComparisonFromTurnOutcome,
  finishTurn,
  getTurnStatusProjection,
  getTurnArtifactBatch,
  getTurnReactionCleanup,
  parkRunningTurnAfterProviderFailure,
  resumeParkedSessionTurn,
  retryRunningTurnAfterProviderFailure,
} = state;

let releaseDatabaseTestLock: (() => void) | null = null;

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
});

afterEach(() => {
  releaseDatabaseTestLock?.();
  releaseDatabaseTestLock = null;
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

  test("keeps retrying and parked comparison outcomes nonterminal", () => {
    expect(finishComparisonFromTurnOutcome("missing-request", { status: "retry_queued" }))
      .toEqual({ status: "pending" });
    expect(finishComparisonFromTurnOutcome("missing-request", { status: "provider_parked" }))
      .toEqual({ status: "pending" });
  });
});
