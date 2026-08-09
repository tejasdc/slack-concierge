import type { ProviderId } from "./state";
import { createHash } from "node:crypto";

export const COMPARISON_SHORTCUT_ID = "compare_with_agent";
export const COMPARISON_VIEW_ID = "compare_with_agent_submit";

const PROVIDER_BLOCK_ID = "comparison_provider";
const PROVIDER_ACTION_ID = "provider";
const MODEL_BLOCK_ID = "comparison_model";
const MODEL_ACTION_ID = "model";

const PROVIDER_OPTIONS: Array<{ text: { type: "plain_text"; text: string }; value: ProviderId }> = [
  { text: { type: "plain_text", text: "Codex" }, value: "codex" },
  { text: { type: "plain_text", text: "Claude Code" }, value: "claude-code" },
];

export interface ComparisonMetadata {
  channelId: string;
  channelName: string;
  sourceSessionId: number;
  sourceMessageTs: string;
  sourceThreadTs: string;
}

export interface ComparisonRequest extends ComparisonMetadata {
  provider: ProviderId;
  model: string | null;
}

export interface ComparisonPromptEntry {
  slack_user_msg_ts: string;
  user_text: string | null;
  replay_ready: number;
  status: string;
  unreplayable_attachment_count: number;
}

export function alternateProvider(provider: ProviderId): ProviderId {
  return provider === "codex" ? "claude-code" : "codex";
}

export function turnInputPolicy(prebuiltPrompt: boolean) {
  return {
    handleInlineCapture: !prebuiltPrompt,
    selectSkill: !prebuiltPrompt,
    stripMentions: !prebuiltPrompt,
    hydrateSlackLinks: !prebuiltPrompt,
  };
}

export function buildComparisonModal(input: {
  metadata: ComparisonMetadata;
  sourceProvider: ProviderId;
}) {
  const initialProvider = alternateProvider(input.sourceProvider);
  const initialOption = PROVIDER_OPTIONS.find((option) => option.value === initialProvider)!;

  return {
    type: "modal",
    callback_id: COMPARISON_VIEW_ID,
    private_metadata: JSON.stringify(input.metadata),
    title: { type: "plain_text", text: "Compare agent" },
    submit: { type: "plain_text", text: "Run comparison" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Starts a fresh session with user prompts only; original agent replies are omitted. The new agent keeps normal tool permissions and may change this project.",
        },
      },
      {
        type: "input",
        block_id: PROVIDER_BLOCK_ID,
        label: { type: "plain_text", text: "Agent" },
        element: {
          type: "static_select",
          action_id: PROVIDER_ACTION_ID,
          options: PROVIDER_OPTIONS,
          initial_option: initialOption,
        },
      },
      {
        type: "input",
        block_id: MODEL_BLOCK_ID,
        optional: true,
        label: { type: "plain_text", text: "Model (optional)" },
        element: {
          type: "plain_text_input",
          action_id: MODEL_ACTION_ID,
          max_length: 100,
          placeholder: { type: "plain_text", text: "Leave blank for the agent default" },
        },
      },
    ],
  };
}

export async function openComparisonModal(client: any, triggerId: string, view: ReturnType<typeof buildComparisonModal>) {
  const result = await client.views.open({ trigger_id: triggerId, view });
  if (result?.ok === false) throw new Error(String(result.error || "views.open failed"));
  return result;
}

export function parseComparisonRequest(view: any): ComparisonRequest {
  const metadata = parseMetadata(view?.private_metadata);
  const provider = view?.state?.values?.[PROVIDER_BLOCK_ID]?.[PROVIDER_ACTION_ID]?.selected_option?.value;
  if (provider !== "codex" && provider !== "claude-code") {
    throw new Error("Choose Codex or Claude Code.");
  }

  const modelValue = view?.state?.values?.[MODEL_BLOCK_ID]?.[MODEL_ACTION_ID]?.value;
  const model = typeof modelValue === "string" ? modelValue.trim() : "";
  if (model && !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)) {
    throw new Error("Model names may only contain letters, numbers, dot, dash, underscore, colon, or slash.");
  }

  return { ...metadata, provider, model: model || null };
}

function parseMetadata(raw: unknown): ComparisonMetadata {
  let parsed: any;
  try {
    parsed = JSON.parse(String(raw || ""));
  } catch {
    throw new Error("The comparison source expired or is malformed. Open the message action again.");
  }
  if (
    typeof parsed?.channelId !== "string" ||
    typeof parsed?.channelName !== "string" ||
    !Number.isInteger(parsed?.sourceSessionId) ||
    typeof parsed?.sourceMessageTs !== "string" ||
    typeof parsed?.sourceThreadTs !== "string"
  ) {
    throw new Error("The comparison source expired or is malformed. Open the message action again.");
  }
  return parsed as ComparisonMetadata;
}

export function buildUserOnlyComparisonPrompt(prompts: ComparisonPromptEntry[]): string {
  const replayablePrompts = replayableComparisonPrompts(prompts);
  const serializedPrompts = JSON.stringify(replayablePrompts.map((prompt) => prompt.user_text), null, 2);
  return [
    "This is a fresh A/B comparison session. The original agent's responses have deliberately been omitted.",
    "The JSON array below contains the source conversation's user prompts in chronological order. Treat earlier entries as conversation context and the final entry as the active request. Respond to that final request without evaluating or mentioning the omitted responses or this comparison wrapper.",
    "User prompt history:",
    serializedPrompts,
  ].join("\n\n");
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
  const attachmentCount = replayable.reduce(
    (total, prompt) => total + Math.max(0, prompt.unreplayable_attachment_count || 0),
    0,
  );
  if (attachmentCount > 0) {
    throw new Error(
      `This history contains ${attachmentCount} file attachment${attachmentCount === 1 ? "" : "s"} whose contents cannot yet be replayed faithfully.`,
    );
  }
  if (replayable.some((prompt) => !prompt.user_text?.trim())) {
    throw new Error("This history contains an empty or legacy attachment-only prompt that cannot be replayed faithfully.");
  }
  return replayable as Array<ComparisonPromptEntry & { user_text: string }>;
}

export function comparisonClientMessageId(requestId: string): string {
  const hex = createHash("sha256").update(requestId).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function comparisonTargetLabel(provider: ProviderId, model?: string | null): string {
  return model ? `${provider}/${model}` : provider;
}
