import { existsSync } from "node:fs";
import { errorFields, log } from "./log";
import { cleanExpiredArtifactStaging } from "./artifact-delivery-worker";
import { findTurnArtifacts, removeArtifactStagingTree } from "./artifacts";
import {
  abandonTurnArtifactBatch,
  cancelRunningTurnAndReleaseSession,
  claimOrphanedDelivery,
  ensureSlackThreadStatusMessage,
  findLegacySlackThreadStatusMessage,
  finishDeliveredTurn,
  getSlackRootRequestText,
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
import { conciergeRootSummary, formatTurnStatusMessage } from "./text";
import type { SlackAgentProgressChunk } from "./agent-progress";

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
  stopAgentProgress?(input: {
    client: any;
    turnId: number;
    channel: string;
    streamTs: string;
    chunks: SlackAgentProgressChunk[];
  }): Promise<void>;
  setAgentSessionStatus?(input: {
    client: any;
    channel: string;
    threadTs: string;
    status: "active" | "processing" | "suspended";
  }): Promise<void>;
  projectRootSummary?(input: {
    client: any;
    channel: string;
    threadTs: string;
    turnId: number;
    text: string;
  }): Promise<ProjectionOutcome>;
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
      if (turn.projection_mode === "agent" && turn.stop_requested_at) {
        const reason = "Turn stopped from Slack.";
        await stopRecoveredAgentProgress(input, turn, "Stopped", "complete");
        await setRecoveredAgentSessionStatus(
          input,
          turn.slack_channel_id,
          visibleThreadTs,
          turn.id,
          "active",
        );
        abandonInterruptedTurnArtifacts(turn.id, reason);
        if (!cancelRunningTurnAndReleaseSession(turn.id, turn.owner_instance_id, reason)) {
          throw new Error(`Recovered native Stop could not cancel turn ${turn.id}.`);
        }
        continue;
      }
      const orphanedBatch = getTurnArtifactBatch(turn.id);
      const artifactActivity = orphanedBatch && existsSync(orphanedBatch.directory_path)
        ? findTurnArtifacts(orphanedBatch.directory_path).length > 0
        : false;
      const ambiguousAgentStreamStart = turn.projection_mode === "agent"
        && turn.progress_stream_state === "starting"
        && !turn.progress_stream_ts;
      if (!artifactActivity
        && !ambiguousAgentStreamStart
        && requeueOrphanedPreAdmissionTurn(turn.id, turn.owner_instance_id)) {
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
        if (turn.projection_mode === "legacy") {
          const statusOutcome = await input.services.projectTurnStatus({
            client: input.client,
            turnId: turn.id,
            text: "Status: queued - service restarted before dispatch; input preserved and retrying automatically",
          });
          if (statusOutcome === "stopped") return "stopped";
        }
        continue;
      }
      const reason = ambiguousAgentStreamStart
        ? "Interrupted because Agent progress-stream creation had an ambiguous Slack outcome."
        : "Interrupted because the Concierge service stopped before this agent turn completed.";
      if (turn.projection_mode === "agent") {
        await stopRecoveredAgentProgress(input, turn, reason, "error");
        await setRecoveredAgentSessionStatus(
          input,
          turn.slack_channel_id,
          visibleThreadTs,
          turn.id,
          "suspended",
        );
      } else {
        const statusOutcome = await input.services.projectTurnStatus({
          client: input.client,
          turnId: turn.id,
          text: formatTurnStatusMessage({
            state: "interrupted",
            detail: `Status: interrupted - ${reason}`,
          }),
        });
        if (statusOutcome === "stopped") return "stopped";
      }
      abandonInterruptedTurnArtifacts(turn.id, reason);
      interruptOrphanedTurn(turn.id, turn.owner_instance_id, reason);
      if (turn.projection_mode === "agent" && turn.requested_by_user_id) {
        const actionText = `<@${turn.requested_by_user_id}> Action required for turn ${turn.id}: ${reason}`;
        try {
          await input.services.projectTurnStatus({
            client: input.client,
            turnId: turn.id,
            text: actionText,
          });
        } catch (error) {
          parkTurnStatusProjectionAfterFailure(
            turn.id,
            actionText,
            `Recovered interruption notice failed: ${String(error)}`,
          );
        }
      }
      scheduleWorkingReactionCleanup(input, turn.id);
      continue;
    }

    const outboundText = turn.outbound_text || turn.agent_text;
    if (!outboundText || !claimOrphanedDelivery(turn.id, turn.owner_instance_id, input.instanceId)) continue;
    if (turn.projection_mode === "agent") {
      const progressStopped = await stopRecoveredAgentProgress(
        input,
        turn,
        "Work complete",
        "complete",
      );
      if (!progressStopped) {
        await setRecoveredAgentSessionStatus(
          input,
          turn.slack_channel_id,
          visibleThreadTs,
          turn.id,
          "suspended",
        );
        if (turn.requested_by_user_id) {
          const actionText = `<@${turn.requested_by_user_id}> Action required for turn ${turn.id}: Concierge could not close the Agent progress stream, so the final reply was not posted.`;
          try {
            await input.services.projectTurnStatus({
              client: input.client,
              turnId: turn.id,
              text: actionText,
            });
          } catch (projectionError) {
            parkTurnStatusProjectionAfterFailure(
              turn.id,
              actionText,
              `Recovered Agent stream-stop notice failed: ${String(projectionError)}`,
            );
          }
        }
        relinquishTurnDelivery(turn.id, input.instanceId);
        continue;
      }
    }
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
        let statusOutcome: ProjectionOutcome = "delivered";
        if (turn.projection_mode === "legacy") {
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
        } else {
          await setRecoveredAgentSessionStatus(
            input,
            turn.slack_channel_id,
            visibleThreadTs,
            turn.id,
            "suspended",
          );
          if (turn.requested_by_user_id) {
            const actionText = `<@${turn.requested_by_user_id}> Action required for turn ${turn.id}: response delivery was permanently parked after restart.`;
            try {
              statusOutcome = await input.services.projectTurnStatus({
                client: input.client,
                turnId: turn.id,
                text: actionText,
              });
            } catch (projectionError) {
              parkTurnStatusProjectionAfterFailure(
                turn.id,
                actionText,
                `Recovered Agent delivery notice failed: ${String(projectionError)}`,
              );
              statusOutcome = "permanent_failure";
            }
          }
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
      let summaryOutcome: ProjectionOutcome;
      if (turn.projection_mode === "agent") {
        const rootRequestText = getSlackRootRequestText(turn.slack_channel_id, visibleThreadTs);
        const rootSummaryText = rootRequestText
          ? conciergeRootSummary(turn.agent_text || "", rootRequestText)
          : null;
        summaryOutcome = input.services.projectRootSummary && rootSummaryText
          ? await input.services.projectRootSummary({
              client: input.client,
              channel: turn.slack_channel_id,
              threadTs: visibleThreadTs,
              turnId: turn.id,
              text: rootSummaryText,
            })
          : "delivered";
      } else {
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
        summaryOutcome = await input.services.projectThreadSummary({
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
      }
      if (turn.projection_mode === "legacy" && summaryOutcome === "stopped") {
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

async function stopRecoveredAgentProgress(
  input: Parameters<typeof reconcileRecoverableTurns>[0],
  turn: {
    id: number;
    slack_channel_id: string;
    progress_stream_ts: string | null;
    progress_stream_state: string;
  },
  title: string,
  status: "complete" | "error",
) {
  if (turn.progress_stream_state === "stopped") return true;
  if (!input.services.stopAgentProgress
    || !turn.progress_stream_ts
    || !["streaming", "stopping", "parked"].includes(turn.progress_stream_state)) return false;
  try {
    await input.services.stopAgentProgress({
      client: input.client,
      turnId: turn.id,
      channel: turn.slack_channel_id,
      streamTs: turn.progress_stream_ts,
      chunks: [{
        type: "task_update",
        id: `operation-recovery-result-${turn.id}`,
        title,
        status,
      }],
    });
    return true;
  } catch (error) {
    log("error", "recovered_agent_progress_stop_failed", {
      ...errorFields(error),
      turn_id: turn.id,
      channel: turn.slack_channel_id,
      stream_ts: turn.progress_stream_ts,
    });
    return false;
  }
}

async function setRecoveredAgentSessionStatus(
  input: Parameters<typeof reconcileRecoverableTurns>[0],
  channel: string,
  threadTs: string,
  turnId: number,
  status: "active" | "processing" | "suspended",
) {
  if (!input.services.setAgentSessionStatus) return;
  try {
    await input.services.setAgentSessionStatus({
      client: input.client,
      channel,
      threadTs,
      status,
    });
  } catch (error) {
    log("warn", "recovered_agent_session_status_failed", {
      ...errorFields(error),
      turn_id: turnId,
      status,
      channel,
      thread_ts: threadTs,
    });
  }
}
