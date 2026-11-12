import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

export type RawMessageSpan = { offset: number; length: number; sha256: string };
export type RawMessageSpanIndex = {
  sourceSha256: string;
  sourceBytes: number;
  spansByOrdinal: Map<number, RawMessageSpan>;
};

/**
 * Find SDK rows whose message payload is exactly recoverable from one raw line.
 * The caller still has to prove custody of this complete source version before
 * replacing any stored payload. Duplicate UUIDs and incomplete lines stay full rows.
 */
export async function matchingRawMessageSpans(
  path: string, rows: readonly SessionMessage[],
): Promise<RawMessageSpanIndex> {
  const requested = new Map<string, number>();
  const ambiguous = new Set<string>();
  for (let ordinal = 0; ordinal < rows.length; ordinal++) {
    const uuid = rows[ordinal]?.uuid;
    if (!uuid) continue;
    if (requested.has(uuid)) ambiguous.add(uuid);
    else requested.set(uuid, ordinal);
  }
  const seen = new Set<string>();
  const matches = new Map<number, RawMessageSpan>();
  const digest = createHash("sha256");
  let position = 0;
  let carry = Buffer.alloc(0);
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    digest.update(bytes);
    const combined = carry.length ? Buffer.concat([carry, bytes]) : bytes;
    const base = position - carry.length;
    position += bytes.length;
    let start = 0;
    for (let end = combined.indexOf(10); end >= 0; start = end + 1, end = combined.indexOf(10, start)) {
      const line = combined.subarray(start, end);
      if (line.length) {
        let raw: any;
        try { raw = JSON.parse(line.toString("utf8")); } catch { raw = null; }
        const uuid = raw?.uuid;
        const ordinal = typeof uuid === "string" ? requested.get(uuid) : undefined;
        if (ordinal !== undefined && !ambiguous.has(uuid)) {
          if (seen.has(uuid)) { ambiguous.add(uuid); matches.delete(ordinal); }
          else {
            seen.add(uuid);
            const sdk = rows[ordinal]!;
            if (raw.type === sdk.type && raw.sessionId === sdk.session_id
              && isDeepStrictEqual(raw.message, sdk.message)) {
              matches.set(ordinal, {
                offset: base + start,
                length: line.length,
                sha256: createHash("sha256").update(line).digest("hex"),
              });
            }
          }
        }
      }
    }
    carry = combined.subarray(start);
  }
  // A trailing partial line is not a stable transcript row, even though it is
  // included in the complete-file digest used for custody comparison.
  return { sourceSha256: digest.digest("hex"), sourceBytes: position, spansByOrdinal: matches };
}
