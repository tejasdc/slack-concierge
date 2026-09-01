import { describe, expect, test } from "bun:test";
import {
  conciergeRootSummary,
  ensureTldr,
  extractLastTldr,
  extractTldr,
  formatTurnStatusMessage,
  slackAgentSessionTitle,
  splitSlackText,
} from "../src/text";

describe("slackAgentSessionTitle", () => {
  test("uses the first meaningful request line as Slack's session title", () => {
    expect(slackAgentSessionTitle("\n# Audit the Agent Sessions UI\nMore detail"))
      .toBe("Audit the Agent Sessions UI");
  });

  test("honors Slack's 200-character title contract without splitting Unicode", () => {
    const title = slackAgentSessionTitle(`🧭${"x".repeat(240)}`)!;

    expect(Array.from(title)).toHaveLength(200);
    expect(title).toEndWith("…");
  });

  test("omits a title for an empty request", () => {
    expect(slackAgentSessionTitle(" \n ")).toBeUndefined();
  });
});

describe("splitSlackText", () => {
  test("keeps short text intact", () => {
    expect(splitSlackText("hello", 10)).toEqual(["hello"]);
    expect(splitSlackText("", 10)).toEqual([""]);
  });

  test("splits long text under limit", () => {
    const chunks = splitSlackText("one two three four five", 9);
    expect(chunks.every((chunk) => chunk.length <= 9)).toBe(true);
    expect(chunks.join("")).toBe("one two three four five");
  });

  test("keeps Markdown tables valid across reply boundaries", () => {
    const header = "| Surface | Best at |\n| --- | --- |\n";
    const rows = "| Slack | Steering agent work |\n".repeat(12);
    const chunks = splitSlackText(header + rows, 140);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.startsWith(header) && chunk.length <= 140)).toBe(true);
    expect(chunks.map((chunk) => chunk.slice(header.length)).join("")).toBe(rows);
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

  test("keeps the original root request above the provider-authored TLDR", () => {
    expect(conciergeRootSummary("TL;DR: Shipped.\n\nDetails", "Build the thing"))
      .toBe([
        "Build the thing",
        "",
        "━━━━━━━━━━━━━━━━━━━━",
        "*Concierge TL;DR*",
        "Shipped.",
      ].join("\n"));
    expect(conciergeRootSummary("Finished without a summary.", "Build the thing"))
      .toBeNull();
    expect(conciergeRootSummary(`TL;DR: ${"x".repeat(12_000)}`, "Build the thing"))
      .toBeNull();
    expect(conciergeRootSummary("TL;DR: Shipped.", "")).toBeNull();
  });

  test("truncates only the original request when the combined root exceeds Slack's limit", () => {
    const rendered = conciergeRootSummary("TL;DR: Shipped.", "request ".repeat(700));

    expect(rendered).not.toBeNull();
    expect(rendered!.length).toBe(4_000);
    expect(rendered).toStartWith("request request");
    expect(rendered).toEndWith([
      "… [truncated]",
      "",
      "━━━━━━━━━━━━━━━━━━━━",
      "*Concierge TL;DR*",
      "Shipped.",
    ].join("\n"));
  });

  test("preserves the full request and its links when the combined root fits exactly", () => {
    const suffix = [
      "",
      "",
      "━━━━━━━━━━━━━━━━━━━━",
      "*Concierge TL;DR*",
      "Shipped.",
    ].join("\n");
    const link = "See <https://example.com/request|the request>\n";
    const request = link + "x".repeat(4_000 - suffix.length - link.length);

    expect(conciergeRootSummary("TL;DR: Shipped.", request)).toBe(`${request}${suffix}`);
  });

  test("leaves the root unchanged when the summary leaves no room for request text", () => {
    const markerLength = "… [truncated]".length;
    const summaryFrameLength = [
      "",
      "",
      "━━━━━━━━━━━━━━━━━━━━",
      "*Concierge TL;DR*",
      "",
    ].join("\n").length;
    const summaryContentLength = 4_000 - summaryFrameLength - markerLength;

    expect(conciergeRootSummary(
      `TL;DR: ${"x".repeat(summaryContentLength)}`,
      "original request",
    )).toBeNull();
  });

  test("extracts the final answer TLDR after progress commentary", () => {
    expect(extractLastTldr([
      "TL;DR: Early progress update.",
      "",
      "More commentary.",
      "",
      "TL;DR: Final end-to-end summary.",
    ].join("\n"))).toBe("Final end-to-end summary.");
  });

  test("treats former Slack List controls as ordinary response text", () => {
    expect(ensureTldr("CONCIERGE_LIST_ADD: ship it")).toBe(
      "TL;DR: CONCIERGE_LIST_ADD: ship it\n\nCONCIERGE_LIST_ADD: ship it",
    );
  });

  test("keeps in-progress turn status terse", () => {
    expect(formatTurnStatusMessage({
      state: "working",
      elapsedMs: 65_000,
      lastUpdateAgeMs: 30_000,
      toolCount: 1,
    })).toBe("Status: working - 1m 5s elapsed, last update 30s ago, 1 tool call");
  });

  test("renders queued turns without implying a resend", () => {
    expect(formatTurnStatusMessage({ state: "queued" })).toBe(
      "Status: queued - another turn is using this agent session; this will start automatically",
    );
  });

  test("renders final turn status with the provider TL;DR", () => {
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
