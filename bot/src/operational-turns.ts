import { createOrGetSession, db, getChannel, resolveSessionForReply } from "./state";
import { selectProviderForTurn } from "./aliases";

export function admitOperationalTurn(input: {
  channel: string; rootTs: string; trigger: string; prompt: string; operatorUserId: string;
}) {
  return db.transaction(() => {
    const existing = db.query("SELECT id FROM turns WHERE turn_kind='machine_alert' AND trigger_key=?")
      .get(input.trigger) as { id: number } | null;
    if (existing) return existing.id;
    const channel = getChannel(input.channel);
    if (!channel || !/^\d+\.\d+$/.test(input.rootTs) || !/^U[A-Z0-9]+$/.test(input.operatorUserId)
      || !/^(grafana|thinkering-report):[0-9a-f]{64}$/.test(input.trigger)) throw new Error("Operational task identity is unavailable.");
    const routing = resolveSessionForReply(channel, input.rootTs);
    const selection = selectProviderForTurn({ text: "", topLevel: false,
      channelDefault: channel.provider_default, existingProvider: routing.session?.provider_id });
    const session = routing.session || createOrGetSession(input.channel, routing.sessionThreadTs, selection.selectedProvider);
    return Number(db.query(`INSERT INTO turns (session_id,slack_user_msg_ts,slack_reply_thread_ts,user_text,status,
      turn_kind,trigger_key,requested_by_user_id,projection_mode,provider_model,reasoning_effort)
      VALUES (?,?,?,?,'queued','machine_alert',?,?,'agent',?,?)`)
      .run(session.id, input.trigger, input.rootTs, input.prompt, input.trigger, input.operatorUserId,
        selection.selectedModel || null, selection.selectedReasoningEffort || null).lastInsertRowid);
  })();
}
