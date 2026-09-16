import type { SlackMessageFile } from "./attachments";
import { db, SETTLED_EXECUTION_SQL, type SessionRow } from "./state";
import { visibleSlackRootSql } from "./slack-thread-identity";
import { retryTransientDatabaseOperation } from "./durable-notice-worker";
import { slackTimestampUs, slackTimestampUsSql } from "./router-search-index";
import { slackThreadPermalink } from "./slack-links";
import { type RoutedProviderSelection } from "./provider-continuation";
import { sessionMetadata } from "./session-inputs";

export type ExecutionReference = { turn_id: number; channel_id: string; root_ts: string };
export class RoutedAdmissionHeld extends Error {}
export type RoutedRequest = {
  source: { channel_id: string; message_ts: string };
  action_id: string;
  destination: { channel_id: string; root_ts?: string | null };
  task: string;
  defer: boolean;
  depends_on: ExecutionReference[];
  files?: string[];
  provider?: string;
  title?: string;
  expected_session_id?: number;
};
type AcceptedRoutedRequest = RoutedRequest & { provider_selection?: RoutedProviderSelection };
export type RoutedInput = {
  channel: string; channelName?: string; threadTs: string; userMsgTs: string;
  user: string; text: string; files?: SlackMessageFile[];
  clientMessageId?: string;
};
type RequestRow = {
  request_id: string; channel_id: string; payload_json: string; payload_hash: string;
  requested_by: string; status: string; owner_instance_id: string;
  receipt_json: string | null; publication_json: string | null; message_ts: string | null;
  turn_id: number | null; error: string | null;
};
export type RoutedAdmission = {
  routedRequestId: string; waitRequested: boolean; dependencyTurnIds: number[];
  providerOverride?: RoutedProviderSelection["provider"];
  modelOverride?: string;
  forceNewSession?: boolean;
  expectedSessionId?: number;
  sessionTitle?: string;
};
type Dependencies = {
  instanceId: string;
  admit(input: RoutedInput, routing?: RoutedAdmission): Promise<unknown>;
  isOwnerAlive(instanceId: string): boolean;
  workspaceUrl?(): string | null;
  onError(error: unknown): void;
  onChanged?(): void;
};

export const RETIRED_SLACK_ROUTING = 'Agent Slack publication is retired. Use router-actions.sh sessions with the common native owner.';
const UNCERTAIN_LEGACY_DELIVERY = 'Legacy Slack delivery requires owner reconciliation; no publication or provider input was replayed.';

function requireTimestamp(value: string) {
  if (slackTimestampUs(value) === null) throw new Error("An exact Slack timestamp string is required.");
}

