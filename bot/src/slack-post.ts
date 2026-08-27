import { splitSlackText } from "./text";
import { slackCall } from "./rate-limit";
import { createHash } from "node:crypto";
import { scopeSlackIdempotencyKey } from "./slack-idempotency";

function deterministicClientMessageId(key: string, chunkIndex: number): string {
  const hex = createHash("sha256")
    .update(`${scopeSlackIdempotencyKey(key)}:${chunkIndex}`)
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export async function postLongReply(input: {
  client: any;
  channel: string;
  threadTs: string;
  text: string;
  user?: string;
  idempotencyKey?: string;
  skipChunkIndexes?: Set<number>;
  onChunkPosted?: (index: number, ts: string | null) => void;
}) {
  const chunks = splitSlackText(input.text || "(no output)");
  const posted: string[] = [];
  for (const [idx, chunk] of chunks.entries()) {
    if (input.skipChunkIndexes?.has(idx)) continue;
    const result: any = await slackCall(
      input.client,
      "chat.postMessage",
      {
        channel: input.channel,
        thread_ts: input.threadTs,
        text: chunks.length > 1 ? `${chunk}\n\n(${idx + 1}/${chunks.length})` : chunk,
        ...(input.idempotencyKey ? { client_msg_id: deterministicClientMessageId(input.idempotencyKey, idx) } : {}),
      },
      { channel: input.channel, user: input.user },
    );
    if (result?.ts) posted.push(result.ts);
    input.onChunkPosted?.(idx, result?.ts || null);
  }
  return posted;
}
