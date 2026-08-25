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

  test("a blocked repair parks through a durable owner-notification state", () => {
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
      error: "deployment control failed",
      failureFingerprint: "control:failed",
    });
    const incidentId = failure.incident!.id;
    store.transitionIncident(incidentId, "diagnosing");
    store.prepareRepairRun({
      incidentId,
      baseCommit: COMMIT_A,
      baselineLocalCommit: COMMIT_B,
      repositoryPath: "/repairs/incident",
      evidenceDigest: DIGEST_A,
      providerCapabilityDigest: DIGEST_B,
      capabilityExpiresAtMs: 1_900_000_000_000,
      workerUnit: `concierge-deployment-repair@${incidentId}.service`,
    });
    store.markRepairRunLaunched(incidentId);
    store.bindRepairSession(incidentId, "codex", "repair-session");
    const blocked = store.blockRepairRun({
      incidentId,
      providerSessionUuid: "repair-session",
      result: { outcome: "blocked", next_action: "park" },
      error: "protected authority change required",
    });
    expect(blocked.incident.status).toBe("awaiting_owner_fix");
    expect(blocked.repairRun.status).toBe("parked");
    expect(store.getActiveIncident()?.id).toBe(incidentId);
    expect(store.transitionIncident(incidentId, "parked", blocked.incident.error).status).toBe("parked");
    expect(store.getActiveIncident()).toBeNull();
  });

  test("repair and independent review stay bound to exact sessions and immutable digests", () => {
    const intent = store.requestIntent({ expectedCommit: COMMIT_A, continuation: continuation(1) });
    const generation = store.prepareGeneration({
      desiredCommit: COMMIT_A,
      originUrl: "origin",
      originObservedAt: new Date().toISOString(),
      includedIntentIds: [intent.id],
    });
    const attempt = store.createAttempt(generation.id);
    const failed = store.failAttempt({
      attemptId: attempt.id,
      outcome: "failed",
      error: "deployment control failed",
      failureFingerprint: "control:failed",
    });
    const incident = store.transitionIncident(failed.incident!.id, "diagnosing");
    store.prepareRepairRun({
      incidentId: incident.id,
      baseCommit: COMMIT_A,
      baselineLocalCommit: COMMIT_B,
      repositoryPath: "/repairs/incident",
      evidenceDigest: DIGEST_A,
      providerCapabilityDigest: DIGEST_B,
      capabilityExpiresAtMs: 1_900_000_000_000,
      workerUnit: `concierge-deployment-repair@${incident.id}.service`,
    });
    store.markRepairRunLaunched(incident.id);
    expect(store.beginRepairProviderLaunch(incident.id).outcome).toBe("fresh");
    store.bindRepairSession(incident.id, "codex", "repair-session");
    store.completeRepairRun({
      incidentId: incident.id,
      providerSessionUuid: "repair-session",
      result: { head_commit: COMMIT_A, tree_digest: DIGEST_C },
    });
    const review = store.prepareReviewRun({
      reviewId: "123e4567-e89b-42d3-a456-426614174001",
      incidentId: incident.id,
      baseCommit: COMMIT_A,
      headCommit: COMMIT_B,
      treeDigest: DIGEST_C,
      policyDigest: DIGEST_A,
      enforcementDigest: DIGEST_B,
      evidenceDigest: DIGEST_C,
      repositoryPath: "/reviews/repository",
      controlPath: "/controls/review",
      providerCapabilityDigest: DIGEST_A,
      capabilityExpiresAtMs: 1_900_000_000_000,
      workerUnit: "concierge-deployment-review@123e4567-e89b-42d3-a456-426614174001.service",
    });
    store.markReviewRunLaunched(review.id);
    expect(store.beginReviewProviderLaunch(incident.id, review.id).outcome).toBe("fresh");
    store.bindReviewSession(incident.id, review.id, "review-session");
    expect(() => store.completeReviewRun({
      incidentId: incident.id,
      reviewId: review.id,
      providerSessionUuid: "wrong-session",
      verdict: "ship",
      result: { verdict: "SHIP" },
    })).toThrow("bound running provider session");
    expect(store.completeReviewRun({
      incidentId: incident.id,
      reviewId: review.id,
      providerSessionUuid: "review-session",
      verdict: "ship",
      result: { verdict: "SHIP" },
    }).status).toBe("ship");
    expect(store.markRepairIntegrated(incident.id, COMMIT_B)).toMatchObject({ integrated_commit: COMMIT_B });
    expect(store.getIncident(incident.id)?.status).toBe("deploying");
    expect(store.getActiveGeneration(incident.target)).toMatchObject({
      desired_commit: COMMIT_B,
      status: "prepared",
    });
  });

  test("review rejection explicitly authorizes one new turn in the exact repair session", () => {
    const intent = store.requestIntent({ expectedCommit: COMMIT_A, continuation: continuation(1) });
    const generation = store.prepareGeneration({
      desiredCommit: COMMIT_A,
      originUrl: "origin",
      originObservedAt: new Date().toISOString(),
      includedIntentIds: [intent.id],
    });
    const attempt = store.createAttempt(generation.id);
    const failed = store.failAttempt({
      attemptId: attempt.id,
      outcome: "failed",
      error: "deployment control failed",
      failureFingerprint: "control:review-rejected",
    });
    const incident = store.transitionIncident(failed.incident!.id, "diagnosing");
    store.prepareRepairRun({
      incidentId: incident.id,
      baseCommit: COMMIT_A,
      baselineLocalCommit: COMMIT_B,
      repositoryPath: "/repairs/rejected-incident",
      evidenceDigest: DIGEST_A,
      providerCapabilityDigest: DIGEST_B,
      capabilityExpiresAtMs: 1_900_000_000_000,
      workerUnit: `concierge-deployment-repair@${incident.id}.service`,
    });
    store.markRepairRunLaunched(incident.id);
    expect(store.beginRepairProviderLaunch(incident.id).outcome).toBe("fresh");
    store.bindRepairSession(incident.id, "codex", "repair-session");
    store.completeRepairRun({
      incidentId: incident.id,
      providerSessionUuid: "repair-session",
      result: { head_commit: COMMIT_A, tree_digest: DIGEST_C },
    });
    const review = store.prepareReviewRun({
      reviewId: "123e4567-e89b-42d3-a456-426614174088",
      incidentId: incident.id,
      baseCommit: COMMIT_A,
      headCommit: COMMIT_B,
      treeDigest: DIGEST_C,
      policyDigest: DIGEST_A,
      enforcementDigest: DIGEST_B,
      evidenceDigest: DIGEST_C,
      repositoryPath: "/reviews/rejected",
      controlPath: "/controls/rejected",
      providerCapabilityDigest: DIGEST_A,
      capabilityExpiresAtMs: 1_900_000_000_000,
      workerUnit: "concierge-deployment-review@123e4567-e89b-42d3-a456-426614174088.service",
    });
    store.markReviewRunLaunched(review.id);
    expect(store.beginReviewProviderLaunch(incident.id, review.id).outcome).toBe("fresh");
    store.bindReviewSession(incident.id, review.id, "review-session");
    store.completeReviewRun({
      incidentId: incident.id,
      reviewId: review.id,
      providerSessionUuid: "review-session",
      verdict: "no_ship",
      result: { verdict: "NO_SHIP", blockers: ["focused correction required"] },
    });
    expect(store.getRepairRun(incident.id)).toMatchObject({
      status: "prepared",
      provider_session_uuid: "repair-session",
      provider_launch_attempted: 0,
    });
    store.markRepairRunLaunched(incident.id);
    expect(store.beginRepairProviderLaunch(incident.id)).toMatchObject({
      outcome: "resume",
      providerSessionUuid: "repair-session",
    });
  });

  test("a provider crash before session binding parks instead of creating a second session", () => {
    const intent = store.requestIntent({ expectedCommit: COMMIT_A, continuation: continuation(1) });
    const generation = store.prepareGeneration({
      desiredCommit: COMMIT_A,
      originUrl: "origin",
      originObservedAt: new Date().toISOString(),
      includedIntentIds: [intent.id],
    });
    const attempt = store.createAttempt(generation.id);
    const failed = store.failAttempt({
      attemptId: attempt.id,
      outcome: "failed",
      error: "deployment failed",
      failureFingerprint: "provider:crash-window",
    });
    const incidentId = store.transitionIncident(failed.incident!.id, "diagnosing").id;
    store.prepareRepairRun({
      incidentId,
      baseCommit: COMMIT_A,
      baselineLocalCommit: COMMIT_B,
      repositoryPath: "/repairs/incident",
      evidenceDigest: DIGEST_A,
      providerCapabilityDigest: DIGEST_B,
      capabilityExpiresAtMs: 1_900_000_000_000,
      workerUnit: `concierge-deployment-repair@${incidentId}.service`,
    });
    store.markRepairRunLaunched(incidentId);
    expect(store.beginRepairProviderLaunch(incidentId).outcome).toBe("fresh");
    expect(store.beginRepairProviderLaunch(incidentId).outcome).toBe("parked");
    expect(store.getRepairRun(incidentId)?.status).toBe("ambiguous");
    expect(store.getIncident(incidentId)?.status).toBe("awaiting_owner_fix");

    const boundStore = new DeploymentControlStore(":memory:");
    try {
      const boundIntent = boundStore.requestIntent({ expectedCommit: COMMIT_A, continuation: continuation(3) });
      const boundGeneration = boundStore.prepareGeneration({
        desiredCommit: COMMIT_A,
        originUrl: "origin",
        originObservedAt: new Date().toISOString(),
        includedIntentIds: [boundIntent.id],
      });
      const boundAttempt = boundStore.createAttempt(boundGeneration.id);
      const boundFailure = boundStore.failAttempt({
        attemptId: boundAttempt.id,
        outcome: "failed",
        error: "deployment failed",
        failureFingerprint: "provider:bound-crash-window",
      });
      const boundIncidentId = boundStore.transitionIncident(boundFailure.incident!.id, "diagnosing").id;
      boundStore.prepareRepairRun({
        incidentId: boundIncidentId,
        baseCommit: COMMIT_A,
        baselineLocalCommit: COMMIT_B,
        repositoryPath: "/repairs/bound-incident",
        evidenceDigest: DIGEST_A,
        providerCapabilityDigest: DIGEST_B,
        capabilityExpiresAtMs: 1_900_000_000_000,
        workerUnit: `concierge-deployment-repair@${boundIncidentId}.service`,
      });
      boundStore.markRepairRunLaunched(boundIncidentId);
      expect(boundStore.beginRepairProviderLaunch(boundIncidentId).outcome).toBe("fresh");
      boundStore.bindRepairSession(boundIncidentId, "codex", "repair-session");
      expect(boundStore.beginRepairProviderLaunch(boundIncidentId).outcome).toBe("parked");
      expect(boundStore.getRepairRun(boundIncidentId)?.status).toBe("ambiguous");
      expect(boundStore.getIncident(boundIncidentId)?.status).toBe("awaiting_owner_fix");
    } finally {
      boundStore.close();
    }

    const reviewStore = new DeploymentControlStore(":memory:");
    try {
      const reviewIntent = reviewStore.requestIntent({ expectedCommit: COMMIT_A, continuation: continuation(2) });
      const reviewGeneration = reviewStore.prepareGeneration({
        desiredCommit: COMMIT_A,
        originUrl: "origin",
        originObservedAt: new Date().toISOString(),
        includedIntentIds: [reviewIntent.id],
      });
      const reviewAttempt = reviewStore.createAttempt(reviewGeneration.id);
      const reviewFailure = reviewStore.failAttempt({
        attemptId: reviewAttempt.id,
        outcome: "failed",
        error: "deployment failed",
        failureFingerprint: "review:crash-window",
      });
      const reviewIncidentId = reviewStore.transitionIncident(reviewFailure.incident!.id, "diagnosing").id;
      reviewStore.prepareRepairRun({
        incidentId: reviewIncidentId,
        baseCommit: COMMIT_A,
        baselineLocalCommit: COMMIT_B,
        repositoryPath: "/repairs/review-incident",
        evidenceDigest: DIGEST_A,
        providerCapabilityDigest: DIGEST_B,
        capabilityExpiresAtMs: 1_900_000_000_000,
        workerUnit: `concierge-deployment-repair@${reviewIncidentId}.service`,
      });
      reviewStore.markRepairRunLaunched(reviewIncidentId);
      reviewStore.beginRepairProviderLaunch(reviewIncidentId);
      reviewStore.bindRepairSession(reviewIncidentId, "codex", "repair-session");
      reviewStore.completeRepairRun({
        incidentId: reviewIncidentId,
        providerSessionUuid: "repair-session",
        result: { head_commit: COMMIT_B, tree_digest: DIGEST_C },
      });
      const review = reviewStore.prepareReviewRun({
        reviewId: "123e4567-e89b-42d3-a456-426614174099",
        incidentId: reviewIncidentId,
        baseCommit: COMMIT_A,
        headCommit: COMMIT_B,
        treeDigest: DIGEST_C,
        policyDigest: DIGEST_A,
        enforcementDigest: DIGEST_B,
        evidenceDigest: DIGEST_C,
        repositoryPath: "/reviews/repository",
        controlPath: "/controls/review",
        providerCapabilityDigest: DIGEST_A,
        capabilityExpiresAtMs: 1_900_000_000_000,
        workerUnit: "concierge-deployment-review@123e4567-e89b-42d3-a456-426614174099.service",
      });
      reviewStore.markReviewRunLaunched(review.id);
      expect(reviewStore.beginReviewProviderLaunch(reviewIncidentId, review.id).outcome).toBe("fresh");
      reviewStore.bindReviewSession(reviewIncidentId, review.id, "review-session");
      expect(reviewStore.beginReviewProviderLaunch(reviewIncidentId, review.id).outcome).toBe("parked");
      expect(reviewStore.getReviewRun(review.id)?.status).toBe("ambiguous");
      expect(reviewStore.getIncident(reviewIncidentId)?.status).toBe("awaiting_owner_fix");
    } finally {
      reviewStore.close();
    }
  });

  test("origin movement refreshes the same repair session before another review", () => {
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
      error: "deployment control failed",
      failureFingerprint: "control:failed",
    });
    const incidentId = failure.incident!.id;
    store.transitionIncident(incidentId, "diagnosing");
    store.prepareRepairRun({
      incidentId,
      baseCommit: COMMIT_A,
      baselineLocalCommit: COMMIT_B,
      repositoryPath: "/repairs/incident",
      evidenceDigest: DIGEST_A,
      providerCapabilityDigest: DIGEST_B,
      capabilityExpiresAtMs: 1_900_000_000_000,
      workerUnit: `concierge-deployment-repair@${incidentId}.service`,
    });
    store.markRepairRunLaunched(incidentId);
    expect(store.beginRepairProviderLaunch(incidentId).outcome).toBe("fresh");
    store.bindRepairSession(incidentId, "codex", "repair-session");
    store.completeRepairRun({
      incidentId,
      providerSessionUuid: "repair-session",
      result: { head_commit: COMMIT_B, tree_digest: DIGEST_C },
    });

    store.requireRepairRefresh(incidentId, "origin/main moved after review");
    expect(store.getIncident(incidentId)?.status).toBe("diagnosing");
    const refreshed = store.prepareRepairRun({
      incidentId,
      baseCommit: COMMIT_B,
      baselineLocalCommit: COMMIT_A,
      repositoryPath: "/repairs/incident",
      evidenceDigest: DIGEST_C,
      providerCapabilityDigest: DIGEST_A,
      capabilityExpiresAtMs: 1_900_086_400_000,
      workerUnit: `concierge-deployment-repair@${incidentId}.service`,
    });
    expect(refreshed).toMatchObject({
      status: "prepared",
      base_commit: COMMIT_B,
      baseline_local_commit: COMMIT_A,
      provider_session_uuid: "repair-session",
      result_json: null,
      integrated_commit: null,
      provider_launch_attempted: 0,
    });
    const pending = store.beginRepairCapabilityRotation(incidentId, DIGEST_B, 1_900_172_800_000);
    expect(pending).toMatchObject({
      provider_capability_digest: DIGEST_A,
      pending_provider_capability_digest: DIGEST_B,
      pending_capability_expires_at_ms: 1_900_172_800_000,
    });
    const rotated = store.completeRepairCapabilityRotation(incidentId, DIGEST_B, 1_900_172_800_000);
    expect(rotated).toMatchObject({
      provider_capability_digest: DIGEST_B,
      pending_provider_capability_digest: null,
      pending_capability_expires_at_ms: null,
      provider_launch_attempted: 0,
    });
    store.markRepairRunLaunched(incidentId);
    expect(store.beginRepairProviderLaunch(incidentId)).toMatchObject({
      outcome: "resume",
      providerSessionUuid: "repair-session",
    });
    expect(store.getIncident(incidentId)?.status).toBe("repairing");
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
