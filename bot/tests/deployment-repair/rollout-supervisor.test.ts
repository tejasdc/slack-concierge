import { describe, expect, test } from "bun:test";
import {
  reconcileRolloutStep,
  startRolloutSupervisor,
  type RolloutSupervisorServices,
} from "../../../deployment-control/rollout";

const rolloutId = "11111111-1111-4111-8111-111111111111";
const ownerUnit = `concierge-deployment-rollout@${rolloutId}.service`;

describe("deployment rollout supervisor", () => {
  test("claims the exact systemd instance and exposes its durable next step", async () => {
    const calls: string[] = [];
    const rollout = await startRolloutSupervisor({
      rolloutId,
      ownerUnit,
      invocationId: "22222222222222222222222222222222",
      shouldStop: () => true,
      services: {
        create: async (id, unit) => {
          calls.push(`create:${id}:${unit}`);
          return { rollout: { id, status: "staged", next_step: "claim_rollout_lease" } };
        },
        claim: async (id, status, owner) => {
          calls.push(`claim:${id}:${status}:${String(owner.invocation_id)}`);
          return {
            rollout: {
              id,
              status: "staged",
              next_step: "contain_application",
              owner_invocation_id: owner.invocation_id,
            },
          };
        },
        snapshot: async () => { throw new Error("must not snapshot after stop"); },
        heartbeat: async () => { throw new Error("must not heartbeat after stop"); },
        command: async () => { throw new Error("must not command after stop"); },
      },
    });
    expect(rollout).toMatchObject({ status: "staged", next_step: "contain_application" });
    expect(calls).toEqual([
      `create:${rolloutId}:${ownerUnit}`,
      `claim:${rolloutId}:staged:22222222222222222222222222222222`,
    ]);
  });

  test("rejects a mismatched unit before requesting kernel authority", async () => {
    await expect(startRolloutSupervisor({
      rolloutId,
      ownerUnit: "concierge-deployment-rollout@different.service",
      invocationId: "invocation",
      shouldStop: () => true,
      services: {
        create: async () => { throw new Error("must not create"); },
        claim: async () => { throw new Error("must not claim"); },
        snapshot: async () => { throw new Error("must not snapshot"); },
        heartbeat: async () => { throw new Error("must not heartbeat"); },
        command: async () => { throw new Error("must not command"); },
      },
    })).rejects.toThrow(`must run as ${ownerUnit}`);
  });

  test("drives protected rollout phases with owner-fenced commands", async () => {
    const commands: Array<{ command: string; expected: any; payload: any }> = [];
    const services = {
      command: async (command: string, expected: any, payload: any) => {
        commands.push({ command, expected, payload });
        return {};
      },
    } as RolloutSupervisorServices;
    const owner = {
      invocation_id: "invocation",
      pid: 42,
      boot_id: "boot",
      start_ticks: "ticks",
    };
    const staged = {
      active_rollout: { id: rolloutId, status: "staged", next_step: "claim" },
      rollout_checks: [],
    };
    await expect(reconcileRolloutStep({ services, snapshot: staged, rolloutId, owner })).resolves.toMatchObject({
      action: "rollout_containing_application",
    });
    expect(commands[0]).toMatchObject({
      command: "rollout.transition",
      expected: { entity: "rollout", id: rolloutId, status: "staged" },
      payload: {
        rollout_id: rolloutId,
        owner,
        status: "containing_application",
      },
    });

    commands.length = 0;
    const canary = {
      active_rollout: { id: rolloutId, status: "canary_probation" },
      rollout_checks: [],
      canary_activation: { id: "canary", rollout_id: rolloutId, status: "exposed" },
      canary_handoff: { handshake_at: "2026-08-24 00:00:00", heartbeat_at: "2026-08-24 00:00:00" },
      rollout_incident: { id: "incident", status: "verifying", rollout_id: rolloutId },
    };
    await expect(reconcileRolloutStep({ services, snapshot: canary, rolloutId, owner })).resolves.toMatchObject({
      action: "synthetic_learning_recorded",
    });
    expect(commands[0]).toMatchObject({
      command: "learning.record",
      expected: { entity: "incident", id: "incident", status: "verifying" },
    });
  });

  test("settles rollback evidence before freezing and releases admission only after verification", async () => {
    const commands: string[] = [];
    const services = {
      command: async (command: string) => {
        commands.push(command);
        return {};
      },
    } as RolloutSupervisorServices;
    const owner = { invocation_id: "invocation", pid: 42, boot_id: "boot", start_ticks: "ticks" };
    const passed = (name: string, evidence: Record<string, unknown> = {}) => ({
      name,
      status: "passed",
      evidence_json: JSON.stringify(evidence),
    });
    const recovery = {
      active_rollout: { id: rolloutId, status: "recovery_proving" },
      rollout_checks: [
        passed("canary_recovery"),
        passed("last_known_good_health"),
        passed("contained_rollback", {
          restored_service_invocation_id: "a".repeat(32),
          capture_probe: "functional health passed",
          service_probe: "functional health passed",
        }),
        passed("contained_rollback_alert"),
      ],
      rollout_incident: { id: "incident", status: "resolved", rollout_id: rolloutId },
      rollout_incident_notifications: [{ id: "notice", kind: "runtime_restored", status: "delivered" }],
    };
    await expect(reconcileRolloutStep({ services, snapshot: recovery, rolloutId, owner })).resolves.toMatchObject({
      action: "rollout_evidence_frozen",
    });
    expect(commands).toEqual(["rollout.evidence.freeze"]);

    commands.length = 0;
    const verified = {
      active_rollout: { id: rolloutId, status: "verified" },
      rollout_checks: recovery.rollout_checks,
      rollout_gates: { status: "held" },
      rollout_incident: recovery.rollout_incident,
      rollout_incident_notifications: recovery.rollout_incident_notifications,
    };
    await expect(reconcileRolloutStep({ services, snapshot: verified, rolloutId, owner })).resolves.toMatchObject({
      action: "rollout_admission_released",
    });
    expect(commands).toEqual(["rollout.gates.release"]);
  });

  test("does not silently finish a verified rollout whose gate release failed before reconciliation", async () => {
    const verified = {
      id: rolloutId,
      status: "verified",
      next_step: "release_admission_gates",
    };
    const snapshot = {
      active_rollout: verified,
      rollout_checks: [],
      rollout_gates: { status: "held" },
    };
    await expect(startRolloutSupervisor({
      rolloutId,
      ownerUnit,
      invocationId: "33333333333333333333333333333333",
      heartbeatIntervalMs: 0,
      services: {
        create: async () => ({ rollout: verified }),
        claim: async () => ({ rollout: verified }),
        snapshot: async () => snapshot,
        heartbeat: async () => ({ rollout: verified }),
        command: async (command) => {
          if (command === "rollout.gates.release") throw new Error("kernel request failed before release intent");
          throw new Error(`unexpected command ${command}`);
        },
      },
    })).rejects.toThrow("Verified rollout 11111111-1111-4111-8111-111111111111 still has held admission gates");
  });
});
