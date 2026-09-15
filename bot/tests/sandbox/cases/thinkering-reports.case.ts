import { createHash, randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import type { LiveTypedTurnAdapter } from "../adapters/live-typed-turn";
import type { LaneFixtureIdentities } from "../../../scripts/sandbox-provision";
import type { SandboxEvidenceWriter } from "../support/evidence";

export async function runThinkeringReportsCase(input: {
  lane: LaneFixtureIdentities; runId: string; adapter: LiveTypedTurnAdapter; evidence: SandboxEvidenceWriter;
}) {
  const { adapter, lane, evidence } = input;
  const source = adapter.runSourceEvidence();
  const setup = await adapter.postUserMessage({ lane, channel_id: lane.channels.core.id, client_message_id: randomUUID(),
    text: "@cc Grafana sandbox setup fixture. Reply with TL;DR: Sandbox Grafana fixture ready." });
  await adapter.waitForTurnDispatchState({ lane, receipt: setup, statuses: ["done"] });
  await adapter.waitForRunSettled();
  adapter.configureGrafanaFixture();
  const database = new Database(adapter.routerSearchContext().state_database, { readonly: true });
  const counts = () => database.query("SELECT count(*) AS n FROM slack_user_input_claims").get();
  const before = counts();
  const reports: unknown[] = [];
  try {
    for (const long of [false, true]) {
      const id = randomUUID();
      const text = `Thinkering bug report\nBUG-REPORT-START ${id}\nDescription 😀\n${long ? "frozen diagnostic event\n".repeat(500) : "one event\n"}{"sessionId":"context-only-wrong-target"}\nBUG-REPORT-END ${id}`;
      const request = { kind: "bug_report" as const, event_id: `thinkering-${createHash("sha256").update(text).digest("hex")}`, text };
      if ((await adapter.submitThinkeringCapture(request, false)).http_status !== 401) throw new Error("Unauthenticated report accepted");
      const accepted = await adapter.submitThinkeringCapture(request);
      if (accepted.http_status !== 202 || !accepted.event_id) throw new Error("Report intake rejected");
      const duplicate = await adapter.submitThinkeringCapture(request);
      if (!duplicate.duplicate || duplicate.event_id !== accepted.event_id) throw new Error("Report retry changed identity");
      if ((await adapter.submitThinkeringCapture({ ...request, text: "changed" })).http_status !== 409) throw new Error("Report ID accepted changed text");
      const observed = await adapter.observeThinkeringReport(accepted.event_id, text);
      const final = await adapter.submitThinkeringCapture(request);
      if (final.status !== "delivered" || final.terminal_receipt !== observed.root_ts) throw new Error("Report lost its exact receipt");
      const turns: any = database.query("SELECT count(*) AS n FROM turns WHERE trigger_key=?").get(`thinkering-report:${accepted.event_id}`);
      if (turns.n !== 1) throw new Error("Report retry created duplicate agent work");
      reports.push({ accepted, duplicate, final, observed });
    }
    await adapter.waitForRunSettled();
    if (JSON.stringify(counts()) !== JSON.stringify(before)) throw new Error("App report masqueraded as a Slack user capture");
    const result = { case_id: "thinkering-reports", status: "passed", source, run_id: input.runId, lane_id: lane.lane_id,
      reports, user_claims_before: before, user_claims_after: counts(), run_owned_unsettled: 0,
      provider_evidence: "Native report admission and full-input protocol fixture; autonomous repair is separately exercised by grafana-alerts with the shared authority and turn owner." };
    evidence.writeJson("thinkering-reports.json", result);
    return result;
  } finally { database.close(); }
}
