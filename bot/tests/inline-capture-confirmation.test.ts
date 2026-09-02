import { beforeEach, describe, expect, test } from "bun:test";
import { deliverInlineCaptureConfirmation } from "../src/inline-capture-confirmation";
import { slackBucket } from "../src/rate-limit";

beforeEach(() => slackBucket.reset());

describe("inline capture confirmation", () => {
  test.each(["!todo keep this", "/todo keep this"])(
    "acknowledges %s with only a check-mark reaction on the triggering message",
    async (userText) => {
      const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
      const client = {
        apiCall: async (method: string, args: Record<string, unknown>) => {
          calls.push({ method, args });
          return { ok: true };
        },
      };

      await deliverInlineCaptureConfirmation({
        client,
        channel: "C1",
        threadTs: "100.1",
        userMessageTs: "101.2",
        userText,
        userId: "U1",
        messageClientId: "unused-for-todos",
      });

      expect(calls).toEqual([{
        method: "reactions.add",
        args: { channel: "C1", timestamp: "101.2", name: "white_check_mark" },
      }]);
    },
  );

  test("treats an existing todo reaction as a successful replay", async () => {
    const client = {
      apiCall: async () => {
        const error: any = new Error("already_reacted");
        error.data = { error: "already_reacted" };
        throw error;
      },
    };

    await expect(deliverInlineCaptureConfirmation({
      client,
      channel: "C1",
      threadTs: "100.1",
      userMessageTs: "101.2",
      userText: "!todo keep this",
      userId: "U1",
      messageClientId: "unused-for-todos",
    })).resolves.toBeUndefined();
  });

  test("preserves the existing thread confirmation for inline notes", async () => {
    const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
    const client = {
      apiCall: async (method: string, args: Record<string, unknown>) => {
        calls.push({ method, args });
        return { ok: true };
      },
    };

    await deliverInlineCaptureConfirmation({
      client,
      channel: "C1",
      threadTs: "100.1",
      userMessageTs: "101.2",
      userText: "!note remember this",
      userId: "U1",
      messageClientId: "note-confirmation-id",
    });

    expect(calls).toEqual([{
      method: "chat.postMessage",
      args: {
        channel: "C1",
        thread_ts: "100.1",
        text: "note captured",
        client_msg_id: "note-confirmation-id",
      },
    }]);
  });
});
