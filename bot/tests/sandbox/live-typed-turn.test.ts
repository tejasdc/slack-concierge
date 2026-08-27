import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaneFixtureIdentities } from "../../scripts/sandbox-provision";
import {
  LiveTypedTurnAdapter,
  LiveTypedTurnError,
  slackUserCallerFromConfig,
  type TypedTurnSlackCaller,
} from "./adapters/live-typed-turn";
import { runTypedTurnCase } from "./cases/typed-turn.case";
import { assertBrowserRequestMatchesLane, type BrowserCaptureRequest, type SandboxBrowser } from "./support/browser";
import { SandboxEvidenceWriter, type ScreenshotEvidence } from "./support/evidence";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "sandbox-live-typed-turn-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

const fixtures: LaneFixtureIdentities = {
  schema_version: 1,
  lane_id: "lane-1",
  app_id: "AAPP1",
  team_id: "TSANDBOX1",
  bot_user_id: "UBOT1",
  bot_id: "BBOT1",
  manifest_digest: "a".repeat(64),
  installer_user_id: "UINSTALLER1",
  dm_channel_id: "DDM1",
  channels: {
    core: { id: "CCORE1", name: "concierge-lane-1-core" },
    project: { id: "CPROJECT1", name: "concierge-lane-1-project" },
    capture: { id: "CCAPTURE1", name: "concierge-lane-1-capture" },
  },
  browser: {
    namespace: "concierge-sandbox-lane-1",
    profile_path: "/tmp/concierge-sandbox-browser/lane-1",
    client_workspace_id: "EENTERPRISE1",
    canonical_workspace_domain: "sandbox-workspace.slack.com",
  },
};

type Harness = {
  root: string;
  runRoot: string;
  databasePath: string;
  configPath: string;
  runMetadataPath: string;
  readyPath: string;
};

function createStateDatabase(path: string): void {
  const database = new Database(path, { create: true });
  database.exec(`
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY,
      slack_channel_id TEXT NOT NULL,
      slack_thread_ts TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      agent_session_uuid TEXT,
      status TEXT NOT NULL
    );
    CREATE TABLE turns (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL,
      slack_user_msg_ts TEXT NOT NULL,
      slack_reply_thread_ts TEXT,
      user_text TEXT NOT NULL,
      status TEXT NOT NULL,
      delivery_status TEXT NOT NULL,
      outbound_text TEXT,
      response_tldr TEXT,
      provider_duration_ms INTEGER,
      provider_turn_id TEXT,
      status_projection_status TEXT NOT NULL DEFAULT 'not_needed'
    );
    CREATE TABLE slack_user_input_claims (
      slack_channel_id TEXT NOT NULL,
      slack_user_msg_ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      user_id TEXT,
      user_text TEXT,
      files_json TEXT NOT NULL,
      turn_id INTEGER
    );
    CREATE TABLE turn_delivery_chunks (
      turn_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      slack_ts TEXT,
      delivered_at TEXT
    );
    CREATE TABLE turn_steering_messages (status TEXT NOT NULL);
    CREATE TABLE agent_progress_messages (creation_state TEXT NOT NULL, dirty INTEGER NOT NULL);
    CREATE TABLE turn_artifact_batches (status TEXT NOT NULL);
    CREATE TABLE turn_artifact_deliveries (status TEXT NOT NULL);
    CREATE TABLE slack_thread_statuses (projection_status TEXT NOT NULL);
    CREATE TABLE slack_root_summary_projections (projection_status TEXT NOT NULL);
    CREATE TABLE slack_agent_session_status_projections (projection_status TEXT NOT NULL);
    CREATE TABLE turn_reaction_cleanups (cleanup_status TEXT NOT NULL);
  `);
  database.close();
}

