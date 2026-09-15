import { createHash } from "node:crypto";
import { createOrGetSession, db, getChannel, resolveSessionForReply } from "./state";
import { grafanaInvestigationPrompt, type GrafanaAlertRow } from "./grafana-alerts";
import { selectProviderForTurn } from "./aliases";

export function admitGrafanaInvestigation(alert: GrafanaAlertRow, operatorUserId: string) {
  return db.transaction(() => {
    const channel = getChannel(alert.channel);
    if (!channel || !alert.root_ts || !/^U[A-Z0-9]+$/.test(operatorUserId)) throw new Error("Grafana investigation destination is unavailable.");
    const routing = resolveSessionForReply(channel, alert.root_ts);
    const selection = selectProviderForTurn({ text: "", topLevel: false,
      channelDefault: channel.provider_default, existingProvider: routing.session?.provider_id });
    const provider = selection.selectedProvider;
    const session = routing.session || createOrGetSession(alert.channel, routing.sessionThreadTs, provider);
    const trigger = "grafana:" + createHash("sha256").update(JSON.stringify([alert.fingerprint, alert.starts_at])).digest("hex");
    db.query(`INSERT INTO turns (session_id,slack_user_msg_ts,slack_reply_thread_ts,user_text,status,
      turn_kind,trigger_key,requested_by_user_id,projection_mode,provider_model,reasoning_effort)
      VALUES (?,?,?,?,'queued','machine_alert',?,?,'agent',?,?)
      ON CONFLICT(turn_kind,trigger_key) WHERE trigger_key IS NOT NULL DO NOTHING`)
      .run(session.id, trigger, alert.root_ts, grafanaInvestigationPrompt(alert), trigger, operatorUserId,
        selection.selectedModel || null, selection.selectedReasoningEffort || null);
    return (db.query("SELECT id FROM turns WHERE turn_kind='machine_alert' AND trigger_key=?").get(trigger) as { id: number }).id;
  })();
}
