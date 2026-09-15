import { attachmentPrompt, cleanupAttachmentBundle, downloadSlackFiles, type SlackMessageFile } from "./attachments";
import { SESSION_ROUTING_INSTRUCTIONS } from "./session-input-context";
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
    SESSION_ROUTING_INSTRUCTIONS,
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
  savedReplayText?: string | null;
}) {
  const messageContext = slackMessageContext(input.channel, input.messageTs, input.threadTs);
  const files = input.savedReplayText == null ? input.files : input.files.filter((file) => !isAudioFile(file));
  const attachmentBundle = await downloadSlackFiles({ ...input, files });
  try {
    const transcripts = await transcribeAudioAttachments({
      slackFiles: files,
      downloadedFiles: attachmentBundle.files,
    });
    const linkedThreadContext = input.savedReplayText == null && input.hydrateSlackLinks
      ? await slackPermalinkPrompt(input)
      : "";
    const replayText = input.savedReplayText ?? [messageContext, input.prompt, linkedThreadContext, transcriptionPrompt(transcripts)]
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
