/**
 * The Stop hook for every Concierge agent, Claude and Codex alike: when an agent tries to end its
 * turn while it still owes a final reply to a request it received, send it back with the exact
 * command, inside the same turn. Usage: owed-reply-stop-hook.ts <claude-code|codex>.
 *
 * Both providers run Stop hooks when the agent finishes, give the hook the provider's own
 * conversation id as `session_id` and `stop_hook_active` when the turn is already continuing
 * because of a Stop hook, and take `{"decision":"block","reason"}` as "keep going with this"
 * (https://code.claude.com/docs/en/hooks#stop, https://learn.chatgpt.com/docs/hooks). Claude gets
 * this hook from Concierge with --settings on every run (claude-code.ts). Codex gets it as a
 * managed hook from /etc/codex/requirements.toml, which Codex trusts by policy for unattended
 * agents; scripts/install-codex-stop-hook.sh installs it on each machine.
 *
 * The owner decides from the conversation id which session and run are asking; a conversation
 * with no running Concierge turn owes nothing, so every Codex or Claude run outside Concierge on
 * the same machine passes straight through. The agent is sent back once. When it stops again,
 * `stop_hook_active` is the evidence that the reminder reached it: the owner records exactly the
 * requests this hook printed as reminded and lets it stop, and if they are still open when the run
 * ends the requester is told they stalled. Any failure lets the agent stop: a hook must never trap
 * a turn. Background tasks keep a Concierge run open and wake it again, so they allow the stop.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { requestApiResponse } from './router-request-client';
import { RETRY_POLICIES } from '../src/retry-policies';

const provider = process.argv[2];
let hook: any = {};
try { hook = JSON.parse((await Bun.stdin.text()) || '{}'); } catch { process.exit(0); }
const conversation = typeof hook.session_id === 'string' ? hook.session_id : null;
if (!provider || !conversation || (Array.isArray(hook.background_tasks) && hook.background_tasks.length)) process.exit(0);

// agent-browser detaches its controller from a tool command, so the shared Codex daemon's
// cgroup retains Chrome after the turn. The provider conversation (Codex) or the owner's exact
// native run (Claude) is carried into that controller's environment. Stop only processes bearing
// that identity, after the turn is allowed to finish; a blocked Stop still owns its browser.
function closeRunBrowsers(runId: string | null) {
  if (process.platform !== 'linux') return;
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const executable = readFileSync(`/proc/${pid}/cmdline`).toString().split('\0')[0];
      if (executable !== '/usr/lib/node_modules/agent-browser/bin/agent-browser-linux-x64'
        && !/^\/root\/\.agent-browser\/browsers\/chrome-[^/]+\/chrome(?:_crashpad_handler)?$/.test(executable)) continue;
      const environment = readFileSync(`/proc/${pid}/environ`).toString().split('\0');
      const owned = runId && environment.includes(`CONCIERGE_SOURCE_RUN_ID=${runId}`)
        || provider === 'codex' && environment.includes(`CODEX_THREAD_ID=${conversation}`);
      if (owned) process.kill(pid, 'SIGTERM');
    } catch { /* A process may exit while /proc is being scanned. */ }
  }
}
// The hook itself has 20 seconds (claude-code.ts), so a restart is waited out only within that.
const ask = (extra: object) => requestApiResponse('/session-communication/owed', { provider, provider_session_id: conversation, ...extra }, RETRY_POLICIES.ownerRestartInHook);

try {
  if (hook.stop_hook_active) {
    const response = await ask({ remind: true });
    closeRunBrowsers(response.ok ? response.result?.source?.run_id ?? null : null);
    process.exit(0);
  }
  const response = await ask({});
  const owed: { request_id: string; requester: string; requested_effect: string }[] = response.ok ? response.result?.owed ?? [] : [];
  const source: { input_id: string; run_id: string } | null = response.ok ? response.result?.source ?? null : null;
  if (owed.length && source) {
    const tool = join(homedir(), '.local', 'bin', 'router-actions.sh');
    const lines = owed.map(request => `- request ${request.request_id} from ${request.requester}: ${tool} sessions reply ${request.request_id} --source-input '${source.input_id}' --source-run '${source.run_id}' --action-id 'final-${request.request_id.slice(0, 8)}'${request.requested_effect === 'work' ? ' --work-disposition completed|failed|needs_decision' : ''} --summary '<one line saying what your answer is>' -- '<your result>'`);
    await Bun.write(Bun.stdout, JSON.stringify({ decision: 'block', reason: [
      `You are ending your turn while you still owe a final reply to ${owed.length === 1 ? 'this request' : 'these requests'}. Your turn's text is never read as a reply. Send it now:`,
      ...lines,
      'If you are not finished and are waiting on something, send --partial instead saying exactly what; unless it is a request you sent, the requester will be told this request stalled.',
    ].join('\n') }) + '\n');
    // Only after the reminder is written: these exact requests were shown to the agent in this run.
    await ask({ offer: owed.map(request => request.request_id) });
  } else {
    closeRunBrowsers(source?.run_id ?? null);
  }
} catch {
  // The owner may be restarting. Codex's own conversation identity is still enough to close
  // this turn's browser; Claude has no independent identity here, so leave its process untouched.
  if (provider === 'codex') closeRunBrowsers(null);
  /* let the turn end; a stranded request is still reported stalled */
}
process.exit(0);
