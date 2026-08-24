#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import {
  BrokeredCodexAppServerClient,
  loadProviderProjectRegistry,
  resolveProviderProject,
} from "../../bot/src/provider-broker-client";

const stateDirectory = process.env.CONCIERGE_STATE_DIR || "/var/lib/concierge-bot/state";
const registryPath = process.env.CONCIERGE_PROVIDER_PROJECTS_PATH
  || "/var/lib/concierge-bot/provider-projects.json";

if (process.geteuid?.() === 0 && process.env.CONCIERGE_PROVIDER_CONTINUITY_ALLOW_ROOT !== "1") {
  throw new Error("Provider continuity must run as the application principal.");
}

const registry = loadProviderProjectRegistry(registryPath);
const database = new Database(`${stateDirectory}/state.db`, { readonly: true, strict: true });
let codexSessions = 0;
let claudeSessions = 0;
try {
  const sessions = database.query(`
    SELECT s.id, s.provider_id, s.agent_session_uuid, s.provider_binding_token,
           COALESCE(c.code_path, c.vault_path) AS project_path
    FROM sessions s JOIN channels c ON c.slack_channel_id=s.slack_channel_id
    WHERE s.agent_session_uuid IS NOT NULL ORDER BY s.id
  `).all() as Array<{
    id: number;
    provider_id: "codex" | "claude-code";
    agent_session_uuid: string;
    provider_binding_token: string | null;
    project_path: string;
  }>;
  for (const session of sessions) {
    if (!session.provider_binding_token) throw new Error(`Session ${session.id} lacks a provider binding token.`);
    const project = resolveProviderProject(session.project_path, registry);
    if (session.provider_id === "claude-code") {
      claudeSessions += 1;
      continue;
    }
    const client = new BrokeredCodexAppServerClient(project.socket_path, session.provider_binding_token);
    try {
      const response = await client.request("thread/read", {
        threadId: session.agent_session_uuid,
        includeTurns: false,
      }, { requestTimeoutMs: 30_000 });
      if (String(response?.thread?.id || "") !== session.agent_session_uuid) {
        throw new Error(`Provider history read returned the wrong session for ${session.id}.`);
      }
      codexSessions += 1;
    } finally {
      await client.close();
    }
  }
} finally {
  database.close();
}

console.log(JSON.stringify({ status: "passed", codex_sessions: codexSessions, claude_sessions: claudeSessions }));
