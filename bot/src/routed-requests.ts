import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { runRouterAction, RouterActionError, type FailureContext, type Receipt } from "../scripts/router-post";
import type { SlackMessageFile } from "./attachments";
import { db, getChannel, getSlackUserInputClaim, SETTLED_EXECUTION_SQL } from "./state";
import { resolveReplySession, visibleSlackRootSql } from "./slack-thread-identity";
import { retryTransientDatabaseOperation } from "./durable-notice-worker";
import { slackTimestampUs, slackTimestampUsSql } from "./router-search-index";
import { slackThreadPermalink } from "./slack-links";

export type ExecutionReference = { turn_id: number; channel_id: string; root_ts: string };
export type RoutedRequest = {
  source: { channel_id: string; message_ts: string };
  action_id: string;
  destination: { channel_id: string; root_ts?: string | null };
  task: string;
  defer: boolean;
  depends_on: ExecutionReference[];
  files?: string[];
};
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
};
type Dependencies = {
  instanceId: string;
  userToken: string;
  admit(input: RoutedInput, routing?: RoutedAdmission): Promise<unknown>;
  isOwnerAlive(instanceId: string): boolean;
  request?: typeof fetch;
  publish?: typeof runRouterAction;
  onError(error: unknown): void;
};

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
      AND status IN ('accepted', 'publishing', 'confirmed', 'parked')`).all(channel);
    return { channel_id: channel, before_ts: input.beforeTs, complete: unresolved.length === 0,
      executions: executions.map((execution: any) => ({ ...execution,
        permalink: slackThreadPermalink(workspaceUrl, execution.channel_id, execution.root_ts) })),
      unresolved_publications: unresolved };
  })();
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

  result(id: string) {
    const row = this.row(id);
    return { request_id: id, status: row.status, turn_id: row.turn_id, error: row.error,
      ...(row.receipt_json ? JSON.parse(row.receipt_json) : {}) };
  }

  async submit(input: RoutedRequest) {
    if (this.stopped) throw new Error("Concierge admission is stopping; retry the same request after restart.");
    if (!input || typeof input.task !== "string" || typeof input.defer !== "boolean"
      || !Array.isArray(input.depends_on) || (!input.defer && input.depends_on.length)
      || typeof input.action_id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.action_id)) {
      throw new Error("Invalid request: task, explicit defer flag, dependencies, and stable action_id are required.");
    }
    requireTimestamp(input.source?.message_ts);
    const source = getSlackUserInputClaim(input.source.channel_id, input.source.message_ts);
    if (!source?.user_id || !["turn", "steering"].includes(source.kind)) throw new Error("Source must identify an accepted Slack user input.");
    const channel = resolveRequestChannel(input.destination.channel_id);
    const target = getChannel(channel)!;
    if (target.mode === "silent") throw new Error("Destination channel is silent.");
    if (input.destination.root_ts) {
      requireTimestamp(input.destination.root_ts);
      const root = db.query(`SELECT 1 FROM turns turn JOIN sessions session ON session.id=turn.session_id
        LEFT JOIN channels channel ON channel.slack_channel_id=session.slack_channel_id
        LEFT JOIN slack_user_input_claims claim ON claim.slack_channel_id=session.slack_channel_id
          AND claim.slack_user_msg_ts=turn.slack_user_msg_ts
        WHERE session.slack_channel_id=? AND ${visibleSlackRootSql('turn', 'session')}=?`)
        .get(channel, input.destination.root_ts);
      const session = resolveReplySession(db, target, input.destination.root_ts).session;
      if (!root || !session || session.status === "archived") throw new Error("Destination root is not an established resumable thread.");
    }
    for (const reference of input.depends_on) {
      if (!Number.isSafeInteger(reference.turn_id) || reference.turn_id < 1) throw new Error("Invalid dependency execution ID.");
      const matching = db.query(`SELECT 1 FROM turns turn JOIN sessions session ON session.id=turn.session_id
        LEFT JOIN channels channel ON channel.slack_channel_id=session.slack_channel_id
        LEFT JOIN slack_user_input_claims claim ON claim.slack_channel_id=session.slack_channel_id
          AND claim.slack_user_msg_ts=turn.slack_user_msg_ts
        WHERE turn.id=? AND session.slack_channel_id=? AND ${visibleSlackRootSql('turn', 'session')}=?
        AND turn.turn_kind IN ('slack_user', 'comparison')
        AND ${slackTimestampUsSql('turn.slack_user_msg_ts')}<?`)
        .get(reference.turn_id, reference.channel_id, reference.root_ts, slackTimestampUs(input.source.message_ts));
      if (!matching) throw new Error("Dependency execution identity or source cutoff does not match the ledger.");
    }
    const files = (input.files || []).map(path => {
      if (typeof path !== "string" || !statSync(path).isFile()) throw new Error("Request attachment must be a regular local file.");
      return { filename: basename(path), bytes: readFileSync(path) };
    });
    if (!input.task.trim() && !files.length) throw new Error("Request has no task or attachments.");
    const payload = { source: { channel_id: input.source.channel_id, message_ts: input.source.message_ts },
      action_id: input.action_id, task: input.task, defer: input.defer,
      destination: { channel_id: channel, root_ts: input.destination.root_ts || null },
      depends_on: [...new Map(input.depends_on.map(dep => [dep.turn_id, dep])).values()].sort((a,b) => a.turn_id-b.turn_id),
      files: files.map(file => ({ filename: file.filename, sha256: createHash('sha256').update(file.bytes).digest('hex') })) };
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const id = db.transaction(() => {
      const previous = db.query("SELECT request_id, payload_hash FROM routed_requests WHERE source_channel=? AND source_message_ts=? AND action_id=?")
        .get(input.source.channel_id, input.source.message_ts, input.action_id) as RequestRow | null;
      if (previous) {
        if (previous.payload_hash !== hash) throw new Error("Idempotency conflict: the source/action already has a different request.");
        return previous.request_id;
      }
      const id = randomUUID();
      db.query(`INSERT INTO routed_requests (request_id, source_channel, source_message_ts, action_id, channel_id,
        payload_json, payload_hash, requested_by, owner_instance_id, publication_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.source.channel_id, input.source.message_ts, input.action_id, channel, JSON.stringify(payload), hash,
          source.user_id, this.dependencies.instanceId, JSON.stringify({ delivery: 'not_sent', channel, thread_ts: payload.destination.root_ts, file_ids: [] }));
      files.forEach((file, position) => db.query("INSERT INTO routed_request_files VALUES (?, ?, ?, ?)")
        .run(id, position, file.filename, file.bytes));
      return id;
    })();
    return this.owned(channel, async () => {
      await this.process(id);
      await this.flush(channel);
      return this.result(id);
    });
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

  private blocked(channel: string, except?: string) {
    return Boolean(db.query(`SELECT 1 FROM routed_requests WHERE channel_id=? AND request_id<>?
      AND status IN ('accepted', 'publishing', 'confirmed', 'parked')`).get(channel, except || ''));
  }

  private async flush(channel: string) {
    const recoverable = db.query(`SELECT request_id FROM routed_requests WHERE channel_id=? AND status='parked'
      AND EXISTS (SELECT 1 FROM routed_input_events event WHERE event.channel_id=routed_requests.channel_id
        AND json_extract(event.input_json, '$.clientMessageId')=routed_requests.request_id
        AND json_extract(event.input_json, '$.user')=routed_requests.requested_by) ORDER BY rowid`)
      .all(channel) as Array<{ request_id: string }>;
    for (const row of recoverable) await this.process(row.request_id);
    const accepted = db.query("SELECT request_id FROM routed_requests WHERE channel_id=? AND status='accepted' ORDER BY rowid")
      .all(channel) as Array<{ request_id: string }>;
    for (const row of accepted) await this.process(row.request_id);
    if (this.blocked(channel)) return;
    const events = db.query(`SELECT message_ts, input_json FROM routed_input_events WHERE channel_id=? ORDER BY ${slackTimestampUsSql('message_ts')}`)
      .all(channel) as Array<{ message_ts: string; input_json: string }>;
    for (const event of events) {
      if (this.stopped || this.blocked(channel)) return;
      await this.dependencies.admit(JSON.parse(event.input_json));
      db.query("DELETE FROM routed_input_events WHERE channel_id=? AND message_ts=?").run(channel, event.message_ts);
    }
  }

  private async slackMessage(receipt: Receipt, user: string): Promise<{ text: string; files: SlackMessageFile[] }> {
    const query = new URLSearchParams({ channel: receipt.channel, timestamp: receipt.ts });
    const response = await (this.dependencies.request || fetch)(`https://slack.com/api/reactions.get?${query}`, {
      headers: { Authorization: `Bearer ${this.dependencies.userToken}` },
    });
    const body: any = await response.json();
    if (!response.ok || !body.ok || body.channel !== receipt.channel || body.message?.ts !== receipt.ts || body.message.user !== user
      || (body.message.thread_ts || body.message.ts) !== (receipt.thread_ts || receipt.ts)) {
      throw new Error("Published request's exact Slack input is not yet readable.");
    }
    return { text: body.message.text || '', files: body.message.files || [] };
  }

  private async process(id: string) {
    let row = this.row(id);
    if (['admitted', 'failed'].includes(row.status)) return;
    if (row.owner_instance_id !== this.dependencies.instanceId && this.dependencies.isOwnerAlive(row.owner_instance_id)) {
      throw new Error('A live prior process still owns this publication.');
    }
    // An unresolved earlier publication owns this channel across process boundaries.
    const older = db.query(`SELECT 1 FROM routed_requests WHERE channel_id=? AND rowid<(SELECT rowid FROM routed_requests WHERE request_id=?)
      AND status IN ('accepted', 'publishing', 'confirmed', 'parked')`).get(row.channel_id, id);
    if (older) return;
    db.query('UPDATE routed_requests SET owner_instance_id=? WHERE request_id=?').run(this.dependencies.instanceId, id);
    const input = JSON.parse(row.payload_json) as RoutedRequest;
    const progress = (context: FailureContext) => {
      const previous = JSON.parse(this.row(id).publication_json!) as FailureContext;
      const delivery = previous.delivery === 'confirmed' || context.delivery === 'confirmed' ? 'confirmed'
        : previous.delivery === 'unknown' || context.delivery === 'unknown' ? 'unknown' : 'not_sent';
      const retained = { ...previous, ...context, delivery, ts: previous.ts || context.ts,
        file_ids: [...new Set([...previous.file_ids, ...context.file_ids])] };
      db.query("UPDATE routed_requests SET publication_json=?, message_ts=COALESCE(?, message_ts) WHERE request_id=?")
        .run(JSON.stringify(retained), retained.ts || null, id);
    };
    try {
      let receipt = row.receipt_json ? JSON.parse(row.receipt_json) as Receipt : null;
      const context = JSON.parse(row.publication_json!) as FailureContext;
      if (context.delivery === 'unknown' && !context.ts && !context.file_ids.length) {
        const matches = db.query(`SELECT message_ts FROM routed_input_events WHERE channel_id=?
          AND json_extract(input_json, '$.clientMessageId')=? AND json_extract(input_json, '$.user')=?`)
          .all(row.channel_id, id, row.requested_by) as Array<{ message_ts: string }>;
        if (matches.length === 1) { context.ts = matches[0]!.message_ts; progress(context); }
      }
      if (!receipt) {
        const action = { verb: input.destination.root_ts ? 'resume' as const : 'post' as const,
          channel: row.channel_id, threadTs: input.destination.root_ts || undefined, text: input.task, filePaths: [], fileIds: [] as string[] };
        const options = { channel: row.channel_id, token: this.dependencies.userToken, clientMessageId: id, onProgress: progress };
        const transport = this.dependencies.publish || runRouterAction;
        if (context.delivery !== 'not_sent') {
          if (!context.ts && !context.file_ids.length) {
            throw new Error("Publication outcome is ambiguous; exact receipt recovery is required before channel admission resumes.");
          }
          receipt = await transport({ ...action, verb: context.ts ? 'permalink' : 'resolve-upload',
            messageTs: context.ts, fileIds: context.file_ids }, this.dependencies.request, undefined, options);
        } else {
          db.query("UPDATE routed_requests SET status='publishing', owner_instance_id=? WHERE request_id=?")
            .run(this.dependencies.instanceId, id);
          const files = db.query("SELECT filename, bytes FROM routed_request_files WHERE request_id=? ORDER BY position")
            .all(id) as Array<{ filename: string; bytes: Uint8Array }>;
          receipt = await transport(action, this.dependencies.request, undefined, { ...options,
            files: files.map(file => ({ title: file.filename, bytes: Buffer.from(file.bytes) })) });
        }
        db.query("UPDATE routed_requests SET receipt_json=?, message_ts=?, status='confirmed', error=NULL WHERE request_id=?")
          .run(JSON.stringify(receipt), receipt.ts, id);
      }
      const published = await this.slackMessage(receipt, row.requested_by);
      await this.dependencies.admit({ channel: receipt.channel, threadTs: receipt.thread_ts || receipt.ts,
        userMsgTs: receipt.ts, user: row.requested_by, text: input.task, files: published.files }, {
        routedRequestId: id, waitRequested: input.defer, dependencyTurnIds: input.depends_on.map(dep => dep.turn_id),
      });
      db.transaction(() => {
        const claim = getSlackUserInputClaim(receipt.channel, receipt.ts);
        if (!claim || claim.kind === 'pending') throw new Error("Published request was not durably admitted.");
        db.query("UPDATE routed_requests SET status='admitted', turn_id=?, error=NULL WHERE request_id=?").run(claim.turn_id, id);
        db.query("DELETE FROM routed_request_files WHERE request_id=?").run(id);
      })();
    } catch (error) {
      if (error instanceof RouterActionError && error.context) progress(error.context);
      row = this.row(id);
      const context = JSON.parse(row.publication_json!) as FailureContext;
      const status = context.delivery === 'not_sent' ? 'failed' : 'parked';
      db.query("UPDATE routed_requests SET status=?, error=? WHERE request_id=?")
        .run(status, error instanceof Error ? error.message : 'Request publication failed.', id);
      this.dependencies.onError(error);
    }
  }

  async recover() {
    const requests = db.query("SELECT * FROM routed_requests WHERE status IN ('accepted', 'publishing', 'confirmed', 'parked') ORDER BY rowid").all() as RequestRow[];
    for (const row of requests) {
      if (row.owner_instance_id !== this.dependencies.instanceId && this.dependencies.isOwnerAlive(row.owner_instance_id)) {
        throw new Error("A live prior process still owns routed publication admission.");
      }
      await this.owned(row.channel_id, () => this.process(row.request_id));
    }
    const channels = db.query("SELECT DISTINCT channel_id FROM routed_input_events").all() as Array<{ channel_id: string }>;
    for (const channel of channels) await this.owned(channel.channel_id, () => this.flush(channel.channel_id));
  }

  recoverRequest(id: string) {
    const row = this.row(id);
    return this.owned(row.channel_id, async () => {
      await this.process(id);
      await this.flush(row.channel_id);
      return this.result(id);
    });
  }

  async stop() {
    this.stopped = true;
    await Promise.allSettled([...this.owners.values(), ...this.pendingInputs]);
  }
}
