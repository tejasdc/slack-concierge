import { SessionMode } from "./state";

export function persistentSessionThreadTs(channelId: string) {
  return `single-persistent:${channelId}`;
}

export function resolveMessageRouting(input: {
  replyThreadTs: string;
  sessionMode: SessionMode;
  anchorThreadTs?: string | null;
}) {
  return {
    replyThreadTs: input.replyThreadTs,
    sessionThreadTs: input.sessionMode === "single-persistent" && input.anchorThreadTs
      ? input.anchorThreadTs
      : input.replyThreadTs,
  };
}
