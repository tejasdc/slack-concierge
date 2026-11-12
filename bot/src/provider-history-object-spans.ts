import { createHash } from "node:crypto";
import { createReadStream, closeSync, openSync, readSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

const MAX_REFERENCED_LINE_BYTES = 64 * 1024 * 1024;

export type RawMessageSpan = { offset: number; length: number; sha256: string };
export type RawMessageSpanIndex = {
  sourceSha256: string;
  sourceBytes: number;
  spansByOrdinal: Map<number, RawMessageSpan>;
};

export function readSdkMessageFromRawSpan(
  objectPath: string, metadata: Omit<SessionMessage, "message">, span: RawMessageSpan,
): SessionMessage {
  if (!Number.isSafeInteger(span.offset) || span.offset < 0
    || !Number.isSafeInteger(span.length) || span.length < 1 || span.length > MAX_REFERENCED_LINE_BYTES)
    throw new Error("INVALID_HISTORY_OBJECT_SPAN");
  const bytes = Buffer.alloc(span.length);
  const descriptor = openSync(objectPath, "r");
  try {
    for (let length = 0; length < bytes.length;) {
      const read = readSync(descriptor, bytes, length, bytes.length - length, span.offset + length);
      if (!read) throw new Error("HISTORY_OBJECT_SPAN_SHORT");
      length += read;
    }
  } finally { closeSync(descriptor); }
  if (createHash("sha256").update(bytes).digest("hex") !== span.sha256)
    throw new Error("HISTORY_OBJECT_SPAN_CHANGED");
  let raw: any;
  try { raw = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("HISTORY_OBJECT_SPAN_INVALID"); }
  if (raw?.uuid !== metadata.uuid || raw?.type !== metadata.type
    || raw?.sessionId !== metadata.session_id || !("message" in raw))
    throw new Error("HISTORY_OBJECT_SPAN_IDENTITY_CHANGED");
  return { ...metadata, message: raw.message };
}

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
  let lineStart = 0;
  let lineBytes = 0;
  let lineParts: Buffer[] = [];
  let oversized = false;
  let hadOversizedLine = false;
  const append = (part: Buffer) => {
    lineBytes += part.length;
    if (lineBytes > MAX_REFERENCED_LINE_BYTES) { oversized = true; hadOversizedLine = true; lineParts = []; }
    else if (!oversized && part.length) lineParts.push(part);
  };
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    digest.update(bytes);
    const chunkStart = position;
    position += bytes.length;
    let start = 0;
    for (let end = bytes.indexOf(10); end >= 0; start = end + 1, end = bytes.indexOf(10, start)) {
      append(bytes.subarray(start, end));
      if (lineBytes && !oversized) {
        const line = Buffer.concat(lineParts, lineBytes);
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
                offset: lineStart,
                length: line.length,
                sha256: createHash("sha256").update(line).digest("hex"),
              });
            }
          }
        }
      }
      lineStart = chunkStart + end + 1;
      lineBytes = 0;
      lineParts = [];
      oversized = false;
    }
    append(bytes.subarray(start));
  }
  // A trailing partial line is not a stable transcript row, even though it is
  // included in the complete-file digest used for custody comparison.
  // An unparsed oversized line might repeat a matched UUID. Keep all rows in
  // their full form rather than claiming a unique source line without proof.
  return { sourceSha256: digest.digest("hex"), sourceBytes: position,
    spansByOrdinal: hadOversizedLine ? new Map() : matches };
}
