/** One-shot canonical Claude history import. Runs in a child process, never in the owner. */
import { getSessionMessages, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, open, rename, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claudeQueuedMessages, withQueuedMessages } from "./claude-queued-messages";
import { writeLogLine } from "./log";

function toolNames(rows: readonly any[]) {
  const names = new Map<string,string>();
  for (const row of rows) for (const part of Array.isArray(row?.message?.content) ? row.message.content : [])
    if (part?.type === "tool_use" && typeof part.id === "string" && typeof part.name === "string") names.set(part.id,part.name);
  return names;
}

async function transcriptTailUuid(path: string, size: number) {
  const handle = await open(path, "r");
  try {
    const length = Math.min(size, 8 * 1024 * 1024);
    const bytes = Buffer.alloc(length);
    const read = await handle.read(bytes, 0, length, size - length);
    const text = bytes.subarray(0,read.bytesRead).toString("utf8");
    const lines = text.slice(length < size ? text.indexOf("\n") + 1 : 0).split("\n");
    for (let index=lines.length-1;index>=0;index--) {
      try { const row = JSON.parse(lines[index]!); if (typeof row?.uuid === "string" && row.uuid) return row.uuid; }
      catch { /* A partial line is not a graph node. */ }
    }
    return null;
  } finally { await handle.close(); }
}

/** Byte offsets of every compaction boundary line, in transcript order. */
async function compactionOffsets(path: string, size: number) {
  const offsets: number[] = [];
  const handle = await open(path, "r");
  try {
    let offset = 0, carry = Buffer.alloc(0);
    while (offset < size) {
      const chunk = Buffer.alloc(Math.min(4 * 1024 * 1024, size - offset));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      if (!bytesRead) break;
      const bytes = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      const base = offset - carry.length;
      offset += bytesRead;
      let start = 0;
      for (let end = bytes.indexOf(10); end >= 0; start = end + 1, end = bytes.indexOf(10, start)) {
        const line = bytes.subarray(start, end);
        if (line.includes('"compact_boundary"')) {
          try { if (JSON.parse(line.toString("utf8"))?.subtype === "compact_boundary") offsets.push(base + start); }
          catch { /* A line that does not parse is not a boundary. */ }
        }
      }
      carry = bytes.subarray(start);
    }
  } finally { await handle.close(); }
  return offsets;
}

/**
 * Claude Code's reader lists only what follows a conversation's latest compaction, so every
 * compaction removed the whole earlier conversation from the session window, and requests
 * from before it were drawn at the bottom (report 60b1809c, 2026-10-29). The same native
 * reader, run on the transcript as it stood just before each boundary, returns each earlier
 * part under Claude Code's own rules; Concierge still never interprets the graph itself.
 */
