import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'codex-protected-observer-'));
process.env.CONCIERGE_STATE_DIR = scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR = join(scratch, 'capture');
const { db } = await import('../src/state');
const { createNativeSession, bindSessionProvider, retainSessionInput, enqueueSessionInput } = await import('../src/session-inputs');
const { CodexSessionObserver, bindCodexProviderSession } = await import('../src/codex-session-observer');
const { CodexRemoteObserver } = await import('../src/codex-remote-observer');

const predecessor = createNativeSession('codex', { title: 'Predecessor', summary: 'Retain work', origin: 'native', cwd: scratch,
  model: 'gpt-6-astra', reasoningEffort: 'medium' });
const successor = createNativeSession('codex', { title: 'Protected successor', summary: 'Observe work', origin: 'native', cwd: scratch,
  model: 'gpt-6-astra', reasoningEffort: 'medium' });
bindSessionProvider(successor.id, 'codex', 'protected-native-thread');
bindSessionProvider(predecessor.id, 'codex', 'accepted-predecessor-thread');
const original = retainSessionInput({ id: 'original-input', sessionId: predecessor.id, scope: 'fixture', actionId: 'original',
  kind: 'input', origin: 'human', payload: { text: 'original' } }).input;
enqueueSessionInput(original.id);
const placement = retainSessionInput({ id: 'placement-input', sessionId: successor.id, scope: 'fixture', actionId: 'placement',
  kind: 'input', origin: 'service', payload: { text: 'placement' } }).input;
enqueueSessionInput(placement.id);
const placementTurnId = Number(db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(placement.id)?.turn_id);
const handoffId = 'fixture-handoff';
db.query(`INSERT INTO session_handoffs(id,predecessor_session_id,successor_session_id,state,action_id,caller_session_id,
  reason,requesting_input_id,requesting_run_id,inventory_json,inventory_digest)
  VALUES(?,?,?,'accepted','fixture',?,'fixture',?,'fixture-run','{}','fixture-digest')`)
  .run(handoffId, predecessor.id, successor.id, predecessor.id, original.id);
db.query(`INSERT INTO codex_custody_successors(canonical_input_id,predecessor_session_id,successor_session_id,handoff_id,
  placement_input_id,placement_turn_id,request_id,source_input_id,source_run_id,state,plan_json,snapshot_json,native_thread_id,native_turn_id)
  VALUES(?,?,?,?,?,?,? ,? ,? ,'admitted','{}','{}','protected-native-thread','protected-native-turn')`)
  .run(original.id, predecessor.id, successor.id, handoffId, placement.id, placementTurnId,
    'fixture-request', original.id, 'fixture-run');

const calls: string[] = [];
const listeners = new Set<(event: any) => void>();
let threadReads = 0;
let connectionGeneration = 0;
let connected = false;
let completeRun = false;
let disconnectResolver: (() => void) | null = null;
const appServer: any = {
  async connect() { if (!connected) { connected = true; connectionGeneration++; } return connectionGeneration; },
  async waitForDisconnect(generation: number) {
    if (!connected || generation !== connectionGeneration) return;
    await new Promise<void>(resolve => { disconnectResolver = resolve; });
  },
  disconnect() { connected = false; disconnectResolver?.(); disconnectResolver = null; },
  onNotification(listener: (event: any) => void) { listeners.add(listener); return () => listeners.delete(listener); },
  async request(method: string, params: any) {
    calls.push(method);
    if (method === 'thread/loaded/list') return { data: ['protected-native-thread', 'accepted-predecessor-thread'], nextCursor: null };
    if (method === 'thread/read') {
      threadReads++;
      return { thread: { id: params.threadId, status: { type: completeRun ? 'idle' : 'active' } } };
    }
    if (method === 'thread/turns/list') return params.cursor === null
      ? { data: [], nextCursor: 'turn-page-2' }
      : { data: [{ id: 'protected-native-turn', status: 'completed' }], nextCursor: null };
    if (method === 'thread/items/list' && params.limit === 1) return { data: [
      { turnId: 'protected-native-turn', item: { type: 'agentMessage', id: 'answer', text: 'protected useful result' } },
    ], nextCursor: null };
    if (method === 'thread/items/list') return params.cursor === null
      ? { data: [{ turnId: 'protected-native-turn', item: { type: 'userMessage', id: 'input',
        content: [{ type: 'text', text: 'placement' }] } }], nextCursor: 'item-page-2' }
      : { data: [{ turnId: 'protected-native-turn', item: { type: 'agentMessage', id: 'answer', text: 'protected useful result' } }], nextCursor: null };
    if (method === 'thread/resume' || method === 'thread/start' || method === 'turn/start'
      || method === 'turn/steer' || method === 'thread/unsubscribe') {
      throw new Error(`protected observer must not call ${method}`);
    }
    throw new Error(`unexpected App Server call ${method}`);
  },
};

