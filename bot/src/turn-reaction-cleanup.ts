import { runDurableNoticeWorker } from "./durable-notice-worker";
import { slackCall } from "./rate-limit";
import { isTransientSlackError, slackErrorCode } from "./slack-errors";
import {
  claimTurnReactionCleanup,
  getTurnReactionCleanup,
  markTurnReactionCleanupDelivered,
  markTurnReactionCleanupRetry,
  parkTurnReactionCleanup,
} from "./state";

const activeCleanups = new Map<number, Promise<ReactionCleanupOutcome>>();

export type ReactionCleanupOutcome = "delivered" | "stopped" | "permanent_failure";

export interface TurnReactionCleanupOptions {
  shouldStop?: () => boolean;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  initialDelayMs?: number;
  maximumDelayMs?: number;
}

export function scheduleTurnReactionCleanup(
  client: any,
  turnId: number,
  options: TurnReactionCleanupOptions = {},
): Promise<ReactionCleanupOutcome> {
  const existing = activeCleanups.get(turnId);
  if (existing) return existing;

  const cleanup = runDurableNoticeWorker({
    load: () => {
      const row = getTurnReactionCleanup(turnId);
      return row ? {
        ...row,
        noticeStatus: row.cleanup_status,
        attempts: row.cleanup_attempts,
        nextAttemptMs: row.cleanup_next_attempt_ms,
      } : null;
    },
    claim: (nowMs) => {
      const row = claimTurnReactionCleanup(turnId, nowMs);
      return row ? {
        ...row,
        noticeStatus: row.cleanup_status,
        attempts: row.cleanup_attempts,
        nextAttemptMs: row.cleanup_next_attempt_ms,
      } : null;
    },
    deliver: async (row) => {
      try {
        await slackCall(client, "reactions.remove", {
          channel: row.slack_channel_id,
          timestamp: row.slack_user_msg_ts,
          name: "hourglass_flowing_sand",
        }, { channel: row.slack_channel_id });
      } catch (error) {
        if (["no_reaction", "message_not_found"].includes(slackErrorCode(error))) return;
        throw error;
      }
    },
    markDelivered: () => markTurnReactionCleanupDelivered(turnId),
    markRetry: (error, nextAttemptMs) => markTurnReactionCleanupRetry(turnId, error, nextAttemptMs),
    markParked: (error) => parkTurnReactionCleanup(turnId, error),
    isRetryable: isTransientSlackError,
    shouldStop: options.shouldStop,
    wait: options.wait,
    now: options.now,
    initialDelayMs: options.initialDelayMs,
    maximumDelayMs: options.maximumDelayMs,
  }).finally(() => {
    if (activeCleanups.get(turnId) === cleanup) activeCleanups.delete(turnId);
  });
  activeCleanups.set(turnId, cleanup);
  return cleanup;
}
