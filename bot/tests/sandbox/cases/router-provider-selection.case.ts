import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import type { LaneFixtureIdentities } from "../../../scripts/sandbox-provision";
import type { LiveTypedTurnAdapter } from "../adapters/live-typed-turn";
import type { TypedTurnPostReceipt } from "./typed-turn.case";
import { assertBrowserRequestMatchesLane, type SandboxBrowser } from "../support/browser";
import type { SandboxEvidenceWriter } from "../support/evidence";
import { routerSearchResponseTarget } from "./router-search.case";

export async function runRouterProviderSelectionCase(options: {
  lane: LaneFixtureIdentities; workspaceDomain: string; runId: string;
  brokenMarkerPath: string;
  adapter: LiveTypedTurnAdapter; browser: SandboxBrowser; evidence: SandboxEvidenceWriter;
}) {
  const { adapter, lane, evidence } = options;
  if (!existsSync(options.brokenMarkerPath)) throw new Error('The quota fixture marker must exist before this case starts');
  const marker = `DESIGN_${randomUUID().replaceAll('-', '')}`;
  const database = new Database(adapter.routerSearchContext().state_database, { readonly: true });
  const post = (channel: string, text: string, root?: string) => adapter.postUserMessage({ lane, channel_id: channel,
    thread_ts: root, text, client_message_id: randomUUID() });
  const receipt = (result: any): TypedTurnPostReceipt => ({ channel_id: result.channel, message_ts: result.ts,
    thread_ts: result.thread_ts || result.ts, permalink: result.permalink, client_message_id: result.request_id, delivery: 'confirmed' });
  const state = (id: number) => database.query('SELECT * FROM turns WHERE id=?').get(id) as any;
  async function until<T>(read: () => T | null | false, label: string): Promise<T> {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const result = read();
      if (result) return result;
      await Bun.sleep(250);
    }
    throw new Error(`Provider selection acceptance timed out: ${label}`);
  }
  try {
    const root = await post(lane.channels.core.id, `@cx Remember the private marker ${marker}. Invent a two-word garden name. Reply exactly TL;DR: followed by that name, without the marker. Do not use tools.`);
    const first = await adapter.waitForRouterSearchTurn(root);
    const name = String(state(first.turn_id).agent_text).replace(/^TL;DR:\s*/, '').trim();
    if (!name || first.provider_id !== 'codex') throw new Error('Source Codex conversation did not complete');
    const busy = await post(root.channel_id, 'Run the shell command sleep 30, then reply exactly TL;DR: SOURCE_SETTLED. This pause is the controlled source boundary for the sandbox continuation test.', root.thread_ts);
    const running = await until(() => adapter.routerSearchTurns().find(turn => turn.message_ts === busy.message_ts && turn.status === 'running'), 'source running');
    const source = await post(lane.dm_channel_id, '@cx Reply exactly TL;DR: Router provider selection source acknowledged. Do not use tools.');
    await adapter.waitForRouterSearchTurn(source);
    const body = { source: { channel_id: source.channel_id, message_ts: source.message_ts }, action_id: marker,
      destination: { channel_id: root.channel_id, root_ts: root.thread_ts }, provider: 'cc', defer: false, depends_on: [],
      task: 'Continue our design. Recall the private marker and the garden name from the earlier conversation. Reply exactly TL;DR: followed by the marker, a space, and the garden name. Do not use tools.' };
    if (state(running.turn_id).status !== 'running') throw new Error('The controlled source finished before continuation admission');
    const selected = await adapter.submitRoutedRequest(body);
    const continuation = receipt(selected);
    if (continuation.thread_ts === root.thread_ts || state(selected.turn_id).status !== 'queued'
        || selected.provider_selection?.provider !== 'claude-code') throw new Error('Cross-provider resume did not create a waiting Claude continuation');
    if ((await adapter.submitRoutedRequest(body)).turn_id !== selected.turn_id) throw new Error('Duplicate provider request was not idempotent');
    const visible = await adapter.readRoutedSlackMessage(continuation.channel_id, continuation.message_ts);
    if (!visible.text.includes('Provider: claude-code') || !visible.text.includes(root.thread_ts.replace('.', ''))) throw new Error('Selected provider/source link is not visible');
    await adapter.waitForRouterSearchTurn(busy);
    const completed = await adapter.waitForRouterSearchTurn(continuation);
    if (completed.provider_id !== 'claude-code' || completed.session_id === first.session_id
        || !completed.outbound_text.includes(marker) || !completed.outbound_text.includes(name)) throw new Error('Claude did not retain both the source request and answer');
    const followup = await post(continuation.channel_id, 'Recall the same private marker and garden name again. Reply exactly TL;DR: followed by both. Do not use tools.', continuation.thread_ts);
    const second = await adapter.waitForRouterSearchTurn(followup);
    if (second.provider_session_uuid !== completed.provider_session_uuid || !second.outbound_text.includes(marker) || !second.outbound_text.includes(name)) throw new Error('Later replies did not stay in the Claude continuation');
    const texts = await adapter.fetchBotThreadTexts({ lane, receipt: continuation });
    if (texts.filter(text => text.startsWith('TL;DR:') && text.includes(marker)).length !== 2) throw new Error('Later progress duplicated or overwrote cumulative responses');

    const exhausted = await adapter.submitRoutedRequest({ ...body, action_id: `${marker}_quota`,
      destination: { channel_id: lane.channels.core.id }, task: `SANDBOX_ROUTER_PROVIDER_EXHAUSTED: Reply exactly TL;DR: ${marker}_RECOVERED. Do not use tools.` });
    const quotaReceipt = receipt(exhausted);
    const quota = await until(() => {
      const row = state(exhausted.turn_id);
      return row?.status === 'parked' && row.status_projection_status === 'delivered' ? row : null;
    }, 'visible quota exhaustion');
    const quotaTexts = await adapter.fetchBotThreadTexts({ lane, receipt: quotaReceipt });
    if (quota.dispatch_failure_class !== 'parked_terminal' || !quotaTexts.some(text => text.includes('Claude usage is exhausted') && text.includes('Retry after usage resets')))
      throw new Error('Quota exhaustion did not become a visible actionable pause');
    rmSync(options.brokenMarkerPath);
    const recoveryInput = await post(quotaReceipt.channel_id, `Reply exactly TL;DR: ${marker}_AFTER_RECOVERY. Do not use tools.`, quotaReceipt.thread_ts);
    await until(() => { const row = state(exhausted.turn_id); return row.status === 'done' && row.dispatch_attempt >= 2 ? row : null; }, 'same quota turn recovered');
    const recovered = await adapter.waitForRouterSearchTurn(quotaReceipt);
    const afterRecovery = await adapter.waitForRouterSearchTurn(recoveryInput);
    if (recovered.turn_id !== exhausted.turn_id || !recovered.outbound_text.includes(`${marker}_RECOVERED`)
        || !afterRecovery.outbound_text.includes(`${marker}_AFTER_RECOVERY`)) throw new Error('Quota recovery did not resume the same request and drain its successor');
    await adapter.waitForRunSettled();
    const request = { lane_id: lane.lane_id, workspace_domain: options.workspaceDomain,
      browser_namespace: lane.browser.namespace, browser_profile_path: lane.browser.profile_path,
      phase: 'terminal' as const, ...routerSearchResponseTarget(followup, second.response_message_ts, marker),
      required_text: [marker, name], assertions: ['The Claude continuation preserves the earlier Codex request and answer across two replies.'] };
    assertBrowserRequestMatchesLane(request, lane);
    const browser = evidence.verifyScreenshot(await options.browser.capture(request, evidence));
    const result = { case_id: 'router-provider-selection', status: 'passed', lane_id: lane.lane_id, run_id: options.runId,
      ...adapter.runSourceEvidence(), marker, name, root, first, busy, source, selected, visible, completed, followup, second,
      quota: { receipt: exhausted, status: quota.status, failure_class: quota.dispatch_failure_class, texts: quotaTexts, recovered, afterRecovery }, browser };
    evidence.writeJson('router-provider-selection.json', result);
    return result;
  } finally { database.close(); }
}

