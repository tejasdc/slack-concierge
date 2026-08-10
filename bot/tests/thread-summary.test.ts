import { describe, expect, test } from "bun:test";
import {
  buildSlackThreadSummaryContract,
  latestSlackThreadTldr,
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
    };
    const responses = [{ turn_id: 1, user_text: "First request", response_tldr: "First only.", agent_text: null }];

    expect(priorSlackThreadTldrs(status, responses)).toEqual([
      "Implemented the first request and verified the follow-up.",
    ]);
    expect(latestSlackThreadTldr(status, responses)).toBe(status.thread_tldr);
  });

  test("recovers every legacy final-answer TLDR for the first cumulative synthesis", () => {
    const responses = [
      {
        turn_id: 1,
        user_text: "Fix it",
        response_tldr: null,
        agent_text: "Progress commentary.\n\nTL;DR: Fixed the heartbeat.\n\nDetails",
      },
      {
        turn_id: 2,
        user_text: "Make it cumulative",
        response_tldr: "Added cumulative thread summaries.",
        agent_text: "ignored",
      },
    ];

    expect(priorSlackThreadTldrs(null, responses)).toEqual([
      "Request: Fix it\nOutcome: Fixed the heartbeat.",
      "Request: Make it cumulative\nOutcome: Added cumulative thread summaries.",
    ]);
    expect(latestSlackThreadTldr(null, responses)).toBe("Added cumulative thread summaries.");
  });

  test("requires the final response to replace the visible thread summary end to end", () => {
    const prompt = buildSlackThreadSummaryContract(["Fixed the heartbeat.", "Added retries."]);

    expect(prompt).toContain("first line of your final answer must be `TL;DR: <summary>`");
    expect(prompt).toContain("visible Slack thread");
    expect(prompt).toContain("all user requests and delivered agent outcomes");
    expect(prompt).toContain("- Fixed the heartbeat.");
    expect(prompt).toContain("- Added retries.");
  });
});
