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

export function priorAgentThreadTldrs(
  status: SlackThreadStatusRow | null,
  responses: SlackThreadResponseRow[],
): string[] {
  const latest = latestSlackThreadTldr(status, responses);
  return latest ? [latest] : [];
}

export function latestSlackThreadTldr(
  status: SlackThreadStatusRow | null,
  responses: SlackThreadResponseRow[],
): string | null {
  if (status?.thread_tldr) return status.thread_tldr;
  const latest = responses.at(-1);
  return latest?.response_tldr || extractLastTldr(latest?.agent_text || "") || null;
}

export function buildSlackThreadSummaryContext(previousTldrs: string[]): string {
  if (previousTldrs.length === 0) return "";
  return [
    "Prior delivered summaries for this visible Slack thread:",
    "<prior_thread_summaries>",
    ...previousTldrs.map((summary) => `- ${summary}`),
    "</prior_thread_summaries>",
  ].join("\n");
}
