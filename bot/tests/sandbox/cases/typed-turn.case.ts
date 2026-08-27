import { randomUUID } from "node:crypto";
import type { LaneFixtureIdentities } from "../../../scripts/sandbox-provision";
import type { SandboxBrowser } from "../support/browser";
import { assertBrowserRequestMatchesLane } from "../support/browser";
import type { SandboxEvidenceWriter, ScreenshotEvidence } from "../support/evidence";

export type TypedTurnPostReceipt = {
  channel_id: string;
  message_ts: string;
  thread_ts: string;
  permalink: string;
  client_message_id: string;
  delivery: "confirmed";
};

export type TypedTurnObservation = {
  api_app_id: string;
  input_channel_id: string;
  input_message_ts: string;
  input_kind: "turn";
  input_user_id: string;
  turn_id: number;
  provider_id: string;
  provider_session_uuid: string;
  provider_turn_id: string;
  turn_status: "done";
  delivery_status: "delivered";
  response_message_ts: string;
  response_thread_ts: string;
  response_permalink: string;
  agent_text: string;
};

export type TypedTurnDrain = {
  run_owned_unsettled: number;
  input_claims: number;
  turns: number;
  delivered_responses: number;
};

export interface TypedTurnAdapter {
  postUserMessage(input: {
    lane: LaneFixtureIdentities;
    text: string;
    client_message_id: string;
  }): Promise<TypedTurnPostReceipt>;
  waitForTurn(input: {
    lane: LaneFixtureIdentities;
    receipt: TypedTurnPostReceipt;
    marker: string;
  }): Promise<TypedTurnObservation>;
  drain(input: {
    lane: LaneFixtureIdentities;
    receipt: TypedTurnPostReceipt;
    observation: TypedTurnObservation;
  }): Promise<TypedTurnDrain>;
}

export class TypedTurnBoundaryUnavailable extends Error {
  readonly code = "typed_turn_adapter_unverified";
  constructor() {
    super(
      "No verified live typed-turn adapter is installed. Do not post to Slack. "
      + "The adapter must bind the selected lane's user-token write to the exact Socket Mode api_app_id, "
      + "durable input claim, turn/session, delivered response, and affected-run drain.",
    );
  }
}

export class UnverifiedTypedTurnAdapter implements TypedTurnAdapter {
  async postUserMessage(): Promise<TypedTurnPostReceipt> { throw new TypedTurnBoundaryUnavailable(); }
  async waitForTurn(): Promise<TypedTurnObservation> { throw new TypedTurnBoundaryUnavailable(); }
  async drain(): Promise<TypedTurnDrain> { throw new TypedTurnBoundaryUnavailable(); }
}

export type TypedTurnCaseResult = {
  case_id: "typed-turn";
  lane_id: string;
  app_id: string;
  run_id: string;
  marker: string;
  receipt: TypedTurnPostReceipt;
  observation: Omit<TypedTurnObservation, "agent_text"> & { marker_count: number };
  browser: ScreenshotEvidence;
  drain: TypedTurnDrain;
  status: "passed";
};

function countMarker(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

export async function runTypedTurnCase(options: {
  lane: LaneFixtureIdentities;
  workspaceDomain: string;
  runId: string;
  expectedProvider: string;
  adapter: TypedTurnAdapter;
  browser: SandboxBrowser;
  evidence: SandboxEvidenceWriter;
}): Promise<TypedTurnCaseResult> {
  const marker = `SANDBOX_TYPED_TURN_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  const clientMessageId = randomUUID();
  const text = `[sandbox:${options.runId}:typed-turn] Reply once and include this marker exactly once: ${marker}`;
  const receipt = await options.adapter.postUserMessage({ lane: options.lane, text, client_message_id: clientMessageId });
  if (receipt.delivery !== "confirmed" || receipt.channel_id !== options.lane.channels.core.id
      || receipt.thread_ts !== receipt.message_ts || receipt.client_message_id !== clientMessageId) {
    throw new Error("Typed-turn post receipt does not identify the selected lane root");
  }
  const observation = await options.adapter.waitForTurn({ lane: options.lane, receipt, marker });
  const markerCount = countMarker(observation.agent_text, marker);
  if (observation.api_app_id !== options.lane.app_id
      || observation.input_channel_id !== receipt.channel_id
      || observation.input_message_ts !== receipt.message_ts
      || observation.input_kind !== "turn"
      || observation.input_user_id !== options.lane.installer_user_id
      || observation.provider_id !== options.expectedProvider
      || !observation.provider_session_uuid
      || !observation.provider_turn_id
      || observation.turn_status !== "done"
      || observation.delivery_status !== "delivered"
      || observation.response_thread_ts !== receipt.thread_ts
      || markerCount !== 1) {
    throw new Error("Typed-turn durable observation failed exact identity/content assertions");
  }
  const browserRequest = {
    lane_id: options.lane.lane_id,
    workspace_domain: options.workspaceDomain,
    browser_namespace: options.lane.browser.namespace,
    browser_profile_path: options.lane.browser.profile_path,
    phase: "terminal" as const,
    permalink: observation.response_permalink,
    channel_id: receipt.channel_id,
    message_ts: observation.response_message_ts,
    thread_ts: observation.response_thread_ts,
    required_text: [marker],
    assertions: [
      "input root is visible in the selected lane core channel",
      "one terminal response is visible in the input thread",
      "terminal progress has no running spinner",
      "response contains the unique marker once",
    ],
  };
  assertBrowserRequestMatchesLane(browserRequest, options.lane);
  const browser = await options.browser.capture(browserRequest, options.evidence);
  const verifiedBrowser = options.evidence.verifyScreenshot(browser);
  const drain = await options.adapter.drain({ lane: options.lane, receipt, observation });
  if (drain.run_owned_unsettled !== 0 || drain.input_claims !== 1 || drain.turns !== 1 || drain.delivered_responses !== 1) {
    throw new Error("Typed-turn run did not drain to one exact delivered outcome");
  }
  const { agent_text: _agentText, ...observationEvidence } = observation;
  const result: TypedTurnCaseResult = {
    case_id: "typed-turn",
    lane_id: options.lane.lane_id,
    app_id: options.lane.app_id,
    run_id: options.runId,
    marker,
    receipt,
    observation: { ...observationEvidence, marker_count: markerCount },
    browser: verifiedBrowser,
    drain,
    status: "passed",
  };
  options.evidence.writeJson("typed-turn.json", result);
  return result;
}
