import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import type { LaneFixtureIdentities } from "../../../scripts/sandbox-provision";
import { resolveProviderDefault } from "../../../src/aliases";
import type { LiveTypedTurnAdapter } from "../adapters/live-typed-turn";
import { assertBrowserRequestMatchesLane, type SandboxBrowser } from "../support/browser";
import type { SandboxEvidenceWriter } from "../support/evidence";
import { routerSearchResponseTarget } from "./router-search.case";

export async function runClaudeDefaultModelCase(options: {
  lane: LaneFixtureIdentities; workspaceDomain: string; runId: string;
  adapter: LiveTypedTurnAdapter; browser: SandboxBrowser; evidence: SandboxEvidenceWriter;
}) {
  const { adapter, lane, evidence } = options;
  const model = resolveProviderDefault("cc").model;
  if (!model) throw new Error("Claude default must be explicitly owned by Concierge");
  const marker = `SANDBOX_CLAUDE_DEFAULT_${randomUUID().replaceAll("-", "")}`;
  const receipt = await adapter.postUserMessage({
    lane, channel_id: lane.channels.core.id, client_message_id: randomUUID(),
    text: `@cc [sandbox:${options.runId}:claude-default-model] Reply exactly: TL;DR: ${marker} accepted.`,
  });
  const turn = await adapter.waitForRouterSearchTurn(receipt);
  await adapter.waitForRunSettled();
  const database = new Database(adapter.routerSearchContext().state_database, { readonly: true });
  let selection: unknown;
  try {
    selection = database.query(`
      SELECT claim.kind, claim.user_id, turn.provider_model
      FROM slack_user_input_claims claim JOIN turns turn ON turn.id=claim.turn_id
      WHERE claim.slack_channel_id=? AND claim.slack_user_msg_ts=? AND turn.id=?
    `).get(receipt.channel_id, receipt.message_ts, turn.turn_id);
  } finally { database.close(); }
  const expectedSelection = { kind: "turn", user_id: lane.installer_user_id, provider_model: model };
  if (JSON.stringify(selection) !== JSON.stringify(expectedSelection)
      || turn.provider_id !== "claude-code" || !turn.provider_session_uuid
      || turn.root_ts !== receipt.thread_ts || receipt.thread_ts !== receipt.message_ts
      || !turn.outbound_text.startsWith(`TL;DR: ${marker}`)
      || !turn.outbound_text.includes(`_model: ${model} - cwd: `)) {
    throw new Error("Claude default did not join the exact input to the selected and reported model");
  }
  const texts = await adapter.fetchBotThreadTexts({ lane, receipt });
  if (texts.filter((text) => text.startsWith(`TL;DR: ${marker}`)
      && text.includes(`model: ${model} - cwd: `)).length !== 1) {
    throw new Error("Claude default did not deliver exactly one matching Slack response");
  }
  const target = routerSearchResponseTarget(receipt, turn.response_message_ts, marker);
  const request = {
    lane_id: lane.lane_id, workspace_domain: options.workspaceDomain,
    browser_namespace: lane.browser.namespace, browser_profile_path: lane.browser.profile_path,
    phase: "terminal" as const, ...target, required_text: [marker, `model: ${model} - cwd:`],
    assertions: ["The exact Claude response visibly reports Concierge's selected default model"],
  };
  assertBrowserRequestMatchesLane(request, lane);
  const browser = evidence.verifyScreenshot(await options.browser.capture(request, evidence));
  await adapter.waitForRunSettled();
  const result = {
    case_id: "claude-default-model", status: "passed", lane_id: lane.lane_id,
    app_id: lane.app_id, team_id: lane.team_id, run_id: options.runId,
    ...adapter.runSourceEvidence(), marker, model, receipt, turn, selection, browser, unsettled: 0,
  };
  evidence.writeJson("claude-default-model.json", result);
  return result;
}
