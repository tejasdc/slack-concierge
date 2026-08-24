import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { DeploymentHandoffRow } from "../../../deployment-control/kernel/state";
import {
  checkedKernelCommand,
  deploymentKernelSocket,
  DeploymentKernelCommandError,
} from "./kernel-client";
import {
  activateControlHandoffProjection,
  controlHandoffSettlements,
  listUnsettledControlHandoffProjections,
  markControlHandoffProjectionAmbiguous,
  prepareControlHandoffProjection,
  settleControlHandoffProjection,
} from "./handoff-projection";

export interface ControlHandoffKernelServices {
  list(): Promise<DeploymentHandoffRow[]>;
  claim(handoff: DeploymentHandoffRow, ownerKey: string): Promise<void>;
  settle(handoffId: string, ownerKey: string, outcome: "delivered" | "parked", error: string | null): Promise<void>;
}

export function controlHandoffKernelAvailable() {
  return existsSync(deploymentKernelSocket("bot"));
}

export function controlHandoffKernelServices(): ControlHandoffKernelServices {
  return {
    list: async () => {
      const result = await checkedKernelCommand(
        "bot",
        "handoff.list",
        { entity: "target", id: "concierge", status: "ready" },
        {},
        { idempotencyKey: `kernel:handoff.list:${randomUUID()}` },
      );
      return result.handoffs;
    },
    claim: async (handoff, ownerKey) => {
      const result = await checkedKernelCommand(
        "bot",
        "handoff.claim",
        { entity: "handoff", id: handoff.id, status: "pending" },
        { handoff_id: handoff.id, owner_instance_id: ownerKey },
        { idempotencyKey: `kernel:handoff.claim:${handoff.id}` },
      );
      if (!result.handoff || result.handoff.id !== handoff.id) {
        throw new Error(`Kernel did not return claimed handoff ${handoff.id}.`);
      }
    },
    settle: async (handoffId, ownerKey, outcome, error) => {
      const result = await checkedKernelCommand(
        "bot",
        "handoff.settle",
        { entity: "handoff", id: handoffId, status: "claimed" },
        { handoff_id: handoffId, owner_instance_id: ownerKey, outcome, error },
        { idempotencyKey: `kernel:handoff.settle:${handoffId}:${outcome}` },
      );
      if (!result.handoff || result.handoff.status !== outcome) {
        throw new Error(`Kernel did not settle handoff ${handoffId} as ${outcome}.`);
      }
    },
  };
}

export async function reconcileControlHandoffs(services: ControlHandoffKernelServices) {
  const pending = await services.list();
  for (const handoff of pending) prepareControlHandoffProjection(handoff);

  let activated = 0;
  let settled = 0;
  let ambiguous = 0;
  for (const projection of listUnsettledControlHandoffProjections()) {
    if (projection.status !== "prepared") continue;
    const handoff = JSON.parse(projection.handoff_json) as DeploymentHandoffRow;
    try {
      await services.claim(handoff, projection.kernel_owner_key);
      activateControlHandoffProjection(handoff.id);
      activated += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof DeploymentKernelCommandError) {
        markControlHandoffProjectionAmbiguous(handoff.id, message);
        ambiguous += 1;
      }
    }
  }

  for (const projection of controlHandoffSettlements()) {
    try {
      await services.settle(
        projection.handoff_id,
        projection.kernel_owner_key,
        projection.wake_status,
        projection.wake_error,
      );
      settleControlHandoffProjection(projection.handoff_id, projection.wake_status, projection.wake_error);
      settled += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof DeploymentKernelCommandError) {
        markControlHandoffProjectionAmbiguous(projection.handoff_id, message);
        ambiguous += 1;
      }
    }
  }

  return { discovered: pending.length, activated, settled, ambiguous };
}
