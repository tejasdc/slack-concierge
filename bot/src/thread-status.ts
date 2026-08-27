import { createHash } from "node:crypto";
import { scopeSlackIdempotencyKey } from "./slack-idempotency";

export interface SlackThreadStatusProjection {
  slack_channel_id: string;
  slack_thread_ts: string;
  slack_status_msg_ts: string;
  anchor_turn_id?: number | null;
  message_generation: number;
  desired_text: string | null;
  desired_revision: number;
  projected_revision: number;
  projection_status: "not_needed" | "pending" | "sending" | "delivered" | "parked";
  projection_attempts: number;
  projection_next_attempt_ms: number | null;
}

type MaybePromise<T> = T | Promise<T>;

export function threadStatusClientMessageId(channel: string, threadTs: string, generation: number): string {
  const hex = createHash("sha256")
    .update(scopeSlackIdempotencyKey(`thread-status:${channel}:${threadTs}:${generation}`))
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export async function runSlackThreadStatusProjection(input: {
  load: () => MaybePromise<SlackThreadStatusProjection | null>;
  claim: (nowMs: number) => MaybePromise<SlackThreadStatusProjection | null>;
  update: (row: SlackThreadStatusProjection) => Promise<void>;
  post: (row: SlackThreadStatusProjection, clientMessageId: string) => Promise<{ ts?: string }>;
  recordMessage: (row: SlackThreadStatusProjection, messageTs: string) => MaybePromise<void>;
  replaceMissingMessage: (row: SlackThreadStatusProjection) => MaybePromise<void>;
  markDelivered: (row: SlackThreadStatusProjection) => MaybePromise<void>;
  markRetry: (row: SlackThreadStatusProjection, error: string, nextAttemptMs: number) => MaybePromise<void>;
  markParked: (row: SlackThreadStatusProjection, error: string) => MaybePromise<void>;
  isMissingUpdateError: (error: unknown) => boolean;
  isMissingDuplicateError: (error: unknown) => boolean;
  isRetryable: (error: unknown) => boolean;
  shouldStop?: () => boolean;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  initialDelayMs?: number;
  maximumDelayMs?: number;
  clientMessageId?: (row: SlackThreadStatusProjection) => string;
}): Promise<"delivered" | "stopped" | "permanent_failure"> {
  const now = input.now || Date.now;
  const wait = input.wait || ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const initialDelayMs = input.initialDelayMs ?? 1_000;
  const maximumDelayMs = input.maximumDelayMs ?? 30_000;

  while (!input.shouldStop?.()) {
    const current = await input.load();
    if (!current || current.projection_status === "parked") return "permanent_failure";
    if (current.projection_status === "delivered" && current.projected_revision >= current.desired_revision) {
      return "delivered";
    }
    if (current.projection_status === "sending") {
      await wait(50);
      continue;
    }
    const dueAt = current.projection_next_attempt_ms || 0;
    if (dueAt > now()) {
      await wait(dueAt - now());
      continue;
    }

    const claimed = await input.claim(now());
    if (!claimed) continue;
    try {
      if (claimed.slack_status_msg_ts) {
        await input.update(claimed);
      } else {
        const posted = await input.post(
          claimed,
          input.clientMessageId?.(claimed) || threadStatusClientMessageId(
            claimed.slack_channel_id,
            claimed.slack_thread_ts,
            claimed.message_generation,
          ),
        );
        if (!posted.ts) throw new Error("Slack did not return a timestamp for the thread status message.");
        await input.recordMessage(claimed, posted.ts);
      }
      await input.markDelivered(claimed);
    } catch (error) {
      const missingExistingMessage = Boolean(claimed.slack_status_msg_ts) && input.isMissingUpdateError(error);
      const missingDuplicate = !claimed.slack_status_msg_ts && input.isMissingDuplicateError(error);
      if (missingExistingMessage || missingDuplicate) {
        await input.replaceMissingMessage(claimed);
        continue;
      }
      if (!input.isRetryable(error)) {
        await input.markParked(claimed, String(error));
        return "permanent_failure";
      }
      const retryDelayMs = Math.min(
        initialDelayMs * (2 ** Math.max(0, claimed.projection_attempts - 1)),
        maximumDelayMs,
      );
      await input.markRetry(claimed, String(error), now() + retryDelayMs);
    }
  }
  return "stopped";
}
