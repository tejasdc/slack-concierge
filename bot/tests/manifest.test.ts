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
});
