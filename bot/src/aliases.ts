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
  | "cc-opus"
  | "cc-opus-1m"
  | "cc-sonnet"
  | "cc-haiku"
  | "cx"
  | "cx-fast"
  | "cx-medium"
  | "cx-astra"
  | "cx-sol"
  | "cx-terra"
  | "cx-luna";

const CLAUDE_MODELS = {
  fable: "claude-fable-5-1",
  opus: "claude-opus-5-5",
  // Claude Code's own alias for the latest Opus with the extended window. It belongs in
  // this table rather than inline in an alias, so the union below is the whole set.
  opus1m: "opus[1m]",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
} as const;

// Sol and Luna are on GPT-6, Terra is not, because GPT-6 Terra does not exist —
// OpenAI shipped only Sol and Luna in that generation and GPT-5.6 Terra remains
// current. Both GPT-6 tiers cost half their 5.6 counterparts.
//
// Reaching them needs Codex CLI 0.156 or newer. On 0.153.4 the server refused
// every gpt-6-* name except Astra with "not supported when using Codex with a
// ChatGPT account" — which reads like an entitlement problem and is not one: the
// same account on the Mac's 0.156.0 accepted gpt-6-sol, and after upgrading the
// box it accepted it too (2026-09-23). That message is Codex's generic answer for
// a name the client cannot negotiate, so do not read it as a plan limit; check
// the CLI version first. It is still the true answer for `gpt-6-terra`, which no
// version accepts.
const CODEX_MODELS = {
  astra: "gpt-6-astra",
  sol: "gpt-6-sol",
  terra: "gpt-5.6-terra",
  luna: "gpt-6-luna",
} as const;

/**
 * Every model this system can select, and what it is called in front of Tejas.
 *
 * **This is the one place a model exists.** Its id, the provider it belongs to and the name
 * he reads are all here, and every other surface derives from it: a session's selectable
 * models, the outage notice's labels, the `/models` catalogue thnkr.ing's pickers and
 * labels read, and the router's help text.
 *
 * It exists because they were hand-copied. On 2026-09-23 Concierge moved to Claude Opus 5.5
 * and thnkr.ing's new-session picker kept offering "Claude Opus 5", because the list was
 * also written out in `apps/web/src/model-names.ts` and again in
 * `apps/web/src/native-session-workspace.tsx`. Tejas: "I thought we agreed to change this
 * everywhere… we need to make this architecturally impossible."
 *
 * So it is made impossible rather than remembered. `MODEL_LABELS` is keyed by
 * `SelectableModel`, the literal union of the two `as const` tables above, so **a model
 * added there without a name here fails to compile** — the gap is a build error, not
 * something to notice later. Adding a model is one edit in one file; nothing downstream has
 * to be told.
 *
 * The union is taken from those tables and deliberately not from `PROVIDER_ALIASES`, whose
 * `model` field is typed `string`: routing it through the alias table widens the union to
 * `string`, `Record<string, string>` accepts anything, and the guard silently checks
 * nothing. That was the first version of this, and it passed a deliberately broken build.
 */
export type SelectableModel =
  | typeof CLAUDE_MODELS[keyof typeof CLAUDE_MODELS]
  | typeof CODEX_MODELS[keyof typeof CODEX_MODELS];

const MODEL_LABELS: Record<SelectableModel, string> = {
  "claude-fable-5-1": "Claude Fable 5.1",
  "claude-opus-5-5": "Claude Opus 5.5",
  "opus[1m]": "Claude Opus 5.5 1M",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
  "gpt-6-sol": "GPT-6 Sol",
  "gpt-6-luna": "GPT-6 Luna",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-6-astra": "GPT-6 Astra",
};

/**
 * Models a model that is no longer offered but that older sessions still run on, so a
 * session bound to one keeps showing the model it is actually using rather than its bare id.
 * Superseded, not selectable: these never appear in a picker.
 */
const RETIRED_MODEL_LABELS: Record<string, string> = {
  "claude-opus-5": "Claude Opus 5",
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "claude-fable-5": "Claude Fable 5.1",
};

/** What he reads for a model id, including one no longer offered. Unknown ids keep their id. */
export function modelDisplayName(model: string | null | undefined): string {
  if (!model) return "";
  return (MODEL_LABELS as Record<string, string>)[model] ?? RETIRED_MODEL_LABELS[model] ?? model;
}

export interface ModelCatalogueEntry {
  id: string;
  label: string;
  provider: ProviderId;
  /** The shortest alias that selects it, so a caller can name it without knowing the id. */
  alias: ProviderAliasKey;
}

/**
 * The selectable models, derived from the alias table so it cannot disagree with it.
 * Published by the owner and read by every client picker; nothing re-types this list.
 */
