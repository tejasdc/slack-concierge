import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const manifest = JSON.parse(
  readFileSync(join(import.meta.dir, "../../slack-app-manifest.json"), "utf-8"),
);

describe("Slack app manifest", () => {
  test("keeps shortcut names within Slack's 25-character limit", () => {
    const shortcuts = manifest.features.shortcuts as Array<{ name: string }>;

    expect(shortcuts.every((shortcut) => shortcut.name.length <= 25)).toBe(true);
  });

  test("declares the existing Concierge app as an Agent with native Stop", () => {
    expect(manifest.features.agent_view.agent_description).toContain("durable Codex");
    expect(manifest.features.app_home).toMatchObject({
      home_tab_enabled: true,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    });
    expect(manifest.oauth_config.scopes.bot).toContain("assistant:write");
    expect(manifest.settings.event_subscriptions.bot_events).toContain("agent_session_stopped");
    expect(manifest.settings.event_subscriptions.bot_events).toContain("agent_session_title_changed");
    expect(manifest.settings.event_subscriptions.bot_events).toContain("app_home_opened");
  });
});
