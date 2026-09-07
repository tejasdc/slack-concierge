import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LaneFixtureIdentities } from "../../../scripts/sandbox-provision";
import type { SandboxBrowser } from "../support/browser";
import { assertBrowserRequestMatchesLane } from "../support/browser";
import type { SandboxEvidenceWriter, ScreenshotEvidence } from "../support/evidence";

const fixture = JSON.parse(readFileSync(
  join(import.meta.dir, "../../fixtures/pebble-index-webhook-v1.json"),
  "utf8",
)) as {
  webhook_version: string;
  triggers: { single: string; double: string; test: string };
  test_transcription: string;
};

export type PebbleCaptureRequest = {
  transcription: string;
  recorded_at_ms: number;
  client: string;
  trigger?: string;
  webhook_version?: string;
};

export type PebbleCaptureReceipt = PebbleCaptureRequest & {
  http_status: number;
  event_id: string | null;
  duplicate: boolean | null;
  status: string | null;
  source_trigger: string | null;
  source_webhook_version: string | null;
  destination_kind: "slack" | "journal" | null;
  terminal_receipt: string | null;
  error: string | null;
};

export type PebbleRouteEffect = {
  event_id: string;
  capture_status: "delivered";
  source_trigger: string | null;
  source_webhook_version: string | null;
  destination_kind: "slack" | "journal";
  slack_message_count: number;
  slack_message_ts: string | null;
  input_claims: number;
  turns: number;
  delivered_responses: number;
  journal_file_name: string | null;
  journal_sha256: string | null;
  permalink: string | null;
};

export type PebbleTriggerRoutingObservation = {
  api_app_id: string;
  ingress_active: true;
  capture_process_pid: number;
  single: PebbleRouteEffect;
  double: PebbleRouteEffect;
  test: PebbleRouteEffect;
  legacy: PebbleRouteEffect;
  unknown: {
    event_id: string;
    capture_rows: number;
    slack_message_count: number;
    input_claims: number;
    turns: number;
    journal_file_count: number;
  };
  run_owned_unsettled: number;
};

export interface PebbleTriggerRoutingAdapter {
  submitPebbleCapture(input: PebbleCaptureRequest): Promise<PebbleCaptureReceipt>;
  waitForPebbleTriggerRouting(input: {
    lane: LaneFixtureIdentities;
    single: PebbleCaptureReceipt;
    double: PebbleCaptureReceipt;
    test: PebbleCaptureReceipt;
    legacy: PebbleCaptureReceipt;
    unknown: PebbleCaptureReceipt;
    unknown_event_id: string;
  }): Promise<PebbleTriggerRoutingObservation>;
}

export type PebbleTriggerRoutingCaseResult = {
  case_id: "pebble-trigger-routing";
  lane_id: string;
  app_id: string;
  run_id: string;
  marker: string;
  receipts: {
    single: PebbleCaptureReceipt;
    single_duplicate: PebbleCaptureReceipt;
    double: PebbleCaptureReceipt;
    test: PebbleCaptureReceipt;
    legacy: PebbleCaptureReceipt;
    unknown: PebbleCaptureReceipt;
  };
  observation: PebbleTriggerRoutingObservation;
  browser: ScreenshotEvidence;
  status: "passed";
};

