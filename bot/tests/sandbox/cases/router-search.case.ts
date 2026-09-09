import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import type { LaneFixtureIdentities } from "../../../scripts/sandbox-provision";
import { searchRouterThreads } from "../../../src/router-search";
import type { LiveTypedTurnAdapter } from "../adapters/live-typed-turn";
import { assertBrowserRequestMatchesLane, type SandboxBrowser } from "../support/browser";
import type { SandboxEvidenceWriter } from "../support/evidence";
import type { TypedTurnPostReceipt } from "./typed-turn.case";
import incident from "../../fixtures/router-search-incident.json";

export function routerSearchResponseTarget(receipt: TypedTurnPostReceipt, responseMessageTs: string, expectedText: string) {
  const permalink = new URL(receipt.permalink);
  permalink.pathname = `/archives/${receipt.channel_id}/p${responseMessageTs.replace(".", "")}`;
  permalink.searchParams.set("thread_ts", receipt.thread_ts);
  permalink.searchParams.set("cid", receipt.channel_id);
  return { permalink: permalink.toString(), channel_id: receipt.channel_id,
    message_ts: responseMessageTs, thread_ts: receipt.thread_ts, required_text: [expectedText] };
}

export function assertRouterSearchRouting(input: {
  destination: string; root: string; marker: string; previousTurnIds: number[];
  turns: ReturnType<LiveTypedTurnAdapter["routerSearchTurns"]>; decision: "resume" | "clarify";
}) {
  const newDestinationTurns = input.turns.filter((turn) => turn.channel_id === input.destination && !input.previousTurnIds.includes(turn.turn_id));
  if (input.decision === "clarify") {
    if (newDestinationTurns.length) throw new Error("Unresolved resume signal created destination work");
    return;
  }
  if (newDestinationTurns.length !== 1 || newDestinationTurns[0]?.root_ts !== input.root
      || newDestinationTurns[0]?.message_ts === input.root || !newDestinationTurns[0]?.user_text.includes(input.marker)
      || newDestinationTurns[0]?.delivery_status !== "delivered" || newDestinationTurns[0]?.status !== "done") {
    throw new Error("Resume did not produce exactly one delivered input in the historical Slack root");
  }
}

