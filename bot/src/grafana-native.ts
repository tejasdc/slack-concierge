import {resolveRepairNotice} from "./repair-notices";
import { createHash } from "node:crypto";
import { db } from "./state";
import { GRAFANA_CONDITIONS, GRAFANA_ORIGIN, GRAFANA_EXTERNAL_CONDITIONS } from "./grafana-webhook";
import type { GrafanaAlertRow } from "./grafana-alerts";
import { publishProviderFreeNotice, noticeTime } from "./provider-free-notice";

function episodeKey(row: GrafanaAlertRow) {
  return "grafana:" + createHash("sha256").update(JSON.stringify([row.fingerprint, row.starts_at])).digest("hex");
}

/** Native receipt is deterministic: an owner crash after publication cannot duplicate it. */
export async function publishNativeGrafanaAlert(row: GrafanaAlertRow): Promise<string> {
  const key = episodeKey(row);
  const inputId = `service:grafana:${key}:${row.status}`;
  // The durable Grafana receipt is enough for the external owner and reserved
  // contact tests. Forwarding it to repair now would admit a competing investigator.
  if (GRAFANA_EXTERNAL_CONDITIONS.has(row.condition) || ["TestAlert", "ConciergeWebhookAcceptance"].includes(row.condition)) return inputId;
  const sentence = GRAFANA_CONDITIONS[row.condition] ?? "A monitored condition needs investigation.";
  const text =
    `${sentence}\n${row.status === "firing" ? "Detected" : "Recovered"} ${noticeTime(db, Date.parse(row.ends_at || row.starts_at))}. `
    + (row.status === "firing" ? "Inspect retained evidence and repair what requires action." : "The monitored condition cleared; verify recovery before further action.");
  if(row.status === "resolved")resolveRepairNotice(db,{key:`${key}:firing`,recoveryKey:`${key}:resolved`,kind:"grafana_alert",text});
  else publishProviderFreeNotice(db, { key: `${key}:firing`, kind: "grafana_alert", text,
    payload: { condition: row.condition, fingerprint: row.fingerprint, source: GRAFANA_ORIGIN } });
  return inputId;
}