export async function runRouterIntentSelectionCase(options: {
  lane: LaneFixtureIdentities; workspaceDomain: string; runId: string;
  adapter: LiveTypedTurnAdapter; browser: SandboxBrowser; evidence: SandboxEvidenceWriter;
}) {
  const { adapter, lane, evidence } = options;
  const marker = `INTENT_${randomUUID().replaceAll('-', '')}`;
  const database = new Database(adapter.routerSearchContext().state_database, { readonly: true });
  const post = (channel: string, text: string) => adapter.postUserMessage({ lane, channel_id: channel,
    text, client_message_id: randomUUID() });
  const setup = await post(lane.channels.core.id, '@cx Reply exactly TL;DR: Garden project fixture ready. Do not use tools.');
  await adapter.waitForRouterSearchTurn(setup);
  const results: unknown[] = [];
  try {
    for (const override of [false, true]) {
      const taskMarker = `${marker}_${override ? 'OVERRIDE' : 'DEFAULT'}`;
      const source = await post(lane.dm_channel_id, [
        '@cx Act as the DM router for this clearly NEW project request. Use the Concierge-supplied routing and provider-selection contract.',
        `Destination: ${lane.channels.core.name} (${lane.channels.core.id}). Search globally before choosing the channel, then post this new work once.`,
        `The only allowed helper prefix is: ${adapter.routerSearchContext().helper_command}`,
        'Use that full prefix for every call. Never use the installed production helper, raw Slack API, or inspect a database yourself.',
        ...(override ? ['The user explicitly chooses Codex for this brainstorming request.'] : []),
        `Forward this exact task: Brainstorm the garden homepage. For this routing fixture, first just reply exactly TL;DR: ${taskMarker}. Do not use tools.`,
        'After an admitted receipt, reply with TL;DR: Routed followed by the returned permalink and chosen provider. Do not send a separate audit or reaction.',
      ].join('\n'));
      const router = await adapter.waitForRouterSearchTurn(source);
      const requests = database.query('SELECT * FROM routed_requests WHERE source_channel=? AND source_message_ts=?')
        .all(source.channel_id, source.message_ts) as any[];
      if (requests.length !== 1 || requests[0].status !== 'admitted') throw new Error('Router did not dispatch exactly one admitted request');
      const row = requests[0];
      const payload = JSON.parse(row.payload_json);
      if (payload.provider_selection?.provider !== (override ? 'codex' : 'claude-code') || payload.destination.root_ts !== null)
        throw new Error('Router classification did not honor design preference and explicit user override');
      const routed = JSON.parse(row.receipt_json);
      const destination: TypedTurnPostReceipt = { channel_id: routed.channel, message_ts: routed.ts,
        thread_ts: routed.thread_ts || routed.ts, permalink: routed.permalink, client_message_id: row.request_id, delivery: 'confirmed' };
      const completed = await adapter.waitForRouterSearchTurn(destination);
      if (!completed.outbound_text.includes(taskMarker) || completed.provider_id !== payload.provider_selection.provider)
        throw new Error('Router-selected provider did not deliver the exact destination result');
      results.push({ source, router, requested_provider: payload.provider, selection: payload.provider_selection, destination, completed });
    }
    evidence.writeJson('router-intent-selection.json', { case_id: 'router-intent-selection', status: 'passed',
      lane_id: lane.lane_id, run_id: options.runId, ...adapter.runSourceEvidence(), results });
    return results;
  } finally { database.close(); }
}
