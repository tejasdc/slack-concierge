import { describe, expect, test } from "bun:test";
import {
  providerAliasFromText,
  providerSelectionFromText,
  resolveProviderDefault,
  selectProviderForTurn,
  stripProviderAliases,
} from "../src/aliases";

const removedLegacyTextAlias = ["@", "claude", "-", "code"].join("");

describe("provider aliases", () => {
  test("resolves every documented alias", () => {
    expect(providerAliasFromText("@cc do it", { topLevel: true })).toMatchObject({
      alias: "cc",
      provider: "claude-code",
    });
    expect(providerAliasFromText("@cc-fast do it", { topLevel: true })).toMatchObject({
      alias: "cc-fast",
      provider: "claude-code",
      model: "claude-haiku-4-5",
    });
    expect(providerAliasFromText("@cc-medium do it", { topLevel: true })).toMatchObject({
      alias: "cc-medium",
      provider: "claude-code",
      model: "claude-sonnet-5",
    });
    expect(providerAliasFromText("@cc-fable do it", { topLevel: true })).toMatchObject({
      alias: "cc-fable",
      provider: "claude-code",
      model: "claude-fable-5",
    });
    expect(providerAliasFromText("@cx do it", { topLevel: true })).toMatchObject({
      alias: "cx",
      provider: "codex",
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
      model: "claude-fable-5",
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
      model: "claude-fable-5",
    });
    expect(resolveProviderDefault("codex")).toMatchObject({
      alias: "cx",
      provider: "codex",
    });
  });
});

describe("selectProviderForTurn", () => {
  test("uses alias model on the first top-level message", () => {
    expect(selectProviderForTurn({
      text: "please use @cc-fast",
      channelDefault: "cx",
      topLevel: true,
    })).toMatchObject({
      selectedProvider: "claude-code",
      selectedModel: "claude-haiku-4-5",
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
    expect(selection.selectedModel).toBeUndefined();
    expect(selection.selectedReasoningEffort).toBeUndefined();
  });
});
