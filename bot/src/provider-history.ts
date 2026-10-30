import {releaseWorkerPath} from "./release-worker";
import { forkSession, getSessionMessages, type GetSessionMessagesOptions, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { claudeQueuedMessages, withQueuedMessages } from "./claude-queued-messages";
import { CLAUDE_HISTORY_FORMAT } from "./provider-history-format";
import { claudeConfigDir, locateClaudeTranscript } from "./claude-transcript-watch";
import { log } from "./log";
import { db as ownerDb } from "./state";
import { preparedOwnerMessageVersion } from "./presentation-message-reader";
import type { RunResult } from "./codex";
import { sharedCodexAppServerClient } from "./codex-app-server-client";
import { assertProviderForkPolicy, type ProviderInteractionPolicy } from "./provider-policy";
import { codexTranscriptTimestamps, codexTranscriptTimestampsAfter, type CodexTranscriptMark } from './provider-transcript-metadata';
import { LEGACY_STRUCTURED_OUTPUT_TOOL, legacyStructuredOutputMessage, splitTurnOutcomeMarker } from './turn-outcome-marker';

/**
 * The session a message came from, and who that agent is by the one presence rule
 * (`agentIdentity` in session-presence.ts): `agentName` is the exact name the sidebar and header
 * show for it. A fact this machine does not know is null, never another provider's name.
 */
export type AuthorSession = {id:string;title:string;provider:string|null;model:string|null;reasoningEffort:string|null;agentName:string|null};

export type MessageAuthor = {
  kind: 'human'|'agent'|'service'|'unknown';
  outsideAgent?: {name:string;label:string};
  session?: AuthorSession;
  inputId?:string; runId?:string; requestId?:string;
  /** `notice`: the service wrote it itself with no agent behind it (a retry that gave up, a failed update). */
  communication?:'request'|'reply'|'result'|'overdue'|'post'|'notice'; replyKind?:'partial'|'final';
  /** Whether a delegated request may change anything, resolved across its whole chain. */
  effectScope?:'informational'|'work';
  /** The human request this ultimately acts for, which can differ from the immediate sender. */
  originatingHuman?:{session?:AuthorSession;inputId:string;runId:string;captureId?:string};
  /** Which way his own message came in: "iPhone Action Button", "Mac quick capture", "web". */
  via?:string;
  /** This was recorded as Tejas's words but an agent posted it; the record says why. */
  correction?:{reason:string;at:string};
  /** He saved another author's message: the act is his, the words are theirs. */
  quoted?:{kind:'agent'|'human'|'unknown';session?:AuthorSession};
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
  /** This session received the exact accepted Inbox message from another thread. */
  routedFrom?:{sessionId:string;messageId:string;topicId:string;root:string;title:string;originalText:string;originalCreatedAt:string;authorKind:'human'|'agent'};
  toolCallId?: string;
  detailKey?: string;
  attachments?: Array<{ id: string; name: string; contentType: string }>;
  richContent?: unknown;
  /** Exact structured words live behind a verified selected-message detail read. */
  contentDetail?: {digest:string;bytes:number;parts:number};
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

/**
 * The newest readable window of each Codex conversation, kept beside the ledger and topped up
 * with only what Codex added since. Without it every open listed 5-8 App Server pages of a
 * tool-heavy conversation and, after a restart, re-read its whole rollout for timestamps:
 * 0.3-1.1 s per open warm and 3-6 s cold (nightly review, 2026-10-30).
 *
 * The window is a run of real App Server pages, newest first. Codex items never change once
 * listed and its continuation markers are rollout positions, so each kept page's marker stays
 * valid. A top-up lists from the newest item until it meets the kept head; the page that meets
 * it replaces the kept items it covers, and the remainder of the kept page it lands in keeps
 * that page's marker. A head that is no longer listed (a rolled-back thread) or a gap longer than
 * a few pages rebuilds the window from the newest page.
 */
type CodexWindowEntry={id:string;turnId:string;messages:ProviderHistoryMessage[]};
type CodexWindowSegment={entries:CodexWindowEntry[];next:string|null};
type CodexWindow={version:2;thread:string;segments:CodexWindowSegment[];omissions:string[]};
/**
 * Kept pages are 20 items, the client's page size, so an answer can stop at the first page that
 * completes what was asked: a 100-item page made a read of a tool-heavy conversation carry
 * 250-540 messages (0.8-1.7 MB, 150-360 ms) to show 30 readable ones (2026-10-30).
 */
const CODEX_WINDOW_PAGE=20;
const CODEX_WINDOW_TOPUP_PAGES=25;
const CODEX_WINDOW_BUILD_PAGES=60;
export const CODEX_WINDOW_DIALOGUE=40;

function codexWindowPath(thread:string){
  if(!/^[A-Za-z0-9-]{8,80}$/.test(thread))throw new Error("INVALID_HISTORY_REQUEST");
  return join(process.env.CONCIERGE_STATE_DIR||join(homedir(),".local","state","concierge"),"codex-history-window",`${thread}.json`);
}
// The window and the rollout position its timestamps were read to are separate files: the
// position moves with every bookkeeping line Codex writes, the window only when items change.
function loadCodexWindow(thread:string):{window:CodexWindow;text:string;mark:CodexTranscriptMark|null}|null{
  try{
    const path=codexWindowPath(thread),text=readFileSync(path,"utf8"),window=JSON.parse(text) as CodexWindow;
    if(window?.version!==2||window.thread!==thread||!Array.isArray(window.segments)||!window.segments.length)return null;
    let mark:CodexTranscriptMark|null=null;
    try{mark=JSON.parse(readFileSync(`${path}.mark`,"utf8"));}catch{/* Timestamps are then read from the rollout's start. */}
    return {window,text,mark};
  }catch{return null;}
}
function writeAtomically(path:string,text:string){
  const temporary=`${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(temporary,text,{mode:0o600});
  renameSync(temporary,path);
}
function saveCodexWindow(thread:string,text:string|null,mark:CodexTranscriptMark|null){
  try{
    const path=codexWindowPath(thread);
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    if(text!==null)writeAtomically(path,text);
    if(mark)writeAtomically(`${path}.mark`,JSON.stringify(mark));
  }catch(error){log("warn","codex_history_window_save_failed",{error:String(error).slice(0,300)});}
}
const windowDialogue=(segments:readonly CodexWindowSegment[])=>{
  let dialogue=0,user=false;
  for(const segment of segments)for(const entry of segment.entries)for(const message of entry.messages){
    if(message.role!=="tool")dialogue++;
    if(message.role==="user")user=true;
  }
  return {dialogue,user};
};

/** The kept window for one thread, topped up from the App Server; built once when none is kept. */
export async function readCodexHistoryWindow(input:{sessionUuid:string;want?:{dialogue:number;untilInput:boolean}},
  request:CodexHistoryRequest=codexRequest()):Promise<ProviderHistoryPage>{
  const thread=input.sessionUuid,loaded=loadCodexWindow(thread),kept=loaded?.window??null;
  const head=kept?.segments[0]?.entries.at(-1);
  // Listed items are always projected afresh (one still being written can change); only their
  // timestamps are reused, so a top-up reads just the rollout bytes written since.
  const keptTimes=new Map<string,string>();
  if(kept)for(const segment of kept.segments)for(const entry of segment.entries)for(const message of entry.messages)
    if(message.createdAt&&message.timestampSource==="provider")keptTimes.set(JSON.stringify([message.turnId,message.id]),message.createdAt);
  const pages:{data:any[];next:string|null}[]=[];
  let cursor:string|null=null,met=-1,topUp=!!head;
  for(let page=0;page<CODEX_WINDOW_BUILD_PAGES;page++){
    const listed=codexPage(await request("thread/items/list",{threadId:thread,cursor,limit:CODEX_WINDOW_PAGE,sortDirection:"desc"}));
    if(listed.nextCursor!==null&&listed.nextCursor===cursor)throw new Error("PROVIDER_HISTORY_INVALID");
    pages.push({data:listed.data,next:listed.nextCursor});
    if(topUp){
      met=listed.data.findIndex(entry=>entry?.turnId===head!.turnId&&entry?.item?.id===head!.id);
      if(met>=0)break;
      if(pages.length>=CODEX_WINDOW_TOPUP_PAGES)topUp=false;
    }
    if(!topUp){
      const listedEntries=pages.flatMap(item=>item.data).map(entry=>({role:entry?.item?.type}));
      const dialogue=listedEntries.filter(entry=>entry.role==="userMessage"||entry.role==="agentMessage").length;
      if(dialogue>=CODEX_WINDOW_DIALOGUE&&listedEntries.some(entry=>entry.role==="userMessage"))break;
    }
    if(!listed.nextCursor)break;
    cursor=listed.nextCursor;
  }
  let window:CodexWindow;
  {
    // Timestamps for listed items not already kept: only the rollout bytes after the kept mark,
    // or the whole rollout when nothing usable is kept.
    const resumable=met>=0?loaded!.mark:null;
    const read=await codexTranscriptTimestampsAfter(thread,request,resumable);
    const timestamps=read?.timestamps??new Map<string,string|null>();
    const omissions=new Set<string>(met>=0?kept!.omissions:[]);
    const segments:CodexWindowSegment[]=pages.map(page=>({next:page.next,entries:page.data.slice().reverse().map(entry=>{
      if(typeof entry?.turnId!=="string")throw new Error("PROVIDER_HISTORY_INVALID");
      const messages=codexHistoryMessages(entry.item,entry.turnId,thread,omissions);
      for(const message of messages){
        const key=JSON.stringify([message.turnId,message.id]);
        const timestamp=timestamps.get(key)??(met>=0?keptTimes.get(key):undefined);
        if(timestamp){message.createdAt=timestamp;message.timestampSource="provider";}
      }
      return {id:entry.item.id,turnId:entry.turnId,messages};
    })}));
    if(met>=0){
      // The kept items older than the last listed one keep their own pages and markers.
      const oldest=segments.at(-1)!.entries[0]!;
      const at=kept!.segments.findIndex(segment=>segment.entries.some(entry=>entry.id===oldest.id&&entry.turnId===oldest.turnId));
      if(at>=0){
        const landing=kept!.segments[at]!,index=landing.entries.findIndex(entry=>entry.id===oldest.id&&entry.turnId===oldest.turnId);
        if(index>0)segments.push({entries:landing.entries.slice(0,index),next:landing.next});
        segments.push(...kept!.segments.slice(at+1));
      }
    }
    // Keep the newest pages that hold the readable window; older pages are read on demand.
    let keep=segments.length;
    for(let count=1;count<=segments.length;count++){
      const covered=windowDialogue(segments.slice(0,count));
      if(covered.dialogue>=CODEX_WINDOW_DIALOGUE&&covered.user){keep=count;break;}
    }
    window={version:2,thread,segments:segments.slice(0,keep),omissions:[...omissions]};
    // A rollout that only gained bookkeeping (token counts) leaves the kept window as it was.
    const text=JSON.stringify(window);
    saveCodexWindow(thread,text===loaded?.text?null:text,read?.mark??null);
  }
  // Answer with the newest pages that complete what was asked, not the whole kept window.
  let answer=window.segments.length;
  if(input.want)for(let count=1;count<=window.segments.length;count++){
    const covered=windowDialogue(window.segments.slice(0,count));
    if(covered.dialogue>=input.want.dialogue&&(!input.want.untilInput||covered.user)){answer=count;break;}
  }
  const served=window.segments.slice(0,answer);
  const messages=served.slice().reverse().flatMap(segment=>segment.entries.flatMap(entry=>entry.messages));
  const next=served.at(-1)!.next;
  return {messages,nextCursor:next===null?null:encode({sessionUuid:thread,cursor:next}),
    ...(window.omissions.length?{coverage:{complete:false,omissions:window.omissions}}:{})};
}

/** An explicit detail read uses the provider's exact turn and item identity, not a history scan. */
export async function readCodexHistoryMessage(sessionUuid:string,turnId:string,messageId:string,
  request:CodexHistoryRequest=codexRequest()):Promise<ProviderHistoryMessage|null> {
  if(!sessionUuid||!turnId||!messageId||[sessionUuid,turnId,messageId].some(value=>value.length>512))
    throw new Error('INVALID_HISTORY_REFERENCE');
  let cursor:string|null=null;
  do {
    const page=codexPage(await request('thread/items/list',{
      threadId:sessionUuid,turnId,cursor,limit:100,sortDirection:'desc'}));
    const entry=page.data.find(value=>value?.turnId===turnId&&value?.item?.id===messageId);
    if(entry)return codexHistoryMessages(entry.item,turnId,sessionUuid).find(value=>value.id===messageId)??null;
    if(page.nextCursor===cursor)throw new Error('PROVIDER_HISTORY_INVALID');
    cursor=page.nextCursor;
  } while(cursor!==null);
  return null;
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
  source_mtime_ms: number; row_count: number; generation: string; event_cutoff: number; tail_uuid: string | null;
  verified_source_size: number; verified_source_mtime_ms: number; verified_tail_uuid: string | null; needs_reimport: number;
  history_format?: number };
const queuedImports = new Map<string, Promise<void>>();
const activeImportChildren = new Set<ReturnType<typeof Bun.spawn>>();
const pendingRefresh = new Map<string, ReturnType<typeof setTimeout>>();
const observedVersions = new Map<string, string>();
const retryImportAt = new Map<string, number>();
const queuedVerifications = new Map<string,Promise<void>>();
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
    try {
      const status=JSON.parse(readFileSync(path+".verified.json","utf8")) as Partial<ClaudeCacheMeta>;
      if(status.generation===meta.generation && Number.isSafeInteger(status.verified_source_size)
        && typeof status.verified_source_mtime_ms==="number") {
        meta.verified_source_size=status.verified_source_size!;
        meta.verified_source_mtime_ms=status.verified_source_mtime_ms;
        meta.verified_tail_uuid=typeof status.verified_tail_uuid==="string"?status.verified_tail_uuid:null;
        meta.needs_reimport=status.needs_reimport===1?1:0;
        if(status.history_format===CLAUDE_HISTORY_FORMAT)meta.history_format=CLAUDE_HISTORY_FORMAT;
      }
    } catch { /* The immutable baseline remains valid without a verifier checkpoint. */ }
    // An older snapshot keeps serving its rows until the verifier child confirms its transcript
    // never compacted (it then records the current format) or one rebuild replaces it.
    if (meta.history_format !== CLAUDE_HISTORY_FORMAT) meta.needs_reimport = 1;
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

function historyWorkerPath(){return releaseWorkerPath("provider-history-worker");}
function historyVerifyWorkerPath(){return releaseWorkerPath("provider-history-sync-worker");}

function queueHistoryVerification(sessionUuid:string,ownerSessionId:number) {
  if(queuedVerifications.has(sessionUuid))return queuedVerifications.get(sessionUuid);
  if(queuedImports.has(sessionUuid))return;
  const work=importLane.then(async()=>{
    const command=process.platform==="linux"
      ? ["setpriv","--pdeathsig","KILL",process.execPath,"run",historyVerifyWorkerPath(),cachePath(sessionUuid),
          join(process.env.CONCIERGE_STATE_DIR!,"state.db"),String(ownerSessionId),sessionUuid]
      : [process.execPath,"run",historyVerifyWorkerPath(),cachePath(sessionUuid),
          join(process.env.CONCIERGE_STATE_DIR!,"state.db"),String(ownerSessionId),sessionUuid];
    const child=Bun.spawn(command,{stdout:"ignore",stderr:"ignore",env:{HOME:process.env.HOME || homedir()}});
    activeImportChildren.add(child);
    const timeout=setTimeout(()=>child.kill(),30_000);
    try {
      const code=await child.exited;
      if(code!==0)log("warn","provider_history_verification_failed",{session_uuid:sessionUuid,exit_code:code});
    } finally {clearTimeout(timeout);activeImportChildren.delete(child);}
  }).catch(error=>log("warn","provider_history_verification_failed",{session_uuid:sessionUuid,
    reason:error instanceof Error?error.name:"unknown"}));
  queuedVerifications.set(sessionUuid,work);
  importLane=work.then(()=>{});
  void work.finally(()=>queuedVerifications.delete(sessionUuid));
  return work;
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
    if(ownerSessionId)await queueHistoryVerification(sessionUuid,ownerSessionId);
    const cache=openCache(sessionUuid);
    const stillUncovered=!cache || cache.meta.source_path!==current.path || cache.meta.needs_reimport===1 || cache.meta.verified_source_size!==current.size
      || cache.meta.verified_source_mtime_ms!==current.mtimeMs;
    cache?.db.close();
    if(stillUncovered)queueCanonicalImport(sessionUuid, cwd, current.path, ownerSessionId);
  }, 5_000);
  timer.unref?.();
  pendingRefresh.set(sessionUuid, timer);
}

function snapshotMatches(meta: ClaudeCacheMeta, source: {path:string;size:number;mtimeMs:number}, cwd: string) {
  return meta.source_path===source.path && meta.cwd===cwd && !meta.needs_reimport
    && meta.verified_source_size===source.size && meta.verified_source_mtime_ms===source.mtimeMs;
}

/**
 * Brings one conversation's snapshot up to its transcript before anyone opens it, using the
 * same import and verification children a read would start. A read that found no snapshot
 * answered with no messages while the import ran, so the first open of most conversations
 * was blank (2026-10-13). Resolves once this conversation's preparation has finished.
 */
export async function prepareClaudeHistory(sessionUuid: string, cwd: string, ownerSessionId: number):
  Promise<"current"|"prepared"|"unprepared"|"unavailable"> {
  const source = await sourceVersion(sessionUuid, cwd);
  if (!source) return "unavailable";
  const current = () => {
    const cache = openCache(sessionUuid);
    if (!cache) return null;
    try { return snapshotMatches(cache.meta, source, cwd); } finally { cache.db.close(); }
  };
  const before = current();
  if (before) return "current";
  // Verification walks only the appended bytes, so it comes first whenever a snapshot exists.
  if (before === false) await queueHistoryVerification(sessionUuid, ownerSessionId);
  if (current()) return "prepared";
  queueCanonicalImport(sessionUuid, cwd, source.path, ownerSessionId);
  await queuedImports.get(sessionUuid);
  return current() ? "prepared" : "unprepared";
}

function cacheCoverage(sessionUuid: string): ProviderHistoryPage["coverage"] {
  const retry = Math.max(0, (retryImportAt.get(sessionUuid) || 0) - Date.now());
  return { complete: false, code: retry ? "history_import_failed" : "history_indexing",
    retryAfterMs: retry || 1000,
    omissions: [retry ? "Conversation history preparation failed and will retry."
      : "Conversation history is being prepared from its provider record."] };
}

type NovelId={messageId:string;firstSequence:number};
function novelIds(db:Database,sessionId:number,cutoff:number,head:number,before:number,limit:number):{
  ids:NovelId[];hasMore:boolean;appliedSequence:number;complete:boolean
} {
  const presentationPath=join(process.env.CONCIERGE_STATE_DIR!,"presentation.db");
  if(!existsSync(presentationPath))return {ids:[],hasMore:false,appliedSequence:0,complete:false};
  db.query("ATTACH DATABASE ? AS presentation").run(presentationPath);
  try {
    const meta=db.query(`SELECT generation,event_watermark AS appliedSequence,ready
      FROM presentation.presentation_message_meta WHERE singleton=1`).get() as
      {generation:number;appliedSequence:number;ready:number}|null;
    if(!meta?.ready)return {ids:[],hasMore:false,appliedSequence:0,complete:false};
    const rows=db.query(`SELECT p.message_id AS messageId,p.first_sequence AS firstSequence
      FROM presentation.presentation_owner_messages p
      WHERE p.generation=? AND p.session_id=? AND p.first_sequence>? AND p.first_sequence<=?
        AND p.first_sequence<? AND NOT EXISTS(SELECT 1 FROM message_ids b WHERE b.id=p.message_id)
      ORDER BY p.first_sequence DESC LIMIT ?`)
      .all(meta.generation,sessionId,cutoff,head,before,limit+1) as NovelId[];
    return {ids:rows.slice(0,limit),hasMore:rows.length>limit,
      appliedSequence:meta.appliedSequence,complete:meta.appliedSequence>=head};
  } finally {db.exec("DETACH DATABASE presentation");}
}

function retainedVersionMessage(sessionId:number,id:string,head:number):{message:ProviderHistoryMessage;eventId:string}|null {
  const version=preparedOwnerMessageVersion(sessionId,id,head);
  if(!version)return null;
  const row=ownerDb.query("SELECT payload_json FROM session_owner_events WHERE event_id=? AND session_id=? AND kind='message'")
    .get(version.eventId,sessionId) as {payload_json:string}|null;
  const message=row?(JSON.parse(row.payload_json) as {message?:ProviderHistoryMessage}).message:null;
  return message?.id===id?{message,eventId:version.eventId}:null;
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
    if (location && (location.generation!==meta.generation || !Number.isSafeInteger(location.overlayHead)
      || !["overlay","baseline"].includes(location.phase))) throw new Error("STALE_HISTORY_CURSOR");
    const overlayHead = location ? location.overlayHead : input.ownerSessionId ?
      ((ownerDb.query("SELECT MAX(sequence) AS n FROM session_owner_events WHERE session_id=? AND kind='message'")
        .get(input.ownerSessionId) as {n:number|null}).n || meta.event_cutoff) : meta.event_cutoff;
    const phase=location?.phase || "overlay";
    const before=phase==="overlay" ? (location?.beforeFirstSequence ?? Number.MAX_SAFE_INTEGER) : 0;
    if(phase==="overlay" && (!Number.isSafeInteger(before) || before<1))throw new Error("STALE_HISTORY_CURSOR");
    const novel=input.ownerSessionId && phase==="overlay"
      ? novelIds(db,input.ownerSessionId,meta.event_cutoff,overlayHead,before,input.limit)
      : {ids:[] as NovelId[],hasMore:false,appliedSequence:overlayHead,complete:true};
    const remaining=phase==="baseline" ? input.limit : novel.hasMore ? 0 : input.limit-novel.ids.length;
    const end=phase==="baseline" ? location?.position : meta.row_count;
    if(!Number.isSafeInteger(end) || end<0 || end>meta.row_count)throw new Error("STALE_HISTORY_CURSOR");
    const offset=Math.max(0,end-remaining);
    const rows=remaining>0 ? (db.query("SELECT json FROM rows WHERE ordinal>=? AND ordinal<? ORDER BY ordinal")
      .all(offset,end) as {json:string}[]).map(row=>JSON.parse(row.json)) as SessionMessage[] : [];
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
    let missingVersion=false;
    for(let index=0;index<messages.length;index++) {
      const message=messages[index]!;
      const newer=input.ownerSessionId ? retainedVersionMessage(input.ownerSessionId,message.id,overlayHead) : null;
      if(newer)messages[index]=newer.message;
      if(newer?.message.role==="tool")messages[index]!.detailKey=encode({sessionUuid:input.sessionUuid,
        ownerEventId:newer.eventId,ownerSessionId:input.ownerSessionId});
    }
    const added:ProviderHistoryMessage[]=[];
    for(const id of novel.ids.slice().reverse()) {
      const version=retainedVersionMessage(input.ownerSessionId!,id.messageId,overlayHead);
      if(!version){missingVersion=true;continue;}
      const message={...version.message};
      if(message.role==="tool")message.detailKey=encode({sessionUuid:input.sessionUuid,
        ownerEventId:version.eventId,ownerSessionId:input.ownerSessionId});
      added.push(message);
    }
    for (const message of messages) if (message.detailKey && !decode(message.detailKey,input.sessionUuid).ownerEventId) {
      message.detailKey=encode({...decode(message.detailKey,input.sessionUuid),generation:meta.generation});
    }
    const pathChanged=!!source && meta.source_path!==source.path;
    const sourceChanged=!source || pathChanged ||
      meta.verified_source_size!==source.size || meta.verified_source_mtime_ms!==source.mtimeMs;
    if(sourceChanged && source && input.ownerSessionId && !meta.needs_reimport && !pathChanged)
      queueHistoryVerification(input.sessionUuid,input.ownerSessionId);
    if((sourceChanged || meta.needs_reimport) && source && (!input.ownerSessionId || meta.needs_reimport || pathChanged))
      scheduleQuietRefresh(input.sessionUuid,input.cwd,source,input.ownerSessionId);
    const covered=!sourceChanged && !meta.needs_reimport && meta.cwd===input.cwd && novel.complete && !missingVersion;
    const coverage=!covered ? cacheCoverage(input.sessionUuid) : omissions.size ? {complete:false,omissions:[...omissions]} : undefined;
    const nextCursor=novel.hasMore ? encode({sessionUuid:input.sessionUuid,phase:"overlay",
      beforeFirstSequence:novel.ids.at(-1)!.firstSequence,overlayHead,generation:meta.generation})
      : offset>0 ? encode({sessionUuid:input.sessionUuid,phase:"baseline",position:offset,
        overlayHead,generation:meta.generation}) : null;
    return { messages:[...messages,...added], nextCursor,
      ...(coverage ? { coverage } : {}) };
  } finally { cache.db.close(); }
}

/** The immutable Claude cache indexes provider message IDs to one transcript row. */
export function readClaudeCachedMessage(sessionUuid:string,messageId:string):ProviderHistoryMessage|null {
  if(!messageId||messageId.length>512)throw new Error('INVALID_HISTORY_REFERENCE');
  const cache=openCache(sessionUuid);
  if(!cache)throw new Error('HISTORY_INDEXING');
  try {
    const row=cache.db.query(`SELECT rows.json FROM message_ids
      JOIN rows ON rows.ordinal=message_ids.ordinal WHERE message_ids.id=?`)
      .get(messageId) as {json:string}|null;
    if(!row)return null;
    return claudeHistoryMessages(JSON.parse(row.json),sessionUuid).find(message=>message.id===messageId)??null;
  } finally {cache.db.close();}
}

async function claudeCachedDetail(input: ProviderDetailInput): Promise<{ content: string }> {
  const location=decode(input.detailKey,input.sessionUuid);
  if(location.ownerEventId!==undefined) {
    if(typeof location.ownerEventId!=="string" || !Number.isSafeInteger(location.ownerSessionId)
      || location.ownerSessionId!==input.ownerSessionId)throw new Error("INVALID_HISTORY_REFERENCE");
    const row=ownerDb.query(`SELECT payload_json FROM session_owner_events
      WHERE event_id=? AND session_id=? AND kind='message'`).get(location.ownerEventId,input.ownerSessionId) as
      {payload_json:string}|null;
    if(!row)throw new Error("PROVIDER_HISTORY_ITEM_NOT_FOUND");
    const message=(JSON.parse(row.payload_json) as {message?:ProviderHistoryMessage}).message;
    if(!message || message.role!=="tool")throw new Error("PROVIDER_HISTORY_ITEM_NOT_FOUND");
    return {content:message.content};
  }
  const cache = openCache(input.sessionUuid);
  if (!cache) throw new Error("HISTORY_INDEXING");
  try {
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
