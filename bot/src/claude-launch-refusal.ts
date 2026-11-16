/**
 * Concierge's Claude launcher (scripts/agent-claude-launch.ts) prints every refusal it makes
 * before Claude starts after this marker and exits with this code. The turn runner reads it as
 * proof that nothing reached Claude, so the turn fails at once with the launcher's reason instead
 * of parking as an ambiguous end. On 2026-11-16 an unmarked refusal parked concierge:8196's turn
 * with three requests counted as live work until a fifteen-minute overdue notice.
 */
export const LAUNCH_REFUSED_MARKER = 'CONCIERGE_CLAUDE_LAUNCH_REFUSED:';
export const LAUNCH_REFUSED_EXIT = 78;

/** The launcher's own reason, when this stderr and exit code are its marked refusal. */
export function launchRefusalReason(stderr: string, exitCode: number | null): string | null {
  if (exitCode !== LAUNCH_REFUSED_EXIT) return null;
  const at = stderr.lastIndexOf(LAUNCH_REFUSED_MARKER);
  if (at < 0) return null;
  const reason = stderr.slice(at + LAUNCH_REFUSED_MARKER.length).split('\n')[0]!.trim();
  return reason || null;
}
