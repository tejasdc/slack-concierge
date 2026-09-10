import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import type { LaneFixtureIdentities } from "../../../scripts/sandbox-provision";
import type { LiveTypedTurnAdapter } from "../adapters/live-typed-turn";
import { assertBrowserRequestMatchesLane, type SandboxBrowser } from "../support/browser";
import type { SandboxEvidenceWriter } from "../support/evidence";
import { routerSearchResponseTarget } from "./router-search.case";

export async function runRouterReplyCase(options: {
  lane: LaneFixtureIdentities; workspaceDomain: string; runId: string;
  adapter: LiveTypedTurnAdapter; browser: SandboxBrowser; evidence: SandboxEvidenceWriter;
}) {
  const { adapter, lane, evidence } = options;
  const marker = `SANDBOX_ROUTER_REPLY_${randomUUID().replaceAll("-", "")}`;
  const context = adapter.routerSearchContext();
  const receipt = await adapter.postUserMessage({
    lane, channel_id: lane.dm_channel_id, client_message_id: randomUUID(),
    text: [
      `@cc [sandbox:${options.runId}:router-reply] Route this fixture once to ${lane.channels.core.id}.`,
      `The exact helper command prefix is: ${context.helper_command}`,
      `Use its post verb once with this destination text: Reply exactly: TL;DR: ${marker}_TARGET accepted.`,
      `Do not audit or react separately. Your final starts TL;DR: ${marker}_ROUTED and includes the helper's exact returned permalink. Keep it below 300 characters.`,
      "Do not use the installed production helper or inspect any other workspace. Do not repeat a failed or ambiguous write.",
    ].join("\n"),
  });
  const routed = await adapter.waitForRouterSearchTurn(receipt);
  await adapter.waitForRunSettled();
  const destination = adapter.routerSearchTurns().filter(t => t.channel_id === lane.channels.core.id && t.user_text.includes(`${marker}_TARGET`));
  if (destination.length !== 1 || !routed.outbound_text.includes(`${marker}_ROUTED`)
      || !routed.outbound_text.includes("https://")) throw new Error("Router did not produce one exact destination and routing receipt");

  async function inspect(turn: typeof routed, replacement: boolean) {
    const database = new Database(context.state_database, { readonly: true });
    try {
      const pages = database.query("SELECT page_number, message_ts, dirty FROM agent_progress_messages WHERE turn_id=? ORDER BY page_number").all(turn.turn_id) as any[];
      const chunks = database.query("SELECT chunk_index, replace_message_ts, slack_ts, delivered_at FROM turn_delivery_chunks WHERE turn_id=? ORDER BY chunk_index").all(turn.turn_id) as any[];
      const claim = database.query("SELECT kind, user_id, turn_id FROM slack_user_input_claims WHERE slack_channel_id=? AND slack_user_msg_ts=?").get(turn.channel_id, turn.message_ts);
      if (pages.length !== 1 || pages[0].dirty !== 0 || chunks.length !== 1 || !chunks[0].delivered_at
          || chunks[0].slack_ts !== turn.response_message_ts
          || (replacement ? chunks[0].replace_message_ts !== pages[0].message_ts || chunks[0].slack_ts !== pages[0].message_ts
            : chunks[0].replace_message_ts !== null || chunks[0].slack_ts === pages[0].message_ts)
          || JSON.stringify(claim) !== JSON.stringify({ kind: "turn", user_id: lane.installer_user_id, turn_id: turn.turn_id })) {
        throw new Error("Reply mode lost exact input, progress, or response ownership");
      }
      return { pages, chunks, claim };
    } finally { database.close(); }
  }
  const initialState = await inspect(routed, true);
  const destinationState = await inspect(destination[0]!, false);
  const initialTexts = await adapter.fetchBotThreadTexts({ lane, receipt });
  if (initialTexts.length !== 1 || !initialTexts[0]!.startsWith(`TL;DR: ${marker}_ROUTED`)) {
    throw new Error("Ordinary router capture created more than one bot message");
  }
  const destinationTexts = await adapter.fetchBotThreadTexts({ lane, receipt: { ...receipt, channel_id: destination[0]!.channel_id, thread_ts: destination[0]!.root_ts } });
  if (destinationTexts.length !== 2 || !destinationTexts.includes("Agent task progress")) {
    throw new Error("Destination channel lost its separate progress and final replies");
  }
  const screenshots = [];
  async function capture(turn: typeof routed, expected: string) {
    const target = routerSearchResponseTarget(receipt, turn.response_message_ts, expected);
    const request = { lane_id: lane.lane_id, workspace_domain: options.workspaceDomain,
      browser_namespace: lane.browser.namespace, browser_profile_path: lane.browser.profile_path,
      phase: "terminal" as const, ...target, required_text: [expected],
      assertions: ["The exact former router progress message visibly contains the final routing receipt"] };
    assertBrowserRequestMatchesLane(request, lane);
    screenshots.push(evidence.verifyScreenshot(await options.browser.capture(request, evidence)));
  }
  await capture(routed, `${marker}_ROUTED`);
  const followupReceipt = await adapter.postUserMessage({ lane, channel_id: lane.dm_channel_id,
    thread_ts: receipt.thread_ts, client_message_id: randomUUID(),
    text: `@cc [sandbox:${options.runId}:router-reply-followup] No more routing or helper calls. Reply exactly: TL;DR: ${marker}_FOLLOWUP The earlier capture was routed and this follow-up is acknowledged.`,
  });
  const followup = await adapter.waitForRouterSearchTurn(followupReceipt);
  await adapter.waitForRunSettled();
  const followupState = await inspect(followup, true);
  const finalTexts = await adapter.fetchBotThreadTexts({ lane, receipt });
  if (finalTexts.length !== 2 || !finalTexts.includes(initialTexts[0]!)
      || finalTexts.filter(t => t.startsWith(`TL;DR: ${marker}_FOLLOWUP`)).length !== 1) {
    throw new Error("Later router work overwrote the prior receipt or created duplicate progress/final messages");
  }
  await capture(followup, `${marker}_FOLLOWUP`);
  await adapter.waitForRunSettled();
  const result = { case_id: "router-reply", status: "passed", lane_id: lane.lane_id,
    app_id: lane.app_id, team_id: lane.team_id, run_id: options.runId,
    ...adapter.runSourceEvidence(), marker, receipt, routed, initialState, initialTexts,
    destination, destinationState, destinationTexts, followupReceipt, followup, followupState,
    finalTexts, screenshots, unsettled: 0 };
  evidence.writeJson("router-reply.json", result);
  return result;
}
