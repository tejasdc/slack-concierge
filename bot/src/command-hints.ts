import manifest from "../../slack-app-manifest.json";
import { PROVIDER_ALIASES, resolveProviderDefault, type ProviderAliasTarget } from "./aliases";
import type { ChannelRow } from "./state";
import type { SkillRoute } from "./skill-routes";

export function isHintCommand(input: { text: string; files?: unknown[]; prebuiltPrompt?: boolean }): boolean {
  return !input.prebuiltPrompt && !input.files?.length && /^!hint$/i.test(input.text.trim());
}

function targetLabel(target: ProviderAliasTarget): string {
  const provider = target.provider === "codex" ? "Codex" : "Claude Code";
  return `${provider} · ${target.model || "provider default model"}`;
}

function slackText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("`", "'");
}

export function renderCommandHints(input: {
  channel: ChannelRow | null;
  skillRoutes: SkillRoute[];
}): string {
  const channel = input.channel;
  const context = channel
    ? [
      `*Here: ${slackText(channel.slack_channel_name)}*`,
      `Default: \`@${resolveProviderDefault(channel.provider_default).alias}\` (${targetLabel(resolveProviderDefault(channel.provider_default))}).`,
      `Mode: \`${channel.mode}\` — ${channel.mode === "silent"
        ? "agent replies are disabled; capture and !hint still work. Use /mode to enable agents."
        : channel.mode === "agent-tag"
        ? "mention Concierge, a provider shortcut, or a configured skill to start an agent."
        : "ordinary messages start or continue an agent."}`,
      channel.session_mode === "single-persistent"
        ? "Sessions: shared across this channel; an existing session keeps its provider/model. Forks and comparisons stay separate."
        : "Sessions: one per thread; replies keep that thread's provider/model.",
    ].join("\n")
    : "*Here: no channel registration yet.*\nThese are Concierge's commands. Normal project use registers this conversation; !hint only reads configuration.";

  const aliases = Object.entries(PROVIDER_ALIASES)
    .map(([alias, target]) => `• \`@${alias}\` — ${targetLabel(target)}`);
  const commands = manifest.features.slash_commands.map((command) => {
    const usage = command.command === "/switch-provider"
      ? `<${Object.keys(PROVIDER_ALIASES).join("|")}>`
      : command.usage_hint;
    const caveat = command.command === "/auth-refresh"
      ? " (Claude Code login here; Codex auth is managed on the host)"
      : command.command === "/review-inbox"
      ? " (requires the host review pipeline)"
      : "";
    return `• \`${slackText(`${command.command}${usage ? ` ${usage}` : ""}`)}\` — ${command.description}${caveat}`;
  });

  return [
    "TL;DR: Concierge commands and shortcuts available here.",
    context,
    [
      "*Provider shortcuts*",
      "Start a new top-level request with a shortcut, e.g. `@cx-fast explain this`. Existing sessions keep their provider/model.",
      ...aliases,
    ].join("\n"),
    [
      "*Bang commands*",
      "• `!hint` — show this command reference, even during an active turn",
      "• `!todo <text>` — capture a task",
      "• `!note <text>` — capture an inbox note",
      "• `!fork` — fork from a reply in a settled agent thread",
      "During an active turn, !todo, !note, and !fork replies are steering. Use /todo or /note for capture then.",
    ].join("\n"),
    ["*Slash commands*", ...commands].join("\n"),
    ...(input.skillRoutes.length ? [[
      "*Skill shortcuts*",
      ...input.skillRoutes.map((route) => `• \`@${slackText(route.name)}\` — start a request using this skill`),
    ].join("\n")] : []),
    [
      "*Message menu*",
      ...manifest.features.shortcuts.map((shortcut) => `• ${shortcut.name} — ${shortcut.description}`),
      "Agent Sessions in App Home also offers session controls; running turns have Stop, and retryable failures offer Retry.",
    ].join("\n"),
  ].join("\n\n");
}
