import { describe, expect, test } from "bun:test";
import { claudeCodeArgs } from "../src/claude-code";
import {
  PROVIDER_ALIASES,
  REASONING_EFFORTS,
  normalizeProviderAliasKey,
  normalizeReasoningEffort,
  parseProviderSelector,
  providerAliasFromText,
  providerSelectionFromText,
  resolveProviderAlias,
  resolveProviderDefault,
  selectProviderForTurn,
  selectProviderForComparison,
  stripProviderAliases,
} from "../src/aliases";

const removedLegacyTextAlias = ["@", "claude", "-", "code"].join("");

describe("provider aliases", () => {
  test("selects the automatic comparison counterpart unless an explicit alias overrides it", () => {
    expect(selectProviderForComparison({ sourceProvider: "codex" })).toEqual({
      alias: "cc",
      provider: "claude-code",
      model: "claude-fable-5-1",
      source: "comparison_counterpart",
    });
    expect(selectProviderForComparison({ sourceProvider: "claude-code" })).toEqual({
      alias: "cx",
      provider: "codex",
      model: "gpt-6-astra",
      reasoning_effort: "medium",
      source: "comparison_counterpart",
    });
    expect(selectProviderForComparison({ sourceProvider: "codex", targetAlias: "cx-fast" })).toEqual({
      alias: "cx-fast",
      provider: "codex",
      model: "gpt-5.6-luna",
      reasoning_effort: "medium",
      source: "comparison_explicit_alias",
    });
    expect(selectProviderForComparison({ sourceProvider: "codex", targetAlias: "cx-sol", targetEffort: "xhigh" })).toEqual({
      alias: "cx-sol",
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoning_effort: "xhigh",
      source: "comparison_explicit_alias",
    });
  });
  test("resolves every documented alias", () => {
    expect(providerAliasFromText("@cc do it", { topLevel: true })).toMatchObject({
      alias: "cc",
      provider: "claude-code",
      model: "claude-fable-5-1",
    });
    expect(providerAliasFromText("@cc-fast do it", { topLevel: true })).toMatchObject({
      alias: "cc-fast",
      provider: "claude-code",
      model: "claude-haiku-4-5-20251001",
    });
    expect(providerAliasFromText("@cc-medium do it", { topLevel: true })).toMatchObject({
      alias: "cc-medium",
      provider: "claude-code",
      model: "claude-sonnet-5",
    });
    expect(providerAliasFromText("@cc-fable do it", { topLevel: true })).toMatchObject({
      alias: "cc-fable",
      provider: "claude-code",
      model: "claude-fable-5-1",
    });
    expect(providerAliasFromText("@cx do it", { topLevel: true })).toMatchObject({
      alias: "cx",
      provider: "codex",
      model: "gpt-6-astra",
      reasoning_effort: "medium",
    });
    expect(providerAliasFromText("@cx-fast do it", { topLevel: true })).toMatchObject({
      alias: "cx-fast",
      provider: "codex",
      model: "gpt-5.6-luna",
    });
    expect(providerAliasFromText("@cx-medium do it", { topLevel: true })).toMatchObject({
      alias: "cx-medium",
      provider: "codex",
      model: "gpt-5.6-terra",
    });
    expect(providerAliasFromText("@cx-sol do it", { topLevel: true })).toMatchObject({
      alias: "cx-sol",
      provider: "codex",
      model: "gpt-5.6-sol",
    });
  });

  test("pins the Codex default model and effort in the alias table", () => {
    // The default must not depend on the host CLI's model_reasoning_effort.
    expect(PROVIDER_ALIASES.cx).toEqual({ provider: "codex", model: "gpt-6-astra" });
    expect(resolveProviderAlias("cx")).toEqual({
      alias: "cx",
      provider: "codex",
      model: "gpt-6-astra",
      reasoning_effort: "medium",
    });
    expect(resolveProviderDefault("codex")).toMatchObject({
      alias: "cx",
      model: "gpt-6-astra",
      reasoning_effort: "medium",
    });
    // Nothing configured resolves to DEFAULT_PROVIDER_ALIAS, not to Codex.
    expect(resolveProviderDefault(null)).toMatchObject({
      alias: "cc-opus",
      provider: "claude-code",
      model: "claude-opus-5",
    });
  });

  test("treats reasoning effort as an axis separate from the model", () => {
    // Effort suffixes compose with any model alias and normalize spoken spellings.
    expect(parseProviderSelector("cx-extra-high")).toEqual({ alias: "cx", effort: "xhigh" });
    expect(parseProviderSelector("cx-sol-xhigh")).toEqual({ alias: "cx-sol", effort: "xhigh" });
    expect(parseProviderSelector("cc-opus-max")).toEqual({ alias: "cc-opus", effort: "max" });
    expect(parseProviderSelector("@cx-low")).toEqual({ alias: "cx", effort: "low" });
    // An exact alias wins over effort parsing, so retained tier spellings still name models.
    expect(parseProviderSelector("cx-medium")).toEqual({ alias: "cx-medium", effort: null });
    expect(parseProviderSelector("cc-fast")).toEqual({ alias: "cc-fast", effort: null });
    expect(parseProviderSelector("cx-bogus")).toBeNull();
    expect(parseProviderSelector("cx-sol-bogus")).toBeNull();

    expect(resolveProviderAlias("cx-sol", "xhigh")).toMatchObject({
      provider: "codex", model: "gpt-5.6-sol", reasoning_effort: "xhigh",
    });
    // Claude keeps no configured default, so its own CLI default applies.
    expect(resolveProviderAlias("cc").reasoning_effort).toBeUndefined();
    expect(resolveProviderAlias("cc", "high")).toMatchObject({
      provider: "claude-code", model: "claude-fable-5-1", reasoning_effort: "high",
    });

    expect(providerAliasFromText("@cx-sol-extra-high do it", { topLevel: true })).toMatchObject({
      alias: "cx-sol", model: "gpt-5.6-sol", reasoning_effort: "xhigh", token: "@cx-sol-extra-high",
    });
    expect(stripProviderAliases("@cx-sol-xhigh run it")).toBe("run it");
    expect(resolveProviderDefault("cx-high")).toMatchObject({
      alias: "cx", model: "gpt-6-astra", reasoning_effort: "high",
    });
  });

  test("shares one reasoning-effort vocabulary across both providers", () => {
    // These exact tokens are what codex and claude --effort each accept.
    expect([...REASONING_EFFORTS]).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(normalizeReasoningEffort("extra-high")).toBe("xhigh");
    expect(normalizeReasoningEffort("XHigh")).toBe("xhigh");
    expect(normalizeReasoningEffort("maximum")).toBe("max");
    expect(normalizeReasoningEffort("minimal")).toBeNull();
    expect(normalizeReasoningEffort("bogus")).toBeNull();
  });

  test("publishes cx-sol to every router-facing alias surface", () => {
    expect(Object.keys(PROVIDER_ALIASES)).toContain("cx-sol");
    expect(normalizeProviderAliasKey("cx-sol")).toBe("cx-sol");
    expect(normalizeProviderAliasKey("@cx-sol")).toBe("cx-sol");
    expect(resolveProviderAlias("cx-sol")).toEqual({
      alias: "cx-sol",
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoning_effort: "medium",
    });
    expect(selectProviderForComparison({ sourceProvider: "claude-code", targetAlias: "cx-sol" })).toEqual({
      alias: "cx-sol",
      provider: "codex",
      model: "gpt-5.6-sol",
      source: "comparison_explicit_alias",
    });
    expect(stripProviderAliases("@cx-sol run the suite")).toBe("run the suite");
    // A Sol suffix must stay exclusive to Codex and reject near-misses.
    expect(providerAliasFromText("@cc-sol do it", { topLevel: true })).toBeNull();
    expect(providerAliasFromText("@cx-solar do it", { topLevel: true })).toBeNull();
  });

  test("matches aliases at start, middle, and end of top-level messages", () => {
    expect(providerAliasFromText("@cc-fast start", { topLevel: true })?.alias).toBe("cc-fast");
    expect(providerAliasFromText("please use @cx-medium for this", { topLevel: true })?.alias).toBe("cx-medium");
    expect(providerAliasFromText("ship with @cc-fable", { topLevel: true })?.alias).toBe("cc-fable");
  });

  test("requires start or whitespace before the at sign and an exact alias boundary", () => {
    expect(providerAliasFromText("myemail@cc.example.com", { topLevel: true })).toBeNull();
    expect(providerAliasFromText("@cc-fastfix", { topLevel: true })).toBeNull();
    expect(providerAliasFromText("@cc-fastfix please help", { topLevel: true })).toBeNull();
    expect(providerAliasFromText("@ccfast please help", { topLevel: true })).toBeNull();
    expect(providerAliasFromText("@cx-fable please", { topLevel: true })).toBeNull();
    expect(providerSelectionFromText("myemail@cc.example.com", "codex", { topLevel: true })).toMatchObject({
      alias: "cx",
      provider: "codex",
      source: "channel_default",
    });
    expect(providerSelectionFromText("@cc-fastfix", "codex", { topLevel: true })).toMatchObject({
      alias: "cx",
      provider: "codex",
      source: "channel_default",
    });
  });

  test("is case-insensitive and never falls back unknown suffixes to a bare provider", () => {
    expect(providerAliasFromText("Use @CC-MEDIUM", { topLevel: true })).toMatchObject({
      alias: "cc-medium",
      provider: "claude-code",
      model: "claude-sonnet-5",
    });
    expect(providerAliasFromText("@CC-FABLE fix", { topLevel: true })).toMatchObject({
      alias: "cc-fable",
      provider: "claude-code",
      model: "claude-fable-5-1",
    });
    expect(providerAliasFromText("@cc-fst typo", { topLevel: true })).toBeNull();
    expect(providerAliasFromText("@cx-fable mismatch", { topLevel: true })).toBeNull();
  });

  test("does not bind aliases outside the first top-level message", () => {
    expect(providerAliasFromText("@cc-fast reply", { topLevel: false })).toBeNull();
    expect(providerSelectionFromText("@cc-fast reply", "codex", { topLevel: false })).toMatchObject({
      alias: "cx",
      provider: "codex",
      source: "channel_default",
    });
  });

  test("does not recognize legacy text while keeping configured bot mentions", () => {
    expect(providerAliasFromText(`${removedLegacyTextAlias} do it`, { topLevel: true })).toBeNull();
    expect(providerAliasFromText("<@UCLAUDE> do it", {
      topLevel: true,
      claudeCodeBotUserId: "UCLAUDE",
    })).toMatchObject({
      alias: "cc",
      provider: "claude-code",
      source: "bot_mention",
      model: "claude-fable-5-1",
    });
  });

  test("strips routing aliases before the provider sees the prompt", () => {
    expect(stripProviderAliases("@cc-fast fix it")).toBe("fix it");
    expect(stripProviderAliases("please @cx-medium fix it")).toBe("please fix it");
    expect(stripProviderAliases("@cc-fastfix")).toBe("@cc-fastfix");
    expect(stripProviderAliases("@cc-fastfix please help")).toBe("@cc-fastfix please help");
    expect(stripProviderAliases("@cx-fable please")).toBe("@cx-fable please");
    expect(stripProviderAliases(`${removedLegacyTextAlias} fix this`)).toBe(`${removedLegacyTextAlias} fix this`);
  });

  test("channel defaults resolve through the alias table with provider-id compatibility", () => {
    expect(resolveProviderDefault("cc-fable")).toMatchObject({
      provider: "claude-code",
      model: "claude-fable-5-1",
    });
    expect(resolveProviderDefault("codex")).toMatchObject({
      alias: "cx",
      provider: "codex",
    });
  });
});

