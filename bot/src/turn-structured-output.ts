/**
 * Every working turn ends with a final answer the provider itself validates against this
 * schema: Claude Code through `--json-schema`, Codex through `outputSchema` on
 * `turn/start`. The outcome is structured data the provider enforced, never read out of
 * prose. `message` is what the turn displays everywhere; the raw object stays only as
 * execution evidence. See thinkering docs/plans/2026-09-18-turn-outcome.md.
 */
export const TURN_OUTCOME_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    outcome: { type: "string", enum: ["done", "needs_you", "failed"] },
    question: { type: "string", minLength: 1 },
    message: { type: "string", minLength: 1 },
  },
  required: ["outcome", "message"],
  // No top-level allOf/anyOf/oneOf: Claude delivers this schema as a tool definition, and the
  // API refuses the whole request for one ("input_schema does not support oneOf, allOf, or
  // anyOf at the top level"), which failed every Claude turn on 2026-09-18. That `needs_you`
  // carries a question is enforced by `structuredTurnOutcome` below.
} as const;

export type StructuredTurnOutcome = { outcome: "done" | "needs_you" | "failed"; question?: string; message: string };

/** Claude Code delivers structured output as a call to this tool, which ends the turn. */
export const CLAUDE_STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

/** The provider validated this already; checking again keeps a malformed value from being trusted. */
export function structuredTurnOutcome(value: unknown): StructuredTurnOutcome | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !["outcome", "question", "message"].includes(key))) return null;
  if (item.outcome !== "done" && item.outcome !== "needs_you" && item.outcome !== "failed") return null;
  if (typeof item.message !== "string" || !item.message.trim()) return null;
  if (item.question !== undefined && (typeof item.question !== "string" || !item.question.trim())) return null;
  if (item.outcome === "needs_you" && item.question === undefined) return null;
  return { outcome: item.outcome, message: item.message, ...(typeof item.question === "string" ? { question: item.question } : {}) };
}

/** Codex returns the validated final answer as the text of its last agent message. */
export function structuredTurnOutcomeText(text: string): StructuredTurnOutcome | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try { return structuredTurnOutcome(JSON.parse(trimmed)); } catch { return null; }
}
