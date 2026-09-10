import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import type { LaneFixtureIdentities } from '../../../scripts/sandbox-provision';
import type { LiveTypedTurnAdapter } from '../adapters/live-typed-turn';
import type { TypedTurnPostReceipt } from './typed-turn.case';
import { assertBrowserRequestMatchesLane, type SandboxBrowser } from '../support/browser';
import type { SandboxEvidenceWriter } from '../support/evidence';

export async function runQueuedRequestsCase(options: {
  lane: LaneFixtureIdentities; workspaceDomain: string; runId: string;
  adapter: LiveTypedTurnAdapter; browser: SandboxBrowser; evidence: SandboxEvidenceWriter;
}) {
  const { lane, adapter, evidence } = options;
  const marker = `SANDBOX_QUEUED_${randomUUID().replaceAll('-', '').toUpperCase()}`;
  const held: TypedTurnPostReceipt[] = [];
  let database: Database | null = null;
  const post = (channel: string, suffix: string, hold = false, root?: string) => adapter.postUserMessage({
    lane, channel_id: channel, client_message_id: randomUUID(), thread_ts: root,
    text: `@cc ${marker}_${suffix} ${hold ? '[QUEUE_HOLD]' : ''} Return the exact marker in your final.`,
  }).then(receipt => { if (hold) held.push(receipt); return receipt; });
  try {
  const destinationSetup = await post(lane.channels.capture.id, 'DESTINATION_SETUP');
  await adapter.waitForRouterSearchTurn(destinationSetup);
  const a = await post(lane.channels.core.id, 'A1', true);
  const b = await post(lane.channels.project.id, 'B1', true);
  const runningA = await adapter.waitForTurnDispatchState({ lane, receipt: a, statuses: ['running'] });
  const runningB = await adapter.waitForTurnDispatchState({ lane, receipt: b, statuses: ['running'] });
  const source = await post(lane.dm_channel_id, 'SOURCE');
  await adapter.waitForRouterSearchTurn(source);
  const body = { source: { channel_id: source.channel_id, message_ts: source.message_ts }, action_id: marker,
    destination: { channel_id: lane.channels.capture.id }, task: `@cc ${marker}_C\n${'Retain this complete task. '.repeat(180)}`,
    defer: true, depends_on: [
      { turn_id: runningA.turn_id, channel_id: a.channel_id, root_ts: a.thread_ts },
      { turn_id: runningB.turn_id, channel_id: b.channel_id, root_ts: b.thread_ts },
    ] };
  const routed = await adapter.submitRoutedRequest(body);
  const c: TypedTurnPostReceipt = { channel_id: routed.channel, message_ts: routed.ts,
    thread_ts: routed.thread_ts || routed.ts, permalink: routed.permalink,
    client_message_id: routed.request_id, delivery: 'confirmed' };
  database = new Database(adapter.routerSearchContext().state_database, { readonly: true });
  const state = () => database!.query('SELECT status, owner_instance_id, dispatch_attempt FROM turns WHERE id=?').get(routed.turn_id) as any;
  async function waitForReaction(present: boolean) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const message = await adapter.readRoutedSlackMessage(c.channel_id, c.message_ts);
      const hasReaction = Array.isArray(message.reactions) && message.reactions.some((r: any) => r.name === 'hourglass_flowing_sand' && r.users.includes(lane.bot_user_id));
      if (hasReaction === present) return message;
      await Bun.sleep(250);
    }
    throw new Error(`Waiting reaction did not converge to ${present}.`);
  }
  async function capture(phase: 'running' | 'terminal', required: string[]) {
    const final = phase === 'terminal' ? adapter.routerSearchTurns().find(turn => turn.turn_id === routed.turn_id) : null;
    const messageTs = final?.response_message_ts || c.message_ts;
    const permalink = final ? `https://${lane.browser.canonical_workspace_domain}/archives/${c.channel_id}/p${messageTs.replace('.', '')}?thread_ts=${c.thread_ts}&cid=${c.channel_id}` : c.permalink;
    const request = { lane_id: lane.lane_id, workspace_domain: options.workspaceDomain,
      browser_namespace: lane.browser.namespace, browser_profile_path: lane.browser.profile_path,
      phase, capture_name: `${marker}-${phase}`, permalink,
      channel_id: c.channel_id, message_ts: messageTs, thread_ts: c.thread_ts,
      required_text: required, assertions: [phase === 'running' ? 'The user request shows only an hourglass while waiting.' : 'The same thread contains the completed deferred request.'] };
    assertBrowserRequestMatchesLane(request, lane);
    return evidence.verifyScreenshot(await options.browser.capture(request, evidence));
  }
    const waitingMessage = await waitForReaction(true);
    if (waitingMessage.user !== lane.installer_user_id || state().status !== 'queued' || state().owner_instance_id !== null
      || state().dispatch_attempt !== 0 || (await adapter.fetchBotThreadTexts({ lane, receipt: c })).length !== 0
      || routed.file_ids.length !== 1) throw new Error('Deferred input was not a quiet, user-authored, file-backed wait.');
    const waitingScreenshot = await capture('running', ['Complete routed request attached', `${marker}_C`]);
    if ((await adapter.submitRoutedRequest(body)).turn_id !== routed.turn_id) throw new Error('Duplicate request created another turn.');
    const independent = await post(c.channel_id, 'INDEPENDENT');
    await adapter.waitForRouterSearchTurn(independent);
    await post(a.channel_id, 'RELEASE_A1', false, a.thread_ts);
    await adapter.waitForRouterSearchTurn(a);
    const a2 = await post(a.channel_id, 'A2', true, a.thread_ts);
    await adapter.waitForTurnDispatchState({ lane, receipt: a2, statuses: ['running'] });
    if (state().status !== 'queued') throw new Error('One prerequisite completion released the dependent too soon.');
    await post(b.channel_id, 'RELEASE_B1', false, b.thread_ts);
    await adapter.waitForRouterSearchTurn(b);
    const completed = await adapter.waitForRouterSearchTurn(c);
    if (!completed.outbound_text.includes(`${marker}_C`) || state().dispatch_attempt !== 1) throw new Error('Deferred request did not run once with the complete file-backed input.');
    const a2State = adapter.routerSearchTurns().find(turn => turn.message_ts === a2.message_ts);
    if (a2State?.status !== 'running') throw new Error('Later work must still run independently when C completes.');
    await waitForReaction(false);
    const deferredResume = await adapter.submitRoutedRequest({ ...body, action_id: `${marker}_RESUME_EMPTY`,
      destination: { channel_id: a.channel_id, root_ts: a.thread_ts },
      task: `@cc ${marker}_RESUME_EMPTY`, depends_on: [] });
    const completedResume = await adapter.submitRoutedRequest({ ...body, action_id: `${marker}_RESUME_COMPLETE`,
      destination: { channel_id: a.channel_id, root_ts: a.thread_ts },
      task: `@cc ${marker}_RESUME_COMPLETE`, depends_on: [body.depends_on[0]] });
    const resumeReceipts = [deferredResume, completedResume].map(result => ({ channel_id: result.channel,
      message_ts: result.ts, thread_ts: result.thread_ts, permalink: result.permalink,
      client_message_id: result.request_id, delivery: 'confirmed' as const }));
    for (const result of [deferredResume, completedResume]) {
      const row = database.query(`SELECT turn.status, turn.dispatch_attempt, claim.kind FROM turns turn
        JOIN slack_user_input_claims claim ON claim.turn_id=turn.id AND claim.slack_user_msg_ts=turn.slack_user_msg_ts WHERE turn.id=?`).get(result.turn_id) as any;
      if (row?.status !== 'queued' || row.dispatch_attempt !== 0 || row.kind !== 'turn') throw new Error('Explicit deferral became steering or bypassed destination FIFO.');
    }
    const ordinaryRelease = await adapter.submitRoutedRequest({ ...body, action_id: `${marker}_RELEASE_A2`,
      destination: { channel_id: a.channel_id, root_ts: a.thread_ts }, task: `Release ${marker}_A2.`, defer: false, depends_on: [] });
    if (ordinaryRelease.turn_id !== a2State.turn_id) throw new Error('Ordinary API resume did not preserve live steering.');
    await adapter.waitForRouterSearchTurn(a2);
    for (const receipt of resumeReceipts) await adapter.waitForRouterSearchTurn(receipt);
    await adapter.waitForRunSettled();
    const terminalScreenshot = await capture('terminal', [`${marker}_C completed.`]);
    const dependencies = database.query('SELECT prerequisite_turn_id, outcome, satisfied_at FROM turn_dependencies WHERE turn_id=? ORDER BY prerequisite_turn_id').all(routed.turn_id);
    const result = { case_id: 'queued-requests', status: 'passed', lane_id: lane.lane_id, run_id: options.runId,
      source: adapter.runSourceEvidence(), marker, a, b, c, routed, dependencies, deferredResume, completedResume,
      ordinaryRelease, waitingScreenshot, terminalScreenshot };
    evidence.writeJson('queued-requests-result', result);
    return result;
  } finally {
    database?.close();
    for (const receipt of held) {
      const current = adapter.routerSearchTurns().find(turn => turn.channel_id === receipt.channel_id && turn.message_ts === receipt.message_ts);
      if (current?.status === 'running') await post(receipt.channel_id, 'CLEANUP_RELEASE', false, receipt.thread_ts);
    }
  }
}
