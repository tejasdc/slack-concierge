import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { LaneFixtureIdentities } from "../../../scripts/sandbox-provision";
import type { LiveTypedTurnAdapter } from "../adapters/live-typed-turn";
import { assertBrowserRequestMatchesLane, type SandboxBrowser } from "../support/browser";
import type { SandboxEvidenceWriter } from "../support/evidence";

export async function runDeploymentRepairCase(options: {
  lane: LaneFixtureIdentities; workspaceDomain: string; runId: string; configPath: string;
  adapter: LiveTypedTurnAdapter; browser: SandboxBrowser; evidence: SandboxEvidenceWriter;
}) {
  const { lane, adapter, evidence } = options;
  const marker = `SANDBOX_QUEUED_REPAIR_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  const post = (text: string, thread_ts?: string) => adapter.postUserMessage({ lane, channel_id: lane.channels.core.id,
    client_message_id: randomUUID(), thread_ts, text: `@cc ${text}` });
  const receipt = await post(`${marker} Return the exact marker.`);
  const turn = await adapter.waitForRouterSearchTurn(receipt);
  const root = resolve(import.meta.dir, "../../../..");
  async function control(action: string) {
    adapter.runSourceEvidence();
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../support/deployment-repair-fixture.ts"), action,
      dirname(adapter.routerSearchContext().state_database), options.configPath, String(turn.turn_id), root],
    { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Repair fixture failed: ${error}`);
    const result = JSON.parse(output.trim().split("\n").at(-1)!);
    evidence.writeJson(`deployment-repair-${action}.json`, result);
    return result;
  }
  const running = await control("repair");
  const has = async (ts: string, name: string) => {
    const message = await adapter.readRoutedSlackMessage(receipt.channel_id, ts);
    return message.reactions?.some((r: any) => r.name === name && r.users.includes(lane.bot_user_id));
  };
  if (running.request_count !== 0 || running.attempts.length !== 2
    || !await has(turn.response_message_ts, "hammer_and_wrench")) throw new Error("Repair state did not reach the exact Slack response.");
  const parked = await control("park");
  if (parked.notices.length !== 1 || parked.notices[0].status !== "delivered"
    || parked.reaction.desired_state !== "parked"
    || !await has(turn.response_message_ts, "octagonal_sign")
    || !await has(receipt.message_ts, "octagonal_sign")) throw new Error("Parked repair did not deliver one notice and both stop reactions.");
  const later = await post(`${marker}_LATER Return the exact marker.`, receipt.thread_ts);
  await adapter.waitForRouterSearchTurn(later);
  const projected = await control("project");
  if (projected.notices.length !== 1 || !await has(turn.response_message_ts, "octagonal_sign")
    || await has(turn.response_message_ts, "hammer_and_wrench") || await has(turn.response_message_ts, "rocket")) {
    throw new Error("Later turn overwrote terminal deployment state or duplicated its notice.");
  }
  await adapter.waitForRunSettled();
  const request = { lane_id: lane.lane_id, workspace_domain: options.workspaceDomain,
    browser_namespace: lane.browser.namespace, browser_profile_path: lane.browser.profile_path,
    phase: "terminal" as const, permalink: receipt.permalink, channel_id: receipt.channel_id,
    message_ts: receipt.message_ts, thread_ts: receipt.thread_ts,
    required_text: [marker], assertions: ["The exact repair thread remains visible after a later turn; API and ledger prove its stop state and one notice."] };
  assertBrowserRequestMatchesLane(request, lane);
  const browser = evidence.verifyScreenshot(await options.browser.capture(request, evidence));
  evidence.writeJson("deployment-repair-result.json", { status: "passed", source: adapter.runSourceEvidence(), receipt,
    turn, later, incident: parked.incident.id, browser });
}
