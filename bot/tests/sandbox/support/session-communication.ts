import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { join, resolve } from 'node:path';
import type { LaneFixtureIdentities } from '../../../scripts/sandbox-provision';
import type { LiveTypedTurnAdapter } from '../adapters/live-typed-turn';
import type { TypedTurnPostReceipt } from '../cases/typed-turn.case';
import type { SandboxEvidenceWriter } from './evidence';

const projectRoot = resolve(import.meta.dir, '../../../..');

export type CommunicationRequestObservation = {
  request_id: string; source_session_id: number; target_session_id: number; target_turn_id: number | null;
  source_channel: string; source_message_ts: string; target_channel: string; target_root_ts: string;
  routed_request_id: string | null; input_kind: string | null; status: string; outcome: string | null;
  result_json: string | null; due_at_ms: number; overdue_at_ms: number | null;
};
export type CommunicationEventObservation = {
  event_id: string; request_id: string; kind: string; status: string; payload_json: string; routed_request_id: string | null;
};
export type CommunicationInputObservation = {
  request_id: string; channel: string; message_ts: string; root_ts: string; turn_id: number;
  kind: string; user_id: string; replay_text: string | null; steering_status: string | null;
  turn_status: string; session_id: number; provider_session_uuid: string | null; user_text: string;
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
    return this.database.query('SELECT event_id,request_id,kind,status,payload_json,routed_request_id FROM session_communication_events WHERE request_id=? ORDER BY rowid').all(id) as CommunicationEventObservation[];
  }
  input(routedRequestId: string) {
    return this.one<CommunicationInputObservation>(`SELECT routed.request_id, routed.channel_id AS channel,
      routed.message_ts, claim.reply_thread_ts AS root_ts, claim.turn_id, claim.kind, claim.user_id,
      COALESCE(steering.replay_text,turn.replay_text) AS replay_text, steering.status AS steering_status,
      turn.status AS turn_status, turn.session_id, session.agent_session_uuid AS provider_session_uuid, claim.user_text
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
        || (expected.kind === 'turn' && !row.provider_session_uuid) || (row.kind === 'steering' && row.steering_status !== 'sent')) return null;
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
  deadlines() {
    return this.one<{ outstanding: number; eligible_deadlines: number; undelivered_events: number }>(`SELECT
      (SELECT count(*) FROM session_communication_requests WHERE outcome IS NULL) AS outstanding,
      (SELECT count(*) FROM session_communication_requests WHERE outcome IS NULL AND overdue_at_ms IS NULL) AS eligible_deadlines,
      (SELECT count(*) FROM session_communication_events WHERE status<>'admitted') AS undelivered_events`)!;
  }
}
