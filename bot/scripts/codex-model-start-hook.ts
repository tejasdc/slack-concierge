/** Machine-managed prompt guard: the owner has bound Concierge threads before their first prompt. */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { escalationReason } from '../src/model-escalation';
import {requestApiResponse} from './router-request-client';
import {RETRY_POLICIES} from '../src/retry-policies';

type Start = {model?: unknown;session_id?: unknown;turn_id?:unknown;agent_id?:unknown};
let start: Start = {};
try { start = JSON.parse((await Bun.stdin.text()) || '{}'); } catch { /* A malformed hook input cannot prove an Astra start. */ }

const state = process.env.CONCIERGE_STATE_DIR || join(homedir(), '.local/state/concierge');
const model=typeof start.model==='string'?start.model:'';
const outside=process.env.CONCIERGE_OUTSIDE_RUN==='1';
if(model!=='gpt-6-astra'&&!outside)process.exit(0);
const providerSession = typeof start.session_id === 'string' ? start.session_id : '';
const ownerTurnId=Number(process.env.CONCIERGE_TURN_ID??'');
const owner=providerSession?await requestApiResponse('/session-communication/model-start-gate',
  {providerSessionId:providerSession,model,
    ...(typeof start.turn_id==='string'?{providerTurnId:start.turn_id}:{}),
    ...(typeof start.agent_id==='string'?{providerAgentId:start.agent_id}:{}),
    ...(Number.isSafeInteger(ownerTurnId)&&ownerTurnId>0?{ownerTurnId}:{}),
    ...(process.env.CONCIERGE_SOURCE_RUN_ID?{sourceRunId:process.env.CONCIERGE_SOURCE_RUN_ID}:{})},
  RETRY_POLICIES.ownerRestartInHook):null;
if(owner?.ok&&owner.result?.known){
  if(!owner.result.allowed)deny(String(owner.result.message??'This Codex prompt needs its bound execution and model. Choose gpt-6.1-sol.'));
  process.exit(0);
}
if(outside&&model==='gpt-6-astra')deny('Concierge cannot confirm this outside Astra prompt. Choose gpt-6.1-sol or retry when its owner answers.');
if (start.model !== 'gpt-6-astra') process.exit(0);
const reason = process.env.CODEX_ESCALATION_REASON?.trim() || '';
// A direct process can set its own environment; only the owner can attest a human choice.
const refusal = escalationReason('gpt-6-astra', reason, false);
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
