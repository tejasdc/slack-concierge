/**
 * JSON Lines read from a stream: one record per "\n", nothing else.
 *
 * Bun's node:readline also ends a line at U+2028 and U+2029, which JSON allows unescaped inside
 * strings. A record holding either arrived as broken pieces that every reader skipped as
 * unparsable. On 2026-10-21 that silently dropped every thread/resume answer for one Codex
 * conversation whose history held a paragraph separator, and the conversation refused all input
 * (docs/incidents/2026-10-21-codex-thread-resume-unanswered-on-shared-connection.md). The release
 * lint refuses node:readline under Bun; read JSON Lines through here.
 */
import type { Readable } from "node:stream";

export async function* jsonLines(input: Readable | NodeJS.ReadableStream): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of input as AsyncIterable<Uint8Array | string>) {
    pending += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let start = 0, newline: number;
    while ((newline = pending.indexOf("\n", start)) !== -1) {
      const line = pending.slice(start, newline);
      start = newline + 1;
      yield line.endsWith("\r") ? line.slice(0, -1) : line;
    }
    pending = pending.slice(start);
  }
  pending += decoder.decode();
  if (pending) yield pending.endsWith("\r") ? pending.slice(0, -1) : pending;
}

/** One JSON Lines record whose line breaks survive any reader: U+2028/U+2029 are escaped. */
export function jsonLine(value: unknown): string {
  return `${JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")}\n`;
}

/**
 * Calls onLine for each record as it arrives. A stream error ends reading, as it ended
 * readline's line events; the owner of the stream sees that error through its own listeners.
 */
export function onJsonLines(input: Readable | NodeJS.ReadableStream, onLine: (line: string) => void): void {
  void (async () => {
    for await (const line of jsonLines(input)) {
      // A throwing handler surfaces exactly as it did from a readline event, and reading goes on.
      try { onLine(line); } catch (error) { queueMicrotask(() => { throw error; }); }
    }
  })().catch(() => {});
}
