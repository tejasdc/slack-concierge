import { forkSession, getSessionMessages, type GetSessionMessagesOptions, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { claudeQueuedMessages, withQueuedMessages } from "./claude-queued-messages";
import { claudeConfigDir, locateClaudeTranscript } from "./claude-transcript-watch";
import { log } from "./log";
import { db as ownerDb } from "./state";
import type { RunResult } from "./codex";
import { sharedCodexAppServerClient } from "./codex-app-server-client";
import { assertProviderForkPolicy, type ProviderInteractionPolicy } from "./provider-policy";
import { codexTranscriptTimestamps } from './provider-transcript-metadata';
import { LEGACY_STRUCTURED_OUTPUT_TOOL, legacyStructuredOutputMessage, splitTurnOutcomeMarker } from './turn-outcome-marker';

export type MessageAuthor = {
  kind: 'human'|'agent'|'service'|'unknown';
  outsideAgent?: {name:string;label:string};
  session?: {id:string;title:string;provider:'codex'|'claude-code'|'chatgpt'};
  inputId?:string; runId?:string; requestId?:string;
  /** `notice`: the service wrote it itself with no agent behind it (a retry that gave up, a failed update). */
  communication?:'request'|'reply'|'result'|'overdue'|'post'|'notice'; replyKind?:'partial'|'final';
  /** Whether a delegated request may change anything, resolved across its whole chain. */
  effectScope?:'informational'|'work';
  /** The human request this ultimately acts for, which can differ from the immediate sender. */
  originatingHuman?:{session?:{id:string;title:string;provider:'codex'|'claude-code'|'chatgpt'};inputId:string;runId:string;captureId?:string};
  /** Which way his own message came in: "iPhone Action Button", "Mac quick capture", "web". */
  via?:string;
  /** This was recorded as Tejas's words but an agent posted it; the record says why. */
  correction?:{reason:string;at:string};
  /** He saved another author's message: the act is his, the words are theirs. */
  quoted?:{kind:'agent'|'human'|'unknown';session?:{id:string;title:string;provider:'codex'|'claude-code'|'chatgpt'}};
};

export interface ProviderHistoryMessage {
  id: string;
  author?: MessageAuthor;
  role: "user" | "assistant" | "tool";
  content: string;
  tool: string | null;
  phase: string | null;
  turnId?: string;
  timing?: {startedAt:string|null;endedAt:string|null;workStartedAt:string|null;running:boolean;workMs:number|null};
  createdAt?: string;
  timestampSource?: "provider" | "received" | "submitted";
  model?: string;
  modelSource?: "provider" | "run";
  requestedModel?: string;
  reasoningEffort?: string;
  reasoningEffortSource?: "provider" | "requested";
  submissionId?: string;
  /** Owner-projected: the accepted input this message belongs to, for any role. */
  inputId?: string;
  /** The exact message a deliberate thread post answers. */
  replyToMessage?: { kind: "message"; sessionId: string; messageId: string };
  toolCallId?: string;
  detailKey?: string;
  attachments?: Array<{ id: string; name: string; contentType: string }>;
  richContent?: unknown;
  marks?: {reactions:string[];saved:boolean};
}

export type ProviderMessageCallback = (message: ProviderHistoryMessage) => void;

export function providerMessageObserver(callback?: ProviderMessageCallback) {
  const versions = new Map<string, string>();
  return (messages: ProviderHistoryMessage[]) => {
    if (!callback) return;
    for (const message of messages) {
      const key = JSON.stringify([message.turnId, message.id]);
      const version = JSON.stringify(message);
      if (versions.get(key) === version) continue;
      callback(message);
      versions.set(key, version);
    }
  };
}

export interface ProviderHistoryInput {
  sessionUuid: string;
  cwd: string;
  cursor: string | null;
  limit: number;
  ownerSessionId?: number;
}

export interface ProviderHistoryPage {
  messages: ProviderHistoryMessage[];
  nextCursor: string | null;
  coverage?: { complete: boolean; omissions: string[]; code?: "history_indexing" | "history_import_failed"; retryAfterMs?: number };
}

export interface ProviderDetailInput {
  sessionUuid: string;
  cwd: string;
  detailKey: string;
  ownerSessionId?: number;
}

function record(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function encode(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ version: 1, ...value })).toString("base64url");
}

function decode(value: string, sessionUuid: string): Record<string, any> {
  let location: Record<string, any> | null = null;
  try { location = record(JSON.parse(Buffer.from(value, "base64url").toString("utf8"))); } catch {}
  if (!location || location.version !== 1 || location.sessionUuid !== sessionUuid) {
    throw new Error("INVALID_HISTORY_REFERENCE");
  }
  return location;
}

function validatePageInput(input: ProviderHistoryInput) {
  if (!input.sessionUuid || !Number.isSafeInteger(input.limit) || input.limit < 1) throw new Error("INVALID_HISTORY_REQUEST");
}

