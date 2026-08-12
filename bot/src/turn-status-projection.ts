import { createHash } from "node:crypto";

export function turnStatusClientMessageId(turnId: number, generation: number): string {
  const hex = createHash("sha256")
    .update(`turn-status:${turnId}:${generation}`)
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}
