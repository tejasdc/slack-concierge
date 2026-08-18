import { SessionMode } from "./state";

export function persistentSessionThreadTs(channelId: string) {
  return `single-persistent:${channelId}`;
}

export function effectiveSessionModeForMessage(input: {
  channelSessionMode: SessionMode;
  forceNewSession?: boolean;
  hasVisibleThreadSession: boolean;
}): SessionMode {
  if (input.forceNewSession || input.hasVisibleThreadSession) return "per-thread";
  return input.channelSessionMode;
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
