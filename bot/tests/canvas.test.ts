import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  agentsFingerprint,
  agentsPath,
  buildAgentsCanvasMarkdown,
  buildAgentsCanvasPayload,
  syncAllAgentsCanvases,
} = require("../src/canvas");
const scratchDirectories: string[] = [];

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("buildAgentsCanvasMarkdown", () => {
  test("renders AGENTS.md into deterministic Slack Canvas markdown", () => {
    const markdown = buildAgentsCanvasMarkdown({
      channelName: "proj_alpha",
      sourcePath: "/root/workspace/proj/alpha/AGENTS.md",
      agentsText: "# Instructions\n\n- Keep markdown as source of truth.",
    });

    expect(markdown).toContain("# Instructions");
    expect(markdown).toContain("- Keep markdown as source of truth.");
    expect(markdown).toContain("Synced from /root/workspace/proj/alpha/AGENTS.md");
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

  test("reads code-root instructions for managed projects and vault instructions only for vault-only channels", () => {
    const root = mkdtempSync(join(tmpdir(), "concierge-canvas-source-"));
    scratchDirectories.push(root);
    const codePath = join(root, "code");
    const vaultPath = join(root, "vault");
    mkdirSync(codePath, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    writeFileSync(join(codePath, "AGENTS.md"), "# Code authority\n");
    writeFileSync(join(vaultPath, "AGENTS.md"), "# Vault authority\n");

    const managed = {
      slack_channel_name: "managed",
      code_path: codePath,
      vault_path: vaultPath,
    };
    const vaultOnly = {
      slack_channel_name: "vault-only",
      code_path: null,
      vault_path: vaultPath,
    };

    expect(agentsPath(managed)).toBe(join(codePath, "AGENTS.md"));
    expect(buildAgentsCanvasPayload(managed).document_content.markdown).toContain("# Code authority");
    expect(buildAgentsCanvasPayload(managed).document_content.markdown).not.toContain("# Vault authority");
    expect(agentsPath(vaultOnly)).toBe(join(vaultPath, "AGENTS.md"));
    expect(buildAgentsCanvasPayload(vaultOnly).document_content.markdown).toContain("# Vault authority");
    expect(agentsFingerprint(managed)).not.toBe(agentsFingerprint(vaultOnly));
  });

  test("fails a required all-channel refresh but tolerates ordinary scheduled failures", async () => {
    const channels = [
      { slack_channel_id: "C1" },
      { slack_channel_id: "C2" },
    ] as any[];
    const sync = async (channel: any) => channel.slack_channel_id === "C1"
      ? { ok: true as const }
      : { ok: false as const, error: "canvas_failed" };

    const ordinary = await syncAllAgentsCanvases({ channels, requireSuccess: false, sync });
    expect(ordinary).toEqual({
      refreshed: 1,
      failures: [{ channel: "C2", error: "canvas_failed" }],
    });
    expect(syncAllAgentsCanvases({ channels, requireSuccess: true, sync })).rejects.toThrow("Required Canvas refresh failed");
  });
});