export function resolveRequestChannel(value: string) {
  const rows = db.query("SELECT slack_channel_id FROM channels WHERE slack_channel_id=? OR slack_channel_name=?")
    .all(value, value.replace(/^#/, "")) as Array<{ slack_channel_id: string }>;
  if (rows.length !== 1) throw new Error("Unknown or ambiguous managed channel.");
  return rows[0]!.slack_channel_id;
}

export function lookupExecutions(input: { channel: string; beforeTs: string; rootTs?: string; sessionId?: number; turnId?: number }, workspaceUrl?: string | null) {
  const channel = resolveRequestChannel(input.channel);
  requireTimestamp(input.beforeTs);
  if (input.rootTs) requireTimestamp(input.rootTs);
  for (const value of [input.sessionId, input.turnId]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error("Invalid execution/session ID.");
  }
  return db.transaction(() => {
    const scope = `FROM turns prerequisite JOIN sessions session ON session.id=prerequisite.session_id
      LEFT JOIN channels channel ON channel.slack_channel_id=session.slack_channel_id
      LEFT JOIN slack_user_input_claims claim ON claim.slack_channel_id=session.slack_channel_id
        AND claim.slack_user_msg_ts=prerequisite.slack_user_msg_ts
      WHERE session.slack_channel_id=? AND ${slackTimestampUsSql('prerequisite.slack_user_msg_ts')}<?
        AND prerequisite.turn_kind IN ('slack_user', 'comparison')
        AND (? IS NULL OR ${visibleSlackRootSql('prerequisite', 'session')}=?)
        AND (? IS NULL OR prerequisite.session_id=?) AND (? IS NULL OR prerequisite.id=?)`;
    const parameters = [channel, slackTimestampUs(input.beforeTs), input.rootTs ?? null, input.rootTs ?? null,
      input.sessionId ?? null, input.sessionId ?? null, input.turnId ?? null, input.turnId ?? null];
    if ((input.rootTs || input.sessionId !== undefined || input.turnId !== undefined)
      && !db.query(`SELECT 1 ${scope} LIMIT 1`).get(...parameters)) {
      throw new Error("Execution selector is unknown or does not match the channel, root, session, and source cutoff.");
    }
    const executions = db.query(`SELECT prerequisite.id AS turn_id, session.slack_channel_id AS channel_id,
      ${visibleSlackRootSql('prerequisite', 'session')} AS root_ts,
      prerequisite.slack_user_msg_ts AS message_ts, prerequisite.session_id,
      prerequisite.user_text AS request, prerequisite.status, prerequisite.delivery_status,
      session.provider_id, session.agent_session_uuid, (${SETTLED_EXECUTION_SQL}) AS settled
      ${scope}
        AND (? IS NOT NULL OR NOT (${SETTLED_EXECUTION_SQL}))
      ORDER BY prerequisite.id`).all(...parameters, input.turnId ?? null);
    const unresolved = db.query(`SELECT request_id, status FROM routed_requests WHERE channel_id=?
      AND status IN ('accepted', 'publishing', 'confirmed', 'parked', 'held', 'uncertain')`).all(channel);
    return { channel_id: channel, before_ts: input.beforeTs, complete: unresolved.length === 0,
      executions: executions.map((execution: any) => ({ ...execution,
        permalink: slackThreadPermalink(workspaceUrl, execution.channel_id, execution.root_ts) })),
      unresolved_publications: unresolved };
  })();
}

export function readRoutedRequest(id: string) {
    const row = db.query("SELECT * FROM routed_requests WHERE request_id=?").get(id) as RequestRow | null;
    if (!row) throw new Error("Unknown routed request.");
    const session = row.turn_id === null ? null : db.query('SELECT session.* FROM sessions session JOIN turns turn ON turn.session_id=session.id WHERE turn.id=?').get(row.turn_id) as SessionRow|null;
    const selection = (JSON.parse(row.payload_json) as AcceptedRoutedRequest).provider_selection;
    const unresolved=!['admitted','failed'].includes(row.status);
    const explanation=unresolved && row.status!=='uncertain'
      ? `${UNCERTAIN_LEGACY_DELIVERY}${row.error ? ` Previous diagnostic: ${row.error}` : ''}` : row.error;
    return { request_id: id, status: unresolved?'uncertain':row.status, turn_id: row.turn_id, error: explanation,
      ...(session ? { session: { id: `concierge:${session.id}`, title: sessionMetadata(session).title ?? null } } : {}),
      ...(selection ? { provider_selection: { alias: selection.alias, provider: selection.provider, model: selection.model || null,
        reasoning_effort: selection.reasoning_effort || null,
        continuation_from: selection.continuation?.rootTs || null } } : {}),
      ...(row.receipt_json ? JSON.parse(row.receipt_json) : {}) };
  }


export class RoutedRequestCoordinator {
  private readonly owners = new Map<string, Promise<unknown>>();
  private readonly pendingInputs = new Set<Promise<unknown>>();
  private stopped = false;
  constructor(private readonly dependencies: Dependencies) {}

  private owned<T>(channel: string, action: () => Promise<T>): Promise<T> {
    const previous = this.owners.get(channel) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.owners.set(channel, next);
    void next.finally(() => {
      if (this.owners.get(channel) === next) this.owners.delete(channel);
    }).catch(() => {});
    return next;
  }

  private row(id: string): RequestRow {
    const row = db.query("SELECT * FROM routed_requests WHERE request_id=?").get(id) as RequestRow | null;
    if (!row) throw new Error("Unknown routed request.");
    return row;
  }

  result(id: string) { return readRoutedRequest(id); }

  async submit(_input: RoutedRequest): Promise<never> {
    throw new Error(RETIRED_SLACK_ROUTING);
  }

  receive(input: RoutedInput) {
    const received = retryTransientDatabaseOperation({
      operation: () => db.query("INSERT INTO routed_input_events VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
        .run(input.channel, input.userMsgTs, JSON.stringify(input)),
    }).then(() => {
      if (!this.stopped) return this.owned(input.channel, () => this.flush(input.channel));
    });
    this.pendingInputs.add(received);
    void received.finally(() => this.pendingInputs.delete(received)).catch(() => {});
    return received;
  }

  private async flush(channel: string) {
    const events = db.query(`SELECT message_ts, input_json FROM routed_input_events WHERE channel_id=? ORDER BY ${slackTimestampUsSql('message_ts')}`)
      .all(channel) as Array<{ message_ts: string; input_json: string }>;
    for (const event of events) {
      if (this.stopped) return;
      const input=JSON.parse(event.input_json) as RoutedInput;
      // A late Slack echo is evidence of the retired effect, never fresh human input.
      const routed = db.query('SELECT request_id FROM routed_requests WHERE channel_id=? AND (message_ts=? OR request_id=?)')
        .get(channel,event.message_ts,input.clientMessageId??null) as {request_id:string}|null;
      if (routed) { this.retainUncertain(routed.request_id); continue; }
      await this.dependencies.admit(input);
      db.query('DELETE FROM routed_input_events WHERE channel_id=? AND message_ts=?').run(channel,event.message_ts);
      this.dependencies.onChanged?.();
    }
  }

  private retainUncertain(id: string) {
    db.query("UPDATE routed_requests SET status='uncertain',error=CASE WHEN error IS NULL THEN ? ELSE error || char(10) || ? END WHERE request_id=? AND status NOT IN ('admitted','failed','uncertain')")
      .run(UNCERTAIN_LEGACY_DELIVERY,UNCERTAIN_LEGACY_DELIVERY,id);
  }

  async recover() {
    const requests = db.query("SELECT * FROM routed_requests WHERE status IN ('accepted', 'publishing', 'confirmed', 'parked', 'held', 'uncertain') ORDER BY rowid").all() as RequestRow[];
    for (const row of requests) {
      if (row.owner_instance_id !== this.dependencies.instanceId && this.dependencies.isOwnerAlive(row.owner_instance_id)) {
        throw new Error("A live prior process still owns routed publication admission.");
      }
      this.retainUncertain(row.request_id);
    }
    const channels = db.query("SELECT DISTINCT channel_id FROM routed_input_events").all() as Array<{ channel_id: string }>;
    for (const channel of channels) await this.owned(channel.channel_id, () => this.flush(channel.channel_id));
  }

  recoverRequest(id: string) {
    this.row(id);
    this.retainUncertain(id);
    return Promise.resolve(this.result(id));
  }

  recoverUnsentReturn(id: string) {
    return this.recoverRequest(id);
  }

  async stop() {
    this.stopped = true;
    await Promise.allSettled([...this.owners.values(), ...this.pendingInputs]);
  }
}
