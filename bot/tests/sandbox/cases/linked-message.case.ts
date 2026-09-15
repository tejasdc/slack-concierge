import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ErrorCode, WebClient } from "@slack/web-api";
import { Database } from "bun:sqlite";
import type { LaneFixtureIdentities } from "../../../scripts/sandbox-provision";
import type { LiveTypedTurnAdapter } from "../adapters/live-typed-turn";
import { assertBrowserRequestMatchesLane, type SandboxBrowser } from "../support/browser";
import type { SandboxEvidenceWriter } from "../support/evidence";
import { routerSearchResponseTarget } from "./router-search.case";

export async function runLinkedMessageCase(options: {
  lane: LaneFixtureIdentities; workspaceDomain: string; runId: string; configPath: string;
  adapter: LiveTypedTurnAdapter; browser: SandboxBrowser; evidence: SandboxEvidenceWriter;
}) {
  const { adapter, lane, evidence } = options;
  const marker = randomUUID().replaceAll("-", "");
  const targetCode = `cant_update_message_${marker}`;
  const decoyCode = `transcript_index_${marker}`;
  const root = await adapter.postUserMessage({
    lane, channel_id: lane.channels.core.id, client_message_id: randomUUID(),
    text: `@cx [sandbox:${options.runId}:linked-message-source] Reply exactly: TL;DR: Supporting context ${marker}`,
  });
  await adapter.waitForRouterSearchTurn(root);
  await adapter.waitForRunSettled();
  adapter.runSourceEvidence();
  const config = Bun.TOML.parse(readFileSync(options.configPath, "utf8")) as { bot_token: string };
  const bot = new WebClient(config.bot_token, { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true });
  const identity = await bot.auth.test();
  if (identity.team_id !== lane.team_id || identity.user_id !== lane.bot_user_id) {
    throw new Error("Supporting-context fixture must use the exact claimed lane bot");
  }
  const supportingReceipts = [];
  // Cover either page ordering without starting provider turns for fixture rows.
  async function addSupportingContext(start: number) {
    for (let index = start; index < start + 50; index += 1) {
      adapter.runSourceEvidence();
      const text = `Supporting context ${marker} row ${index + 1}`;
      const request = { channel: root.channel_id, thread_ts: root.thread_ts, text };
      const posted = await bot.chat.postMessage(request).catch(async (error) => {
        if (error.code !== ErrorCode.RateLimitedError) throw error;
        await Bun.sleep(error.retryAfter * 1000);
        return bot.chat.postMessage(request);
      });
      if (posted.channel !== root.channel_id || !posted.ts || posted.message?.text !== text) {
        throw new Error("Slack did not confirm the exact supporting-context fixture row");
      }
      supportingReceipts.push({ ts: posted.ts, text });
    }
  }
  await addSupportingContext(0);
  const targetReceipt = await adapter.postUserMessage({
    lane, channel_id: root.channel_id, thread_ts: root.thread_ts, client_message_id: randomUUID(),
    text: `@cx [sandbox:${options.runId}:linked-message-target] Reply exactly: TL;DR: Error report: ${targetCode}`,
  });
  const target = await adapter.waitForRouterSearchTurn(targetReceipt);
  await addSupportingContext(50);
  const next = await adapter.postUserMessage({
    lane, channel_id: root.channel_id, thread_ts: root.thread_ts, client_message_id: randomUUID(),
    text: `@cx [sandbox:${options.runId}:linked-message-decoy] Reply exactly: TL;DR: Error report: ${decoyCode}`,
  });
  const decoy = await adapter.waitForRouterSearchTurn(next);
  await adapter.waitForRunSettled();
  const permalink = `https://${lane.browser.canonical_workspace_domain}/archives/${root.channel_id}/p${target.response_message_ts.replace(".", "")}?thread_ts=${root.thread_ts}`;
  const responses = [];
  for (const provider of ["cx", "cc"]) {
    const receipt = await adapter.postUserMessage({
      lane, channel_id: lane.channels.project.id, client_message_id: randomUUID(),
      text: `@${provider} [sandbox:${options.runId}:linked-message] What error does this report? <${permalink}>\nReply only with TL;DR: followed by the exact error code in the report.`,
    });
    const turn = await adapter.waitForRouterSearchTurn(receipt);
    await adapter.waitForRunSettled();
    const database = new Database(adapter.routerSearchContext().state_database, { readonly: true });
    let replay: string;
    try {
      replay = (database.query("SELECT replay_text FROM turns WHERE id=?").get(turn.turn_id) as { replay_text: string }).replay_text;
    } finally { database.close(); }
    if (!replay.includes(`linked_message_ts=${target.response_message_ts}, parent_thread_ts=${root.thread_ts}`)
      || !replay.includes(`[LINKED MESSAGE — SUBJECT] ts=${target.response_message_ts}`)
      || !replay.includes(decoyCode) || !replay.includes(targetCode)
      || !replay.includes("supporting thread messages omitted")
      || !replay.includes("51. [LINKED MESSAGE — SUBJECT]")
      || turn.provider_id !== (provider === "cx" ? "codex" : "claude-code")
      || !turn.outbound_text.startsWith(`TL;DR: ${targetCode}`)
      || turn.outbound_text.includes(decoyCode)) {
      throw new Error(`${provider} did not answer the exact linked message with the newer decoy present`);
    }
    const texts = await adapter.fetchBotThreadTexts({ lane, receipt });
    if (texts.filter(text => text.startsWith(`TL;DR: ${targetCode}`) && !text.includes(decoyCode)).length !== 1) {
      throw new Error(`${provider} did not deliver one exact target answer in Slack`);
    }
    const request = {
      lane_id: lane.lane_id, workspace_domain: options.workspaceDomain,
      browser_namespace: lane.browser.namespace, browser_profile_path: lane.browser.profile_path,
      capture_name: `linked-message-${provider}-${marker}`,
      phase: "terminal" as const, ...routerSearchResponseTarget(receipt, turn.response_message_ts, targetCode),
      required_text: [targetCode], assertions: ["The answer names the older linked message's error, with a newer unrelated report in its supporting context"],
    };
    assertBrowserRequestMatchesLane(request, lane);
    const browser = evidence.verifyScreenshot(await options.browser.capture(request, evidence));
    responses.push({ provider, receipt, turn, replay, texts, browser });
  }
  const result = { case_id: "linked-message", status: "passed", lane_id: lane.lane_id,
    app_id: lane.app_id, team_id: lane.team_id, run_id: options.runId,
    ...adapter.runSourceEvidence(), root, supportingReceipts, targetReceipt, target, decoy, permalink, targetCode, decoyCode, responses, unsettled: 0 };
  evidence.writeJson("linked-message.json", result);
  return result;
}
