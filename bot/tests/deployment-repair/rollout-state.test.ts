import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DeploymentControlStore } from "../../../deployment-control/kernel/state";

const ROLLOUT_ID = "11111111-1111-4111-8111-111111111111";
const IDENTITY = "a".repeat(64);
const EVIDENCE = "b".repeat(64);
const owner = {
  invocationId: "22222222222222222222222222222222",
  pid: 4242,
  bootId: "33333333-3333-4333-8333-333333333333",
  startTicks: "123456",
  identityDigest: IDENTITY,
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
    store.recordRolloutReview({
      rolloutId: ROLLOUT_ID,
      reviewKind: "implementation",
      verdict: "ship",
      reviewedDigest: IDENTITY,
      identityDigest: IDENTITY,
      reviewerSessionUuid: "implementation-review-session",
      verdictPayload: { verdict: "ship" },
    });

    const canary = store.prepareActivationGeneration({ rolloutId: ROLLOUT_ID, kind: "canary", ...owner });
    expect(JSON.parse(canary.capabilities_json)).toEqual(["rollout_canary"]);
    store.acknowledgeActivation({ generationId: canary.id, role: "bot", identityDigest: IDENTITY });
    expect(() => store.exposeActivationGeneration({
      rolloutId: ROLLOUT_ID,
      generationId: canary.id,
      ...owner,
    })).toThrow("requires bot and coordinator acknowledgments");
    store.acknowledgeActivation({ generationId: canary.id, role: "coordinator", identityDigest: IDENTITY });
    store.exposeActivationGeneration({ rolloutId: ROLLOUT_ID, generationId: canary.id, ...owner });
    store.revokeActivationGeneration({
      rolloutId: ROLLOUT_ID,
      generationId: canary.id,
      reason: "expected probation recovery drill",
      ...owner,
    });
    expect(store.getActivationGeneration(canary.id)).toMatchObject({ status: "revoked" });
    expect(store.getRollout(ROLLOUT_ID)).toMatchObject({ status: "recovery_proving" });

    store.recordRolloutCheck({
      rolloutId: ROLLOUT_ID,
      name: "last_known_good_health",
      phase: "recovery",
      status: "passed",
      evidenceDigest: EVIDENCE,
      evidence: { runtime_sha: "c".repeat(40), service_probe: "passed" },
      ...owner,
    });
    const frozen = store.freezeRolloutEvidence({ rolloutId: ROLLOUT_ID, ...owner });
    expect(frozen.evidence_digest).toMatch(/^[0-9a-f]{64}$/);
    store.recordRolloutReview({
      rolloutId: ROLLOUT_ID,
      reviewKind: "live_evidence",
      verdict: "ship",
      reviewedDigest: frozen.evidence_digest!,
      identityDigest: IDENTITY,
      reviewerSessionUuid: "live-evidence-review-session",
      verdictPayload: { verdict: "ship" },
    });

    const production = store.prepareActivationGeneration({ rolloutId: ROLLOUT_ID, kind: "production", ...owner });
    expect(production.id).not.toBe(canary.id);
    expect(JSON.parse(production.capabilities_json)).toEqual([
      "intent_routing",
      "attempt_reconciliation",
      "autonomous_repair",
    ]);
    store.acknowledgeActivation({ generationId: production.id, role: "bot", identityDigest: IDENTITY });
    store.acknowledgeActivation({ generationId: production.id, role: "coordinator", identityDigest: IDENTITY });
    store.exposeActivationGeneration({ rolloutId: ROLLOUT_ID, generationId: production.id, ...owner });
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
    expect(() => store.recordRolloutReview({
      rolloutId: ROLLOUT_ID,
      reviewKind: "implementation",
      verdict: "ship",
      reviewedDigest: "c".repeat(64),
      identityDigest: IDENTITY,
      reviewerSessionUuid: "wrong-review",
      verdictPayload: { verdict: "ship" },
    })).toThrow("does not match the frozen rollout authority");
    store.recordRolloutReview({
      rolloutId: ROLLOUT_ID,
      reviewKind: "implementation",
      verdict: "no_ship",
      reviewedDigest: IDENTITY,
      identityDigest: IDENTITY,
      reviewerSessionUuid: "review-session",
      verdictPayload: { verdict: "no_ship", blockers: ["fixture"] },
    });
    expect(store.getRollout(ROLLOUT_ID)).toMatchObject({
      status: "proving",
      next_step: "correct_implementation_evidence",
    });
  });

  test("terminal proof records cannot be rewritten or frozen when any proof failed", () => {
    reachImplementationReview();
    store.recordRolloutReview({
      rolloutId: ROLLOUT_ID,
      reviewKind: "implementation",
      verdict: "ship",
      reviewedDigest: IDENTITY,
      identityDigest: IDENTITY,
      reviewerSessionUuid: "review-session",
      verdictPayload: { verdict: "ship" },
    });
    const canary = store.prepareActivationGeneration({ rolloutId: ROLLOUT_ID, kind: "canary", ...owner });
    store.acknowledgeActivation({ generationId: canary.id, role: "bot", identityDigest: IDENTITY });
    store.acknowledgeActivation({ generationId: canary.id, role: "coordinator", identityDigest: IDENTITY });
    store.exposeActivationGeneration({ rolloutId: ROLLOUT_ID, generationId: canary.id, ...owner });
    store.revokeActivationGeneration({ rolloutId: ROLLOUT_ID, generationId: canary.id, reason: "drill", ...owner });
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
      evidenceDigest: EVIDENCE,
      evidence: { passed: true },
      ...owner,
    })).toThrow("already terminal");
    expect(() => store.freezeRolloutEvidence({ rolloutId: ROLLOUT_ID, ...owner }))
      .toThrow("required check is not passed");
  });
});