type CodexHistoryRequest = (method: string, params: Record<string, unknown>) => Promise<any>;

const nativeCodexRequest:CodexHistoryRequest=(method,params)=>sharedCodexAppServerClient().request(method,params);
function codexRequest(): CodexHistoryRequest { return nativeCodexRequest; }

function codexPage(response: unknown): { data: any[]; nextCursor: string | null } {
  const page = record(response);
  if (!page || !Array.isArray(page.data) || (page.nextCursor !== null && typeof page.nextCursor !== "string")) {
    throw new Error("PROVIDER_HISTORY_INVALID");
  }
  return { data: page.data, nextCursor: page.nextCursor };
}

export function codexHistoryMessages(value: unknown, turnId: string, sessionUuid: string,
  omissions = new Set<string>()): ProviderHistoryMessage[] {
  const item = record(value);
  if (!item || typeof item.id !== "string" || !item.id || typeof item.type !== "string"
    || !turnId || !sessionUuid) throw new Error("PROVIDER_HISTORY_INVALID");
  if (item.type === "reasoning" || item.type === "hookPrompt") return [];
  const identity = { id: item.id, turnId };
  if (item.type === "userMessage") {
    if (!Array.isArray(item.content)) throw new Error("PROVIDER_HISTORY_INVALID");
    if (item.content.some((part: any) => part?.type === "text" && typeof part.text !== "string")) throw new Error("PROVIDER_HISTORY_INVALID");
    if (item.content.some((part: any) => part?.type !== "text")) omissions.add("Non-text Codex input content is not available through this history adapter.");
    return [{ ...identity, role: "user", content: item.content.filter((part: any) => part?.type === "text")
      .map((part: any) => part.text).join("\n"), tool: null, phase: null,
      ...(typeof item.clientId === "string" ? { submissionId: item.clientId } : {}) }];
  }
  if (item.type === "agentMessage") {
    if (typeof item.text !== "string") throw new Error("PROVIDER_HISTORY_INVALID");
    // The outcome marker ending a final answer is bookkeeping, not something anyone reads.
    // An answer that was only the marker leaves nothing behind, and a turn that said
    // nothing of its own has no message rather than an empty one.
    const content = splitTurnOutcomeMarker(item.text).text;
    return content ? [{ ...identity, role: "assistant", content, tool: null,
      phase: typeof item.phase === "string" ? item.phase : null }] : [];
  }
  return [{ ...identity, role: "tool", content: JSON.stringify(item),
    tool: typeof item.tool === "string" ? item.tool : typeof item.name === "string" ? item.name : item.type,
    phase: typeof item.status === "string" ? item.status : null,
    detailKey: encode({ sessionUuid, turnId, id: item.id }) }];
}

export async function readCodexHistory(input: ProviderHistoryInput,
  request: CodexHistoryRequest = codexRequest()): Promise<ProviderHistoryPage> {
  validatePageInput(input);
  const cursor = input.cursor === null ? null : decode(input.cursor, input.sessionUuid).cursor;
  if (cursor !== null && typeof cursor !== "string") throw new Error("INVALID_HISTORY_REFERENCE");
  const page = codexPage(await request("thread/items/list", {
    threadId: input.sessionUuid, cursor, limit: input.limit, sortDirection: "desc",
  }));
  if (page.nextCursor !== null && page.nextCursor === cursor) throw new Error("PROVIDER_HISTORY_INVALID");
  const messages: ProviderHistoryMessage[] = [];
  const omissions = new Set<string>();
  for (const entry of page.data.slice().reverse()) {
    if (typeof entry?.turnId !== "string") throw new Error("PROVIDER_HISTORY_INVALID");
    messages.push(...codexHistoryMessages(entry.item, entry.turnId, input.sessionUuid, omissions));
  }
  const timestamps = await codexTranscriptTimestamps(input.sessionUuid, request);
  for (const message of messages) {
    const timestamp = timestamps.get(JSON.stringify([message.turnId,message.id]));
    if (timestamp) { message.createdAt=timestamp; message.timestampSource='provider'; }
  }
  return { messages, nextCursor: page.nextCursor === null ? null : encode({ sessionUuid: input.sessionUuid, cursor: page.nextCursor }),
    ...(omissions.size ? { coverage: { complete: false, omissions: [...omissions] } } : {}) };
}

