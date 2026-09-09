import type { Database } from "bun:sqlite";
import type { ChannelRow, SessionRow } from "./state";
import { effectiveSessionModeForMessage, persistentSessionThreadTs, resolveMessageRouting } from "./routing";

// These aliases are internal SQL identifiers, never caller input. A shared provider
// anchor cannot identify a visible root in a single-persistent channel.
export function visibleSlackRootSql(turn = "t", session = "s", channel = "channel", claim = "claim") {
  return `COALESCE(${turn}.slack_reply_thread_ts, ${claim}.reply_thread_ts,
    CASE WHEN COALESCE(${channel}.session_mode, 'per-thread')='per-thread'
      THEN ${session}.slack_thread_ts ELSE ${turn}.slack_user_msg_ts END)`;
}

export function isolatedSessionThread(database: Database, channelId: string, rootTs: string): boolean {
  return Boolean(database.query(`SELECT 1 WHERE
    EXISTS (SELECT 1 FROM sessions WHERE slack_channel_id=? AND slack_thread_ts=? AND parent_session_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM fork_requests WHERE slack_channel_id=? AND slack_message_ts=?)
    OR EXISTS (SELECT 1 FROM comparison_requests WHERE slack_channel_id=? AND comparison_thread_ts=?)
  `).get(channelId, rootTs, channelId, rootTs, channelId, rootTs));
}

export function resolveReplySession(database: Database, channel: ChannelRow, rootTs: string, forceNewSession = false) {
  const sessionForThread = (threadTs: string) => database.query(`SELECT * FROM sessions
    WHERE slack_channel_id=? AND slack_thread_ts=? ORDER BY id ASC LIMIT 1`)
    .get(channel.slack_channel_id, threadTs) as SessionRow | null;
  const visibleThreadSession = sessionForThread(rootTs);
  const effectiveSessionMode = effectiveSessionModeForMessage({
    channelSessionMode: channel.session_mode,
    forceNewSession,
    hasIsolatedThreadSession: channel.session_mode === "single-persistent"
      && isolatedSessionThread(database, channel.slack_channel_id, rootTs),
  });
  let anchorThreadTs: string | null = null;
  if (effectiveSessionMode === "single-persistent") {
    if (channel.default_session_uuid) {
      const anchor = database.query(`SELECT slack_thread_ts FROM sessions
        WHERE slack_channel_id=? AND agent_session_uuid=? ORDER BY id ASC LIMIT 1`)
        .get(channel.slack_channel_id, channel.default_session_uuid) as { slack_thread_ts: string } | null;
      anchorThreadTs = anchor?.slack_thread_ts ?? null;
    } else {
      anchorThreadTs = persistentSessionThreadTs(channel.slack_channel_id);
    }
  }
  const { sessionThreadTs } = resolveMessageRouting({ replyThreadTs: rootTs, sessionMode: effectiveSessionMode, anchorThreadTs });
  return {
    effectiveSessionMode, anchorThreadTs, sessionThreadTs, visibleThreadSession,
    session: sessionThreadTs === rootTs ? visibleThreadSession : sessionForThread(sessionThreadTs),
  };
}