export function modelCatalogue(provider?: ProviderId): ModelCatalogueEntry[] {
  const seen = new Map<string, ModelCatalogueEntry>();
  for (const [alias, target] of Object.entries(PROVIDER_ALIASES) as [ProviderAliasKey, ProviderAliasTarget][]) {
    if (!target.model || (provider && target.provider !== provider)) continue;
    const existing = seen.get(target.model);
    // The shortest alias wins, so `cx-sol` is offered rather than the retained `cx`.
    if (existing && existing.alias.length <= alias.length) continue;
    seen.set(target.model, { id: target.model, label: modelDisplayName(target.model), provider: target.provider, alias });
  }
  return [...seen.values()];
}

// One reasoning-effort vocabulary for both providers. These exact tokens are
// what `codex -c model_reasoning_effort=` and `claude --effort` each accept, so
// a selected effort reaches either CLI unchanged and needs no per-provider
// translation table. Codex additionally accepts `none` and `minimal`; they are
// excluded because Claude rejects them and the vocabulary must stay portable.
export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

// Spoken and written spellings that mean an existing level. They normalize to
// the canonical token before reaching a provider.
const REASONING_EFFORT_SYNONYMS: Record<string, ReasoningEffort> = {
  "extra-high": "xhigh",
  "extrahigh": "xhigh",
  "x-high": "xhigh",
  "maximum": "max",
};

// Effort is an axis of its own, not a property of the model choice. An alias
// that names no effort takes its provider's default, which is configured here
// rather than inherited from the host CLI's `model_reasoning_effort`, so
// Concierge's default cannot drift with host or repository configuration.
// Claude keeps no default, so its own CLI default applies until asked.
export const PROVIDER_DEFAULT_REASONING_EFFORT: Record<ProviderId, ReasoningEffort | undefined> = {
  codex: "medium",
  "claude-code": undefined,
};

// Aliases choose a model only. `cc-fast`, `cc-medium`, `cx-fast`, and
// `cx-medium` are retained tier spellings for models that also have a
// model-name alias; they keep their historical meaning so nothing in flight
// changes, and exact alias matching always wins over effort parsing.
export const PROVIDER_ALIASES = {
  cc: { provider: "claude-code", model: CLAUDE_MODELS.fable },
  "cc-fast": { provider: "claude-code", model: CLAUDE_MODELS.haiku },
  "cc-medium": { provider: "claude-code", model: CLAUDE_MODELS.sonnet },
  "cc-fable": { provider: "claude-code", model: CLAUDE_MODELS.fable },
  "cc-opus": { provider: "claude-code", model: CLAUDE_MODELS.opus },
  "cc-opus-1m": { provider: "claude-code", model: CLAUDE_MODELS.opus1m },
  "cc-sonnet": { provider: "claude-code", model: CLAUDE_MODELS.sonnet },
  "cc-haiku": { provider: "claude-code", model: CLAUDE_MODELS.haiku },
  cx: { provider: "codex", model: CODEX_MODELS.sol },
  "cx-fast": { provider: "codex", model: CODEX_MODELS.luna },
  "cx-medium": { provider: "codex", model: CODEX_MODELS.terra },
  "cx-astra": { provider: "codex", model: CODEX_MODELS.astra },
  "cx-sol": { provider: "codex", model: CODEX_MODELS.sol },
  "cx-terra": { provider: "codex", model: CODEX_MODELS.terra },
  "cx-luna": { provider: "codex", model: CODEX_MODELS.luna },
} satisfies Record<ProviderAliasKey, ProviderAliasTarget>;

// The provider a session takes when nothing has chosen one. The Codex allowance
// is account-scoped and has now been exhausted on two accounts, so the default
// parent is Opus and the cheaper Codex tiers are reached by delegating bounded
// work inside a turn rather than by starting there. This is only a default: an
// explicit provider/model choice and an already-bound session both win over it,
// and no path switches providers on its own.
export const DEFAULT_PROVIDER_ALIAS: ProviderAliasKey = "cc-opus";

// A project registered before anyone chose a provider carries the channel
// column's own schema default, `codex`. It is not an alias key, and every
// selection path — `/switch-provider` and the native project default control —
// stores a canonical alias instead, so this value provably means "nothing
// chosen" and needs no data migration to stop meaning Codex.
export const UNSET_PROVIDER_DEFAULT = "codex";

// Read a stored channel/project provider default. An explicit selection is
// returned unchanged, including any effort suffix; anything else resolves to the
// one configured default above.
export function configuredProviderDefault(stored: string | null | undefined): string {
  const value = String(stored ?? "").trim();
  if (!value || value.toLowerCase() === UNSET_PROVIDER_DEFAULT) return DEFAULT_PROVIDER_ALIAS;
  return parseProviderSelector(value) ? value : DEFAULT_PROVIDER_ALIAS;
}

const EFFORT_TOKENS = [...REASONING_EFFORTS, ...Object.keys(REASONING_EFFORT_SYNONYMS)]
  .sort((a, b) => b.length - a.length);

