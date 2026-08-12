import { runDurableNoticeWorker } from "./durable-notice-worker";
import { slackCall } from "./rate-limit";
import { isTransientSlackError, slackErrorCode } from "./slack-errors";
import {
  claimTurnReactionCleanup,
  getTurnReactionCleanup,
  markTurnReactionCleanupDelivered,
  markTurnReactionCleanupRetry,
  parkExhaustedTurnReactionCleanup,
  parkTurnReactionCleanup,
} from "./state";

const activeCleanups = new Map<number, Promise<ReactionCleanupOutcome>>();
export const TURN_REACTION_CLEANUP_MAX_ATTEMPTS = 8;

export type ReactionCleanupOutcome = "delivered" | "stopped" | "permanent_failure";

export interface TurnReactionCleanupOptions {
  shouldStop?: () => boolean;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  initialDelayMs?: number;
  maximumDelayMs?: number;
  maximumAttempts?: number;
}

export function scheduleTurnReactionCleanup(
  client: any,
  turnId: number,
  options: TurnReactionCleanupOptions = {},
): Promise<ReactionCleanupOutcome> {
  const existing = activeCleanups.get(turnId);
  if (existing) return existing;
  const maximumAttempts = options.maximumAttempts ?? TURN_REACTION_CLEANUP_MAX_ATTEMPTS;

  const cleanup = runDurableNoticeWorker({
    load: () => {
      let row = getTurnReactionCleanup(turnId);
      if (row?.cleanup_status === "pending" && row.cleanup_attempts >= maximumAttempts) {
        parkExhaustedTurnReactionCleanup(turnId, maximumAttempts);
        row = getTurnReactionCleanup(turnId);
      }
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
    maximumAttempts,
  }).finally(() => {
    if (activeCleanups.get(turnId) === cleanup) activeCleanups.delete(turnId);
  });
  activeCleanups.set(turnId, cleanup);
  return cleanup;
}
