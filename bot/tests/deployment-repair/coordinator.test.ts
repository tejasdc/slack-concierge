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
      acknowledgeActivation: async (generationId, identityDigest) => {
        calls.push(`activation-ack:${generationId}:${identityDigest}`);
        return {};
      },
      heartbeatActivation: async (generationId, digest, handshake) => {
        calls.push(`activation-heartbeat:${generationId}:${digest}:${handshake}`);
        return {};
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
      transitionIncident: async (incidentId, from, to) => {
        calls.push(`incident:${incidentId}:${from}:${to}`);
        return { incident: { id: incidentId, status: to } };
      },
      prepareRepair: async (incidentId) => {
        calls.push(`repair-prepare:${incidentId}`);
        return {};
      },
      launchRepair: async (incidentId) => {
        calls.push(`repair-launch:${incidentId}`);
        return {};
      },
      prepareReview: async (incidentId) => {
        calls.push(`review-prepare:${incidentId}`);
        return {};
      },
      launchReview: async (incidentId, reviewId) => {
        calls.push(`review-launch:${incidentId}:${reviewId}`);
        return {};
      },
      integrateRepair: async (incidentId, reviewId) => {
        calls.push(`integrate:${incidentId}:${reviewId}`);
        return { integration: { integrated_commit: "f".repeat(40) } };
      },
      recordLearning: async (incidentId) => {
        calls.push(`learn:${incidentId}`);
        return {};
      },
      notifyParked: async (incidentId) => {
        calls.push(`notify-parked:${incidentId}`);
        return {};
      },
      notifyForward: async (incidentId) => {
        calls.push(`notify:${incidentId}`);
        return {};
      },
      reconcileNotification: async (notificationId, status) => {
        calls.push(`notification-reconcile:${notificationId}:${status}`);
        return {};
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

  test("the installed coordinator acknowledges pending authority without an environment enable", async () => {
    const fixture = services([{
      activation_generation: {
        id: "activation-1",
        status: "pending",
        identity_digest: "a".repeat(64),
        coordinator_acknowledged_at: null,
      },
    }]);
    expect(await reconcileDeploymentTarget(fixture.services)).toEqual({
      action: "activation_acknowledged",
      generation_id: "activation-1",
    });
    expect(fixture.calls).toEqual([
      "snapshot",
      `activation-ack:activation-1:${"a".repeat(64)}`,
    ]);
  });

  test("the kernel generation, not environment flags, decides whether reconciliation runs", async () => {
    const disabled = services([{ activation_generation: null, active_activation: null }]);
    expect(await reconcileDeploymentTarget(disabled.services)).toEqual({ action: "disabled" });
    expect(disabled.calls).toEqual(["snapshot"]);

    const canary = services([{
      activation_generation: { id: "canary-1", status: "exposed", kind: "canary" },
      active_activation: { id: "canary-1", status: "exposed", kind: "canary", identity_digest: "a".repeat(64) },
      coordinator_handoff: { status: "probation" },
    }]);
    expect(await reconcileDeploymentTarget(canary.services)).toEqual({
      action: "canary_probation_waiting",
      generation_id: "canary-1",
    });
    expect(canary.calls[0]).toBe("snapshot");
    expect(canary.calls[1]).toMatch(/^activation-heartbeat:canary-1:[0-9a-f]{64}:true$/);
  });

  test("autonomous incident reconciliation prepares, launches, reviews, and integrates one repair", async () => {
    const previous = process.env.CONCIERGE_AUTONOMOUS_REPAIR_ENABLED;
    process.env.CONCIERGE_AUTONOMOUS_REPAIR_ENABLED = "1";
    try {
      const diagnosing = services([{
        active_incident: { id: "incident-1", status: "diagnosing" },
        active_repair_run: null,
      }]);
      expect(await reconcileDeploymentTarget(diagnosing.services, { enabled: true })).toEqual({
        action: "repair_prepared",
        incident_id: "incident-1",
      });
      expect(diagnosing.calls).toEqual(["snapshot", "repair-prepare:incident-1"]);

      const repairing = services([{
        active_incident: { id: "incident-1", status: "repairing" },
        active_repair_run: { status: "prepared" },
      }]);
      expect(await reconcileDeploymentTarget(repairing.services, { enabled: true })).toMatchObject({
        action: "repair_launched",
      });
      expect(repairing.calls).toEqual(["snapshot", "repair-launch:incident-1"]);

      const persistedLaunch = services([{
        active_incident: { id: "incident-1", status: "repairing" },
        active_repair_run: { status: "launched" },
      }]);
      expect(await reconcileDeploymentTarget(persistedLaunch.services, { enabled: true })).toMatchObject({
        action: "repair_launched",
      });
      expect(persistedLaunch.calls).toEqual(["snapshot", "repair-launch:incident-1"]);

      const reviewing = services([{
        active_incident: { id: "incident-1", status: "reviewing" },
        active_repair_run: { result_json: JSON.stringify({ head_commit: "b".repeat(40), tree_digest: "1".repeat(64) }) },
        latest_review_run: {
          id: "review-1",
          status: "ship",
          head_commit: "b".repeat(40),
          tree_digest: "1".repeat(64),
        },
      }]);
      expect(await reconcileDeploymentTarget(reviewing.services, { enabled: true })).toMatchObject({
        action: "repair_integrated",
        integrated_commit: "f".repeat(40),
      });
      expect(reviewing.calls).toEqual(["snapshot", "integrate:incident-1:review-1"]);
    } finally {
      if (previous == null) delete process.env.CONCIERGE_AUTONOMOUS_REPAIR_ENABLED;
      else process.env.CONCIERGE_AUTONOMOUS_REPAIR_ENABLED = previous;
    }
  });

  test("origin movement returns the incident to its exact repair session instead of replaying a stale review", async () => {
    const previous = process.env.CONCIERGE_AUTONOMOUS_REPAIR_ENABLED;
    process.env.CONCIERGE_AUTONOMOUS_REPAIR_ENABLED = "1";
    try {
      const fixture = services([{
        active_incident: { id: "incident-1", status: "reviewing" },
        active_repair_run: { result_json: JSON.stringify({ head_commit: "b".repeat(40), tree_digest: "1".repeat(64) }) },
        latest_review_run: {
          id: "review-1",
          status: "ship",
          head_commit: "b".repeat(40),
          tree_digest: "1".repeat(64),
        },
      }]);
      fixture.services.integrateRepair = async (incidentId, reviewId) => {
        fixture.calls.push(`integrate:${incidentId}:${reviewId}`);
        return { refresh_required: true, observed_origin_commit: "c".repeat(40) };
      };
      expect(await reconcileDeploymentTarget(fixture.services, { enabled: true })).toEqual({
        action: "repair_refresh_required",
        incident_id: "incident-1",
        observed_origin_commit: "c".repeat(40),
      });
      expect(fixture.calls).toEqual(["snapshot", "integrate:incident-1:review-1"]);
    } finally {
      if (previous == null) delete process.env.CONCIERGE_AUTONOMOUS_REPAIR_ENABLED;
      else process.env.CONCIERGE_AUTONOMOUS_REPAIR_ENABLED = previous;
    }
  });

  test("a blocked repair emits one project alert before the incident becomes terminal", async () => {
    const previous = process.env.CONCIERGE_AUTONOMOUS_REPAIR_ENABLED;
    process.env.CONCIERGE_AUTONOMOUS_REPAIR_ENABLED = "1";
    try {
      const unnotified = services([{
        active_incident: { id: "incident-1", status: "awaiting_owner_fix", error: "protected change required" },
        active_repair_run: { status: "parked" },
        incident_attempt: { status: "restored" },
        incident_generation: { desired_commit: "a".repeat(40) },
        incident_notifications: [],
      }]);
      expect(await reconcileDeploymentTarget(unnotified.services, { enabled: true })).toMatchObject({
        action: "repair_parked_notified",
      });
      expect(unnotified.calls).toEqual(["snapshot", "notify-parked:incident-1"]);

      const notified = services([{
        active_incident: { id: "incident-1", status: "awaiting_owner_fix", error: "protected change required" },
        incident_attempt: { status: "restored" },
        incident_generation: { desired_commit: "a".repeat(40) },
        incident_notifications: [{ kind: "repair_parked", status: "delivered" }],
      }]);
      expect(await reconcileDeploymentTarget(notified.services, { enabled: true })).toMatchObject({
        action: "incident_parked",
      });
      expect(notified.calls).toEqual([
        "snapshot",
        "incident:incident-1:awaiting_owner_fix:parked",
      ]);
    } finally {
      if (previous == null) delete process.env.CONCIERGE_AUTONOMOUS_REPAIR_ENABLED;
      else process.env.CONCIERGE_AUTONOMOUS_REPAIR_ENABLED = previous;
    }
  });

  test("reconciles an ambiguous notification before advancing its incident without reposting", async () => {
    const fixture = services([{
      active_incident: { id: "incident-1", status: "awaiting_owner_fix" },
      unsettled_notifications: [{ id: "notification-1", status: "ambiguous" }],
    }]);
    expect(await reconcileDeploymentTarget(fixture.services, { enabled: true })).toEqual({
      action: "notification_reconciled",
      notification_id: "notification-1",
    });
    expect(fixture.calls).toEqual([
      "snapshot",
      "notification-reconcile:notification-1:ambiguous",
    ]);
  });
});
