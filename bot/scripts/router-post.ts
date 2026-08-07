#!/usr/bin/env bun
// Post to a channel from the router agent (single source of truth for mrkdwn).
// Called by /root/.local/bin/router-actions.sh.
//
// Usage: bun scripts/router-post.ts <channel-name> "<text>"
// Reads user_token from /root/.config/concierge/slack.toml.
// Writes the message via Slack API as Tejas (so target-channel concierge
// treats it as a real user message and starts a session).
// The text is force-converted to Slack mrkdwn via `toMrkdwn`.

import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { toMrkdwn } from "../src/mrkdwn";

const [, , channelName, ...rest] = process.argv;
if (!channelName || rest.length === 0) {
  console.error("usage: router-post <channel-name> <text...>");
  process.exit(2);
}
const rawText = rest.join(" ");

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
const text = toMrkdwn(rawText);
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
