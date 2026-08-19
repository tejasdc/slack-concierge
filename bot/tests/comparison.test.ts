import { describe, expect, test } from "bun:test";
import {
  alternateProvider,
  buildComparisonAnchorMessage,
  buildComparisonModal,
  buildUserOnlyComparisonPrompt,
  comparisonClientMessageId,
  comparisonAnchorSourceText,
  comparisonTargetLabel,
  openComparisonModal,
  parseComparisonRequest,
  replayableComparisonPrompts,
  turnInputPolicy,
} from "../src/comparison";

describe("agent comparison", () => {
  test("defaults the modal to the other provider", () => {
    const modal: any = buildComparisonModal({
      sourceProvider: "codex",
      metadata: {
        channelId: "C1",
        channelName: "project",
        sourceSessionId: 42,
        sourceMessageTs: "123.000004",
        sourceThreadTs: "123.000001",
      },
    });

    expect(modal.callback_id).toBe("compare_with_agent_submit");
    expect(modal.blocks[1].element.initial_option.value).toBe("claude-code");
    expect(modal.blocks.map((block: any) => block.block_id)).not.toContain("comparison_model");
    expect(alternateProvider("claude-code")).toBe("codex");
  });

  test("parses a provider-only modal submission through bare provider defaults", () => {
    expect(parseComparisonRequest({
      private_metadata: JSON.stringify({
        channelId: "C1",
        channelName: "project",
        sourceSessionId: 42,
        sourceMessageTs: "123.000004",
        sourceThreadTs: "123.000001",
      }),
      state: {
        values: {
          comparison_provider: { provider: { selected_option: { value: "claude-code" } } },
        },
      },
    })).toEqual({
      channelId: "C1",
      channelName: "project",
      sourceSessionId: 42,
      sourceMessageTs: "123.000004",
      sourceThreadTs: "123.000001",
      provider: "claude-code",
      model: null,
    });
  });

  test("rejects malformed provider selections", () => {
    expect(() => parseComparisonRequest({
      private_metadata: JSON.stringify({
        channelId: "C1",
        channelName: "project",
        sourceSessionId: 42,
        sourceMessageTs: "123.000004",
        sourceThreadTs: "123.000001",
      }),
      state: {
        values: {
          comparison_provider: { provider: { selected_option: { value: "other-agent" } } },
        },
      },
    })).toThrow("Choose Codex or Claude Code");
  });

  test("serializes user prompts without any agent response field", () => {
    const prompt = buildUserOnlyComparisonPrompt([
      {
        slack_user_msg_ts: "123.000001",
        user_text: "First request",
        replay_ready: 1,
        status: "done",
        unreplayable_attachment_count: 0,
      },
      {
        slack_user_msg_ts: "123.000003",
        user_text: "Follow-up request",
        replay_ready: 1,
        status: "delivery_parked",
        unreplayable_attachment_count: 0,
      },
    ]);

    expect(prompt).toContain(JSON.stringify(["First request", "Follow-up request"], null, 2));
    expect(prompt).toContain("the final entry as the active request");
    expect(prompt).not.toContain("agent_text");
    expect(comparisonTargetLabel("codex", "gpt-5.6-codex")).toBe("codex/gpt-5.6-codex");
  });

  test("shows the exact selected original prompt in Unicode-safe plain-text anchor blocks", () => {
    const prefix = "  <@U123>";
    const sourceText = `${prefix}${"x".repeat(2_999 - prefix.length)}😀tail  `;
    const anchor = buildComparisonAnchorMessage({
      sourceProvider: "codex",
      targetLabel: "claude-code",
      promptCount: 2,
      sourceText,
    });

    expect(anchor.text).toBe(
      "A/B comparison: codex → claude-code. Replaying 2 user prompts through the selected message; original agent replies are omitted.",
    );
    expect(anchor.blocks[1].text.text).toBe("*Original prompt/transcript:*");
    const transcriptBlocks = anchor.blocks.slice(2);
    expect(transcriptBlocks.every((block) => block.text.type === "plain_text")).toBe(true);
    expect(transcriptBlocks.every((block) => Array.from(block.text.text).length <= 3_000)).toBe(true);
    expect(transcriptBlocks.map((block) => block.text.text).join("")).toBe(sourceText);
  });

  test("falls back to canonical audio transcript text and rejects impossible Block Kit payloads", () => {
    expect(comparisonAnchorSourceText({
      slack_user_msg_ts: "1",
      user_text: "Audio clip transcription:\nspoken request",
      source_text: "",
      replay_ready: 1,
      status: "done",
      unreplayable_attachment_count: 0,
    })).toBe("Audio clip transcription:\nspoken request");
    expect(comparisonAnchorSourceText({
      slack_user_msg_ts: "1",
      user_text: "canonical",
      source_text: "  keep source spacing  ",
      replay_ready: 1,
      status: "done",
      unreplayable_attachment_count: 0,
    })).toBe("  keep source spacing  ");
    expect(() => buildComparisonAnchorMessage({
      sourceProvider: "codex",
      targetLabel: "claude-code",
      promptCount: 1,
      sourceText: "x".repeat(144_001),
    })).toThrow("Slack's 50-block message limit");
  });

  test("preserves canonical links, Slack mentions, and skill mentions verbatim", () => {
    const canonical = [
      "Review https://example.slack.com/archives/C123/p1234567890000001",
      "Ask <@U123AGENT> and @substack-editor before deciding.",
      "Slack thread links referenced in this user message were resolved before the agent turn.",
    ].join("\n");

    const prompt = buildUserOnlyComparisonPrompt([
      { slack_user_msg_ts: "1", user_text: canonical, replay_ready: 1, status: "done", unreplayable_attachment_count: 0 },
      { slack_user_msg_ts: "2", user_text: "Now decide", replay_ready: 1, status: "done", unreplayable_attachment_count: 0 },
    ]);

    expect(prompt).toContain(JSON.stringify(canonical));
    expect(prompt).toContain("<@U123AGENT>");
    expect(prompt).toContain("@substack-editor");
  });

  test("prebuilt comparison input bypasses every mutating ingress processor", () => {
    expect(turnInputPolicy(true)).toEqual({
      handleInlineCapture: false,
      selectSkill: false,
      stripMentions: false,
      hydrateSlackLinks: false,
    });
    expect(turnInputPolicy(false)).toEqual({
      handleInlineCapture: true,
      selectSkill: true,
      stripMentions: true,
      hydrateSlackLinks: true,
    });
  });

  test("refuses a selected prompt that never reached the source agent", () => {
    expect(() => replayableComparisonPrompts([
      { slack_user_msg_ts: "1", user_text: "done", replay_ready: 1, status: "done", unreplayable_attachment_count: 0 },
      { slack_user_msg_ts: "2", user_text: "busy", replay_ready: 0, status: "cancelled", unreplayable_attachment_count: 0 },
    ])).toThrow("was not sent to the source agent");
  });

  test("refuses a selected steering message that never reached the source agent", () => {
    expect(() => replayableComparisonPrompts([
      { slack_user_msg_ts: "1", user_text: "done", replay_ready: 1, status: "done", unreplayable_attachment_count: 0 },
      { slack_user_msg_ts: "2", user_text: "late steer", replay_ready: 0, status: "steering_failed", unreplayable_attachment_count: 0 },
    ])).toThrow("steering message did not reach");
  });

  test("includes every terminal provider-run status and removes earlier cancelled turns", () => {
    const prompts = replayableComparisonPrompts([
      { slack_user_msg_ts: "1", user_text: "done", replay_ready: 1, status: "done", unreplayable_attachment_count: 0 },
      { slack_user_msg_ts: "2", user_text: "busy", replay_ready: 0, status: "cancelled", unreplayable_attachment_count: 0 },
      { slack_user_msg_ts: "3", user_text: "error", replay_ready: 1, status: "error", unreplayable_attachment_count: 0 },
      { slack_user_msg_ts: "4", user_text: "interrupted", replay_ready: 1, status: "interrupted", unreplayable_attachment_count: 0 },
      { slack_user_msg_ts: "5", user_text: "parked", replay_ready: 1, status: "delivery_parked", unreplayable_attachment_count: 0 },
    ]);
    expect(prompts.map((prompt) => prompt.user_text)).toEqual([
      "done", "error", "interrupted", "parked",
    ]);
  });

  test("rejects in-flight and acknowledgement-ambiguous source histories", () => {
    expect(() => replayableComparisonPrompts([
      { slack_user_msg_ts: "1", user_text: "running", replay_ready: 1, status: "running", unreplayable_attachment_count: 0 },
    ])).toThrow("still in flight");
    expect(() => replayableComparisonPrompts([
      { slack_user_msg_ts: "1", user_text: "done", replay_ready: 1, status: "done", unreplayable_attachment_count: 0 },
      { slack_user_msg_ts: "2", user_text: "uncertain", replay_ready: 0, status: "steering_ambiguous", unreplayable_attachment_count: 0 },
    ])).toThrow("cannot prove whether");
  });

  test("rejects unreplayable files and legacy empty attachment turns", () => {
    expect(() => replayableComparisonPrompts([
      { slack_user_msg_ts: "1", user_text: "caption", replay_ready: 1, status: "done", unreplayable_attachment_count: 1 },
    ])).toThrow("file attachment");
    expect(() => replayableComparisonPrompts([
      { slack_user_msg_ts: "1", user_text: "", replay_ready: 1, status: "done", unreplayable_attachment_count: 0 },
    ])).toThrow("empty or legacy attachment-only prompt");
  });

  test("rejects in-flight, preprocessing-failed, and legacy prompts without canonical input", () => {
    for (const status of ["error", "done"]) {
      expect(() => replayableComparisonPrompts([
        { slack_user_msg_ts: "1", user_text: null, replay_ready: 0, status, unreplayable_attachment_count: 0 },
      ])).toThrow("without authoritative replay text");
    }
    expect(() => replayableComparisonPrompts([
      {
        slack_user_msg_ts: "1",
        user_text: "canonical but provider never started",
        replay_ready: 0,
        status: "interrupted",
        unreplayable_attachment_count: 0,
      },
    ])).toThrow("without authoritative replay text");
  });

  test("opens expiring Slack modals directly and derives a stable anchor id", async () => {
    const calls: any[] = [];
    const client = { views: { open: async (input: any) => { calls.push(input); return { ok: true }; } } };
    const modal: any = buildComparisonModal({
      sourceProvider: "codex",
      metadata: {
        channelId: "C1", channelName: "project", sourceSessionId: 42,
        sourceMessageTs: "123.000004", sourceThreadTs: "123.000001",
      },
    });

    await openComparisonModal(client, "trigger", modal);

    expect(calls).toEqual([{ trigger_id: "trigger", view: modal }]);
    expect(comparisonClientMessageId("V123")).toMatch(/^[0-9a-f-]{36}$/);
    expect(comparisonClientMessageId("V123")).toBe(comparisonClientMessageId("V123"));
  });
});
