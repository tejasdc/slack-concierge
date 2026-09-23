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
import { requestApiResponse } from './router-request-client';

const provider = process.argv[2];
let hook: any = {};
try { hook = JSON.parse((await Bun.stdin.text()) || '{}'); } catch { process.exit(0); }
const conversation = typeof hook.session_id === 'string' ? hook.session_id : null;
if (!provider || !conversation || (Array.isArray(hook.background_tasks) && hook.background_tasks.length)) process.exit(0);
const ask = (extra: object) => requestApiResponse('/session-communication/owed', { provider, provider_session_id: conversation, ...extra });

try {
  if (hook.stop_hook_active) {
    await ask({ remind: true });
    process.exit(0);
  }
  const response = await ask({});
  const owed: { request_id: string; requester: string; requested_effect: string }[] = response.ok ? response.result?.owed ?? [] : [];
  const source: { input_id: string; run_id: string } | null = response.ok ? response.result?.source ?? null : null;
  if (owed.length && source) {
    const tool = join(homedir(), '.local', 'bin', 'router-actions.sh');
    const lines = owed.map(request => `- request ${request.request_id} from ${request.requester}: ${tool} sessions reply ${request.request_id} --source-input '${source.input_id}' --source-run '${source.run_id}' --action-id 'final-${request.request_id.slice(0, 8)}'${request.requested_effect === 'work' ? ' --work-disposition completed|failed|needs_decision' : ''} -- '<your result>'`);
    await Bun.write(Bun.stdout, JSON.stringify({ decision: 'block', reason: [
      `You are ending your turn while you still owe a final reply to ${owed.length === 1 ? 'this request' : 'these requests'}. Your turn's text is never read as a reply. Send it now:`,
      ...lines,
      'If you are not finished and are waiting on something, send --partial instead saying exactly what; unless it is a request you sent, the requester will be told this request stalled.',
    ].join('\n') }) + '\n');
    // Only after the reminder is written: these exact requests were shown to the agent in this run.
    await ask({ offer: owed.map(request => request.request_id) });
  }
} catch { /* let the turn end; a stranded request is still reported stalled */ }
process.exit(0);
