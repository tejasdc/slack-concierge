import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import type { LaneFixtureIdentities } from "../../../scripts/sandbox-provision";
import type { TurnDispatchStateRow } from "../adapters/live-typed-turn";
import type { SandboxBrowser } from "../support/browser";
import { assertBrowserRequestMatchesLane } from "../support/browser";
import type { SandboxEvidenceWriter, ScreenshotEvidence } from "../support/evidence";
import type { TypedTurnPostReceipt } from "./typed-turn.case";

// Replays the provider-auth incident end to end: the lane's claude-code CLI is
// a stub that fails with the production authentication error while the broken
// marker file exists. The case proves the park with actionable remediation, one
// auto-resume per new-input boundary while the provider stays broken, and the
// full FIFO drain through the real mechanism once the provider is healed.

export interface ParkedResumeAdapter {
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
    failureClass?: string;
    statusProjectionDelivered?: boolean;
  }): Promise<TurnDispatchStateRow>;
  fetchBotThreadTexts(input: {
    lane: LaneFixtureIdentities;
    receipt: TypedTurnPostReceipt;
  }): Promise<string[]>;
  waitForRunSettled(): Promise<void>;
}

export type ParkedResumeCaseResult = {
  case_id: "parked-resume";
  lane_id: string;
  app_id: string;
  run_id: string;
  marker: string;
  session_id: number;
  parked_turn_id: number;
  parked_attempts_while_broken: number;
  remediation_notice: string;
  successor_turn_ids: number[];
  browser: ScreenshotEvidence;
  status: "passed";
};

export async function runParkedResumeCase(options: {
  lane: LaneFixtureIdentities;
  workspaceDomain: string;
  runId: string;
  brokenMarkerPath: string;
  adapter: ParkedResumeAdapter;
  browser: SandboxBrowser;
  evidence: SandboxEvidenceWriter;
}): Promise<ParkedResumeCaseResult> {
  if (!existsSync(options.brokenMarkerPath)) {
    throw new Error("The broken-provider marker file must exist before the case starts");
  }
  const marker = `PARKED_RESUME_${randomUUID().replaceAll("-", "").toUpperCase().slice(0, 12)}`;
  const channelId = options.lane.channels.core.id;
  const post = (text: string, threadTs?: string) => options.adapter.postUserMessage({
    lane: options.lane,
    channel_id: channelId,
    text,
    client_message_id: randomUUID(),
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });

  // 1. The first request parks with the terminal auth failure and an
  //    actionable attention notice.
  const rootReceipt = await post(`@cc Reply with exactly the text ${marker}-FIRST and nothing else.`);
  const parkedFirst = await options.adapter.waitForTurnDispatchState({
    lane: options.lane,
    receipt: rootReceipt,
    statuses: ["parked"],
    minDispatchAttempt: 1,
    failureClass: "parked_terminal",
    statusProjectionDelivered: true,
  });
  const threadTexts = await options.adapter.fetchBotThreadTexts({ lane: options.lane, receipt: rootReceipt });
  const remediationNotice = threadTexts.find((text) =>
    text.includes(`turn ${parkedFirst.turn_id}`)
    && text.includes("Failed to authenticate")
    && text.includes("/auth-refresh claude-code")
    && text.includes("Retry in the Agent Sessions App Home")) || "";
  if (!remediationNotice) {
    throw new Error(`No attention notice with remediation guidance found for turn ${parkedFirst.turn_id}`);
  }

  // 2. A queued successor grants exactly one auto-resume; the still-broken
  //    provider parks the same turn again with a new fenced attempt while the
  //    successor stays queued.
  const secondReceipt = await post(
    `Reply with exactly the text ${marker}-SECOND and nothing else.`,
    rootReceipt.message_ts,
  );
  const parkedAgain = await options.adapter.waitForTurnDispatchState({
    lane: options.lane,
    receipt: rootReceipt,
    statuses: ["parked"],
    minDispatchAttempt: 2,
    failureClass: "parked_terminal",
  });
  const queuedSecond = await options.adapter.waitForTurnDispatchState({
    lane: options.lane,
    receipt: secondReceipt,
    statuses: ["queued"],
  });
  if (parkedAgain.turn_id !== parkedFirst.turn_id
      || queuedSecond.session_id !== parkedFirst.session_id
      || queuedSecond.turn_id <= parkedFirst.turn_id) {
    throw new Error("The successor did not queue behind the exact re-parked head turn in the same session");
  }

  // 3. Heal the provider, then a new input boundary resumes the parked head
  //    and the whole session drains in FIFO order through the real queue.
  rmSync(options.brokenMarkerPath);
  const thirdReceipt = await post(
    `Reply with exactly the text ${marker}-THIRD and nothing else.`,
    rootReceipt.message_ts,
  );
  const doneFirst = await options.adapter.waitForTurnDispatchState({
    lane: options.lane,
    receipt: rootReceipt,
    statuses: ["done"],
    minDispatchAttempt: 3,
  });
  const doneSecond = await options.adapter.waitForTurnDispatchState({
    lane: options.lane,
    receipt: secondReceipt,
    statuses: ["done"],
  });
  const doneThird = await options.adapter.waitForTurnDispatchState({
    lane: options.lane,
    receipt: thirdReceipt,
    statuses: ["done"],
  });
  for (const [label, turn, expectedMarker] of [
    ["first", doneFirst, `${marker}-FIRST`],
    ["second", doneSecond, `${marker}-SECOND`],
    ["third", doneThird, `${marker}-THIRD`],
  ] as const) {
    if (turn.session_id !== parkedFirst.session_id
        || turn.delivery_status !== "delivered"
        || !turn.outbound_text?.includes(expectedMarker)) {
      throw new Error(`The ${label} turn did not deliver its exact marker response in the shared session`);
    }
  }
  if (!(doneFirst.turn_id < doneSecond.turn_id && doneSecond.turn_id < doneThird.turn_id)) {
    throw new Error("Session turns did not retain FIFO identity order");
  }
  await options.adapter.waitForRunSettled();

  const browserRequest = {
    lane_id: options.lane.lane_id,
    workspace_domain: options.workspaceDomain,
    browser_namespace: options.lane.browser.namespace,
    browser_profile_path: options.lane.browser.profile_path,
    phase: "terminal" as const,
    permalink: rootReceipt.permalink,
    channel_id: rootReceipt.channel_id,
    message_ts: rootReceipt.message_ts,
    thread_ts: rootReceipt.message_ts,
    // The exact case thread is proven in the authenticated client through its
    // unique root marker, which renders in the main channel pane. The
    // remediation-notice text and per-turn FIFO delivery are asserted above
    // through the Slack API and durable state, which own that substance.
    required_text: [marker],
    assertions: [
      "the exact parked-resume case thread root is visible in the authenticated lane client",
    ],
  };
  assertBrowserRequestMatchesLane(browserRequest, options.lane);
  const browser = options.evidence.verifyScreenshot(
    await options.browser.capture(browserRequest, options.evidence),
  );

  const result: ParkedResumeCaseResult = {
    case_id: "parked-resume",
    lane_id: options.lane.lane_id,
    app_id: options.lane.app_id,
    run_id: options.runId,
    marker,
    session_id: parkedFirst.session_id,
    parked_turn_id: parkedFirst.turn_id,
    parked_attempts_while_broken: parkedAgain.dispatch_attempt,
    remediation_notice: remediationNotice,
    successor_turn_ids: [doneSecond.turn_id, doneThird.turn_id],
    browser,
    status: "passed",
  };
  options.evidence.writeJson("parked-resume.json", result);
  return result;
}
