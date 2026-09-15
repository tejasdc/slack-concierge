import { expect, test } from 'bun:test';
import { assertCorrelatedExchange, assertNativeLaneReceipt } from './support/unified-session';
import { assertConsultationAnswer, assertConsultationHistory } from './cases/unified-consultation.case';

const expected = { runId: 'owned-run', lane: 1, statePath: '/tmp/owned-run/state/state.db', sourceId: 'a'.repeat(40), previousGeneration: 1 };
const run = { run_id: expected.runId, lane: expected.lane, status: 'running', source: { source_id: expected.sourceId }, generation: 2,
  slack_enabled: false, paths: { state: '/tmp/owned-run/state', ready_file: '/tmp/owned-run/state/ready.json' },
  supervisor: { pid: 123, start_ticks: '1000', boot_id: 'exact-boot' }, candidate: { pid: 456, start_ticks: '2000' } };
const ready = { schema_version: 1, pid: 456, run_id: expected.runId, lane: 1, slack_enabled: false,
  owner_socket: '/tmp/owned-run/state/requests.sock', ready_at: '2026-09-15T12:00:00.000Z' };

test('native acceptance joins exact source, controller generation and non-Slack readiness', () => {
  expect(assertNativeLaneReceipt(run, ready, expected)).toMatchObject({ runId: expected.runId, generation: 2, candidate: run.candidate });
  expect(() => assertNativeLaneReceipt(run, ready, { ...expected, capabilitySocket: '/tmp/exact-peer/capabilities.sock' })).toThrow();
  expect(assertNativeLaneReceipt({ ...run, capability_socket: '/tmp/exact-peer/capabilities.sock' }, ready,
    { ...expected, capabilitySocket: '/tmp/exact-peer/capabilities.sock' }).capabilitySocket).toBe('/tmp/exact-peer/capabilities.sock');
});

test.each([
  { run: { ...run, generation: 1 }, ready },
  { run: { ...run, source: { source_id: 'other-source' } }, ready },
  { run: { ...run, run_id: 'other-run' }, ready },
  { run: { ...run, slack_enabled: true }, ready },
  { run, ready: { ...ready, pid: 999 } },
  { run, ready: { ...ready, owner_socket: '/root/.local/state/concierge/requests.sock' } },
  { run, ready: { ...ready, team_id: 'copied-slack-identity' } },
  { run, ready: { ...ready, slack_enabled: true } },
])('native acceptance refuses mismatched or copied readiness (%#)', value => {
  expect(() => assertNativeLaneReceipt(value.run, value.ready, expected)).toThrow();
});

const request = { request_id: 'question-one', source_session_id: 12, target_session_id: 34,
  source_input_id: 'source-input', target_input_id: 'target-input', routed_request_id: null, outcome: 'answered', status: 'settled' };
const replyEvents = [
  { event_id: 'partial-one', request_id: request.request_id, kind: 'progress', status: 'received',
    accepted_input_id: 'returned-partial-input', routed_request_id: null, payload_json: JSON.stringify({ text: 'Partial evidence' }) },
  { event_id: 'final-one', request_id: request.request_id, kind: 'final', status: 'received',
    accepted_input_id: 'returned-final-input', routed_request_id: null, payload_json: JSON.stringify({ text: 'Final evidence' }) },
];
const exchange = { sourceSession: 12, targetSession: 34, partial: 'Partial evidence', final: 'Final evidence' };

test('consultation answers must be substantive and cite the exact retained evidence', () => {
  const valid = 'The later correction preserves draft isolation. [retained-event-id, jsonl:42]';
  expect(() => assertConsultationAnswer(valid, ['draft isolation'], ['retained-event-id'])).not.toThrow();
  expect(() => assertConsultationAnswer('Unavailable tools.', ['draft isolation'], ['retained-event-id'])).toThrow();
  expect(() => assertConsultationAnswer(valid, ['unsupported assertion'], ['retained-event-id'])).toThrow();
  expect(() => assertConsultationAnswer(valid, ['draft isolation'], ['another-branch-event'])).toThrow();
});

test('native exchange oracle requires partial and final acknowledged returns for one exact request', () => {
  expect(() => assertCorrelatedExchange(request, replyEvents, exchange)).not.toThrow();
});

test('consultation policy proof cannot use incomplete history or overlook tools', () => {
  const history = { messages: [{ role: 'assistant', tool: null }, { role: 'assistant', tool: null }], nextCursor: null };
  expect(() => assertConsultationHistory(history)).not.toThrow();
  expect(() => assertConsultationHistory({ ...history, coverage: { complete: false } })).toThrow();
  expect(() => assertConsultationHistory({ ...history, nextCursor: 'another-page' })).toThrow();
  expect(() => assertConsultationHistory({ ...history, messages: [] })).toThrow();
  expect(() => assertConsultationHistory({ ...history, messages: [...history.messages, { role: 'tool' }] })).toThrow();
  expect(() => assertConsultationHistory({ ...history, messages: [...history.messages, { role: 'assistant', tool: 'shell' }] })).toThrow();
});

test.each([
  { request: { ...request, target_session_id: 35 }, events: replyEvents },
  { request: { ...request, outcome: 'unanswered' }, events: replyEvents },
  { request, events: [replyEvents[1]] },
  { request, events: [...replyEvents, replyEvents[1]] },
  { request, events: replyEvents.map(event => ({ ...event, request_id: 'another-question' })) },
  { request, events: replyEvents.map(event => ({ ...event, status: 'admitted' })) },
  { request, events: replyEvents.map(event => ({ ...event, routed_request_id: 'slack-bridge' })) },
  { request, events: replyEvents.map(event => ({ ...event, accepted_input_id: null })) },
])('native exchange oracle refuses false continuity or incomplete delivery (%#)', value => {
  expect(() => assertCorrelatedExchange(value.request, value.events, exchange)).toThrow();
});
