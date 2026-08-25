import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DeploymentControlStore } from "../../../deployment-control/kernel/state";

const ROLLOUT_ID = "11111111-1111-4111-8111-111111111111";
const IDENTITY = "a".repeat(64);
const owner = {
  invocationId: "22222222222222222222222222222222",
  pid: 4242,
  bootId: "33333333-3333-4333-8333-333333333333",
  startTicks: "123456",
  identityDigest: IDENTITY,
};
const coordinatorPlan = {
  candidateSlot: "a" as const,
  candidateVersion: "b".repeat(64),
  candidateUnit: "concierge-deployment-coordinator@a.service",
  incumbentSlot: "legacy" as const,
  incumbentVersion: "c".repeat(64),
  incumbentUnit: "concierge-deployment-coordinator.service",
  incumbentWasActive: true,
};
const coordinatorOwner = {
  invocationId: "44444444444444444444444444444444",
  pid: 4343,
  bootId: "55555555-5555-4555-8555-555555555555",
  startTicks: "987654",
  slot: "a" as const,
  version: coordinatorPlan.candidateVersion,
};

describe("deployment activation rollout state", () => {
  let store: DeploymentControlStore;

  beforeEach(() => {
    store = new DeploymentControlStore(":memory:");
    store.createRollout({
      id: ROLLOUT_ID,
      ownerUnit: `concierge-deployment-rollout@${ROLLOUT_ID}.service`,
      identityDigest: IDENTITY,
      nextStep: "claim_rollout_lease",
    });
    store.claimRolloutLease({
      rolloutId: ROLLOUT_ID,
      ownerUnit: `concierge-deployment-rollout@${ROLLOUT_ID}.service`,
      ...owner,
    });
  });

  afterEach(() => store.close());

  function transition(expectedStatus: any, status: any, nextStep = `run_${status}`) {
    return store.transitionRollout({
      rolloutId: ROLLOUT_ID,
      expectedStatus,
      status,
      nextStep,
      ...owner,
    });
  }

  function reachImplementationReview() {
    transition("staged", "containing_application");
    transition("containing_application", "staging_coordinator");
    transition("staging_coordinator", "proving");
    transition("proving", "review_pending", "launch_implementation_review");
  }

  function completeReview(reviewKind: "implementation" | "live_evidence", verdict: "ship" | "no_ship", verdictPayload: Record<string, unknown>) {
    const request = store.prepareRolloutReviewRequest({
      rolloutId: ROLLOUT_ID,
      reviewKind,
      ...owner,
    });
    store.claimRolloutReviewRequest({ requestId: request.id, ...owner });
    store.admitRolloutReviewProvider({ requestId: request.id, ...owner });
    const reviewerSessionUuid = `${reviewKind}-review-session`;
    store.bindRolloutReviewSession({ requestId: request.id, providerSessionUuid: reviewerSessionUuid, ...owner });
    return store.recordRolloutReview({
      requestId: request.id,
      verdict,
      reviewerSessionUuid,
      verdictPayload,
      ...owner,
    });
  }

  function prepareActivation(kind: "canary" | "production") {
    const activation = store.prepareActivationGeneration({
      rolloutId: ROLLOUT_ID,
      kind,
      coordinator: coordinatorPlan,
      ...owner,
    });
    store.requestCoordinatorCandidateStart({
      generationId: activation.id,
      rolloutId: ROLLOUT_ID,
      ...owner,
    });
    store.recordCoordinatorCandidateStarted({
      generationId: activation.id,
      invocationId: coordinatorOwner.invocationId,
    });
    return activation;
  }

  function acknowledgeCoordinator(generationId: string) {
    return store.acknowledgeActivation({
      generationId,
      role: "coordinator",
      identityDigest: IDENTITY,
      coordinatorOwner,
    });
  }

  test("one fenced owner resumes only after the prior process is proven dead", () => {
    expect(() => store.claimRolloutLease({
      rolloutId: ROLLOUT_ID,
      ownerUnit: `concierge-deployment-rollout@${ROLLOUT_ID}.service`,
      invocationId: "44444444444444444444444444444444",
      pid: 5252,
      bootId: owner.bootId,
      startTicks: "654321",
    })).toThrow("live or unproven owner");

    const recovered = store.claimRolloutLease({
      rolloutId: ROLLOUT_ID,
      ownerUnit: `concierge-deployment-rollout@${ROLLOUT_ID}.service`,
      invocationId: "44444444444444444444444444444444",
      pid: 5252,
      bootId: owner.bootId,
      startTicks: "654321",
      priorOwnerProvenDead: true,
    });
    expect(recovered).toMatchObject({ owner_pid: 5252, owner_start_ticks: "654321" });
    expect(() => transition("staged", "containing_application")).toThrow("owner lease does not match");
  });

  test("review receipts authorize distinct canary and production generations", () => {
    reachImplementationReview();
    completeReview("implementation", "ship", { verdict: "ship" });

    const canary = prepareActivation("canary");
    expect(JSON.parse(canary.capabilities_json)).toEqual(["rollout_canary"]);
    store.acknowledgeActivation({ generationId: canary.id, role: "bot", identityDigest: IDENTITY });
    expect(() => store.exposeActivationGeneration({
      rolloutId: ROLLOUT_ID,
      generationId: canary.id,
      ...owner,
    })).toThrow("requires bot and coordinator acknowledgments");
    acknowledgeCoordinator(canary.id);
    store.exposeActivationGeneration({ rolloutId: ROLLOUT_ID, generationId: canary.id, probationSeconds: 5, ...owner });
    store.revokeActivationGeneration({
      rolloutId: ROLLOUT_ID,
      generationId: canary.id,
      reason: "expected probation recovery drill",
      ...owner,
    });
    store.recordCoordinatorRecovery({ generationId: canary.id, recoveryInvocationId: "incumbent-recovered" });
    expect(store.getActivationGeneration(canary.id)).toMatchObject({ status: "revoked" });
    expect(store.getRollout(ROLLOUT_ID)).toMatchObject({ status: "recovery_proving" });

    store.recordRolloutCheck({
      rolloutId: ROLLOUT_ID,
      name: "last_known_good_health",
      phase: "recovery",
      status: "passed",
      evidence: { runtime_sha: "c".repeat(40), service_probe: "passed" },
      ...owner,
    });
    const frozen = store.freezeRolloutEvidence({ rolloutId: ROLLOUT_ID, ...owner });
    expect(frozen.evidence_digest).toMatch(/^[0-9a-f]{64}$/);
    completeReview("live_evidence", "ship", { verdict: "ship" });

    const production = prepareActivation("production");
    expect(production.id).not.toBe(canary.id);
    expect(JSON.parse(production.capabilities_json)).toEqual([
      "intent_routing",
      "attempt_reconciliation",
      "autonomous_repair",
    ]);
    store.acknowledgeActivation({ generationId: production.id, role: "bot", identityDigest: IDENTITY });
    acknowledgeCoordinator(production.id);
    store.exposeActivationGeneration({ rolloutId: ROLLOUT_ID, generationId: production.id, probationSeconds: 5, ...owner });
    store.heartbeatCoordinator({
      generationId: production.id,
      ...coordinatorOwner,
      reconciliationDigest: "d".repeat(64),
      handshake: true,
    });
    store.requestCoordinatorPromotion({
      rolloutId: ROLLOUT_ID,
      generationId: production.id,
      now: new Date(Date.now() + 6_000),
      maximumHeartbeatAgeSeconds: 120,
      ...owner,
    });
    store.completeCoordinatorPromotion({ generationId: production.id });
    const verified = store.verifyProductionRollout({
      rolloutId: ROLLOUT_ID,
      generationId: production.id,
      ...owner,
    });
    expect(verified).toMatchObject({ status: "verified", next_step: "monitor" });
    expect(store.getExposedActivation("concierge", "production")?.id).toBe(production.id);
  });

  test("review digest drift and skipped lifecycle states fail closed", () => {
    expect(() => transition("staged", "proving")).toThrow("cannot transition");
    reachImplementationReview();
    const request = store.prepareRolloutReviewRequest({ rolloutId: ROLLOUT_ID, reviewKind: "implementation", ...owner });
    store.claimRolloutReviewRequest({ requestId: request.id, ...owner });
    store.admitRolloutReviewProvider({ requestId: request.id, ...owner });
    store.bindRolloutReviewSession({ requestId: request.id, providerSessionUuid: "review-session", ...owner });
    expect(() => store.recordRolloutReview({
      requestId: request.id,
      verdict: "ship",
      reviewerSessionUuid: "wrong-review",
      verdictPayload: { verdict: "ship" },
      ...owner,
    })).toThrow("not bound to reviewer session");
    store.recordRolloutReview({
      requestId: request.id,
      verdict: "no_ship",
      reviewerSessionUuid: "review-session",
      verdictPayload: { verdict: "no_ship", blockers: ["fixture"] },
      ...owner,
    });
    expect(store.getRollout(ROLLOUT_ID)).toMatchObject({
      status: "proving",
      next_step: "correct_implementation_evidence",
    });
  });

  test("terminal proof records cannot be rewritten or frozen when any proof failed", () => {
    reachImplementationReview();
    completeReview("implementation", "ship", { verdict: "ship" });
    const canary = prepareActivation("canary");
    store.acknowledgeActivation({ generationId: canary.id, role: "bot", identityDigest: IDENTITY });
    acknowledgeCoordinator(canary.id);
    store.exposeActivationGeneration({ rolloutId: ROLLOUT_ID, generationId: canary.id, probationSeconds: 5, ...owner });
    store.revokeActivationGeneration({ rolloutId: ROLLOUT_ID, generationId: canary.id, reason: "drill", ...owner });
    store.recordCoordinatorRecovery({ generationId: canary.id, recoveryInvocationId: "incumbent-recovered" });
    store.recordRolloutCheck({
      rolloutId: ROLLOUT_ID,
      name: "service_health",
      phase: "recovery",
      status: "failed",
      error: "fixture failure",
      ...owner,
    });
    expect(() => store.recordRolloutCheck({
      rolloutId: ROLLOUT_ID,
      name: "service_health",
      phase: "recovery",
      status: "passed",
      evidence: { passed: true },
      ...owner,
    })).toThrow("already terminal");
    expect(() => store.freezeRolloutEvidence({ rolloutId: ROLLOUT_ID, ...owner }))
      .toThrow("required check is not passed");
  });

  test("checks are phase-bound, monotonic, and kernel-digested", () => {
    expect(() => store.recordRolloutCheck({
      rolloutId: ROLLOUT_ID,
      name: "too_early",
      phase: "recovery",
      status: "passed",
      evidence: { passed: true },
      ...owner,
    })).toThrow("is not valid");
    reachImplementationReview();
    completeReview("implementation", "ship", { verdict: "ship" });
    const canary = prepareActivation("canary");
    store.acknowledgeActivation({ generationId: canary.id, role: "bot", identityDigest: IDENTITY });
    acknowledgeCoordinator(canary.id);
    store.exposeActivationGeneration({ rolloutId: ROLLOUT_ID, generationId: canary.id, probationSeconds: 5, ...owner });
    store.revokeActivationGeneration({ rolloutId: ROLLOUT_ID, generationId: canary.id, reason: "drill", ...owner });
    store.recordCoordinatorRecovery({ generationId: canary.id, recoveryInvocationId: "incumbent-recovered" });
    store.recordRolloutCheck({
      rolloutId: ROLLOUT_ID,
      name: "monotonic",
      phase: "recovery",
      status: "running",
      ...owner,
    });
    expect(() => store.recordRolloutCheck({
      rolloutId: ROLLOUT_ID,
      name: "monotonic",
      phase: "recovery",
      status: "prepared",
      ...owner,
    })).toThrow("cannot transition running -> prepared");
    const passed = store.recordRolloutCheck({
      rolloutId: ROLLOUT_ID,
      name: "monotonic",
      phase: "recovery",
      status: "passed",
      evidence: { passed: true },
      ...owner,
    });
    expect(passed.evidence_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(passed.evidence_digest).not.toBe("b".repeat(64));
  });
});
