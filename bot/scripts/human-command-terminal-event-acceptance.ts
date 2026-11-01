import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = await mkdtemp(join(tmpdir(), 'human-command-terminal-event-'));
Object.assign(process.env, { CONCIERGE_STATE_DIR: root, CONCIERGE_CAPTURE_STATE_DIR: join(root, 'capture'),
  CONCIERGE_TEST_MODE: '1', CONCIERGE_TEST_AUTHORIZATION: 'native-attribution-5eaa0768' });
const [{ createCaptureQueueRequestHandler }, { HumanCommandWorker }, { publishHumanCommandTerminalEvent },
  { createNativeSession }, { db }, { captureDb }] = await Promise.all([
  import('../src/capture-queue-api'), import('../src/human-command-worker'), import('../src/human-command-events'),
  import('../src/session-inputs'), import('../src/state'), import('../src/capture-state'),
]);

const inbox = createNativeSession('codex', { title: 'Terminal event acceptance Inbox', summary: undefined, inbox: true });
const token = 'terminal-event-acceptance-token';
const handler = createCaptureQueueRequestHandler({ host: '127.0.0.1', port: 0, token });
const request = (path: string, body?: unknown) => handler(new Request('http://fixture' + path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body),
}));
const command = (actionId: string) => ({ version: 1, clientId: 'fixture-browser-1', sessionId: 'topic:fixture',
  sequence: actionId === 'fixture-read' ? 1 : 2, actionId, door: 'fixture', method: 'POST',
  path: '/sessions/v1/inbox/topics/topic%3Afixture/actions',
  body: { clientActionId: actionId, action: { kind: 'read', sequence: 1 } },
});
const eventRow = (actionId: string) => db.query("SELECT event_id,session_id,payload_json FROM session_owner_events WHERE event_id=?")
  .get(`human-command:${actionId}:terminal`) as { event_id: string; session_id: number; payload_json: string } | null;
const outboxRow = (actionId: string) => captureDb.query('SELECT published_at FROM human_command_terminal_events WHERE action_id=?')
  .get(actionId) as { published_at: string | null } | null;
const waitFor = async (predicate: () => boolean) => { const until = Date.now() + 5_000;
  while (Date.now() < until) { if (predicate()) return; await Bun.sleep(20); }
  throw new Error('Terminal command event did not reach the expected state.');
};
let worker: InstanceType<typeof HumanCommandWorker> | null = null;
try {
  assert.equal((await request('/commands', command('fixture-read'))).status, 202);
  let loseAck = true;
  const fetchQueue = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (loseAck && String(input).endsWith('/terminal-command-events/published')) {
      loseAck = false;
      return Promise.resolve(new Response(null, { status: 503 }));
    }
    return handler(new Request(input, init));
  }) as typeof fetch;
  const options = { queueUrl: 'http://fixture', queueToken: token, fetch: fetchQueue,
    prepare: async () => ({ status: 200, value: { primaryBody: { action: 'read' }, fallbackBody: null } }),
    deliver: async () => ({ status: 200, value: { read: true, revision: 7 } }),
    publishTerminal: publishHumanCommandTerminalEvent };
  worker = new HumanCommandWorker(options);
  worker.start();
  await waitFor(() => eventRow('fixture-read') !== null);
  await worker.stop();
  worker = null;
  assert.equal(outboxRow('fixture-read')?.published_at, null, 'lost acknowledgement leaves the outbox pending');
  const first = eventRow('fixture-read')!;
  assert.equal(first.session_id, inbox.id);
  assert.deepEqual(JSON.parse(first.payload_json).command.ownerResponse, { read: true, revision: 7 });
  assert.equal(JSON.parse(first.payload_json).command.status, 'delivered');
  assert.equal(JSON.parse(first.payload_json).command.commandIdentity.actionId, 'fixture-read');

  // The command scope is immutable even if the Inbox stream anchor changes before replay.
  createNativeSession('codex', { title: 'Later fixture Inbox', summary: undefined, inbox: true });

  const refused = { ...command('fixture-refused'), path: '/sessions/v1/pre-custody-refusal',
    body: { clientActionId: 'fixture-refused', originalPath: '/sessions/v1/inbox/topics/topic%3Afixture/actions' },
    preCustodyStatus: 413 };
  assert.equal((await request('/commands/refuse-before-custody', refused)).status, 202);
  worker = new HumanCommandWorker({ ...options, fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
    handler(new Request(input, init))) as typeof fetch });
  worker.start();
  await waitFor(() => outboxRow('fixture-read')?.published_at !== null && outboxRow('fixture-refused')?.published_at !== null);
  assert.equal((db.query("SELECT count(*) AS count FROM session_owner_events WHERE event_id='human-command:fixture-read:terminal'")
    .get() as { count: number }).count, 1, 'replay uses the same owner event');
  assert.equal(eventRow('fixture-read')!.session_id, inbox.id);
  assert.equal(JSON.parse(eventRow('fixture-refused')!.payload_json).command.status, 'refused');
  console.log(JSON.stringify({ check: 'human-command-terminal-event', status: 'passed',
    durableBeforeAck: true, replayedOnce: true, ingressRefusalPublished: true }));
} finally { await worker?.stop(); await rm(root, { recursive: true, force: true }); }
