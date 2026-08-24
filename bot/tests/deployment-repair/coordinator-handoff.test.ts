import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CoordinatorRuntimeManager } from "../../../deployment-control/kernel/coordinator-runtime";
import { runCoordinatorWatchdog } from "../../../deployment-control/kernel/coordinator-watchdog";
import { DeploymentControlStore } from "../../../deployment-control/kernel/state";

const rolloutId = "11111111-1111-4111-8111-111111111111";
const identityDigest = "a".repeat(64);
const rolloutOwner = {
  invocationId: "22222222222222222222222222222222",
  pid: 4242,
  bootId: "33333333-3333-4333-8333-333333333333",
  startTicks: "123456",
  identityDigest,
};
const candidateOwner = {
  invocationId: "44444444444444444444444444444444",
  pid: 4343,
  bootId: "55555555-5555-4555-8555-555555555555",
  startTicks: "987654",
  slot: "a" as const,
  version: "b".repeat(64),
};

describe("kernel-owned coordinator A/B handoff", () => {
  let store: DeploymentControlStore;
  let root: string;
  let generationId: string;
  let candidateActive: boolean;
  let incumbentActive: boolean;
  let runtime: CoordinatorRuntimeManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "concierge-coordinator-handoff-"));
    store = new DeploymentControlStore(":memory:");
    store.createRollout({
      id: rolloutId,
      ownerUnit: `concierge-deployment-rollout@${rolloutId}.service`,
      identityDigest,
      nextStep: "claim",
    });
    store.claimRolloutLease({
      rolloutId,
      ownerUnit: `concierge-deployment-rollout@${rolloutId}.service`,
      ...rolloutOwner,
    });
    for (const [expectedStatus, status] of [
      ["staged", "containing_application"],
      ["containing_application", "staging_coordinator"],
      ["staging_coordinator", "proving"],
      ["proving", "review_pending"],
    ] as const) {
      store.transitionRollout({ rolloutId, expectedStatus, status, nextStep: status, ...rolloutOwner });
    }
    const review = store.prepareRolloutReviewRequest({ rolloutId, reviewKind: "implementation", ...rolloutOwner });
    store.bindRolloutReviewWorkspace({
      requestId: review.id,
      repositoryPath: `/review/${review.id}/repository`,
      controlPath: `/control/${review.id}`,
      providerCapabilityDigest: "9".repeat(64),
      capabilityExpiresAtMs: Date.now() + 60_000,
    });
    store.requestRolloutReviewLaunch(review.id);
    store.markRolloutReviewSystemdAdmitted(review.id);
    store.claimRolloutReviewRequest({ requestId: review.id, ...rolloutOwner });
    store.admitRolloutReviewProvider({ requestId: review.id, ...rolloutOwner });
    store.bindRolloutReviewSession({ requestId: review.id, providerSessionUuid: "review-session", ...rolloutOwner });
    store.recordRolloutReview({
      requestId: review.id,
      verdict: "ship",
      reviewerSessionUuid: "review-session",
      verdictPayload: { verdict: "ship" },
      ...rolloutOwner,
    });
    const generation = store.prepareActivationGeneration({
      rolloutId,
      kind: "canary",
      coordinator: {
        candidateSlot: "a",
        candidateVersion: candidateOwner.version,
        candidateUnit: "concierge-deployment-coordinator@a.service",
        incumbentSlot: "legacy",
        incumbentVersion: "c".repeat(64),
        incumbentUnit: "concierge-deployment-coordinator.service",
        incumbentWasActive: true,
      },
      ...rolloutOwner,
    });
    generationId = generation.id;
    store.requestCoordinatorCandidateStart({ generationId, rolloutId, ...rolloutOwner });
    store.recordCoordinatorCandidateStarted({ generationId, invocationId: candidateOwner.invocationId });
    store.acknowledgeActivation({ generationId, role: "bot", identityDigest });
    store.acknowledgeActivation({
      generationId,
      role: "coordinator",
      identityDigest,
      coordinatorOwner: candidateOwner,
    });
    store.exposeActivationGeneration({ generationId, rolloutId, probationSeconds: 5, ...rolloutOwner });
    store.recordCoordinatorIncumbentStopped({ generationId });

    candidateActive = true;
    incumbentActive = false;
    runtime = new CoordinatorRuntimeManager({
      runtimeRoot: join(root, "runtime"),
      activeRecordPath: join(root, "coordinator-active.json"),
      systemctlBin: "/unused/systemctl",
      run: (args) => {
        const unit = args[1] || "";
        if (args[0] === "stop") {
          if (unit.includes("@a")) candidateActive = false;
          if (unit === "concierge-deployment-coordinator.service") incumbentActive = false;
        }
        if (args[0] === "start") {
          if (unit.includes("@a")) candidateActive = true;
          if (unit === "concierge-deployment-coordinator.service") incumbentActive = true;
        }
        if (args[0] === "show") {
          const candidate = unit.includes("@a");
          const active = candidate ? candidateActive : incumbentActive;
          return {
            exitCode: 0,
            stdout: `InvocationID=${active ? (candidate ? candidateOwner.invocationId : "incumbent-recovery") : ""}\nMainPID=${active ? (candidate ? candidateOwner.pid : 5353) : 0}\nActiveState=${active ? "active" : "inactive"}\n`,
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("healthy probation retains exactly the candidate generation", () => {
    store.heartbeatCoordinator({
      generationId,
      ...candidateOwner,
      reconciliationDigest: "d".repeat(64),
      handshake: true,
    });
    const outcomes = runCoordinatorWatchdog(store, runtime);
    expect(outcomes).toEqual([{ action: "healthy", generation_id: generationId }]);
    expect(store.getActivationGeneration(generationId)?.status).toBe("exposed");
    expect(store.getCoordinatorHandoff(generationId)?.status).toBe("probation");
  });

  test("real candidate death revokes first and restores the recorded incumbent", () => {
    candidateActive = false;
    const outcomes = runCoordinatorWatchdog(store, runtime);
    expect(outcomes[0]).toMatchObject({ action: "recovered", generation_id: generationId });
    expect(store.getActivationGeneration(generationId)).toMatchObject({
      status: "revoked",
      revocation_reason: expect.stringContaining("not active"),
    });
    expect(store.getCoordinatorHandoff(generationId)).toMatchObject({
      status: "recovered",
      recovery_invocation_id: "incumbent-recovery",
    });
    expect(candidateActive).toBeFalse();
    expect(incumbentActive).toBeTrue();
    expect(JSON.parse(readFileSync(join(root, "coordinator-active.json"), "utf8"))).toMatchObject({
      slot: "legacy",
      version: "c".repeat(64),
      unit: "concierge-deployment-coordinator.service",
    });
  });

  test("a missed handshake expires probation and cannot be re-exposed", () => {
    const handoff = store.getCoordinatorHandoff(generationId)!;
    const afterHandshakeDeadline = new Date(Date.parse(`${handoff.probation_started_at!.replace(" ", "T")}Z`) + 11_000);
    runCoordinatorWatchdog(store, runtime, {
      now: afterHandshakeDeadline,
      handshakeTimeoutSeconds: 10,
      heartbeatTimeoutSeconds: 30,
    });
    expect(store.getActivationGeneration(generationId)?.status).toBe("revoked");
    expect(() => store.exposeActivationGeneration({
      generationId,
      rolloutId,
      probationSeconds: 5,
      ...rolloutOwner,
    })).toThrow("cannot expose from revoked");
  });
});
