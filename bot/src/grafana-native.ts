import { createHash } from "node:crypto";
import { db } from "./state";
import { GRAFANA_CONDITIONS, GRAFANA_ORIGIN } from "./grafana-webhook";
import type { GrafanaAlertRow } from "./grafana-alerts";
import { publishProviderFreeNotice, noticeTime } from "./provider-free-notice";
import { fileServiceNotices, settleServiceNotice } from "./session-topics";
import { createNativeSession, enqueueSessionInput, retainSessionInput } from "./session-inputs";

function episodeKey(row: GrafanaAlertRow) {
  return "grafana:" + createHash("sha256").update(JSON.stringify([row.fingerprint, row.starts_at])).digest("hex");
}

/** Native receipt is deterministic: an owner crash after publication cannot duplicate it. */
export async function publishNativeGrafanaAlert(row: GrafanaAlertRow): Promise<string> {
  const key = episodeKey(row);
  const inputId = `service:service-notice:${key}`;
  if (row.status === "firing") {
    const sentence = GRAFANA_CONDITIONS[row.condition] ?? "A monitored condition needs investigation.";
    const investigation = ["TestAlert", "ConciergeWebhookAcceptance"].includes(row.condition)
      ? "This is a notification test; no repair agent starts."
      : row.condition === "ConciergeDegraded"
        ? "The independent server monitor owns the investigation."
        : "An operational investigator is being started.";
    publishProviderFreeNotice(db, { key, kind: "grafana_alert", text:
      `${sentence}\nDetected ${noticeTime(db, Date.parse(row.starts_at))}. ${investigation}`,
      payload: { condition: row.condition, fingerprint: row.fingerprint, source: GRAFANA_ORIGIN } });
    fileServiceNotices();
  } else {
    settleServiceNotice({ inputId, text: `The monitored condition cleared at ${noticeTime(db, Date.parse(row.ends_at || row.starts_at))}.` });
  }
  return inputId;
}

/** One service-authored native investigation per firing episode, never a forged human input. */
export function admitNativeGrafanaInvestigation(row: GrafanaAlertRow, workspaceRoot: string): number {
  const trigger = episodeKey(row);
  return db.transaction(() => {
    const old = db.query("SELECT turn_id FROM session_inputs WHERE scope='service:grafana' AND action_id=?")
      .get(trigger) as { turn_id: number | null } | null;
    if (old?.turn_id) return old.turn_id;
    if (old) throw new Error("Grafana investigation input exists without a queued turn.");
    const project = `${workspaceRoot}/slack-concierge`;
    const session = createNativeSession("claude-code", {
      title: `Investigate ${row.condition}`, purpose: "develop", cwd: project, project, origin: "native",
    });
    const previous = db.query(`SELECT turn.id,turn.status,
      substr(COALESCE(turn.agent_text,turn.response_tldr),1,4000) AS outcome
      FROM grafana_alerts alert JOIN turns turn ON turn.id=alert.investigation_turn_id
      WHERE alert.condition=? AND NOT (alert.fingerprint=? AND alert.starts_at=?)
      ORDER BY turn.id DESC LIMIT 3`).all(row.condition, row.fingerprint, row.starts_at);
    const text = [
      "This is a service-authored Grafana operational alert, not a human request.",
      `Condition: ${row.condition}. ${GRAFANA_CONDITIONS[row.condition]}`,
      `Fingerprint: ${row.fingerprint}. Started: ${row.starts_at}. Source: ${GRAFANA_ORIGIN}.`,
      `Recent investigation outcomes (excerpts; inspect native history for full evidence): ${JSON.stringify(previous)}`,
      "Investigate retained evidence, identify the cause, repair authorized reversible failures through the owning repository, and verify recovery.",
      "Coordinate with an existing incident or repair agent; do not start a duplicate repair loop. Do not send email or Slack messages.",
      "Report the outcome in this native investigation conversation. A separate provider-free Inbox notice carries the alert and its recovery.",
    ].join("\n");
    const input = retainSessionInput({ sessionId: session.id, scope: "service:grafana", actionId: trigger,
      kind: "create", origin: "service", payload: { firstInput: { text }, delivery: "queue" } }).input;
    const queued = enqueueSessionInput(input.id);
    if (queued.turn_id === null) throw new Error("Grafana investigation was not queued.");
    return queued.turn_id;
  })();
}
