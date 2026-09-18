import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./log";

/**
 * A message Claude Code took into its conversation, read from its own transcript.
 *
 * Claude writes a submitted message into the transcript at the moment it picks the
 * message up — not when it arrives in its queue — either as a `user` row the owner
 * submitted (`promptSource: "sdk"`) or, when folded into work already under way, as a
 * `queued_command` attachment carrying the text and the submitted message's uuid. The
 * `--replay-user-messages` echo on stdout reaches the owner only with Claude's first
 * output, which can be a minute later, so this record is the receipt.
 */
export type ClaudeTranscriptPickup = { text: string; uuid: string | null };

const POLL_MS = 500;
const LOCATE_FOR_MS = 60_000;

function blockText(content: unknown): string | null {
  if (typeof content === "string") return content || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n");
  return text || null;
}

export function claudeTranscriptPickup(row: any): ClaudeTranscriptPickup | null {
  if (row?.isSidechain === true) return null;
  if (row?.type === "user" && row.promptSource === "sdk") {
    const text = blockText(row.message?.content);
    return text ? { text, uuid: typeof row.uuid === "string" ? row.uuid : null } : null;
  }
  const attachment = row?.type === "attachment" ? row.attachment : null;
  if (attachment?.type === "queued_command" && attachment.commandMode === "prompt") {
    const text = blockText(attachment.prompt);
    return text ? { text, uuid: typeof attachment.source_uuid === "string" ? attachment.source_uuid : null } : null;
  }
  return null;
}

async function locateTranscript(configDir: string, sessionUuid: string): Promise<string | null> {
  const projects = join(configDir, "projects");
  let directories: string[];
  try { directories = await readdir(projects); } catch { return null; }
  for (const directory of directories) {
    const candidate = join(projects, directory, `${sessionUuid}.jsonl`);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {}
  }
  return null;
}

/**
 * Follows one Claude session's transcript and reports each message Claude picks up.
 * `fromStart` reads a transcript this process is creating from its beginning; otherwise
 * reading starts where the transcript ends when watching begins, which the caller does
 * before Claude starts, so earlier turns' history is never reported. It only reads
 * Claude's own record: a missing or unreadable transcript reports nothing, and the stdout
 * echo remains the fallback receipt.
 */
export function watchClaudeTranscript(input: {
  sessionUuid: string;
  fromStart: boolean;
  environment?: Record<string, string>;
  onPickup: (pickup: ClaudeTranscriptPickup) => void;
}): () => void {
  const configDir = input.environment?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const locateUntil = Date.now() + LOCATE_FOR_MS;
  let path: string | null = null;
  let offset = 0;
  let partial = "";
  let stopped = false;
  let reading = false;
  let reportedFailure = false;

  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };

  const readNew = async () => {
    if (stopped || reading) return;
    reading = true;
    try {
      if (!path) {
        if (Date.now() > locateUntil) return stop();
        const found = await locateTranscript(configDir, input.sessionUuid);
        if (!found) return;
        path = found;
        offset = input.fromStart ? 0 : (await stat(found)).size;
      }
      const size = (await stat(path)).size;
      if (size <= offset) return;
      const handle = await open(path, "r");
      try {
        const buffer = Buffer.alloc(size - offset);
        await handle.read(buffer, 0, buffer.length, offset);
        offset = size;
        const lines = (partial + buffer.toString("utf8")).split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) {
          if (stopped || !line.trim()) continue;
          let row: unknown;
          try { row = JSON.parse(line); } catch { continue; }
          const pickup = claudeTranscriptPickup(row);
          if (pickup) input.onPickup(pickup);
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!reportedFailure) {
        reportedFailure = true;
        log("warn", "claude_transcript_watch_failed", {
          session_uuid: input.sessionUuid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      reading = false;
    }
  };

  const timer = setInterval(() => { void readNew(); }, POLL_MS);
  void readNew();
  return stop;
}
