#!/usr/bin/env bun
// Atomic outcome-reaction for the router agent.
// Adds the outcome emoji AND removes the in-progress hourglass in one call,
// so the two never coexist on the same inbox message. Idempotent — silently
// ignores `already_reacted` and `no_reaction`.
//
// Usage: bun scripts/router-react.ts <channel-id> <message-ts> <emoji>

import { readFileSync } from "node:fs";

const [, , channelId, messageTs, emoji] = process.argv;
if (!channelId || !messageTs || !emoji) {
  console.error("usage: router-react <channel-id> <message-ts> <emoji>");
  process.exit(2);
}

const cfg = readFileSync("/root/.config/concierge/slack.toml", "utf8");
const botMatch = cfg.match(/bot_token\s*=\s*"([^"]+)"/);
if (!botMatch) {
  console.error("bot_token not found in slack.toml");
  process.exit(1);
}
const botToken = botMatch[1]!;

async function slack(method: string, body: Record<string, string>) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });
  return (await res.json()) as { ok?: boolean; error?: string };
}

const IN_PROGRESS = "hourglass_flowing_sand";

const [addResult, removeResult] = await Promise.all([
  slack("reactions.add", { channel: channelId, timestamp: messageTs, name: emoji }),
  slack("reactions.remove", { channel: channelId, timestamp: messageTs, name: IN_PROGRESS }),
]);

const addOk = addResult.ok || addResult.error === "already_reacted";
const removeOk = removeResult.ok || removeResult.error === "no_reaction";

if (!addOk) console.error(`react add failed: ${addResult.error}`);
if (!removeOk) console.error(`react remove failed: ${removeResult.error}`);
process.exit(addOk && removeOk ? 0 : 1);
