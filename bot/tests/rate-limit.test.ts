import { beforeEach, describe, expect, test } from "bun:test";
import {
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
      slackLists: {
        access: {
          set: async () => {
            listCalls += 1;
            return { ok: true };
          },
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
      await slackListCall(client, "slackLists.access.set", {
        list_id: `F${index}`,
        access_level: "read",
        channel_ids: ["C1"],
      });
    }
    await slackCall(client, "reactions.add", { channel: "C1", timestamp: "1.0", name: "hourglass" });

    expect(listCalls).toBe(20);
    expect(interactiveCalls).toBe(1);
  });
});
