import { beforeEach, describe, expect, test } from "bun:test";
import {
  agentProgressSlackCall,
  canvasSlackBucket,
  canvasSlackCall,
  resetSlackListBucketsForTests,
  slackBucket,
  slackCall,
  slackListCall,
} from "../src/rate-limit";

beforeEach(() => {
  canvasSlackBucket.reset();
  resetSlackListBucketsForTests();
  slackBucket.reset();
});

describe("Slack rate-limit lanes", () => {
  test("uses Slack's raw API surface when a newly released generated method is absent", async () => {
    const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
    const client = {
      apiCall: async (method: string, args: Record<string, unknown>) => {
        calls.push({ method, args });
        return { ok: true };
      },
    };

    await agentProgressSlackCall(client, "agents.sessions.setStatus", {
      channel_id: "C1",
      thread_ts: "100.1",
      status: "processing",
    });

    expect(calls).toEqual([{
      method: "agents.sessions.setStatus",
      args: { channel_id: "C1", thread_ts: "100.1", status: "processing" },
    }]);
  });

  test("a full Canvas maintenance burst does not consume interactive capacity", async () => {
    let canvasCalls = 0;
    let interactiveCalls = 0;
    const client = {
      canvases: {
        edit: async () => {
          canvasCalls += 1;
          return { ok: true };
        },
      },
      chat: {
        postMessage: async () => {
          interactiveCalls += 1;
          return { ok: true, ts: "1.0" };
        },
      },
    };

    for (let index = 0; index < 15; index += 1) {
      await canvasSlackCall(client, "canvases.edit", { canvas_id: `F${index}`, changes: [] });
    }
    await slackCall(client, "chat.postMessage", { channel: "C1", text: "live status" });

    expect(canvasCalls).toBe(15);
    expect(interactiveCalls).toBe(1);
  });

  test("a full List projection burst does not consume interactive capacity", async () => {
    let listCalls = 0;
    let interactiveCalls = 0;
    const client = {
      files: {
        list: async () => {
          listCalls += 1;
          return { ok: true, files: [] };
        },
      },
      reactions: {
        add: async () => {
          interactiveCalls += 1;
          return { ok: true };
        },
      },
    };

    for (let index = 0; index < 20; index += 1) {
      await slackListCall(client, "files.list", { count: 100, page: index + 1, types: "all" });
    }
    await slackCall(client, "reactions.add", { channel: "C1", timestamp: "1.0", name: "hourglass" });

    expect(listCalls).toBe(20);
    expect(interactiveCalls).toBe(1);
  });
});
