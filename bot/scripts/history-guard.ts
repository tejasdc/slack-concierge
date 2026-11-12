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
 * It refuses a recursive search over the whole machine (bot/src/whole-machine-crawl-policy.ts):
 * one rg through every /proc/<pid>/cwd ran at about 5 CPUs for 4.5 minutes on 2026-11-05.
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
import { macComputerUseCall, macSurfaceRefusal } from '../src/mac-surface-policy';
import { foregroundBuildRefusal } from '../src/foreground-build-policy';
import { wholeMachineCrawlRefusal } from '../src/whole-machine-crawl-policy';

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

/**
 * "Concierge did not answer" is not "this request has no Mac need". On 2026-11-12 the Mac's
 * Spotify session (mac:323) held an accepted mac-app need and was clicking through the app when
 * Concierge on the Mac restarted for an update (20:00:32 to 20:00:45); its next two Computer Use
 * calls asked once, got no answer within three seconds, were told they had no accepted need, and
 * the agent gave up a second before the owner came back. So the guard keeps asking while the owner
 * is unreachable (an observed restart takes about 13 seconds), inside the providers' 20-second
 * hook limit, and a still-missing owner gets a refusal that says to retry rather than one that
 * denies the request's need. A real answer, including "no need", is final at once.
 */
const OWNER_WAIT_MS = 15_000;
const OWNER_UNREACHABLE_REFUSAL = 'Concierge on this Mac did not answer for 15 seconds (it is most likely restarting for an update), so this request’s Mac need could not be checked. Your request’s permission is unchanged: retry the same call in a few seconds.';
type OwnerNeed = { kind: string; why: string; humanInputId: string; effectScope: string; updateAuthorization: boolean; focusAuthorization: boolean };
async function askOwnerForMacNeed(providerSessionId: string): Promise<{ answered: true; need: OwnerNeed | null } | { answered: false }> {
  const deadline = Date.now() + OWNER_WAIT_MS;
  const socket = join(userInfo().homedir, 'Library', 'Application Support', 'concierge', 'requests.sock');
  for (;;) {
    const remaining = deadline - Date.now();
    const answer = await fetch('http://localhost/session-communication/mac-need', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider_session_id: providerSessionId }),
      unix: socket, signal: AbortSignal.timeout(Math.max(500, Math.min(3000, remaining))),
    } as RequestInit & { unix: string })
      // A 4xx is the owner answering (no grant); only a missing reply or a 5xx means it is not there yet.
      // Every failure, including a body cut off mid-restart, stays inside this loop: a throw would reach
      // the outer catch, which lets non-Computer-Use helper calls through.
      .then(response => response.ok ? response.json() : response.status < 500 ? {} : undefined)
      .catch(() => undefined);
    if (answer && typeof answer === 'object') {
      const a = answer as any;
      return { answered: true, need: typeof a.kind === 'string' ? {
        kind: a.kind, why: typeof a.why === 'string' ? a.why : '', humanInputId: typeof a.humanInputId === 'string' ? a.humanInputId : '',
        effectScope: typeof a.effectScope === 'string' ? a.effectScope : '', updateAuthorization: a.updateAuthorization === true,
        focusAuthorization: a.focusAuthorization === true,
      } : null };
    }
    if (Date.now() + 500 >= deadline) return { answered: false };
    await Bun.sleep(500);
  }
}

