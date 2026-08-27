import { describe, expect, test } from "bun:test";
import {
  APP_HOME_FORK_ACTION_ID,
  APP_HOME_RENAME_ACTION_ID,
  APP_HOME_RETRY_ACTION_ID,
  APP_HOME_STOP_ACTION_ID,
  buildAgentSessionHomeView,
  buildRenameAgentSessionModal,
  parseAgentSessionActionTarget,
  parseRenameAgentSessionSubmission,
} from "../src/app-home";
import type { AgentSessionDashboardRow } from "../src/state";

function row(overrides: Partial<AgentSessionDashboardRow> = {}): AgentSessionDashboardRow {
  return {
    session_id: 1,
    slack_channel_id: "C123",
    slack_channel_name: "concierge",
    slack_thread_ts: "1787814981.610299",
    provider_id: "codex",
    provider_model: "gpt-5.6-sol",
    agent_session_uuid: "session-1",
    session_status: "running",
    title: "Build an Agent Sessions dashboard",
    turn_id: 10,
    turn_status: "running",
    user_text: "Build a useful dashboard",
    started_at: "2026-08-27 04:30:00",
    ended_at: null,
    provider_duration_ms: null,
    stop_requested_at: null,
    activity: "Editing files",
    queued_turn_count: 0,
    retryable: false,
    fork_provider_turn_id: "turn-complete",
    deployment_state: "deployed",
    ...overrides,
  };
}

function actionIds(view: ReturnType<typeof buildAgentSessionHomeView>) {
  return view.blocks.flatMap((block: any) => [
    block.accessory?.action_id,
    ...(block.elements || []).map((element: any) => element.action_id),
  ]).filter(Boolean);
}

describe("Agent Sessions App Home", () => {
  test("renders real controls for running, retryable, and completed sessions", () => {
    const view = buildAgentSessionHomeView({
      teamId: "T123",
      workspaceUrl: "https://tejazz.slack.com/",
      nowMs: Date.parse("2026-08-27T04:32:00Z"),
      rows: [
        row(),
        row({ session_id: 2, turn_id: 20, turn_status: "parked", retryable: true, title: "Repair provider access" }),
        row({ session_id: 3, turn_id: 30, turn_status: "done", session_status: "idle", title: "Audit Slack UI" }),
      ],
    });
    const ids = actionIds(view);
    expect(view.type).toBe("home");
    expect(view.blocks.length).toBeLessThanOrEqual(100);
    expect(ids).toContain(APP_HOME_STOP_ACTION_ID);
    expect(ids).toContain(APP_HOME_RETRY_ACTION_ID);
    expect(ids).toContain(APP_HOME_FORK_ACTION_ID);
    expect(ids.filter(id => id === APP_HOME_FORK_ACTION_ID)).toHaveLength(2);
    expect(ids.filter(id => id === APP_HOME_RENAME_ACTION_ID)).toHaveLength(3);
    expect(JSON.stringify(view)).toContain("Working · 2m");
    expect(JSON.stringify(view)).toContain("<https://tejazz.slack.com/archives/C123/p1787814981610299?thread_ts=1787814981.610299&cid=C123");
    expect(JSON.stringify(view)).toContain("|Open in main pane>");
    expect(JSON.stringify(view)).toContain("🚀 Deployed");
    expect(view.blocks.some((block: any) => block.accessory?.url)).toBe(false);
  });

  test("does not offer unsafe or stale controls", () => {
    const view = buildAgentSessionHomeView({
      teamId: null,
      rows: [row({ turn_status: "parked", retryable: false, agent_session_uuid: null })],
    });
    const ids = actionIds(view);
    expect(ids).not.toContain(APP_HOME_STOP_ACTION_ID);
    expect(ids).not.toContain(APP_HOME_RETRY_ACTION_ID);
    expect(ids).not.toContain(APP_HOME_FORK_ACTION_ID);
    expect(ids).toContain(APP_HOME_RENAME_ACTION_ID);
  });

  test("waits for a stable boundary before offering a live fork", () => {
    const view = buildAgentSessionHomeView({
      teamId: "T123",
      rows: [
        row({ fork_provider_turn_id: null }),
        row({ session_id: 2, provider_id: "claude-code", fork_provider_turn_id: null }),
      ],
    });
    expect(actionIds(view)).not.toContain(APP_HOME_FORK_ACTION_ID);
  });

  test("renders an instructive empty state", () => {
    const view = buildAgentSessionHomeView({ rows: [], teamId: "T123" });
    expect(JSON.stringify(view)).toContain("No Agent Sessions yet");
    expect(JSON.stringify(view)).toContain("Start a conversation");
  });

  test("round-trips bounded action targets and rename submissions", () => {
    const modal = buildRenameAgentSessionModal(row());
    const target = parseAgentSessionActionTarget(modal.private_metadata);
    expect(target).toEqual({
      version: 1,
      sessionId: 1,
      channel: "C123",
      threadTs: "1787814981.610299",
      turnId: 10,
      forkProviderTurnId: "turn-complete",
    });
    expect(parseAgentSessionActionTarget('{"version":1,"sessionId":1,"channel":"bad","threadTs":"x"}')).toBeNull();
    expect(parseRenameAgentSessionSubmission({
      private_metadata: modal.private_metadata,
      state: { values: { agent_session_title: { agent_session_title: { value: "  A clearer   title  " } } } },
    })).toMatchObject({ title: "A clearer title", target });
  });
});