describe("selectProviderForTurn", () => {
  test.each([
    ["@cc start", "cx", undefined],
    ["@cc-fable start", "cx", undefined],
    ["start", "cc", undefined],
    ["start", "claude-code", undefined],
    ["<@UCLAUDE> start", "cx", undefined],
    ["start", "cc-fast", "claude-code"],
  ] as const)("passes the Concierge Claude default to a new CLI turn (%s, %s, %s)", (text, channelDefault, providerOverride) => {
    const selection = selectProviderForTurn({
      text, channelDefault, providerOverride, topLevel: true, claudeCodeBotUserId: "UCLAUDE",
    });
    expect(selection.selectedProvider).toBe("claude-code");
    expect(selection.selectedModel).toBe("claude-fable-5-1");
    const args = claudeCodeArgs({
      prompt: "start", additionalDirs: [], sessionUUID: null, model: selection.selectedModel,
    });
    expect(args[args.indexOf("--model") + 1]).toBe("claude-fable-5-1");
    expect(args).not.toContain("--effort");
  });

  test("passes a selected reasoning effort to the Claude CLI", () => {
    const selection = selectProviderForTurn({
      text: "@cc-opus-high design this", channelDefault: "cx", topLevel: true,
    });
    expect(selection.selectedModel).toBe("claude-opus-5");
    expect(selection.selectedReasoningEffort).toBe("high");
    const args = claudeCodeArgs({
      prompt: "start", additionalDirs: [], sessionUUID: null,
      model: selection.selectedModel, reasoning_effort: selection.selectedReasoningEffort,
    });
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
  });

  test("preserves explicit Claude overrides and existing session bindings", () => {
    expect(selectProviderForTurn({
      text: 'continue', channelDefault: 'cx', topLevel: false, existingProvider: 'claude-code',
      providerOverride: 'claude-code', modelOverride: 'claude-sonnet-5',
    }).selectedModel).toBe('claude-sonnet-5');
    expect(selectProviderForTurn({
      text: "start", channelDefault: "cc", topLevel: true,
      modelOverride: "claude-haiku-4-5",
    }).selectedModel).toBe("claude-haiku-4-5");
    expect(selectProviderForTurn({
      text: "@cc continue", channelDefault: "cc", topLevel: false,
      existingProvider: "claude-code",
    }).selectedModel).toBeUndefined();
  });

  test("uses alias model on the first top-level message", () => {
    expect(selectProviderForTurn({
      text: "please use @cc-fast",
      channelDefault: "cx",
      topLevel: true,
    })).toMatchObject({
      selectedProvider: "claude-code",
      selectedModel: "claude-haiku-4-5-20251001",
      ignoredSelection: null,
    });
  });

  test("preserves thread binding by ignoring later provider and model aliases", () => {
    expect(selectProviderForTurn({
      text: "actually use @cc-medium",
      channelDefault: "cx",
      topLevel: false,
      existingProvider: "codex",
    })).toMatchObject({
      selectedProvider: "codex",
      selectedModel: undefined,
      ignoredSelection: {
        alias: "cc-medium",
        provider: "claude-code",
        model: "claude-sonnet-5",
      },
    });
  });

  test("keeps single-persistent anchored sessions on their original provider", () => {
    expect(selectProviderForTurn({
      text: "new top-level request @cx-medium",
      channelDefault: "cc-fast",
      topLevel: true,
      existingProvider: "claude-code",
    })).toMatchObject({
      selectedProvider: "claude-code",
      selectedModel: undefined,
      ignoredSelection: {
        alias: "cx-medium",
        provider: "codex",
        model: "gpt-5.6-terra",
      },
    });
  });

  test("does not inherit channel default models when a provider override is explicit", () => {
    const selection = selectProviderForTurn({
      text: "comparison prompt",
      channelDefault: "cc-fast",
      topLevel: true,
      providerOverride: "codex",
      modelOverride: null,
    });
    expect(selection.selectedProvider).toBe("codex");
    // The Claude channel default must not leak across the override; the
    // overridden provider supplies its own alias-table default instead.
    expect(selection.selectedModel).not.toBe("claude-haiku-4-5-20251001");
    expect(selection.selectedModel).toBe("gpt-6-astra");
    expect(selection.selectedReasoningEffort).toBe("medium");
  });
});
