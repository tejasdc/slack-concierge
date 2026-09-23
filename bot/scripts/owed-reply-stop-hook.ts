/**
 * Claude Code Stop hook: when an agent tries to end its turn while it still owes a final reply to a
 * request it received, send it back with the exact command, inside the same turn.
 *
 * Claude Code runs Stop hooks when the agent finishes responding; `{"decision":"block","reason"}`
 * prevents the stop and gives Claude the reason, and `stop_hook_active` is true when Claude is
 * already continuing because of a Stop hook (https://code.claude.com/docs/en/hooks#stop). So this
 * sends the agent back once; when it stops again, `stop_hook_active` is the evidence that the
 * reminder reached it, and only then is the reminder recorded (so the owner stalls the request
 * rather than reminding again). If the first answer never reached Claude, nothing is recorded and
 * the owner's own reminder turn still follows. Any failure lets the agent stop: a hook must never
 * trap a turn. Background tasks keep a Concierge run open and wake it again, so they allow the
 * stop; a session cron does not (a timer does not outlive the run), so it does not.
 *
 * Concierge passes this hook to every native Claude run (claude-code.ts) with the run's identity
 * in CONCIERGE_SOURCE_INPUT_ID / CONCIERGE_SOURCE_RUN_ID.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { requestApiResponse } from './router-request-client';

const inputId = process.env.CONCIERGE_SOURCE_INPUT_ID;
const runId = process.env.CONCIERGE_SOURCE_RUN_ID;
let hook: any = {};
try { hook = JSON.parse((await Bun.stdin.text()) || '{}'); } catch { process.exit(0); }
if (!inputId || !runId || (Array.isArray(hook.background_tasks) && hook.background_tasks.length)) process.exit(0);

try {
  if (hook.stop_hook_active) {
    // Claude continued because of a Stop hook and is stopping again: the requests this run's hook
    // listed count as reminded (the owner matches them by run); anything else keeps its reminder.
    await requestApiResponse('/session-communication/owed', { source: { input_id: inputId, run_id: runId }, remind: true });
    process.exit(0);
  }
  const response = await requestApiResponse('/session-communication/owed', { source: { input_id: inputId, run_id: runId } });
  const owed: { request_id: string; requester: string; requested_effect: string }[] = response.ok ? response.result?.owed ?? [] : [];
  if (owed.length) {
    const tool = join(homedir(), '.local', 'bin', 'router-actions.sh');
    const lines = owed.map(request => `- request ${request.request_id} from ${request.requester}: ${tool} sessions reply ${request.request_id} --source-input '${inputId}' --source-run '${runId}' --action-id 'final-${request.request_id.slice(0, 8)}'${request.requested_effect === 'work' ? ' --work-disposition completed|failed|needs_decision' : ''} -- '<your result>'`);
    await Bun.write(Bun.stdout, JSON.stringify({ decision: 'block', reason: [
      `You are ending your turn while you still owe a final reply to ${owed.length === 1 ? 'this request' : 'these requests'}. Your turn's text is never read as a reply. Send it now:`,
      ...lines,
      'If you are not finished and are waiting on something, send --partial instead saying exactly what; unless it is a request you sent, the requester will be told this request stalled.',
    ].join('\n') }) + '\n');
    // Only after the reminder is written: these exact requests were shown to the agent in this run.
    await requestApiResponse('/session-communication/owed', { source: { input_id: inputId, run_id: runId }, offer: owed.map(request => request.request_id) });
  }
} catch { /* let the turn end; the owner's reminder and stalled notice still apply */ }
process.exit(0);
