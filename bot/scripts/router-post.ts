#!/usr/bin/env bun
// All router posts, uploads, audit replies, and receipt recovery share this path.
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { Database } from "bun:sqlite";
import { toMrkdwn } from "../src/mrkdwn";

const usage = `usage: router-actions.sh
  post <channel> [--file <path> ...] -- <text>
  resume <channel> <thread-ts> [--file <path> ...] -- <text>
  upload <channel> <thread-ts> --file <path> [--file <path> ...] [-- <text>]
  audit <channel> <trigger-message-ts> -- <text>
  thread-of <channel> <message-ts>
  resolve-upload <channel> [--thread <thread-ts>] --file-id <id> [--file-id <id> ...]
  permalink <channel> <message-ts>
  trigger <turn-id>
Channels may be managed names or Slack IDs. Resume/upload require a root timestamp.
Audit accepts the triggering root or reply and verifies its thread before posting.
Trigger reads the exact active turn from the local DB: {channel, message_ts, thread_ts}.
Use the turn ID from this turn's artifact directory; ambient turn IDs are not used.
Posting success is JSON: {channel, ts, permalink, thread_ts, file_ids}.
Text above Slack's 4,000-character single-message boundary is delivered once as routed-request.txt.
Receipt reads handle transient lag for up to 30 seconds; no caller retry loop is needed.
Errors go to stderr; never repeat a post with an unknown/confirmed delivery outcome.`;

type Verb = "post" | "resume" | "upload" | "audit" | "thread-of" | "resolve-upload" | "permalink";
type Action = {
  verb: Verb;
  channel: string;
  threadTs?: string;
  messageTs?: string;
  text: string;
  filePaths: string[];
  fileIds: string[];
};
type Receipt = {
  channel: string;
  ts: string;
  permalink: string;
  thread_ts: string | null;
  file_ids: string[];
};
type FailureContext = {
  delivery: "not_sent" | "unknown" | "confirmed";
  channel: string;
  thread_ts: string | null;
  file_ids: string[];
  ts?: string;
  message_ts?: string;
  recover?: string[];
  retry_after_ms?: number;
};

export class RouterActionError extends Error {
  constructor(message: string, readonly exitCode = 1, readonly context?: FailureContext, readonly code = "action_failed") {
    super(message);
  }
}

class TransientReceiptError extends Error {
  constructor(message: string, readonly retryAfterMs = 0) { super(message); }
}

type ReceiptTiming = { budgetMs: number; now: () => number; sleep: (ms: number) => Promise<void> };
const receiptTiming: ReceiptTiming = { budgetMs: 30_000, now: () => performance.now(), sleep: ms => Bun.sleep(ms) };
const SLACK_ROUTER_TEXT_LIMIT = 4_000;

function timestamp(value: string | undefined): string {
  if (!value || !/^\d+\.\d+$/.test(value)) {
    throw new RouterActionError("expected a Slack timestamp (keep it as a string)", 2);
  }
  return value;
}

export function parseRouterAction(argv: string[]): Action {
  const [verb, channel, ...args] = argv;
  if (!["post", "resume", "upload", "audit", "thread-of", "resolve-upload", "permalink"].includes(verb) || !channel || channel.startsWith("--")) {
    throw new RouterActionError(usage, 2);
  }
  const action: Action = { verb: verb as Verb, channel, text: "", filePaths: [], fileIds: [] };
  if (["resume", "upload"].includes(verb)) action.threadTs = timestamp(args.shift());
  if (verb === "audit") action.messageTs = timestamp(args.shift());
  if (verb === "permalink" || verb === "thread-of") {
    action.messageTs = timestamp(args.shift());
    if (args.length) throw new RouterActionError(usage, 2);
    return action;
  }
  while (args.length) {
    const arg = args.shift()!;
    if (arg === "--") {
      action.text = args.join(" ");
      break;
    }
    if (arg === "--file" || arg.startsWith("--file=")) {
      const path = arg === "--file" ? args.shift() : arg.slice(7);
      if (!path || path.startsWith("--") || !["post", "resume", "upload"].includes(verb)) {
        throw new RouterActionError("--file requires a path and a post, resume, or upload action", 2);
      }
      action.filePaths.push(path);
    } else if (verb === "resolve-upload" && arg === "--file-id") {
      const id = args.shift();
      if (!id || !/^F[A-Z0-9]+$/.test(id)) throw new RouterActionError("--file-id requires a Slack file ID", 2);
      action.fileIds.push(id);
    } else if (verb === "resolve-upload" && arg === "--thread" && !action.threadTs) {
      action.threadTs = timestamp(args.shift());
    } else if (arg.startsWith("--")) {
      throw new RouterActionError(`unknown option: ${arg}; put literal text after --`, 2);
    } else {
      action.text = [arg, ...args].join(" ");
      break;
    }
  }
  const hasText = action.text.trim().length > 0;
  if (verb === "resolve-upload") {
    if (!action.fileIds.length || hasText) throw new RouterActionError(usage, 2);
  } else if ((!hasText && !action.filePaths.length) || (verb === "upload" && !action.filePaths.length)) {
    throw new RouterActionError(usage, 2);
  }
  return action;
}

