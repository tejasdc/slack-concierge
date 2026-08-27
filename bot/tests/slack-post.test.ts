import { beforeEach, describe, expect, test } from "bun:test";
import { slackBucket } from "../src/rate-limit";
import { postLongReply } from "../src/slack-post";

describe("final Slack replies", () => {
  beforeEach(() => slackBucket.reset());

  test("renders standard Markdown through Slack's native Markdown block", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const table = [
      "TL;DR: Compared the three surfaces.",
      "",
      "| Surface | Best at | Cognitive timescale |",
      "| --- | --- | --- |",
      "| Thinkering | Forming thought | Seconds to hours |",
      "| Slack | Steering agents | Hours to days |",
      "| Obsidian | Ratified memory | Days to years |",
    ].join("\n");
    const client = {
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { ok: true, ts: "100.000001" };
        },
      },
    };

    await postLongReply({
      client,
      channel: "C1",
      threadTs: "99.000001",
      text: table,
      idempotencyKey: "turn:1:outcome",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      channel: "C1",
      thread_ts: "99.000001",
      blocks: [{ type: "markdown", text: table }],
      client_msg_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  test("shows continuation labels inside each visible Markdown block", async () => {
    const calls: Array<Record<string, any>> = [];
    const client = {
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { ok: true, ts: String(calls.length) };
        },
      },
    };

    await postLongReply({
      client,
      channel: "C1",
      threadTs: "99.000001",
      text: "Paragraph.\n\n".repeat(500),
    });

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((call, index) =>
      call.blocks[0].type === "markdown"
      && call.blocks[0].text.endsWith(`(${index + 1}/${calls.length})`),
    )).toBe(true);
  });
});
