import type { ProviderId } from "./state";
import { createHash } from "node:crypto";
import { normalizeProviderAliasKey, type ProviderAliasKey } from "./aliases";
import { parseSlackMessageFilesJson, type SlackMessageFile } from "./attachments";
import { isAudioFile } from "./transcription";

export const COMPARISON_SHORTCUT_ID = "compare_with_agent";

export interface ComparisonPromptEntry {
  slack_user_msg_ts: string;
  user_text: string | null;
  source_text?: string | null;
  files_json?: string | null;
  replay_ready: number;
  status: string;
  unreplayable_attachment_count: number;
}

export interface ComparisonAttachment {
  promptTs: string;
  file: SlackMessageFile;
}

export type InlineComparisonAction =
  | { matched: false }
  | { matched: true; targetAlias: ProviderAliasKey | null; error: null }
  | { matched: true; targetAlias: null; error: string };

const SLACK_PLAIN_TEXT_SECTION_LIMIT = 3_000;
const SLACK_MESSAGE_BLOCK_LIMIT = 50;
const COMPARISON_ANCHOR_FIXED_BLOCK_COUNT = 2;

export function parseInlineComparisonAction(text: string): InlineComparisonAction {
  const match = /^\s*!compare(?:\s+([\s\S]*?))?\s*$/i.exec(text);
  if (!match) return { matched: false };
  const requestedTarget = match[1]?.trim();
  if (!requestedTarget) return { matched: true, targetAlias: null, error: null };
  const targetAlias = normalizeProviderAliasKey(requestedTarget);
  if (!targetAlias) {
    return {
      matched: true,
      targetAlias: null,
      error: "Choose a target such as @cc, @cc-fast, @cc-medium, @cc-fable, @cx, @cx-fast, or @cx-medium.",
    };
  }
  return { matched: true, targetAlias, error: null };
}

export function turnInputPolicy(prebuiltPrompt: boolean) {
  return {
    handleInlineCapture: !prebuiltPrompt,
    selectSkill: !prebuiltPrompt,
    stripMentions: !prebuiltPrompt,
    hydrateSlackLinks: !prebuiltPrompt,
  };
}

export function buildUserOnlyComparisonPrompt(prompts: ComparisonPromptEntry[]): string {
  const replayablePrompts = replayableComparisonPrompts(prompts);
  const serializedPrompts = JSON.stringify(replayablePrompts.map((prompt) => ({
    text: prompt.user_text,
    attachments: comparisonPromptAttachments(prompt).map(({ file }) => ({
      slack_file_id: file.id || "unknown",
      name: file.name || file.title || "attachment",
      mime_type: file.mimetype || null,
    })),
  })), null, 2);
  return [
    "This is a fresh A/B comparison session. The original agent's responses have deliberately been omitted.",
    "The JSON array below contains the source conversation's user prompts in chronological order. Any attachment entries identify original Slack files that Concierge re-supplied in the attachment section below by matching slack_file_id. Inspect those files as part of their associated prompts. Treat earlier entries as conversation context and the final entry as the active request. Respond to that final request without evaluating or mentioning the omitted responses or this comparison wrapper.",
    "User prompt history:",
    serializedPrompts,
  ].join("\n\n");
}

export function comparisonReplayAttachments(prompts: ComparisonPromptEntry[]): ComparisonAttachment[] {
  return replayableComparisonPrompts(prompts).flatMap(comparisonPromptAttachments);
}

