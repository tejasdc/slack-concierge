import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { join, resolve } from 'node:path';
import type { LaneFixtureIdentities } from '../../../scripts/sandbox-provision';
import type { LiveTypedTurnAdapter } from '../adapters/live-typed-turn';
import type { TypedTurnPostReceipt } from '../cases/typed-turn.case';
import type { SandboxEvidenceWriter } from './evidence';
import { BunAgentBrowserCommandRunner, type AgentBrowserCommandRunner } from './browser';

const projectRoot = resolve(import.meta.dir, '../../../..');

export async function activateSessionCommunicationBrowser(lane: LaneFixtureIdentities,
  runner: AgentBrowserCommandRunner = new BunAgentBrowserCommandRunner()) {
  const command = async (...args: string[]) => {
    const result = await runner.run([...args, '--session', lane.browser.namespace, '--profile', lane.browser.profile_path, '--json']);
    const parsed = JSON.parse(result.stdout);
    if (result.exitCode || !parsed.success) throw new Error(`Session browser activation failed: ${parsed.error ?? result.stderr}`);
    return parsed.data;
  };
  const { tabs } = await command('tab', 'list');
  const active = tabs.filter((tab: { active: boolean }) => tab.active);
  if (active.length !== 1 || !/^t[1-9][0-9]*$/.test(active[0].tabId)) throw new Error('Session browser requires exactly one identified active tab.');
  const selected = await command('tab', active[0].tabId);
  if (selected.tabId !== active[0].tabId) throw new Error('Session browser selected a different tab.');
  await command('wait', '--fn', "document.visibilityState === 'visible'");
  const { result: visibility } = await command('eval', 'document.visibilityState');
  if (visibility !== 'visible') throw new Error('Session browser tab is still hidden.');
  return { tab_id: selected.tabId, visibility };
}

export type CommunicationRequestObservation = {
  request_id: string; source_session_id: number; target_session_id: number; target_turn_id: number | null;
  source_channel: string; source_message_ts: string; target_channel: string; target_root_ts: string;
  routed_request_id: string | null; input_kind: string | null; status: string; outcome: string | null;
  result_json: string | null; due_at_ms: number; overdue_at_ms: number | null;
};
export type CommunicationEventObservation = {
  event_id: string; request_id: string; kind: string; status: string; error: string | null; payload_json: string; routed_request_id: string | null;
};
export type CommunicationInputObservation = {
  request_id: string; channel: string; message_ts: string; root_ts: string; turn_id: number;
  kind: string; user_id: string; replay_text: string | null; steering_status: string | null;
  turn_status: string; session_id: number; provider_session_uuid: string | null; user_text: string;
  provider_input_acknowledged_at: string | null; input_context_received_by_turn_id: number | null;
};

