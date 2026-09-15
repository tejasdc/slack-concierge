import { createHash } from "node:crypto";
import { db } from "./state";
import { grafanaInvestigationPrompt, type GrafanaAlertRow, type GrafanaPriorTurn } from "./grafana-alerts";
import { admitOperationalTurn } from "./operational-turns";

export function admitGrafanaInvestigation(alert: GrafanaAlertRow, operatorUserId: string) {
  return db.transaction(() => {
    if (!alert.root_ts) throw new Error("Grafana investigation destination is unavailable.");
    const trigger = "grafana:" + createHash("sha256").update(JSON.stringify([alert.fingerprint, alert.starts_at])).digest("hex");
    const history = db.query(`SELECT turn.id, turn.status,
      substr(COALESCE(turn.agent_text, turn.response_tldr),1,4000) AS outcome
      FROM turns turn JOIN sessions session ON session.id=turn.session_id
      WHERE session.slack_channel_id=? AND turn.slack_reply_thread_ts=?
        AND turn.turn_kind='machine_alert' AND turn.trigger_key<>?
      ORDER BY turn.id DESC LIMIT 3`).all(alert.channel, alert.root_ts, trigger) as GrafanaPriorTurn[];
    return admitOperationalTurn({ channel: alert.channel, rootTs: alert.root_ts, trigger,
      prompt: grafanaInvestigationPrompt(alert, history), operatorUserId });
  })();
}
