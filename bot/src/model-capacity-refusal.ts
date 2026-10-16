/**
 * OpenAI saying a model has no serving capacity right now ("Selected model is at capacity.
 * Please try a different model.", or the App Server's typed `serverOverloaded`). It is a
 * temporary provider condition, like a rate limit, never a verdict on the request: on
 * 2026-10-16 it was read as permanent after two attempts in forty seconds and an outside
 * Codex run resuming through a remote compaction died on it. The App Server names it with a
 * typed code; `codex exec` prints it only as an error line or on stderr, so the words are
 * matched too. This module imports nothing, because the receipt text the presentation
 * worker writes needs the same match and that worker may not import application writers.
 */
export function isModelCapacityRefusal(message: string): boolean {
  return /\bat capacity\b|server_overloaded|serverOverloaded/i.test(message);
}
