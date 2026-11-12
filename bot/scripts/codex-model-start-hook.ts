/** Machine-managed prompt guard: the owner has bound Concierge threads before their first prompt. */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { escalationReason } from '../src/model-escalation';
import {requestApiResponse} from './router-request-client';
import {RETRY_POLICIES} from '../src/retry-policies';

type Start = {model?: unknown;session_id?: unknown};
let start: Start = {};
try { start = JSON.parse((await Bun.stdin.text()) || '{}'); } catch { /* A malformed hook input cannot prove an Astra start. */ }
if (start.model !== 'gpt-6-astra') process.exit(0);

const state = process.env.CONCIERGE_STATE_DIR || join(homedir(), '.local/state/concierge');
const providerSession = typeof start.session_id === 'string' ? start.session_id : '';
const owner=providerSession?await requestApiResponse('/session-communication/model-start-gate',
  {providerSessionId:providerSession,model:'gpt-6-astra'},RETRY_POLICIES.ownerRestartInHook):null;
if(owner?.ok&&owner.result?.known){
  if(!owner.result.allowed)deny(String(owner.result.message??'GPT-6 Astra needs an owner-recorded escalation reason. Choose gpt-6.1-sol.'));
  process.exit(0);
}
const directReason = process.env.CODEX_ESCALATION_REASON?.trim() || '';
const reason = directReason;
const humanChoice = /^Tejas explicitly (?:chose|requested) Astra\b/i.test(reason);
const refusal = escalationReason('gpt-6-astra', reason, humanChoice);
if (!refusal) {
  try {
    mkdirSync(state, {recursive: true, mode: 0o700});
    appendFileSync(join(state, 'model-escalations.jsonl'), `${JSON.stringify({
      at: new Date().toISOString(), model: 'gpt-6-astra', reason,
      source: 'codex-native-session-start', providerSessionId: providerSession || null,
      attemptId: process.env.CODEX_ESCALATION_ATTEMPT_ID || null,
    })}\n`, {mode: 0o600});
  } catch { deny('Astra escalation recording failed. Choose gpt-6.1-sol.'); }
}
if (refusal) deny(refusal.replace('--escalation-reason', 'CODEX_ESCALATION_REASON')
  .replace('Choose cc-opus or cx-sol for an ordinary start.', 'Choose gpt-6.1-sol for an ordinary start.')
  .replaceAll('cx-sol', 'gpt-6.1-sol'));

function deny(message: string): never {
  process.stdout.write(JSON.stringify({decision: 'block', reason: message}) + '\n');
  process.exit(0);
}
