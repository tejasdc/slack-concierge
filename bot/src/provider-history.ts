import { forkSession, getSessionMessages, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RunResult } from "./codex";
import { sharedCodexAppServerClient } from "./codex-app-server-client";
import { assertProviderForkPolicy, type ProviderInteractionPolicy } from "./provider-policy";
import { codexTranscriptTimestamps } from './provider-transcript-metadata';

export type MessageAuthor = {
  kind: 'human'|'agent'|'service'|'unknown';
  session?: {id:string;title:string;provider:'codex'|'claude-code'|'chatgpt'};
  inputId?:string; runId?:string; requestId?:string;
  communication?:'request'|'reply'|'result'|'overdue'|'post'; replyKind?:'partial'|'final';
  /** Whether a delegated request may change anything, resolved across its whole chain. */
  effectScope?:'informational'|'work';
  /** The human request this ultimately acts for, which can differ from the immediate sender. */
  originatingHuman?:{session?:{id:string;title:string;provider:'codex'|'claude-code'|'chatgpt'};inputId:string;runId:string;captureId?:string};
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
}

export interface ProviderHistoryPage {
  messages: ProviderHistoryMessage[];
  nextCursor: string | null;
  coverage?: { complete: boolean; omissions: string[] };
}

export interface ProviderDetailInput {
  sessionUuid: string;
  cwd: string;
  detailKey: string;
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
    return [{ ...identity, role: "assistant", content: item.text, tool: null,
      phase: typeof item.phase === "string" ? item.phase : null }];
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

type ClaudeHistoryReader = typeof getSessionMessages;

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
  if (row.type !== 'user' || row.entrypoint !== 'sdk-cli' || row.promptSource === 'sdk' || row.promptSource === 'typed') return false;
  if (typeof content === 'string') return true;
  // Tool results and attachments keep their own handling; only plain text rows qualify.
  return Array.isArray(content) && content.length > 0 && content.every(block => record(block)?.type === 'text');
}

export function claudeHistoryMessages(value: unknown, sessionUuid: string, omissions = new Set<string>()): ProviderHistoryMessage[] {
  const row = record(value);
  if (!row || (row.type !== "user" && row.type !== "assistant") || typeof row.uuid !== "string"
    || !row.uuid || row.session_id !== sessionUuid) {
    throw new Error("PROVIDER_HISTORY_INVALID");
  }
  if (row.parent_tool_use_id != null) return [];
  const content = record(row.message)?.content;
  if (isClaudeBookkeepingRow(row, content)) return [];
  const timestamp = typeof row.timestamp === "string" && Number.isFinite(Date.parse(row.timestamp)) ? row.timestamp : undefined;
  const model = row.type === "assistant" && typeof record(row.message)?.model === "string" ? row.message.model : undefined;
  const identity = { id: row.uuid, turnId: row.uuid,
    ...(timestamp ? { createdAt: timestamp, timestampSource: "provider" as const } : {}),
    ...(model ? { model, modelSource: "provider" as const } : {}),
    ...(row.type === "user" ? { submissionId: row.uuid } : {}) };
  if (typeof content === "string") return [{ ...identity, role: row.type, content, tool: null, phase: null }];
  if (!Array.isArray(content)) throw new Error("PROVIDER_HISTORY_INVALID");
  if (content.some(part => part?.type === "text" && typeof part.text !== "string")) throw new Error("PROVIDER_HISTORY_INVALID");
  const messages: ProviderHistoryMessage[] = [];
  const text = content.filter(part => part?.type === "text").map(part => typeof part.text === "string" ? part.text : "").join("\n");
  if (content.some(part => part?.type === "text")) messages.push({ ...identity, role: row.type, content: text, tool: null, phase: null });
  for (const part of content) {
    if (part?.type === "thinking" || part?.type === "redacted_thinking" || part?.type === "text") continue;
    if (part?.type !== "tool_use" && part?.type !== "tool_result") {
      omissions.add("Non-text Claude content is not available through this history adapter.");
      continue;
    }
    const result = part.type === "tool_result";
    const id = result ? part.tool_use_id : part.id;
    if (typeof id !== "string" || !id) throw new Error("PROVIDER_HISTORY_INVALID");
    messages.push({ id: result ? `${id}:result` : id, turnId: row.uuid, role: "tool", content: JSON.stringify(part),
      tool: typeof part.name === "string" ? part.name : id, phase: result ? part.is_error ? "failed" : "completed" : "requested",
      ...(timestamp ? {createdAt:timestamp,timestampSource:"provider" as const} : {}),
      ...(result ? { toolCallId: id } : {}), detailKey: encode({ sessionUuid, uuid: row.uuid, toolId: id, type: part.type }) });
  }
  return messages;
}

export async function readClaudeHistory(input: ProviderHistoryInput,
  read: ClaudeHistoryReader = getSessionMessages): Promise<ProviderHistoryPage> {
  validatePageInput(input);
  let offset: number;
  let rows: SessionMessage[];
  if (input.cursor !== null) {
    const location = decode(input.cursor, input.sessionUuid);
    if (!Number.isSafeInteger(location.offset) || location.offset < 1 || typeof location.anchor !== "string" || !location.anchor) {
      throw new Error("INVALID_HISTORY_REFERENCE");
    }
    offset = Math.max(0, location.offset - input.limit);
    rows = await read(input.sessionUuid, { offset, limit: location.offset - offset + 1 });
    if (rows.at(-1)?.uuid !== location.anchor) throw new Error("STALE_HISTORY_CURSOR");
    rows = rows.slice(0, -1);
  } else {
    const native = await read(input.sessionUuid, {});
    if (!native.length) throw new Error("PROVIDER_HISTORY_UNAVAILABLE");
    offset = Math.max(0, native.length - input.limit);
    rows = native.slice(offset);
  }
  const omissions = new Set<string>();
  const messages = rows.flatMap(row => claudeHistoryMessages(row, input.sessionUuid, omissions));
  return { messages, nextCursor: offset > 0 && rows[0]
    ? encode({ sessionUuid: input.sessionUuid, offset, anchor: rows[0].uuid }) : null,
    ...(omissions.size ? { coverage: { complete: false, omissions: [...omissions] } } : {}) };
}

export async function readClaudeHistoryDetail(input: ProviderDetailInput,
  read: ClaudeHistoryReader = getSessionMessages): Promise<{ content: string }> {
  const location = decode(input.detailKey, input.sessionUuid);
  if (typeof location.uuid !== "string" || !location.uuid) throw new Error("INVALID_HISTORY_REFERENCE");
  if (location.toolId !== undefined) {
    if (typeof location.toolId !== "string" || !location.toolId
      || (location.type !== "tool_use" && location.type !== "tool_result")) throw new Error("INVALID_HISTORY_REFERENCE");
    const rows = await read(input.sessionUuid, {});
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
  const [row] = await read(input.sessionUuid, { offset: location.offset, limit: 1 });
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
