import { attachmentPrompt, cleanupAttachmentBundle, downloadSlackFiles, type SlackMessageFile } from "./attachments";
import { slackPermalinkPrompt } from "./slack-links";
import { isAudioFile, transcribeAudioAttachments, transcriptionPrompt } from "./transcription";

function slackMessageContext(channel: string, messageTs: string, threadTs: string | null) {
  if (threadTs === null) return "";
  if (typeof channel !== "string" || !/^[CGD][A-Z0-9]+$/.test(channel)
    || typeof messageTs !== "string" || !/^\d+\.\d+$/.test(messageTs)
    || typeof threadTs !== "string" || !/^\d+\.\d+$/.test(threadTs)) {
    throw new Error("Slack input requires an exact channel, message timestamp, and thread root.");
  }
  return [
    "Slack message identity for this input, supplied by Concierge (timestamps are strings):",
    "<slack-message-context>",
    JSON.stringify({ channel_id: channel, message_ts: messageTs, thread_ts: threadTs }),
    "</slack-message-context>",
    "For router-actions.sh audit, use this channel_id and message_ts. thread_ts is this message's reply root (itself for a root message), not the provider session anchor. Do not infer a target from channel recency.",
    "For every router post/resume/upload, pass --source-channel <this channel_id> --source-ts <this message_ts> and a stable --action-id for each split request. These helpers submit one service-owned request; never publish to Slack independently. An explicit request to wait requires router-actions.sh work <dependency-channel> --before-ts <this message_ts> [--root-ts <exact-root> | --session-id <exact-session> | --turn-id <exact-turn>]. Resolve every named prerequisite with complete evidence, then repeat --after <turn_id>,<channel_id>,<root_ts> for its exact executions. A complete empty selection uses --defer. Ordinary requests omit these wait flags. Unknown, incomplete, or ambiguous dependency evidence requires clarification, never omission or guessing. Later work does not change the selected executions. The destination shows only an hourglass while waiting; do not post a waiting receipt or activation announcement. A machine receipt with status other than admitted is unresolved: preserve its request_id and inspect with router-actions.sh work request <request_id>; do not create another action.",
    "If acting as the DM/inbox router: for an explicit or strongly implied resume signal (continue, the chat about, we discussed, last time), choose the destination channel, then call router-actions.sh threads search <target-channel> --before-ts <this input's message_ts> -- <1..8 distinctive topic concepts>. Quote each concept as one argument; do not send raw FTS syntax. If already inside a thread, pass --exclude-root-ts <this input's thread_ts>. This Concierge-owned search is sanctioned routing evidence and replaces last-five-message/session-recency discovery for resume decisions.",
    "Resume only when complete search evidence identifies one clearly matching resumable root, using exactly the returned channel_id and root_ts strings. Inspect candidates and matched concepts/snippets; BM25 order is not identity proof. Empty, incomplete, failed, ambiguous, or non-resumable retrieval for a resume signal requires one concise clarification naming candidate dates/topics (or asking for a link/topic); never fall back to post/new thread, guess the newest root, or use a provider anchor. Clearly new work retains route-new behavior and does not need search.",
  ].join("\n");
}

export async function prepareProviderInput(input: {
  prompt: string;
  text: string;
  files: SlackMessageFile[];
  botToken: string;
  channel: string;
  messageTs: string;
  threadTs: string | null;
  user: string;
  client: any;
  hydrateSlackLinks: boolean;
  attachmentRoot: string;
}) {
  const messageContext = slackMessageContext(input.channel, input.messageTs, input.threadTs);
  const attachmentBundle = await downloadSlackFiles(input);
  try {
    const transcripts = await transcribeAudioAttachments({
      slackFiles: input.files,
      downloadedFiles: attachmentBundle.files,
    });
    const linkedThreadContext = input.hydrateSlackLinks
      ? await slackPermalinkPrompt(input)
      : "";
    const replayText = [messageContext, input.prompt, linkedThreadContext, transcriptionPrompt(transcripts)]
      .filter(Boolean)
      .join("\n\n");
    return {
      attachmentBundle,
      replayText,
      prompt: [replayText, attachmentPrompt(attachmentBundle.files, {
        transcribedSlackFileIds: transcripts.map((transcript) => transcript.slackFileId),
      })].filter(Boolean).join("\n\n"),
      unreplayableAttachmentCount: input.files.filter((file) => !isAudioFile(file)).length,
      transcriptCount: transcripts.length,
    };
  } catch (error) {
    await cleanupAttachmentBundle(attachmentBundle);
    throw error;
  }
}