async function compactedSegments(sessionUuid: string, cwd: string, sourcePath: string, size: number) {
  const offsets = (await compactionOffsets(sourcePath, size)).filter(offset => offset > 0);
  if (!offsets.length) return [];
  const root = await mkdtemp(join(tmpdir(), "claude-history-segment-"));
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  try {
    const projectDir = join(root, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(projectDir, { recursive: true, mode: 0o700 });
    const segmentPath = join(projectDir, `${sessionUuid}.jsonl`);
    const rows: SessionMessage[] = [];
    process.env.CLAUDE_CONFIG_DIR = root;
    for (const end of offsets) {
      await copyPrefix(sourcePath, segmentPath, end);
      rows.push(...await getSessionMessages(sessionUuid, { dir: cwd }));
    }
    return rows;
  } finally {
    if (configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = configDir;
    await rm(root, { recursive: true, force: true });
  }
}

async function copyPrefix(source: string, destination: string, length: number) {
  const input = await open(source, "r"), output = await open(destination, "w", 0o600);
  try {
    for (let offset = 0; offset < length;) {
      const bytes = Buffer.alloc(Math.min(4 * 1024 * 1024, length - offset));
      const { bytesRead } = await input.read(bytes, 0, bytes.length, offset);
      if (!bytesRead) throw new Error("HISTORY_SEGMENT_SHORT");
      await output.write(bytes, 0, bytesRead);
      offset += bytesRead;
    }
  } finally { await input.close(); await output.close(); }
}

async function main() {
  const [sessionUuid, cwd, sourcePath, destination, cutoffText] = process.argv.slice(2);
  if (!sessionUuid || !/^[a-f0-9-]{36}$/i.test(sessionUuid) || !cwd || !sourcePath || !destination) throw new Error("INVALID_HISTORY_IMPORT");
  const eventCutoff = Number(cutoffText || 0);
  if (!Number.isSafeInteger(eventCutoff) || eventCutoff < 0) throw new Error("INVALID_HISTORY_CUTOFF");
  const before = await stat(sourcePath);
  const listed = [...await compactedSegments(sessionUuid, cwd, sourcePath, before.size), ...await getSessionMessages(sessionUuid, {})];
  const seen = new Set<string>();
  const unique = listed.filter(row => !seen.has(row.uuid) && !!seen.add(row.uuid));
  const queued = await claudeQueuedMessages(sessionUuid, cwd);
  const rows = withQueuedMessages(unique, queued, sessionUuid);
  const names = toolNames(rows);
  const after = await stat(sourcePath);
  const tailUuid = await transcriptTailUuid(sourcePath, before.size);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = destination + ".next.sqlite";
  await unlink(temporary).catch(error => { if (error?.code !== "ENOENT") throw error; });
  const db = new Database(temporary, { create: true, strict: true });
  try {
    db.exec(`PRAGMA journal_mode=DELETE; CREATE TABLE meta (
      session_uuid TEXT NOT NULL,cwd TEXT NOT NULL,source_path TEXT NOT NULL,
      source_size INTEGER NOT NULL,source_mtime_ms REAL NOT NULL,
      row_count INTEGER NOT NULL,generation TEXT NOT NULL,event_cutoff INTEGER NOT NULL,
      tail_uuid TEXT,verified_source_size INTEGER NOT NULL,
      verified_source_mtime_ms REAL NOT NULL,verified_tail_uuid TEXT,needs_reimport INTEGER NOT NULL DEFAULT 0
    ); CREATE TABLE rows (ordinal INTEGER PRIMARY KEY,uuid TEXT NOT NULL,json TEXT NOT NULL);
    CREATE INDEX rows_uuid ON rows(uuid);
    CREATE TABLE message_ids (id TEXT PRIMARY KEY,ordinal INTEGER NOT NULL);
    CREATE TABLE tool_names (tool_id TEXT PRIMARY KEY,name TEXT NOT NULL);`);
    const generation = `${Date.now()}-${process.pid}`;
    const insertRow = db.query("INSERT INTO rows(ordinal,uuid,json) VALUES(?,?,?)");
    const insertTool = db.query("INSERT INTO tool_names(tool_id,name) VALUES(?,?)");
    const insertMessageId = db.query("INSERT OR IGNORE INTO message_ids(id,ordinal) VALUES(?,?)");
    db.transaction(() => {
      db.query("INSERT INTO meta VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(sessionUuid,cwd,sourcePath,
        before.size,before.mtimeMs,rows.length,generation,eventCutoff,tailUuid,
        before.size,before.mtimeMs,tailUuid,0);
      for (let index = 0; index < rows.length; index++) {
        const row: any = rows[index]!;
        insertRow.run(index,row.uuid,JSON.stringify(row));
        if (row.type !== "user" && row.type !== "assistant") continue;
        insertMessageId.run(row.uuid,index);
        for (const part of Array.isArray(row.message?.content) ? row.message.content : []) {
          if (part?.type === "tool_use" && typeof part.id === "string") insertMessageId.run(part.id,index);
          if (part?.type === "tool_result" && typeof part.tool_use_id === "string") insertMessageId.run(`${part.tool_use_id}:result`,index);
        }
      }
      for (const [id,name] of names) insertTool.run(id,name);
    })();
    db.exec("PRAGMA optimize");
    writeLogLine("info", JSON.stringify({ generation, rows: rows.length, changedDuringImport: before.size !== after.size || before.mtimeMs !== after.mtimeMs }));
  } finally { db.close(); }
  await rename(temporary,destination);
}

main().catch(error => { writeLogLine("error", error instanceof Error ? error.message : "HISTORY_IMPORT_FAILED"); process.exitCode = 1; });
