import { errorFields, log } from "./log";
import { slackCall } from "./rate-limit";
import { isTransientSlackError } from "./slack-errors";
import {
  claimOrphanedDelivery,
  ensureSlackThreadStatusMessage,
  findLegacySlackThreadStatusMessage,
  finishDeliveredTurn,
  getSlackThreadStatus,
  interruptOrphanedTurn,
  listRecoverableTurns,
  markTurnDeliveryFailed,
  markTurnResponseDelivered,
  parkTurnDelivery,
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
      interruptOrphanedTurn(turn.id, turn.owner_instance_id, reason);
      void removeWorkingReaction(input.client, turn.slack_channel_id, turn.slack_user_msg_ts);
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
        const statusOutcome = await input.services.projectTurnStatus({
          client: input.client,
          turnId: turn.id,
          text: formatTurnStatusMessage({
            state: "error",
            detail: "Status: error - response delivery was permanently parked after restart",
          }),
        });
        if (statusOutcome === "stopped") {
          relinquishTurnDelivery(turn.id, input.instanceId);
          return "stopped";
        }
        parkTurnDelivery(turn.id, input.instanceId);
        void removeWorkingReaction(input.client, turn.slack_channel_id, turn.slack_user_msg_ts);
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
      void removeWorkingReaction(input.client, turn.slack_channel_id, turn.slack_user_msg_ts);
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

async function removeWorkingReaction(client: any, channel: string, messageTs: string) {
  const maximumAttempts = 3;
  let delayMs = 250;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      await slackCall(client, "reactions.remove", {
        channel,
        timestamp: messageTs,
        name: "hourglass_flowing_sand",
      }, { channel });
      return;
    } catch (error) {
      if (!isTransientSlackError(error)) {
        log("warn", "recovered_turn_reaction_remove_parked", {
          ...errorFields(error),
          channel,
          slack_user_msg_ts: messageTs,
        });
        return;
      }
      if (attempt === maximumAttempts) {
        log("warn", "recovered_turn_reaction_remove_retry_exhausted", {
          ...errorFields(error),
          channel,
          slack_user_msg_ts: messageTs,
          attempts: maximumAttempts,
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 30_000);
    }
  }
}