export async function readCodexHistoryDetail(input: ProviderDetailInput,
  request: CodexHistoryRequest = codexRequest()): Promise<{ content: string }> {
  const location = decode(input.detailKey, input.sessionUuid);
  if (typeof location.turnId !== "string" || !location.turnId || typeof location.id !== "string" || !location.id) {
    throw new Error("INVALID_HISTORY_REFERENCE");
  }
  let cursor: string | null = null;
  do {
    const page = codexPage(await request("thread/items/list", {
      threadId: input.sessionUuid, turnId: location.turnId, cursor, limit: 100, sortDirection: "desc",
    }));
    const entry = page.data.find(entry => entry?.turnId === location.turnId && entry?.item?.id === location.id);
    if (entry && !["reasoning", "hookPrompt", "userMessage", "agentMessage"].includes(entry.item.type)) {
      return { content: JSON.stringify(entry.item) };
    }
    if (page.nextCursor !== null && page.nextCursor === cursor) throw new Error("PROVIDER_HISTORY_INVALID");
    cursor = page.nextCursor;
  } while (cursor !== null);
  throw new Error("PROVIDER_HISTORY_ITEM_NOT_FOUND");
}

type ClaudeCacheMeta = { session_uuid: string; cwd: string; source_path: string; source_size: number;
  source_mtime_ms: number; row_count: number; generation: string; event_cutoff: number; tail_uuid: string | null };
const queuedImports = new Map<string, Promise<void>>();
const activeImportChildren = new Set<ReturnType<typeof Bun.spawn>>();
const pendingRefresh = new Map<string, ReturnType<typeof setTimeout>>();
const observedVersions = new Map<string, string>();
const retryImportAt = new Map<string, number>();
const verifiedAppends = new Map<string,{generation:string;sourceSize:number;sourceMtimeMs:number;tailUuid:string|null}>();
let importLane = Promise.resolve();
process.on("exit", () => { for (const child of activeImportChildren) child.kill();
  for (const timer of pendingRefresh.values()) clearTimeout(timer); });

function cachePath(sessionUuid: string) {
  if (!/^[a-f0-9-]{36}$/i.test(sessionUuid)) throw new Error("INVALID_HISTORY_REQUEST");
  return join(process.env.CONCIERGE_STATE_DIR || join(homedir(), ".local", "state", "concierge"),
    "provider-history-cache", `${sessionUuid}.sqlite`);
}

