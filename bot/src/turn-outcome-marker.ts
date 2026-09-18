/**
 * Every working turn ends its ordinary answer with one outcome marker line, for example
 * `[[outcome-k7q4:needs_you]] Which name should the project use?`. There is no form, tool
 * call or schema: the agent writes its answer as usual and adds the line. Tejas chose this
 * on 2026-09-18 after the provider-enforced form doubled every Claude turn.
 *
 * The code `k7q4` is what keeps it unambiguous: only the exact marker, alone on the last
 * line, counts. The word "done" anywhere in prose means nothing. The marker is removed
 * before the answer is shown anywhere.
 *
 * - done: the work is finished; nothing for him.
 * - response: an answer he will want to read, but nothing is blocked on him.
 * - needs_you: he must act before work can move; the text after the marker is the question.
 * - failed: the text after the marker says why.
 */
export type MarkedTurnOutcome = "done" | "response" | "needs_you" | "failed";
export type TurnOutcomeMark = { outcome: MarkedTurnOutcome; question?: string; message: string };

export const TURN_OUTCOME_MARKER_CODE = "outcome-k7q4";
const MARKER_LINE = /\n?[ \t]*\[\[outcome-k7q4:(done|response|needs_you|failed)\]\][ \t]*([^\n]*)\s*$/;

/** The answer without its marker, and the outcome the marker declared, if it ended with one. */
export function splitTurnOutcomeMarker(text: string): { text: string; mark: TurnOutcomeMark | null } {
  const match = MARKER_LINE.exec(text);
  if (!match) return { text, mark: null };
  const message = text.slice(0, match.index).trimEnd();
  const outcome = match[1] as MarkedTurnOutcome;
  const detail = match[2]!.trim();
  return { text: message, mark: { outcome, message, ...(detail ? { question: detail } : {}) } };
}

/**
 * Sessions that ran on 2026-09-18 while the form version was live recorded their answer
 * as a `StructuredOutput` tool call. History still reads those as the plain message.
 */
export const LEGACY_STRUCTURED_OUTPUT_TOOL = "StructuredOutput";
export function legacyStructuredOutputMessage(value: unknown): string | null {
  const message = value && typeof value === "object" ? (value as Record<string, unknown>).message : null;
  return typeof message === "string" && message.trim() ? message : null;
}
