import { randomUUID } from "node:crypto";
import type { LaneFixtureIdentities } from "../../../scripts/sandbox-provision";
import type { TurnDispatchStateRow } from "../adapters/live-typed-turn";
import type { SandboxBrowser } from "../support/browser";
import { assertBrowserRequestMatchesLane } from "../support/browser";
import type { SandboxEvidenceWriter, ScreenshotEvidence } from "../support/evidence";
import type { TypedTurnPostReceipt } from "./typed-turn.case";

export type ClaudeSteeringAcknowledgementObservation = {
  api_app_id: string;
  turn_id: number;
  provider_id: "claude-code";
  input_channel_id: string;
  input_message_ts: string;
  input_kind: "steering";
  input_user_id: string;
  input_text: string;
  root_thread_ts: string;
  steering_status: "sent";
  steering_notice_status: "delivered";
  steering_notice_attempts: number;
  replay_text: string;
  replay_ready: 1;
  unreplayable_attachment_count: 0;
  reaction_name: "arrow_right_hook";
  reaction_count: 1;
  reaction_user_ids: string[];
  failure_notice_count: 0;
};

export interface ClaudeSteeringAckAdapter {
  postUserMessage(input: {
    lane: LaneFixtureIdentities;
    channel_id: string;
    text: string;
    client_message_id: string;
    thread_ts?: string;
  }): Promise<TypedTurnPostReceipt>;
  waitForTurnDispatchState(input: {
    lane: LaneFixtureIdentities;
    receipt: TypedTurnPostReceipt;
    statuses: string[];
    minDispatchAttempt?: number;
    statusProjectionDelivered?: boolean;
  }): Promise<TurnDispatchStateRow>;
  waitForSteeringAcknowledgement(input: {
    lane: LaneFixtureIdentities;
    rootReceipt: TypedTurnPostReceipt;
    steeringReceipt: TypedTurnPostReceipt;
  }): Promise<ClaudeSteeringAcknowledgementObservation>;
  fetchBotThreadTexts(input: {
    lane: LaneFixtureIdentities;
    receipt: TypedTurnPostReceipt;
  }): Promise<string[]>;
  waitForRunSettled(): Promise<void>;
}

export type ClaudeSteeringAckCaseResult = {
  case_id: "claude-steering-ack";
  lane_id: string;
  app_id: string;
  run_id: string;
  marker: string;
  root_receipt: TypedTurnPostReceipt;
  steering_receipt: TypedTurnPostReceipt;
  observation: ClaudeSteeringAcknowledgementObservation;
  terminal_turn: TurnDispatchStateRow;
  browser: ScreenshotEvidence;
  status: "passed";
};

export async function runClaudeSteeringAckCase(options: {
  lane: LaneFixtureIdentities;
  workspaceDomain: string;
  runId: string;
  adapter: ClaudeSteeringAckAdapter;
  browser: SandboxBrowser;
  evidence: SandboxEvidenceWriter;
}): Promise<ClaudeSteeringAckCaseResult> {
  const marker = `SANDBOX_CLAUDE_STEERING_ACK_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  const channelId = options.lane.channels.core.id;
  const rootReceipt = await options.adapter.postUserMessage({
    lane: options.lane,
    channel_id: channelId,
    text: `@cc Keep this sandbox turn open until a steering follow-up arrives. Run marker: ${marker}`,
    client_message_id: randomUUID(),
  });
  const running = await options.adapter.waitForTurnDispatchState({
    lane: options.lane,
    receipt: rootReceipt,
    statuses: ["running"],
    minDispatchAttempt: 1,
  });
  if (running.provider_id !== "claude-code") {
    throw new Error("Claude steering root did not enter the Claude Code provider boundary");
  }

  const steeringText = `Steer the active turn now and include ${marker} in the final response.`;
  const steeringReceipt = await options.adapter.postUserMessage({
    lane: options.lane,
    channel_id: channelId,
    text: steeringText,
    client_message_id: randomUUID(),
    thread_ts: rootReceipt.thread_ts,
  });
  const observation = await options.adapter.waitForSteeringAcknowledgement({
    lane: options.lane,
    rootReceipt,
    steeringReceipt,
  });
  if (observation.api_app_id !== options.lane.app_id
      || observation.turn_id !== running.turn_id
      || observation.provider_id !== "claude-code"
      || observation.input_channel_id !== channelId
      || observation.input_message_ts !== steeringReceipt.message_ts
      || observation.input_kind !== "steering"
      || observation.input_user_id !== options.lane.installer_user_id
      || observation.input_text !== steeringText
      || observation.root_thread_ts !== rootReceipt.thread_ts
      || observation.steering_status !== "sent"
      || observation.steering_notice_status !== "delivered"
      || observation.steering_notice_attempts < 1
      || observation.replay_ready !== 1
      || observation.unreplayable_attachment_count !== 0
      || !observation.replay_text.includes(marker)
      || observation.reaction_name !== "arrow_right_hook"
      || observation.reaction_count !== 1
      || JSON.stringify(observation.reaction_user_ids) !== JSON.stringify([options.lane.bot_user_id])
      || observation.failure_notice_count !== 0) {
    throw new Error("Claude steering observation failed exact durable, replay, and Slack-visible assertions");
  }

  const terminalTurn = await options.adapter.waitForTurnDispatchState({
    lane: options.lane,
    receipt: rootReceipt,
    statuses: ["done"],
    minDispatchAttempt: 1,
  });
  if (terminalTurn.delivery_status !== "delivered" || !terminalTurn.outbound_text?.includes(marker)) {
    throw new Error("Claude steering turn did not deliver the steering-dependent terminal response");
  }
  await options.adapter.waitForRunSettled();
  const botTexts = await options.adapter.fetchBotThreadTexts({ lane: options.lane, receipt: rootReceipt });
  if (!botTexts.some((text) => text.includes(marker))
      || botTexts.some((text) => text.includes("provider delivery receipt for that steering message"))) {
    throw new Error("Claude steering Slack thread omitted the final marker or exposed a false ambiguity notice");
  }

  const browserRequest = {
    lane_id: options.lane.lane_id,
    workspace_domain: options.workspaceDomain,
    browser_namespace: options.lane.browser.namespace,
    browser_profile_path: options.lane.browser.profile_path,
    phase: "terminal" as const,
    permalink: steeringReceipt.permalink,
    channel_id: steeringReceipt.channel_id,
    message_ts: steeringReceipt.message_ts,
    thread_ts: rootReceipt.thread_ts,
    required_text: [marker],
    assertions: [
      "the exact steering reply is visible with one arrow-right-hook reaction",
      "the thread contains the steering-dependent terminal response and no ambiguity warning",
    ],
  };
  assertBrowserRequestMatchesLane(browserRequest, options.lane);
  const browser = options.evidence.verifyScreenshot(
    await options.browser.capture(browserRequest, options.evidence),
  );
  const result: ClaudeSteeringAckCaseResult = {
    case_id: "claude-steering-ack",
    lane_id: options.lane.lane_id,
    app_id: options.lane.app_id,
    run_id: options.runId,
    marker,
    root_receipt: rootReceipt,
    steering_receipt: steeringReceipt,
    observation,
    terminal_turn: terminalTurn,
    browser,
    status: "passed",
  };
  options.evidence.writeJson("claude-steering-ack.json", result);
  return result;
}
