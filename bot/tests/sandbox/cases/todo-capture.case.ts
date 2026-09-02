import { randomUUID } from "node:crypto";
import type { LaneFixtureIdentities } from "../../../scripts/sandbox-provision";
import type { SandboxBrowser } from "../support/browser";
import { assertBrowserRequestMatchesLane } from "../support/browser";
import type { SandboxEvidenceWriter, ScreenshotEvidence } from "../support/evidence";
import type { TypedTurnPostReceipt } from "./typed-turn.case";

export type TodoCaptureObservation = {
  api_app_id: string;
  input_channel_id: string;
  input_message_ts: string;
  input_kind: "capture";
  input_user_id: string;
  input_text: string;
  capture_vault_status: "done";
  capture_list_status: "skipped";
  capture_confirmation_status: "delivered";
  capture_confirmation_attempts: number;
  reaction_name: "white_check_mark";
  reaction_count: number;
  reaction_user_ids: string[];
  thread_reply_count: number;
};

export type TodoCaptureDrain = {
  run_owned_unsettled: number;
  input_claims: number;
  turns: number;
  delivered_confirmations: number;
};

export interface TodoCaptureAdapter {
  postUserMessage(input: {
    lane: LaneFixtureIdentities;
    channel_id: string;
    text: string;
    client_message_id: string;
  }): Promise<TypedTurnPostReceipt>;
  waitForTodoCapture(input: {
    lane: LaneFixtureIdentities;
    receipt: TypedTurnPostReceipt;
  }): Promise<TodoCaptureObservation>;
  drainTodoCapture(input: {
    lane: LaneFixtureIdentities;
    receipt: TypedTurnPostReceipt;
    observation: TodoCaptureObservation;
  }): Promise<TodoCaptureDrain>;
}

export type TodoCaptureCaseResult = {
  case_id: "todo-capture";
  lane_id: string;
  app_id: string;
  run_id: string;
  marker: string;
  receipt: TypedTurnPostReceipt;
  observation: TodoCaptureObservation;
  browser: ScreenshotEvidence;
  drain: TodoCaptureDrain;
  status: "passed";
};

export async function runTodoCaptureCase(options: {
  lane: LaneFixtureIdentities;
  workspaceDomain: string;
  runId: string;
  adapter: TodoCaptureAdapter;
  browser: SandboxBrowser;
  evidence: SandboxEvidenceWriter;
}): Promise<TodoCaptureCaseResult> {
  const marker = `SANDBOX_TODO_CAPTURE_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  const clientMessageId = randomUUID();
  const text = `!todo ${marker} acknowledge this capture without creating a thread reply`;
  const channelId = options.lane.channels.capture.id;
  const receipt = await options.adapter.postUserMessage({
    lane: options.lane,
    channel_id: channelId,
    text,
    client_message_id: clientMessageId,
  });
  if (receipt.delivery !== "confirmed" || receipt.channel_id !== channelId
      || receipt.thread_ts !== receipt.message_ts || receipt.client_message_id !== clientMessageId) {
    throw new Error("Todo-capture post receipt does not identify the selected lane root");
  }

  const observation = await options.adapter.waitForTodoCapture({ lane: options.lane, receipt });
  if (observation.api_app_id !== options.lane.app_id
      || observation.input_channel_id !== receipt.channel_id
      || observation.input_message_ts !== receipt.message_ts
      || observation.input_kind !== "capture"
      || observation.input_user_id !== options.lane.installer_user_id
      || observation.input_text !== text
      || observation.capture_vault_status !== "done"
      || observation.capture_list_status !== "skipped"
      || observation.capture_confirmation_status !== "delivered"
      || observation.capture_confirmation_attempts < 1
      || observation.reaction_name !== "white_check_mark"
      || observation.reaction_count !== 1
      || JSON.stringify(observation.reaction_user_ids) !== JSON.stringify([options.lane.bot_user_id])
      || observation.thread_reply_count !== 0) {
    throw new Error("Todo-capture observation failed exact durable and Slack-visible assertions");
  }

  const browserRequest = {
    lane_id: options.lane.lane_id,
    workspace_domain: options.workspaceDomain,
    browser_namespace: options.lane.browser.namespace,
    browser_profile_path: options.lane.browser.profile_path,
    phase: "terminal" as const,
    permalink: receipt.permalink,
    channel_id: receipt.channel_id,
    message_ts: receipt.message_ts,
    thread_ts: receipt.thread_ts,
    required_text: [marker],
    assertions: [
      "the exact todo message is visible with a white-check-mark reaction",
      "the exact todo message has no thread reply",
    ],
  };
  assertBrowserRequestMatchesLane(browserRequest, options.lane);
  const browser = options.evidence.verifyScreenshot(
    await options.browser.capture(browserRequest, options.evidence),
  );
  const drain = await options.adapter.drainTodoCapture({ lane: options.lane, receipt, observation });
  if (drain.run_owned_unsettled !== 0 || drain.input_claims !== 1
      || drain.turns !== 0 || drain.delivered_confirmations !== 1) {
    throw new Error("Todo-capture sandbox run did not drain to one settled capture and zero provider turns");
  }

  const result: TodoCaptureCaseResult = {
    case_id: "todo-capture",
    lane_id: options.lane.lane_id,
    app_id: options.lane.app_id,
    run_id: options.runId,
    marker,
    receipt,
    observation,
    browser,
    drain,
    status: "passed",
  };
  options.evidence.writeJson("todo-capture.json", result);
  return result;
}
