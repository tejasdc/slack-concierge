#!/usr/bin/env bun
import toml from "@iarna/toml";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const configPath = process.env.CONCIERGE_CONFIG_PATH || `${homedir()}/.config/concierge/slack.toml`;
const config: any = toml.parse(readFileSync(configPath, "utf-8"));
const token = String(config.bot_token || "");

if (!token) {
  console.error(`healthcheck: bot_token is missing from ${configPath}`);
  process.exit(2);
}

const response = await fetch("https://slack.com/api/auth.test", {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/x-www-form-urlencoded",
  },
});
const result: any = await response.json();

if (!response.ok || !result.ok) {
  console.error(`healthcheck: Slack auth.test failed (${response.status} ${result.error || "unknown_error"})`);
  process.exit(1);
}

console.log(`healthcheck: Slack authenticated as ${result.user || result.user_id || "concierge"} in ${result.team || result.team_id || "workspace"}`);
