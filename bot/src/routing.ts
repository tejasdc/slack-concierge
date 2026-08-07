import { SessionMode } from "./state";

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