function channelId(channel: string): string {
  if (/^[CGD][A-Z0-9]+$/.test(channel)) return channel;
  const db = new Database(process.env.CONCIERGE_STATE_DB || "/root/.local/state/concierge/state.db", { readonly: true });
  try {
    const row = db.query("SELECT slack_channel_id FROM channels WHERE slack_channel_name = ?")
      .get(channel.replace(/^#/, "")) as { slack_channel_id: string | null } | null;
    if (!row?.slack_channel_id) throw new RouterActionError(`no channel: ${channel}`);
    return row.slack_channel_id;
  } finally {
    db.close();
  }
}

function triggerIdentity(args: string[]) {
  const [turnId] = args;
  if (args.length !== 1 || !turnId || !/^[1-9]\d*$/.test(turnId) || !Number.isSafeInteger(Number(turnId))) {
    throw new RouterActionError("usage: router-actions.sh trigger <turn-id>; use the ID from this turn's artifact directory", 2);
  }
  const db = new Database(process.env.CONCIERGE_STATE_DB || "/root/.local/state/concierge/state.db", { readonly: true });
  try {
    const row = db.query(`
      SELECT session.slack_channel_id AS channel, turn.slack_user_msg_ts AS message_ts,
             turn.slack_reply_thread_ts AS thread_ts, turn.status, turn.turn_kind
      FROM turns turn JOIN sessions session ON session.id=turn.session_id
      WHERE turn.id=?
    `).get(Number(turnId));
    if (!isRecord(row)) throw new RouterActionError(`no turn: ${turnId}`);
    if (row.status !== "running") throw new RouterActionError(`turn ${turnId} is not running; use this turn's artifact ID`);
    if (row.turn_kind !== "slack_user") throw new RouterActionError(`turn ${turnId} has no Slack user trigger`);
    if (typeof row.channel !== "string" || !/^[CGD][A-Z0-9]+$/.test(row.channel)
      || typeof row.message_ts !== "string" || !/^\d+\.\d+$/.test(row.message_ts)
      || typeof row.thread_ts !== "string" || !/^\d+\.\d+$/.test(row.thread_ts)) {
      throw new RouterActionError(`turn ${turnId} has incomplete or invalid Slack trigger identity`, 1, undefined, "identity_mismatch");
    }
    return { channel: row.channel, message_ts: row.message_ts, thread_ts: row.thread_ts };
  } finally {
    db.close();
  }
}

function actionToken(verb: Verb): string {
  const config = Bun.TOML.parse(readFileSync(process.env.CONCIERGE_SLACK_CONFIG || "/root/.config/concierge/slack.toml", "utf8"));
  const key = verb === "audit" ? "bot_token" : "user_token";
  const token = config[key];
  if (typeof token !== "string" || !token) throw new RouterActionError(`${key} not found in slack.toml`);
  return token;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseWarnsOfTruncation(response: unknown): boolean {
  if (!isRecord(response)) return false;
  const warnings = new Set<string>();
  const collect = (value: unknown) => {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (typeof item !== "string") continue;
      for (const warning of item.split(",")) warnings.add(warning.trim());
    }
  };
  collect(response.warning);
  collect(response.warnings);
  if (isRecord(response.response_metadata)) collect(response.response_metadata.warnings);
  return warnings.has("message_truncated");
}

function shareTimestamp(file: unknown, fileId: string, channel: string, threadTs?: string): string {
  if (!isRecord(file) || file.id !== fileId) throw new RouterActionError(`files.info did not return requested file ${fileId}`, 1, undefined, "identity_mismatch");
  const invalid = () => new RouterActionError("files.info returned invalid share metadata");
  if (file.shares !== undefined && !isRecord(file.shares)) throw invalid();
  const matches = new Set<string>();
  let visibleShares = 0;
  for (const [visibility, channels] of Object.entries(file.shares || {})) {
    if (!["public", "private"].includes(visibility) || !isRecord(channels)) throw invalid();
    for (const [sharedChannel, shares] of Object.entries(channels)) {
      if (!Array.isArray(shares)) throw invalid();
      for (const share of shares) {
        if (!isRecord(share) || typeof share.ts !== "string" || !/^\d+\.\d+$/.test(share.ts)
          || (share.thread_ts !== undefined && (typeof share.thread_ts !== "string" || !/^\d+\.\d+$/.test(share.thread_ts)))) throw invalid();
        visibleShares += 1;
        const inThread = threadTs ? share.thread_ts === threadTs : share.thread_ts === undefined || share.thread_ts === share.ts;
        if (sharedChannel === channel && inThread) matches.add(share.ts);
      }
    }
  }
  if (!visibleShares) throw new TransientReceiptError(`file ${fileId} share is not yet visible`);
  if (!matches.size) throw new RouterActionError(`file ${fileId} has no valid share in the requested channel/thread; do not repost`, 1, undefined, "identity_mismatch");
  if (matches.size > 1) throw new RouterActionError(`file ${fileId} has ambiguous share identity in the requested channel/thread; do not repost`, 1, undefined, "ambiguous_share");
  return [...matches][0]!;
}

export async function runRouterAction(action: Action, request: typeof fetch = fetch, timing: ReceiptTiming = receiptTiming): Promise<Receipt> {
  const channel = channelId(action.channel);
  const token = actionToken(action.verb);
  const context: FailureContext = {
    delivery: "not_sent", channel, thread_ts: action.threadTs || null, file_ids: [...action.fileIds],
    ...(["audit", "thread-of"].includes(action.verb) ? { message_ts: action.messageTs } : {}),
  };
  const convertedText = toMrkdwn(action.text);
  const routedRequestBytes = Array.from(convertedText).length > SLACK_ROUTER_TEXT_LIMIT
    ? Buffer.from(action.text, "utf8")
    : null;
  const text = routedRequestBytes
    ? `Complete routed request attached as routed-request.txt (${Array.from(action.text).length} characters).`
    : convertedText;
  let threadTs = action.threadTs;
  let receiptDeadline: number | undefined;
  let retryDelayMs = 1000;
  async function readReceipt<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    receiptDeadline ??= timing.now() + timing.budgetMs;
    let lastError = "receipt read did not finish";
    const timeout = () => new RouterActionError(`receipt resolution could not finish within its ${timing.budgetMs / 1000}s budget: ${lastError}; do not repost`, 1, undefined, "receipt_timeout");
    while (timing.now() < receiptDeadline) {
      const signal = AbortSignal.timeout(Math.max(1, Math.ceil(receiptDeadline - timing.now())));
      try {
        const value = await operation(signal);
        if (timing.now() >= receiptDeadline) throw timeout();
        return value;
      } catch (error) {
        if (!(error instanceof TransientReceiptError)) throw error;
        lastError = error.message;
        const remaining = receiptDeadline - timing.now();
        if (remaining <= 0) break;
        if (error.retryAfterMs >= remaining) {
          context.retry_after_ms = error.retryAfterMs;
          throw timeout();
        }
        await timing.sleep(Math.min(remaining, Math.max(retryDelayMs, error.retryAfterMs)));
        retryDelayMs = Math.min(retryDelayMs * 2, 8000);
      }
    }
    throw timeout();
  }
  async function slack(method: string, payload: Record<string, unknown>, read = false, signal?: AbortSignal) {
    const query = new URLSearchParams(Object.entries(payload).map(([key, value]) => [key, String(value)]));
    const formEncoded = method === "files.getUploadURLExternal";
    let res: Response;
    try {
      res = await request(`https://slack.com/api/${method}${read ? `?${query}` : ""}`, {
        method: read ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": formEncoded ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8",
        },
        ...(signal ? { signal } : {}),
        ...(read ? {} : { body: formEncoded ? query : JSON.stringify(payload) }),
      });
    } catch {
      if (read) throw new TransientReceiptError(`${method}: transport failed`);
      throw new RouterActionError(`${method}: transport failed; do not repeat a possibly accepted post`);
    }
    const retryAfterSeconds = Number(res.headers.get("Retry-After"));
    const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 0;
    if (read && (res.status === 429 || res.status >= 500)) {
      void res.body?.cancel().catch(() => {});
      throw new TransientReceiptError(`${method}: HTTP ${res.status}`, retryAfterMs);
    }
    let json: any;
    try { json = await res.json(); } catch (error) {
      if (read && (signal?.aborted || !(error instanceof SyntaxError))) throw new TransientReceiptError(`${method}: response body read failed`);
      throw new RouterActionError(`${method}: invalid JSON response`);
    }
    if (!res.ok || json?.ok !== true) {
      const error = typeof json?.error === "string" && /^[a-z0-9_]+$/.test(json.error) ? json.error : `HTTP ${res.status}`;
      if (read && ["ratelimited", "internal_error", "service_unavailable", "request_timeout"].includes(error)) {
        throw new TransientReceiptError(`${method}: ${error}`, retryAfterMs);
      }
      throw new RouterActionError(`${method}: ${error}`);
    }
    return json;
  }
  function uploadRecovery() {
    context.recover = ["resolve-upload", channel, ...(threadTs ? ["--thread", threadTs] : []),
      ...context.file_ids.flatMap(id => ["--file-id", id])];
  }
  async function resolveUpload() {
    const timestamps = new Set<string>();
    for (const id of context.file_ids) {
      timestamps.add(await readReceipt(async signal => {
        const response = await slack("files.info", { file: id }, true, signal);
        return shareTimestamp(response.file, id, channel, threadTs);
      }));
      if (timestamps.size > 1) throw new RouterActionError("uploaded files do not identify one shared message; do not repost", 1, undefined, "identity_mismatch");
    }
    return [...timestamps][0]!;
  }
  async function threadOf(messageTs: string): Promise<string> {
    const response = await readReceipt(signal => slack("reactions.get", { channel, timestamp: messageTs }, true, signal));
    const message = response.message;
    if (response.type !== "message" || response.channel !== channel || message?.type !== "message" || message.ts !== messageTs) {
      throw new RouterActionError("exact message lookup did not return the requested channel and timestamp", 1, undefined, "identity_mismatch");
    }
    const rootTs = message.thread_ts === undefined ? message.ts : message.thread_ts;
    if (typeof rootTs !== "string" || !/^\d+\.\d+$/.test(rootTs)) {
      throw new RouterActionError("exact message lookup returned invalid thread identity", 1, undefined, "identity_mismatch");
    }
    return rootTs;
  }
  try {
    let ts: string;
    if (action.verb === "thread-of") {
      ts = action.messageTs!;
      threadTs = await threadOf(ts);
      context.thread_ts = threadTs;
    } else if (action.verb === "permalink") {
      ts = action.messageTs!;
    } else if (action.verb === "resolve-upload") {
      context.delivery = "unknown";
      uploadRecovery();
      ts = await resolveUpload();
      context.delivery = "confirmed";
    } else {
      if (action.verb === "audit") {
        threadTs = await threadOf(action.messageTs!);
        context.thread_ts = threadTs;
        // Preflight identity and post-write receipt resolution have separate read budgets.
        receiptDeadline = undefined;
        retryDelayMs = 1000;
      }
      // Validate every local input before reserving any upload or posting anything.
      const localFiles = action.filePaths.map(path => {
        const stat = statSync(path);
        if (!stat.isFile()) throw new RouterActionError(`not a file: ${path}`);
        return { path, title: basename(path), size: stat.size };
      });
      const files: Array<{ title: string; size: number; path?: string; bytes?: Buffer }> = [
        ...(routedRequestBytes
          ? [{ title: "routed-request.txt", size: routedRequestBytes.byteLength, bytes: routedRequestBytes }]
          : []),
        ...localFiles,
      ];
      if (files.length) {
        const uploadedFiles: { id: string; title: string }[] = [];
        for (const file of files) {
          const reserved = await slack("files.getUploadURLExternal", { filename: file.title, length: file.size });
          if (typeof reserved.upload_url !== "string" || typeof reserved.file_id !== "string" || !/^F[A-Z0-9]+$/.test(reserved.file_id)) {
            throw new RouterActionError("upload URL response missing fields");
          }
          context.file_ids.push(reserved.file_id);
          let uploaded: Response;
          try {
            uploaded = await request(reserved.upload_url, {
              method: "POST",
              headers: { "Content-Type": "application/octet-stream" },
              body: file.bytes || Bun.file(file.path!),
            });
          } catch { throw new RouterActionError("file byte upload transport failed"); }
          if (!uploaded.ok) throw new RouterActionError(`file byte upload failed: HTTP ${uploaded.status}`);
          uploadedFiles.push({ id: reserved.file_id, title: file.title });
        }
        context.delivery = "unknown";
        uploadRecovery();
        const completed = await slack("files.completeUploadExternal", {
          channel_id: channel, files: uploadedFiles,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          ...(text ? { initial_comment: text } : {}),
        });
        context.delivery = "confirmed";
        if (responseWarnsOfTruncation(completed)) {
          throw new RouterActionError(
            "Slack accepted the upload but reported that its message text was truncated; do not repost",
            1,
            context,
            "message_truncated",
          );
        }
        ts = await resolveUpload();
      } else {
        context.delivery = "unknown";
        const posted = await slack("chat.postMessage", {
          channel, text, unfurl_links: false, unfurl_media: false,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
        context.delivery = "confirmed";
        if (posted.channel !== channel || typeof posted.ts !== "string" || !/^\d+\.\d+$/.test(posted.ts)) {
          throw new RouterActionError("chat.postMessage did not return the requested channel and message timestamp; do not repost");
        }
        ts = posted.ts;
        context.ts = ts;
        if (responseWarnsOfTruncation(posted)) {
          throw new RouterActionError(
            "Slack accepted the post but reported that its message text was truncated or split; do not repost",
            1,
            context,
            "message_truncated",
          );
        }
      }
    }
    context.ts = ts;
    // File receipts retain the full file/thread proof when retrying a failed permalink read.
    if (!context.file_ids.length) context.recover = [action.verb === "thread-of" ? "thread-of" : "permalink", channel, ts];
    const linked = await readReceipt(signal => slack("chat.getPermalink", { channel, message_ts: ts }, true, signal));
    if (linked.channel !== channel || typeof linked.permalink !== "string" || !linked.permalink.startsWith("https://")) {
      throw new RouterActionError("chat.getPermalink returned an invalid message link");
    }
    return { channel, ts, permalink: linked.permalink, thread_ts: threadTs || null, file_ids: context.file_ids };
  } catch (error) {
    throw new RouterActionError(error instanceof Error ? error.message : "router action failed", 1, context,
      error instanceof RouterActionError ? error.code : "action_failed");
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "--help") {
      console.log(usage);
    } else if (args[0] === "--action" && args[1] === "trigger") {
      console.log(JSON.stringify(triggerIdentity(args.slice(2))));
    } else {
      // Preserve direct router-post.ts <channel> invocations as well as the shell API.
      const actionArgs = args[0] === "--action" ? args.slice(1) : ["post", ...args];
      console.log(JSON.stringify(await runRouterAction(parseRouterAction(actionArgs))));
    }
  } catch (error) {
    const failure = error instanceof RouterActionError ? error : new RouterActionError("router configuration or input failed");
    console.error(JSON.stringify({ ok: false, code: failure.code, error: failure.message, ...failure.context }));
    process.exitCode = failure.exitCode;
  }
}
