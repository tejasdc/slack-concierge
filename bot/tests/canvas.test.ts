import { describe, expect, test } from "bun:test";

const { buildAgentsCanvasMarkdown } = require("../src/canvas");

describe("buildAgentsCanvasMarkdown", () => {
  test("renders AGENTS.md into deterministic Slack Canvas markdown", () => {
    const markdown = buildAgentsCanvasMarkdown({
      channelName: "proj_alpha",
      codePath: "/root/workspace/proj/alpha",
      agentsText: "# Instructions\n\n- Keep markdown as source of truth.",
    });

    expect(markdown).toContain("# Instructions");
    expect(markdown).toContain("- Keep markdown as source of truth.");
    expect(markdown).toContain("Synced from /root/workspace/proj/alpha");
    expect(markdown).not.toContain("# #proj_alpha instructions");
    expect(markdown.length).toBeLessThanOrEqual(1_048_576);
  });

  test("caps payload at Slack's document_content limit", () => {
    const markdown = buildAgentsCanvasMarkdown({
      channelName: "proj_big",
      agentsText: "x".repeat(1_100_000),
    });

    expect(markdown.length).toBeLessThanOrEqual(1_048_576);
    expect(markdown).toContain("Trimmed by Concierge");
  });
});