let hook: any = {};
try { hook = JSON.parse((await Bun.stdin.text()) || '{}'); } catch { process.exit(0); }
let reason: string | null = null;
let refusedMessages = false;
let macComputerUseAttempt = false;
try {
  const input = hook.tool_input ?? {};
  macComputerUseAttempt=process.platform==='darwin'&&macComputerUseCall(String(hook.tool_name??''),input);
  const command = toolCommand(input);
  reason = messagesDatabaseRefusal(command, input);
  refusedMessages = reason !== null;
  const surface={command,toolName:String(hook.tool_name??''),toolInput:input,platform:process.platform};
  if(!reason)reason=macSurfaceRefusal({...surface,need:process.env.CONCIERGE_MAC_NEED??''});
  // The environment can be empty (Codex's shared App Server) or older than a need steered in later.
  // Computer Use always checks the active owner's record, including when the environment claims a need:
  // a direct Mac process must not unlock desktop control by setting an environment variable. The Codex
  // hook gets no Concierge environment, so the socket is the Mac owner's fixed one. An absent owner is
  // asked again for up to 15 seconds (askOwnerForMacNeed); a missing answer keeps Computer Use refused.
  const computerUse=!refusedMessages&&macComputerUseAttempt;
  const nativeUpdate=process.platform==='darwin'&&((command??'')+' '+String(input.code??'')).includes('mac-update-ax.swift');
  const nativeFocus=process.platform==='darwin'&&((command??'')+' '+String(input.code??'')).includes('mac-focus-ax.swift');
  const liftable=reason&&!refusedMessages&&process.platform==='darwin'&&typeof hook.session_id==='string'&&hook.session_id
    &&(nativeUpdate||nativeFocus||macSurfaceRefusal({...surface,need:'ios-native'})!==reason);
  if((liftable||computerUse||nativeUpdate||nativeFocus)&&typeof hook.session_id==='string'&&hook.session_id){
    const owner=await askOwnerForMacNeed(hook.session_id);
    const recorded=owner.answered?owner.need:null;
    // The environment carries only a need category. A native app action must
    // use the owner's current source-bound grant even when that category matches.
    if((computerUse||nativeUpdate||nativeFocus)&&!owner.answered)reason=OWNER_UNREACHABLE_REFUSAL;
    else if(computerUse||nativeUpdate||nativeFocus)reason=macSurfaceRefusal({...surface,need:recorded??''});
    else if(recorded&&recorded.kind!==(process.env.CONCIERGE_MAC_NEED??''))reason=macSurfaceRefusal({...surface,need:recorded});
  }
  if(computerUse&&(!hook.session_id||typeof hook.session_id!=='string'))reason=macSurfaceRefusal({...surface,need:''});
  if(nativeUpdate&&(!hook.session_id||typeof hook.session_id!=='string'))reason=macSurfaceRefusal({...surface,need:''});
  // Codex names a command's own working directory in its input; Claude's is the hook's cwd.
  const start = [input.workdir, hook.cwd].find(dir => typeof dir === 'string' && dir) ?? process.cwd();
  // The machine wrapper's current-release pass already checked whole-machine crawls.
  if (!reason && process.env.CONCIERGE_CURRENT_LIVE_COPY_CHECKED !== '1') {
    try { reason = wholeMachineCrawlRefusal(command, String(hook.tool_name ?? ''), input, [input.workdir, hook.cwd].find(dir => typeof dir === 'string' && dir) ?? process.cwd()); } catch { reason = null; }
  }
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
} catch { reason = macComputerUseAttempt
  ? 'Mac Computer Use needs a recorded desktop-capable Mac need; the owner check could not complete.'
  : null; }
if (refusedMessages) {
  try { recordMessagesRead({ event: 'messages_database_refused', provider_session: hook.session_id ?? null, tool: hook.tool_name ?? null, cwd: hook.cwd ?? null }); } catch {}
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) + '\n');
} else if (reason) {
  console.error(JSON.stringify({ event: 'tool_preflight_refused', provider_session: hook.session_id ?? null, tool: hook.tool_name ?? null }));
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) + '\n');
} else {
  // Not a refusal: a browser about to open a website hears about that website's runbook.
  let notices: string[] = [];
  try { notices = siteRunbookNotices(hook, toolCommand(hook.tool_input ?? {})); } catch { notices = []; }
  if (notices.length) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: notices.join('\n') } }) + '\n');
}
process.exit(0);