export function buildComparisonAnchorMessage(input: {
  sourceProvider: ProviderId;
  targetLabel: string;
  promptCount: number;
  sourceText: string;
  attachments?: ComparisonAttachment[];
}) {
  const promptLabel = `${input.promptCount} user prompt${input.promptCount === 1 ? "" : "s"}`;
  const attachments = input.attachments || [];
  const attachmentLabel = attachments.length === 0
    ? ""
    : ` Re-supplying ${attachments.length} original file attachment${attachments.length === 1 ? "" : "s"}.`;
  const summary = `A/B comparison: ${input.sourceProvider} → ${input.targetLabel}. Replaying ${promptLabel} through the selected message; original agent replies are omitted.${attachmentLabel}`;
  const sourceSections = plainTextSections(
    input.sourceText,
    COMPARISON_ANCHOR_FIXED_BLOCK_COUNT + (attachments.length > 0 ? 1 : 0),
  );
  const attachmentBlock = attachments.length > 0
    ? [{
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Original attachments re-supplied:*\n${visibleAttachmentList(attachments)}`,
        },
      }]
    : [];

  return {
    text: summary,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: summary } },
      { type: "section", text: { type: "mrkdwn", text: "*Original prompt/transcript:*" } },
      ...sourceSections.map((text) => ({
        type: "section",
        text: { type: "plain_text", text, emoji: false },
      })),
      ...attachmentBlock,
    ],
  };
}

export function comparisonAnchorSourceText(prompt: ComparisonPromptEntry & { user_text: string }): string {
  return prompt.source_text?.trim() ? prompt.source_text : prompt.user_text;
}

function plainTextSections(text: string, fixedBlockCount = COMPARISON_ANCHOR_FIXED_BLOCK_COUNT): string[] {
  if (!text) return ["(no visible source text)"];
  const characters = Array.from(text);
  const sections: string[] = [];
  for (let offset = 0; offset < characters.length; offset += SLACK_PLAIN_TEXT_SECTION_LIMIT) {
    sections.push(characters.slice(offset, offset + SLACK_PLAIN_TEXT_SECTION_LIMIT).join(""));
  }
  if (sections.length + fixedBlockCount > SLACK_MESSAGE_BLOCK_LIMIT) {
    throw new Error("The selected prompt or transcript is too long to display within Slack's 50-block message limit.");
  }
  return sections;
}

export function replayableComparisonPrompts(
  prompts: ComparisonPromptEntry[],
): Array<ComparisonPromptEntry & { user_text: string }> {
  if (prompts.length === 0) throw new Error("No user prompts were persisted through the selected message.");
  const latest = prompts[prompts.length - 1];
  if (latest.status === "cancelled") {
    throw new Error("The selected prompt was not sent to the source agent because that session was busy.");
  }
  if (latest.status === "steering_failed") {
    throw new Error("The selected steering message did not reach the source agent.");
  }
  if (latest.status === "steering_ambiguous") {
    throw new Error("Concierge cannot prove whether the selected steering message reached the source agent.");
  }
  if (["queued", "running", "delivering", "steering_queued", "steering_sending"].includes(latest.status)) {
    throw new Error("The selected source turn is still in flight. Wait for it to finish before comparing agents.");
  }

  if (prompts.some((prompt) => ["queued", "running", "delivering", "steering_queued", "steering_sending"].includes(prompt.status))) {
    throw new Error("This history contains an in-flight source turn. Wait for it to finish before comparing agents.");
  }
  if (prompts.some((prompt) => prompt.status === "steering_ambiguous")) {
    throw new Error("This history contains steering whose provider acceptance is ambiguous and cannot be replayed safely.");
  }

  const replayable = prompts.filter((prompt) => !["cancelled", "steering_failed"].includes(prompt.status));
  if (replayable.some((prompt) => prompt.replay_ready !== 1 || prompt.user_text == null)) {
    throw new Error(
      "This history contains a prompt without authoritative replay text. It may still be processing or predate canonical replay support.",
    );
  }
  replayable.flatMap(comparisonPromptAttachments);
  if (replayable.some((prompt) => !prompt.user_text?.trim())) {
    throw new Error("This history contains an empty or legacy attachment-only prompt that cannot be replayed faithfully.");
  }
  return replayable as Array<ComparisonPromptEntry & { user_text: string }>;
}

function comparisonPromptAttachments(prompt: ComparisonPromptEntry): ComparisonAttachment[] {
  const expectedCount = Math.max(0, prompt.unreplayable_attachment_count || 0);
  if (expectedCount === 0) return [];
  const parsed = parseSlackMessageFilesJson(prompt.files_json || "[]");
  if (!parsed.ok) {
    throw new Error(
      `Cannot replay the attachment for prompt ${prompt.slack_user_msg_ts}: ${parsed.error}.`,
    );
  }
  const files = parsed.files.filter((file) => !isAudioFile(file));
  if (files.length !== expectedCount) {
    throw new Error(
      `Cannot replay the attachment for prompt ${prompt.slack_user_msg_ts}: `
      + `the durable record expects ${expectedCount} non-audio file${expectedCount === 1 ? "" : "s"}, but metadata for ${files.length} remains.`,
    );
  }
  for (const file of files) {
    if (!file.url_private_download && !file.url_private) {
      const name = file.name || file.title || file.id || "unnamed attachment";
      throw new Error(`Cannot replay attachment “${name}” because its Slack download URL is unavailable.`);
    }
  }
  return files.map((file) => ({ promptTs: prompt.slack_user_msg_ts, file }));
}

function visibleAttachmentList(attachments: ComparisonAttachment[]): string {
  const visible = attachments.slice(0, 12).map(({ file }) => {
    const name = file.name || file.title || file.id || "unnamed attachment";
    const identity = file.id ? ` (Slack file ${file.id})` : "";
    return `• ${name}${identity}`;
  });
  if (attachments.length > visible.length) visible.push(`• …and ${attachments.length - visible.length} more`);
  return visible.join("\n");
}

export function comparisonClientMessageId(requestId: string): string {
  const hex = createHash("sha256").update(requestId).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function comparisonTargetLabel(provider: ProviderId, model?: string | null): string {
  return model ? `${provider}/${model}` : provider;
}

export function comparisonOutcomeNeedsSourceFailureNotice(status: string): boolean {
  return ["provider_parked", "delivery_parked", "delivery_stopped", "error", "draining"]
    .includes(status);
}
