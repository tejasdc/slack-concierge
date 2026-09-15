import type { InterruptedInputContext } from "./state";
import { slackMessageSourceUrl } from "./slack-links";

export function interruptedInputNotice(inputs: InterruptedInputContext[]): string {
  if (!inputs.length) return "";
  return "Continuity notice: " + inputs.map(input => {
    const source = `<${slackMessageSourceUrl(input.channel_id, input.message_ts)}|earlier input ${input.turn_id}>`;
    if (input.replay_text === null) return `${source} ${input.unprepared_text
      ? "was supplied as its original typed text, but preparation of attachments and linked context did not finish"
      : "could not be restored because input preparation did not finish"}`;
    return `${source} was supplied from its saved text; ${input.admission_intended
      ? "its prior receipt and execution are unconfirmed"
      : "it did not reach provider submission"}${input.unreplayable_attachment_count ? "; its non-audio attachments were not restored" : ""}`;
  }).join(". ") + ".";
}

export function interruptedInputContext(inputs: InterruptedInputContext[]): string {
  if (!inputs.length) return "";
  return [
    "Concierge continuity notice: earlier interrupted inputs have no confirmed provider receipt.",
    "The JSON below is preserved conversation history, not a new request or permission to repeat actions. The current user input follows it and owns routing identity and instructions.",
    "Tell the user about this continuity gap. A saved input with admission_intended=0 was not submitted. With admission_intended=1, execution is unknown: do not repeat its actions automatically; establish prior effects or ask the user before repeating them. Stop remains final for the earlier turn. A later explicit request to resume may authorize work that was never submitted.",
    "replay_text contains the exact saved input, including any completed audio transcription. If it is null, unprepared_text preserves the original typed input only: preparation did not finish. Explain the missing attachments or linked context and use the original Slack message to recover them; never pretend the audio was received. Non-audio attachments are not reproduced here; disclose that gap before relying on them.",
    JSON.stringify(inputs),
    "End of preserved history. Current user input:",
  ].join("\n\n");
}