function createHarness(): Harness {
  const root = scratch();
  const runRoot = join(root, "lanes", "lane-1", "runs", "run-1");
  const stateDirectory = join(runRoot, "state");
  const configPath = join(root, "config", "lanes", "lane-1", "slack.toml");
  const readyPath = join(stateDirectory, "ready.json");
  const runMetadataPath = join(runRoot, "run.json");
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "config", "lanes", "lane-1"), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, "user_token = \"xoxp-offline-test\"\n", { mode: 0o600 });
  writeFileSync(readyPath, `${JSON.stringify({
    schema_version: 1,
    pid: 43210,
    run_id: "run-1",
    lane: 1,
    team_id: fixtures.team_id,
    app_id: fixtures.app_id,
    bot_user_id: fixtures.bot_user_id,
    bot_id: fixtures.bot_id,
    ready_at: "2026-08-27T12:00:00.000Z",
  })}\n`, { mode: 0o600 });
  writeFileSync(runMetadataPath, `${JSON.stringify({
    run_id: "run-1",
    lane: 1,
    status: "running",
    generation: 1,
    source: {
      git_sha: "a".repeat(40),
      branch: "worktree-test",
      dirty_digest: null,
      source_id: "a".repeat(40),
    },
    candidate: { pid: 43210 },
    lane_identity: {
      team_id: fixtures.team_id,
      app_id: fixtures.app_id,
      bot_user_id: fixtures.bot_user_id,
      bot_id: fixtures.bot_id,
    },
    lane_fixtures: {
      lane_id: fixtures.lane_id,
      installer_user_id: fixtures.installer_user_id,
      browser: {
        client_workspace_id: fixtures.browser.client_workspace_id,
        canonical_workspace_domain: fixtures.browser.canonical_workspace_domain,
      },
    },
    paths: { config: configPath, fixtures: "unused", state: stateDirectory, ready_file: readyPath },
  })}\n`, { mode: 0o600 });
  const databasePath = join(stateDirectory, "state.db");
  createStateDatabase(databasePath);
  return { root, runRoot, databasePath, configPath, runMetadataPath, readyPath };
}

function persistRunningTurn(databasePath: string, inputText: string, inputTs: string): void {
  const database = new Database(databasePath);
  database.transaction(() => {
    database.query(`INSERT INTO sessions
      (id, slack_channel_id, slack_thread_ts, provider_id, agent_session_uuid, status)
      VALUES (7, ?, ?, 'codex', 'provider-session-7', 'running')`).run(fixtures.channels.core.id, inputTs);
    database.query(`INSERT INTO turns
      (id, session_id, slack_user_msg_ts, slack_reply_thread_ts, user_text, status,
       delivery_status, provider_turn_id, status_projection_status)
      VALUES (42, 7, ?, ?, ?, 'running', 'not_ready', 'provider-turn-42', 'not_needed')`)
      .run(inputTs, inputTs, inputText);
    database.query(`INSERT INTO slack_user_input_claims
      (slack_channel_id, slack_user_msg_ts, kind, user_id, user_text, files_json, turn_id)
      VALUES (?, ?, 'turn', ?, ?, '[]', 42)`)
      .run(fixtures.channels.core.id, inputTs, fixtures.installer_user_id, inputText);
  })();
  database.close();
}

function finishTurn(databasePath: string, outputText: string, responseTldr: string): void {
  const database = new Database(databasePath);
  database.transaction(() => {
    database.query(`UPDATE turns SET status='done', delivery_status='delivered', outbound_text=?,
      response_tldr=?, provider_duration_ms=4000 WHERE id=42`).run(outputText, responseTldr);
    database.query("UPDATE sessions SET status='idle' WHERE id=7").run();
    database.query(`INSERT INTO turn_delivery_chunks
      (turn_id, chunk_index, slack_ts, delivered_at)
      VALUES (42, 0, '1788000001.000001', '2026-08-27 12:00:01')`).run();
  })();
  database.close();
}