function openCache(sessionUuid: string): { db: Database; meta: ClaudeCacheMeta } | null {
  const path = cachePath(sessionUuid);
  if (!existsSync(path)) return null;
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true, strict: true });
    const meta = db.query("SELECT * FROM meta").get() as ClaudeCacheMeta | null;
    if (!meta || meta.session_uuid !== sessionUuid) throw new Error("INVALID_HISTORY_CACHE");
    return { db, meta };
  } catch (error) {
    db?.close();
    log("warn", "provider_history_cache_unreadable", { session_uuid: sessionUuid,
      reason: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}

async function sourceVersion(sessionUuid: string, cwd: string) {
  const config = claudeConfigDir();
  const local = join(config, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionUuid}.jsonl`);
  let path = local;
  try { await stat(local); } catch { path = await locateClaudeTranscript(config, sessionUuid) || ""; }
  if (!path) return null;
  try { const file = await stat(path); return { path, size: file.size, mtimeMs: file.mtimeMs }; }
  catch { return null; }
}

function historyWorkerPath() {
  const adjacent = join(dirname(process.argv[1] || ""), "provider-history-worker.js");
  if (existsSync(adjacent)) return adjacent;
  const source = join(import.meta.dir, "provider-history-worker.ts");
  if (existsSync(source)) return source;
  throw new Error("HISTORY_WORKER_UNAVAILABLE");
}

function queueCanonicalImport(sessionUuid: string, cwd: string, sourcePath: string, ownerSessionId?: number) {
  if (queuedImports.has(sessionUuid) || Date.now() < (retryImportAt.get(sessionUuid) || 0)) return;
  let succeeded = false;
  const work = importLane.then(async () => {
    const cutoff = ownerSessionId ? (ownerDb.query("SELECT MAX(sequence) AS n FROM session_owner_events WHERE session_id=?")
      .get(ownerSessionId) as { n: number | null }).n || 0 : 0;
    const worker = historyWorkerPath();
    const command = process.platform === "linux"
      ? ["setpriv", "--pdeathsig", "KILL", process.execPath, "run", worker, sessionUuid, cwd, sourcePath, cachePath(sessionUuid), String(cutoff)]
      : [process.execPath, "run", worker, sessionUuid, cwd, sourcePath, cachePath(sessionUuid), String(cutoff)];
    const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore",
      env: { HOME: process.env.HOME || homedir(),
        ...(process.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR } : {}) } });
    activeImportChildren.add(child);
    const timeout = setTimeout(() => child.kill(), 120_000);
    try {
      const code = await child.exited;
      succeeded = code === 0;
      log(code === 0 ? "info" : "warn", code === 0 ? "provider_history_imported" : "provider_history_import_failed",
        { session_uuid: sessionUuid, exit_code: code });
    } finally { clearTimeout(timeout); activeImportChildren.delete(child); }
  }).catch(error => log("warn", "provider_history_import_failed", {
    session_uuid: sessionUuid, reason: error instanceof Error ? error.name : "unknown" }));
  queuedImports.set(sessionUuid, work);
  importLane = work.then(() => {});
  void work.finally(async () => {
    queuedImports.delete(sessionUuid);
    if (!succeeded) { retryImportAt.set(sessionUuid, Date.now() + 30_000); return; }
    retryImportAt.delete(sessionUuid);
    // A later read decides whether any source change lacks a retained owner event.
    // Rebuilding merely because a live provider appended bytes would replay the
    // entire transcript on every turn.
  });
}

function scheduleQuietRefresh(sessionUuid: string, cwd: string, source: {path:string;size:number;mtimeMs:number}, ownerSessionId?: number) {
  const version = `${source.path}:${source.size}:${source.mtimeMs}`;
  if (observedVersions.get(sessionUuid) === version && pendingRefresh.has(sessionUuid)) return;
  observedVersions.set(sessionUuid, version);
  const old = pendingRefresh.get(sessionUuid);
  if (old) clearTimeout(old);
  const timer = setTimeout(async () => {
    pendingRefresh.delete(sessionUuid);
    const current = await sourceVersion(sessionUuid, cwd);
    if (!current) return;
    if (`${current.path}:${current.size}:${current.mtimeMs}` !== version) {
      scheduleQuietRefresh(sessionUuid, cwd, current, ownerSessionId);
      return;
    }
    queueCanonicalImport(sessionUuid, cwd, current.path, ownerSessionId);
  }, 5_000);
  timer.unref?.();
  pendingRefresh.set(sessionUuid, timer);
}

function cacheCoverage(sessionUuid: string): ProviderHistoryPage["coverage"] {
  const retry = Math.max(0, (retryImportAt.get(sessionUuid) || 0) - Date.now());
  return { complete: false, code: retry ? "history_import_failed" : "history_indexing",
    retryAfterMs: retry || 1000,
    omissions: [retry ? "Conversation history preparation failed and will retry."
      : "Conversation history is being prepared from its provider record."] };
}

type RetainedMessage = { sequence: number; message: ProviderHistoryMessage };
function retainedMessages(sessionId: number | undefined, after: number, through: number): { rows: RetainedMessage[]; overflow: boolean } {
  if (!sessionId) return { rows: [], overflow: false };
  const rows = ownerDb.query(`SELECT sequence,payload_json FROM session_owner_events
    WHERE session_id=? AND kind='message' AND sequence>? AND sequence<=?
    ORDER BY sequence DESC LIMIT 201`).all(sessionId, after, through) as {sequence:number;payload_json:string}[];
  const latest = new Map<string, RetainedMessage>();
  for (const row of rows) {
    const message = (JSON.parse(row.payload_json) as {message?: ProviderHistoryMessage}).message;
    if (typeof message?.id === "string" && !latest.has(message.id)) latest.set(message.id,{sequence:row.sequence,message});
  }
  return { rows: [...latest.values()].sort((a,b)=>a.sequence-b.sequence), overflow: rows.length > 200 };
}

/** A changed Claude source is covered when it is an append of rows already retained by the owner.
 * Branches, compactions, external edits and an oversized tail require a new canonical SDK import. */
async function appendCovered(meta: ClaudeCacheMeta, source: {path:string;size:number;mtimeMs:number}|null,
  ownerSessionId: number|undefined, ids: ReadonlySet<string>): Promise<{covered:boolean;tailUuid:string|null}> {
  const missing = {covered:false,tailUuid:meta.tail_uuid};
  if (!source || source.path !== meta.source_path || source.size < meta.source_size || meta.cwd === "") return missing;
  if (source.size === meta.source_size) return {covered:source.mtimeMs === meta.source_mtime_ms,tailUuid:meta.tail_uuid};
  if (!ownerSessionId || source.size - meta.source_size > 4 * 1024 * 1024) return missing;
  const handle = await open(source.path,"r");
  try {
    const bytes = Buffer.alloc(source.size-meta.source_size);
    const read = await handle.read(bytes,0,bytes.length,meta.source_size);
    if (read.bytesRead !== bytes.length) return missing;
    const tail = bytes.toString("utf8");
    if (!tail.endsWith("\n")) return missing;
    let parent = meta.tail_uuid;
    for (const line of tail.split("\n")) {
      if (!line) continue;
      let row: Record<string,any>;
      try { row = JSON.parse(line); } catch { return missing; }
      if (row.isCompactSummary === true || row.type === "summary" || row.subtype === "compact_boundary") return missing;
      if (typeof row.uuid === "string" && row.uuid) {
        if (parent && typeof row.parentUuid === "string" && row.parentUuid && row.parentUuid !== parent) return missing;
        parent = row.uuid;
      }
      if ((row.type === "user" || row.type === "assistant") && row.isSidechain !== true && row.isMeta !== true
        && row.parent_tool_use_id == null && typeof row.uuid === "string") {
        const parts = Array.isArray(row.message?.content) ? row.message.content : [];
        const text = typeof row.message?.content === "string" || parts.some((part:any)=>part?.type === "text");
        if (text && !ids.has(row.uuid)) return missing;
        if (parts.some((part:any)=>(part?.type === "tool_use" || part?.type === "tool_result") &&
          !ids.has(part.type === "tool_result" ? `${part.tool_use_id}:result` : part.id))) return missing;
      }
      if (row.type === "attachment" && row.attachment?.type === "queued_command") {
        const id = row.attachment.source_uuid || row.uuid;
        if (typeof id !== "string" || !ids.has(id)) return missing;
      }
    }
    return {covered:true,tailUuid:parent};
  } finally { await handle.close(); }
}

async function claudeCachedPage(input: ProviderHistoryInput): Promise<ProviderHistoryPage> {
  const source = await sourceVersion(input.sessionUuid, input.cwd);
  const cache = openCache(input.sessionUuid);
  if (!source && !cache) throw new Error("PROVIDER_HISTORY_UNAVAILABLE");
  if (source && !cache) queueCanonicalImport(input.sessionUuid, input.cwd, source.path, input.ownerSessionId);
  if (!cache) return { messages: [], nextCursor: null, coverage: cacheCoverage(input.sessionUuid) };
  try {
    const { db, meta } = cache;
    const location = input.cursor === null ? null : decode(input.cursor,input.sessionUuid);
    if (location && (location.generation !== meta.generation || !Number.isSafeInteger(location.position)
      || location.position < 1 || !Number.isSafeInteger(location.overlayHead))) throw new Error("STALE_HISTORY_CURSOR");
    const overlayHead = location ? location.overlayHead : input.ownerSessionId ?
      ((ownerDb.query("SELECT MAX(sequence) AS n FROM session_owner_events WHERE session_id=?").get(input.ownerSessionId) as {n:number|null}).n || 0) : 0;
    const retained = retainedMessages(input.ownerSessionId,meta.event_cutoff,overlayHead);
    const found = db.query("SELECT ordinal FROM message_ids WHERE id=?");
    const replacements = new Map<string,ProviderHistoryMessage>();
    const added: RetainedMessage[] = [];
    for (const entry of retained.rows) {
      const indexed = found.get(entry.message.id) as {ordinal:number}|null;
      if (indexed) replacements.set(entry.message.id,entry.message);
      else added.push(entry);
    }
    const total = meta.row_count + added.length;
    const end = location ? location.position : total;
    if (end > total) throw new Error("STALE_HISTORY_CURSOR");
    const offset = Math.max(0,end-input.limit);
    let rows: SessionMessage[];
    rows = offset < meta.row_count ? (db.query("SELECT json FROM rows WHERE ordinal>=? AND ordinal<? ORDER BY ordinal")
      .all(offset,Math.min(end,meta.row_count)) as {json:string}[]).map(row=>JSON.parse(row.json)) : [];
    const needed = new Set<string>();
    for (const row of rows) for (const part of Array.isArray((row as any).message?.content) ? (row as any).message.content : [])
      if (part?.type === "tool_result" && typeof part.tool_use_id === "string") needed.add(part.tool_use_id);
    const toolNames = claudeToolNames(rows);
    const findTool = db.query("SELECT name FROM tool_names WHERE tool_id=?");
    for (const id of needed) if (!toolNames.has(id)) {
      const found = findTool.get(id) as { name: string } | null;
      if (found) toolNames.set(id, found.name);
    }
    const omissions = new Set<string>();
    const messages = rows.flatMap(row => claudeHistoryMessages(row, input.sessionUuid, omissions, toolNames));
    for (let index=0;index<messages.length;index++) {
      const newer = replacements.get(messages[index]!.id);
      if (newer) messages[index] = newer;
    }
    messages.push(...added.slice(Math.max(0,offset-meta.row_count),Math.max(0,end-meta.row_count)).map(entry=>entry.message));
    for (const message of messages) if (message.detailKey) {
      message.detailKey = encode({ ...decode(message.detailKey, input.sessionUuid), generation: meta.generation });
    }
    const checkpoint = verifiedAppends.get(input.sessionUuid);
    const effectiveMeta = checkpoint?.generation === meta.generation ? {...meta,source_size:checkpoint.sourceSize,
      source_mtime_ms:checkpoint.sourceMtimeMs,tail_uuid:checkpoint.tailUuid} : meta;
    const verdict = meta.cwd === input.cwd && !retained.overflow ? await appendCovered(effectiveMeta,source,input.ownerSessionId,
      new Set(retained.rows.map(entry=>entry.message.id))) : {covered:false,tailUuid:meta.tail_uuid};
    const covered = verdict.covered;
    if (covered && source) verifiedAppends.set(input.sessionUuid,{generation:meta.generation,sourceSize:source.size,
      sourceMtimeMs:source.mtimeMs,tailUuid:verdict.tailUuid});
    if (!covered && source) scheduleQuietRefresh(input.sessionUuid,input.cwd,source,input.ownerSessionId);
    const coverage = !covered ? cacheCoverage(input.sessionUuid) : omissions.size ? { complete: false, omissions: [...omissions] } : undefined;
    return { messages, nextCursor: offset > 0
      ? encode({ sessionUuid: input.sessionUuid, position:offset, overlayHead, generation:meta.generation }) : null,
      ...(coverage ? { coverage } : {}) };
  } finally { cache.db.close(); }
}

async function claudeCachedDetail(input: ProviderDetailInput): Promise<{ content: string }> {
  const cache = openCache(input.sessionUuid);
  if (!cache) throw new Error("HISTORY_INDEXING");
  try {
    const location = decode(input.detailKey, input.sessionUuid);
    if (location.generation !== cache.meta.generation) throw new Error("STALE_HISTORY_CURSOR");
    if (typeof location.uuid !== "string" || !location.uuid) throw new Error("INVALID_HISTORY_REFERENCE");
    if (location.toolId === undefined && (!Number.isSafeInteger(location.offset) || location.offset < 0
      || !Number.isSafeInteger(location.index) || location.index < 0)) throw new Error("INVALID_HISTORY_REFERENCE");
    const row = location.toolId !== undefined
      ? cache.db.query("SELECT json FROM rows WHERE uuid=?").all(location.uuid) as { json: string }[]
      : cache.db.query("SELECT json FROM rows WHERE ordinal=? AND uuid=?").all(location.offset, location.uuid) as { json: string }[];
    if (row.length !== 1) throw new Error("STALE_HISTORY_CURSOR");
    const message = JSON.parse(row[0]!.json);
    const parts = message.message?.content;
    if (location.toolId !== undefined) {
      if (typeof location.toolId !== "string" || !location.toolId
        || (location.type !== "tool_use" && location.type !== "tool_result")) throw new Error("INVALID_HISTORY_REFERENCE");
      const found = Array.isArray(parts) ? parts.filter((part: any) => part?.type === location.type
        && (part.type === "tool_result" ? part.tool_use_id : part.id) === location.toolId) : [];
      if (found.length !== 1) throw new Error("PROVIDER_HISTORY_ITEM_NOT_FOUND");
      return { content: JSON.stringify(found[0]) };
    }
    const part = Array.isArray(parts) ? parts[location.index] : undefined;
    if (part?.type !== "tool_use" && part?.type !== "tool_result") throw new Error("PROVIDER_HISTORY_ITEM_NOT_FOUND");
    return { content: JSON.stringify(part) };
  } finally { cache.db.close(); }
}

/** The SDK's listed rows, with a session's queued messages placed where Claude read them. */
type ClaudeHistoryReader = (sessionUuid: string, options: GetSessionMessagesOptions, cwd?: string) => Promise<SessionMessage[]>;
const readClaudeTranscript: ClaudeHistoryReader = async (sessionUuid, options, cwd) => {
  const [listed, queued] = await Promise.all([getSessionMessages(sessionUuid, {}), cwd ? claudeQueuedMessages(sessionUuid, cwd) : []]);
  const rows = withQueuedMessages(listed, queued, sessionUuid);
  const offset = options.offset ?? 0;
  return options.limit !== undefined && options.limit > 0 ? rows.slice(offset, offset + options.limit) : offset > 0 ? rows.slice(offset) : rows;
};

/**
 * Claude records who submitted each user row in `promptSource`: `sdk` for an input the
 * owner delivered through the stream, `typed` for a person typing into Claude directly.
 * Anything else in a session the owner drives is the CLI's own bookkeeping —
 * interruption notes, model-switch records, "Continue from where you left off",
 * image-size notes, skill-loading notes, background-task notices — and is not a
 * message from anyone.
 *
 * Decided by that recorded author, never by wording. Matching wordings is what failed:
 * the first fix knew one interruption phrasing and missed the second, and real messages
 * can begin with the same bracket the markers do. Checked on 2026-09-18 across every
 * retained transcript: 593 rows in displayed owner-driven sessions carry no such
 * author, in 32 distinct texts, all machine-generated. The only real prompts without an
 * author are helper-agent tasks, which live in separate files and are never displayed.
 */
function isClaudeBookkeepingRow(row: Record<string, any>, content: unknown) {
  // A queued message is one someone submitted; Claude records no promptSource on it.
  if (row.queuedCommand === true) return false;
  if (row.type !== 'user' || row.entrypoint !== 'sdk-cli' || row.promptSource === 'sdk' || row.promptSource === 'typed') return false;
  if (typeof content === 'string') return true;
  // Tool results and attachments keep their own handling; only plain text rows qualify.
  return Array.isArray(content) && content.length > 0 && content.every(block => record(block)?.type === 'text');
}

/** Tool names by call ID, so a result whose call sits on an earlier page still names its tool. */
export function claudeToolNames(rows: readonly unknown[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const row of rows) {
    const content = record(record(row)?.message)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) if (part?.type === "tool_use" && typeof part.id === "string" && typeof part.name === "string") names.set(part.id, part.name);
  }
  return names;
}

export function claudeHistoryMessages(value: unknown, sessionUuid: string, omissions = new Set<string>(),
  toolNames?: ReadonlyMap<string, string>): ProviderHistoryMessage[] {
  const row = record(value);
  if (!row || (row.type !== "user" && row.type !== "assistant") || typeof row.uuid !== "string"
    || !row.uuid || row.session_id !== sessionUuid) {
    throw new Error("PROVIDER_HISTORY_INVALID");
  }
  if (row.parent_tool_use_id != null) return [];
  const content = record(row.message)?.content;
  if (isClaudeBookkeepingRow(row, content)) return [];
  // Sessions from the brief form version acknowledged its answer with a tool result that
  // ended the turn. It is the provider's receipt, not something anyone said.
  if (row.type === "user" && row.toolEndsTurn === true) return [];
  const timestamp = typeof row.timestamp === "string" && Number.isFinite(Date.parse(row.timestamp)) ? row.timestamp : undefined;
  // Claude Code writes some assistant rows itself and records their model as `<synthetic>`.
  // Its "No response requested." after an interrupted or superseded prompt is bookkeeping,
  // not something the agent said; a provider error it records the same way still explains
  // a failure and stays, without a fake model name. Decided by that recorded field, never wording.
  const synthetic = row.type === "assistant" && record(row.message)?.model === "<synthetic>";
  if (synthetic && row.isApiErrorMessage !== true) return [];
  const model = row.type === "assistant" && !synthetic && typeof record(row.message)?.model === "string" ? row.message.model : undefined;
  const identity = { id: row.uuid, turnId: row.uuid,
    ...(timestamp ? { createdAt: timestamp, timestampSource: "provider" as const } : {}),
    ...(model ? { model, modelSource: "provider" as const } : {}),
    ...(row.type === "user" ? { submissionId: row.uuid } : {}) };
  if (typeof content === "string") {
    // Same rule as the parts below: what is left after the marker, and no message at all
    // when nothing is. A user row keeps whatever it holds.
    if (row.type === "assistant") {
      const stripped = splitTurnOutcomeMarker(content).text;
      return stripped ? [{ ...identity, role: row.type, content: stripped, tool: null, phase: null }] : [];
    }
    return [{ ...identity, role: row.type, content, tool: null, phase: null }];
  }
  if (!Array.isArray(content)) throw new Error("PROVIDER_HISTORY_INVALID");
  if (content.some(part => part?.type === "text" && typeof part.text !== "string")) throw new Error("PROVIDER_HISTORY_INVALID");
  const messages: ProviderHistoryMessage[] = [];
  const text = content.filter(part => part?.type === "text").map(part => typeof part.text === "string" ? part.text : "").join("\n");
  const projected = row.type === "assistant" ? splitTurnOutcomeMarker(text).text : text;
  // An assistant row that was only the marker has nothing left to show, so it is no message;
  // the row's tool parts below still are. A user row keeps whatever it holds.
  if (content.some(part => part?.type === "text") && !(row.type === "assistant" && !projected)) messages.push({ ...identity, role: row.type,
    content: projected, tool: null, phase: null });
  for (const part of content) {
    if (part?.type === "thinking" || part?.type === "redacted_thinking" || part?.type === "text") continue;
    // The form version's answer arrived as a provider tool call; it reads as its message.
    const legacy = part?.type === "tool_use" && part.name === LEGACY_STRUCTURED_OUTPUT_TOOL ? legacyStructuredOutputMessage(part.input) : null;
    if (legacy && typeof part.id === "string" && part.id) {
      messages.push({ ...identity, id: part.id, role: "assistant", content: legacy, tool: null, phase: null });
      continue;
    }
    if (part?.type !== "tool_use" && part?.type !== "tool_result") {
      omissions.add("Non-text Claude content is not available through this history adapter.");
      continue;
    }
    const result = part.type === "tool_result";
    const id = result ? part.tool_use_id : part.id;
    if (typeof id !== "string" || !id) throw new Error("PROVIDER_HISTORY_INVALID");
    messages.push({ id: result ? `${id}:result` : id, turnId: row.uuid, role: "tool", content: JSON.stringify(part),
      // A result carries only its call's ID; name it from the call, never from the ID itself.
      tool: typeof part.name === "string" ? part.name : toolNames?.get(id) ?? "tool", phase: result ? part.is_error ? "failed" : "completed" : "requested",
      ...(timestamp ? {createdAt:timestamp,timestampSource:"provider" as const} : {}),
      ...(result ? { toolCallId: id } : {}), detailKey: encode({ sessionUuid, uuid: row.uuid, toolId: id, type: part.type }) });
  }
  return messages;
}

export async function readClaudeHistory(input: ProviderHistoryInput,
  read: ClaudeHistoryReader = readClaudeTranscript): Promise<ProviderHistoryPage> {
  validatePageInput(input);
  if (read === readClaudeTranscript) return claudeCachedPage(input);
  let offset: number;
  let rows: SessionMessage[];
  // Rows whose tool calls can name this page's results: the page itself, or the whole
  // transcript when the latest page already read it.
  let named: readonly unknown[];
  if (input.cursor !== null) {
    const location = decode(input.cursor, input.sessionUuid);
    if (!Number.isSafeInteger(location.offset) || location.offset < 1 || typeof location.anchor !== "string" || !location.anchor) {
      throw new Error("INVALID_HISTORY_REFERENCE");
    }
    offset = Math.max(0, location.offset - input.limit);
    rows = await read(input.sessionUuid, { offset, limit: location.offset - offset + 1 }, input.cwd);
    if (rows.at(-1)?.uuid !== location.anchor) throw new Error("STALE_HISTORY_CURSOR");
    rows = rows.slice(0, -1);
    named = rows;
  } else {
    const native = await read(input.sessionUuid, {}, input.cwd);
    if (!native.length) throw new Error("PROVIDER_HISTORY_UNAVAILABLE");
    offset = Math.max(0, native.length - input.limit);
    rows = native.slice(offset);
    named = native;
  }
  const omissions = new Set<string>();
  const toolNames = claudeToolNames(named);
  const messages = rows.flatMap(row => claudeHistoryMessages(row, input.sessionUuid, omissions, toolNames));
  return { messages, nextCursor: offset > 0 && rows[0]
    ? encode({ sessionUuid: input.sessionUuid, offset, anchor: rows[0].uuid }) : null,
    ...(omissions.size ? { coverage: { complete: false, omissions: [...omissions] } } : {}) };
}

export async function readClaudeHistoryDetail(input: ProviderDetailInput,
  read: ClaudeHistoryReader = readClaudeTranscript): Promise<{ content: string }> {
  if (read === readClaudeTranscript) return claudeCachedDetail(input);
  const location = decode(input.detailKey, input.sessionUuid);
  if (typeof location.uuid !== "string" || !location.uuid) throw new Error("INVALID_HISTORY_REFERENCE");
  if (location.toolId !== undefined) {
    if (typeof location.toolId !== "string" || !location.toolId
      || (location.type !== "tool_use" && location.type !== "tool_result")) throw new Error("INVALID_HISTORY_REFERENCE");
    const rows = await read(input.sessionUuid, {}, input.cwd);
    const matches = rows.filter(row => row.session_id === input.sessionUuid && row.uuid === location.uuid);
    if (matches.length !== 1) throw new Error("STALE_HISTORY_CURSOR");
    const content = record(matches[0]!.message)?.content;
    const parts = Array.isArray(content) ? content.filter(part => part?.type === location.type
      && (part.type === "tool_result" ? part.tool_use_id : part.id) === location.toolId) : [];
    if (parts.length !== 1) throw new Error("PROVIDER_HISTORY_ITEM_NOT_FOUND");
    return { content: JSON.stringify(parts[0]) };
  }
  if (!Number.isSafeInteger(location.offset) || location.offset < 0 || !Number.isSafeInteger(location.index)
    || location.index < 0 || typeof location.uuid !== "string" || !location.uuid) throw new Error("INVALID_HISTORY_REFERENCE");
  const [row] = await read(input.sessionUuid, { offset: location.offset, limit: 1 }, input.cwd);
  if (row?.session_id !== input.sessionUuid || row?.uuid !== location.uuid) throw new Error("STALE_HISTORY_CURSOR");
  const part = record(row.message)?.content?.[location.index];
  if (part?.type !== "tool_use" && part?.type !== "tool_result") throw new Error("PROVIDER_HISTORY_ITEM_NOT_FOUND");
  return { content: JSON.stringify(part) };
}

export async function forkClaudeHistory(input: {
  sessionUuid: string; cwd: string; boundary: string; interactionPolicy?: ProviderInteractionPolicy;
}, native = { read: getSessionMessages, fork: forkSession }): Promise<RunResult> {
  assertProviderForkPolicy(input.interactionPolicy);
  const history = await native.read(input.sessionUuid, { dir: input.cwd });
  if (!input.boundary || !history.some(row => row.session_id === input.sessionUuid && row.uuid === input.boundary)) {
    throw new Error("PROVIDER_FORK_BOUNDARY_NOT_FOUND");
  }
  const child = await native.fork(input.sessionUuid, { dir: input.cwd, upToMessageId: input.boundary });
  if (!child.sessionId || child.sessionId === input.sessionUuid) throw new Error("PROVIDER_FORK_IDENTITY_MISMATCH");
  return { text: "Fork created.", sessionUUID: child.sessionId, providerTurnId: null, toolsUsed: [] };
}
