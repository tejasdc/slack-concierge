import { attachmentPrompt, cleanupAttachmentBundle, downloadSlackFiles, type SlackMessageFile } from "./attachments";
import { slackPermalinkPrompt } from "./slack-links";
import { isAudioFile, transcribeAudioAttachments, transcriptionPrompt } from "./transcription";

export async function prepareProviderInput(input: {
  prompt: string;
  text: string;
  files: SlackMessageFile[];
  botToken: string;
  channel: string;
  messageTs: string;
  user: string;
  client: any;
  hydrateSlackLinks: boolean;
  attachmentRoot: string;
}) {
  const attachmentBundle = await downloadSlackFiles(input);
  try {
    const transcripts = await transcribeAudioAttachments({
      slackFiles: input.files,
      downloadedFiles: attachmentBundle.files,
    });
    const linkedThreadContext = input.hydrateSlackLinks
      ? await slackPermalinkPrompt(input)
      : "";
    const replayText = [input.prompt, linkedThreadContext, transcriptionPrompt(transcripts)]
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
