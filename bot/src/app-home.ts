import type { AgentSessionDashboardRow } from "./state";
import { slackMessageSourceUrl } from "./slack-links";

export const APP_HOME_REFRESH_ACTION_ID = "agent_sessions_home_refresh";
export const APP_HOME_OPEN_ACTION_ID = "agent_sessions_home_open";
export const APP_HOME_STOP_ACTION_ID = "agent_sessions_home_stop";
export const APP_HOME_RENAME_ACTION_ID = "agent_sessions_home_rename";
export const APP_HOME_RETRY_ACTION_ID = "agent_sessions_home_retry";
export const APP_HOME_FORK_ACTION_ID = "agent_sessions_home_fork";
export const APP_HOME_RENAME_VIEW_ID = "agent_sessions_home_rename_view";
export const APP_HOME_RENAME_INPUT_ID = "agent_session_title";

export interface AgentSessionActionTarget {
  version: 1;
  sessionId: number;
  channel: string;
  threadTs: string;
  turnId?: number;
}

function escapeMrkdwn(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(value: string, limit: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  const characters = Array.from(normalized);
  return characters.length <= limit ? normalized : `${characters.slice(0, limit - 1).join("").trimEnd()}…`;
}

function actionTarget(row: AgentSessionDashboardRow): string {
  return JSON.stringify({
    version: 1,
    sessionId: row.session_id,
    channel: row.slack_channel_id,
    threadTs: row.slack_thread_ts,
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
  } satisfies AgentSessionActionTarget);
}

export function parseAgentSessionActionTarget(value: unknown): AgentSessionActionTarget | null {
  if (typeof value !== "string" || value.length > 1000) return null;
  try {
    const parsed = JSON.parse(value) as Partial<AgentSessionActionTarget>;
    if (parsed.version !== 1 || !Number.isSafeInteger(parsed.sessionId) || Number(parsed.sessionId) <= 0
      || typeof parsed.channel !== "string" || !/^[A-Z][A-Z0-9]+$/.test(parsed.channel)
      || typeof parsed.threadTs !== "string" || !/^\d+\.\d{1,6}$/.test(parsed.threadTs)
      || (parsed.turnId !== undefined && (!Number.isSafeInteger(parsed.turnId) || Number(parsed.turnId) <= 0))) {
      return null;
    }
    return parsed as AgentSessionActionTarget;
  } catch {
    return null;
  }
}

function elapsedSince(value: string | null, nowMs: number) {
  if (!value) return null;
  const parsed = Date.parse(value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`);
  if (!Number.isFinite(parsed)) return null;
  const seconds = Math.max(0, Math.floor((nowMs - parsed) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function providerLabel(row: AgentSessionDashboardRow) {
  const provider = row.provider_id === "claude-code" ? "Claude Code" : "Codex";
  return row.provider_model ? `${provider} · ${row.provider_model}` : provider;
}

function rowState(row: AgentSessionDashboardRow, nowMs: number) {
  if (["running", "delivering"].includes(row.turn_status || "")) {
    const elapsed = elapsedSince(row.started_at, nowMs);
    return row.stop_requested_at ? "Stopping" : elapsed ? `Working · ${elapsed}` : "Working";
  }
  if (row.turn_status === "queued") {
    return row.queued_turn_count > 1 ? `Queued · ${row.queued_turn_count} turns` : "Queued";
  }
  if (row.turn_status === "parked") return row.retryable ? "Needs attention · safe to retry" : "Needs attention";
  if (row.turn_status === "delivery_parked") return "Response delivery needs attention";
  if (row.turn_status === "cancelled") return "Stopped";
  if (row.turn_status === "error") return "Ended with an error";
  return "Complete";
}

function actionButton(text: string, actionId: string, value: string, style?: "primary" | "danger") {
  return {
    type: "button",
    text: { type: "plain_text", text, emoji: true },
    action_id: actionId,
    value,
    ...(style ? { style } : {}),
  };
}

function sessionBlocks(row: AgentSessionDashboardRow, teamId: string | null, nowMs: number) {
  const value = actionTarget(row);
  const details = [
    rowState(row, nowMs),
    providerLabel(row),
    `<#${row.slack_channel_id}>`,
  ].join("  ·  ");
  const current = row.activity || row.user_text;
  const blocks: any[] = [{
    type: "section",
    text: {
      type: "mrkdwn",
      text: [
        `*${escapeMrkdwn(truncate(row.title, 120))}*`,
        details,
        current ? `_${escapeMrkdwn(truncate(current, 180))}_` : null,
      ].filter(Boolean).join("\n"),
    },
    accessory: actionButton(
      "Open thread",
      APP_HOME_OPEN_ACTION_ID,
      value,
    ),
  }];
  blocks[0].accessory.url = slackMessageSourceUrl(row.slack_channel_id, row.slack_thread_ts, teamId || undefined);

  const actions = [actionButton("Rename", APP_HOME_RENAME_ACTION_ID, value)];
  if (["running", "delivering"].includes(row.turn_status || "") && !row.stop_requested_at) {
    actions.unshift(actionButton("Stop", APP_HOME_STOP_ACTION_ID, value, "danger"));
  } else if (row.turn_status === "parked" && row.retryable) {
    actions.unshift(actionButton("Retry", APP_HOME_RETRY_ACTION_ID, value, "primary"));
  } else if (!["queued", "parked", "delivery_parked"].includes(row.turn_status || "")
    && row.agent_session_uuid) {
    actions.push(actionButton("Fork", APP_HOME_FORK_ACTION_ID, value));
  }
  blocks.push({ type: "actions", block_id: `agent_session_actions_${row.session_id}`, elements: actions });
  return blocks;
}

function sectionBlocks(input: {
  heading: string;
  description: string;
  rows: AgentSessionDashboardRow[];
  teamId: string | null;
  nowMs: number;
}) {
  if (input.rows.length === 0) return [];
  return [
    { type: "header", text: { type: "plain_text", text: input.heading, emoji: true } },
    { type: "context", elements: [{ type: "mrkdwn", text: input.description }] },
    ...input.rows.flatMap(row => sessionBlocks(row, input.teamId, input.nowMs)),
  ];
}

export function buildAgentSessionHomeView(input: {
  rows: AgentSessionDashboardRow[];
  teamId: string | null;
  nowMs?: number;
  notice?: string | null;
}) {
  const nowMs = input.nowMs ?? Date.now();
  const active = input.rows.filter(row => ["running", "delivering", "queued"].includes(row.turn_status || ""));
  const attention = input.rows.filter(row => ["parked", "delivery_parked"].includes(row.turn_status || ""));
  const recent = input.rows.filter(row => !active.includes(row) && !attention.includes(row));
  const summary = [
    active.length ? `${active.length} active or queued` : "No active work",
    attention.length ? `${attention.length} need attention` : "Nothing blocked",
    recent.length ? `${recent.length} recent` : "No recent sessions",
  ].join("  ·  ");
  const blocks: any[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: "*Agent Sessions*\nSee what Concierge is doing and manage each session from one place." },
      accessory: actionButton("Refresh", APP_HOME_REFRESH_ACTION_ID, "refresh"),
    },
    { type: "context", elements: [{ type: "mrkdwn", text: summary }] },
  ];
  if (input.notice) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `_${escapeMrkdwn(truncate(input.notice, 300))}_` } });
  }
  if (input.rows.length === 0) {
    blocks.push(
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*No Agent Sessions yet*\nStart a conversation with Concierge in a channel or DM. It will appear here as soon as the first agent turn is accepted.",
        },
      },
    );
  } else {
    blocks.push(
      ...sectionBlocks({
        heading: "Running now",
        description: "Live and queued work. Stop is bound to the exact running turn.",
        rows: active,
        teamId: input.teamId,
        nowMs,
      }),
      ...sectionBlocks({
        heading: "Needs attention",
        description: "Retry appears only when Concierge can prove the original input is safe to replay.",
        rows: attention,
        teamId: input.teamId,
        nowMs,
      }),
      ...sectionBlocks({
        heading: "Recent",
        description: "Open the original thread, give the session a useful name, or fork its latest complete provider history.",
        rows: recent,
        teamId: input.teamId,
        nowMs,
      }),
    );
  }
  blocks.push({
    type: "context",
    elements: [{
      type: "mrkdwn",
      text: "Slack’s native Agent Sessions list still owns pinning and archiving. This dashboard adds Concierge-specific operational controls.",
    }],
  });
  return { type: "home", callback_id: "agent_sessions_home", blocks };
}

