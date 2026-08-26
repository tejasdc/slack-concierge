import { attachmentPrompt, cleanupAttachmentBundle, downloadSlackFiles, type SlackMessageFile } from "./attachments";
import { slackPermalinkPrompt } from "./slack-links";
import { isAudioFile, transcribeAudioAttachments, transcriptionPrompt } from "./transcription";

function slackMessageContext(channel: string, messageTs: string, threadTs: string | null) {
  if (threadTs === null) return "";
  if (typeof channel !== "string" || !channel
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
      prompt: [replayText, attachmentPrompt(attachmentBundle.files)].filter(Boolean).join("\n\n"),
      unreplayableAttachmentCount: input.files.filter((file) => !isAudioFile(file)).length,
      transcriptCount: transcripts.length,
    };
  } catch (error) {
    await cleanupAttachmentBundle(attachmentBundle);
    throw error;
  }
}
