import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SessionCommunicationSandbox, type CommunicationRequestObservation } from './support/session-communication';

const provider = join(import.meta.dir, 'support/session-communication-provider.sh');
const user = (text: string) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const interrupt = (id: string) => ({ type: 'control_request', request_id: id, request: { subtype: 'interrupt' } });

async function providerTranscript(inputs: unknown[]) {
  const child = Bun.spawn(['bash', provider, '--resume', '11111111-1111-4111-8111-111111111111'], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  for (const input of inputs) child.stdin.write(`${JSON.stringify(input)}\n`);
  child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(exitCode, stderr).toBe(0);
  return stdout.trim().split('\n').map(line => JSON.parse(line));
}

test('session provider fixture accepts multiple native steering inputs and only finishes after its exact finish control', async () => {
  const initial = user('SANDBOX_SESSION_COMM_TEST_ROOT [SESSION_HOLD]');
  const questionOne = user('Session request 11111111-aaaa-bbbb-cccc-111111111111 from concierge:1. SANDBOX_SESSION_COMM_TEST_ONE');
  const questionTwo = user('Session request 22222222-aaaa-bbbb-cccc-222222222222 from concierge:1. SANDBOX_SESSION_COMM_TEST_TWO');
  const finish = user('SANDBOX_SESSION_COMM_TEST_FINISH [SESSION_FINISH]');
  const output = await providerTranscript([initial, interrupt('steer-one'), questionOne, interrupt('steer-two'), questionTwo, interrupt('finish'), finish]);
  expect(output.filter(event => event.type === 'user')).toEqual([initial, questionOne, questionTwo, finish]);
  expect(output.filter(event => event.type === 'control_response').map(event => event.response.request_id)).toEqual(['steer-one', 'steer-two', 'finish']);
  expect(output.filter(event => event.type === 'result')).toHaveLength(1);
  expect(output.at(-1)).toMatchObject({ type: 'result', session_id: '11111111-1111-4111-8111-111111111111', is_error: false });
  expect(output.at(-1).result).toContain('SANDBOX_SESSION_COMM_TEST_ONE');
  expect(output.at(-1).result).toContain('SANDBOX_SESSION_COMM_TEST_TWO');
  expect(output.at(-1).result).toContain('SANDBOX_SESSION_COMM_TEST_FINISH');
});

test('a resumed return remains running until its own Slack finish control and retains exact correlation', async () => {
  const returned = user('Session final event 11111111-aaaa-bbbb-cccc-111111111111 for request 22222222-aaaa-bbbb-cccc-222222222222. SANDBOX_SESSION_COMM_TEST_RETURN');
  const unfinished = await providerTranscript([returned]);
  expect(unfinished.filter(event => event.type === 'result')).toEqual([]);
  const finished = await providerTranscript([returned, interrupt('finish-return'), user('SANDBOX_SESSION_COMM_TEST_RETURN_FINISH [SESSION_FINISH]')]);
  expect(finished.at(-1).result).toContain('Observed final event 11111111-aaaa-bbbb-cccc-111111111111 for request 22222222-aaaa-bbbb-cccc-222222222222');
  expect(finished.at(-1).result).toContain('SANDBOX_SESSION_COMM_TEST_RETURN_FINISH');
});

test('native stop ends the fixture without fabricating a provider final', async () => {
  const output = await providerTranscript([user('SANDBOX_SESSION_COMM_TEST_STOP'), interrupt('concierge_stop_test')]);
  expect(output.at(-1)).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'concierge_stop_test' } });
  expect(output.filter(event => event.type === 'result')).toEqual([]);
});

test('a controlled return can end the native turn without an echoed receipt', async () => {
  const initial = user('SANDBOX_SESSION_COMM_TEST_AMBIGUOUS [SESSION_HOLD]');
  const returned = user('Session final event 11111111-aaaa-bbbb-cccc-111111111111 for request 22222222-aaaa-bbbb-cccc-222222222222. [SESSION_RETURN_WITHOUT_ECHO]');
  const output = await providerTranscript([initial, interrupt('ambiguous-return'), returned]);
  expect(output.filter(event => event.type === 'user')).toEqual([initial]);
  expect(output.filter(event => event.type === 'control_response')).toHaveLength(1);
  expect(output.at(-1)).toMatchObject({ type: 'result', is_error: false, result: 'TL;DR: Native fixture ended without acknowledging the return input.' });
  expect(output.at(-1).result).not.toContain('11111111-aaaa-bbbb-cccc-111111111111');
});

test('output acceptance rejects a missing legacy timestamp when Slack has a confirmed delivery receipt', () => {
  const fixture = Object.create(SessionCommunicationSandbox.prototype) as SessionCommunicationSandbox;
  const agentText = 'TL;DR: exact retained output';
  const messageTs = '1789443528.417269';
  const messages = [{ chunk_index: 0, slack_ts: messageTs }, { chunk_index: 1, slack_ts: '1789443529.417269' }];
  Object.assign(fixture, { one: () => ({ agent_text: agentText, delivered_messages_json: JSON.stringify(messages), delivery_status: 'delivered' }) });
  const output = { turn_id: 3, channel_id: 'CCORE', root_ts: '1789443476.534949', message_ts: null as string | null,
    messages, delivery_status: 'delivered', sha256: createHash('sha256').update(agentText).digest('hex') };
  const request = () => ({ target_channel: output.channel_id, target_root_ts: output.root_ts,
    result_json: JSON.stringify({ output }) }) as CommunicationRequestObservation;
  expect(() => fixture.assertOutput(request(), 3)).toThrow('exact completed output reference');
  output.message_ts = messageTs;
  expect(fixture.assertOutput(request(), 3)).toEqual(output);
  output.message_ts = messages[1].slack_ts;
  expect(() => fixture.assertOutput(request(), 3)).toThrow('exact completed output reference');
});

test('session communication runner plan advertises its source, lifecycle, and restart boundaries without live execution', async () => {
  const child = Bun.spawn(['bun', join(import.meta.dir, 'runner.ts'), 'plan', 'session-communication', '--lane', 'lane-1', '--run-id', 'plan-session-communication'], {
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(exitCode, stderr).toBe(0);
  const plan = JSON.parse(stdout);
  expect(plan).toMatchObject({ case_id: 'session-communication', lane_id: 'lane-1', executable: true, requires_apply: true });
  expect(plan.required_boundaries.join('\n')).toContain('session-communication-provider.sh');
  expect(plan.required_boundaries.join('\n')).toContain('controller reload');
  expect(plan.required_boundaries.join('\n')).toContain('no eligible idle deadline');
  expect(plan.required_boundaries.join('\n')).toContain('unresolved prerequisite waits outside FIFO');
  expect(plan.required_boundaries.join('\n')).toContain('native Slack Stop');
  expect(plan.required_boundaries.join('\n')).toContain('retained ambiguous return without blind replay');
});
