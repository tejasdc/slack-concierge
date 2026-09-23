#!/usr/bin/env bun
/**
 * An agent's own entrance to every delivery path, so it can test the real pipeline end to end
 * without borrowing one of Tejas's doors. The request goes through the same public route, device
 * route or local door his captures use, carrying the agent's accepted input and run; Concierge then
 * records it as that agent, shows it in the Inbox under the agent's name and starts no Inbox turn.
 * Before this, the only way to test a path was one of his doors, so every test showed as him
 * (2026-09-23: "Agents get their own test entrance, labelled as them").
 *
 * Usage: router-actions.sh test-capture --path <path> --source-input <id> --source-run <id>
 *          [--reply-to <concierge:N>] -- <text>
 * Paths: send-to-inbox, bug-report, pebble (the capture drop-off); iphone-share, action-button,
 * watch, mac (thnkr.ing's device route, with the agent test device key); notification-reply
 * (thnkr.ing, into --reply-to); monologue (Concierge's local door).
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';

const DROP_OFF = process.env.CONCIERGE_CAPTURE_URL ?? 'https://capture.tejas.nyc';
const THNKRING = process.env.THINKERING_ORIGIN_URL ?? 'https://thnkr.ing';
const TEST_KEY_FILE = process.env.THINKERING_AGENT_TEST_KEY_FILE ?? '/root/.local/state/thinkering/agent-test-device.key';
const SOCKET = `${process.env.CONCIERGE_STATE_DIR ?? '/root/.local/state/concierge'}/requests.sock`;
const DEVICE_APPS: Record<string, string> = { 'iphone-share': 'thnkring-share', 'action-button': 'thnkring-action', watch: 'thnkring-watch', mac: 'thnkring-mac' };

const fail = (message: string): never => { console.error(JSON.stringify({ ok: false, error: message })); process.exit(2); };
const args = process.argv.slice(2), separator = args.indexOf('--');
const text = separator >= 0 ? args.slice(separator + 1).join(' ').trim() : '';
const flags = new Map<string, string>();
for (let i = 0; i < (separator >= 0 ? separator : args.length); i += 2) {
  if (!args[i]?.startsWith('--') || !args[i + 1]) fail(`Unexpected argument: ${args[i]}`);
  flags.set(args[i]!, args[i + 1]!);
}
const path = flags.get('--path') ?? fail('--path is required.');
const inputId = flags.get('--source-input') ?? fail('--source-input is required: your own accepted input.');
const runId = flags.get('--source-run') ?? fail('--source-run is required: your own run.');
if (!text) fail('Give the test text after --.');
const agentHeader = { 'x-concierge-agent-source': `${inputId} ${runId}` };
const key = (file: string) => readFileSync(file, 'utf8').trim();

async function send(url: string, init: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  const body = await response.text();
  console.log(JSON.stringify({ ok: response.ok, path, status: response.status, body: body.slice(0, 2000) }));
  process.exit(response.ok ? 0 : 1);
}

if (path === 'send-to-inbox' || path === 'bug-report') {
  const eventId = 'thinkering-' + createHash('sha256').update(`agent-test:${randomUUID()}`).digest('hex');
  const body = path === 'bug-report'
    ? { event_id: eventId, kind: 'bug_report', text: `Thinkering bug report\n\nDescription:\n${text}` }
    : { event_id: eventId, text };
  await send(`${DROP_OFF}/thinkering`, { method: 'POST', body: JSON.stringify(body),
    headers: { ...agentHeader, 'content-type': 'application/json', authorization: `Bearer ${key('/etc/concierge/thinkering.token')}` } });
} else if (path === 'pebble') {
  const form = new FormData();
  form.set('transcription', text); form.set('recordedAt', String(Date.now())); form.set('client', 'agent-test');
  await send(`${DROP_OFF}/pebble`, { method: 'POST', body: form, headers: { ...agentHeader, authorization: `Bearer ${key('/etc/concierge/pebble-index.token')}` } });
} else if (DEVICE_APPS[path]) {
  const replyTo = flags.get('--reply-to');
  const body = { formatVersion: 1, captureId: randomUUID(), capturedAt: new Date().toISOString(),
    origin: { app: DEVICE_APPS[path], build: 'agent-test', sourceApp: null }, items: [{ kind: 'text', text }],
    ...(replyTo ? { replyTo: { sessionId: replyTo, reference: null } } : {}) };
  await send(`${THNKRING}/api/captures/share`, { method: 'POST', body: JSON.stringify(body),
    headers: { ...agentHeader, 'content-type': 'application/json', authorization: `Bearer ${key(TEST_KEY_FILE)}` } });
} else if (path === 'notification-reply') {
  const sessionId = flags.get('--reply-to') ?? fail('notification-reply needs --reply-to <concierge:N>, a session that notified recently.');
  await send(`${THNKRING}/api/notifications/reply`, { method: 'POST', body: JSON.stringify({ replyId: randomUUID(), sessionId, inputId: null, text }),
    headers: { ...agentHeader, 'content-type': 'application/json', authorization: `Bearer ${key(TEST_KEY_FILE)}` } });
} else if (path === 'monologue') {
  const body = JSON.stringify({ source: { kind: 'monologue', id: `agent-test-${randomUUID()}`, recordedAt: new Date().toISOString(), title: 'Agent test',
    metadata: { agentSource: { inputId, runId } } }, text, files: [] });
  const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const call = httpRequest({ socketPath: SOCKET, path: '/sessions/v1/inbox', method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
      let data = ''; response.on('data', chunk => data += chunk); response.on('end', () => resolve({ status: response.statusCode ?? 0, body: data }));
    });
    call.on('error', reject); call.end(body);
  });
  console.log(JSON.stringify({ ok: result.status < 300, path, status: result.status, body: result.body.slice(0, 2000) }));
  process.exit(result.status < 300 ? 0 : 1);
} else {
  fail('Choose a path: send-to-inbox, bug-report, pebble, iphone-share, action-button, watch, mac, notification-reply, monologue.');
}
