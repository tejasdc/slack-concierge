#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { checkedKernelCommand } from "../../bot/src/deployment-repair/kernel-client";

export interface CoordinatorServices {
  snapshot(): Promise<any>;
  prepareGeneration(): Promise<any>;
  createAttempt(generationId: string, expectedStatus: string): Promise<any>;
  launchAttempt(attemptId: string): Promise<any>;
}

export function coordinatorServices(): CoordinatorServices {
  return {
    snapshot: () => checkedKernelCommand(
      "coordinator",
      "snapshot.read",
      { entity: "target", id: "concierge", status: "ready" },
      {},
      { idempotencyKey: `kernel:snapshot.read:coordinator:${randomUUID()}` },
    ),
    prepareGeneration: () => checkedKernelCommand(
      "coordinator",
      "generation.prepare",
      { entity: "target", id: "concierge", status: "idle" },
      {},
      { idempotencyKey: `kernel:generation.prepare:${randomUUID()}` },
    ),
    createAttempt: (generationId, expectedStatus) => checkedKernelCommand(
      "coordinator",
      "attempt.create",
      { entity: "generation", id: generationId, status: expectedStatus },
      { generation_id: generationId },
      { idempotencyKey: `kernel:attempt.create:${generationId}` },
    ),
    launchAttempt: (attemptId) => checkedKernelCommand(
      "coordinator",
      "attempt.launch",
      { entity: "attempt", id: attemptId, status: "prepared" },
      { attempt_id: attemptId },
      { idempotencyKey: `kernel:attempt.launch:${attemptId}` },
    ),
  };
}

export async function reconcileDeploymentTarget(
  services: CoordinatorServices,
  options: { enabled?: boolean } = {},
) {
  const enabled = options.enabled ?? process.env.CONCIERGE_DEPLOYMENT_CONTROL_ENABLED === "1";
  if (!enabled) {
    return { action: "disabled" };
  }
  let current = await services.snapshot();
  if (current.active_incident) {
    return {
      action: process.env.CONCIERGE_AUTONOMOUS_REPAIR_ENABLED === "1"
        ? "repair_adapter_required"
        : "waiting_for_repair_prerequisites",
      incident_id: current.active_incident.id,
    };
  }

  if (!current.active_generation) {
    if (!current.pending_intents?.length) return { action: "idle" };
    await services.prepareGeneration();
    current = await services.snapshot();
  }

  if (!current.active_generation) throw new Error("Generation preparation completed without an active generation.");
  let attempt = current.active_attempt;
  if (!attempt) {
    const created = await services.createAttempt(current.active_generation.id, current.active_generation.status);
    attempt = created.attempt;
  }
  if (attempt.status === "prepared") {
    const launched = await services.launchAttempt(attempt.id);
    return { action: "attempt_launched", attempt_id: attempt.id, unit_name: launched.unit_name };
  }
  return { action: "attempt_active", attempt_id: attempt.id, status: attempt.status };
}

if (import.meta.main) {
  const services = coordinatorServices();
  let stopping = false;
  process.on("SIGTERM", () => { stopping = true; });
  process.on("SIGINT", () => { stopping = true; });
  while (!stopping) {
    try {
      const outcome = await reconcileDeploymentTarget(services);
      if (outcome.action !== "idle" && outcome.action !== "disabled") {
        console.log(JSON.stringify({ event: "deployment_coordinator_reconciled", ...outcome }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: "deployment_coordinator_failed",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    await Bun.sleep(5_000);
  }
}
