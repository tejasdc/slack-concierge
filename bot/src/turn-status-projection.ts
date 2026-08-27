import { createHash } from "node:crypto";
import { scopeSlackIdempotencyKey } from "./slack-idempotency";

export function turnStatusClientMessageId(turnId: number, generation: number): string {
  const hex = createHash("sha256")
    .update(scopeSlackIdempotencyKey(`turn-status:${turnId}:${generation}`))
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export async function postThreadStatusThroughAnchor(input: {
  anchorTurnId: number | null | undefined;
  projectAnchorTurn(turnId: number): Promise<unknown>;
  loadStatusMessageTs(): string;
  updateAnchoredMessage(messageTs: string): Promise<void>;
  postNewMessage(): Promise<{ ts?: string }>;
}): Promise<{ ts?: string }> {
  if (input.anchorTurnId) {
    await input.projectAnchorTurn(input.anchorTurnId);
    const anchoredMessageTs = input.loadStatusMessageTs();
    if (anchoredMessageTs) {
      await input.updateAnchoredMessage(anchoredMessageTs);
      return { ts: anchoredMessageTs };
    }
  }
  return input.postNewMessage();
}
