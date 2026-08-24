import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  checkedKernelCommand,
  deploymentKernelSocket,
} from "./kernel-client";

export interface ActivationAcknowledgementServices {
  snapshot(): Promise<any>;
  acknowledge(generationId: string, identityDigest: string): Promise<any>;
}

export function activationKernelAvailable() {
  return existsSync(deploymentKernelSocket("bot"));
}

export function activationAcknowledgementServices(): ActivationAcknowledgementServices {
  return {
    snapshot: () => checkedKernelCommand(
      "bot",
      "snapshot.read",
      { entity: "target", id: "concierge", status: "ready" },
      {},
      { idempotencyKey: `kernel:snapshot.read:bot-activation:${randomUUID()}` },
    ),
    acknowledge: (generationId, identityDigest) => checkedKernelCommand(
      "bot",
      "activation.ack",
      { entity: "activation", id: generationId, status: "pending" },
      { generation_id: generationId, identity_digest: identityDigest },
      { idempotencyKey: `kernel:activation.ack:bot:${generationId}:${identityDigest}` },
    ),
  };
}

export async function reconcileActivationAcknowledgement(services: ActivationAcknowledgementServices) {
  const snapshot = await services.snapshot();
  const generation = snapshot.activation_generation;
  if (!generation || generation.status !== "pending") return { action: "no_pending_activation" };
  if (generation.bot_acknowledged_at) {
    return { action: "activation_already_acknowledged", generation_id: generation.id };
  }
  await services.acknowledge(generation.id, generation.identity_digest);
  return { action: "activation_acknowledged", generation_id: generation.id };
}