function liveSlack(databasePath: string, responseAppId = fixtures.app_id): TypedTurnSlackCaller {
  let inputText = "";
  let inputClientMessageId = "";
  let terminal = false;
  return async (method, body) => {
    if (method === "auth.test") {
      return {
        ok: true,
        team_id: fixtures.team_id,
        user_id: fixtures.installer_user_id,
        url: `https://${fixtures.browser.canonical_workspace_domain}/`,
      };
    }
    if (method === "chat.postMessage") {
      inputText = String(body.text);
      inputClientMessageId = String(body.client_msg_id);
      persistRunningTurn(databasePath, inputText, "1788000000.000001");
      return {
        ok: true,
        channel: fixtures.channels.core.id,
        ts: "1788000000.000001",
        message: {
          ts: "1788000000.000001",
          user: fixtures.installer_user_id,
          text: inputText,
          client_msg_id: inputClientMessageId,
        },
      };
    }
    if (method === "chat.getPermalink") {
      const timestamp = String(body.message_ts).replace(".", "");
      const query = body.message_ts !== "1788000000.000001"
        ? "?thread_ts=1788000000.000001&cid=CCORE1"
        : "";
      return {
        ok: true,
        permalink: `https://${fixtures.browser.canonical_workspace_domain}/archives/${fixtures.channels.core.id}/p${timestamp}${query}`,
      };
    }
    if (method === "conversations.replies") {
      const marker = /SANDBOX_TYPED_TURN_[A-Z0-9]+/.exec(inputText)?.[0] || "missing-marker";
      const responseTldr = `${marker} provider lifecycle accepted.`;
      const outputText = [
        `TL;DR: ${responseTldr}`,
        "",
        "| File | Role | Lifetime |",
        "| --- | --- | --- |",
        "| AGENTS.md | Instructions | Long-lived |",
        "| notes/inbox.md | Capture | Ephemeral |",
        "| notes/TODOS.md | Actions | Active |",
      ].join("\n");
      const rootText = terminal
        ? `${inputText}\n\n━━━━━━━━━━━━━━━━━━━━\n*Concierge TL;DR*\n${responseTldr}`
        : inputText;
      const tableRows = [
        ["File", "Role", "Lifetime"],
        ["AGENTS.md", "Instructions", "Long-lived"],
        ["notes/inbox.md", "Capture", "Ephemeral"],
        ["notes/TODOS.md", "Actions", "Active"],
      ];
      const responseBlocks = [
        { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: `TL;DR: ${responseTldr}\n\n` }] }] },
        { type: "table", rows: tableRows.map((row) => row.map((text) => ({
          type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }],
        }))) },
      ];
      const result = {
        ok: true,
        messages: [{
          ts: "1788000000.000001",
          user: fixtures.installer_user_id,
          text: rootText,
        }, {
          ts: "1788000000.500001",
          thread_ts: "1788000000.000001",
          user: fixtures.bot_user_id,
          bot_id: fixtures.bot_id,
          app_id: fixtures.app_id,
          text: "Agent task progress",
          blocks: [{ type: "task_card", task_id: terminal ? "activity-terminal-42" : "activity-running-42",
            title: terminal ? "Work complete · 4s" : "Thinking · 2s elapsed",
            status: terminal ? "complete" : "in_progress" }],
        }, ...(terminal ? [{
          ts: "1788000001.000001",
          thread_ts: "1788000000.000001",
          user: fixtures.bot_user_id,
          bot_id: fixtures.bot_id,
          app_id: responseAppId,
          text: outputText.replace(/\s+/g, " ").trim(),
          blocks: responseBlocks,
        }] : [])],
      };
      if (!terminal) {
        terminal = true;
        finishTurn(databasePath, outputText, responseTldr);
      }
      return result;
    }
    throw new Error(`unexpected Slack method ${method}`);
  };
}

class FakeBrowser implements SandboxBrowser {
  requests: BrowserCaptureRequest[] = [];

  constructor(private readonly runRoot: string) {}

  async capture(request: BrowserCaptureRequest): Promise<ScreenshotEvidence> {
    assertBrowserRequestMatchesLane(request, fixtures);
    this.requests.push(request);
    const directory = join(this.runRoot, "browser");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const screenshot = join(directory, `${request.phase}.png`);
    const accessibility = join(directory, `${request.phase}-accessibility.json`);
    const geometry = join(directory, `${request.phase}-geometry.json`);
    writeFileSync(screenshot, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lMZzWQAAAABJRU5ErkJggg==",
      "base64",
    ));
    writeFileSync(accessibility, "{}");
    writeFileSync(geometry, "{}");
    return {
      phase: request.phase,
      permalink: request.permalink,
      client_workspace_id: fixtures.browser.client_workspace_id,
      canonical_workspace_domain: fixtures.browser.canonical_workspace_domain,
      channel_id: request.channel_id,
      message_ts: request.message_ts,
      screenshot_path: screenshot,
      screenshot_sha256: "",
      accessibility_path: accessibility,
      geometry_path: geometry,
    };
  }
}

