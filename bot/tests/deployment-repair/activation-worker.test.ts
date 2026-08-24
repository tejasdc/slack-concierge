import { describe, expect, test } from "bun:test";
import { reconcileActivationAcknowledgement } from "../../src/deployment-repair/activation-worker";

describe("application activation acknowledgement", () => {
  test("acknowledges one pending kernel generation with its exact identity", async () => {
    const calls: string[] = [];
    const result = await reconcileActivationAcknowledgement({
      snapshot: async () => ({
        activation_generation: {
          id: "generation-1",
          status: "pending",
          identity_digest: "a".repeat(64),
          bot_acknowledged_at: null,
        },
      }),
      acknowledge: async (generationId, identityDigest) => {
        calls.push(`${generationId}:${identityDigest}`);
        return {};
      },
    });
    expect(result).toEqual({ action: "activation_acknowledged", generation_id: "generation-1" });
    expect(calls).toEqual([`generation-1:${"a".repeat(64)}`]);
  });

  test("does not repeat an acknowledgement or invent an activation", async () => {
    const noPending = await reconcileActivationAcknowledgement({
      snapshot: async () => ({ activation_generation: null }),
      acknowledge: async () => { throw new Error("must not acknowledge"); },
    });
    expect(noPending).toEqual({ action: "no_pending_activation" });

    const already = await reconcileActivationAcknowledgement({
      snapshot: async () => ({
        activation_generation: {
          id: "generation-2",
          status: "pending",
          identity_digest: "b".repeat(64),
          bot_acknowledged_at: "2026-08-24 00:00:00",
        },
      }),
      acknowledge: async () => { throw new Error("must not repeat"); },
    });
    expect(already).toEqual({ action: "activation_already_acknowledged", generation_id: "generation-2" });
  });
});
