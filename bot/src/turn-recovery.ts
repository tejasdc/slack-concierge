import { existsSync } from "node:fs";
import { errorFields, log } from "./log";
import { cleanExpiredArtifactStaging } from "./artifact-delivery-worker";
import { findTurnArtifacts, removeArtifactStagingTree } from "./artifacts";
import {
  abandonTurnArtifactBatch,
  claimOrphanedDelivery,
  ensureSlackThreadStatusMessage,
  findLegacySlackThreadStatusMessage,
  finishDeliveredTurn,
  getTurnArtifactBatch,
  getSlackThreadStatus,
  interruptOrphanedTurn,
  listRecoverableTurns,
  markTurnDeliveryFailed,
  markTurnResponseDelivered,
  parkTurnDelivery,
  parkTurnStatusProjectionAfterFailure,
  requeueOrphanedPreAdmissionTurn,
  registerTurnArtifactIntents,
  relinquishTurnDelivery,
} from "./state";
import { formatTurnStatusMessage } from "./text";

type ProjectionOutcome = "delivered" | "stopped" | "permanent_failure";

export interface TurnRecoveryServices {
  deliverOutcome(input: {
    turnId: number;
    client: any;
    channel: string;
    threadTs: string;
    text: string;
  }): Promise<ProjectionOutcome>;
  projectTurnStatus(input: {
    client: any;
    turnId: number;
    text: string;
  }): Promise<ProjectionOutcome>;
  projectThreadSummary(input: {
    client: any;
    channel: string;
    threadTs: string;
    turnId: number;
    text: string;
  }): Promise<ProjectionOutcome>;
  scheduleWorkingReactionCleanup?(client: any, turnId: number): Promise<unknown>;
}

