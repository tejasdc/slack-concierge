import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendInbox } from "../src/channel";
import {
  frictionCategoryLabels,
  inlineCaptureConfirmationText,
  inlineCaptureInboxText,
  parseInlineCapture,
} from "../src/inline-capture";

const CAPTURE_SECRET = "friction-capture-test-signing-secret";

describe("explicit friction capture", () => {
  test("recognizes only the three explicit typed-and-transcript-safe categories", () => {
    expect(parseInlineCapture("!friction new-interface Show a calmer activity view")).toEqual({
      kind: "friction",
      category: "new-interface",
      text: "Show a calmer activity view",
    });
    expect(parseInlineCapture("!FRICTION existing-infrastructure Slack activity is noisy")).toEqual({
      kind: "friction",
      category: "existing-infrastructure",
      text: "Slack activity is noisy",
    });
    expect(parseInlineCapture("!friction solved Agent can inspect the rendered block\n\n— via pebble")).toEqual({
      kind: "friction",
      category: "solved",
      text: "Agent can inspect the rendered block\n\n— via pebble",
    });
    expect(parseInlineCapture("!friction idea classify this for me")).toBeNull();
    expect(parseInlineCapture("/friction solved unknown native slash commands are not the affordance")).toBeNull();
    expect(parseInlineCapture("we had friction with the List")).toBeNull();
  });

  test("keeps the category durable and distinct in the canonical inbox", () => {
    const directory = mkdtempSync(join(tmpdir(), "concierge-friction-capture-"));
    const channel = { slack_channel_id: "C1", slack_channel_name: "capture", vault_path: directory };
    try {
      for (const category of Object.keys(frictionCategoryLabels) as Array<keyof typeof frictionCategoryLabels>) {
        const parsed = parseInlineCapture(`!friction ${category} Evidence for ${category}`);
        if (!parsed || parsed.kind !== "friction") throw new Error("Expected friction capture");
        const captureKey = `C1:${category}`;
        appendInbox(
          channel as any,
          inlineCaptureInboxText(parsed),
          "inline by U1",
          captureKey,
          CAPTURE_SECRET,
        );
        appendInbox(
          channel as any,
          inlineCaptureInboxText(parsed),
          "inline by U1",
          captureKey,
          CAPTURE_SECRET,
        );
        expect(inlineCaptureConfirmationText(parsed)).toBe(`${frictionCategoryLabels[category]} captured`);
      }

      const inbox = readFileSync(join(directory, "notes", "inbox.md"), "utf8");
      for (const category of Object.keys(frictionCategoryLabels)) {
        expect(inbox.match(new RegExp(`\\[friction:${category}\\]`, "g"))).toHaveLength(1);
      }
      expect(inbox.match(/concierge-capture-v1:[0-9a-f]{64}/g)).toHaveLength(3);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("preserves existing todo and note parsing and confirmation", () => {
    const todo = parseInlineCapture("/todo Keep this behavior");
    const note = parseInlineCapture("!note Keep this too");
    expect(todo).toEqual({ kind: "todo", text: "Keep this behavior" });
    expect(note).toEqual({ kind: "note", text: "Keep this too" });
    expect(inlineCaptureConfirmationText(todo)).toBe("todo captured");
    expect(inlineCaptureConfirmationText(note)).toBe("note captured");
  });
});
