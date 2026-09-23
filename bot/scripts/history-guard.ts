/**
 * Runs before every command of every Claude and Codex agent and refuses one that would rewrite
 * history that is already pushed: a forced push, or amending or rebasing a pushed commit. The
 * decision is bot/src/history-rewrite-policy.ts; git's pre-push hook refuses the push itself too
 * (scripts/git-hooks/refuse-history-rewrite), for anything this does not see.
 *
 * Both providers run PreToolUse hooks with the tool input on stdin and take
 * `hookSpecificOutput.permissionDecision: "deny"` with a reason the agent reads
 * (https://code.claude.com/docs/en/hooks#pretooluse, https://learn.chatgpt.com/docs/hooks).
 * Claude gets it with --settings on every run (claude-code.ts) and as machine settings; Codex gets
 * it as a managed hook (scripts/install-codex-stop-hook.sh). Anything unexpected lets the command
 * through: git's own hook is the backstop, and a guard must never stop unrelated work.
 */
import { historyRewriteRefusal, toolCommand, type RepositoryProbe } from '../src/history-rewrite-policy';

function git(dir: string, args: string[]): string | null {
  const result = Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'ignore' });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

const probe: RepositoryProbe = {
  headPushed(dir) {
    const found = git(dir, ['for-each-ref', '--contains', 'HEAD', '--count=1', '--format=%(refname)', 'refs/remotes']);
    return found === null ? null : found.length > 0;
  },
  rebaseRewritesPushed(dir, upstream, branch, root) {
    const tip = branch ?? 'HEAD';
    const range = root ? [tip] : [`${upstream ?? '@{upstream}'}..${tip}`];
    const all = git(dir, ['rev-list', '--count', ...range]);
    const unpushed = git(dir, ['rev-list', '--count', ...range, '--not', '--remotes']);
    if (all === null || unpushed === null) return null;
    return Number(all) !== Number(unpushed);
  },
};

let hook: any = {};
try { hook = JSON.parse((await Bun.stdin.text()) || '{}'); } catch { process.exit(0); }
let reason: string | null = null;
try {
  const input = hook.tool_input ?? {};
  const command = toolCommand(input);
  // Codex names a command's own working directory in its input; Claude's is the hook's cwd.
  const start = [input.workdir, hook.cwd].find(dir => typeof dir === 'string' && dir) ?? process.cwd();
  if (command) reason = historyRewriteRefusal(command, start, probe);
} catch { reason = null; }
if (reason) {
  console.error(JSON.stringify({ event: 'history_rewrite_refused', provider_session: hook.session_id ?? null }));
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) + '\n');
}
process.exit(0);