const observer = new CodexSessionObserver({ appServer });
let secondaryObserverCalls = 0;
observer.start();
const reconnectDeadline = Date.now() + 3_000;
while (Date.now() < reconnectDeadline && !calls.includes('thread/loaded/list')) {
  await new Promise(resolve => setTimeout(resolve, 20));
}
await bindCodexProviderSession(observer, 'protected-native-thread', {
  async providerSessionBound() { secondaryObserverCalls++; },
});
await bindCodexProviderSession(observer, 'accepted-predecessor-thread', {
  async providerSessionBound() { secondaryObserverCalls++; },
});
assert.equal(secondaryObserverCalls, 0, 'production composition bypasses secondary observer for protected custody');
const firstPagesDeadline = Date.now() + 3_000;
while (Date.now() < firstPagesDeadline && calls.filter(method => method === 'thread/items/list').length < 2) {
  await new Promise(resolve => setTimeout(resolve, 20));
}
appServer.disconnect();
const secondConnectDeadline = Date.now() + 3_000;
while (Date.now() < secondConnectDeadline && calls.filter(method => method === 'thread/loaded/list').length < 2) {
  await new Promise(resolve => setTimeout(resolve, 20));
}
completeRun = true;
const terminalDeadline = Date.now() + 3_000;
while (Date.now() < terminalDeadline && calls.filter(method => method === 'thread/read').length < 4) {
  await new Promise(resolve => setTimeout(resolve, 20));
}
await observer.stop();
assert.ok(threadReads >= 4, 'the observer polled the exact protected thread until it became idle');
assert.ok(calls.filter(method => method === 'thread/loaded/list').length >= 2, 'reconnect rescans bound threads through the production observer loop');
assert.ok(calls.includes('thread/turns/list'), 'protected turn was reconciled from turn pages');
assert.ok(calls.includes('thread/items/list'), 'protected result was read from paginated item entries');
assert.ok(calls.filter(method => method === 'thread/items/list').length >= 2, 'the observer followed item-page continuation');
assert.equal(calls.some(method => ['thread/resume', 'thread/start', 'turn/start', 'turn/steer', 'thread/unsubscribe'].includes(method)), false);
const observed = db.query(`SELECT payload_json FROM session_owner_events WHERE session_id=? AND kind='message'`)
  .all(successor.id) as { payload_json: string }[];
assert.ok(observed.some(row => JSON.stringify(JSON.parse(row.payload_json)).includes('protected useful result')),
  'read-only page observation preserves the useful provider result');

const ordinary = createNativeSession('codex', { title: 'Ordinary remote session', summary: 'Keep ordinary behavior', origin: 'native', cwd: scratch });
bindSessionProvider(ordinary.id, 'codex', 'ordinary-remote-thread');
let remoteGeneration = 0;
let remoteConnected = false;
let remoteDisconnectResolver: (() => void) | null = null;
const remoteResumes: string[] = [];
const remoteAppServer: any = {
  async connect() { if (!remoteConnected) { remoteConnected = true; remoteGeneration++; } return remoteGeneration; },
  async waitForDisconnect(generation: number) {
    if (!remoteConnected || generation !== remoteGeneration) return;
    await new Promise<void>(resolve => { remoteDisconnectResolver = resolve; });
  },
  disconnect() { remoteConnected = false; remoteDisconnectResolver?.(); remoteDisconnectResolver = null; },
  onNotification() { return () => {}; },
  async request(method: string, params: any) {
    assert.equal(method, 'thread/resume', 'remote observer only issues its ordinary resume request in this fixture');
    remoteResumes.push(params.threadId);
    return {};
  },
};
const mappings = [
  { session_id: predecessor.id, provider_thread_uuid: 'accepted-predecessor-thread', slack_channel_id: 'C1', slack_channel_name: 'ordinary', slack_thread_ts: 'one' },
  { session_id: successor.id, provider_thread_uuid: 'protected-native-thread', slack_channel_id: 'C1', slack_channel_name: 'ordinary', slack_thread_ts: 'two' },
  { session_id: ordinary.id, provider_thread_uuid: 'ordinary-remote-thread', slack_channel_id: 'C1', slack_channel_name: 'ordinary', slack_thread_ts: 'three' },
];
const remoteObserver = new CodexRemoteObserver({}, undefined, { appServer: remoteAppServer, listMappings: () => mappings as any });
await remoteObserver.providerSessionBound('accepted-predecessor-thread');
await remoteObserver.providerSessionBound('protected-native-thread');
assert.deepEqual(remoteResumes, [], 'direct remote binding refuses both accepted predecessor and protected successor');
await remoteObserver.providerSessionBound('ordinary-remote-thread');
assert.deepEqual(remoteResumes, ['ordinary-remote-thread'], 'ordinary direct mapping keeps its resume behavior');
remoteObserver.start();
const initialRemoteDeadline = Date.now() + 3_000;
while (Date.now() < initialRemoteDeadline && remoteResumes.length < 2) await new Promise(resolve => setTimeout(resolve, 20));
remoteAppServer.disconnect();
const remoteReconnectDeadline = Date.now() + 3_000;
while (Date.now() < remoteReconnectDeadline && remoteResumes.length < 3) await new Promise(resolve => setTimeout(resolve, 20));
await remoteObserver.stop();
assert.ok(remoteResumes.length >= 3, 'ordinary remote mapping is still resumed on reconnect');
assert.equal(remoteResumes.some(threadId => threadId !== 'ordinary-remote-thread'), false,
  'remote reconnect excludes accepted predecessor and protected successor mappings');
console.log('Codex protected observer fixture passed: production callbacks and reconnect scans observe protected pages without resume, while ordinary remote mappings retain resume behavior');