describe("live typed-turn sandbox adapter", () => {
  test("uses Slack's query contract for permalink and reply reads", async () => {
    const harness = createHarness();
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const requester = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: new URL(String(input)), init: init || {} });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const caller = slackUserCallerFromConfig(harness.configPath, requester);
    await caller("chat.getPermalink", { channel: "CCORE1", message_ts: "1788000000.000001" });
    await caller("conversations.replies", { channel: "CCORE1", ts: "1788000000.000001", limit: 100 });
    await caller("chat.postMessage", { channel: "CCORE1", text: "test" });

    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.url.searchParams.get("message_ts")).toBe("1788000000.000001");
    expect(calls[0]?.init.body).toBeUndefined();
    expect(calls[1]?.init.method).toBe("GET");
    expect(calls[1]?.url.searchParams.get("ts")).toBe("1788000000.000001");
    expect(calls[2]?.init.method).toBe("POST");
    expect(calls[2]?.init.body).toBe(JSON.stringify({ channel: "CCORE1", text: "test" }));
  });

  test("proves one real run-owned input through provider identities, Slack delivery, visual proof, and drain", async () => {
    const harness = createHarness();
    const adapter = new LiveTypedTurnAdapter({
      lane: fixtures,
      workspaceDomain: "concierge--sandbox.enterprise.slack.com",
      runId: "run-1",
      stateRoot: harness.root,
      configPath: harness.configPath,
      slack: liveSlack(harness.databasePath),
      pollIntervalMs: 1,
    });
    const evidence = new SandboxEvidenceWriter("lane-1", "run-1", harness.root);
    const browser = new FakeBrowser(evidence.runRoot);
    const result = await runTypedTurnCase({
      lane: fixtures,
      workspaceDomain: "concierge--sandbox.enterprise.slack.com",
      runId: "run-1",
      expectedProvider: "codex",
      adapter,
      browser,
      evidence,
    });

    expect(result.status).toBe("passed");
    expect(result.observation).toMatchObject({
      turn_id: 42,
      provider_session_uuid: "provider-session-7",
      provider_turn_id: "provider-turn-42",
      response_message_ts: "1788000001.000001",
      marker_count: 1,
    });
    expect(result.drain).toEqual({ run_owned_unsettled: 0, input_claims: 1, turns: 1, delivered_responses: 1 });
    expect(result.browser.running.client_workspace_id).toBe("EENTERPRISE1");
    expect(adapter.runSourceEvidence()).toEqual({
      source_head: "a".repeat(40),
      source_branch: "worktree-test",
      source_diff_digest: "clean",
      source_id: "a".repeat(40),
      generation: 1,
    });
    expect(browser.requests).toHaveLength(2);
    expect(browser.requests[0]).toMatchObject({
      message_ts: "1788000000.500001",
      thread_ts: "1788000000.000001",
      required_text: ["elapsed"],
    });
  });

  test("fails closed when Slack-visible terminal delivery belongs to another app", async () => {
    const harness = createHarness();
    const adapter = new LiveTypedTurnAdapter({
      lane: fixtures,
      workspaceDomain: "concierge--sandbox.enterprise.slack.com",
      runId: "run-1",
      stateRoot: harness.root,
      configPath: harness.configPath,
      slack: liveSlack(harness.databasePath, "AOTHER"),
      pollIntervalMs: 1,
    });
    const evidence = new SandboxEvidenceWriter("lane-1", "run-1", harness.root);
    await expect(runTypedTurnCase({
      lane: fixtures,
      workspaceDomain: "concierge--sandbox.enterprise.slack.com",
      runId: "run-1",
      expectedProvider: "codex",
      adapter,
      browser: new FakeBrowser(evidence.runRoot),
      evidence,
    })).rejects.toMatchObject({ code: "slack_terminal_delivery_mismatch" });
  });

  test("rejects a stale or cross-run ready receipt before any Slack operation", () => {
    const harness = createHarness();
    const ready = JSON.parse(readFileSync(harness.readyPath, "utf8"));
    writeFileSync(harness.readyPath, `${JSON.stringify({ ...ready, app_id: "AOTHER" })}\n`, { mode: 0o600 });
    let slackCalls = 0;
    expect(() => new LiveTypedTurnAdapter({
      lane: fixtures,
      workspaceDomain: "concierge--sandbox.enterprise.slack.com",
      runId: "run-1",
      stateRoot: harness.root,
      configPath: harness.configPath,
      slack: async () => { slackCalls += 1; return {}; },
    })).toThrow(LiveTypedTurnError);
    expect(slackCalls).toBe(0);
  });

  test("rejects a source or generation change during acceptance", () => {
    const harness = createHarness();
    const adapter = new LiveTypedTurnAdapter({
      lane: fixtures,
      workspaceDomain: "concierge--sandbox.enterprise.slack.com",
      runId: "run-1",
      stateRoot: harness.root,
      configPath: harness.configPath,
      slack: async () => ({}),
    });
    const run = JSON.parse(readFileSync(harness.runMetadataPath, "utf8"));
    writeFileSync(harness.runMetadataPath, `${JSON.stringify({ ...run, generation: 2 })}\n`, { mode: 0o600 });
    expect(() => adapter.runSourceEvidence()).toThrow(
      expect.objectContaining({ code: "run_source_changed" }),
    );
  });
});
