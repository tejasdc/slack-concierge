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
  audit <channel> <thread-ts> -- <text>
  resolve-upload <channel> [--thread <thread-ts>] --file-id <id> [--file-id <id> ...]
  permalink <channel> <message-ts>
Channels may be managed names or Slack IDs. Thread timestamps must identify the root.
Posting success is JSON: {channel, ts, permalink, thread_ts, file_ids}.
Errors go to stderr; never repeat a post with an unknown/confirmed delivery outcome.`;

type Verb = "post" | "resume" | "upload" | "audit" | "resolve-upload" | "permalink";
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
  recover?: string[];
};

export class RouterActionError extends Error {
  constructor(message: string, readonly exitCode = 1, readonly context?: FailureContext) {
    super(message);
  }
}

function timestamp(value: string | undefined): string {
  if (!value || !/^\d+\.\d+$/.test(value)) {
    throw new RouterActionError("expected a Slack timestamp (keep it as a string)", 2);
  }
  return value;
}

export function parseRouterAction(argv: string[]): Action {
  const [verb, channel, ...args] = argv;
  if (!["post", "resume", "upload", "audit", "resolve-upload", "permalink"].includes(verb) || !channel || channel.startsWith("--")) {
    throw new RouterActionError(usage, 2);
  }
  const action: Action = { verb: verb as Verb, channel, text: "", filePaths: [], fileIds: [] };
  if (["resume", "upload", "audit"].includes(verb)) action.threadTs = timestamp(args.shift());
  if (verb === "permalink") {
    action.messageTs = timestamp(args.shift());
    if (args.length) throw new RouterActionError(usage, 2);
    return action;
  }
  while (args.length) {
    const arg = args.shift()!;
    if (arg === "--") {
      action.text = args.join(" ").trim();
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
      action.text = [arg, ...args].join(" ").trim();
      break;
    }
  }
  if (verb === "resolve-upload") {
    if (!action.fileIds.length || action.text) throw new RouterActionError(usage, 2);
  } else if ((!action.text && !action.filePaths.length) || (verb === "upload" && !action.filePaths.length)) {
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

function actionToken(verb: Verb): string {
  const config = Bun.TOML.parse(readFileSync(process.env.CONCIERGE_SLACK_CONFIG || "/root/.config/concierge/slack.toml", "utf8"));
  const key = verb === "audit" ? "bot_token" : "user_token";
  const token = config[key];
  if (typeof token !== "string" || !token) throw new RouterActionError(`${key} not found in slack.toml`);
  return token;
}

type SlackFile = {
  id?: string;
  shares?: Record<string, Record<string, { ts?: string; thread_ts?: string }[]>>;
};

function shareTimestamp(file: SlackFile | undefined, fileId: string, channel: string, threadTs?: string): string {
  if (file?.id !== fileId) throw new RouterActionError(`files.info did not return requested file ${fileId}`);
  const matches = new Set<string>();
  for (const visibility of ["public", "private"]) {
    for (const share of file.shares?.[visibility]?.[channel] || []) {
      const inThread = threadTs ? share.thread_ts === threadTs : !share.thread_ts || share.thread_ts === share.ts;
      if (inThread && share.ts && /^\d+\.\d+$/.test(share.ts)) matches.add(share.ts);
    }
  }
  if (matches.size !== 1) {
    throw new RouterActionError(`file ${fileId} has ${matches.size ? "ambiguous" : "not yet visible"} share identity in the requested channel/thread; do not repost`);
  }
  return [...matches][0]!;
}

export async function runRouterAction(action: Action, request: typeof fetch = fetch): Promise<Receipt> {
  const channel = channelId(action.channel);
  const token = actionToken(action.verb);
  const context: FailureContext = {
    delivery: "not_sent", channel, thread_ts: action.threadTs || null, file_ids: [...action.fileIds],
  };
  async function slack(method: string, payload: Record<string, unknown>, read = false) {
    const query = new URLSearchParams(Object.entries(payload).map(([key, value]) => [key, String(value)]));
    let res: Response;
    try {
      res = await request(`https://slack.com/api/${method}${read ? `?${query}` : ""}`, {
        method: read ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
        ...(read ? {} : { body: JSON.stringify(payload) }),
      });
    } catch {
      throw new RouterActionError(`${method}: transport failed; do not repeat a possibly accepted post`);
    }
    let json: any;
    try { json = await res.json(); } catch { throw new RouterActionError(`${method}: invalid JSON response`); }
    if (!res.ok || json?.ok !== true) {
      const error = typeof json?.error === "string" && /^[a-z0-9_]+$/.test(json.error) ? json.error : `HTTP ${res.status}`;
      throw new RouterActionError(`${method}: ${error}`);
    }
    return json;
  }
  function uploadRecovery() {
    context.recover = ["resolve-upload", channel, ...(action.threadTs ? ["--thread", action.threadTs] : []),
      ...context.file_ids.flatMap(id => ["--file-id", id])];
  }
  async function resolveUpload() {
    const timestamps = new Set<string>();
    for (const id of context.file_ids) {
      const response = await slack("files.info", { file: id }, true);
      timestamps.add(shareTimestamp(response.file, id, channel, action.threadTs));
    }
    if (timestamps.size !== 1) throw new RouterActionError("uploaded files do not identify one shared message; do not repost");
    return [...timestamps][0]!;
  }
  try {
    let ts: string;
    if (action.verb === "permalink") {
      ts = action.messageTs!;
    } else if (action.verb === "resolve-upload") {
      context.delivery = "unknown";
      uploadRecovery();
      ts = await resolveUpload();
      context.delivery = "confirmed";
    } else {
      const text = toMrkdwn(action.text);
      // Validate every local input before reserving any upload or posting anything.
      const files = action.filePaths.map(path => {
        const stat = statSync(path);
        if (!stat.isFile()) throw new RouterActionError(`not a file: ${path}`);
        return { path, title: basename(path), size: stat.size };
      });
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
              method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: Bun.file(file.path),
            });
          } catch { throw new RouterActionError("file byte upload transport failed"); }
          if (!uploaded.ok) throw new RouterActionError(`file byte upload failed: HTTP ${uploaded.status}`);
          uploadedFiles.push({ id: reserved.file_id, title: file.title });
        }
        context.delivery = "unknown";
        uploadRecovery();
        await slack("files.completeUploadExternal", {
          channel_id: channel, files: uploadedFiles,
          ...(action.threadTs ? { thread_ts: action.threadTs } : {}),
          ...(text ? { initial_comment: text } : {}),
        });
        context.delivery = "confirmed";
        ts = await resolveUpload();
      } else {
        context.delivery = "unknown";
        const posted = await slack("chat.postMessage", {
          channel, text, unfurl_links: false, unfurl_media: false,
          ...(action.threadTs ? { thread_ts: action.threadTs } : {}),
        });
        context.delivery = "confirmed";
        if (posted.channel !== channel || typeof posted.ts !== "string" || !/^\d+\.\d+$/.test(posted.ts)) {
          throw new RouterActionError("chat.postMessage did not return the requested channel and message timestamp; do not repost");
        }
        ts = posted.ts;
      }
    }
    context.ts = ts;
    // File receipts retain the full file/thread proof when retrying a failed permalink read.
    if (!context.file_ids.length) context.recover = ["permalink", channel, ts];
    const linked = await slack("chat.getPermalink", { channel, message_ts: ts }, true);
    if (linked.channel !== channel || typeof linked.permalink !== "string" || !linked.permalink.startsWith("https://")) {
      throw new RouterActionError("chat.getPermalink returned an invalid message link");
    }
    return { channel, ts, permalink: linked.permalink, thread_ts: action.threadTs || null, file_ids: context.file_ids };
  } catch (error) {
    throw new RouterActionError(error instanceof Error ? error.message : "router action failed", 1, context);
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "--help") {
      console.log(usage);
    } else {
      // Preserve direct router-post.ts <channel> invocations as well as the shell API.
      const actionArgs = args[0] === "--action" ? args.slice(1) : ["post", ...args];
      console.log(JSON.stringify(await runRouterAction(parseRouterAction(actionArgs))));
    }
  } catch (error) {
    const failure = error instanceof RouterActionError ? error : new RouterActionError("router configuration or input failed");
    console.error(JSON.stringify({ ok: false, error: failure.message, ...failure.context }));
    process.exitCode = failure.exitCode;
  }
}
