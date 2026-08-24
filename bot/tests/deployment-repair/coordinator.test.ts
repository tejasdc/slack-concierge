import { describe, expect, test } from "bun:test";
import {
  reconcileDeploymentTarget,
  type CoordinatorServices,
} from "../../../deployment-control/coordinator";

function services(sequence: any[]): { services: CoordinatorServices; calls: string[] } {
  const calls: string[] = [];
  let snapshotIndex = 0;
  return {
    calls,
    services: {
      snapshot: async () => {
        calls.push("snapshot");
        return sequence[Math.min(snapshotIndex++, sequence.length - 1)];
      },
      prepareGeneration: async () => {
        calls.push("prepare");
        return { generation: { id: "generation-1" } };
      },
      createAttempt: async (generationId, status) => {
        calls.push(`create:${generationId}:${status}`);
        return { attempt: { id: "attempt-1", status: "prepared" } };
      },
      launchAttempt: async (attemptId) => {
        calls.push(`launch:${attemptId}`);
        return { unit_name: "concierge-deploy-attempt-1" };
      },
    },
  };
}

describe("deployment supervisor coordinator", () => {
  test("serializes pending intent into one generation, attempt, and launch", async () => {
    const fixture = services([
      { pending_intents: [{ id: "intent-1" }], active_generation: null, active_attempt: null, active_incident: null },
      {
        pending_intents: [{ id: "intent-1" }],
        active_generation: { id: "generation-1", status: "prepared" },
        active_attempt: null,
        active_incident: null,
      },
    ]);
    expect(await reconcileDeploymentTarget(fixture.services, { enabled: true })).toEqual({
      action: "attempt_launched",
      attempt_id: "attempt-1",
      unit_name: "concierge-deploy-attempt-1",
    });
    expect(fixture.calls).toEqual([
      "snapshot",
      "prepare",
      "snapshot",
      "create:generation-1:prepared",
      "launch:attempt-1",
    ]);
  });

  test("does not recursively launch attempts while one is active", async () => {
    const fixture = services([{
      pending_intents: [{ id: "intent-1" }],
      active_generation: { id: "generation-1", status: "active" },
      active_attempt: { id: "attempt-1", status: "verifying" },
      active_incident: null,
    }]);
    expect(await reconcileDeploymentTarget(fixture.services, { enabled: true })).toEqual({
      action: "attempt_active",
      attempt_id: "attempt-1",
      status: "verifying",
    });
    expect(fixture.calls).toEqual(["snapshot"]);
  });

  test("one active incident blocks recursive repair deployment", async () => {
    const previous = process.env.CONCIERGE_AUTONOMOUS_REPAIR_ENABLED;
    process.env.CONCIERGE_AUTONOMOUS_REPAIR_ENABLED = "0";
    try {
      const fixture = services([{
        pending_intents: [{ id: "intent-1" }],
        active_generation: null,
        active_attempt: null,
        active_incident: { id: "incident-1", status: "diagnosing" },
      }]);
      expect(await reconcileDeploymentTarget(fixture.services, { enabled: true })).toEqual({
        action: "waiting_for_repair_prerequisites",
        incident_id: "incident-1",
      });
      expect(fixture.calls).toEqual(["snapshot"]);
    } finally {
      if (previous == null) delete process.env.CONCIERGE_AUTONOMOUS_REPAIR_ENABLED;
      else process.env.CONCIERGE_AUTONOMOUS_REPAIR_ENABLED = previous;
    }
  });

  test("bootstrap mode cannot read or mutate deployment state", async () => {
    const fixture = services([{ pending_intents: [{ id: "intent-1" }] }]);
    expect(await reconcileDeploymentTarget(fixture.services, { enabled: false })).toEqual({ action: "disabled" });
    expect(fixture.calls).toEqual([]);
  });
});
