import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeConfigDir, locateClaudeTranscript } from "./claude-transcript-watch";
import { log } from "./log";

/**
 * Messages Claude Code took while a tool was still running, read from its own transcript
 * so history lists them where they were read.
 *
 * Claude Code writes such a message as an `attachment` row (`attachment.type:
 * "queued_command"`, `commandMode: "prompt"`) and shows it to the model inside a system
 * reminder, never as a `user` row (Claude Code 2.1.283; anthropics/claude-code#86980,
 * closed as not planned). The SDK's `getSessionMessages` returns only user, assistant and
 * system rows, so those messages were absent from every history page while the owner's
 * live stream had already announced them; thnkr.ing then re-appended the live copy after
 * his newest message on every refresh, reading "read after 12:50 PM" for a request the
 * agent had answered at 12:37 (Tejas, 2026-09-28, reported twice). The row carries the
 * exact bytes the owner sent and `source_uuid`, the uuid the owner submitted the message
 * under, which is the id the live stream echoed, so the listed row and the live copy are
 * one message.
 *
 * The transcript is append-only, so each file is scanned once from the byte it was last
 * read to; a shrunken file is scanned again from the start.
 */
export type ClaudeQueuedMessage = {
  /** The nearest earlier user or assistant row, after which this message was read. */
  anchor: string | null;
  row: SessionMessage;
};

type Scan = { path: string; offset: number; partial: string; recent: string[]; messages: ClaudeQueuedMessage[] };
const scans = new Map<string, Scan>();
const RECENT_LINES = 32;
const CHUNK = 8 * 1024 * 1024;

function record(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function conversationRow(line: string): Record<string, any> | null {
  let row: Record<string, any> | null;
  try { row = record(JSON.parse(line)); } catch { return null; }
  if (!row || (row.type !== "user" && row.type !== "assistant") || typeof row.uuid !== "string") return null;
  if (row.isSidechain === true || row.isMeta === true) return null;
  return row;
}

function queuedMessage(row: Record<string, any>, sessionUuid: string, recent: readonly string[]): ClaudeQueuedMessage | null {
  const attachment = record(row.attachment);
  if (row.type !== "attachment" || attachment?.type !== "queued_command" || attachment.commandMode !== "prompt") return null;
  if (row.isSidechain === true || !Array.isArray(attachment.prompt) || !attachment.prompt.length) return null;
  const uuid = typeof attachment.source_uuid === "string" && attachment.source_uuid ? attachment.source_uuid
    : typeof row.uuid === "string" ? row.uuid : null;
  if (!uuid) return null;
  let anchor: string | null = null;
  for (let index = recent.length - 1; index >= 0 && anchor === null; index--) anchor = conversationRow(recent[index]!)?.uuid ?? null;
  const timestamp = typeof row.timestamp === "string" ? row.timestamp : typeof attachment.timestamp === "string" ? attachment.timestamp : undefined;
  const message: SessionMessage & Record<string, unknown> = {
    type: "user", uuid, session_id: sessionUuid, parent_tool_use_id: null, parent_agent_id: null,
    message: { role: "user", content: attachment.prompt },
    ...(timestamp ? { timestamp } : {}), ...(typeof row.entrypoint === "string" ? { entrypoint: row.entrypoint } : {}),
    queuedCommand: true,
  };
  return { anchor, row: message };
}

async function transcriptPath(sessionUuid: string, cwd: string): Promise<string | null> {
  const configDir = claudeConfigDir();
  const slugged = join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionUuid}.jsonl`);
  try { if ((await stat(slugged)).isFile()) return slugged; } catch {}
  return locateClaudeTranscript(configDir, sessionUuid);
}

/** Every queued message in one Claude transcript, in transcript order, each with the row it follows. */
export async function claudeQueuedMessages(sessionUuid: string, cwd: string): Promise<ClaudeQueuedMessage[]> {
  let scan = scans.get(sessionUuid);
  if (!scan) {
    const path = await transcriptPath(sessionUuid, cwd);
    if (!path) return [];
    scan = { path, offset: 0, partial: "", recent: [], messages: [] };
    scans.set(sessionUuid, scan);
  }
  try {
    const size = (await stat(scan.path)).size;
    if (size < scan.offset) Object.assign(scan, { offset: 0, partial: "", recent: [], messages: [] });
    if (size === scan.offset) return scan.messages;
    const handle = await open(scan.path, "r");
    try {
      while (scan.offset < size) {
        const buffer = Buffer.alloc(Math.min(CHUNK, size - scan.offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, scan.offset);
        if (!bytesRead) break;
        scan.offset += bytesRead;
        const lines = (scan.partial + buffer.subarray(0, bytesRead).toString("utf8")).split("\n");
        scan.partial = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          if (line.includes('"queued_command"')) {
            let row: Record<string, any> | null = null;
            try { row = record(JSON.parse(line)); } catch {}
            const message = row && queuedMessage(row, sessionUuid, scan.recent);
            if (message) scan.messages.push(message);
          }
          scan.recent.push(line);
          if (scan.recent.length > RECENT_LINES) scan.recent.shift();
        }
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    log("warn", "claude_queued_messages_unread", { session_uuid: sessionUuid, error: error instanceof Error ? error.message : String(error) });
  }
  return scan.messages;
}

/** The SDK's listed rows with each queued message placed after the row it followed in the transcript. */
export function withQueuedMessages(listed: readonly SessionMessage[], queued: readonly ClaudeQueuedMessage[], sessionUuid: string): SessionMessage[] {
  if (!queued.length) return [...listed];
  const listedUuids = new Set(listed.map(row => row.uuid));
  const after = new Map<string, SessionMessage[]>();
  let unplaced = 0;
  for (const message of queued) {
    if (listedUuids.has(message.row.uuid)) continue;
    if (message.anchor === null || !listedUuids.has(message.anchor)) { unplaced++; continue; }
    const rows = after.get(message.anchor) ?? [];
    rows.push(message.row);
    after.set(message.anchor, rows);
  }
  if (unplaced) log("warn", "claude_queued_messages_unplaced", { session_uuid: sessionUuid, count: unplaced });
  const rows: SessionMessage[] = [];
  for (const row of listed) {
    rows.push(row);
    const following = after.get(row.uuid);
    if (following) rows.push(...following);
  }
  return rows;
}
