import { describe, expect, test } from "bun:test";
import { buildComparisonAnchorMessage } from "../src/comparison";
import { buildComparisonRootSummaryUpdate } from "../src/comparison-root-summary";
import { conciergeComparisonRootSummary, conciergeRootSummary } from "../src/text";

function comparisonRoot(sourceText = "Tejas's original comparison prompt") {
  const anchor = buildComparisonAnchorMessage({
    sourceProvider: "codex",
    targetLabel: "claude-code",
    promptCount: 1,
    sourceText,
  });
  return { ...anchor, ts: "100.000001", user: "U-bot", bot_id: "B-bot" };
}

function update(root: ReturnType<typeof comparisonRoot>, desiredText: string, revision = 1) {
  return buildComparisonRootSummaryUpdate({
    root,
    rootTs: "100.000001",
    botUserId: "U-bot",
    botId: "B-bot",
    desiredText,
    revision,
  });
}

describe("comparison-root cumulative projection", () => {
  test("retains visible comparison prompt blocks and never renders the private provider wrapper", () => {
    const root = comparisonRoot();
    const oldDesiredText = conciergeRootSummary(
      "TL;DR: Tejas answered the question and the work resumed.",
      "This is a fresh A/B comparison session.\n\nHidden canonical provider JSON.",
    )!;
    const projected = update(root, oldDesiredText);

    expect(projected.blocks.slice(0, root.blocks.length)).toEqual(root.blocks);
    expect(projected.blocks.at(-1)?.text?.text)
      .toContain("Tejas answered the question and the work resumed.");
    expect(projected.blocks.at(-1)?.block_id).toBe("concierge-root-summary-1");
    expect(projected.text).toContain(root.text);
    expect(JSON.stringify(projected)).not.toContain("Hidden canonical provider JSON");
  });

  test("later revisions replace only the owned TL;DR while preserving the source", () => {
    const root = comparisonRoot();
    const first = update(root, conciergeComparisonRootSummary("TL;DR: Waiting for Tejas's answer.")!);
    const later = update({ ...root, ...first }, conciergeComparisonRootSummary("TL;DR: Work complete.")!, 2);

    expect(later.blocks).toHaveLength(first.blocks.length);
    expect(later.blocks.slice(0, root.blocks.length)).toEqual(root.blocks);
    expect(JSON.stringify(later)).not.toContain("Waiting for Tejas's answer.");
    expect(later.blocks.at(-1)?.text?.text).toContain("Work complete.");
    expect(later.blocks.at(-1)?.block_id).toBe("concierge-root-summary-2");
  });

  test("50-block legacy comparison roots use their title rather than discarding prompts", () => {
    const initial = comparisonRoot();
    const root = { ...initial, blocks: [
      ...initial.blocks,
      ...Array.from({ length: 50 - initial.blocks.length }, () => ({
        type: "section",
        text: { type: "plain_text", text: "Original source", emoji: false },
      })),
    ] };
    expect(root.blocks).toHaveLength(50);
    const result = update(root, conciergeComparisonRootSummary("TL;DR: Work complete.")!);
    expect(result.blocks).toHaveLength(50);
    expect(result.blocks.slice(1)).toEqual(root.blocks.slice(1));
    expect(result.blocks[0].text?.text).toContain("Work complete.");
    const second = update({ ...root, ...result }, conciergeComparisonRootSummary("TL;DR: Answered.")!, 2);
    expect(JSON.stringify(second)).not.toContain("Work complete.");
    expect(second.blocks[0].text?.text).toContain("Answered.");
  });

  test("rejects a different posting identity and cannot silently replace the root", () => {
    const root = comparisonRoot();
    const desired = conciergeComparisonRootSummary("TL;DR: Work complete.")!;
    expect(() => update({ ...root, user: "U-human" }, desired)).toThrow("not owned");
    expect(() => update({ ...root, blocks: [] }, desired)).toThrow("no preservable prompt blocks");
  });
});