function captureEventId(input: PebbleCaptureRequest): string {
  const hash = createHash("sha256");
  for (const part of [
    "pebble-index:v1",
    "pebble-index",
    String(input.recorded_at_ms),
    input.client,
    input.transcription,
  ]) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function assertAccepted(
  receipt: PebbleCaptureReceipt,
  expected: { eventId: string; status: number; trigger: string | null; kind: "slack" | "journal"; duplicate: boolean },
): void {
  if (receipt.http_status !== expected.status
      || receipt.event_id !== expected.eventId
      || receipt.duplicate !== expected.duplicate
      || receipt.source_trigger !== expected.trigger
      || receipt.source_webhook_version !== (expected.trigger ? fixture.webhook_version : null)
      || receipt.destination_kind !== expected.kind
      || receipt.error !== null) {
    throw new Error(`Pebble ingress receipt did not preserve the canonical route: ${JSON.stringify(receipt)}`);
  }
}

export async function runPebbleTriggerRoutingCase(options: {
  lane: LaneFixtureIdentities;
  workspaceDomain: string;
  runId: string;
  adapter: PebbleTriggerRoutingAdapter;
  browser: SandboxBrowser;
  evidence: SandboxEvidenceWriter;
}): Promise<PebbleTriggerRoutingCaseResult> {
  const marker = `SANDBOX_PEBBLE_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  const recordedAt = Date.now();
  const client = `sandbox-${options.runId}`;
  const singleRequest: PebbleCaptureRequest = {
    transcription: `${marker} preserve this thought without Slack`,
    recorded_at_ms: recordedAt,
    client,
    trigger: fixture.triggers.single,
    webhook_version: fixture.webhook_version,
  };
  const doubleRequest: PebbleCaptureRequest = {
    transcription: `Begin the final response with TL;DR: ${marker} double-click agent path accepted.`,
    recorded_at_ms: recordedAt + 1,
    client,
    trigger: fixture.triggers.double,
    webhook_version: fixture.webhook_version,
  };
  const testRequest: PebbleCaptureRequest = {
    transcription: fixture.test_transcription,
    recorded_at_ms: recordedAt + 2,
    client,
    trigger: fixture.triggers.test,
    webhook_version: fixture.webhook_version,
  };
  const legacyRequest: PebbleCaptureRequest = {
    transcription: `${marker} legacy headerless Slack path`,
    recorded_at_ms: recordedAt + 3,
    client,
  };
  const unknownRequest: PebbleCaptureRequest = {
    transcription: `${marker} unknown trigger must have no effect`,
    recorded_at_ms: recordedAt + 4,
    client,
    trigger: "future-unknown-trigger",
    webhook_version: fixture.webhook_version,
  };

  const single = await options.adapter.submitPebbleCapture(singleRequest);
  const singleDuplicate = await options.adapter.submitPebbleCapture(singleRequest);
  const double = await options.adapter.submitPebbleCapture(doubleRequest);
  const test = await options.adapter.submitPebbleCapture(testRequest);
  const legacy = await options.adapter.submitPebbleCapture(legacyRequest);
  const unknown = await options.adapter.submitPebbleCapture(unknownRequest);

  assertAccepted(single, {
    eventId: captureEventId(singleRequest), status: 202, trigger: fixture.triggers.single, kind: "journal", duplicate: false,
  });
  assertAccepted(singleDuplicate, {
    eventId: captureEventId(singleRequest), status: 200, trigger: fixture.triggers.single, kind: "journal", duplicate: true,
  });
  assertAccepted(double, {
    eventId: captureEventId(doubleRequest), status: 202, trigger: fixture.triggers.double, kind: "slack", duplicate: false,
  });
  assertAccepted(test, {
    eventId: captureEventId(testRequest), status: 202, trigger: fixture.triggers.test, kind: "slack", duplicate: false,
  });
  assertAccepted(legacy, {
    eventId: captureEventId(legacyRequest), status: 202, trigger: null, kind: "slack", duplicate: false,
  });
  if (unknown.http_status !== 422 || unknown.event_id !== null || unknown.error !== "unknown Pebble trigger: future-unknown-trigger") {
    throw new Error(`Unknown Pebble trigger did not fail closed: ${JSON.stringify(unknown)}`);
  }

  const observation = await options.adapter.waitForPebbleTriggerRouting({
    lane: options.lane,
    single,
    double,
    test,
    legacy,
    unknown,
    unknown_event_id: captureEventId(unknownRequest),
  });
  if (observation.api_app_id !== options.lane.app_id
      || observation.ingress_active !== true
      || observation.single.destination_kind !== "journal"
      || observation.single.slack_message_count !== 0
      || observation.single.input_claims !== 0
      || observation.single.turns !== 0
      || observation.single.journal_file_name !== `pebble-${single.event_id}.md`
      || !observation.single.journal_sha256
      || observation.double.destination_kind !== "slack"
      || observation.double.slack_message_count !== 1
      || observation.double.input_claims !== 1
      || observation.double.turns !== 1
      || observation.double.delivered_responses !== 1
      || observation.test.slack_message_count !== 1
      || observation.legacy.slack_message_count !== 1
      || observation.unknown.capture_rows !== 0
      || observation.unknown.slack_message_count !== 0
      || observation.unknown.input_claims !== 0
      || observation.unknown.turns !== 0
      || observation.unknown.journal_file_count !== 0
      || observation.run_owned_unsettled !== 0
      || !observation.double.permalink) {
    throw new Error("Pebble trigger routing did not join the expected durable, filesystem, Slack, and provider effects");
  }

  const browserRequest = {
    lane_id: options.lane.lane_id,
    workspace_domain: options.workspaceDomain,
    browser_namespace: options.lane.browser.namespace,
    browser_profile_path: options.lane.browser.profile_path,
    phase: "terminal" as const,
    permalink: observation.double.permalink,
    channel_id: options.lane.dm_channel_id,
    message_ts: observation.double.slack_message_ts!,
    thread_ts: observation.double.slack_message_ts!,
    required_text: [marker],
    assertions: [
      "the exact double-click capture is visible in the claimed lane DM",
      "the exact double-click thread contains its terminal agent response",
    ],
  };
  assertBrowserRequestMatchesLane(browserRequest, options.lane);
  const browser = options.evidence.verifyScreenshot(
    await options.browser.capture(browserRequest, options.evidence),
  );

  const result: PebbleTriggerRoutingCaseResult = {
    case_id: "pebble-trigger-routing",
    lane_id: options.lane.lane_id,
    app_id: options.lane.app_id,
    run_id: options.runId,
    marker,
    receipts: { single, single_duplicate: singleDuplicate, double, test, legacy, unknown },
    observation,
    browser,
    status: "passed",
  };
  options.evidence.writeJson("pebble-trigger-routing.json", result);
  return result;
}
