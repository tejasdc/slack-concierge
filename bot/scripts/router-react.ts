#!/usr/bin/env bun
// Outcome-reaction projection for the router agent. Adds the outcome emoji and
// removes the in-progress hourglass in one invocation. Slack keeps those writes
// non-atomic, so the receipt reports both results explicitly; idempotent
// outcomes remain successful.
//
// Usage: bun scripts/router-react.ts <channel-id> <message-ts> <emoji>

import { readFileSync } from "node:fs";

const [, , channelId, messageTs, emoji] = process.argv;
if (!channelId || !/^[CGD][A-Z0-9]+$/.test(channelId)
    || !messageTs || !/^\d+\.\d+$/.test(messageTs)
    || !emoji || !/^[A-Za-z0-9_+-]+$/.test(emoji)) {
  console.error(JSON.stringify({
    ok: false,
    error: "usage",
    detail: "usage: router-react <channel-id> <message-ts> <emoji>",
  }));
  process.exit(2);
}

type SlackReactionResponse =
  | { ok: true }
  | { ok: false; error: string };

async function slack(botToken: string, method: string, body: Record<string, string>): Promise<SlackReactionResponse> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) throw new Error(`Slack ${method} returned HTTP ${res.status}`);
  const response: unknown = await res.json();
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error(`Slack ${method} returned a malformed response`);
  }
  const { ok, error } = response as Record<string, unknown>;
  if (ok === true) return { ok: true };
  if (ok === false && typeof error === "string" && error.length > 0) return { ok: false, error };
  throw new Error(`Slack ${method} returned a malformed response`);
}

const IN_PROGRESS = "hourglass_flowing_sand";

try {
  const configPath = process.env.CONCIERGE_SLACK_CONFIG || "/root/.config/concierge/slack.toml";
  const cfg = readFileSync(configPath, "utf8");
  const botMatch = cfg.match(/bot_token\s*=\s*"([^"]+)"/);
  if (!botMatch) throw new Error("Slack configuration is missing bot_token");
  const botToken = botMatch[1]!;
  const [addResult, removeResult] = await Promise.all([
    slack(botToken, "reactions.add", { channel: channelId, timestamp: messageTs, name: emoji }),
    slack(botToken, "reactions.remove", { channel: channelId, timestamp: messageTs, name: IN_PROGRESS }),
  ]);

  const outcomeReaction = addResult.ok
    ? "added"
    : addResult.error === "already_reacted" ? "already_reacted" : "failed";
  const inProgressReaction = removeResult.ok
    ? "removed"
    : removeResult.error === "no_reaction" ? "already_absent" : "failed";
  const ok = outcomeReaction !== "failed" && inProgressReaction !== "failed";
  const receipt = {
    ok,
    channel: channelId,
    message_ts: messageTs,
    reaction: emoji,
    outcome_reaction: outcomeReaction,
    in_progress_reaction: inProgressReaction,
    ...(!addResult.ok && addResult.error !== "already_reacted" ? { add_error: addResult.error || "unknown_error" } : {}),
    ...(!removeResult.ok && removeResult.error !== "no_reaction" ? { remove_error: removeResult.error || "unknown_error" } : {}),
  };
  if (ok) console.log(JSON.stringify(receipt));
  else {
    console.error(JSON.stringify({ ...receipt, error: "reaction_projection_failed" }));
    process.exitCode = 1;
  }
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: "reaction_projection_unproven",
    channel: channelId,
    message_ts: messageTs,
    reaction: emoji,
    detail: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
}
