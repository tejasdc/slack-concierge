import { describe, expect, test } from "bun:test";
import { startRolloutSupervisor } from "../../../deployment-control/rollout";

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
      },
    })).rejects.toThrow(`must run as ${ownerUnit}`);
  });
});
