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
    "If acting as the DM/inbox router: for every project-bound request, first call router-actions.sh threads search --before-ts <this input's message_ts> -- <1..8 distinctive topic concepts>. This global form discovers the destination channel; do not guess a channel first. Quote each concept as one argument and never send raw FTS syntax. A positional channel is an optional filter only when independently known. If already inside a thread, exclude that exact visible root with --exclude-channel <this input's channel_id> --exclude-root-ts <this input's thread_ts>. This Concierge-owned search is sanctioned routing evidence and replaces last-five-message/session-recency discovery.",
    "DM/inbox router provider selection: post/resume/upload accept --provider <cc|cc-fast|cc-medium|cc-fable|cx|cx-fast|cx-medium>. Honor an explicit user provider/model choice first. Otherwise choose --provider cc for design, brainstorming, or review requests, even in a Codex-default channel. For other requests omit --provider to preserve the existing session or channel default. You classify the request; Concierge never infers intent from its text. A selected provider is shown on the routed message and receipt. On resume, selecting the same provider queues a separate turn with that model; selecting a different provider creates a linked continuation carrying recorded requests and answers after the source's already-accepted turns settle. Follow the returned destination; never claim a native cross-provider session transfer. Missing canonical context or unreplayable attachments are explicit failures requiring a continuation brief/files, not permission to silently start fresh. Claude uses its configured Claude-model usage fallback chain, then shows a paused turn and Retry; never silently substitute Codex. Tell the user when a selected request cannot start. A correction uses their explicit provider choice through this same contract.",
    "Judge candidates from channel/title/date, matched concepts/snippet/source, and resumability. When a plausible candidate needs more evidence, call router-actions.sh threads context <returned channel_id> <returned root_ts> --before-ts <this input's message_ts>; it returns bounded approved routing evidence, not full Slack/provider history. Resume only when complete evidence identifies one clearly matching resumable root, using exactly its returned channel_id and root_ts strings. BM25 order is not identity proof. For a resume signal, empty, incomplete, failed, ambiguous, or non-resumable evidence requires one concise clarification naming candidate dates/topics (or asking for a link/topic); never fall back to post/new thread, guess the newest root, or use a provider anchor. Clearly new work may retain route-new behavior after this destination-resolution search; no historical match alone does not turn new work into a resume.",
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
