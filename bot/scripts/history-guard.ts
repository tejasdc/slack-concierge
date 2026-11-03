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
 *
 * It refuses, first, any call that reads the Mac's Messages or Notification Center databases
 * directly (bot/src/messages-database-policy.ts), because they hold the login codes texted to
 * Tejas; agents read texts through `router-actions.sh messages`, which withholds those. Each such
 * refusal is recorded (bot/src/messages-read-log.ts).
 *
 * It refuses a raw copy of a live Concierge database (bot/src/live-store-copy-policy.ts): one
 * such copy wrote 52.8 GB and stalled his pages on 2026-10-10; copies go through
 * scripts/diagnostic-sqlite-snapshot.py.
 *
 * It refuses a Claude Code command that waits on a shared host build slot unless it runs in the
 * background (bot/src/foreground-build-policy.ts): a foreground build froze an urgent repair for
 * ten minutes on 2026-11-01 while Tejas waited.
 *
 * The same pass, when it refuses nothing, tells an agent about to open a website in a browser
 * where that website's runbook is (bot/src/site-runbook-notice.ts), as `additionalContext` beside
 * the call. It rides this hook because both machines already run it before every call, so no new
 * launcher or machine password is needed.
 */
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { historyRewriteRefusal, toolCommand, writableCodexLaunchDirectory, type RepositoryProbe } from '../src/history-rewrite-policy';
import { siteRunbookNotices } from '../src/site-runbook-notice';
import { messagesDatabaseRefusal } from '../src/messages-database-policy';
import { recordMessagesRead } from '../src/messages-read-log';
import { liveStoreCopyRefusal } from '../src/live-store-copy-policy';
import { macSurfaceRefusal } from '../src/mac-surface-policy';
import { foregroundBuildRefusal } from '../src/foreground-build-policy';

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
let refusedMessages = false;
try {
  const input = hook.tool_input ?? {};
  const command = toolCommand(input);
  reason = messagesDatabaseRefusal(command, input);
  refusedMessages = reason !== null;
  const surface={command,toolName:String(hook.tool_name??''),toolInput:input,platform:process.platform};
  if(!reason)reason=macSurfaceRefusal({...surface,need:process.env.CONCIERGE_MAC_NEED??''});
  // The environment can be empty (Codex's shared App Server) or older than a need steered in later, so a
  // refusal a need could lift asks the Mac owner for the need of the run holding this conversation. The
  // Codex hook gets no Concierge environment, so the socket is the Mac owner's fixed one (as the browser
  // fallback reaches it); one attempt, three seconds, because a hook killed at its own timeout lets the
  // tool run.
  const liftable=reason&&!refusedMessages&&process.platform==='darwin'&&typeof hook.session_id==='string'&&hook.session_id
    &&macSurfaceRefusal({...surface,need:'ios-native'})!==reason;
  if(liftable){
    const recorded=await fetch('http://localhost/session-communication/mac-need',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({provider_session_id:hook.session_id}),
      unix:join(userInfo().homedir,'Library','Application Support','concierge','requests.sock'),signal:AbortSignal.timeout(3000),
    } as RequestInit & {unix:string}).then(response=>response.ok?response.json():null).then((answer:any)=>typeof answer?.kind==='string'?answer.kind:null,()=>null);
    if(recorded&&recorded!==(process.env.CONCIERGE_MAC_NEED??''))reason=macSurfaceRefusal({...surface,need:recorded});
  }
  // Codex names a command's own working directory in its input; Claude's is the hook's cwd.
  const start = [input.workdir, hook.cwd].find(dir => typeof dir === 'string' && dir) ?? process.cwd();
  if (command && !reason) {
    reason = (process.env.CONCIERGE_CURRENT_LIVE_COPY_CHECKED === '1' ? null : liveStoreCopyRefusal(command, start))
      ?? selfMatchingWaitRefusal(command) ?? historyRewriteRefusal(command, start, probe);
    // Claude Code's Bash tool blocks the agent until the command ends; Codex's yields after seconds.
    const claude = hook.tool_name === 'Bash' && typeof input.command === 'string'
      && !(typeof hook.transcript_path === 'string' && hook.transcript_path.includes('/.codex/'));
    if (!reason && claude) {
      try { reason = foregroundBuildRefusal(command, input, start); } catch { reason = null; }
    }
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
if (refusedMessages) {
  try { recordMessagesRead({ event: 'messages_database_refused', provider_session: hook.session_id ?? null, tool: hook.tool_name ?? null, cwd: hook.cwd ?? null }); } catch {}
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) + '\n');
} else if (reason) {
  console.error(JSON.stringify({ event: 'history_rewrite_refused', provider_session: hook.session_id ?? null }));
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) + '\n');
} else {
  // Not a refusal: a browser about to open a website hears about that website's runbook.
  let notices: string[] = [];
  try { notices = siteRunbookNotices(hook, toolCommand(hook.tool_input ?? {})); } catch { notices = []; }
  if (notices.length) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: notices.join('\n') } }) + '\n');
}
process.exit(0);
