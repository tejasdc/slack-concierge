#!/usr/bin/env bun
import toml from "@iarna/toml";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { CodexAppServerClient } from "../src/codex-app-server-client";
import { providerBrokerEnabled, verifyProviderBrokerReady } from "../src/provider-broker-client";

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

if (providerBrokerEnabled()) {
  try {
    await verifyProviderBrokerReady();
  } catch (error) {
    console.error(`healthcheck: provider broker model/list failed (${error instanceof Error ? error.message : String(error)})`);
    process.exitCode = 1;
  }
} else {
  const codex = new CodexAppServerClient();
  try {
    await codex.request("model/list", {}, { requestTimeoutMs: 10_000 });
  } catch (error) {
    console.error(`healthcheck: Codex App Server model/list failed (${error instanceof Error ? error.message : String(error)})`);
    process.exitCode = 1;
  } finally {
    await codex.close().catch(() => {});
  }
}

if (process.exitCode) process.exit(1);
console.log(`healthcheck: Slack authenticated as ${result.user || result.user_id || "concierge"} in ${result.team || result.team_id || "workspace"}; ${providerBrokerEnabled() ? "provider brokers are" : "Codex App Server is"} reachable`);
