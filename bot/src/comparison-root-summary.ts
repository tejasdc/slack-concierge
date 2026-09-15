import { toMrkdwn } from "./mrkdwn";
import { comparisonRootSummarySuffix } from "./text";

const SUMMARY_BLOCK_PREFIX = "concierge-root-summary-";
const SLACK_SECTION_LIMIT = 3_000;
const SLACK_MESSAGE_BLOCK_LIMIT = 50;
const SLACK_ROOT_TEXT_LIMIT = 4_000;

type SlackSection = {
  type: string;
  block_id?: string;
  text?: { type: string; text: string; emoji?: boolean };
  [key: string]: unknown;
};

export function buildComparisonRootSummaryUpdate(input: {
  root: { ts?: string; user?: string; bot_id?: string; text?: string; blocks?: SlackSection[] };
  rootTs: string;
  botUserId: string;
  botId: string | null;
  desiredText: string;
  revision: number;
}) {
  const { root } = input;
  if (root.ts !== input.rootTs || root.user !== input.botUserId
      || (input.botId && root.bot_id !== input.botId)) {
    throw new Error("Comparison root is not owned by the authenticated Concierge bot.");
  }
  if (!Array.isArray(root.blocks) || root.blocks.length < 3) {
    throw new Error("Comparison root has no preservable prompt blocks.");
  }
  const suffix = comparisonRootSummarySuffix(input.desiredText);
  if (!suffix) throw new Error("Comparison root summary has no cumulative TL;DR.");
  const renderedSummary = toMrkdwn(suffix.trim());
  if (Array.from(renderedSummary).length > SLACK_SECTION_LIMIT
      || Buffer.byteLength(renderedSummary, "utf8") > SLACK_SECTION_LIMIT) {
    throw new Error("Comparison TL;DR exceeds Slack's section text limit; final response remains available.");
  }
  const originalFallback = String(root.text || "").split("\n\n━━━━━━━━━━━━━━━━━━━━")[0];
  const fallback = `${originalFallback}${suffix}`;
  if (Array.from(fallback).length > SLACK_ROOT_TEXT_LIMIT
      || Buffer.byteLength(fallback, "utf8") > SLACK_ROOT_TEXT_LIMIT) {
    throw new Error("Comparison root fallback plus TL;DR exceeds Slack's message text limit.");
  }
  const blocks = root.blocks.filter((block) => !block.block_id?.startsWith(SUMMARY_BLOCK_PREFIX));
  if (blocks.length < SLACK_MESSAGE_BLOCK_LIMIT) {
    return {
      text: fallback,
      blocks: [...blocks, {
        type: "section",
        block_id: `${SUMMARY_BLOCK_PREFIX}${input.revision}`,
        text: { type: "mrkdwn", text: renderedSummary },
      }],
    };
  }
  const first = blocks[0];
  if (first?.type !== "section" || first.text?.type !== "mrkdwn") {
    throw new Error("Comparison root has no available block for its TL;DR.");
  }
  const originalTitle = first.text.text.split("\n\n━━━━━━━━━━━━━━━━━━━━")[0];
  const mergedTitle = `${originalTitle}${suffix}`;
  if (Array.from(mergedTitle).length > SLACK_SECTION_LIMIT
      || Buffer.byteLength(mergedTitle, "utf8") > SLACK_SECTION_LIMIT) {
    throw new Error("Comparison root title cannot carry the TL;DR within Slack's section limit.");
  }
  return {
    text: fallback,
    blocks: [{ ...first, text: { ...first.text, text: toMrkdwn(mergedTitle) } }, ...blocks.slice(1)],
  };
}
