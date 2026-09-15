import { describe, expect, test } from "bun:test";
import { parseSlackPermalinks, slackPermalinkPrompt, slackThreadPermalink } from "../src/slack-links";

describe("slackThreadPermalink", () => {
  test("builds the canonical in-client thread route from the authenticated workspace URL", () => {
    expect(slackThreadPermalink(
      "https://tejazz.slack.com/",
      "C123",
      "1786144075.781769",
      "T123",
    )).toBe(
      "https://tejazz.slack.com/archives/C123/p1786144075781769?thread_ts=1786144075.781769&cid=C123",
    );
  });

  test("falls back to the existing team route when Slack omits its workspace URL", () => {
    expect(slackThreadPermalink(null, "C123", "1786144075.781769", "T123"))
      .toBe("https://app.slack.com/client/T123/C123/thread-C123-1786144075781769");
  });
});

describe("parseSlackPermalinks", () => {
  test("extracts channel, message timestamp, and thread timestamp from Slack mrkdwn links", () => {
    const links = parseSlackPermalinks(
      "<https://tejazz.slack.com/archives/C123/p1786144075781769?thread_ts=1786136808.487959&cid=C123|thread>",
    );

    expect(links).toEqual([{
      url: "https://tejazz.slack.com/archives/C123/p1786144075781769?thread_ts=1786136808.487959&cid=C123",
      channelId: "C123",
      messageTs: "1786144075.781769",
      threadTs: "1786136808.487959",
    }]);
  });
});

