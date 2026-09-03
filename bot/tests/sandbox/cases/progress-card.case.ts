import { randomUUID } from "node:crypto";
import type { LaneFixtureIdentities } from "../../../scripts/sandbox-provision";
import type { TypedTurnRunningObservation, TypedTurnPostReceipt } from "./typed-turn.case";
import type { SandboxBrowser } from "../support/browser";
import { assertBrowserRequestMatchesLane } from "../support/browser";
import type { SandboxEvidenceWriter, ScreenshotEvidence } from "../support/evidence";

export type ProgressCardObservation = {
  api_app_id: string;
  turn_id: number;
  provider_id: "codex";
  turn_status: "done";
  delivery_status: "delivered";
  progress_row_count: 1;
  progress_page_number: 0;
  progress_message_ts: string;
  stored_commentary_count: number;
  stored_activity_count: number;
  slack_progress_reply_count: 1;
  slack_bot_reply_count: 2;
  work_complete_title: string;
  plan_title: string;
  earlier_progress_title: string;
  continued_below_count: 0;
  response_message_ts: string;
  marker_count: 1;
};

export interface ProgressCardAdapter {
  postUserMessage(input: {
    lane: LaneFixtureIdentities;
    channel_id: string;
    text: string;
    client_message_id: string;
  }): Promise<TypedTurnPostReceipt>;
  waitForRunning(input: {
    lane: LaneFixtureIdentities;
    receipt: TypedTurnPostReceipt;
  }): Promise<TypedTurnRunningObservation>;
  waitForProgressCard(input: {
    lane: LaneFixtureIdentities;
    receipt: TypedTurnPostReceipt;
    running: TypedTurnRunningObservation;
    marker: string;
  }): Promise<ProgressCardObservation>;
  waitForRunSettled(): Promise<void>;
}

export type ProgressCardCaseResult = {
  case_id: "progress-card";
  lane_id: string;
  app_id: string;
  run_id: string;
  marker: string;
  receipt: TypedTurnPostReceipt;
  running: TypedTurnRunningObservation;
  observation: ProgressCardObservation;
  browser: ScreenshotEvidence;
  status: "passed";
};

export async function runProgressCardCase(options: {
  lane: LaneFixtureIdentities;
  workspaceDomain: string;
  runId: string;
  adapter: ProgressCardAdapter;
  browser: SandboxBrowser;
  evidence: SandboxEvidenceWriter;
}): Promise<ProgressCardCaseResult> {
  const marker = `SANDBOX_PROGRESS_CARD_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  const channelId = options.lane.channels.core.id;
  const text = [
    `[sandbox:${options.runId}:progress-card] This is an exact progress-card acceptance run.`,
    "Use update_plan immediately with exactly four steps. Mark step 1 complete and step 2 in progress.",
    "Then perform exactly 26 cycles sequentially. In every cycle, first send a distinct short commentary update named Progress cycle NN, then make one separate functions.exec call that runs pwd. Do not combine or parallelize cycles or tool calls.",
    "Keep step 2 in progress through all 26 cycles. After the last tool call, update the same plan so all four steps are complete; the visible plan must say Step 4/4.",
    `Only then respond exactly: TL;DR: ${marker} one progress message accepted.`,
  ].join("\n");
  const clientMessageId = randomUUID();
  const receipt = await options.adapter.postUserMessage({
    lane: options.lane,
    channel_id: channelId,
    text,
    client_message_id: clientMessageId,
  });
  if (receipt.delivery !== "confirmed" || receipt.channel_id !== channelId
      || receipt.thread_ts !== receipt.message_ts || receipt.client_message_id !== clientMessageId) {
    throw new Error("Progress-card post receipt does not identify the selected lane root");
  }
  const running = await options.adapter.waitForRunning({ lane: options.lane, receipt });
  if (running.api_app_id !== options.lane.app_id || running.provider_id !== "codex"
      || !running.provider_session_uuid || !running.provider_turn_id
      || !running.progress_message_ts || !running.progress_permalink) {
    throw new Error("Progress-card running state was not bound to the exact Codex turn");
  }
  const observation = await options.adapter.waitForProgressCard({
    lane: options.lane,
    receipt,
    running,
    marker,
  });
  if (observation.api_app_id !== options.lane.app_id
      || observation.turn_id !== running.turn_id
      || observation.provider_id !== "codex"
      || observation.turn_status !== "done"
      || observation.delivery_status !== "delivered"
      || observation.progress_row_count !== 1
      || observation.progress_page_number !== 0
      || observation.progress_message_ts !== running.progress_message_ts
      || observation.stored_commentary_count < 26
      || observation.stored_activity_count > 1
      || observation.slack_progress_reply_count !== 1
      || observation.slack_bot_reply_count !== 2
      || !observation.work_complete_title.startsWith("Work complete · ")
      || observation.plan_title !== "4/4 steps complete"
      || !observation.earlier_progress_title.startsWith("Earlier progress")
      || observation.continued_below_count !== 0
      || observation.marker_count !== 1) {
    throw new Error("Progress-card observation failed exact durable and Slack-visible assertions");
  }
  await options.adapter.waitForRunSettled();

  const browserRequest = {
    lane_id: options.lane.lane_id,
    workspace_domain: options.workspaceDomain,
    browser_namespace: options.lane.browser.namespace,
    browser_profile_path: options.lane.browser.profile_path,
    phase: "terminal" as const,
    permalink: running.progress_permalink,
    channel_id: receipt.channel_id,
    message_ts: running.progress_message_ts,
    thread_ts: receipt.thread_ts,
    required_text: ["Work complete ·", "4/4 steps complete", "Earlier progress", marker],
    assertions: [
      "the exact thread contains one Agent task progress reply updated in place",
      "the sole terminal progress card visibly shows Work complete, Step 4/4, and Earlier progress",
      "no older progress card or continued-below plan remains in the thread",
    ],
  };
  assertBrowserRequestMatchesLane(browserRequest, options.lane);
  const browser = options.evidence.verifyScreenshot(
    await options.browser.capture(browserRequest, options.evidence),
  );
  const result: ProgressCardCaseResult = {
    case_id: "progress-card",
    lane_id: options.lane.lane_id,
    app_id: options.lane.app_id,
    run_id: options.runId,
    marker,
    receipt,
    running,
    observation,
    browser,
    status: "passed",
  };
  options.evidence.writeJson("progress-card.json", result);
  return result;
}
