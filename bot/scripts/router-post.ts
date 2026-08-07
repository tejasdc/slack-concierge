#!/usr/bin/env bun
// Post to a channel from the router agent (single source of truth for mrkdwn).
// Called by /root/.local/bin/router-actions.sh.
//
// Usage:
//   bun scripts/router-post.ts <channel-name> "<text>"
//   bun scripts/router-post.ts <channel-name> --file <path> [--file <path> ...] -- "<text>"
// Reads user_token from /root/.config/concierge/slack.toml.
// Writes the message via Slack API as Tejas (so target-channel concierge
// treats it as a real user message and starts a session).
// The text is force-converted to Slack mrkdwn via `toMrkdwn`.

import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { Database } from "bun:sqlite";
import { toMrkdwn } from "../src/mrkdwn";

const [, , channelName, ...args] = process.argv;
if (!channelName || args.length === 0) {
  console.error("usage: router-post <channel-name> [--file <path> ... --] <text...>");
  process.exit(2);
}

const parsed = parseArgs(args);
if (!parsed.text && parsed.filePaths.length === 0) {
  console.error("router-post needs text, files, or both");
  process.exit(2);
}

const cfg = readFileSync("/root/.config/concierge/slack.toml", "utf8");
const userMatch = cfg.match(/user_token\s*=\s*"([^"]+)"/);
if (!userMatch) {
  console.error("user_token not found in slack.toml");
  process.exit(1);
}
const userToken = userMatch[1]!;

const db = new Database("/root/.local/state/concierge/state.db", { readonly: true });
const row = db
  .query("SELECT slack_channel_id FROM channels WHERE slack_channel_name = ?")
  .get(channelName) as { slack_channel_id?: string } | undefined;
db.close();
const channelId = row?.slack_channel_id;
if (!channelId) {
  console.error(`no channel: ${channelName}`);
  process.exit(1);
}

const text = toMrkdwn(parsed.text);
if (parsed.filePaths.length > 0) {
  const uploadedFiles = [];
  for (const path of parsed.filePaths) {
    uploadedFiles.push(await uploadFile(path, userToken));
  }
  const completed = await slackApi("files.completeUploadExternal", userToken, {
    channel_id: channelId,
    files: uploadedFiles.map((file) => ({ id: file.id, title: file.title })),
    ...(text ? { initial_comment: text } : {}),
  });
  console.log(firstShareTs(completed, channelId) || uploadedFiles.map((file) => file.id).join(","));
} else {
  const body = new URLSearchParams({
    channel: channelId,
    text,
    unfurl_links: "false",
    unfurl_media: "false",
  });
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${userToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const json = (await res.json()) as { ok?: boolean; ts?: string; error?: string };
  if (!json.ok) {
    console.error(`post failed: ${json.error}`);
    process.exit(1);
  }
  console.log(json.ts ?? "");
}

function parseArgs(input: string[]) {
  const filePaths: string[] = [];
  let textParts: string[] = [];
  for (let idx = 0; idx < input.length; idx += 1) {
    const arg = input[idx];
    if (arg === "--") {
      textParts = input.slice(idx + 1);
      break;
    }
    if (arg === "--file") {
      const value = input[idx + 1];
      if (!value) {
        console.error("--file requires a path");
        process.exit(2);
      }
      filePaths.push(value);
      idx += 1;
      continue;
    }
    if (arg.startsWith("--file=")) {
      filePaths.push(arg.slice("--file=".length));
      continue;
    }
    textParts = input.slice(idx);
    break;
  }
  return { filePaths, text: textParts.join(" ").trim() };
}

async function uploadFile(path: string, token: string) {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`not a file: ${path}`);
  const title = basename(path);
  const reserved = await slackApi("files.getUploadURLExternal", token, {
    filename: title,
    length: stat.size,
  }, "form") as { upload_url?: string; file_id?: string };
  if (!reserved.upload_url || !reserved.file_id) {
    throw new Error(`upload URL response missing fields for ${path}`);
  }
  const uploadRes = await fetch(reserved.upload_url, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: Bun.file(path),
  });
  if (!uploadRes.ok) {
    throw new Error(`file byte upload failed for ${path}: HTTP ${uploadRes.status}`);
  }
  return { id: reserved.file_id, title };
}

async function slackApi(method: string, token: string, payload: Record<string, unknown>, encoding: "json" | "form" = "json") {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": encoding === "json" ? "application/json; charset=utf-8" : "application/x-www-form-urlencoded",
    },
    body: encoding === "json" ? JSON.stringify(payload) : formBody(payload),
  });
  const json = await res.json() as { ok?: boolean; error?: string };
  if (!json.ok) {
    console.error(`${method} failed: ${json.error || `HTTP ${res.status}`}`);
    process.exit(1);
  }
  return json;
}

function formBody(payload: Record<string, unknown>) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) body.set(key, String(value));
  return body.toString();
}

function firstShareTs(response: any, channelId: string) {
  for (const file of response?.files || []) {
    const shares = file?.shares || {};
    for (const bucket of [shares.public, shares.private]) {
      const channelShares = bucket?.[channelId];
      if (Array.isArray(channelShares) && channelShares[0]?.ts) return channelShares[0].ts;
    }
  }
  return null;
}
