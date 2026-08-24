import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DeploymentControlStore,
  type ContinuationSnapshot,
} from "../../../deployment-control/kernel/state";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const DIGEST_A = "1".repeat(64);
const DIGEST_B = "2".repeat(64);
const DIGEST_C = "3".repeat(64);

function continuation(turn: number, session = 10): ContinuationSnapshot {
  return {
    sourceTurnId: turn,
    sourceSessionId: session,
    slackChannelId: "C-project",
    slackThreadTs: "1700000000.000001",
    requestedByUserId: "U-operator",
    providerId: "codex",
    providerModel: "gpt-5.6",
    reasoningEffort: "high",
    providerSessionUuid: "provider-session-1",
  };
}

function runToReleasing(store: DeploymentControlStore, generationId: string, sequence: number) {
  const attempt = store.createAttempt(generationId);
  store.claimAttempt({ attemptId: attempt.id, pid: 100 + sequence, bootId: "boot", startTicks: String(sequence) });
  store.transitionAttempt(attempt.id, "updating");
  store.transitionAttempt(attempt.id, "activating");
  store.transitionAttempt(attempt.id, "verifying");
  store.transitionAttempt(attempt.id, "releasing");
  return attempt;
}

describe("deployment repair control state", () => {
  let store: DeploymentControlStore;

  beforeEach(() => {
    store = new DeploymentControlStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("attempt failures preserve intents and a later success creates one exact-session handoff", () => {
    const first = store.requestIntent({ expectedCommit: COMMIT_A, continuation: continuation(1) });
    const second = store.requestIntent({ expectedCommit: COMMIT_B, continuation: continuation(2) });

    let incidentId = "";
    for (let index = 0; index < 3; index += 1) {
      const generation = store.prepareGeneration({
        desiredCommit: COMMIT_B,
        originUrl: "git@github.com:owner/slack-concierge.git",
        originObservedAt: new Date().toISOString(),
        includedIntentIds: [first.id, second.id],
      });
      const attempt = store.createAttempt(generation.id);
      store.claimAttempt({ attemptId: attempt.id, pid: 200 + index, bootId: "boot", startTicks: String(index) });
      store.transitionAttempt(attempt.id, "updating");
      const failed = store.failAttempt({
        attemptId: attempt.id,
        outcome: "failed",
        error: "functional probe failed",
        failureFingerprint: "verifying:service-probe",
      });
      incidentId ||= failed.incident!.id;
      expect(failed.incident!.id).toBe(incidentId);
      expect(store.listIntents("concierge").map((intent) => intent.status)).toEqual(["pending", "pending"]);
      expect(store.listPendingHandoffs()).toHaveLength(0);
    }

    const generation = store.prepareGeneration({
      desiredCommit: COMMIT_B,
      originUrl: "git@github.com:owner/slack-concierge.git",
      originObservedAt: new Date().toISOString(),
      includedIntentIds: [first.id, second.id],
    });
    const attempt = runToReleasing(store, generation.id, 4);
    store.succeedAttempt({
      attemptId: attempt.id,
      deployedCommit: COMMIT_B,
      serviceInvocationId: "invocation-4",
      evidence: { capture_probe: "passed", service_probe: "passed", admission_gates: "released" },
      satisfiedIntentIds: [first.id, second.id],
    });

    const handoffs = store.listPendingHandoffs();
    expect(handoffs).toHaveLength(1);
    expect(JSON.parse(handoffs[0]!.payload_json)).toMatchObject({
      requested_commits: [COMMIT_A, COMMIT_B],
      deployed_commit: COMMIT_B,
      service_invocation_id: "invocation-4",
    });
    expect(store.listIntents("concierge").map((intent) => intent.status)).toEqual([
      "verification_pending",
      "verification_pending",
    ]);

    const claimed = store.claimHandoff(handoffs[0]!.id, "bot-instance");
    expect(claimed?.provider_session_uuid).toBe("provider-session-1");
    store.settleHandoff(handoffs[0]!.id, "bot-instance", "delivered");
    expect(store.listIntents("concierge").map((intent) => intent.status)).toEqual(["verified", "verified"]);
  });

  test("one incident keeps one repair provider session across nested attempt failures", () => {
    const intent = store.requestIntent({ expectedCommit: COMMIT_A, continuation: continuation(1) });
    const generation = store.prepareGeneration({
      desiredCommit: COMMIT_A,
      originUrl: "origin",
      originObservedAt: new Date().toISOString(),
      includedIntentIds: [intent.id],
    });
    const attempt = store.createAttempt(generation.id);
    store.claimAttempt({ attemptId: attempt.id, pid: 123, bootId: "boot", startTicks: "1" });
    const failed = store.failAttempt({
      attemptId: attempt.id,
      outcome: "failed",
      error: "origin unavailable",
      failureFingerprint: "origin:unavailable",
    });
    const bound = store.bindRepairSession(failed.incident!.id, "codex", "repair-session-1");
    expect(bound.repair_session_uuid).toBe("repair-session-1");
    expect(store.bindRepairSession(bound.id, "codex", "repair-session-1").repair_session_uuid)
      .toBe("repair-session-1");
    expect(() => store.bindRepairSession(bound.id, "codex", "repair-session-2"))
      .toThrow("already bound");
  });

  test("state transitions reject skipped phases and terminal incident resurrection", () => {
    const intent = store.requestIntent({ expectedCommit: COMMIT_A, continuation: continuation(1) });
    const generation = store.prepareGeneration({
      desiredCommit: COMMIT_A,
      originUrl: "origin",
      originObservedAt: new Date().toISOString(),
      includedIntentIds: [intent.id],
    });
    const attempt = store.createAttempt(generation.id);
    expect(() => store.transitionAttempt(attempt.id, "activating")).toThrow("cannot transition");
    store.claimAttempt({ attemptId: attempt.id, pid: 123, bootId: "boot", startTicks: "1" });
    expect(() => store.transitionAttempt(attempt.id, "verifying")).toThrow("cannot transition");

    const failed = store.failAttempt({
      attemptId: attempt.id,
      outcome: "failed",
      error: "failed",
      failureFingerprint: "test:failed",
    });
    store.transitionIncident(failed.incident!.id, "diagnosing");
    store.transitionIncident(failed.incident!.id, "parked", "human authority required");
    expect(() => store.transitionIncident(failed.incident!.id, "resolved")).toThrow("cannot transition");
  });

  test("a parked incident cannot resume over a newer active incident", () => {
    const intent = store.requestIntent({ expectedCommit: COMMIT_A, continuation: continuation(1) });
    const firstGeneration = store.prepareGeneration({
      desiredCommit: COMMIT_A,
      originUrl: "origin",
      originObservedAt: new Date().toISOString(),
      includedIntentIds: [intent.id],
    });
    const firstAttempt = store.createAttempt(firstGeneration.id);
    const firstFailure = store.failAttempt({
      attemptId: firstAttempt.id,
      outcome: "failed",
      error: "first",
      failureFingerprint: "test:first",
    });
    store.transitionIncident(firstFailure.incident!.id, "parked", "paused");

    const secondGeneration = store.prepareGeneration({
      desiredCommit: COMMIT_A,
      originUrl: "origin",
      originObservedAt: new Date().toISOString(),
      includedIntentIds: [intent.id],
    });
    const secondAttempt = store.createAttempt(secondGeneration.id);
    const secondFailure = store.failAttempt({
      attemptId: secondAttempt.id,
      outcome: "failed",
      error: "second",
      failureFingerprint: "test:second",
    });
    expect(secondFailure.incident!.id).not.toBe(firstFailure.incident!.id);
    expect(() => store.transitionIncident(firstFailure.incident!.id, "diagnosing"))
      .toThrow("cannot resume while incident");
  });

  test("incident notifications permit one proven root and immutable thread updates", () => {
    const intent = store.requestIntent({ expectedCommit: COMMIT_A, continuation: continuation(1) });
    const generation = store.prepareGeneration({
      desiredCommit: COMMIT_A,
      originUrl: "origin",
      originObservedAt: new Date().toISOString(),
      includedIntentIds: [intent.id],
    });
    const attempt = store.createAttempt(generation.id);
    const failure = store.failAttempt({
      attemptId: attempt.id,
      outcome: "failed",
      error: "candidate unhealthy",
      failureFingerprint: "health:candidate",
    });
    const incidentId = failure.incident!.id;
    expect(() => store.prepareNotification({
      incidentId,
      kind: "forward_repair_succeeded",
      payload: { incident_id: incidentId },
      payloadDigest: DIGEST_A,
      clientMessageId: "client-terminal",
    })).toThrow("cannot create a new incident root");

    const root = store.prepareNotification({
      incidentId,
      kind: "runtime_restored",
      payload: { incident_id: incidentId, restored_commit: COMMIT_A },
      payloadDigest: DIGEST_B,
      clientMessageId: "client-root",
    });
    expect(store.prepareNotification({
      incidentId,
      kind: "runtime_restored",
      payload: { incident_id: incidentId, restored_commit: COMMIT_A },
      payloadDigest: DIGEST_B,
      clientMessageId: "client-root",
    }).id).toBe(root.id);
    expect(() => store.prepareNotification({
      incidentId,
      kind: "runtime_restored",
      payload: { incident_id: incidentId, restored_commit: COMMIT_B },
      payloadDigest: DIGEST_C,
      clientMessageId: "client-root",
    })).toThrow("changed after persistence");
    store.claimNotification(root.id);
    store.settleNotification(root.id, "delivered", { slackTs: "1700000000.000001" });

    const followup = store.prepareNotification({
      incidentId,
      kind: "forward_repair_succeeded",
      payload: { incident_id: incidentId, deployed_commit: COMMIT_B },
      payloadDigest: DIGEST_C,
      clientMessageId: "client-terminal",
    });
    expect(followup.root_alert_id).toBe(root.id);
  });

  test("release promotion is monotonic and preserves exactly one last known good", () => {
    const first = store.recordRelease({
      gitCommit: COMMIT_A,
      artifactPath: `/releases/${DIGEST_A}`,
      artifactDigest: DIGEST_A,
      runtimeDigest: DIGEST_B,
      compatibilityDigest: DIGEST_C,
      rollbackSafe: true,
      evidence: { service_probe: "passed" },
    });
    store.markReleaseHealthy(first.id, { service_probe: "passed" });
    expect(store.promoteRelease(first.id, { final_probe: "passed" }).status).toBe("last_known_good");

    const second = store.recordRelease({
      gitCommit: COMMIT_B,
      artifactPath: `/releases/${DIGEST_B}`,
      artifactDigest: DIGEST_B,
      runtimeDigest: DIGEST_C,
      compatibilityDigest: DIGEST_A,
      rollbackSafe: true,
      evidence: { service_probe: "passed" },
    });
    store.markReleaseHealthy(second.id, { service_probe: "passed" });
    expect(store.promoteRelease(second.id, { final_probe: "passed" }).id).toBe(second.id);
    expect(store.lastKnownGood()?.id).toBe(second.id);
    expect(store.database.query("SELECT status FROM deployment_releases WHERE id=?").get(first.id))
      .toEqual({ status: "superseded" });
  });

  test("a failed attempt records restoration only to the exact last-known-good release", () => {
    const intent = store.requestIntent({ expectedCommit: COMMIT_A, continuation: continuation(1) });
    const generation = store.prepareGeneration({
      desiredCommit: COMMIT_A,
      originUrl: "origin",
      originObservedAt: new Date().toISOString(),
      includedIntentIds: [intent.id],
    });
    const attempt = store.createAttempt(generation.id);
    store.failAttempt({
      attemptId: attempt.id,
      outcome: "failed",
      error: "candidate unhealthy",
      failureFingerprint: "health:candidate",
    });
    const release = store.recordRelease({
      gitCommit: COMMIT_B,
      artifactPath: `/releases/${DIGEST_A}`,
      artifactDigest: DIGEST_A,
      runtimeDigest: DIGEST_B,
      compatibilityDigest: DIGEST_C,
      rollbackSafe: true,
      evidence: {},
    });
    store.markReleaseHealthy(release.id, { service_probe: "passed" });
    store.promoteRelease(release.id, { final_probe: "passed" });
    expect(store.markAttemptRestored({
      attemptId: attempt.id,
      releaseId: release.id,
      deployedCommit: COMMIT_B,
      serviceInvocationId: "invocation-restored",
      evidence: { service_probe: "passed" },
    })).toMatchObject({ status: "restored", deployed_commit: COMMIT_B });
  });

  test("learning classifications stay separate from repair review evidence", () => {
    const intent = store.requestIntent({ expectedCommit: COMMIT_A, continuation: continuation(1) });
    const generation = store.prepareGeneration({
      desiredCommit: COMMIT_A,
      originUrl: "origin",
      originObservedAt: new Date().toISOString(),
      includedIntentIds: [intent.id],
    });
    const attempt = store.createAttempt(generation.id);
    store.claimAttempt({ attemptId: attempt.id, pid: 123, bootId: "boot", startTicks: "1" });
    const incident = store.failAttempt({
      attemptId: attempt.id,
      outcome: "failed",
      error: "missing evidence",
      failureFingerprint: "evidence:missing",
    }).incident!;

    const reviewId = store.recordReview({
      incidentId: incident.id,
      reviewKind: "repair",
      verdict: "ship",
      baseCommit: COMMIT_A,
      headCommit: COMMIT_B,
      treeDigest: DIGEST_A,
      policyDigest: DIGEST_B,
      enforcementDigest: DIGEST_C,
      evidenceDigest: "4".repeat(64),
      reviewerIdentity: "independent-review-session",
    });
    const learningId = store.recordLearning({
      incidentId: incident.id,
      classification: "evidence_gap",
      summary: "The incident packet omitted the current service invocation.",
      retrievalTrace: { selected: [] },
      productionEvidence: { repaired: true },
    });
    expect(reviewId).not.toBe(learningId);
    expect(store.database.query("SELECT classification, status FROM deployment_learning WHERE id=?").get(learningId))
      .toEqual({ classification: "evidence_gap", status: "recorded" });
  });
});
