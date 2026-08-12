import type { ProviderId } from "./state";

export interface ProviderAliasTarget {
  provider: ProviderId;
  model?: string;
  reasoning_effort?: string;
}

export type ProviderAliasKey =
  | "cc"
  | "cc-fast"
  | "cc-medium"
  | "cc-fable"
  | "cx"
  | "cx-fast"
  | "cx-medium";

export const PROVIDER_ALIASES = {
  cc: { provider: "claude-code" },
  "cc-fast": { provider: "claude-code", model: "claude-haiku-4-5" },
  "cc-medium": { provider: "claude-code", model: "claude-sonnet-5" },
  "cc-fable": { provider: "claude-code", model: "claude-fable-5" },
  cx: { provider: "codex" },
  "cx-fast": { provider: "codex", model: "gpt-5.6-luna" },
  "cx-medium": { provider: "codex", model: "gpt-5.6-terra" },
} satisfies Record<ProviderAliasKey, ProviderAliasTarget>;

export const PROVIDER_ALIAS_PATTERN = /(^|\s)@((?:cc|cx)(?:-[A-Za-z0-9][A-Za-z0-9_-]*)?|claude-code)\b/gi;

export interface ProviderAliasResolution extends ProviderAliasTarget {
  alias: ProviderAliasKey;
}

export interface ProviderAliasMatch extends ProviderAliasResolution {
  token: string;
  index: number;
  fallback_from?: string;
  source: "text_alias" | "legacy_text_alias" | "bot_mention" | "channel_default";
}

export interface ProviderTurnSelection {
  requestedSelection: ProviderAliasMatch | (ProviderAliasResolution & { source: "channel_default" });
  mentionedSelection: ProviderAliasMatch | null;
  selectedProvider: ProviderId;
  selectedModel?: string;
  selectedReasoningEffort?: string;
  ignoredSelection: ProviderAliasMatch | null;
}

export function aliasKeyForProvider(provider: ProviderId): ProviderAliasKey {
  return provider === "claude-code" ? "cc" : "cx";
}

export function resolveProviderAlias(alias: ProviderAliasKey): ProviderAliasResolution {
  return { alias, ...PROVIDER_ALIASES[alias] };
}

export function normalizeProviderAliasKey(input: string | null | undefined): ProviderAliasKey | null {
  const value = String(input || "").trim().replace(/^@/, "").toLowerCase();
  if (!value) return null;
  if (value === "codex") return "cx";
  if (value === "claude-code") return "cc";
  if (value in PROVIDER_ALIASES) return value as ProviderAliasKey;

  const base = /^(cc|cx)(?:-.+)?$/.exec(value)?.[1] as "cc" | "cx" | undefined;
  return base || null;
}

export function resolveProviderDefault(input: string | null | undefined): ProviderAliasResolution {
  return resolveProviderAlias(normalizeProviderAliasKey(input) || "cx");
}

export function providerAliasFromText(
  text: string,
  opts: { topLevel?: boolean; claudeCodeBotUserId?: string | null } = {},
): ProviderAliasMatch | null {
  if (!opts.topLevel) return null;

  PROVIDER_ALIAS_PATTERN.lastIndex = 0;
  const match = PROVIDER_ALIAS_PATTERN.exec(text);
  if (match) {
    const rawAlias = match[2].toLowerCase();
    const alias = normalizeProviderAliasKey(rawAlias);
    if (alias) {
      const source = rawAlias === "claude-code" ? "legacy_text_alias" : "text_alias";
      return {
        ...resolveProviderAlias(alias),
        token: `@${rawAlias}`,
        index: match.index + match[1].length,
        fallback_from: alias === rawAlias ? undefined : rawAlias,
        source,
      };
    }
  }

  const trimmed = text.trimStart();
  if (opts.claudeCodeBotUserId && trimmed.startsWith(`<@${opts.claudeCodeBotUserId}>`)) {
    return {
      ...resolveProviderAlias("cc"),
      token: `<@${opts.claudeCodeBotUserId}>`,
      index: text.length - trimmed.length,
      source: "bot_mention",
    };
  }

  return null;
}

export function providerSelectionFromText(
  text: string,
  fallback: string,
  opts: { topLevel?: boolean; claudeCodeBotUserId?: string | null } = {},
): ProviderAliasMatch | (ProviderAliasResolution & { source: "channel_default" }) {
  return providerAliasFromText(text, opts) || {
    ...resolveProviderDefault(fallback),
    source: "channel_default",
  };
}

export function selectProviderForTurn(input: {
  text: string;
  channelDefault: string;
  topLevel: boolean;
  existingProvider?: ProviderId | null;
  providerOverride?: ProviderId;
  modelOverride?: string | null;
  reasoningEffortOverride?: string | null;
  claudeCodeBotUserId?: string | null;
}): ProviderTurnSelection {
  const requestedSelection = providerSelectionFromText(input.text, input.channelDefault, {
    topLevel: input.topLevel,
    claudeCodeBotUserId: input.claudeCodeBotUserId,
  });
  const mentionedSelection = providerAliasFromText(input.text, {
    topLevel: true,
    claudeCodeBotUserId: input.claudeCodeBotUserId,
  });
  const overrideAlias = input.providerOverride
    ? resolveProviderAlias(aliasKeyForProvider(input.providerOverride))
    : null;
  const selectedProvider =
    input.existingProvider ||
    input.providerOverride ||
    requestedSelection.provider;
  const selectedModel = input.existingProvider
    ? undefined
    : input.modelOverride ||
      (input.providerOverride ? overrideAlias?.model : requestedSelection.model) ||
      undefined;
  const selectedReasoningEffort = input.existingProvider
    ? undefined
    : input.reasoningEffortOverride ||
      (input.providerOverride ? overrideAlias?.reasoning_effort : requestedSelection.reasoning_effort) ||
      undefined;

  return {
    requestedSelection,
    mentionedSelection,
    selectedProvider,
    selectedModel,
    selectedReasoningEffort,
    ignoredSelection: input.existingProvider ? mentionedSelection : null,
  };
}

export function stripProviderAliases(text: string): string {
  PROVIDER_ALIAS_PATTERN.lastIndex = 0;
  return text
    .replace(PROVIDER_ALIAS_PATTERN, (_token, leading: string) => leading)
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
