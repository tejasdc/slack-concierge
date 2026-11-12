import { createHash } from "node:crypto";
import { createReadStream, closeSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

const MAX_REFERENCED_LINE_BYTES = 64 * 1024 * 1024;
const HOST_OBJECT_ROOT = "/root/transcript-objects";
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const PLAN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export type RawMessageSpan = { offset: number; length: number; sha256: string };
export type RawMessageSpanIndex = {
  sourceSha256: string;
  sourceBytes: number;
  spansByOrdinal: Map<number, RawMessageSpan>;
};

export type RawLineScan = { sourceSha256: string; sourceBytes: number; oversizedLine: boolean };

type HostObjectProof = {
  schema: number; sha256: string; bytes: number; snapshot: string;
  verifiedAt: string; plan: string; planDigest: string;
};

/** An absent or invalid proof leaves the row in its existing full SDK form. */
export async function provenHostTranscriptObject(
  sha256: string, bytes: number, root = HOST_OBJECT_ROOT,
): Promise<string | null> {
  if (!HEX_SHA256.test(sha256) || !Number.isSafeInteger(bytes) || bytes < 0) return null;
  const readJson = (path: string): any => {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("INVALID_HISTORY_OBJECT_PROOF");
    return JSON.parse(readFileSync(path, "utf8"));
  };
  try {
    const finder = readJson(join(root, "proofs", "by-object", `${sha256}.json`)) as HostObjectProof;
    if (finder?.schema !== 1 || finder.sha256 !== sha256 || finder.bytes !== bytes
      || !HEX_SHA256.test(finder.planDigest) || !HEX_SHA256.test(finder.snapshot)
      || !PLAN_ID.test(finder.plan) || typeof finder.verifiedAt !== "string") return null;
    const planPath = join(root, "plans", `${finder.plan}.json`);
    const planInfo = lstatSync(planPath);
    if (!planInfo.isFile() || planInfo.isSymbolicLink()) return null;
    const planBytes = readFileSync(planPath);
    if (createHash("sha256").update(planBytes).digest("hex") !== finder.planDigest) return null;
    const plan = JSON.parse(planBytes.toString("utf8"));
    const proof = readJson(join(root, "proofs", `${finder.plan}.json`));
    const backup = readJson(join(root, "backups", `${finder.plan}.json`));
    if (plan?.schema !== 1 || plan.id !== finder.plan || !Array.isArray(plan.files)
      || !plan.files.some((file: any) => file?.digest === sha256 && file?.size === bytes)
      || proof?.schema !== 1 || proof.plan !== finder.plan || proof.planDigest !== finder.planDigest
      || proof.snapshot !== finder.snapshot || !Array.isArray(proof.objects)
      || !proof.objects.includes(sha256) || backup?.schema !== 1
      || backup.planDigest !== finder.planDigest || backup.snapshot !== finder.snapshot) return null;
    const objectPath = join(root, "sha256", sha256.slice(0, 2), sha256);
    const info = lstatSync(objectPath);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o444
      || info.size !== bytes) return null;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(objectPath, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
    if (hash.digest("hex") !== sha256) return null;
    const after = lstatSync(objectPath);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== info.dev || after.ino !== info.ino
      || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs
      || (after.mode & 0o777) !== 0o444) return null;
    return objectPath;
  } catch { return null; }
}

/** A bounded byte scan; callers may index rows in SQLite instead of retaining them in memory. */
export async function scanRawMessageLines(
  path: string, onLine: (line: Buffer, span: RawMessageSpan) => void,
): Promise<RawLineScan> {
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
        onLine(line, { offset: lineStart, length: line.length,
          sha256: createHash("sha256").update(line).digest("hex") });
      }
      lineStart = chunkStart + end + 1;
      lineBytes = 0;
      lineParts = [];
      oversized = false;
    }
    append(bytes.subarray(start));
  }
  // Incomplete trailing bytes contribute to the source digest, but are never rows.
  return { sourceSha256: digest.digest("hex"), sourceBytes: position, oversizedLine: hadOversizedLine };
}

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
 * Call only on a host-published immutable object, then compare sourceSha256 and
 * sourceBytes with that object's verified receipt before replacing any payload.
 * Duplicate UUIDs and incomplete lines stay full rows.
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
  const scan = await scanRawMessageLines(path, (line, span) => {
    let raw: any;
    try { raw = JSON.parse(line.toString("utf8")); } catch { raw = null; }
    const uuid = raw?.uuid;
    const ordinal = typeof uuid === "string" ? requested.get(uuid) : undefined;
    if (ordinal === undefined || ambiguous.has(uuid)) return;
    if (seen.has(uuid)) { ambiguous.add(uuid); matches.delete(ordinal); return; }
    seen.add(uuid);
    const sdk = rows[ordinal]!;
    if (raw.type === sdk.type && raw.sessionId === sdk.session_id
      && isDeepStrictEqual(raw.message, sdk.message)) matches.set(ordinal, span);
  });
  // An unparsed oversized line might repeat a matched UUID. Keep all rows in
  // their full form rather than claiming a unique source line without proof.
  return { sourceSha256: scan.sourceSha256, sourceBytes: scan.sourceBytes,
    spansByOrdinal: scan.oversizedLine ? new Map() : matches };
}
