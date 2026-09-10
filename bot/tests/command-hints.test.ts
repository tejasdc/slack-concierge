import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import manifest from "../../slack-app-manifest.json";
import { PROVIDER_ALIASES } from "../src/aliases";
import { isHintCommand, renderCommandHints } from "../src/command-hints";
import { configuredSkillRoutes } from "../src/skill-routes";
import type { ChannelRow } from "../src/state";

const channel = {
  slack_channel_name: "sample-project",
  provider_default: "cc-fast",
  mode: "agent-auto",
  session_mode: "per-thread",
} as ChannelRow;

describe("!hint", () => {
  test("recognizes only a standalone, typed command", () => {
    for (const text of ["!hint", "  !HINT\n"]) expect(isHintCommand({ text })).toBe(true);
    for (const text of ["/hint", "!hints", "search !hint", "!hint explain this", "`!hint`", "!hint\n!todo task"]) {
      expect(isHintCommand({ text })).toBe(false);
    }
    expect(isHintCommand({ text: "!hint", files: [{}] })).toBe(false);
    expect(isHintCommand({ text: "!hint", prebuiltPrompt: true })).toBe(false);
  });

  test("lists every configured alias, manifest command and message shortcut", () => {
    const text = renderCommandHints({ channel, skillRoutes: configuredSkillRoutes() });
    for (const [alias, target] of Object.entries(PROVIDER_ALIASES)) {
      expect(text).toContain(`\`@${alias}\``);
      if ("model" in target) expect(text).toContain(target.model);
    }
    for (const command of manifest.features.slash_commands) expect(text).toContain(command.command);
    for (const shortcut of manifest.features.shortcuts) expect(text).toContain(shortcut.name);
    expect(text).toContain("@substack-editor");
    expect(text).toContain("!todo");
    expect(text).toContain("!note");
    expect(text).toContain("!fork");
    expect(text).not.toContain("/new");
    expect(text).toContain("Codex auth is managed on the host");
    expect(text).toContain("requires the host review pipeline");
  });

  test("reflects the invoking channel default, admission and session modes", () => {
    const text = renderCommandHints({ channel, skillRoutes: [] });
    expect(text).toContain("Here: sample-project");
    expect(text).toContain("Default: `@cc-fast`");
    expect(text).toContain("claude-haiku-4-5");
    expect(text).toContain("one per thread");
    expect(text).not.toContain("Skill shortcuts");
    const shared = renderCommandHints({ channel: { ...channel, mode: "agent-tag", session_mode: "single-persistent", provider_default: "cx-medium" }, skillRoutes: [] });
    expect(shared).toContain("Default: `@cx-medium`");
    expect(shared).toContain("mention Concierge");
    expect(shared).toContain("shared across this channel");
    expect(shared).toContain("existing session keeps its provider/model");
    const silent = renderCommandHints({ channel: { ...channel, mode: "silent" }, skillRoutes: [] });
    expect(silent).toContain("agent replies are disabled");
    expect(silent).toContain("capture and !hint still work");
  });

  test("reports an unregistered conversation without inventing settings", () => {
    const text = renderCommandHints({ channel: null, skillRoutes: [] });
    expect(text).toContain("no channel registration yet");
    expect(text).not.toContain("Default:");
    expect(text).toContain("@cx-fast");
  });

  test("escapes registry text and keeps the complete reference in one ordinary Slack reply", () => {
    const text = renderCommandHints({ channel: { ...channel, slack_channel_name: "<@UOTHER>&`" }, skillRoutes: configuredSkillRoutes() });
    expect(text).toContain("&lt;@UOTHER&gt;&amp;'");
    expect(text.length).toBeLessThan(4000);
  });

  test("durably claims and classifies help before steering, capture, or project creation", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const handler = source.slice(source.indexOf("async function handleUserMessage"), source.indexOf("const ROUTABLE_SUBTYPES"));
    const hint = handler.indexOf("if (isHintCommand(opts))");
    expect(hint).toBeGreaterThan(handler.indexOf("if (!inputClaim.claimed)"));
    expect(hint).toBeLessThan(handler.indexOf("activeTurnDispatch.dispatchSteering("));
    expect(hint).toBeLessThan(handler.indexOf("ensureChannelProject("));
    const action = handler.slice(hint, handler.indexOf("const steeringDispatch"));
    expect(action.indexOf('inputClaimToken, "ignored"')).toBeLessThan(action.indexOf('"chat.postMessage"'));
    expect(action).toContain("thread_ts: opts.threadTs");
    expect(action).toContain("channel: getChannel(opts.channel)");
    expect(action).not.toContain("ensureChannelProject");
  });
});
