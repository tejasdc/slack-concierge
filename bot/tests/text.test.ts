import { describe, expect, test } from "bun:test";
import { ensureTldr, extractTldr, formatTurnStatusMessage, splitSlackText } from "../src/text";

describe("splitSlackText", () => {
  test("keeps short text intact", () => {
    expect(splitSlackText("hello", 10)).toEqual(["hello"]);
  });

  test("splits long text under limit", () => {
    const chunks = splitSlackText("one two three four five", 9);
    expect(chunks.every((chunk) => chunk.length <= 9)).toBe(true);
    expect(chunks.join(" ")).toBe("one two three four five");
  });
});

describe("TL;DR formatting", () => {
  test("preserves a response that already starts with TL;DR", () => {
    const response = "TL;DR: Shipped the change.\n\nDetails here.";

    expect(ensureTldr(response)).toBe(response);
    expect(extractTldr(response)).toBe("Shipped the change.");
  });

  test("normalizes TLDR and prefixes missing summaries", () => {
    expect(ensureTldr("TLDR: Done\n\nDetails")).toBe("TL;DR: Done\n\nDetails");
    expect(ensureTldr("Implemented the status update.\n\nDetails")).toBe(
      "TL;DR: Implemented the status update.\n\nImplemented the status update.\n\nDetails",
    );
  });

  test("does not derive a summary from hidden Slack List operations", () => {
    expect(ensureTldr("CONCIERGE_LIST_ADD: ship it")).toBe(
      "TL;DR: No output.\n\nCONCIERGE_LIST_ADD: ship it",
    );
  });

  test("renders turn status with a top-level TL;DR", () => {
    expect(formatTurnStatusMessage({
      state: "working",
      elapsedMs: 65_000,
      lastUpdateAgeMs: 30_000,
      toolCount: 1,
    })).toBe("TL;DR: Working on the request; 1 tool call so far.\n\nStatus: working - 1m 5s elapsed, last update 30s ago, 1 tool call");

    expect(formatTurnStatusMessage({
      state: "done",
      elapsedMs: 2_000,
      toolCount: 3,
      provider: "codex",
      tldr: "Final answer ready.",
    })).toBe("TL;DR: Final answer ready.\n\nStatus: done - 2s elapsed, 3 tool calls, provider codex");
  });

  test("bounds provider TL;DR content used in status updates", () => {
    const status = formatTurnStatusMessage({
      state: "done",
      elapsedMs: 2_000,
      toolCount: 1,
      provider: "codex",
      tldr: `TL;DR: ${"word ".repeat(120)}`,
    });

    const firstLine = status.split("\n")[0];
    expect(firstLine.startsWith("TL;DR: word word")).toBe(true);
    expect(firstLine.length).toBeLessThanOrEqual(248);
    expect(status).toContain("Status: done - 2s elapsed, 1 tool call, provider codex");
  });
});
