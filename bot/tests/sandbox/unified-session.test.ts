import { expect, test } from 'bun:test';
import { assertCorrelatedExchange, assertNativeLaneReceipt } from './support/unified-session';
import {assertChatGptIntentResult} from './cases/unified-chatgpt.case';

const chatGptRequest={request_id:'question',target_session_id:2,target_input_id:'request:question',routed_request_id:null,payload_json:JSON.stringify({provider:'chatgpt'}),outcome:'answered',result_json:JSON.stringify({responding_session_id:'concierge:2',event_id:'final',text:'Ferns tolerate shade.'})};
const chatGptTarget={provider_id:'chatgpt',slack_channel_id:null,slack_thread_ts:null,agent_session_uuid:'native-chatgpt'};
const chatGptOperation={origin:'agent',kind:'create',inputId:'request:question',sessionId:'concierge:2',requestId:'question',state:'completed',acknowledgedAt:'2026-09-15T12:00:00Z',result:'Ferns tolerate shade.'};
const chatGptEvents=[{event_id:'final',request_id:'question',kind:'final',status:'received',accepted_input_id:'return:final',routed_request_id:null}];

test('ChatGPT intent oracle distinguishes exact provider answers from explicit unavailable creation',()=>{
  expect(()=>assertChatGptIntentResult(chatGptRequest,chatGptTarget,chatGptOperation,chatGptEvents,[])).not.toThrow();
  const failed={...chatGptRequest,outcome:'failed'};
  const unavailable={...chatGptOperation,state:'failed',runId:null,admission:null,error:{message:'chatgpt start unavailable.'}};
  expect(()=>assertChatGptIntentResult(failed,chatGptTarget,unavailable,chatGptEvents,[])).not.toThrow();
  expect(()=>assertChatGptIntentResult(failed,chatGptTarget,{...unavailable,error:{message:'An internal setup error'}},chatGptEvents,[])).toThrow();
  const uncertain={...unavailable,state:'uncertain',runId:'run',admission:{runId:'run'},error:{message:'Send acknowledgement lost'}};
  expect(()=>assertChatGptIntentResult(failed,chatGptTarget,uncertain,chatGptEvents,[])).toThrow();
  expect(()=>assertChatGptIntentResult(failed,chatGptTarget,uncertain,chatGptEvents,[{kind:'failure',run:{inputId:'request:question',runId:'run'},code:'CHATGPT_SEND_UNCONFIRMED',message:'Send acknowledgement lost'}])).not.toThrow();
});

test.each([
  {target:{...chatGptTarget,provider_id:'codex'}},
  {target:{...chatGptTarget,slack_channel_id:'CFABRICATED'}},
  {operation:{...chatGptOperation,origin:'human'}},
  {operation:{...chatGptOperation,acknowledgedAt:null}},
  {operation:{...chatGptOperation,result:'A different result'}},
  {events:chatGptEvents.map(event=>({...event,request_id:'another-question'}))},
  {events:chatGptEvents.map(event=>({...event,status:'queued'}))},
  {events:[...chatGptEvents,...chatGptEvents]},
])('ChatGPT intent oracle rejects fallback, fabricated authority and uncorrelated returns (%#)',value=>{
  expect(()=>assertChatGptIntentResult(chatGptRequest,value.target??chatGptTarget,value.operation??chatGptOperation,value.events??chatGptEvents,[])).toThrow();
});
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
  { request, events: replyEvents.map(event => event.kind === 'final' ? { ...event, payload_json: JSON.stringify({text:'A different remembered decision'}) } : event) },
  { request, events: replyEvents.map(event => event.kind === 'progress' ? { ...event, payload_json: JSON.stringify({text:'A different progress reply'}) } : event) },
])('native exchange oracle refuses false continuity or incomplete delivery (%#)', value => {
  expect(() => assertCorrelatedExchange(value.request, value.events, exchange)).toThrow();
});
