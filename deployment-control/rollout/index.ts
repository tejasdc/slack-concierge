#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { currentProcessIdentity } from "../../bot/src/runtime-identity";
import { checkedKernelCommand } from "../../bot/src/deployment-repair/kernel-client";

export interface RolloutSupervisorServices {
  create(rolloutId: string, ownerUnit: string): Promise<any>;
  claim(rolloutId: string, expectedStatus: string, owner: Record<string, unknown>): Promise<any>;
  snapshot(): Promise<any>;
  heartbeat(rolloutId: string, expectedStatus: string, owner: Record<string, unknown>): Promise<any>;
}

export function rolloutSupervisorServices(): RolloutSupervisorServices {
  return {
    create: (rolloutId, ownerUnit) => checkedKernelCommand(
      "rollout",
      "rollout.create",
      { entity: "target", id: "concierge", status: "ready" },
      { rollout_id: rolloutId, owner_unit: ownerUnit },
      { idempotencyKey: `kernel:rollout.create:${rolloutId}` },
    ),
    claim: (rolloutId, expectedStatus, owner) => checkedKernelCommand(
      "rollout",
      "rollout.claim",
      { entity: "rollout", id: rolloutId, status: expectedStatus },
      { rollout_id: rolloutId, owner },
      { idempotencyKey: `kernel:rollout.claim:${rolloutId}:${String(owner.invocation_id)}` },
    ),
    snapshot: () => checkedKernelCommand(
      "rollout",
      "snapshot.read",
      { entity: "target", id: "concierge", status: "ready" },
      {},
      { idempotencyKey: `kernel:snapshot.read:rollout:${randomUUID()}` },
    ),
    heartbeat: (rolloutId, expectedStatus, owner) => checkedKernelCommand(
      "rollout",
      "rollout.heartbeat",
      { entity: "rollout", id: rolloutId, status: expectedStatus },
      { rollout_id: rolloutId, owner },
      { idempotencyKey: `kernel:rollout.heartbeat:${rolloutId}:${randomUUID()}` },
    ),
  };
}

export async function startRolloutSupervisor(input: {
  rolloutId: string;
  ownerUnit: string;
  invocationId: string;
  heartbeatIntervalMs?: number;
  services?: RolloutSupervisorServices;
  shouldStop?: () => boolean;
}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.rolloutId)) {
    throw new Error("The rollout supervisor requires a UUID instance ID.");
  }
  const expectedUnit = `concierge-deployment-rollout@${input.rolloutId}.service`;
  if (input.ownerUnit !== expectedUnit) throw new Error(`The rollout supervisor must run as ${expectedUnit}.`);
  if (!input.invocationId) throw new Error("The rollout supervisor requires its systemd invocation ID.");
  const identity = currentProcessIdentity();
  const owner = {
    invocation_id: input.invocationId,
    pid: identity.pid,
    boot_id: identity.bootId,
    start_ticks: identity.startTicks,
  };
  const services = input.services || rolloutSupervisorServices();
  const created = await services.create(input.rolloutId, input.ownerUnit);
  let rollout = (await services.claim(input.rolloutId, created.rollout.status, owner)).rollout;
  console.log(JSON.stringify({
    event: "deployment_rollout_claimed",
    rollout_id: rollout.id,
    state: rollout.status,
    next_step: rollout.next_step,
    owner_invocation_id: rollout.owner_invocation_id,
  }));
  const interval = input.heartbeatIntervalMs ?? 30_000;
  while (!input.shouldStop?.()) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    if (input.shouldStop?.()) break;
    const snapshot = await services.snapshot();
    const observed = snapshot.active_rollout;
    if (!observed || observed.id !== input.rolloutId) {
      throw new Error(`Rollout ${input.rolloutId} is no longer the kernel's current rollout.`);
    }
    rollout = observed;
    if (["verified", "parked"].includes(rollout.status)) break;
    rollout = (await services.heartbeat(input.rolloutId, rollout.status, owner)).rollout;
    console.log(JSON.stringify({
      event: "deployment_rollout_heartbeat",
      rollout_id: rollout.id,
      state: rollout.status,
      next_step: rollout.next_step,
    }));
  }
  return rollout;
}

if (import.meta.main) {
  let stopping = false;
  process.on("SIGTERM", () => { stopping = true; });
  process.on("SIGINT", () => { stopping = true; });
  const rolloutId = process.argv[2] || "";
  const ownerUnit = process.env.CONCIERGE_ROLLOUT_UNIT || "";
  const invocationId = process.env.INVOCATION_ID || "";
  startRolloutSupervisor({
    rolloutId,
    ownerUnit,
    invocationId,
    shouldStop: () => stopping,
  }).catch((error) => {
    console.error(JSON.stringify({
      event: "deployment_rollout_failed",
      rollout_id: rolloutId,
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exit(1);
  });
}
