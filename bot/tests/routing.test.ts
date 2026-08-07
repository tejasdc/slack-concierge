import { describe, expect, test } from "bun:test";
import { resolveMessageRouting } from "../src/routing";

describe("resolveMessageRouting", () => {
  test("reuses persistent context without moving the Slack reply", () => {
    const routing = resolveMessageRouting({
      replyThreadTs: "1786117122.879289",
      sessionMode: "single-persistent",
      anchorThreadTs: "1786100374.028559",
    });

    expect(routing).toEqual({
      replyThreadTs: "1786117122.879289",
      sessionThreadTs: "1786100374.028559",
    });
  });

  test("keeps per-thread context and delivery together", () => {
    const routing = resolveMessageRouting({
      replyThreadTs: "1786117122.879289",
      sessionMode: "per-thread",
      anchorThreadTs: "1786100374.028559",
    });

    expect(routing.replyThreadTs).toBe(routing.sessionThreadTs);
  });
});
