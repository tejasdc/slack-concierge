/**
 * A background job whose only work is waiting is refused before it starts.
 *
 * Claude Code already reports every background agent and background command back to the agent
 * that started it when it finishes, and wakes a helper agent with its own job's result even after
 * that helper stopped (recorded live on 2026-10-07: a nested `task_started` carries
 * `owned_by_subagent`, and its completion restarts the helper). Concierge keeps the run open until
 * those reports arrive and steers a late one in itself (claude-code.ts). A hand-made waiter on top
 * adds nothing, but it holds the run and every Concierge update behind it: on 2026-10-07 one helper
 * agent started four helpers of its own and then five sleeps (`sleep 240`, `sleep 540`, `sleep 880`…)
 * to stay awake for them, and the main agent added a loop polling for the reports' files, so
 * Tejas saw an update waiting on seven "background jobs", most of them waiting for each other.
 *
 * A waiter is a background Bash command or a Monitor made only of sleeping and looking at files
 * (`sleep`, `until [ -s report.md ]; do sleep 15; done`, `sleep 240; cat log`). Anything that does
 * work, or watches something outside this machine's own jobs (a deploy, a URL, a process ID), is
 * left alone.
 */
const WAIT_ONLY_COMMANDS = new Set(['sleep', 'echo', 'printf', 'true', ':', 'test', '[', '[[', 'ls', 'cat', 'tail', 'head', 'wc', 'grep', 'date']);
const SHELL_KEYWORDS = /^(?:(?:until|while|done|do|then|else|fi|if)\b|!|\{|\}|\(|\))\s*/;

export const WAITER_REFUSAL = 'Refused: this job only waits. Every background agent and background command you start '
  + 'already reports back to you when it finishes, inside helper agents too, and Concierge keeps this run open until then and '
  + 'checks on you if a report is late. So start nothing just to wait: keep working or end your turn, and you are woken with the '
  + 'result. If you need a result before you can go on, run that agent or command in the foreground instead.';

function waitsOnly(command: string): boolean {
  const body = command.replace(/#.*$/gm, '').replace(/\[\[?[^\]]*\]\]?/g, ' test ');
  const segments = body.split(/;|&&|\|\||\||\n/).map(segment => segment.trim()).filter(Boolean);
  let sleeps = false;
  for (let segment of segments) {
    while (SHELL_KEYWORDS.test(segment)) segment = segment.replace(SHELL_KEYWORDS, '');
    if (!segment) continue;
    const name = segment.split(/\s+/)[0]!.split('/').pop()!;
    if (!WAIT_ONLY_COMMANDS.has(name)) return false;
    if (name === 'sleep') sleeps = true;
  }
  return sleeps;
}

/**
 * The refusal for a job that only waits, or null for anything that does work. In the background
 * any wait-only command is refused; in the foreground only a wait loop is, since a short pause
 * is ordinary and Claude Code already blocks a long one. A foreground loop polling for its own
 * jobs' output holds the turn, and every update with it, as surely as a background one: the
 * security-review session sat in one at 16:40 on 2026-10-07 while the update waited.
 */
export function waiterOnlyRefusal(toolName: unknown, input: Record<string, any>): string | null {
  if (typeof input.command !== 'string' || !waitsOnly(input.command)) return null;
  if (toolName === 'Monitor' || (toolName === 'Bash' && input.run_in_background === true)) return WAITER_REFUSAL;
  return toolName === 'Bash' && /\b(?:until|while)\b/.test(input.command) ? WAITER_REFUSAL : null;
}