describe("slackPermalinkPrompt", () => {
  test("reads a full thread directly when the permalink includes thread_ts", async () => {
    const calls: any[] = [];
    const prompt = await slackPermalinkPrompt({
      text: "look at https://tejazz.slack.com/archives/C123/p1786144075781769?thread_ts=1786136808.487959&cid=C123",
      client: {},
      user: "UUSER",
      call: async (_client, method, args, context) => {
        calls.push({ method, args, context });
        return {
          messages: [
            { ts: "1786136808.487959", thread_ts: "1786136808.487959", user: "U1", text: "parent" },
            { ts: "1786144075.781769", thread_ts: "1786136808.487959", user: "U2", text: "", files: [{ name: "clip.m4a", mimetype: "audio/mp4" }] },
          ],
        };
      },
    });

    expect(calls).toEqual([{
      method: "conversations.replies",
      args: { channel: "C123", ts: "1786136808.487959", limit: 50 },
      context: { channel: "C123", user: "UUSER" },
    }]);
    expect(prompt).toContain("Linked Slack message:");
    expect(prompt).toContain("surrounding thread is supporting context");
    expect(prompt).toContain("linked_message_ts=1786144075.781769");
    expect(prompt).toContain("2. [LINKED MESSAGE — SUBJECT] ts=1786144075.781769");
    expect(prompt).toContain("not part of the current visible Slack thread or its cumulative TL;DR");
    expect(prompt).toContain("parent_thread_ts=1786136808.487959");
    expect(prompt).toContain("text: parent");
    expect(prompt).toContain("files: clip.m4a (audio/mp4)");
  });

  test("resolves a reply permalink without thread_ts before fetching the parent thread", async () => {
    const calls: any[] = [];
    const prompt = await slackPermalinkPrompt({
      text: "https://tejazz.slack.com/archives/C123/p1786144075781769",
      client: {},
      call: async (_client, method, args, context) => {
        calls.push({ method, args, context });
        if (args.ts === "1786144075.781769") {
          return { messages: [{ ts: "1786144075.781769", thread_ts: "1786136808.487959", user: "U2", text: "reply" }] };
        }
        return { messages: [{ ts: "1786136808.487959", thread_ts: "1786136808.487959", user: "U1", text: "parent" }] };
      },
    });

    expect(calls.map((call) => call.args.ts)).toEqual(["1786144075.781769", "1786136808.487959"]);
    expect(prompt).toContain("parent_thread_ts=1786136808.487959");
    expect(prompt).toContain("text: parent");
  });

  test("keeps inaccessible links as visible prompt context", async () => {
    const prompt = await slackPermalinkPrompt({
      text: "https://tejazz.slack.com/archives/C123/p1786144075781769",
      client: {},
      call: async () => {
        throw new Error("channel_not_found");
      },
    });

    expect(prompt).toContain("linked_message_ts=1786144075.781769");
    expect(prompt).toContain("Unable to read linked message and supporting thread: channel_not_found");
  });

  test("identifies the older linked reply and preserves its full text alongside newer context", async () => {
    const target = "Important details. ".repeat(150) + "cant_update_message";
    const prompt = await slackPermalinkPrompt({
      text: "https://tejazz.slack.com/archives/C123/p1786144075781769?thread_ts=1786136808.487959",
      client: {},
      call: async () => ({ messages: [
        { ts: "1786136808.487959", text: "root context" },
        { ts: "1786144075.781769", text: target },
        { ts: "1786144080.000001", text: "unrelated newest reply" },
      ] }),
    });
    expect(prompt).toContain(`2. [LINKED MESSAGE — SUBJECT] ts=1786144075.781769 author=unknown\n   text: ${target}`);
    expect(prompt).toContain("3. ts=1786144080.000001");
    expect(prompt).toContain("unrelated newest reply");
    expect(prompt).not.toContain("Linked Slack thread:");
  });

  test("a root permalink still identifies that exact message, with or without thread_ts", async () => {
    for (const suffix of ["", "?thread_ts=1786136808.487959"]) {
      const prompt = await slackPermalinkPrompt({
        text: `https://tejazz.slack.com/archives/C123/p1786136808487959${suffix}`,
        client: {},
        call: async () => ({ messages: [{ ts: "1786136808.487959", text: "root subject" }] }),
      });
      expect(prompt).toContain("linked_message_ts=1786136808.487959, parent_thread_ts=1786136808.487959");
      expect(prompt).toContain("1. [LINKED MESSAGE — SUBJECT]");
    }
  });

  test("fetches the exact target beyond the supporting-context limit without walking the whole thread", async () => {
    const calls: any[] = [];
    const prompt = await slackPermalinkPrompt({
      text: "https://tejazz.slack.com/archives/C123/p1786144075781769?thread_ts=1786136808.487959",
      client: {},
      call: async (_client, method, args) => {
        calls.push({ method, args });
        if (args.oldest) return { messages: [
          { ts: "1786136808.487959", text: "parent also returned by Slack" },
          { ts: "1786144075.781769", text: "late target" },
        ] };
        return {
          messages: Array.from({ length: 51 }, (_, i) => ({ ts: i === 0 ? "1786136808.487959" : `1786136809.${String(i).padStart(6, "0")}`, text: "context" })),
          response_metadata: { next_cursor: "more" },
        };
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ method: "conversations.replies", args: {
      channel: "C123", ts: "1786136808.487959", oldest: "1786144075.781769",
      latest: "1786144075.781769", inclusive: true, limit: 1,
    } });
    expect(prompt).toContain("51. [LINKED MESSAGE — SUBJECT] ts=1786144075.781769");
    expect(prompt).toContain("message_count=51");
    expect(prompt).not.toContain("ts=1786136809.000050");
    expect(prompt).toContain("text: late target");
    expect(prompt).toContain("supporting thread messages omitted");
  });

  test("discloses a missing target even if Slack returns another message or the exact read fails", async () => {
    for (const fail of [false, true]) {
      const prompt = await slackPermalinkPrompt({
        text: "https://tejazz.slack.com/archives/C123/p1786144075781769?thread_ts=1786136808.487959",
        client: {},
        call: async (_client, _method, args) => {
          if (args.oldest && fail) throw new Error("message_not_found");
          return { messages: [{ ts: "1786136808.487959", text: "supporting root" }] };
        },
      });
      expect(prompt).toContain("[LINKED MESSAGE UNAVAILABLE]");
      expect(prompt).toContain("text: supporting root");
      expect(prompt).not.toContain("1. [LINKED MESSAGE — SUBJECT]");
    }
  });

  test("separate links into one thread each retain their own subject", async () => {
    const prompt = await slackPermalinkPrompt({
      text: "https://tejazz.slack.com/archives/C123/p1786144075781769?thread_ts=1786136808.487959 https://tejazz.slack.com/archives/C123/p1786144080000001?thread_ts=1786136808.487959",
      client: {},
      call: async () => ({ messages: [
        { ts: "1786136808.487959", text: "root" },
        { ts: "1786144075.781769", text: "first subject" },
        { ts: "1786144080.000001", text: "second subject" },
      ] }),
    });
    const sections = prompt.split("Linked Slack message: ").slice(1);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toContain("2. [LINKED MESSAGE — SUBJECT]");
    expect(sections[0]).not.toContain("3. [LINKED MESSAGE — SUBJECT]");
    expect(sections[1]).toContain("3. [LINKED MESSAGE — SUBJECT]");
    expect(sections[1]).not.toContain("2. [LINKED MESSAGE — SUBJECT]");
  });
});