export async function runRouterSearchCase(options: {
  lane: LaneFixtureIdentities; workspaceDomain: string; runId: string;
  adapter: LiveTypedTurnAdapter; browser: SandboxBrowser; evidence: SandboxEvidenceWriter;
}) {
  const { adapter, lane, evidence } = options;
  const marker = `SANDBOX_ROUTER_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  const target = lane.channels.core.id;
  const context = adapter.routerSearchContext();
  const post = (channelId: string, text: string) => adapter.postUserMessage({ lane, channel_id: channelId, text, client_message_id: randomUUID() });
  const receipts: TypedTurnPostReceipt[] = [];
  const snapshots: unknown[] = [];
  const browserTargets: ReturnType<typeof routerSearchResponseTarget>[] = [];
  const historical = await post(target, `[sandbox:${options.runId}:router-search:historical] ${incident.historical_input}\nThis is a routing fixture; only acknowledge this historical topic. Reply exactly: TL;DR: ${marker}_HISTORICAL hair loss and shower filter discussion recorded.`);
  receipts.push(historical);
  const historicalTurn = await adapter.waitForRouterSearchTurn(historical);
  await adapter.waitForRunSettled();
  const unrelated = await post(target, `[sandbox:${options.runId}:router-search:recent] A recent unrelated conversation about train schedules. Reply exactly: TL;DR: ${marker}_RECENT train schedules recorded.`);
  receipts.push(unrelated);
  await adapter.waitForRouterSearchTurn(unrelated);
  await adapter.waitForRunSettled();

  async function route(cue: string, decision: "resume" | "clarify", suffix: string, failingDatabase = false) {
    const beforeTurns = adapter.routerSearchTurns();
    // A nonexistent run-local database exercises the helper's read-only failure
    // contract without damaging the running candidate or any provider session.
    const helper = failingDatabase ? context.helper_command.replace(context.state_database, `${context.state_database}.unavailable`) : context.helper_command;
    const message = await post(lane.dm_channel_id, [
      `[sandbox:${options.runId}:router-search:${suffix}] Act as the DM router for this note: ${cue}`,
      `The proposed destination is ${target} (${lane.channels.core.name}). All visible fixture roots predate this router session.`,
      `The Concierge-supplied router decision contract applies. The only allowed helper command for this sandbox is: ${helper}`,
      "Use that full command prefix on each call. Never use the installed production helper, raw Slack API, provider transcripts, or inspect any database yourself. Use threads search with the exact message_ts from this input's supplied Slack context. Do not infer a root from recency or a provider anchor. Choose resume or clarification from the returned evidence.",
      `If the evidence identifies one convincing resumable root, forward exactly this text there using resume once: Reply exactly: TL;DR: ${marker}_${suffix}_DESTINATION historical conversation resumed.`,
      `If evidence is empty, unavailable, incomplete, or ambiguous, ask one concise clarifying question in your final reply, beginning TL;DR: ${marker}_${suffix}_CLARIFY. Do not create destination work.`,
      `After a confirmed resume, final reply starts TL;DR: ${marker}_${suffix}_ROUTED and includes the returned permalink. Do not audit or react separately in this fixture.`,
    ].join("\n"));
    receipts.push(message);
    const routerTurn = await adapter.waitForRouterSearchTurn(message);
    await adapter.waitForRunSettled();
    const afterTurns = adapter.routerSearchTurns();
    assertRouterSearchRouting({ destination: target, root: historical.thread_ts, marker: `${marker}_${suffix}_DESTINATION`, previousTurnIds: beforeTurns.map((turn) => turn.turn_id), turns: afterTurns, decision });
    const expected = `${marker}_${suffix}_${decision === "resume" ? "ROUTED" : "CLARIFY"}`;
    if (!routerTurn.outbound_text.includes(expected) || (decision === "clarify" && !routerTurn.outbound_text.includes("?"))) throw new Error("Router did not deliver the expected routing/clarification outcome");
    const texts = await adapter.fetchBotThreadTexts({ lane, receipt: message });
    if (!texts.some((text) => text.includes(expected))) throw new Error("Exact DM thread is missing the router outcome");
    if (decision === "resume") {
      const destination = afterTurns.find((turn) => turn.channel_id === target && !beforeTurns.some((prior) => prior.turn_id === turn.turn_id))!;
      if (destination.session_id !== historicalTurn.session_id || destination.provider_session_uuid !== historicalTurn.provider_session_uuid) throw new Error("Historical resume lost its exact provider session ownership");
      const targetTexts = await adapter.fetchBotThreadTexts({ lane, receipt: historical });
      if (!targetTexts.some((text) => text.includes(`${marker}_${suffix}_DESTINATION`))) throw new Error("Historical Slack root lacks the resumed final reply");
      browserTargets.push(routerSearchResponseTarget(historical, destination.response_message_ts, `${marker}_${suffix}_DESTINATION`));
    }
    browserTargets.push(routerSearchResponseTarget(message, routerTurn.response_message_ts, expected));
    const database = new Database(context.state_database, { readonly: true });
    try {
      snapshots.push({ suffix, decision, router_turn: routerTurn, destination_turns: afterTurns.filter((turn) => turn.channel_id === target),
        search: searchRouterThreads(database, { channel: target, beforeTs: message.message_ts, concepts: suffix === "EMPTY" ? ["meridianwax", "penguinvault"] : incident.concepts }) });
    } finally { database.close(); }
    evidence.writeJson(`router-search-${suffix.toLowerCase()}.json`, { marker, receipts, snapshots, ...adapter.runSourceEvidence(), unsettled: 0 });
    return message;
  }

  await route(incident.trigger_text, "resume", "RESUME");
  await route("Continue our previous meridianwax penguinvault conversation.", "clarify", "EMPTY");
  await route(incident.trigger_text, "clarify", "FAILED", true);
  const competing = await post(target, `[sandbox:${options.runId}:router-search:competing] ${incident.historical_input}\nThis is a separate equally relevant conversation. Reply exactly: TL;DR: ${marker}_COMPETING hair loss and shower filter discussion recorded.`);
  receipts.push(competing);
  await adapter.waitForRouterSearchTurn(competing); await adapter.waitForRunSettled();
  await route("Continue one of our previous hair loss and shower filter conversations. I do not remember which discussion; I have no date or distinguishing detail.", "clarify", "AMBIGUOUS");

  const browserEvidence = [];
  for (const target of browserTargets) {
    const request = { lane_id: lane.lane_id, workspace_domain: options.workspaceDomain,
      browser_namespace: lane.browser.namespace, browser_profile_path: lane.browser.profile_path,
      phase: "terminal" as const, capture_name: `router-${target.message_ts}`, ...target,
      assertions: ["Exact historical routing or clarification outcome is visible in its owned Slack thread"] };
    assertBrowserRequestMatchesLane(request, lane);
    browserEvidence.push(evidence.verifyScreenshot(await options.browser.capture(request, evidence)));
  }
  await adapter.waitForRunSettled();
  const result = { case_id: "router-search", lane_id: lane.lane_id, app_id: lane.app_id, run_id: options.runId,
    marker, historical_root: historical.thread_ts, production_fixture_root: incident.historical_root_ts,
    receipts, snapshots, browser: browserEvidence, unsettled: 0, ...adapter.runSourceEvidence(), status: "passed" };
  evidence.writeJson("router-search.json", result);
  return result;
}
