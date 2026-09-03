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
  getSlackAgentSessionStatusProjection,
  getSlackRootRequestText,
  getSlackRootSummaryProjection,
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
  turnHasAmbiguousAgentProgressStart,
} from "./state";
import {
  appendAgentSessionStatusProjectionFailure,
  conciergeRootSummary,
  formatTurnStatusMessage,
  terminalProjectionFailureNotice,
} from "./text";
import { agentWorkCompleteTitle, type SlackAgentProgressChunk } from "./agent-progress";

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
  }): Promise<void | ProjectionOutcome>;
  projectRootSummary?(input: {
    client: any;
    channel: string;
    threadTs: string;
    turnId: number;
    text: string;
  }): Promise<ProjectionOutcome>;
}

interface AgentSessionStatusProjectionResult {
  outcome: ProjectionOutcome;
  error: string | null;
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
        const agentSessionStatus = await setRecoveredAgentSessionStatus(
          input,
          turn.slack_channel_id,
          visibleThreadTs,
          turn.id,
          "active",
        );
        if (agentSessionStatus.outcome === "stopped") return "stopped";
        if (agentSessionStatus.error && turn.requested_by_user_id) {
          const failureNotice = terminalProjectionFailureNotice(
            turn.requested_by_user_id,
            turn.id,
            { agentSessionStatusError: agentSessionStatus.error },
          )!;
          const noticeOutcome = await input.services.projectTurnStatus({
            client: input.client,
            turnId: turn.id,
            text: failureNotice,
          });
          if (noticeOutcome === "stopped") return "stopped";
        }
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
      const ambiguousAgentStreamStart = turnHasAmbiguousAgentProgressStart(turn.id);
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
        ? "Interrupted because Agent progress creation had an ambiguous Slack outcome."
        : "Interrupted because the Concierge service stopped before this agent turn completed.";
      let recoveredAgentSessionStatus: AgentSessionStatusProjectionResult = {
        outcome: "delivered",
        error: null,
      };
      if (turn.projection_mode === "agent") {
        await stopRecoveredAgentProgress(input, turn, reason, "error");
        recoveredAgentSessionStatus = await setRecoveredAgentSessionStatus(
          input,
          turn.slack_channel_id,
          visibleThreadTs,
          turn.id,
          "suspended",
        );
        if (recoveredAgentSessionStatus.outcome === "stopped") return "stopped";
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
        const interruptionText = `<@${turn.requested_by_user_id}> Action required for turn ${turn.id}: ${reason}`;
        const actionText = recoveredAgentSessionStatus.error
          ? appendAgentSessionStatusProjectionFailure(
              interruptionText,
              turn.requested_by_user_id,
              turn.id,
              recoveredAgentSessionStatus.error,
            )
          : interruptionText;
        try {
          const noticeOutcome = await input.services.projectTurnStatus({
            client: input.client,
            turnId: turn.id,
            text: actionText,
          });
          if (noticeOutcome === "stopped") return "stopped";
          if (noticeOutcome === "permanent_failure") {
            log("error", "recovered_interruption_notice_parked", {
              turn_id: turn.id,
              channel: turn.slack_channel_id,
            });
          }
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
        agentWorkCompleteTitle(turn.provider_duration_ms),
        "complete",
      );
      if (!progressStopped) {
        const agentSessionStatus = await setRecoveredAgentSessionStatus(
          input,
          turn.slack_channel_id,
          visibleThreadTs,
          turn.id,
          "suspended",
        );
        if (agentSessionStatus.outcome === "stopped") {
          relinquishTurnDelivery(turn.id, input.instanceId);
          return "stopped";
        }
        if (turn.requested_by_user_id) {
          const progressFailureText = `<@${turn.requested_by_user_id}> Action required for turn ${turn.id}: Concierge could not finalize Agent progress, so the final reply was not posted.`;
          const actionText = agentSessionStatus.error
            ? appendAgentSessionStatusProjectionFailure(
                progressFailureText,
                turn.requested_by_user_id,
                turn.id,
                agentSessionStatus.error,
              )
            : progressFailureText;
          try {
            const noticeOutcome = await input.services.projectTurnStatus({
              client: input.client,
              turnId: turn.id,
              text: actionText,
            });
            if (noticeOutcome === "stopped") {
              relinquishTurnDelivery(turn.id, input.instanceId);
              return "stopped";
            }
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
          const agentSessionStatus = await setRecoveredAgentSessionStatus(
            input,
            turn.slack_channel_id,
            visibleThreadTs,
            turn.id,
            "suspended",
          );
          if (turn.requested_by_user_id) {
            const deliveryFailureText = `<@${turn.requested_by_user_id}> Action required for turn ${turn.id}: response delivery was permanently parked after restart.`;
            const actionText = agentSessionStatus.error
              ? appendAgentSessionStatusProjectionFailure(
                  deliveryFailureText,
                  turn.requested_by_user_id,
                  turn.id,
                  agentSessionStatus.error,
                )
              : deliveryFailureText;
            try {
              statusOutcome = await input.services.projectTurnStatus({
                client: input.client,
                turnId: turn.id,
                text: actionText,
              });
              if (agentSessionStatus.outcome === "stopped" && statusOutcome === "delivered") {
                statusOutcome = "stopped";
              }
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
        const existingRootSummary = getSlackRootSummaryProjection(
          turn.slack_channel_id,
          visibleThreadTs,
        );
        const rootSummaryAlreadySettled = existingRootSummary?.desired_turn_id === turn.id
          && existingRootSummary.desired_text === rootSummaryText
          && ["delivered", "parked"].includes(existingRootSummary.projection_status);
        if (rootSummaryAlreadySettled) {
          summaryOutcome = existingRootSummary!.projection_status === "delivered"
            ? "delivered"
            : "permanent_failure";
        } else if (input.services.projectRootSummary && rootSummaryText) {
          summaryOutcome = await input.services.projectRootSummary({
            client: input.client,
            channel: turn.slack_channel_id,
            threadTs: visibleThreadTs,
            turnId: turn.id,
            text: rootSummaryText,
          });
        } else {
          summaryOutcome = "delivered";
        }
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
      if (summaryOutcome === "stopped") {
        relinquishTurnDelivery(turn.id, input.instanceId);
        return "stopped";
      }
      const rootSummaryError = turn.projection_mode === "agent" && summaryOutcome === "permanent_failure"
        ? getSlackRootSummaryProjection(
          turn.slack_channel_id,
          visibleThreadTs,
        )?.projection_error || "Root-summary projection failed permanently during recovery."
        : null;
      if (turn.projection_mode === "agent") {
        const agentSessionStatus = await setRecoveredAgentSessionStatus(
          input,
          turn.slack_channel_id,
          visibleThreadTs,
          turn.id,
          "active",
        );
        if (agentSessionStatus.outcome === "stopped") {
          relinquishTurnDelivery(turn.id, input.instanceId);
          return "stopped";
        }
        const failureNotice = turn.requested_by_user_id
          ? terminalProjectionFailureNotice(turn.requested_by_user_id, turn.id, {
              rootSummaryError,
              agentSessionStatusError: agentSessionStatus.error,
            })
          : null;
        if (failureNotice) {
          try {
            const noticeOutcome = await input.services.projectTurnStatus({
              client: input.client,
              turnId: turn.id,
              text: failureNotice,
            });
            if (noticeOutcome === "stopped") {
              relinquishTurnDelivery(turn.id, input.instanceId);
              return "stopped";
            }
            if (noticeOutcome !== "delivered") {
              log("error", "recovered_terminal_projection_failure_notice_incomplete", {
                turn_id: turn.id,
                channel: turn.slack_channel_id,
                outcome: noticeOutcome,
              });
            }
          } catch (noticeError) {
            log("error", "recovered_terminal_projection_failure_notice_failed", {
              ...errorFields(noticeError),
              turn_id: turn.id,
              channel: turn.slack_channel_id,
            });
          }
        }
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
    progress_activity_id: string | null;
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
        id: turn.progress_activity_id ?? `operation-recovery-result-${turn.id}`,
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
): Promise<AgentSessionStatusProjectionResult> {
  if (!input.services.setAgentSessionStatus) return { outcome: "delivered", error: null };
  try {
    const outcome = await input.services.setAgentSessionStatus({
      client: input.client,
      channel,
      threadTs,
      status,
    });
    const normalizedOutcome = outcome || "delivered";
    const projectionError = normalizedOutcome === "permanent_failure"
      ? getSlackAgentSessionStatusProjection(channel, threadTs)?.projection_error
        || `Agent session status ${status} projection failed permanently.`
      : null;
    return { outcome: normalizedOutcome, error: projectionError };
  } catch (error) {
    log("warn", "recovered_agent_session_status_failed", {
      ...errorFields(error),
      turn_id: turnId,
      status,
      channel,
      thread_ts: threadTs,
    });
    return {
      outcome: "permanent_failure",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
