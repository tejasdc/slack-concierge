import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LaneFixtureIdentities } from "../../../scripts/sandbox-provision";
import { GRAFANA_ORIGIN } from "../../../src/grafana-webhook";
import type { LiveTypedTurnAdapter } from "../adapters/live-typed-turn";
import type { SandboxBrowser } from "../support/browser";
import type { SandboxEvidenceWriter } from "../support/evidence";
import { SessionCommunicationSandbox } from "../support/session-communication";

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
  let startsAt = new Date().toISOString();
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
    const deadline = Date.now() + 300_000;
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
    const project = adapter.configureGrafanaFixture();
    const command = (args: string[]) => {
      const result = Bun.spawnSync(args, { cwd: project, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode) throw new Error(`Repair fixture command failed: ${result.stderr.toString()}`);
      return result.stdout.toString().trim();
    };
    if (!existsSync(join(project, ".git"))) {
      command(["git", "init", "-b", "main"]);
      command(["git", "config", "user.name", "Sandbox Operator"]);
      command(["git", "config", "user.email", "sandbox@example.test"]);
      command(["git", "config", "core.hooksPath", "/dev/null"]);
      command(["git", "init", "--bare", join(project, "..", "grafana-repair-origin.git")]);
      command(["git", "remote", "add", "origin", join(project, "..", "grafana-repair-origin.git")]);
    }
    writeFileSync(join(project, "AGENTS.md"), [
      "# Isolated Grafana repair acceptance project",
      "This is a run-owned sandbox fixture, not the deployed Thinkering/AX41 installation. All operational evidence is here; do not query production, read host credentials or external operator guides, send messages, or run deployment commands.",
      "The machine alert grants repair authority. Diagnose resource.json using pressure.py and check.py. Resource usage/capacity are bytes; pressure() must report a percentage. Repair the implementation and add a regression if needed. Do not change resource.json or weaken check.py.",
      "Run python3 check.py, then commit and push the repair to the existing run-local bare origin. This is the fixture's established source publication path; no service rollout is involved. Do not ask for routine approval.",
      "A later alert may inject a regression. Inspect the supplied prior native outcome and Git evidence before repairing it. Record the recurrence diagnosis, source commit, check result and publication state in your final response, including the supplied fingerprint. Never claim a production repair.",
    ].join("\n"));
    if (!existsSync(join(project, "CLAUDE.md"))) symlinkSync("AGENTS.md", join(project, "CLAUDE.md"));
    const inject = (usage: number) => {
      writeFileSync(join(project, "resource.json"), JSON.stringify({ used: usage, capacity: 100 }));
      writeFileSync(join(project, "pressure.py"), "def pressure(sample):\n    return 0  # injected instrumentation fault\n");
      writeFileSync(join(project, "check.py"), "import json\nfrom pressure import pressure\nsample = json.load(open('resource.json'))\nassert pressure(sample) == sample['used'] * 100 / sample['capacity']\nassert pressure({'used': 256, 'capacity': 1024}) == 25\nprint('Sandbox pressure verification passed')\n");
      writeFileSync(join(project, ".gitignore"), "__pycache__/\nhold-for-native-stop\n");
      command(["git", "add", "."]);
      command(["git", "commit", "--allow-empty", "-m", "Inject isolated pressure instrumentation fault"]);
      command(["git", "push", "-u", "origin", "main"]);
      const bad = Bun.spawnSync(["python3", "check.py"], { cwd: project });
      if (bad.exitCode === 0) throw new Error("Negative control did not detect injected instrumentation fault");
    };
    const repairProof = () => {
      // This oracle is outside agent-editable files and uses different samples.
      const checked = command(["python3", "-c", "from pressure import pressure; assert pressure({'used': 39, 'capacity': 120}) == 32.5; assert pressure({'used': 0, 'capacity': 10}) == 0; print('independent oracle passed')"]);
      const commit = command(["git", "rev-parse", "HEAD"]);
      if (command(["git", "status", "--porcelain"])) throw new Error("Agent left its repair unpublished or dirty");
      if (command(["git", "rev-parse", "origin/main"]) !== commit) throw new Error("Agent omitted fixture source publication");
      return { project, commit, checked, source: readFileSync(join(project, "pressure.py"), "utf8") };
    };
    inject(90);
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
    await waitFor(() => (db.query("SELECT status FROM turns WHERE id=?").get(firing.investigation_turn_id) as any)?.status === "done");
    await adapter.waitForRunSettled();
    const firstRepair = repairProof();
    const recovery = payload("resolved");
    await submit(recovery);
    await waitFor(() => row()?.status === "resolved" && row()?.delivery_status === "delivered");
    await submit(recovery);
    await submit(payload("firing"));
    const testFp = createHash("sha256").update(fingerprint + "test").digest("hex").slice(0, 16);
    await submit(payload("firing", "TestAlert", testFp));
    await waitFor(() => row(testFp)?.delivery_status === "delivered");
    const acceptanceFp = createHash("sha256").update(fingerprint + "acceptance").digest("hex").slice(0, 16);
    await submit(payload("firing", "ConciergeWebhookAcceptance", acceptanceFp));
    await waitFor(() => row(acceptanceFp)?.delivery_status === "delivered");
    await adapter.waitForRunSettled();
    const turn: any = db.query("SELECT id,turn_kind,trigger_key,slack_user_msg_ts,slack_reply_thread_ts,status,agent_text FROM turns WHERE id=?").get(firing.investigation_turn_id);
    if (!turn.agent_text.includes(fingerprint)) throw new Error("Native provider queue omitted the machine input");
    inject(75);
    startsAt = new Date().toISOString();
    await submit(payload("firing"));
    await waitFor(() => row()?.investigation_turn_id !== turn.id && Boolean(row()?.investigation_turn_id));
    const recurringId = row().investigation_turn_id;
    const recurring: any = db.query("SELECT id,session_id,user_text FROM turns WHERE id=?").get(recurringId);
    const prior = JSON.parse(recurring.user_text.split("inspect native history for full evidence): ")[1]);
    if (prior[0]?.id !== turn.id || prior[0]?.outcome !== turn.agent_text.slice(0, 4000)) throw new Error("Recurrence lost prior native repair evidence");
    await waitFor(() => (db.query("SELECT status FROM turns WHERE id=?").get(recurringId) as any)?.status === "done");
    await adapter.waitForRunSettled();
    const recurringRepair = repairProof();
    await submit(payload("resolved"));
    await waitFor(() => row()?.status === "resolved" && row()?.delivery_status === "delivered");
    // The existing native Stop must retain ownership even for an agent allowed to repair.
    writeFileSync(join(project, "hold-for-native-stop"), "native-control fixture");
    startsAt = new Date().toISOString();
    await submit(payload("firing"));
    await waitFor(() => row()?.investigation_turn_id !== recurringId && Boolean(row()?.investigation_turn_id));
    const stoppedId = row().investigation_turn_id;
    await waitFor(() => (db.query("SELECT status FROM turns WHERE id=?").get(stoppedId) as any)?.status === "running");
    const controls = new SessionCommunicationSandbox(lane, adapter, evidence);
    let stop;
    try { stop = await controls.stopThroughSlack(stoppedId); } finally { controls.close(); }
    unlinkSync(join(project, "hold-for-native-stop"));
    await adapter.waitForRunSettled();
    if ((db.query("SELECT status FROM turns WHERE id=?").get(stoppedId) as any)?.status !== "cancelled") throw new Error("Native Stop did not cancel machine repair ownership");
    await submit(payload("firing"));
    await submit(payload("resolved"));
    await waitFor(() => row()?.status === "resolved" && row()?.delivery_status === "delivered");
    const final: any = await adapter.readRoutedSlackMessage(lane.channels.core.id, firing.root_ts);
    if (final.ts !== message.ts || !final.text.includes("Grafana · RESOLVED") || final.bot_id !== lane.bot_id) throw new Error("Recovery or agent output changed root identity/state");
    const after = counts();
    if ((db.query("SELECT COUNT(*) AS n FROM slack_user_input_claims WHERE slack_user_msg_ts LIKE 'grafana:%'").get() as any).n) throw new Error("Restart manufactured machine user claims");
    if (after.claims !== before.claims || after.captures !== before.captures || after.machineTurns !== before.machineTurns + 3) throw new Error("Alert created captures, user claims, or duplicate investigations");
    if ((db.query("SELECT COUNT(*) AS n FROM grafana_alerts WHERE delivery_status<>'delivered'").get() as any).n !== 0) throw new Error("Unsettled alert delivery");
    await capture("RESOLVED", firing.root_ts);
    const result = { case_id: "grafana-alerts", status: "passed", source, lane_id: lane.lane_id, run_id: options.runId,
      url, fingerprint, receipts, before, after, firing, recovery: row(), test: row(testFp), turn,
      bot_message: final, screenshots, firstRepair, recurringRepair, recurring, stoppedId, stop,
      provider_evidence: "Real Claude CLI through native machine queue repaired and published two run-local faults; setup/Stop use controlled transport fixtures. No production repair or Grafana Cloud delivery claim.", run_owned_unsettled: 0 };
    evidence.writeJson("grafana-alerts.json", result);
    return result;
  } finally { captures.close(); db.close(); }
}
