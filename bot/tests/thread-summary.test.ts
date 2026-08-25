import { describe, expect, test } from "bun:test";
import {
  buildSlackThreadSummaryContext,
  latestSlackThreadTldr,
  priorAgentThreadTldrs,
  priorSlackThreadTldrs,
} from "../src/thread-summary";

describe("Slack thread summaries", () => {
  test("uses the durable cumulative summary instead of rebuilding delivered history", () => {
    const status = {
      slack_channel_id: "C1",
      slack_thread_ts: "1.0",
      slack_status_msg_ts: "1.1",
      thread_tldr: "Implemented the first request and verified the follow-up.",
      summary_through_turn_id: 2,
    } as any;
    const responses = [{ turn_id: 1, user_text: "First request", response_tldr: "First only.", agent_text: null }];

    expect(priorSlackThreadTldrs(status, responses)).toEqual([
      "Implemented the first request and verified the follow-up.",
    ]);
    expect(latestSlackThreadTldr(status, responses)).toBe(status.thread_tldr);
  });

  test("recovers every legacy final-answer TLDR for the first cumulative synthesis", () => {
    const responses = [
      { turn_id: 1, user_text: "Fix it", response_tldr: null, agent_text: "TL;DR: Fixed the heartbeat.\n\nDetails" },
      { turn_id: 2, user_text: "Make it cumulative", response_tldr: "Added cumulative summaries.", agent_text: "ignored" },
    ];
    expect(priorSlackThreadTldrs(null, responses)).toEqual([
      "Request: Fix it\nOutcome: Fixed the heartbeat.",
      "Request: Make it cumulative\nOutcome: Added cumulative summaries.",
    ]);
  });

  test("gives Agent turns only the latest already-cumulative summary", () => {
    const responses = [
      { turn_id: 1, user_text: "First request", response_tldr: "Contaminated old summary.", agent_text: null },
      { turn_id: 2, user_text: "Correction", response_tldr: "Corrected cumulative summary.", agent_text: null },
    ];

    expect(priorAgentThreadTldrs(null, responses)).toEqual([
      "Corrected cumulative summary.",
    ]);
  });

  test("adds only root-specific prior context, not another generic response contract", () => {
    const context = buildSlackThreadSummaryContext(["Fixed the heartbeat."]);
    expect(context).toContain("Prior delivered summaries for this visible Slack thread");
    expect(context).toContain("Fixed the heartbeat.");
    expect(context).not.toContain("first line of your final answer");
    expect(buildSlackThreadSummaryContext([])).toBe("");
  });
});
