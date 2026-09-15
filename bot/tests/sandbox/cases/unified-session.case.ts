import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { LaneFixtureIdentities } from '../../../scripts/sandbox-provision';
import type { LiveTypedTurnAdapter } from '../adapters/live-typed-turn';
import type { SandboxEvidenceWriter } from '../support/evidence';
import { ThinkeringSessionAcceptance } from '../support/thinkering-session';
import { assertCorrelatedExchange, UnifiedSessionSandbox } from '../support/unified-session';
import { runUnifiedConsultationCase } from './unified-consultation.case';

const numericSession = (id: string) => {
  if (!/^concierge:[1-9][0-9]*$/.test(id)) throw new Error('The surface did not return a canonical owner session.');
  return Number(id.slice('concierge:'.length));
};

export async function runUnifiedSessionCase(options: {
  lane: LaneFixtureIdentities; adapter: LiveTypedTurnAdapter; evidence: SandboxEvidenceWriter;
  thinkeringFixture: string; macFixturePath: string;
}) {
  const { lane, adapter, evidence } = options;
  const source = adapter.runSourceEvidence();
  const fixture = new UnifiedSessionSandbox(adapter.routerSearchContext().state_database, source, evidence);
  const surface = new ThinkeringSessionAcceptance(options.thinkeringFixture, dirname(fixture.statePath));
  const marker = `UNIFIED_${randomUUID().replaceAll('-', '')}`;
  const oldMemory = randomUUID(), nativeMemory = randomUUID(), secondMemory = randomUUID();
  const responseRules = 'For a later session question, use this input’s service-issued source input/run with router-actions.sh sessions reply. Send one --partial response and one final response to that exact request, with distinct stable action IDs. Final text must contain the requested marker and the remembered user-supplied fixture value. Do not ask a reciprocal question or acknowledge automatic service returns. End your turn after sending the required replies.';
  const created: string[] = [];
  const owned: string[] = [];
  let slackDisabled = false;
  const operation = async (id: string) => {
    const result = await fixture.owner(`/sessions/v1/operations/${encodeURIComponent(id)}`);
    if (['failed', 'canceled', 'uncertain'].includes(result.state)) throw new Error(`Exact input ended ${result.state}: ${JSON.stringify(result)}`);
    return result;
  };
  const completed = (id: string) => fixture.until('exact native input completes', async () => {
    const result = await operation(id); return result.state === 'completed' ? result : null;
  });
  const idle = (id: string) => fixture.until('exact session has no executing or queued turn', () =>
    fixture.one('SELECT count(*) AS n FROM turns WHERE session_id=? AND status IN (\'queued\',\'running\',\'delivering\')', numericSession(id))!.n === 0 ? true : null);
  const question = (from: string, to: string, inputId: string) => fixture.until('exact source/target question is retained', async () => {
    const current = await operation(inputId);
    const found = fixture.requests().filter(row => row.source_session_id === numericSession(from) && row.target_session_id === numericSession(to));
    if (found.length > 1) throw new Error('Provider submitted more than one question for this exact exchange.');
    if (!found.length && current.state === 'completed') throw new Error(`The exact input completed without submitting the required question: ${JSON.stringify(current)}`);
    return found[0] ?? null;
  });
  const answered = (requestId: string) => fixture.until('exact partial/final answers settle', () => {
    const found = fixture.one('SELECT * FROM session_communication_requests WHERE request_id=?', requestId);
    if (found?.outcome && found.outcome !== 'answered') throw new Error(`Question settled without a confirmed answer: ${JSON.stringify(found)}`);
    return found?.outcome === 'answered' ? found : null;
  });
  const returned = (requestId: string) => fixture.until('all exact partial/final events are received', () => {
    const events = fixture.events(requestId);
    if (events.some(event => ['failed', 'ambiguous', 'uncertain', 'canceled'].includes(event.status))) throw new Error(`Return is explicitly unresolved: ${JSON.stringify(events)}`);
    return events.some(event => event.kind === 'final') && events.every(event => event.status === 'received') ? events : null;
  });
  try {
    const root = await adapter.postUserMessage({ lane, channel_id: lane.channels.core.id, client_message_id: randomUUID(),
      text: `@cx ${marker}_SLACK_ORIGINAL. Remember this user-supplied fixture value in your native conversation: ${oldMemory}. ${responseRules} For this first input only, reply exactly TL;DR: ${marker}_SLACK_READY. Do not use tools.` });
    const initial = await adapter.waitForRouterSearchTurn(root);
    const old = fixture.one('SELECT * FROM sessions WHERE id=?', initial.session_id)!;
    if (!old.agent_session_uuid || initial.provider_id !== 'codex') throw new Error('Slack did not create a real Codex native conversation.');
    const oldId = `concierge:${old.id}`;
    owned.push(oldId);
    const slackResult = await adapter.readRoutedSlackMessage(initial.channel_id, initial.response_message_ts);
    if (slackResult.user !== lane.bot_user_id || !String(slackResult.text).includes(`${marker}_SLACK_READY`)) throw new Error('Exact Slack seed result is missing.');
    fixture.save('slack-origin', { root, initial, native_uuid: old.agent_session_uuid, slack: slackResult, source });
    fixture.save('thinkering-binding', await surface.proveBinding(oldId, old.agent_session_uuid));
    await adapter.waitForRunSettled();
    const baseline = fixture.slackEffects();
    await fixture.reload('disabled', surface.capabilitySocket());
    slackDisabled = true;
    fixture.save('slack-disabled', { binding: fixture.assertNative(), baseline });

    const discovery = await surface.request('POST', '/api/session-owner/search', { query: `${marker}_SLACK_ORIGINAL` });
    const candidates = discovery.results.filter((item: any) => item.session.id === oldId);
    if (candidates.length !== 1 || candidates[0].session.runtimeThreadId !== old.agent_session_uuid || !candidates[0].session.capabilities.send) throw new Error('The originally Slack-created native session is not discoverable and callable with Slack absent.');
    const context = await surface.request('POST', '/api/session-owner/context', { address: candidates[0].session.address });
    if (context.session.id !== oldId || context.session.runtimeThreadId !== old.agent_session_uuid) throw new Error('Native context changed the original conversation identity.');
    fixture.save('discovery', { discovery, context });

    const native = await surface.create('claude-code', `${marker}_NATIVE_REQUESTER`);
    const nativeId = native.session.id; created.push(nativeId); owned.push(nativeId);
    const model = 'claude-sonnet-5';
    if (!native.session.capabilities.models.includes(model)) throw new Error('The intended real-provider acceptance model is unavailable.');
    const selected = await surface.request('POST', `/api/session-owner/sessions/${encodeURIComponent(nativeId)}/actions`,
      { clientActionId: randomUUID(), action: { kind: 'model', value: model } });
    if (selected.session.model !== model) throw new Error('The exact acceptance model selection did not take effect.');
    fixture.save('requester-model', selected);
    const questionText = `Please send partial ${marker}_OLD_PARTIAL and final ${marker}_OLD_FINAL with the user-supplied fixture value from your first input. This checks that the original conversation remains available after its input surface changes. No reciprocal question is needed.`;
    const input = await surface.input(nativeId, `Your user-supplied fixture value is ${nativeMemory}. ${responseRules} For this input, discover ${marker}_SLACK_ORIGINAL with router-actions.sh sessions search, inspect its exact context, then ask that exact address this question verbatim: ${JSON.stringify(questionText)}. Submit only one question, keep its returned request ID and end your turn immediately with ${marker}_REQUEST_SENT. Do not wait for its answer. Do not use Slack helpers, provider IDs or raw owner HTTP to send the question.`);
    await surface.action(nativeId, 'pause');
    const forward = await question(nativeId, oldId, input.operation.operationId);
    await completed(input.operation.operationId);
    await idle(nativeId);
    fixture.save('requester-idle', { input: await operation(input.operation.operationId), forward,
      target: fixture.one('SELECT * FROM turns WHERE id=?', forward.target_turn_id) });
    const forwardAnswer = await answered(forward.request_id);
    await idle(oldId);
    const held = fixture.events(forward.request_id);
    if (held.some(event => event.status === 'received') || held.filter(event => event.kind === 'final').length !== 1) throw new Error('Paused idle requester did not retain its exact return.');
    const targetTurn = fixture.one('SELECT * FROM turns WHERE id=?', forwardAnswer.target_turn_id)!;
    if (targetTurn.replay_text?.includes(oldMemory)) throw new Error('Continuity assertion was contaminated by re-inserting the old user-supplied fixture value.');
    fixture.save('held-return', { request: forwardAnswer, events: held, native_uuid: old.agent_session_uuid });
    await fixture.reload('disabled');
    if (JSON.stringify(fixture.events(forward.request_id).map(event => event.event_id)) !== JSON.stringify(held.map(event => event.event_id))) throw new Error('Restart replaced retained return identities.');
    await surface.action(nativeId, 'continue');
    const forwardEvents = await returned(forward.request_id);
    assertCorrelatedExchange(forwardAnswer, forwardEvents, { sourceSession: numericSession(nativeId), targetSession: old.id,
      partial: `${marker}_OLD_PARTIAL`, final: oldMemory });
    await idle(nativeId);

    const reverseInput = await surface.input(oldId, `Discover ${marker}_NATIVE_REQUESTER with the session CLI, inspect its exact context, ask it exactly one question: Send partial ${marker}_NEW_PARTIAL and final ${marker}_NEW_FINAL with your remembered user-supplied fixture value. End this turn after recording the question. Do not wait or send an automatic reciprocal request.`);
    const reverse = await question(oldId, nativeId, reverseInput.operation.operationId);
    await completed(reverseInput.operation.operationId);
    const reverseAnswer = await answered(reverse.request_id);
    const reverseEvents = await returned(reverse.request_id);
    assertCorrelatedExchange(reverseAnswer, reverseEvents, { sourceSession: old.id, targetSession: numericSession(nativeId),
      partial: `${marker}_NEW_PARTIAL`, final: nativeMemory });
    await idle(oldId); await idle(nativeId);
    if (fixture.one('SELECT agent_session_uuid FROM sessions WHERE id=?', old.id)!.agent_session_uuid !== old.agent_session_uuid) throw new Error('Slack removal changed the original native conversation UUID.');

    const second = await surface.create('codex', `${marker}_NATIVE_SECOND`);
    const secondId = second.session.id; created.push(secondId); owned.push(secondId);
    const seeded = await surface.input(secondId, `Remember user-supplied fixture value ${secondMemory}. ${responseRules} Reply ${marker}_SECOND_READY now.`);
    await completed(seeded.operation.operationId);
    const newQuestion = await surface.input(nativeId, `Discover ${marker}_NATIVE_SECOND through the session CLI and ask one question: Send partial ${marker}_SECOND_PARTIAL and final ${marker}_SECOND_FINAL with your remembered user-supplied fixture value. End after recording the question; no waiting or reciprocal question.`);
    const nativeRequest = await question(nativeId, secondId, newQuestion.operation.operationId);
    await completed(newQuestion.operation.operationId);
    const nativeAnswer = await answered(nativeRequest.request_id);
    const nativeEvents = await returned(nativeRequest.request_id);
    assertCorrelatedExchange(nativeAnswer, nativeEvents, { sourceSession: numericSession(nativeId), targetSession: numericSession(secondId),
      partial: `${marker}_SECOND_PARTIAL`, final: secondMemory });
    await idle(nativeId); await idle(secondId);
    const newSessions = created.map(id => fixture.one('SELECT id,slack_channel_id,slack_thread_ts,agent_session_uuid FROM sessions WHERE id=?', numericSession(id))!);
    if (newSessions.some(row => row.slack_channel_id !== null || row.slack_thread_ts !== null || !row.agent_session_uuid)) throw new Error('Native creation fabricated Slack bindings or failed to establish real native history.');
    await runUnifiedConsultationCase({ fixture, surface, marker, macFixturePath: options.macFixturePath });
    if (JSON.stringify(fixture.slackEffects()) !== JSON.stringify(baseline)) throw new Error('Slack-disabled native communication created a Slack input, publication or response.');
    fixture.save('passed', { source, native_source: surface.sourceEvidence(), marker, old_session: oldId, old_native_uuid: old.agent_session_uuid,
      new_sessions: newSessions, forward: { request: forwardAnswer, events: forwardEvents }, reverse: { request: reverseAnswer, events: reverseEvents },
      native_exchange: { request: nativeAnswer, events: nativeEvents }, slack_before: baseline, slack_after: fixture.slackEffects(), binding: fixture.assertNative() });
  } catch (error) {
    fixture.save('failed', { marker, error: error instanceof Error ? error.message : String(error) });
    if (slackDisabled) {
      for (const id of owned) {
        try {
          const session = (await fixture.owner(`/sessions/v1/sessions/${encodeURIComponent(id)}`)).session;
          if (session.activeRunId) {
            const stopped = await fixture.ownerResponse(`/sessions/v1/sessions/${encodeURIComponent(id)}/stop`, { clientActionId: randomUUID(), runId: session.activeRunId });
            fixture.save(`cleanup-${id.slice('concierge:'.length)}`, stopped);
          }
        } catch (cleanupError) {
          fixture.save(`cleanup-${id.slice('concierge:'.length)}`, { error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) });
        }
      }
    }
    throw error;
  } finally {
    fixture.close();
  }
}