export class SessionCommunicationSandbox {
  private readonly database: Database;
  readonly statePath: string;
  constructor(readonly lane: LaneFixtureIdentities, readonly adapter: LiveTypedTurnAdapter,
    private readonly evidence: SandboxEvidenceWriter) {
    this.statePath = adapter.routerSearchContext().state_database;
    this.database = new Database(this.statePath);
    this.database.exec('PRAGMA busy_timeout=1000');
  }
  close() { this.database.close(); }
  private bound() { this.adapter.runSourceEvidence(); }
  one<T>(sql: string, ...parameters: Array<string | number>) {
    this.bound();
    return this.database.query(sql).get(...parameters) as T | null;
  }
  request(id: string) { return this.one<CommunicationRequestObservation>('SELECT * FROM session_communication_requests WHERE request_id=?', id); }
  events(id: string) {
    this.bound();
    return this.database.query('SELECT event_id,request_id,kind,status,error,payload_json,routed_request_id FROM session_communication_events WHERE request_id=? ORDER BY rowid').all(id) as CommunicationEventObservation[];
  }
  input(routedRequestId: string) {
    return this.one<CommunicationInputObservation>(`SELECT routed.request_id, routed.channel_id AS channel,
      routed.message_ts, claim.reply_thread_ts AS root_ts, claim.turn_id, claim.kind, claim.user_id,
      COALESCE(steering.replay_text,turn.replay_text) AS replay_text, steering.status AS steering_status,
      turn.status AS turn_status, turn.session_id, session.agent_session_uuid AS provider_session_uuid, claim.user_text,
      turn.provider_input_acknowledged_at,turn.input_context_received_by_turn_id
      FROM routed_requests routed JOIN slack_user_input_claims claim
        ON claim.slack_channel_id=routed.channel_id AND claim.slack_user_msg_ts=routed.message_ts
      JOIN turns turn ON turn.id=claim.turn_id JOIN sessions session ON session.id=turn.session_id
      LEFT JOIN turn_steering_messages steering ON steering.turn_id=turn.id AND steering.slack_user_msg_ts=routed.message_ts
      WHERE routed.request_id=?`, routedRequestId);
  }
  async until<T>(description: string, read: () => T | null | false | undefined, timeoutMs = 60_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = read();
      if (value) return value;
      await Bun.sleep(100);
    }
    throw new Error(`Session communication acceptance timed out: ${description}`);
  }
  async received(routedRequestId: string, expected: { kind: 'steering' | 'turn'; session: number; turn?: number }) {
    const input = await this.until('exact provider input ready', () => {
      const row = this.input(routedRequestId);
      if (!row || row.turn_status !== 'running' || !row.replay_text
        || (expected.kind === 'turn' && (!row.provider_session_uuid || (!row.provider_input_acknowledged_at && !row.input_context_received_by_turn_id)))
        || (row.kind === 'steering' && row.steering_status !== 'sent')) return null;
      return row;
    });
    if (input.kind !== expected.kind || input.session_id !== expected.session || (expected.turn !== undefined && input.turn_id !== expected.turn)
      || input.user_id !== this.lane.installer_user_id || input.turn_status !== 'running') {
      throw new Error(`Session input ownership/lifecycle mismatch: ${JSON.stringify(input)}`);
    }
    const slack = await this.adapter.readRoutedSlackMessage(input.channel, input.message_ts);
    if (slack.user !== this.lane.installer_user_id || slack.thread_ts !== input.root_ts) throw new Error('Session input did not identify the exact user-authored sandbox Slack reply.');
    return { input, slack };
  }
  async command(name: string, args: string[], source: Pick<TypedTurnPostReceipt, 'channel_id' | 'message_ts'>, label: string) {
    this.bound();
    const separator = args.indexOf('--');
    const flags = ['--source-channel', source.channel_id, '--source-ts', source.message_ts];
    const completeArgs = separator < 0 ? [...args, ...flags] : [...args.slice(0, separator), ...flags, ...args.slice(separator)];
    const child = Bun.spawn(['bash', join(projectRoot, 'systemd/router-actions.sh'), 'sessions', name, ...completeArgs], {
      env: { ...process.env, CONCIERGE_STATE_DB: this.statePath, CONCIERGE_ROUTER_BOT_DIR: join(projectRoot, 'bot'),
        CONCIERGE_SLACK_CONFIG: '/must-not-read-slack-config-for-session-communication' }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exit_code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const result = JSON.parse(exit_code === 0 ? stdout : stderr);
    this.evidence.writeJson(`session-cli-${label}.json`, { command: name, source, args, exit_code, result });
    if (exit_code !== 0) throw new Error(`Session ${name} failed: ${JSON.stringify(result)}`);
    return result as any;
  }
  makeOverdue(requestId: string) {
    const before = this.request(requestId);
    if (!before || before.outcome || before.overdue_at_ms !== null) throw new Error('Overdue fixture does not identify one outstanding case request.');
    this.database.query('UPDATE session_communication_requests SET due_at_ms=? WHERE request_id=? AND outcome IS NULL AND overdue_at_ms IS NULL')
      .run(Date.now() - 1, requestId);
    return { before, after: this.request(requestId) };
  }
  holdIdleRequester(sessionId: number) {
    const before = this.one<{ id: number; status: string; active: number }>(`SELECT id,status,
      (SELECT count(*) FROM turns WHERE session_id=sessions.id AND status IN ('queued','running','delivering')) AS active FROM sessions WHERE id=?`, sessionId);
    if (!before || before.status === 'running' || before.status === 'archived' || before.active !== 0) throw new Error('Return hold fixture requires the exact idle requester.');
    this.database.query("UPDATE sessions SET status='archived' WHERE id=? AND status=?").run(sessionId, before.status);
    return { before, after: this.one<{ id: number; status: string }>('SELECT id,status FROM sessions WHERE id=?', sessionId) };
  }
  restoreRequester(before: { id: number; status: string }) {
    this.bound();
    const result = this.database.query("UPDATE sessions SET status=? WHERE id=? AND status='archived'").run(before.status, before.id);
    if (result.changes !== 1) throw new Error('The exact held requester changed before restoration.');
    return this.one<{ id: number; status: string }>('SELECT id,status FROM sessions WHERE id=?', before.id);
  }
  assertOutput(request: CommunicationRequestObservation, expectedTurn: number) {
    const result = JSON.parse(request.result_json!);
    const turn = this.one<{ agent_text: string; delivered_messages_json: string; delivery_status: string }>(`SELECT turn.agent_text,turn.delivery_status,
      (SELECT json_group_array(json_object('chunk_index',chunk_index,'slack_ts',slack_ts)) FROM (
        SELECT chunk_index,slack_ts FROM turn_delivery_chunks WHERE turn_id=turn.id
          AND delivered_at IS NOT NULL AND slack_ts IS NOT NULL ORDER BY chunk_index)) AS delivered_messages_json
      FROM turns turn WHERE turn.id=?`, expectedTurn);
    const messages = turn ? JSON.parse(turn.delivered_messages_json) as Array<{ chunk_index: number; slack_ts: string }> : [];
    if (!turn || result.output?.turn_id !== expectedTurn || result.output.channel_id !== request.target_channel
      || result.output.root_ts !== request.target_root_ts || !messages[0]?.slack_ts || result.output.message_ts !== messages[0].slack_ts
      || JSON.stringify(result.output.messages) !== JSON.stringify(messages) || result.output.delivery_status !== turn.delivery_status
      || result.output.sha256 !== createHash('sha256').update(turn.agent_text).digest('hex')) {
      throw new Error('Unanswered return did not retain the exact completed output reference.');
    }
    return result.output;
  }
  async reload(runId: string) {
    this.bound();
    const child = Bun.spawn(['bash', join(projectRoot, 'bot/scripts/sandbox-lane-control.sh'), 'reload', '--lane', this.lane.lane_id.replace('lane-', ''), '--run-id', runId], {
      stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exit_code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const receipt = { lane_id: this.lane.lane_id, run_id: runId, exit_code, stdout, stderr };
    this.evidence.writeJson('session-communication-reload.json', receipt);
    if (exit_code !== 0) throw new Error(`Exact sandbox reload failed: ${stderr}`);
    return receipt;
  }
  async activateBrowser(label: string) {
    this.bound();
    const receipt = await activateSessionCommunicationBrowser(this.lane);
    this.evidence.writeJson(`session-communication-browser-${label}.json`, receipt);
    return receipt;
  }
  async stopThroughSlack(turnId: number) {
    const turn = this.one<{ id: number; session_id: number; status: string; progress_stream_ts: string }>('SELECT id,session_id,status,progress_stream_ts FROM turns WHERE id=?', turnId);
    if (!turn || turn.status !== 'running' || !turn.progress_stream_ts) throw new Error('Native Stop requires an exact running requester turn.');
    await this.activateBrowser(`stop-${turnId}`);
    const runner = new BunAgentBrowserCommandRunner();
    const command = async (...args: string[]) => {
      this.bound();
      const result = await runner.run([...args, '--session', this.lane.browser.namespace, '--profile', this.lane.browser.profile_path, '--json']);
      if (result.exitCode) throw new Error(`Stop browser command failed: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      if (!parsed.success) throw new Error(`Stop browser command failed: ${parsed.error}`);
      return args[0] === 'eval' && parsed.data && 'result' in parsed.data ? parsed.data.result : parsed.data;
    };
    await command('open', `https://app.slack.com/client/${this.lane.browser.client_workspace_id}/${this.lane.dm_channel_id}`);
    const homeSelector = 'button[data-qa="app_home"]';
    await command('wait', homeSelector);
    await command('click', homeSelector);
    await command('wait', `${homeSelector}[aria-selected="true"]`);
    const selector = `button[data-qa-block-id="agent_session_actions_${turn.session_id}"][data-qa-action-id="agent_sessions_home_stop"]`;
    let target: any;
    for (let attempt = 0; attempt < 30; attempt++) {
      target = await command('eval', `(() => { const home=document.querySelector(${JSON.stringify(homeSelector)}); const buttons=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(button=>button.innerText.trim()==='Stop'); return {homeSelected:home?.getAttribute('aria-selected')==='true',buttons:buttons.length,visible:buttons.length===1&&buttons[0].getBoundingClientRect().height>0}; })()`);
      if (target.homeSelected && target.buttons === 1 && target.visible) break;
      await Bun.sleep(500);
    }
    this.evidence.writeJson('session-communication-native-stop-before.json', { turn, selector, target, snapshot: await command('snapshot', '-i') });
    if (!target?.homeSelected || target.buttons !== 1 || !target.visible) throw new Error('App Home did not expose the exact session native Stop control.');
    await command('screenshot', this.evidence.path('session-communication-native-stop-before.png'));
    await command('eval', `(() => { const buttons=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(button=>button.innerText.trim()==='Stop'); if(buttons.length!==1)throw new Error('Stop target changed'); buttons[0].click(); return {clicked:true}; })()`);
    const stopped = await this.until('native Slack Stop acknowledged and completed', () => {
      const row = this.one<{ id: number; session_id: number; status: string; stop_requested_at: string | null }>('SELECT id,session_id,status,stop_requested_at FROM turns WHERE id=?', turnId);
      return row?.stop_requested_at && row.status === 'cancelled' ? row : null;
    });
    this.evidence.writeJson('session-communication-native-stop-after.json', { stopped, snapshot: await command('snapshot', '-i') });
    return stopped;
  }
  deadlines() {
    return this.one<{ outstanding: number; eligible_deadlines: number; undelivered_events: number; pending_events: number; ambiguous_events: number }>(`SELECT
      (SELECT count(*) FROM session_communication_requests WHERE outcome IS NULL) AS outstanding,
      (SELECT count(*) FROM session_communication_requests WHERE outcome IS NULL AND overdue_at_ms IS NULL) AS eligible_deadlines,
      (SELECT count(*) FROM session_communication_events WHERE status<>'received') AS undelivered_events,
      (SELECT count(*) FROM session_communication_events WHERE status NOT IN ('received','ambiguous','failed')) AS pending_events,
      (SELECT count(*) FROM session_communication_events WHERE status='ambiguous') AS ambiguous_events`)!;
  }
}