export function buildRenameAgentSessionModal(row: AgentSessionDashboardRow) {
  return {
    type: "modal",
    callback_id: APP_HOME_RENAME_VIEW_ID,
    private_metadata: actionTarget(row),
    title: { type: "plain_text", text: "Rename session", emoji: true },
    submit: { type: "plain_text", text: "Save", emoji: true },
    close: { type: "plain_text", text: "Cancel", emoji: true },
    blocks: [{
      type: "input",
      block_id: APP_HOME_RENAME_INPUT_ID,
      label: { type: "plain_text", text: "Session name", emoji: true },
      element: {
        type: "plain_text_input",
        action_id: APP_HOME_RENAME_INPUT_ID,
        initial_value: truncate(row.title, 200),
        min_length: 1,
        max_length: 200,
        focus_on_load: true,
      },
    }],
  };
}

export function parseRenameAgentSessionSubmission(view: any): {
  target: AgentSessionActionTarget;
  title: string;
} | null {
  const target = parseAgentSessionActionTarget(view?.private_metadata);
  const title = view?.state?.values?.[APP_HOME_RENAME_INPUT_ID]?.[APP_HOME_RENAME_INPUT_ID]?.value;
  if (!target || typeof title !== "string") return null;
  const normalized = title.replace(/\s+/g, " ").trim();
  if (!normalized || Array.from(normalized).length > 200) return null;
  return { target, title: normalized };
}