export async function reconcileRecoverableTurns(input: {
  client: any;
  instanceId: string;
  isOwnerAlive(identity: { pid: number; bootId: string; startTicks: string }): boolean;
  services: TurnRecoveryServices;
}): Promise<"done" | "stopped"> {
  for (const turn of listRecoverableTurns()) {
    if (input.isOwnerAlive({
      pid: turn.owner_pid || 0,
      bootId: turn.owner_boot_id || "",
      startTicks: turn.owner_process_start_ticks || "",
    })) continue;

    const visibleThreadTs = turn.slack_reply_thread_ts || turn.slack_user_msg_ts;
    if (turn.status === "running") {
      const orphanedBatch = getTurnArtifactBatch(turn.id);
      const artifactActivity = orphanedBatch && existsSync(orphanedBatch.directory_path)
        ? findTurnArtifacts(orphanedBatch.directory_path).length > 0
        : false;
      if (!artifactActivity && requeueOrphanedPreAdmissionTurn(turn.id, turn.owner_instance_id)) {
        if (orphanedBatch && existsSync(orphanedBatch.directory_path)) {
          try {
            removeArtifactStagingTree(orphanedBatch.directory_path);
          } catch (error) {
            log("warn", "requeued_turn_staging_cleanup_failed", {
              ...errorFields(error),
              turn_id: turn.id,
              artifact_directory: orphanedBatch.directory_path,
            });
          }
        }
        const statusOutcome = await input.services.projectTurnStatus({
          client: input.client,
          turnId: turn.id,
          text: "Status: queued - service restarted before dispatch; input preserved and retrying automatically",
        });
        if (statusOutcome === "stopped") return "stopped";
        continue;
      }
      const reason = "Interrupted because the Concierge service stopped before this agent turn completed.";
      const statusOutcome = await input.services.projectTurnStatus({
        client: input.client,
        turnId: turn.id,
        text: formatTurnStatusMessage({
          state: "interrupted",
          detail: `Status: interrupted - ${reason}`,
        }),
      });
      if (statusOutcome === "stopped") return "stopped";
      abandonInterruptedTurnArtifacts(turn.id, reason);
      interruptOrphanedTurn(turn.id, turn.owner_instance_id, reason);
      scheduleWorkingReactionCleanup(input, turn.id);
      continue;
    }

    const outboundText = turn.outbound_text || turn.agent_text;
    if (!outboundText || !claimOrphanedDelivery(turn.id, turn.owner_instance_id, input.instanceId)) continue;
    let responseDeliveryConfirmed = false;
    try {
      const deliveryOutcome = await input.services.deliverOutcome({
        turnId: turn.id,
        client: input.client,
        channel: turn.slack_channel_id,
        threadTs: visibleThreadTs,
        text: outboundText,
      });
      if (deliveryOutcome === "stopped") {
        relinquishTurnDelivery(turn.id, input.instanceId);
        return "stopped";
      }
      if (deliveryOutcome === "permanent_failure") {
        const artifactDirectory = getTurnArtifactBatch(turn.id)?.directory_path || null;
        abandonTurnArtifactBatch(turn.id, "Recovered response delivery was permanently parked before artifact delivery.");
        cleanExpiredArtifactStaging();
        removeAbandonedArtifactStaging(turn.id, artifactDirectory);
        const parkedStatusText = formatTurnStatusMessage({
          state: "error",
          detail: "Status: error - response delivery was permanently parked after restart",
        });
        if (!parkTurnDelivery(turn.id, input.instanceId, parkedStatusText)) {
          throw new Error("Recovered permanent response delivery failure could not be durably parked.");
        }
        let statusOutcome: ProjectionOutcome;
        try {
          statusOutcome = await input.services.projectTurnStatus({
            client: input.client,
            turnId: turn.id,
            text: parkedStatusText,
          });
        } catch (projectionError) {
          parkTurnStatusProjectionAfterFailure(
            turn.id,
            parkedStatusText,
            `Recovered permanent-delivery status projection failed: ${String(projectionError)}`,
          );
          statusOutcome = "permanent_failure";
          log("error", "recovered_parked_delivery_status_projection_failed", {
            ...errorFields(projectionError),
            turn_id: turn.id,
            channel: turn.slack_channel_id,
          });
        }
        if (statusOutcome !== "delivered") {
          log(statusOutcome === "stopped" ? "warn" : "error", "recovered_parked_delivery_status_projection_incomplete", {
            turn_id: turn.id,
            channel: turn.slack_channel_id,
            outcome: statusOutcome,
          });
        }
        scheduleWorkingReactionCleanup(input, turn.id);
        continue;
      }

      responseDeliveryConfirmed = true;
      const existingThreadStatus = getSlackThreadStatus(turn.slack_channel_id, visibleThreadTs);
      ensureSlackThreadStatusMessage(
        turn.slack_channel_id,
        visibleThreadTs,
        existingThreadStatus?.slack_status_msg_ts ||
          findLegacySlackThreadStatusMessage(turn.slack_channel_id, visibleThreadTs) ||
          turn.slack_bot_msg_ts || "",
      );
      const completedThreadStatus = markTurnResponseDelivered(turn.id);
      const turnStatusOutcome = await input.services.projectTurnStatus({
        client: input.client,
        turnId: turn.id,
        text: formatTurnStatusMessage({
          state: "done",
          tldr: turn.response_tldr || undefined,
          detail: "Status: done - response delivery recovered after restart",
        }),
      });
      if (turnStatusOutcome === "stopped") {
        relinquishTurnDelivery(turn.id, input.instanceId);
        return "stopped";
      }
      const summaryOutcome = await input.services.projectThreadSummary({
        client: input.client,
        channel: turn.slack_channel_id,
        threadTs: visibleThreadTs,
        turnId: turn.id,
        text: formatTurnStatusMessage({
          state: "done",
          tldr: completedThreadStatus?.thread_tldr || turn.response_tldr || undefined,
          detail: "Status: done - response delivery recovered after restart",
        }),
      });
      if (summaryOutcome === "stopped") {
        relinquishTurnDelivery(turn.id, input.instanceId);
        return "stopped";
      }
      finishDeliveredTurn(turn.id);
      scheduleWorkingReactionCleanup(input, turn.id);
    } catch (error) {
      if (!responseDeliveryConfirmed) markTurnDeliveryFailed(turn.id, String(error));
      relinquishTurnDelivery(turn.id, input.instanceId);
      log("error", "turn_recovery_failed", {
        ...errorFields(error),
        turn_id: turn.id,
        channel: turn.slack_channel_id,
      });
      throw error;
    }
  }
  return "done";
}

function abandonInterruptedTurnArtifacts(turnId: number, reason: string) {
  const batch = getTurnArtifactBatch(turnId);
  if (!batch) return;
  try {
    if (batch.status === "collecting") {
      registerTurnArtifactIntents(turnId, findTurnArtifacts(batch.directory_path));
    }
  } catch (error) {
    log("warn", "interrupted_turn_artifact_registration_failed", {
      turn_id: turnId,
      artifact_directory: batch.directory_path,
      ...errorFields(error),
    });
  }
  abandonTurnArtifactBatch(turnId, reason);
  cleanExpiredArtifactStaging();
  removeAbandonedArtifactStaging(turnId, batch.directory_path);
}

function removeAbandonedArtifactStaging(turnId: number, directory: string | null) {
  if (!directory) return;
  try {
    removeArtifactStagingTree(directory);
  } catch (error) {
    log("warn", "recovered_abandoned_artifact_staging_cleanup_failed", {
      turn_id: turnId,
      artifact_directory: directory,
      ...errorFields(error),
    });
  }
}

function scheduleWorkingReactionCleanup(
  input: Parameters<typeof reconcileRecoverableTurns>[0],
  turnId: number,
) {
  void input.services.scheduleWorkingReactionCleanup?.(input.client, turnId).catch((error) => {
    log("error", "recovered_turn_reaction_cleanup_worker_failed", {
      ...errorFields(error),
      turn_id: turnId,
    });
  });
}
