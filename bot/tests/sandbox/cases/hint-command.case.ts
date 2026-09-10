import { randomUUID } from "node:crypto";
import type { LaneFixtureIdentities } from "../../../scripts/sandbox-provision";
import type { LiveTypedTurnAdapter } from "../adapters/live-typed-turn";
import type { SandboxBrowser } from "../support/browser";
import type { SandboxEvidenceWriter } from "../support/evidence";

export async function runHintCommandCase(options: {
  lane: LaneFixtureIdentities;
  workspaceDomain: string;
  runId: string;
  adapter: LiveTypedTurnAdapter;
  browser: SandboxBrowser;
  evidence: SandboxEvidenceWriter;
}) {
  const { lane, adapter, evidence } = options;
  const observations = [];
  const hint = async (channelId: string, threadTs?: string, visual = false) => {
    const receipt = await adapter.postUserMessage({ lane, channel_id: channelId, text: "!hint",
      client_message_id: randomUUID(), ...(threadTs ? { thread_ts: threadTs } : {}) });
    const observation = await adapter.waitForHint(receipt);
    for (const required of ["@cx-fast", "@cc-fast", "@cc-fable", "!todo", "!note", "!fork", "/switch-provider", "/mode", "Fork from here"]) {
      if (!observation.text.includes(required)) throw new Error(`Hint omitted ${required}`);
    }
    const screenshot = visual ? evidence.verifyScreenshot(await options.browser.capture({
      lane_id: lane.lane_id,
      workspace_domain: options.workspaceDomain,
      browser_namespace: lane.browser.namespace,
      browser_profile_path: lane.browser.profile_path,
      phase: "terminal",
      permalink: observation.permalink,
      channel_id: channelId,
      message_ts: observation.response_message_ts,
      thread_ts: receipt.thread_ts,
      required_text: ["Concierge commands and shortcuts available here"],
      assertions: ["the command reference is a reply in the exact invoking thread"],
    }, evidence)) : undefined;
    observations.push({ receipt, observation, screenshot });
    return observation;
  };

  for (const channelId of [lane.channels.core.id, lane.dm_channel_id]) {
    const unregistered = await hint(channelId);
    if (unregistered.channel !== null || !unregistered.text.includes("no channel registration yet")) {
      throw new Error("Hint unexpectedly registered the fresh conversation");
    }
  }

  const marker = `SANDBOX_CLAUDE_STEERING_ACK_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  const root = await adapter.postUserMessage({ lane, channel_id: lane.channels.core.id,
    text: `@cc Keep this sandbox turn open until guidance arrives. ${marker}`, client_message_id: randomUUID() });
  const running = await adapter.waitForTurnDispatchState({ lane, receipt: root, statuses: ["running"] });
  const active = await hint(root.channel_id, root.thread_ts, true);
  if (!active.channel || !active.text.includes(lane.channels.core.name)) throw new Error("Hint omitted the invoking channel registry");

  const steering = await adapter.postUserMessage({ lane, channel_id: root.channel_id, thread_ts: root.thread_ts,
    text: `Finish now and include ${marker}.`, client_message_id: randomUUID() });
  const acknowledgement = await adapter.waitForSteeringAcknowledgement({ lane, rootReceipt: root, steeringReceipt: steering });
  const terminal = await adapter.waitForTurnDispatchState({ lane, receipt: root, statuses: ["done"] });
  if (terminal.turn_id !== running.turn_id || acknowledgement.turn_id !== running.turn_id
      || !terminal.outbound_text?.includes(marker)) throw new Error("Hint disrupted the active turn");
  await adapter.waitForRunSettled();

  adapter.configureHintFixture();
  const silent = await hint(root.channel_id, undefined, true);
  for (const required of ["agent replies are disabled", "Default: `@cc-fast`", "shared across this channel"]) {
    if (!silent.text.includes(required)) throw new Error(`Registry-aware hint omitted ${required}`);
  }
  await hint(root.channel_id, root.thread_ts);
  await adapter.waitForRunSettled();
  const result = { case_id: "hint-command", status: "passed", lane_id: lane.lane_id, run_id: options.runId,
    source: adapter.runSourceEvidence(), observations, running, acknowledgement, terminal, run_owned_unsettled: 0 };
  evidence.writeJson("hint-command.json", result);
  return result;
}
