import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'concierge-codex-successor-run-'));
process.env.CONCIERGE_STATE_DIR = scratch;
const { runCodexTurn } = await import('../src/codex');
const listeners = new Set<(event: any) => void>();
const calls: Array<{ method: string; params: any }> = [];
let consumed = false;
const plan: any = { operationId: 'operation', model: 'gpt-6-astra', provider: 'openai', cwd: scratch,
  runtimeWorkspaceRoots: [scratch], environmentId: 'local', config: {}, approvalPolicy: 'never',
  sandbox: 'danger-full-access', custodyCommitted: true, predecessorExcluded: true };
const client: any = {
  async connect() { return 1; },
  async request(method: string, params: any) {
    calls.push({ method, params });
    if (method === 'turn/start') {
      assert.equal(consumed, true, 'durable allowance is consumed before native send');
      queueMicrotask(() => {
        for (const listener of listeners) listener({ method: 'turn/completed', params: { threadId: params.threadId,
          turn: { id: 'turn-1', status: 'completed', error: null, items: [
            { type: 'userMessage', clientId: params.clientUserMessageId },
            { type: 'agentMessage', id: 'answer-1', text: 'useful result' },
          ] } } });
      });
      return { turn: { id: 'turn-1' } };
    }
    throw new Error(`unexpected native call ${method}`);
  },
  async notify() {},
  onNotification(listener: (event: any) => void) { listeners.add(listener); return () => listeners.delete(listener); },
  onDisconnect() { return () => true; }, waitForDisconnect() { return new Promise<void>(() => {}); },
};
try {
  const result = await runCodexTurn({ prompt: 'exact retained reminder', cwd: scratch, additionalDirs: [],
    sessionUUID: 'thread-committed', reasoning_effort: 'medium',
    clientUserMessageId: 'slack-concierge:canonical-input:successor-attempt', appServerClient: client,
    custodySuccessor: { plan, construction: { operationId: 'operation', threadId: 'thread-committed',
      model: 'gpt-6-astra', provider: 'openai', reasoningEffort: 'medium', cwd: scratch,
      runtimeWorkspaceRoots: [scratch], environmentId: 'local', response: {} },
      beforeAdmission: async () => { consumed = true; } } } as any);
  assert.equal(result.sessionUUID, 'thread-committed');
  assert.equal(result.text, 'useful result');
  assert.equal(calls.length, 1, JSON.stringify(calls.map(c=>c.method)));
  assert.equal(calls[0]?.method, 'turn/start');
  assert.equal(calls[0]?.params.input[0]?.text, 'exact retained reminder');
  assert.equal(calls[0]?.params.effort, 'medium');
  assert.deepEqual(calls[0]?.params.environments, [{ environmentId: 'local', cwd: scratch,
    runtimeWorkspaceRoots: [scratch] }]);
  assert.equal(calls.some(call => call.method === 'thread/start' || call.method === 'thread/resume'), false);
  console.log('Codex successor runner fixture passed: committed thread, one exact admission, pre-send consumption and useful result');

  listeners.clear();
  const refusedCalls: string[] = [];
  const refusingClient = { ...client, async request(method: string, params: any) {
    refusedCalls.push(method);
    if (method === 'turn/start') throw new Error('should not send');
    return client.request(method, params);
  } };
  let callbackCount = 0;
  const refused = await runCodexTurn({ prompt: 'exact retained reminder', cwd: scratch, additionalDirs: [],
    sessionUUID: 'thread-committed', clientUserMessageId: 'same-canonical-input', appServerClient: refusingClient as any,
    custodySuccessor: { plan, construction: { operationId: 'operation', threadId: 'thread-committed',
      model: 'gpt-6-astra', provider: 'openai', reasoningEffort: 'medium', cwd: scratch,
      runtimeWorkspaceRoots: [scratch], environmentId: 'local', response: {} },
      beforeAdmission: async () => { callbackCount++; throw new Error('custody changed'); } } } as any)
    .then(()=>null,error=>error);
  assert.ok(refused, 'failed durable consumption refuses the dispatch');
  assert.equal(callbackCount, 1, 'attempt callback is not retried');
  assert.deepEqual(refusedCalls, [], 'native turn/start is not called after a refusal');
  console.log('Codex successor runner refusal fixture passed: callback refusal is never resent');

  const adoptedCalls: string[] = [];
  const adoptedClient = { ...client, async request(method: string, params: any) {
    adoptedCalls.push(method);
    if (method === 'thread/turns/list') return { data: [{ id: 'turn-existing', status: 'completed', items: [
      { type: 'userMessage', clientId: 'same-canonical-input' },
    ] }], nextCursor: null };
    if (method === 'thread/items/list') return { data: [
      { turnId: 'turn-existing', item: { type: 'userMessage', clientId: 'same-canonical-input' } },
      { turnId: 'turn-existing', item: { type: 'agentMessage', id: 'answer-existing', text: 'already completed useful work' } },
    ], nextCursor: null };
    throw new Error(`unexpected adoption call ${method}`);
  } };
  const adopted = await runCodexTurn({ prompt: 'exact retained reminder', cwd: scratch, additionalDirs: [],
    sessionUUID: 'thread-committed', clientUserMessageId: 'same-canonical-input', appServerClient: adoptedClient as any,
    adoptTurn: { threadId: 'thread-committed', turnId: 'turn-existing' },
    custodySuccessor: { plan, construction: { operationId: 'operation', threadId: 'thread-committed',
      model: 'gpt-6-astra', provider: 'openai', reasoningEffort: 'medium', cwd: scratch,
      runtimeWorkspaceRoots: [scratch], environmentId: 'local', response: {} },
      beforeAdmission: async () => { throw new Error('adoption must not consume/send again'); } } } as any);
  assert.equal(adopted.text, 'already completed useful work');
  assert.equal(adoptedCalls.includes('thread/resume'), false);
  assert.equal(adoptedCalls.includes('turn/start'), false);
  assert.deepEqual(adoptedCalls, ['thread/turns/list', 'thread/items/list']);
  console.log('Codex successor adoption fixture passed: protocol-shaped history, no resume or resend');

  let stop!: () => Promise<void>;
  let historyReads = 0;
  const stopCalls: string[] = [];
  const runningClient = { ...client, async request(method: string, params: any) {
    stopCalls.push(method);
    if (method === 'thread/turns/list') {
      historyReads++;
      return { data: [{ id: 'turn-running', status: historyReads < 3 ? 'inProgress' : 'interrupted', items: [
        { type: 'userMessage', clientId: 'stop-canonical-input' },
      ] }], nextCursor: null };
    }
    if (method === 'thread/items/list') return { data: [
      { turnId: 'turn-running', item: { type: 'userMessage', clientId: 'stop-canonical-input' } },
    ], nextCursor: null };
    if (method === 'turn/interrupt') return {};
    throw new Error(`unexpected Stop adoption call ${method}`);
  } };
  const stoppedRun = runCodexTurn({ prompt: 'exact retained reminder', cwd: scratch, additionalDirs: [],
    sessionUUID: 'thread-committed', clientUserMessageId: 'stop-canonical-input', appServerClient: runningClient as any,
    adoptTurn: { threadId: 'thread-committed', turnId: 'turn-running' },
    onCancellationReady: cancel => { stop = cancel; },
    custodySuccessor: { plan, construction: { operationId: 'operation', threadId: 'thread-committed',
      model: 'gpt-6-astra', provider: 'openai', reasoningEffort: 'medium', cwd: scratch,
      runtimeWorkspaceRoots: [scratch], environmentId: 'local', response: {} },
      beforeAdmission: async () => { throw new Error('adoption Stop must not resend'); } } } as any)
    .then(()=>null,error=>error);
  for (let attempt = 0; attempt < 50 && !stop; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(typeof stop, 'function', 'adopted active turn exposes its Stop control');
  await stop();
  const stopResult = await stoppedRun;
  assert.ok(stopResult, 'the interrupted turn remains a terminal result');
  assert.equal(stopCalls.includes('thread/resume'), false);
  assert.equal(stopCalls.includes('turn/start'), false);
  assert.equal(stopCalls.includes('turn/interrupt'), true);
  console.log('Codex successor Stop fixture passed: adopted turn interrupted by exact identity without resume/resend');

  let naturalPoll = 0;
  const naturalCalls: string[] = [];
  const naturalClient = { ...client, async request(method: string, params: any) {
    naturalCalls.push(method);
    if (method === 'thread/turns/list') {
      naturalPoll++;
      return { data: [{ id: 'turn-natural', status: naturalPoll < 3 ? 'inProgress' : 'completed', items: [
        { type: 'userMessage', clientId: 'natural-canonical-input' },
      ] }], nextCursor: null };
    }
    if (method === 'thread/items/list') return { data: [
      { turnId: 'turn-natural', item: { type: 'userMessage', clientId: 'natural-canonical-input' } },
      { turnId: 'turn-natural', item: { type: 'agentMessage', id: 'natural-answer', text: 'completed after reconnect' } },
    ], nextCursor: null };
    throw new Error(`unexpected natural completion call ${method}`);
  } };
  let liveNotified = false;
  const natural = await runCodexTurn({ prompt: 'exact retained reminder', cwd: scratch, additionalDirs: [],
    sessionUUID: 'thread-committed', clientUserMessageId: 'natural-canonical-input', appServerClient: naturalClient as any,
    adoptTurn: { threadId: 'thread-committed', turnId: 'turn-natural' },
    onAdoptedLive: () => { liveNotified = true; },
    custodySuccessor: { plan, construction: { operationId: 'operation', threadId: 'thread-committed',
      model: 'gpt-6-astra', provider: 'openai', reasoningEffort: 'medium', cwd: scratch,
      runtimeWorkspaceRoots: [scratch], environmentId: 'local', response: {} },
      beforeAdmission: async () => { throw new Error('natural completion must not resend'); } } } as any);
  assert.equal(liveNotified, true);
  assert.equal(natural.text, 'completed after reconnect');
  assert.ok(naturalPoll >= 3, 'active successor is polled through natural terminal completion');
  assert.equal(naturalCalls.includes('thread/resume'), false);
  assert.equal(naturalCalls.includes('turn/start'), false);
  console.log('Codex successor natural completion fixture passed: active turn polled to useful terminal result');

} finally { rmSync(scratch, { recursive: true, force: true }); }
