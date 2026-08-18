import { describe, expect, test } from "bun:test";
import {
  effectiveSessionModeForMessage,
  persistentSessionThreadTs,
  resolveMessageRouting,
} from "../src/routing";

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

  test("gives concurrent first persistent messages one hidden session identity", () => {
    const anchorThreadTs = persistentSessionThreadTs("C1");
    const first = resolveMessageRouting({
      replyThreadTs: "1786117122.879289",
      sessionMode: "single-persistent",
      anchorThreadTs,
    });
    const second = resolveMessageRouting({
      replyThreadTs: "1786117123.879290",
      sessionMode: "single-persistent",
      anchorThreadTs,
    });

    expect(first.replyThreadTs).not.toBe(second.replyThreadTs);
    expect(first.sessionThreadTs).toBe("single-persistent:C1");
    expect(second.sessionThreadTs).toBe(first.sessionThreadTs);
  });

  test("keeps an explicitly bound child thread out of the channel-wide persistent session", () => {
    const sessionMode = effectiveSessionModeForMessage({
      channelSessionMode: "single-persistent",
      hasVisibleThreadSession: true,
    });
    const routing = resolveMessageRouting({
      replyThreadTs: "fork-anchor",
      sessionMode,
      anchorThreadTs: "original-persistent-session",
    });

    expect(sessionMode).toBe("per-thread");
    expect(routing.sessionThreadTs).toBe("fork-anchor");
  });
});
