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
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { historyRewriteRefusal, toolCommand, writableCodexLaunchDirectory, type RepositoryProbe } from '../src/history-rewrite-policy';

function selfMatchingWaitRefusal(command: string): string | null {
  const loop = /\b(?:until|while)\b[\s\S]*\b(?:do|sleep)\b|\bfor\b[\s\S]*\bdo\b/i.test(command);
  if (!loop) return null;
  const patternWait = /\bpgrep\s+(?:-[\w]*f[\w]*\s+|--full\s+)|\bpkill\s+(?:-[\w]*0[\w]*\s+)?(?:-[\w]*f[\w]*\s+|--full\s+)|\bps\b[^\n;]*\|\s*grep\b/i.test(command);
  return patternWait
    ? 'Refused: this wait loop can match its own command and never finish. Wait for exact process IDs with `router-actions.sh wait --pid <pid> [--timeout 30m]`.'
    : null;
}

function git(dir: string, args: string[], timeout = 5000): string | null {
  const result = Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'ignore', timeout });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

/**
 * Every commit this checkout knows a remote has: its remote-tracking refs, and the branch tips the
 * remotes report now. Asking the remotes matters: a single-branch or shallow clone tracks only
 * main, so a task branch it pushed has no tracking ref, and the first live check let an amend of
 * that pushed commit through (2026-09-23). Only amend and rebase ask, so the lookup is rare.
 */
function remoteTips(dir: string): string[] | null {
  const tracked = git(dir, ['for-each-ref', '--format=%(objectname)', 'refs/remotes']);
  if (tracked === null) return null;
  const tips = new Set(tracked.split('\n').filter(Boolean));
  for (const remote of (git(dir, ['remote']) ?? '').split('\n').filter(Boolean)) {
    for (const line of (git(dir, ['ls-remote', '--heads', remote], 8000) ?? '').split('\n')) {
      const sha = line.split('\t')[0];
      if (sha && git(dir, ['cat-file', '-e', `${sha}^{commit}`]) !== null) tips.add(sha);
    }
  }
  return [...tips];
}

const probe: RepositoryProbe = {
  headPushed(dir) {
    const tips = remoteTips(dir);
    if (tips === null) return null;
    return tips.some(tip => git(dir, ['merge-base', '--is-ancestor', 'HEAD', tip]) !== null);
  },
  rebaseRewritesPushed(dir, upstream, branch, root) {
    const tip = branch ?? 'HEAD';
    const range = root ? [tip] : [`${upstream ?? '@{upstream}'}..${tip}`];
    const tips = remoteTips(dir);
    const all = git(dir, ['rev-list', '--count', ...range]);
    if (tips === null || all === null) return null;
    const unpushed = git(dir, ['rev-list', '--count', ...range, '--not', ...tips]);
    if (unpushed === null) return null;
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
  if (command) {
    reason = selfMatchingWaitRefusal(command) ?? historyRewriteRefusal(command, start, probe);
    if (!reason) {
      const launch = writableCodexLaunchDirectory(command, start);
      if (launch) {
        const top = git(launch, ['rev-parse', '--show-toplevel']);
        const common = git(launch, ['rev-parse', '--git-common-dir']);
        if (top && common && realpathSync(top) === realpathSync(dirname(resolve(launch, common)))) {
          reason = `Refused: writable Codex work would run in the shared checkout ${top}. Run \`wt <task-name>\` there, then launch Codex from the worktree it prints. Read-only Codex reviews remain allowed here.`;
        }
      }
    }
  }
} catch { reason = null; }
if (reason) {
  console.error(JSON.stringify({ event: 'history_rewrite_refused', provider_session: hook.session_id ?? null }));
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) + '\n');
}
process.exit(0);
