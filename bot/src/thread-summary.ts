import type { SlackThreadResponseRow, SlackThreadStatusRow } from "./state";
import { extractLastTldr } from "./text";

export function priorSlackThreadTldrs(
  status: SlackThreadStatusRow | null,
  responses: SlackThreadResponseRow[],
): string[] {
  if (status?.thread_tldr) return [status.thread_tldr];
  return responses
    .map((response) => {
      const outcome = response.response_tldr || extractLastTldr(response.agent_text || "");
      return outcome ? `Request: ${response.user_text}\nOutcome: ${outcome}` : null;
    })
    .filter((summary): summary is string => !!summary);
}

export function latestSlackThreadTldr(
  status: SlackThreadStatusRow | null,
  responses: SlackThreadResponseRow[],
): string | null {
  if (status?.thread_tldr) return status.thread_tldr;
  const latest = responses.at(-1);
  return latest?.response_tldr || extractLastTldr(latest?.agent_text || "") || null;
}

export function buildSlackThreadSummaryContract(previousTldrs: string[]): string {
  const priorContext = previousTldrs.length > 0
    ? [
        "Prior delivered summaries for this visible Slack thread:",
        "<prior_thread_summaries>",
        ...previousTldrs.map((summary) => `- ${summary}`),
        "</prior_thread_summaries>",
      ].join("\n")
    : "There are no earlier delivered responses in this visible Slack thread.";

  return [
    "Cumulative Slack thread TL;DR contract:",
    "- The first line of your final answer must be `TL;DR: <summary>`.",
    "- That line is the durable summary shown at the top of this visible Slack thread.",
    "- Replace it on every completed turn with a concise end-to-end summary of all user requests and delivered agent outcomes in this Slack thread through the current turn.",
    "- Synthesize the current state; do not merely repeat or append the latest response summary.",
    "- Commentary/status updates during work are not final answers and do not update the durable summary.",
    priorContext,
  ].join("\n");
}
