import { randomUUID } from 'node:crypto';
import type { LaneFixtureIdentities } from '../../../scripts/sandbox-provision';
import type { LiveTypedTurnAdapter } from '../adapters/live-typed-turn';
import { assertBrowserRequestMatchesLane, type SandboxBrowser } from '../support/browser';
import type { SandboxEvidenceWriter } from '../support/evidence';
import { SessionCommunicationSandbox } from '../support/session-communication';
import type { TypedTurnPostReceipt } from './typed-turn.case';

export async function runSessionCommunicationCase(options: {
  lane: LaneFixtureIdentities; workspaceDomain: string; runId: string;
  adapter: LiveTypedTurnAdapter; rebindAdapter: () => LiveTypedTurnAdapter;
  browser: SandboxBrowser; evidence: SandboxEvidenceWriter;
}) {
  const { lane, evidence } = options;
  let adapter = options.adapter;
  let fixture = new SessionCommunicationSandbox(lane, adapter, evidence);
  const marker = `SANDBOX_SESSION_COMM_${randomUUID().replaceAll('-', '').toUpperCase()}`;
  const originalSource = adapter.runSourceEvidence();
  const roots: TypedTurnPostReceipt[] = [];
  let archivedRequester: { id: number; status: string } | null = null;
  let needsRebind = false;
  let caseError: unknown = null;
  const observations: Record<string, unknown> = {};
  const save = (name: string, value: unknown) => {
    observations[name] = value;
    evidence.writeJson(`session-communication-${name}.json`, value);
  };
  const post = async (channel: string, suffix: string, root?: string, finish = false) => {
    const receipt = await adapter.postUserMessage({ lane, channel_id: channel, client_message_id: randomUUID(),
      ...(root ? { thread_ts: root } : {}),
      text: `@cc ${marker}_${suffix} ${finish ? '[SESSION_FINISH]' : '[SESSION_HOLD]'} Session communication acceptance input.`,
    });
    if (!root) roots.push(receipt);
    return receipt;
  };
  const acknowledgedPost = async (root: TypedTurnPostReceipt, suffix: string) => {
    const receipt = await post(root.channel_id, suffix, root.thread_ts);
    const acknowledgement = await fixture.until('genuine Slack steering accepted', () => {
      const row = fixture.one<{ turn_id: number; status: string; replay_text: string }>(`SELECT turn_id,status,replay_text
        FROM turn_steering_messages WHERE slack_user_msg_ts=?`, receipt.message_ts);
      return row?.status === 'sent' ? row : null;
    });
    return { receipt, acknowledgement };
  };
  const requestAdmitted = (requestId: string) => fixture.until('request durable admission', () => {
    const request = fixture.request(requestId);
    if (request?.outcome && request.outcome !== 'answered') throw new Error(`Request failed before acceptance: ${JSON.stringify(request)}`);
    return request?.target_turn_id && request.routed_request_id ? request : null;
  });
  const finalEvent = (requestId: string) => fixture.until('correlated final event admitted', () => {
    const event = fixture.events(requestId).find(value => value.kind === 'final');
    return event?.status === 'admitted' && event.routed_request_id ? event : null;
  });
  const finish = async (root: Pick<TypedTurnPostReceipt, 'channel_id' | 'thread_ts'>, suffix: string, turnId: number) => {
    const control = await post(root.channel_id, suffix, root.thread_ts, true);
    const terminal = await fixture.until('explicitly finished provider turn delivered', () => {
      const turn = adapter.routerSearchTurns().find(value => value.turn_id === turnId);
      if (turn && ['error', 'parked', 'cancelled'].includes(turn.status)) throw new Error(`Fixture turn ended ${turn.status}`);
      return turn?.status === 'done' && turn.delivery_status === 'delivered' && turn.response_message_ts ? turn : null;
    });
    if (!terminal.outbound_text.includes(`${marker}_${suffix}`)) throw new Error('Provider completed without observing its exact Slack finish input.');
    const slack = await adapter.readRoutedSlackMessage(terminal.channel_id, terminal.response_message_ts);
    if (slack.user !== lane.bot_user_id || !String(slack.text).includes(`${marker}_${suffix}`)) throw new Error('Exact provider final was not present in Slack.');
    return { control, terminal, slack };
  };
  const capture = async (name: string, terminal: Awaited<ReturnType<typeof finish>>['terminal'], required: string[]) => {
    const request = { lane_id: lane.lane_id, workspace_domain: options.workspaceDomain,
      browser_namespace: lane.browser.namespace, browser_profile_path: lane.browser.profile_path,
      phase: 'terminal' as const, capture_name: `${marker}-${name}`, channel_id: terminal.channel_id,
      message_ts: terminal.response_message_ts, thread_ts: terminal.root_ts,
      permalink: `https://${lane.browser.canonical_workspace_domain}/archives/${terminal.channel_id}/p${terminal.response_message_ts.replace('.', '')}?thread_ts=${terminal.root_ts}&cid=${terminal.channel_id}`,
      required_text: required, assertions: ['The exact requester thread shows the returned correlation and its explicitly finished provider response.'] };
    assertBrowserRequestMatchesLane(request, lane);
    return evidence.verifyScreenshot(await options.browser.capture(request, evidence));
  };
  try {
    const target = await post(lane.channels.core.id, 'TARGET');
    const runningTarget = await adapter.waitForTurnDispatchState({ lane, receipt: target, statuses: ['running'] });
    const targetReady = await acknowledgedPost(target, 'TARGET_READY');
    const requester = await post(lane.channels.project.id, 'REQUESTER');
    const runningRequester = await adapter.waitForTurnDispatchState({ lane, receipt: requester, statuses: ['running'] });
    const requesterReady = await acknowledgedPost(requester, 'REQUESTER_READY');
    const initialNativeBindings = [runningTarget.session_id, runningRequester.session_id].map(id =>
      fixture.one<{ id: number; agent_session_uuid: string | null }>('SELECT id,agent_session_uuid FROM sessions WHERE id=?', id)!);
    if (initialNativeBindings.some(session => session.agent_session_uuid !== null)
      || targetReady.acknowledgement.turn_id !== runningTarget.turn_id || requesterReady.acknowledgement.turn_id !== runningRequester.turn_id) {
      throw new Error('Acceptance did not begin in two first native turns without persisted UUIDs.');
    }
    const search = await fixture.command('search', ['--', `${marker}_TARGET`], requester, 'search');
    const candidates = search.results.filter((result: any) => result.channel_id === target.channel_id && result.root_ts === target.thread_ts);
    if (search.complete !== true || candidates.length !== 1 || !candidates[0].address
      || candidates[0].session_id !== `concierge:${runningTarget.session_id}`) throw new Error('Discovery did not select exactly the held target session.');
    const address = candidates[0].address;
    const context = await fixture.command('context', [address], requester, 'context');
    if (context.address !== address || context.session_id !== candidates[0].session_id || context.complete !== true
      || !JSON.stringify(context).includes(`${marker}_TARGET`)) throw new Error('Context did not preserve the exact discovered target and input evidence.');
    save('discovery', { targetReady, requesterReady, initialNativeBindings, target, requester, runningTarget, runningRequester, search, context });

    const firstArgs = [address, '--action-id', `${marker}_Q1`, '--', `${marker}_QUESTION_ONE`];
    const first = await fixture.command('ask', firstArgs, requester, 'ask-one');
    const second = await fixture.command('ask', [address, '--action-id', `${marker}_Q2`, '--', `${marker}_QUESTION_TWO`], requester, 'ask-two');
    const requests = await Promise.all([requestAdmitted(first.request_id), requestAdmitted(second.request_id)]);
    const targetInputs = await Promise.all(requests.map(request => fixture.received(request.routed_request_id!, {
      kind: 'steering', session: runningTarget.session_id, turn: runningTarget.turn_id,
    })));
    if (targetInputs.some(value => value.input.provider_session_uuid !== null)) throw new Error('Questions did not exercise first-turn live steering before a persisted UUID.');
    const repeated = await fixture.command('ask', firstArgs, requester, 'ask-one-duplicate');
    if (repeated.request_id !== first.request_id || fixture.one<{ count: number }>(`SELECT count(*) AS count FROM session_communication_requests
      WHERE source_channel=? AND source_message_ts=?`, requester.channel_id, requester.message_ts)?.count !== 2) throw new Error('Duplicate question produced another durable request.');
    save('multiple-live-questions', { requests, targetInputs, repeated });

    const replySource = { channel_id: targetInputs[0].input.channel, message_ts: targetInputs[0].input.message_ts };
    await fixture.command('reply', [first.request_id, '--action-id', `${marker}_PARTIAL`, '--partial', '--', `${marker}_PARTIAL_ANSWER`], replySource, 'partial-answer');
    const progress = await fixture.until('partial answer delivered', () => {
      const event = fixture.events(first.request_id).find(value => value.kind === 'progress');
      return event?.status === 'admitted' && event.routed_request_id ? event : null;
    });
    const partialInput = await fixture.received(progress.routed_request_id!, { kind: 'steering', session: runningRequester.session_id, turn: runningRequester.turn_id });
    if (fixture.request(first.request_id)?.outcome !== null) throw new Error('Partial answer settled the request.');
    const replyArgs = [first.request_id, '--action-id', `${marker}_FINAL`, '--', `${marker}_ANSWER_ONE`];
    await fixture.command('reply', replyArgs, replySource, 'final-answer');
    const answered = await finalEvent(first.request_id);
    const answerInput = await fixture.received(answered.routed_request_id!, { kind: 'steering', session: runningRequester.session_id, turn: runningRequester.turn_id });
    if (answerInput.input.provider_session_uuid !== null || partialInput.input.provider_session_uuid !== null) throw new Error('Active requester returns did not exercise the first-turn boundary.');
    await fixture.command('reply', replyArgs, replySource, 'final-answer-duplicate');
    if (fixture.request(first.request_id)?.outcome !== 'answered' || fixture.request(second.request_id)?.outcome !== null
      || fixture.events(first.request_id).filter(event => event.kind === 'final').length !== 1 || fixture.events(second.request_id).length !== 0) {
      throw new Error('A correlated answer settled another question or a duplicate produced another final event.');
    }
    save('correlated-answer', { progress, partialInput, answered, answerInput, unanswered: fixture.request(second.request_id) });

    const overdueFixture = fixture.makeOverdue(second.request_id);
    const overdueWake = await acknowledgedPost(target, 'OVERDUE_WAKE');
    const overdue = await fixture.until('one overdue return admitted', () => {
      const event = fixture.events(second.request_id).find(value => value.kind === 'overdue');
      return event?.status === 'admitted' && event.routed_request_id ? event : null;
    });
    const overdueInput = await fixture.received(overdue.routed_request_id!, { kind: 'steering', session: runningRequester.session_id, turn: runningRequester.turn_id });
    const repeatedWake = await acknowledgedPost(target, 'OVERDUE_REPEAT_WAKE');
    if (fixture.events(second.request_id).filter(event => event.kind === 'overdue').length !== 1 || fixture.request(second.request_id)?.outcome !== null) {
      throw new Error('Overdue inspection repeated or implicitly settled the outstanding request.');
    }
    save('overdue', { fixture: overdueFixture, overdueWake, overdue, overdueInput, repeatedWake, state: fixture.request(second.request_id), deadlines: fixture.deadlines() });

    const targetFinal = await finish(target, 'TARGET_FINISH', runningTarget.turn_id);
    const unansweredEvent = await finalEvent(second.request_id);
    const unanswered = fixture.request(second.request_id)!;
    if (unanswered.outcome !== 'unanswered' || !JSON.parse(unanswered.result_json!).text.includes('ended without a confirmed answer')
      || fixture.request(first.request_id)?.outcome !== 'answered') throw new Error('Turn completion did not preserve explicit answer correlation.');
    const output = fixture.assertOutput(unanswered, runningTarget.turn_id);
    const unansweredInput = await fixture.received(unansweredEvent.routed_request_id!, { kind: 'steering', session: runningRequester.session_id, turn: runningRequester.turn_id });
    if (!unansweredInput.input.replay_text?.includes(String(output.message_ts))) throw new Error('Requester did not receive the exact retained output reference.');
    const activeFinal = await finish(requester, 'ACTIVE_REQUESTER_FINISH', runningRequester.turn_id);
    const completedNativeBindings = [runningTarget.session_id, runningRequester.session_id].map(id =>
      fixture.one<{ id: number; agent_session_uuid: string | null }>('SELECT id,agent_session_uuid FROM sessions WHERE id=?', id)!);
    if (completedNativeBindings.some(session => !session.agent_session_uuid)) throw new Error('First native turn completion did not persist the resumption identity.');
    if (![first.request_id, second.request_id, `${marker}_ANSWER_ONE`, 'ended without a confirmed answer'].every(value => activeFinal.terminal.outbound_text.includes(value))) {
      throw new Error('Active requester did not observe both the explicit answer and the separate unanswered disposition.');
    }
    const activeScreenshot = await capture('active-requester', activeFinal.terminal, [`${marker}_ANSWER_ONE`, 'ended without a confirmed answer']);
    save('active-requester', { targetFinal, unanswered, unansweredEvent, output, unansweredInput, activeFinal, completedNativeBindings, activeScreenshot });
    await adapter.waitForRunSettled();

    const idleQuestion = await fixture.command('ask', [address, '--action-id', `${marker}_IDLE`, '--after-request', first.request_id, '--', `${marker}_IDLE_QUESTION`], requester, 'idle-question');
    const idleRequest = await requestAdmitted(idleQuestion.request_id);
    const idleTarget = await fixture.received(idleRequest.routed_request_id!, { kind: 'turn', session: runningTarget.session_id });
    if (idleTarget.input.turn_id === runningTarget.turn_id || idleTarget.input.provider_session_uuid !== completedNativeBindings[0].agent_session_uuid) throw new Error('Idle target did not resume the exact native session in a new turn.');
    await fixture.command('reply', [idleQuestion.request_id, '--action-id', `${marker}_IDLE_ANSWER`, '--', `${marker}_IDLE_ANSWER`],
      { channel_id: idleTarget.input.channel, message_ts: idleTarget.input.message_ts }, 'idle-answer');
    const idleEvent = await finalEvent(idleQuestion.request_id);
    const idleReturn = await fixture.received(idleEvent.routed_request_id!, { kind: 'turn', session: runningRequester.session_id });
    if (idleReturn.input.turn_id === runningRequester.turn_id || idleReturn.input.provider_session_uuid !== completedNativeBindings[1].agent_session_uuid) {
      throw new Error('Idle requester did not resume its exact native session in a new turn.');
    }
    const idleFinal = await finish(requester, 'IDLE_REQUESTER_FINISH', idleReturn.input.turn_id);
    const idleTargetFinal = await finish(target, 'IDLE_TARGET_FINISH', idleTarget.input.turn_id);
    save('idle-requester', { idleRequest, idleTarget, idleEvent, idleReturn, idleFinal, idleTargetFinal });
    await adapter.waitForRunSettled();

    const retainedQuestion = await fixture.command('ask', [address, '--action-id', `${marker}_RETAINED`, '--', `${marker}_RETAINED_QUESTION`], requester, 'retained-question');
    const retainedRequest = await requestAdmitted(retainedQuestion.request_id);
    const retainedTarget = await fixture.received(retainedRequest.routed_request_id!, { kind: 'turn', session: runningTarget.session_id });
    const requesterHold = fixture.holdIdleRequester(runningRequester.session_id);
    archivedRequester = requesterHold.before;
    const retainedReply = [retainedQuestion.request_id, '--action-id', `${marker}_RETAINED_ANSWER`, '--', `${marker}_RETAINED_ANSWER`];
    const retainedReplySource = { channel_id: retainedTarget.input.channel, message_ts: retainedTarget.input.message_ts };
    await fixture.command('reply', retainedReply, retainedReplySource, 'retained-answer');
    const heldEvent = await fixture.until('return held for exact idle requester', () => {
      const event = fixture.events(retainedQuestion.request_id).find(value => value.kind === 'final');
      return event?.status === 'held' && !event.routed_request_id ? event : null;
    });
    const retainedTargetFinal = await finish(target, 'RETAINED_TARGET_FINISH', retainedTarget.input.turn_id);
    await adapter.waitForRunSettled();
    save('before-restart', { retainedRequest, retainedTarget, requesterHold, heldEvent, retainedTargetFinal, source: adapter.runSourceEvidence() });
    needsRebind = true;
    const reload = await fixture.reload(options.runId);
    fixture.close();
    adapter = options.rebindAdapter();
    fixture = new SessionCommunicationSandbox(lane, adapter, evidence);
    needsRebind = false;
    const reloadedSource = adapter.runSourceEvidence();
    const afterRestart = fixture.events(retainedQuestion.request_id).filter(event => event.kind === 'final');
    if (reloadedSource.generation <= originalSource.generation || reloadedSource.source_head !== originalSource.source_head
      || reloadedSource.source_diff_digest !== originalSource.source_diff_digest || afterRestart.length !== 1
      || afterRestart[0].event_id !== heldEvent.event_id || afterRestart[0].routed_request_id) throw new Error('Restart lost the exact held return or tested a different source.');
    const restoredRequester = fixture.restoreRequester(archivedRequester);
    archivedRequester = null;
    const restartWake = await post(lane.channels.capture.id, 'RESTART_WAKE');
    const restartWakeTurn = await adapter.waitForTurnDispatchState({ lane, receipt: restartWake, statuses: ['running'] });
    const retainedEvent = await finalEvent(retainedQuestion.request_id);
    const retainedReturn = await fixture.received(retainedEvent.routed_request_id!, { kind: 'turn', session: runningRequester.session_id });
    if (retainedEvent.event_id !== heldEvent.event_id || retainedReturn.input.provider_session_uuid !== completedNativeBindings[1].agent_session_uuid) {
      throw new Error('Retained return changed identity or resumed another native session.');
    }
    await fixture.command('reply', retainedReply, retainedReplySource, 'retained-answer-duplicate');
    const retainedFinal = await finish(requester, 'RETAINED_REQUESTER_FINISH', retainedReturn.input.turn_id);
    const restartWakeFinal = await finish(restartWake, 'RESTART_WAKE_FINISH', restartWakeTurn.turn_id);
    const retainedScreenshot = await capture('retained-requester', retainedFinal.terminal, [`${marker}_RETAINED_ANSWER`, retainedQuestion.request_id]);
    save('after-restart', { reload, source: reloadedSource, afterRestart, restoredRequester, restartWake, retainedEvent, retainedReturn, retainedFinal, restartWakeFinal, retainedScreenshot });
    await adapter.waitForRunSettled();
    const deadlines = fixture.deadlines();
    if (deadlines.outstanding !== 0 || deadlines.eligible_deadlines !== 0 || deadlines.undelivered_events !== 0
      || fixture.events(second.request_id).filter(event => event.kind === 'overdue').length !== 1
      || fixture.events(retainedQuestion.request_id).filter(event => event.kind === 'final').length !== 1) {
      throw new Error('Communication obligations or repeated overdue work survived final drain.');
    }
    const inspected = await fixture.command('get', [second.request_id], requester, 'final-inspection');
    const duplicateInputs = [
      { channel: target.channel_id, fragment: `Session request ${first.request_id} from` },
      { channel: requester.channel_id, fragment: `Session final event ${answered.event_id} for request` },
      { channel: requester.channel_id, fragment: `Session final event ${retainedEvent.event_id} for request` },
    ].map(identity => ({ ...identity, count: fixture.one<{ count: number }>(`SELECT count(*) AS count
      FROM slack_user_input_claims WHERE slack_channel_id=? AND instr(user_text,?)>0`, identity.channel, identity.fragment)!.count }));
    if (duplicateInputs.some(input => input.count !== 1)) throw new Error('Repeated action published duplicate accepted Slack inputs.');
    const result = { case_id: 'session-communication', status: 'passed', lane_id: lane.lane_id, app_id: lane.app_id,
      run_id: options.runId, source: originalSource, reloaded_source: reloadedSource, marker, observations, inspected,
      deadlines, duplicateInputs, run_owned_unsettled: 0, timer_scope: 'Slack proves no eligible deadlines and one overdue event; focused coordinator tests prove timer disarming.' };
    evidence.writeJson('session-communication.json', result);
    return result;
  } catch (error) {
    caseError = error;
    save('failure', { marker, source: originalSource, message: String(error), stack: error instanceof Error ? error.stack : undefined });
    throw error;
  } finally {
    try {
      if (needsRebind) {
        const rebound = options.rebindAdapter();
        const source = rebound.runSourceEvidence();
        if (source.source_head !== originalSource.source_head || source.source_diff_digest !== originalSource.source_diff_digest
          || source.generation < originalSource.generation) throw new Error('Cleanup cannot bind a different sandbox source.');
        fixture.close();
        adapter = rebound;
        fixture = new SessionCommunicationSandbox(lane, adapter, evidence);
      }
      if (archivedRequester) fixture.restoreRequester(archivedRequester);
      let finishing = false;
      for (const root of roots) {
        const running = adapter.routerSearchTurns().find(turn => turn.channel_id === root.channel_id && turn.root_ts === root.thread_ts && turn.status === 'running');
        if (running) {
          await post(root.channel_id, 'CLEANUP_FINISH', root.thread_ts, true);
          finishing = true;
        }
      }
      if (finishing) await adapter.waitForRunSettled();
    } catch (error) {
      save('cleanup-failure', { marker, message: String(error), stack: error instanceof Error ? error.stack : undefined });
      if (!caseError) throw error;
    } finally {
      fixture.close();
    }
  }
}
