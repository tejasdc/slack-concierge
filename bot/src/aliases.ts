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
  | "cx-medium"
  | "cx-sol";

const CLAUDE_MODELS = {
  fable: "claude-fable-5-1",
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
} as const;

const CODEX_MODELS = {
  astra: "gpt-6-astra",
  sol: "gpt-5.6-sol",
  terra: "gpt-5.6-terra",
  luna: "gpt-5.6-luna",
} as const;

// The Codex default is pinned here rather than inherited from the host CLI's
// `model_reasoning_effort`, so Concierge's default effort cannot drift with
// host configuration. Cheaper aliases leave effort unset and inherit it.
export const PROVIDER_ALIASES = {
  cc: { provider: "claude-code", model: CLAUDE_MODELS.fable },
  "cc-fast": { provider: "claude-code", model: CLAUDE_MODELS.haiku },
  "cc-medium": { provider: "claude-code", model: CLAUDE_MODELS.sonnet },
  "cc-fable": { provider: "claude-code", model: CLAUDE_MODELS.fable },
  cx: { provider: "codex", model: CODEX_MODELS.astra, reasoning_effort: "medium" },
  "cx-fast": { provider: "codex", model: CODEX_MODELS.luna },
  "cx-medium": { provider: "codex", model: CODEX_MODELS.terra },
  "cx-sol": { provider: "codex", model: CODEX_MODELS.sol },
} satisfies Record<ProviderAliasKey, ProviderAliasTarget>;

export const CLAUDE_USAGE_FALLBACK_CHAIN: readonly string[] = [
  CLAUDE_MODELS.fable, CLAUDE_MODELS.opus, CLAUDE_MODELS.sonnet, CLAUDE_MODELS.haiku,
];

export function claudeUsageFallbackModels(model: string): string[] {
  // The existing shared DM still prefers this exact legacy Fable ID.
  const configuredModel = model === "claude-fable-5" ? CLAUDE_MODELS.fable : model;
  const index = CLAUDE_USAGE_FALLBACK_CHAIN.indexOf(configuredModel);
  return index < 0 ? [] : CLAUDE_USAGE_FALLBACK_CHAIN.slice(index + 1);
}

export const PROVIDER_ALIAS_PATTERN = /(^|\s)@(cc(?:-(?:fast|medium|fable))?|cx(?:-(?:fast|medium|sol))?)(?!-)\b/gi;

export interface ProviderAliasResolution extends ProviderAliasTarget {
  alias: ProviderAliasKey;
}

export interface ComparisonProviderSelection extends ProviderAliasResolution {
  source: "comparison_counterpart" | "comparison_explicit_alias";
}

export interface ProviderAliasMatch extends ProviderAliasResolution {
  token: string;
  index: number;
  source: "text_alias" | "bot_mention" | "channel_default";
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

export function selectProviderForComparison(input: {
  sourceProvider: ProviderId;
  targetAlias?: ProviderAliasKey | null;
}): ComparisonProviderSelection {
  if (input.targetAlias) {
    return { ...resolveProviderAlias(input.targetAlias), source: "comparison_explicit_alias" };
  }
  const counterpart = input.sourceProvider === "codex" ? "claude-code" : "codex";
  return {
    ...resolveProviderAlias(aliasKeyForProvider(counterpart)),
    source: "comparison_counterpart",
  };
}

export function normalizeProviderAliasKey(input: string | null | undefined): ProviderAliasKey | null {
  const value = String(input || "").trim().toLowerCase();
  if (!value) return null;
  if (value === "codex") return "cx";
  if (value === "claude-code") return "cc";
  const alias = value.replace(/^@(?=(?:cc|cx)(?:-|$))/, "");
  return Object.hasOwn(PROVIDER_ALIASES, alias) ? alias as ProviderAliasKey : null;
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
      return {
        ...resolveProviderAlias(alias),
        token: `@${rawAlias}`,
        index: match.index + match[1].length,
        source: "text_alias",
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

export const parseProviderAliasFromText = providerAliasFromText;

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
    ? (input.providerOverride === input.existingProvider ? input.modelOverride || undefined : undefined)
    : input.modelOverride ||
      (input.providerOverride ? overrideAlias?.model : requestedSelection.model) ||
      undefined;
  const selectedReasoningEffort = input.existingProvider
    ? (input.providerOverride === input.existingProvider ? input.reasoningEffortOverride || undefined : undefined)
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
