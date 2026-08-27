#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { appendTodoFile } from "../src/todo-file";

const [, , channelName, sourceChannelId, sourceMessageTs, separator, ...textParts] = process.argv;
const text = textParts.join(" ").trim();
if (!channelName || !sourceChannelId || !sourceMessageTs || separator !== "--" || !text) {
  console.error("usage: router-todo <channel-name> <source-channel-id> <source-message-ts> -- <item-text>");
  process.exit(2);
}

const statePath = process.env.CONCIERGE_STATE_DB || "/root/.local/state/concierge/state.db";
const configPath = process.env.CONCIERGE_SLACK_CONFIG || "/root/.config/concierge/slack.toml";
const db = new Database(statePath);
db.exec("PRAGMA busy_timeout = 5000");
const channel = db.query(`
  SELECT slack_channel_name, vault_path
  FROM channels
  WHERE slack_channel_name = ? AND slack_channel_id IS NOT NULL
`).get(channelName) as { slack_channel_name: string; vault_path: string } | null;
if (!channel) {
  db.close();
  console.error(`no channel: ${channelName}`);
  process.exit(1);
}

const config = readFileSync(configPath, "utf8");
const secret = config.match(/signing_secret\s*=\s*"([^"]+)"/)?.[1];
if (!secret) {
  console.error("signing_secret not found in slack.toml");
  process.exit(1);
}

const contentIdentity = createHash("sha256").update(text).digest("hex");
const path = appendTodoFile(db, {
  path: join(channel.vault_path, "notes", "TODOS.md"),
  channelName: channel.slack_channel_name,
  text,
  idempotencyKey: `router:${sourceChannelId}:${sourceMessageTs}:${contentIdentity}`,
  idempotencySecret: secret,
  slackOrigin: { channel: sourceChannelId, ts: sourceMessageTs },
});
db.close();
console.log(path);