export function normalizeReasoningEffort(input: string | null | undefined): ReasoningEffort | null {
  const value = String(input || "").trim().toLowerCase();
  if (!value) return null;
  if ((REASONING_EFFORTS as readonly string[]).includes(value)) return value as ReasoningEffort;
  return REASONING_EFFORT_SYNONYMS[value] || null;
}

export interface ProviderSelector {
  alias: ProviderAliasKey;
  effort: ReasoningEffort | null;
}

// `<alias>` or `<alias>-<effort>`. An exact alias match is tried first so a
// retained tier spelling such as `cx-medium` keeps naming its model.
export function parseProviderSelector(input: string | null | undefined): ProviderSelector | null {
  let value = String(input || "").trim().toLowerCase();
  if (!value) return null;
  if (value === "codex") value = "cx";
  else if (value === "claude-code") value = "cc";
  else value = value.replace(/^@(?=(?:cc|cx)(?:-|$))/, "");

  if (Object.hasOwn(PROVIDER_ALIASES, value)) return { alias: value as ProviderAliasKey, effort: null };
  for (const token of EFFORT_TOKENS) {
    if (!value.endsWith(`-${token}`)) continue;
    const base = value.slice(0, -(token.length + 1));
    if (Object.hasOwn(PROVIDER_ALIASES, base)) {
      return { alias: base as ProviderAliasKey, effort: normalizeReasoningEffort(token) };
    }
  }
  return null;
}

export const CLAUDE_USAGE_FALLBACK_CHAIN: readonly string[] = [
  CLAUDE_MODELS.fable, CLAUDE_MODELS.opus, CLAUDE_MODELS.sonnet, CLAUDE_MODELS.haiku,
];

// A superseded model ID means the tier it belongs to, so a session still bound to
// one keeps that tier's place in the chain above and shares its account-scoped
// usage bucket. Without this, a running `claude-opus-5` session would fall off the
// chain entirely and be offered no alternative when its account is exhausted.
const SUPERSEDED_CLAUDE_MODELS: Record<string, string> = {
  // The existing shared DM still prefers this exact legacy Fable ID.
  "claude-fable-5": CLAUDE_MODELS.fable,
  // Legacy since Opus 5.5 (2026-09-22); sessions started before it keep running on it.
  "claude-opus-5": CLAUDE_MODELS.opus,
};

export function canonicalClaudeUsageModel(model: string): string {
  return SUPERSEDED_CLAUDE_MODELS[model] ?? model;
}

export function claudeUsageFallbackModels(model: string): string[] {
  const index = CLAUDE_USAGE_FALLBACK_CHAIN.indexOf(canonicalClaudeUsageModel(model));
  return index < 0 ? [] : CLAUDE_USAGE_FALLBACK_CHAIN.slice(index + 1);
}

// Built from the tables above so a new alias or effort level cannot be
// published in one place and silently unmatched in text.
const ALIAS_KEY_PATTERN = Object.keys(PROVIDER_ALIASES)
  .sort((a, b) => b.length - a.length).join("|");
export const PROVIDER_ALIAS_PATTERN = new RegExp(
  `(^|\\s)@((?:${ALIAS_KEY_PATTERN})(?:-(?:${EFFORT_TOKENS.join("|")}))?)(?![\\w-])`,
  "gi",
);

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

export function resolveProviderAlias(
  alias: ProviderAliasKey,
  effort?: ReasoningEffort | null,
): ProviderAliasResolution {
  const target = PROVIDER_ALIASES[alias];
  const reasoning_effort = effort || PROVIDER_DEFAULT_REASONING_EFFORT[target.provider];
  return { alias, ...target, ...(reasoning_effort ? { reasoning_effort } : {}) };
}

export function resolveProviderSelector(selector: ProviderSelector): ProviderAliasResolution {
  return resolveProviderAlias(selector.alias, selector.effort);
}

export function selectProviderForComparison(input: {
  sourceProvider: ProviderId;
  targetAlias?: ProviderAliasKey | null;
  targetEffort?: ReasoningEffort | null;
}): ComparisonProviderSelection {
  if (input.targetAlias) {
    return {
      ...resolveProviderAlias(input.targetAlias, input.targetEffort),
      source: "comparison_explicit_alias",
    };
  }
  const counterpart = input.sourceProvider === "codex" ? "claude-code" : "codex";
  return {
    ...resolveProviderAlias(aliasKeyForProvider(counterpart)),
    source: "comparison_counterpart",
  };
}

export function normalizeProviderAliasKey(input: string | null | undefined): ProviderAliasKey | null {
  return parseProviderSelector(input)?.alias ?? null;
}

export function resolveProviderDefault(input: string | null | undefined): ProviderAliasResolution {
  const selector = parseProviderSelector(input);
  return selector ? resolveProviderSelector(selector) : resolveProviderAlias(DEFAULT_PROVIDER_ALIAS);
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
    const selector = parseProviderSelector(rawAlias);
    if (selector) {
      return {
        ...resolveProviderSelector(selector),
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
