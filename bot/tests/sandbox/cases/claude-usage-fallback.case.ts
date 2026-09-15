import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import type { LaneFixtureIdentities } from "../../../scripts/sandbox-provision";
import type { LiveTypedTurnAdapter } from "../adapters/live-typed-turn";
import { assertBrowserRequestMatchesLane, type SandboxBrowser } from "../support/browser";
import type { SandboxEvidenceWriter } from "../support/evidence";
import { routerSearchResponseTarget } from "./router-search.case";

export async function runClaudeUsageFallbackCase(options: {
  lane: LaneFixtureIdentities; workspaceDomain: string; runId: string;
  adapter: LiveTypedTurnAdapter; browser: SandboxBrowser; evidence: SandboxEvidenceWriter;
}) {
  const { adapter, lane, evidence } = options;
  const marker = `SANDBOX_CLAUDE_FALLBACK_${randomUUID().replaceAll("-", "")}`;
  const followupMarker = `FOLLOWUP_${randomUUID().replaceAll("-", "")}`;
  const root = await adapter.postUserMessage({ lane, channel_id: lane.channels.core.id, client_message_id: randomUUID(),
    text: `@cc [sandbox:${options.runId}:claude-usage-fallback] Remember ${marker}. Reply exactly: TL;DR: ${marker} remembered. Do not use tools.`,
  });
  const first = await adapter.waitForRouterSearchTurn(root);
  const reply = await adapter.postUserMessage({ lane, channel_id: root.channel_id, thread_ts: root.thread_ts, client_message_id: randomUUID(),
    text: `Recall the SANDBOX_CLAUDE_FALLBACK marker from my preceding request. Reply exactly TL;DR: followed by that complete marker, the word recalled, and ${followupMarker}. Do not use tools.`,
  });
  const second = await adapter.waitForRouterSearchTurn(reply);
  await adapter.waitForRunSettled();
  const database = new Database(adapter.routerSearchContext().state_database, { readonly: true });
  let selection: unknown;
  let acceptedInputs: Array<{ id: number; replay_text: string }>;
  try {
    selection = database.query("SELECT id, provider_model FROM turns WHERE id IN (?, ?) ORDER BY id").all(first.turn_id, second.turn_id);
    acceptedInputs = database.query("SELECT id, replay_text FROM turns WHERE id IN (?, ?) ORDER BY id").all(first.turn_id, second.turn_id) as typeof acceptedInputs;
  } finally { database.close(); }
  if (!first.provider_session_uuid || first.provider_session_uuid !== second.provider_session_uuid
      || first.session_id !== second.session_id
      || !first.outbound_text.startsWith(`TL;DR: ${marker} remembered`)
      || !second.outbound_text.startsWith(`TL;DR: ${marker} recalled ${followupMarker}`)
      || !acceptedInputs[0]?.replay_text.includes(marker)
      || !acceptedInputs[1]?.replay_text.includes(followupMarker)
      || [first, second].some(turn => turn.provider_id !== "claude-code" || !turn.outbound_text.includes("_model: claude-opus-5 - cwd: "))
      || JSON.stringify(selection) !== JSON.stringify([first, second].map(turn => ({ id: turn.turn_id, provider_model: "claude-fable-5-1" })))) {
    throw new Error("Usage fallback did not preserve the exact session, remembered history, Fable preference and Opus results");
  }
  const texts = await adapter.fetchBotThreadTexts({ lane, receipt: root });
  for (const word of ["remembered", "recalled"]) {
    if (texts.filter(text => text.startsWith(`TL;DR: ${marker} ${word}`)).length !== 1) throw new Error("Fallback duplicated or overwrote a delivered response");
  }
  const request = { lane_id: lane.lane_id, workspace_domain: options.workspaceDomain,
    browser_namespace: lane.browser.namespace, browser_profile_path: lane.browser.profile_path,
    phase: "terminal" as const, ...routerSearchResponseTarget(reply, second.response_message_ts, marker),
    required_text: [marker, "model: claude-opus-5 - cwd:"],
    assertions: ["The resumed conversation visibly recalls its prior marker and reports the actual Opus model"],
  };
  assertBrowserRequestMatchesLane(request, lane);
  const browser = evidence.verifyScreenshot(await options.browser.capture(request, evidence));
  const result = { case_id: "claude-usage-fallback", status: "passed", lane_id: lane.lane_id,
    app_id: lane.app_id, team_id: lane.team_id, run_id: options.runId, ...adapter.runSourceEvidence(),
    marker, followupMarker, root, reply, first, second, selection, acceptedInputs, browser, unsettled: 0 };
  evidence.writeJson("claude-usage-fallback.json", result);
  return result;
}
