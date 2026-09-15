import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LaneFixtureIdentities } from "../../../scripts/sandbox-provision";
import { GRAFANA_ORIGIN } from "../../../src/grafana-webhook";
import type { LiveTypedTurnAdapter } from "../adapters/live-typed-turn";
import type { SandboxBrowser } from "../support/browser";
import type { SandboxEvidenceWriter } from "../support/evidence";

export async function runGrafanaAlertsCase(options: {
  lane: LaneFixtureIdentities; workspaceDomain: string; runId: string;
  adapter: LiveTypedTurnAdapter; browser: SandboxBrowser; evidence: SandboxEvidenceWriter;
}) {
  const { lane, adapter, evidence } = options;
  const source = adapter.runSourceEvidence();
  const runRoot = dirname(evidence.runRoot);
  const db = new Database(join(runRoot, "state", "state.db"), { readonly: true });
  const captures = new Database(join(runRoot, "capture-state", "state.db"), { readonly: true });
  const laneNumber = Number(lane.lane_id.replace("lane-", ""));
  const url = `http://127.0.0.1:${8180 + laneNumber}/alerts/grafana`;
  const token = readFileSync(join(runRoot, "state", "capture-credentials", "grafana-alerts.token"), "utf8").trim();
  const fingerprint = createHash("sha256").update(randomUUID()).digest("hex").slice(0, 16);
  const startsAt = new Date().toISOString();
  const payload = (status: "firing" | "resolved", condition = "AX41ResourcePressure", fp = fingerprint) => ({
    receiver: "personal-observability-concierge", externalURL: GRAFANA_ORIGIN, status, truncatedAlerts: 0,
    alerts: [{ status, labels: { alertname: condition }, fingerprint: fp, startsAt,
      endsAt: status === "resolved" ? new Date().toISOString() : "0001-01-01T00:00:00Z" }],
  });
  const receipts: unknown[] = [];
  const submit = async (body: unknown, supplied = token) => {
    adapter.runSourceEvidence();
    const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${supplied}`,
      "content-type": "application/json" }, body: JSON.stringify(body) });
    const receipt: any = await response.json();
    receipts.push({ http_status: response.status, ...receipt });
    return { status: response.status, receipt };
  };
  const counts = () => ({
    claims: (db.query("SELECT COUNT(*) AS n FROM slack_user_input_claims").get() as any).n,
    captures: (captures.query("SELECT COUNT(*) AS n FROM capture_events").get() as any).n,
    machineTurns: (db.query("SELECT COUNT(*) AS n FROM turns WHERE turn_kind='machine_alert'").get() as any).n,
  });
  const row = (fp = fingerprint): any => db.query("SELECT * FROM grafana_alerts WHERE fingerprint=?").get(fp);
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 90_000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error("Grafana sandbox state did not settle"); await Bun.sleep(250); }
  };
  const screenshots: unknown[] = [];
  const capture = async (state: string, ts: string) => screenshots.push(evidence.verifyScreenshot(await options.browser.capture({
    lane_id: lane.lane_id, workspace_domain: options.workspaceDomain, browser_namespace: lane.browser.namespace,
    browser_profile_path: lane.browser.profile_path, phase: "terminal", capture_name: `grafana-${fingerprint}-${state.toLowerCase()}`,
    permalink: `https://${lane.browser.canonical_workspace_domain}/archives/${lane.channels.core.id}/p${ts.replace(".", "")}`,
    channel_id: lane.channels.core.id, message_ts: ts, thread_ts: ts,
    required_text: [`Grafana · ${state}`, fingerprint, "Machine-generated operational alert"],
    assertions: ["The exact bot-authored Grafana root retains machine identity and native state."],
  }, evidence)));
  try {
    const setup = await adapter.postUserMessage({ lane, channel_id: lane.channels.core.id, client_message_id: randomUUID(),
      text: "@cc This is the Grafana sandbox setup fixture. Reply with TL;DR: Sandbox Grafana fixture ready." });
    await adapter.waitForTurnDispatchState({ lane, receipt: setup, statuses: ["done"] });
    await adapter.waitForRunSettled();
    adapter.configureGrafanaFixture();
    const before = counts();
    if ((await submit(payload("firing"), "invalid")).status !== 401 || row()) throw new Error("Unauthorized alert mutated state");
    if ((await submit(payload("firing"))).status !== 202) throw new Error("Native-shaped firing rejected");
    await waitFor(() => row()?.delivery_status === "delivered" && Boolean(row()?.investigation_turn_id));
    const firing = row();
    const message: any = await adapter.readRoutedSlackMessage(lane.channels.core.id, firing.root_ts);
    if (message.bot_id !== lane.bot_id || message.user !== lane.bot_user_id || !message.text.includes("Grafana · FIRING")) {
      throw new Error("Alert was not authored by the exact lane bot");
    }
    await capture("FIRING", firing.root_ts);
    const repeat = await submit(payload("firing"));
    if (repeat.status !== 202 || !repeat.receipt.alerts[0].duplicate) throw new Error("Duplicate firing was not suppressed");
    const recovery = payload("resolved");
    await submit(recovery);
    await waitFor(() => row()?.status === "resolved" && row()?.delivery_status === "delivered");
    await submit(recovery);
    await submit(payload("firing"));
    const testFp = createHash("sha256").update(fingerprint + "test").digest("hex").slice(0, 16);
    await submit(payload("firing", "TestAlert", testFp));
    await waitFor(() => row(testFp)?.delivery_status === "delivered");
    await waitFor(() => (db.query("SELECT status FROM turns WHERE id=?").get(firing.investigation_turn_id) as any)?.status === "done");
    await adapter.waitForRunSettled();
    const turn: any = db.query("SELECT id,turn_kind,trigger_key,slack_user_msg_ts,slack_reply_thread_ts,status,agent_text FROM turns WHERE id=?").get(firing.investigation_turn_id);
    if (!turn.agent_text.includes(fingerprint)) throw new Error("Native provider queue omitted the machine input");
    const final: any = await adapter.readRoutedSlackMessage(lane.channels.core.id, firing.root_ts);
    if (final.ts !== message.ts || !final.text.includes("Grafana · RESOLVED") || final.bot_id !== lane.bot_id) throw new Error("Recovery or agent output changed root identity/state");
    const after = counts();
    if ((db.query("SELECT COUNT(*) AS n FROM slack_user_input_claims WHERE slack_user_msg_ts LIKE 'grafana:%'").get() as any).n) throw new Error("Restart manufactured machine user claims");
    if (after.claims !== before.claims || after.captures !== before.captures || after.machineTurns !== before.machineTurns + 1) throw new Error("Alert created captures, user claims, or duplicate investigations");
    if ((db.query("SELECT COUNT(*) AS n FROM grafana_alerts WHERE delivery_status<>'delivered'").get() as any).n !== 0) throw new Error("Unsettled alert delivery");
    await capture("RESOLVED", firing.root_ts);
    const result = { case_id: "grafana-alerts", status: "passed", source, lane_id: lane.lane_id, run_id: options.runId,
      url, fingerprint, receipts, before, after, firing, recovery: row(), test: row(testFp), turn,
      bot_message: final, screenshots, provider_evidence: "Claude stream-json fixture through native queue; no real monitoring investigation", run_owned_unsettled: 0 };
    evidence.writeJson("grafana-alerts.json", result);
    return result;
  } finally { captures.close(); db.close(); }
}
