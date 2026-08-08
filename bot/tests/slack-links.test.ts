import { describe, expect, test } from "bun:test";
import { parseSlackPermalinks, slackPermalinkPrompt } from "../src/slack-links";

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
    expect(prompt).toContain("Use this linked-thread context");
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

    expect(prompt).toContain("Unable to read linked thread: channel_not_found");
  });
});
