import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { LaneFixtureIdentities } from "../../../scripts/sandbox-provision";
import { toMrkdwn } from "../../../src/mrkdwn";
import { conciergeRootSummary, formatDuration } from "../../../src/text";
import type {
  TypedTurnAdapter,
  TypedTurnDrain,
  TypedTurnObservation,
  TypedTurnPostReceipt,
  TypedTurnRunningObservation,
} from "../cases/typed-turn.case";
import type {
  TodoCaptureAdapter,
  TodoCaptureDrain,
  TodoCaptureObservation,
} from "../cases/todo-capture.case";
import type {
  ClaudeSteeringAckAdapter,
  ClaudeSteeringAcknowledgementObservation,
} from "../cases/claude-steering-ack.case";
import type { ProgressCardAdapter, ProgressCardObservation } from "../cases/progress-card.case";
import type { JournalCaptureObservation } from "../cases/thinkering-capture.case";
import type {
  PebbleCaptureReceipt,
  PebbleCaptureRequest,
  PebbleRouteEffect,
  PebbleTriggerRoutingAdapter,
  PebbleTriggerRoutingObservation,
} from "../cases/pebble-trigger-routing.case";

type JsonObject = Record<string, unknown>;

export type TypedTurnSlackCaller = (
  method: string,
  body: JsonObject,
) => Promise<JsonObject>;

export class LiveTypedTurnError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

type ControllerRunMetadata = {
  run_id: string;
  lane: number;
  status: string;
  generation: number;
  source: {
    git_sha: string;
    branch: string;
    dirty_digest: string | null;
    source_id: string;
  };
  candidate: { pid: number } | null;
  lane_identity: {
    team_id: string;
    app_id: string;
    bot_user_id: string;
    bot_id: string;
  };
  lane_fixtures: {
    lane_id: string;
    installer_user_id: string;
    browser: { client_workspace_id: string; canonical_workspace_domain: string };
  };
  paths: {
    config: string;
    fixtures: string;
    state: string;
    ready_file: string;
    capture_state?: string;
    capture_credentials?: string;
    capture_journal?: string;
  };
  reserved_capture?: {
    ingress_url: string;
    ingress_port: number;
    queue_url: string;
    queue_port: number;
    queue_token_file: string;
    pebble_token_file: string;
    journal_root: string;
    process: { pid: number; start_ticks: string } | null;
    active: boolean;
  };
};

export type SandboxRunSourceEvidence = {
  source_head: string;
  source_branch: string;
  source_diff_digest: string;
  source_id: string;
  generation: number;
};

type SandboxReadyReceipt = {
  schema_version: number;
  pid: number;
  run_id: string;
  lane: number;
  team_id: string;
  app_id: string;
  bot_user_id: string;
  bot_id: string;
};

type DurableTurnRow = {
  claim_kind: string;
  input_user_id: string | null;
  input_user_text: string | null;
  input_files_json: string;
  turn_id: number | null;
  turn_user_text: string | null;
  turn_status: string | null;
  delivery_status: string | null;
  outbound_text: string | null;
  response_tldr: string | null;
  provider_duration_ms: number | null;
  provider_turn_id: string | null;
  response_thread_ts: string | null;
  provider_id: string | null;
  provider_session_uuid: string | null;
  session_status: string | null;
};

type AgentSessionStatusProjectionRow = {
  initial_title: string | null;
  desired_status: string;
  desired_revision: number;
  projected_revision: number;
  projection_status: string;
};

type DeliveryChunkRow = {
  chunk_index: number;
  slack_ts: string | null;
  delivered_at: string | null;
};

type PostedInput = {
  text: string;
  clientMessageId: string;
};

type DurableCaptureRow = {
  kind: string;
  turn_id: number | null;
  user_id: string | null;
  user_text: string | null;
  inline_capture: number;
  capture_vault_status: string;
  capture_list_status: string;
  capture_confirmation_status: string;
  capture_confirmation_attempts: number;
};

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new LiveTypedTurnError("invalid_slack_response", `Slack did not return ${label}`);
  }
  return value;
}

function requiredObject(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) {
    throw new LiveTypedTurnError("invalid_slack_response", `Slack did not return ${label}`);
  }
  return value;
}

function laneNumber(laneId: string): number {
  const match = /^lane-([1-4])$/.exec(laneId);
  if (!match) throw new LiveTypedTurnError("invalid_lane", "Typed-turn acceptance requires lane-1 through lane-4");
  return Number(match[1]);
}

function safeRunId(runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new LiveTypedTurnError("invalid_run_id", "Typed-turn acceptance requires a safe run ID");
  }
  return runId;
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function readJsonFile(path: string, label: string): JsonObject {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new LiveTypedTurnError("unsafe_run_binding", `${label} is not a regular file`);
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new LiveTypedTurnError("unsafe_run_binding", `${label} is not valid JSON`);
  }
}

function assertPermalink(
  permalink: string,
  canonicalWorkspaceDomain: string,
  channelId: string,
  messageTs: string,
): void {
  let parsed: URL;
  try {
    parsed = new URL(permalink);
  } catch {
    throw new LiveTypedTurnError("invalid_slack_permalink", "Slack returned an invalid permalink");
  }
  const expectedPath = `/archives/${channelId}/p${messageTs.replace(".", "")}`;
  if (parsed.protocol !== "https:" || parsed.hostname !== canonicalWorkspaceDomain || parsed.pathname !== expectedPath) {
    throw new LiveTypedTurnError(
      "invalid_slack_permalink",
      "Slack permalink does not identify the exact sandbox workspace message",
    );
  }
}

function slackWorkspaceDomainFromAuth(value: unknown): string {
  const url = requiredString(value, "the authenticated Slack workspace URL");
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port
        || !/^[a-z0-9-]+[.]slack[.]com$/.test(parsed.hostname)) throw new Error("invalid workspace URL");
    return parsed.hostname;
  } catch {
    throw new LiveTypedTurnError("invalid_slack_response", "Slack returned an invalid authenticated workspace URL");
  }
}

function exactSlackMessage(response: JsonObject, messageTs: string): JsonObject {
  const messages = Array.isArray(response.messages) ? response.messages : [];
  const matching = messages.filter((message) => isRecord(message) && message.ts === messageTs);
  if (matching.length !== 1) {
    throw new LiveTypedTurnError(
      "slack_message_identity_mismatch",
      "Slack did not return exactly one message for the durable message timestamp",
    );
  }
  return matching[0] as JsonObject;
}

function activityTask(message: JsonObject, status: "in_progress" | "complete"): JsonObject | null {
  const tasks = (Array.isArray(message.blocks) ? message.blocks : []).filter((block) =>
    isRecord(block) && block.type === "task_card" && !["plan-progress", "earlier-progress"].includes(String(block.task_id)) && block.status === status);
  if (tasks.length > 1) {
    throw new LiveTypedTurnError("slack_progress_lifecycle_mismatch", "Slack returned multiple current activity tasks");
  }
  return tasks[0] as JsonObject | undefined || null;
}

function isLaneBotReply(message: JsonObject, lane: LaneFixtureIdentities, threadTs: string): boolean {
  return message.thread_ts === threadTs && message.user === lane.bot_user_id
    && message.bot_id === lane.bot_id && message.app_id === lane.app_id;
}

function blockText(value: unknown): string {
  if (Array.isArray(value)) return value.map(blockText).join("");
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text;
  return blockText(value.elements);
}

function nativeResponseTable(message: JsonObject): {
  blockTypes: string[];
  table: { headers: string[]; rows: string[][] };
} | null {
  const blocks = Array.isArray(message.blocks) ? message.blocks.filter(isRecord) : [];
  const tables = blocks.filter((block) => block.type === "table");
  if (tables.length !== 1 || !Array.isArray(tables[0]!.rows)) return null;
  const rows = tables[0]!.rows.map((row) =>
    Array.isArray(row) ? row.map((cell) => blockText(cell).trim()) : []);
  if (rows.length < 2 || rows.some((row) => row.length !== rows[0]!.length)) return null;
  return {
    blockTypes: blocks.map((block) => String(block.type || "")),
    table: { headers: rows[0]!, rows: rows.slice(1) },
  };
}

function asControllerRunMetadata(value: JsonObject): ControllerRunMetadata {
  const candidate = value.candidate;
  const laneIdentity = value.lane_identity;
  const laneFixtures = value.lane_fixtures;
  const paths = value.paths;
  if ((candidate !== null && !isRecord(candidate)) || !isRecord(laneIdentity)
      || !isRecord(laneFixtures) || !isRecord(paths)) {
    throw new LiveTypedTurnError("unsafe_run_binding", "Controller run metadata is incomplete");
  }
  return value as unknown as ControllerRunMetadata;
}

function asReadyReceipt(value: JsonObject): SandboxReadyReceipt {
  return value as unknown as SandboxReadyReceipt;
}

function withReadonlyDatabase<T>(path: string, operation: (database: Database) => T): T {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new LiveTypedTurnError("missing_run_state", "The active sandbox run state database is unavailable");
  }
  const database = new Database(path, { readonly: true, create: false });
  try {
    database.exec("PRAGMA query_only = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    return operation(database);
  } finally {
    database.close();
  }
}

function countMarker(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

function captureClientMessageId(eventId: string): string {
  const hex = createHash("sha256").update(`slack-concierge:capture:${eventId}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function slackUserCallerFromConfig(
  configPath: string,
  requester: typeof fetch = fetch,
): TypedTurnSlackCaller {
  if (!isAbsolute(configPath) || !existsSync(configPath)
      || lstatSync(configPath).isSymbolicLink() || !lstatSync(configPath).isFile()
      || (lstatSync(configPath).mode & 0o077) !== 0) {
    throw new LiveTypedTurnError(
      "unsafe_slack_config",
      "Sandbox Slack configuration must be an absolute owner-only regular file",
    );
  }
  const config = Bun.TOML.parse(readFileSync(configPath, "utf8")) as JsonObject;
  const userToken = requiredString(config.user_token, "the sandbox user token");
  if (!userToken.startsWith("xoxp-")) {
    throw new LiveTypedTurnError("unsafe_slack_config", "Sandbox Slack configuration has no user token");
  }
  return async (method, body) => {
    const queryMethod = method === "chat.getPermalink" || method === "conversations.replies";
    const url = new URL(`https://slack.com/api/${method}`);
    if (queryMethod) {
      for (const [name, value] of Object.entries(body)) url.searchParams.set(name, String(value));
    }
    const response = await requester(url, {
      method: queryMethod ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${userToken}`,
        ...(queryMethod ? {} : { "content-type": "application/json; charset=utf-8" }),
      },
      ...(queryMethod ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new LiveTypedTurnError("slack_transport_failed", `Slack ${method} returned HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (!isRecord(payload) || payload.ok !== true) {
      const error = isRecord(payload) && typeof payload.error === "string" ? payload.error : "unknown_error";
      throw new LiveTypedTurnError("slack_api_failed", `Slack ${method} failed: ${error}`);
    }
    return payload;
  };
}

export type TurnDispatchStateRow = {
  turn_id: number;
  turn_status: string;
  dispatch_attempt: number;
  dispatch_failure_class: string | null;
  delivery_status: string;
  status_projection_status: string;
  outbound_text: string | null;
  session_id: number;
  provider_id: string;
};

export type LiveTypedTurnAdapterOptions = {
  lane: LaneFixtureIdentities;
  workspaceDomain: string;
  runId: string;
  stateRoot: string;
  configPath: string;
  slack?: TypedTurnSlackCaller;
  requester?: typeof fetch;
  wait?: (milliseconds: number) => Promise<void>;
  turnTimeoutMs?: number;
  drainTimeoutMs?: number;
  pollIntervalMs?: number;
};

export class LiveTypedTurnAdapter implements TypedTurnAdapter, TodoCaptureAdapter, ClaudeSteeringAckAdapter,
  ProgressCardAdapter, PebbleTriggerRoutingAdapter {
  private readonly lane: LaneFixtureIdentities;
  private readonly runId: string;
  private readonly laneNumber: number;
  private readonly runRoot: string;
  private readonly runMetadataPath: string;
  private readonly readyPath: string;
  private readonly stateDatabasePath: string;
  private readonly configPath: string;
  private readonly slack: TypedTurnSlackCaller;
  private readonly requester: typeof fetch;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly turnTimeoutMs: number;
  private readonly drainTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly sourceEvidence: SandboxRunSourceEvidence;
  private readonly postedInputs = new Map<string, PostedInput>();

  constructor(options: LiveTypedTurnAdapterOptions) {
    this.lane = options.lane;
    if (options.workspaceDomain !== "concierge--sandbox.enterprise.slack.com") {
      throw new LiveTypedTurnError("run_identity_mismatch", "Typed-turn acceptance is restricted to the approved sandbox");
    }
    this.runId = safeRunId(options.runId);
    this.laneNumber = laneNumber(options.lane.lane_id);
    const stateRoot = realpathSync(options.stateRoot);
    this.runRoot = join(stateRoot, "lanes", options.lane.lane_id, "runs", this.runId);
    if (!existsSync(this.runRoot) || lstatSync(this.runRoot).isSymbolicLink()
        || !lstatSync(this.runRoot).isDirectory()
        || !pathIsWithin(stateRoot, realpathSync(this.runRoot))) {
      throw new LiveTypedTurnError("unsafe_run_binding", "Sandbox run root is not a real contained directory");
    }
    this.runMetadataPath = join(this.runRoot, "run.json");
    this.readyPath = join(this.runRoot, "state", "ready.json");
    this.stateDatabasePath = join(this.runRoot, "state", "state.db");
    this.configPath = resolve(options.configPath);
    this.wait = options.wait || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.turnTimeoutMs = options.turnTimeoutMs ?? 10 * 60_000;
    this.drainTimeoutMs = options.drainTimeoutMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    if (this.turnTimeoutMs <= 0 || this.drainTimeoutMs <= 0 || this.pollIntervalMs <= 0) {
      throw new LiveTypedTurnError("invalid_timeout", "Typed-turn acceptance timeouts must be positive");
    }
    this.sourceEvidence = this.readRunBinding().sourceEvidence;
    this.requester = options.requester || fetch;
    this.slack = options.slack || slackUserCallerFromConfig(this.configPath, this.requester);
  }

  private readRunBinding(): { ready: SandboxReadyReceipt; sourceEvidence: SandboxRunSourceEvidence } {
    const run = asControllerRunMetadata(readJsonFile(this.runMetadataPath, "Controller run metadata"));
    const ready = asReadyReceipt(readJsonFile(this.readyPath, "Sandbox readiness receipt"));
    const expectedState = join(this.runRoot, "state");
    const source = run.source;
    const validDirtyDigest = source?.dirty_digest === null
      || (typeof source?.dirty_digest === "string" && /^[0-9a-f]{64}$/.test(source.dirty_digest));
    const expectedSourceId = source?.dirty_digest === null
      ? source?.git_sha
      : typeof source?.dirty_digest === "string"
        ? `${source.git_sha}+${source.dirty_digest.slice(0, 16)}`
        : "";
    if (run.run_id !== this.runId || Number(run.lane) !== this.laneNumber || run.status !== "running"
        || !Number.isSafeInteger(run.generation) || run.generation < 1
        || !isRecord(source)
        || typeof source.git_sha !== "string" || !/^[0-9a-f]{40}$/.test(source.git_sha)
        || typeof source.branch !== "string" || !source.branch
        || !validDirtyDigest || source.source_id !== expectedSourceId
        || !run.candidate || !Number.isSafeInteger(Number(run.candidate.pid))
        || run.lane_identity.team_id !== this.lane.team_id
        || run.lane_identity.app_id !== this.lane.app_id
        || run.lane_identity.bot_user_id !== this.lane.bot_user_id
        || run.lane_identity.bot_id !== this.lane.bot_id
        || run.lane_fixtures.lane_id !== this.lane.lane_id
        || run.lane_fixtures.installer_user_id !== this.lane.installer_user_id
        || run.lane_fixtures.browser?.client_workspace_id !== this.lane.browser.client_workspace_id
        || run.lane_fixtures.browser?.canonical_workspace_domain !== this.lane.browser.canonical_workspace_domain
        || resolve(run.paths.config) !== this.configPath
        || resolve(run.paths.state) !== expectedState
        || resolve(run.paths.ready_file) !== this.readyPath
        || ready.schema_version !== 1
        || ready.pid !== Number(run.candidate.pid)
        || ready.run_id !== this.runId
        || ready.lane !== this.laneNumber
        || ready.team_id !== this.lane.team_id
        || ready.app_id !== this.lane.app_id
        || ready.bot_user_id !== this.lane.bot_user_id
        || ready.bot_id !== this.lane.bot_id) {
      throw new LiveTypedTurnError(
        "run_identity_mismatch",
        "Typed-turn acceptance is not bound to the exact running sandbox lane candidate",
      );
    }
    return {
      ready,
      sourceEvidence: {
        source_head: source.git_sha,
        source_branch: source.branch,
        source_diff_digest: source.dirty_digest || "clean",
        source_id: source.source_id,
        generation: run.generation,
      },
    };
  }

  private assertRunBinding(): SandboxReadyReceipt {
    const current = this.readRunBinding();
    if (current.sourceEvidence.source_id !== this.sourceEvidence.source_id
        || current.sourceEvidence.generation !== this.sourceEvidence.generation) {
      throw new LiveTypedTurnError(
        "run_source_changed",
        "Sandbox source or generation changed during typed-turn acceptance",
      );
    }
    return current.ready;
  }

  runSourceEvidence(): SandboxRunSourceEvidence {
    this.assertRunBinding();
    return { ...this.sourceEvidence };
  }

  private readDurableTurn(channelId: string, messageTs: string): {
    turn: DurableTurnRow | null;
    chunks: DeliveryChunkRow[];
  } {
    return withReadonlyDatabase(this.stateDatabasePath, (database) => {
      const turn = database.query(`
        SELECT claim.kind AS claim_kind,
               claim.user_id AS input_user_id,
               claim.user_text AS input_user_text,
               claim.files_json AS input_files_json,
               turn.id AS turn_id,
               turn.user_text AS turn_user_text,
               turn.status AS turn_status,
               turn.delivery_status,
               turn.outbound_text,
               turn.response_tldr,
               turn.provider_duration_ms,
               turn.provider_turn_id,
               COALESCE(turn.slack_reply_thread_ts, turn.slack_user_msg_ts) AS response_thread_ts,
               session.provider_id,
               session.agent_session_uuid AS provider_session_uuid,
               session.status AS session_status
        FROM slack_user_input_claims claim
        LEFT JOIN turns turn ON turn.id=claim.turn_id
        LEFT JOIN sessions session ON session.id=turn.session_id
        WHERE claim.slack_channel_id=? AND claim.slack_user_msg_ts=?
      `).get(channelId, messageTs) as DurableTurnRow | null;
      const chunks = turn?.turn_id == null ? [] : database.query(`
        SELECT chunk_index, slack_ts, delivered_at
        FROM turn_delivery_chunks
        WHERE turn_id=?
        ORDER BY chunk_index
      `).all(turn.turn_id) as DeliveryChunkRow[];
      return { turn, chunks };
    });
  }

  private readAgentSessionStatusProjection(channelId: string, threadTs: string): AgentSessionStatusProjectionRow | null {
    return withReadonlyDatabase(this.stateDatabasePath, (database) => database.query(`
      SELECT initial_title, desired_status, desired_revision, projected_revision, projection_status
      FROM slack_agent_session_status_projections
      WHERE slack_channel_id=? AND slack_thread_ts=?
    `).get(channelId, threadTs) as AgentSessionStatusProjectionRow | null);
  }

  async postUserMessage(input: {
    lane: LaneFixtureIdentities;
    channel_id: string;
    text: string;
    client_message_id: string;
    thread_ts?: string;
  }): Promise<TypedTurnPostReceipt> {
    this.assertRunBinding();
    const allowedChannels = new Set([
      this.lane.channels.core.id,
      this.lane.channels.capture.id,
      this.lane.dm_channel_id,
    ]);
    if (input.lane.lane_id !== this.lane.lane_id || input.lane.app_id !== this.lane.app_id
        || !allowedChannels.has(input.channel_id)
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.client_message_id)) {
      throw new LiveTypedTurnError("input_identity_mismatch", "Typed-turn input does not belong to this adapter's lane");
    }
    const auth = await this.slack("auth.test", {});
    const canonicalWorkspaceDomain = slackWorkspaceDomainFromAuth(auth.url);
    if (auth.team_id !== this.lane.team_id || auth.user_id !== this.lane.installer_user_id) {
      throw new LiveTypedTurnError(
        "user_token_identity_mismatch",
        "Sandbox user token does not identify the selected lane's installer user and team",
      );
    }
    if (canonicalWorkspaceDomain !== this.lane.browser.canonical_workspace_domain) {
      throw new LiveTypedTurnError(
        "user_token_identity_mismatch",
        "Sandbox user token does not identify the provisioned canonical Slack workspace domain",
      );
    }
    const posted = await this.slack("chat.postMessage", {
      channel: input.channel_id,
      text: input.text,
      client_msg_id: input.client_message_id,
      ...(input.thread_ts ? { thread_ts: input.thread_ts } : {}),
    });
    const channelId = requiredString(posted.channel, "the posted channel ID");
    const messageTs = requiredString(posted.ts, "the posted message timestamp");
    const postedMessage = requiredObject(posted.message, "the posted message object");
    if (channelId !== input.channel_id
        || postedMessage.ts !== messageTs
        || postedMessage.user !== this.lane.installer_user_id
        || postedMessage.text !== input.text
        || postedMessage.client_msg_id !== input.client_message_id) {
      throw new LiveTypedTurnError(
        "slack_message_identity_mismatch",
        "Slack did not confirm the exact user-authored typed-turn root",
      );
    }
    const permalinkResponse = await this.slack("chat.getPermalink", { channel: channelId, message_ts: messageTs });
    const permalink = requiredString(permalinkResponse.permalink, "the input permalink");
    assertPermalink(permalink, canonicalWorkspaceDomain, channelId, messageTs);
    this.postedInputs.set(`${channelId}:${messageTs}`, {
      text: input.text,
      clientMessageId: input.client_message_id,
    });
    return {
      channel_id: channelId,
      message_ts: messageTs,
      thread_ts: input.thread_ts || messageTs,
      permalink,
      client_message_id: input.client_message_id,
      delivery: "confirmed",
    };
  }

  private readTurnDispatchRow(channelId: string, messageTs: string): TurnDispatchStateRow | null {
    return withReadonlyDatabase(this.stateDatabasePath, (database) => database.query(`
      SELECT turn.id AS turn_id,
             turn.status AS turn_status,
             turn.dispatch_attempt,
             turn.dispatch_failure_class,
             turn.delivery_status,
             turn.status_projection_status,
             turn.outbound_text,
             turn.session_id,
             session.provider_id
      FROM slack_user_input_claims claim
      JOIN turns turn ON turn.id=claim.turn_id
      JOIN sessions session ON session.id=turn.session_id
      WHERE claim.slack_channel_id=? AND claim.slack_user_msg_ts=?
    `).get(channelId, messageTs) as TurnDispatchStateRow | null);
  }

  async waitForTurnDispatchState(input: {
    lane: LaneFixtureIdentities;
    receipt: TypedTurnPostReceipt;
    statuses: string[];
    minDispatchAttempt?: number;
    failureClass?: string;
    statusProjectionDelivered?: boolean;
  }): Promise<TurnDispatchStateRow> {
    const postedInput = this.postedInputs.get(`${input.receipt.channel_id}:${input.receipt.message_ts}`);
    if (!postedInput || input.lane.lane_id !== this.lane.lane_id
        || postedInput.clientMessageId !== input.receipt.client_message_id) {
      throw new LiveTypedTurnError("input_identity_mismatch", "Dispatch-state wait does not identify this adapter's input");
    }
    const deadline = Date.now() + this.turnTimeoutMs;
    let lastRow: TurnDispatchStateRow | null = null;
    while (Date.now() <= deadline) {
      this.assertRunBinding();
      lastRow = this.readTurnDispatchRow(input.receipt.channel_id, input.receipt.message_ts);
      if (lastRow
          && lastRow.provider_id === "claude-code"
          && input.statuses.includes(lastRow.turn_status)
          && Number(lastRow.dispatch_attempt) >= (input.minDispatchAttempt ?? 0)
          && (!input.failureClass || lastRow.dispatch_failure_class === input.failureClass)
          && (!input.statusProjectionDelivered || lastRow.status_projection_status === "delivered")) {
        return lastRow;
      }
      await this.wait(this.pollIntervalMs);
    }
    throw new LiveTypedTurnError(
      "turn_dispatch_state_timeout",
      `Turn for ${input.receipt.message_ts} did not reach ${input.statuses.join("/")} `
        + `(attempt>=${input.minDispatchAttempt ?? 0}); last: ${JSON.stringify(lastRow)}`,
    );
  }

  async fetchBotThreadTexts(input: {
    lane: LaneFixtureIdentities;
    receipt: TypedTurnPostReceipt;
  }): Promise<string[]> {
    if (input.lane.lane_id !== this.lane.lane_id) {
      throw new LiveTypedTurnError("input_identity_mismatch", "Thread fetch does not identify this adapter's lane");
    }
    this.assertRunBinding();
    const replies = await this.slack("conversations.replies", {
      channel: input.receipt.channel_id,
      ts: input.receipt.thread_ts,
      limit: 200,
    });
    return (Array.isArray(replies.messages) ? replies.messages : [])
      .filter(isRecord)
      .filter((message) => message.bot_id || message.app_id === this.lane.app_id)
      .map((message) => String(message.text || ""));
  }

  async waitForProgressCard(input: {
    lane: LaneFixtureIdentities;
    receipt: TypedTurnPostReceipt;
    running: TypedTurnRunningObservation;
    marker: string;
    expect_plan?: boolean;
  }): Promise<ProgressCardObservation> {
    const postedInput = this.postedInputs.get(`${input.receipt.channel_id}:${input.receipt.message_ts}`);
    if (!postedInput || input.lane.lane_id !== this.lane.lane_id
        || postedInput.clientMessageId !== input.receipt.client_message_id
        || input.running.progress_message_ts === "") {
      throw new LiveTypedTurnError("input_identity_mismatch", "Progress-card wait does not identify this adapter's exact input");
    }
    const deadline = Date.now() + this.turnTimeoutMs;
    while (Date.now() <= deadline) {
      const ready = this.assertRunBinding();
      const durable = this.readDurableTurn(input.receipt.channel_id, input.receipt.message_ts);
      const turn = durable.turn;
      if (!turn || turn.claim_kind === "pending" || turn.turn_id == null
          || ["queued", "running", "delivering"].includes(String(turn.turn_status))) {
        await this.wait(this.pollIntervalMs);
        continue;
      }
      if (turn.claim_kind !== "turn" || turn.turn_status !== "done" || turn.delivery_status !== "delivered"
          || turn.provider_id !== "codex" || turn.turn_id !== input.running.turn_id || !turn.outbound_text
          || durable.chunks.length !== 1 || !durable.chunks[0]?.slack_ts || !durable.chunks[0]?.delivered_at) {
        throw new LiveTypedTurnError(
          "progress_card_terminal_mismatch",
          "Progress-card input did not reach one exact delivered Codex outcome",
        );
      }
      const progressRows = withReadonlyDatabase(this.stateDatabasePath, (database) => database.query(`
        SELECT page_number, message_ts, chunks_json, creation_state, dirty
        FROM agent_progress_messages
        WHERE turn_id=?
        ORDER BY page_number
      `).all(turn.turn_id) as Array<{
        page_number: number;
        message_ts: string | null;
        chunks_json: string;
        creation_state: string;
        dirty: number;
      }>);
      if (progressRows.some((row) => row.creation_state !== "posted" || row.dirty !== 0)) {
        await this.wait(this.pollIntervalMs);
        continue;
      }
      const replies = await this.slack("conversations.replies", {
        channel: input.receipt.channel_id,
        ts: input.receipt.thread_ts,
        limit: 100,
      });
      const messages = (Array.isArray(replies.messages) ? replies.messages : []).filter(isRecord);
      const botReplies = messages.filter((message) => isLaneBotReply(message, this.lane, input.receipt.thread_ts));
      const progressReplies = botReplies.filter((message) => String(message.text || "") === "Agent task progress");
      const progressMessage = exactSlackMessage(replies, input.running.progress_message_ts);
      const responseMessage = exactSlackMessage(replies, durable.chunks[0].slack_ts);
      const blocks = (Array.isArray(progressMessage.blocks) ? progressMessage.blocks : []).filter(isRecord);
      const tasks = blocks.filter((block) => block.type === "task_card");
      const workComplete = tasks.find((block) => !["plan-progress", "earlier-progress"].includes(String(block.task_id)) && block.status === "complete");
      const plan = tasks.find((block) => block.task_id === "plan-progress");
      const earlierProgress = tasks.find((block) => block.task_id === "earlier-progress"
        && block.status === "complete" && isRecord(block.details) && block.details.type === "rich_text"
        && String(block.title || "").startsWith("Earlier progress"));
      const continuedBelowCount = blocks.filter((block) => String(block.title || "").includes("continued below")
        || blockText(block).includes("continued below")).length;
      const storedChunks = progressRows.length === 1
        ? JSON.parse(progressRows[0]!.chunks_json) as Array<Record<string, unknown>>
        : [];
      const storedCommentaryCount = storedChunks.filter((chunk) => chunk.type === "markdown_text"
        && chunk.isCompaction !== true).length;
      const storedActivityCount = storedChunks.filter((chunk) => chunk.type === "task_update"
        && chunk.id !== "plan-progress").length;
      const markerCount = countMarker(String(responseMessage.text || ""), input.marker);
      if (!isLaneBotReply(progressMessage, this.lane, input.receipt.thread_ts)
          || !isLaneBotReply(responseMessage, this.lane, input.receipt.thread_ts)
          || countMarker(turn.outbound_text, input.marker) !== 1
          || markerCount !== 1
          || progressRows.length !== 1
          || progressRows[0]?.page_number !== 0
          || progressRows[0]?.message_ts !== input.running.progress_message_ts
          || progressReplies.length !== 1
          || botReplies.length !== 2
          || !workComplete || !String(workComplete.title || "").startsWith("Work complete · ")
          || input.expect_plan !== false && plan?.title !== "4/4 steps complete"
          || !earlierProgress
          || continuedBelowCount !== 0) {
        throw new LiveTypedTurnError(
          "slack_progress_card_mismatch",
          "Slack did not preserve one current progress identity with the final plan",
        );
      }
      return {
        api_app_id: ready.app_id,
        turn_id: turn.turn_id,
        provider_id: "codex",
        turn_status: "done",
        delivery_status: "delivered",
        progress_row_count: 1,
        progress_page_number: 0,
        progress_message_ts: input.running.progress_message_ts,
        stored_commentary_count: storedCommentaryCount,
        stored_activity_count: storedActivityCount,
        slack_progress_reply_count: 1,
        slack_bot_reply_count: 2,
        work_complete_title: String(workComplete.title),
        plan_title: String(plan?.title || ""),
        earlier_progress_title: String(earlierProgress.title),
        earlier_progress_text: blockText(earlierProgress.details),
        web_activity_details: blockText(workComplete.details),
        continued_below_count: 0,
        response_message_ts: durable.chunks[0].slack_ts,
        marker_count: markerCount,
      };
    }
    throw new LiveTypedTurnError(
      "progress_card_timeout",
      "Exact sandbox progress-card turn did not reach terminal delivery before the deadline",
    );
  }

  async fetchBotActivityDetails(input: { lane: LaneFixtureIdentities; receipt: TypedTurnPostReceipt }): Promise<string> {
    if (input.lane.lane_id !== this.lane.lane_id) throw new LiveTypedTurnError("input_identity_mismatch", "Wrong lane for activity details");
    this.assertRunBinding();
    const replies = await this.slack("conversations.replies", { channel: input.receipt.channel_id, ts: input.receipt.thread_ts, limit: 100 });
    return (Array.isArray(replies.messages) ? replies.messages : []).filter(isRecord)
      .filter(message => isLaneBotReply(message, this.lane, input.receipt.thread_ts))
      .flatMap(message => Array.isArray(message.blocks) ? message.blocks : [])
      .filter(block => isRecord(block) && block.type === "task_card" && !["plan-progress", "earlier-progress"].includes(String(block.task_id)))
      .map(block => blockText(block.details)).join("\n");
  }

  async waitForSteeringAcknowledgement(input: {
    lane: LaneFixtureIdentities;
    rootReceipt: TypedTurnPostReceipt;
    steeringReceipt: TypedTurnPostReceipt;
  }): Promise<ClaudeSteeringAcknowledgementObservation> {
    const rootInput = this.postedInputs.get(`${input.rootReceipt.channel_id}:${input.rootReceipt.message_ts}`);
    const steeringInput = this.postedInputs.get(
      `${input.steeringReceipt.channel_id}:${input.steeringReceipt.message_ts}`,
    );
    if (!rootInput || !steeringInput || input.lane.lane_id !== this.lane.lane_id
        || input.rootReceipt.channel_id !== input.steeringReceipt.channel_id
        || input.rootReceipt.thread_ts !== input.steeringReceipt.thread_ts
        || rootInput.clientMessageId !== input.rootReceipt.client_message_id
        || steeringInput.clientMessageId !== input.steeringReceipt.client_message_id) {
      throw new LiveTypedTurnError(
        "input_identity_mismatch",
        "Steering acknowledgement wait does not identify this adapter's exact root and reply",
      );
    }
    const deadline = Date.now() + this.turnTimeoutMs;
    while (Date.now() <= deadline) {
      const ready = this.assertRunBinding();
      const steering = withReadonlyDatabase(this.stateDatabasePath, (database) => database.query(`
        SELECT claim.kind AS input_kind,
               claim.user_id AS input_user_id,
               claim.user_text AS input_text,
               claim.reply_thread_ts AS root_thread_ts,
               steering.turn_id,
               steering.status AS steering_status,
               steering.notice_status AS steering_notice_status,
               steering.notice_attempts AS steering_notice_attempts,
               steering.replay_text,
               CASE WHEN steering.provider_sent_at IS NOT NULL THEN 1 ELSE 0 END AS replay_ready,
               steering.unreplayable_attachment_count,
               session.provider_id
        FROM slack_user_input_claims claim
        JOIN turn_steering_messages steering
          ON steering.turn_id=claim.turn_id
         AND steering.slack_user_msg_ts=claim.slack_user_msg_ts
        JOIN turns turn ON turn.id=steering.turn_id
        JOIN sessions session ON session.id=turn.session_id
        WHERE claim.slack_channel_id=? AND claim.slack_user_msg_ts=?
      `).get(
        input.steeringReceipt.channel_id,
        input.steeringReceipt.message_ts,
      ) as {
        input_kind: string;
        input_user_id: string | null;
        input_text: string | null;
        root_thread_ts: string | null;
        turn_id: number;
        steering_status: string;
        steering_notice_status: string;
        steering_notice_attempts: number;
        replay_text: string;
        replay_ready: number;
        unreplayable_attachment_count: number;
        provider_id: string;
      } | null);
      if (!steering || steering.input_kind === "pending"
          || ["queued", "sending"].includes(steering.steering_status)
          || ["pending", "sending", "not_needed", "deferred"].includes(steering.steering_notice_status)) {
        await this.wait(this.pollIntervalMs);
        continue;
      }
      if (steering.input_kind !== "steering"
          || steering.input_user_id !== this.lane.installer_user_id
          || steering.input_text !== steeringInput.text
          || steering.root_thread_ts !== input.rootReceipt.thread_ts
          || steering.provider_id !== "claude-code"
          || steering.steering_status !== "sent"
          || steering.steering_notice_status !== "delivered"
          || steering.steering_notice_attempts < 1
          || steering.replay_ready !== 1
          || steering.unreplayable_attachment_count !== 0
          || !steering.replay_text.includes(steeringInput.text)
          || !steering.replay_text.includes(`"channel_id":"${input.steeringReceipt.channel_id}"`)
          || !steering.replay_text.includes(`"message_ts":"${input.steeringReceipt.message_ts}"`)
          || !steering.replay_text.includes(`"thread_ts":"${input.rootReceipt.thread_ts}"`)) {
        throw new LiveTypedTurnError(
          "durable_steering_acknowledgement_mismatch",
          "Durable state did not make the exact acknowledged steering input replay-ready",
        );
      }

      const replies = await this.slack("conversations.replies", {
        channel: input.steeringReceipt.channel_id,
        ts: input.rootReceipt.thread_ts,
        limit: 100,
      });
      const messages = (Array.isArray(replies.messages) ? replies.messages : []).filter(isRecord);
      const steeringMessage = exactSlackMessage(replies, input.steeringReceipt.message_ts);
      const reactions = (Array.isArray(steeringMessage.reactions) ? steeringMessage.reactions : [])
        .filter(isRecord)
        .filter((reaction) => reaction.name === "arrow_right_hook");
      const reaction = reactions.length === 1 ? reactions[0]! : null;
      const reactionUsers = reaction && Array.isArray(reaction.users)
        ? reaction.users.map(String).sort()
        : [];
      const failureNoticeCount = messages
        .filter((message) => isLaneBotReply(message, this.lane, input.rootReceipt.thread_ts))
        .filter((message) => String(message.text || "").includes("provider delivery receipt for that steering message"))
        .length;
      if (steeringMessage.user !== this.lane.installer_user_id
          || steeringMessage.text !== steeringInput.text
          || steeringMessage.client_msg_id !== steeringInput.clientMessageId
          || steeringMessage.thread_ts !== input.rootReceipt.thread_ts
          || !reaction
          || Number(reaction.count) !== 1
          || JSON.stringify(reactionUsers) !== JSON.stringify([this.lane.bot_user_id])
          || failureNoticeCount !== 0) {
        throw new LiveTypedTurnError(
          "slack_steering_acknowledgement_mismatch",
          "Slack did not expose exactly one bot steering reaction and zero false ambiguity notices",
        );
      }
      return {
        api_app_id: ready.app_id,
        turn_id: steering.turn_id,
        provider_id: "claude-code",
        input_channel_id: input.steeringReceipt.channel_id,
        input_message_ts: input.steeringReceipt.message_ts,
        input_kind: "steering",
        input_user_id: this.lane.installer_user_id,
        input_text: steeringInput.text,
        root_thread_ts: input.rootReceipt.thread_ts,
        steering_status: "sent",
        steering_notice_status: "delivered",
        steering_notice_attempts: steering.steering_notice_attempts,
        replay_text: steering.replay_text,
        replay_ready: 1,
        unreplayable_attachment_count: 0,
        reaction_name: "arrow_right_hook",
        reaction_count: Number(reaction.count),
        reaction_user_ids: reactionUsers,
        failure_notice_count: 0,
      };
    }
    throw new LiveTypedTurnError(
      "steering_acknowledgement_timeout",
      "Exact sandbox steering input did not reach durable and Slack-visible acknowledgement",
    );
  }

  private readCaptureRunBinding(): {
    ingressUrl: string;
    pebbleTokenFile: string;
    captureDatabasePath: string;
    journalRoot: string;
    processPid: number;
  } {
    this.assertRunBinding();
    const run = asControllerRunMetadata(readJsonFile(this.runMetadataPath, "Controller run metadata"));
    const reserved = run.reserved_capture;
    const captureState = run.paths.capture_state && resolve(run.paths.capture_state);
    const credentials = run.paths.capture_credentials && resolve(run.paths.capture_credentials);
    const journalRoot = run.paths.capture_journal && resolve(run.paths.capture_journal);
    if (!reserved || reserved.active !== true || !reserved.process
        || !Number.isSafeInteger(reserved.process.pid) || reserved.process.pid <= 0
        || typeof reserved.process.start_ticks !== "string" || !/^[0-9]+$/.test(reserved.process.start_ticks)
        || !captureState || captureState !== join(this.runRoot, "capture-state")
        || !credentials || credentials !== join(this.runRoot, "state", "capture-credentials")
        || !journalRoot || journalRoot !== join(this.runRoot, "journal-inbox")
        || resolve(reserved.journal_root) !== journalRoot
        || resolve(reserved.pebble_token_file) !== join(credentials, "pebble_index")
        || resolve(reserved.queue_token_file) !== join(credentials, "capture_queue")) {
      throw new LiveTypedTurnError(
        "capture_run_identity_mismatch",
        "Pebble acceptance is not bound to the exact active run-local capture sibling",
      );
    }
    let ingress: URL;
    let queue: URL;
    try {
      ingress = new URL(reserved.ingress_url);
      queue = new URL(reserved.queue_url);
    } catch {
      throw new LiveTypedTurnError("capture_run_identity_mismatch", "Sandbox capture metadata has invalid URLs");
    }
    if (ingress.protocol !== "http:" || ingress.hostname !== "127.0.0.1" || ingress.pathname !== "/"
        || Number(ingress.port) !== reserved.ingress_port
        || queue.protocol !== "http:" || queue.hostname !== "127.0.0.1" || queue.pathname !== "/"
        || Number(queue.port) !== reserved.queue_port
        || reserved.ingress_port === reserved.queue_port) {
      throw new LiveTypedTurnError("capture_run_identity_mismatch", "Sandbox capture ports are not isolated loopback endpoints");
    }
    for (const [path, label, kind] of [
      [captureState, "capture state", "directory"],
      [credentials, "capture credentials", "directory"],
      [journalRoot, "capture journal", "directory"],
      [reserved.pebble_token_file, "Pebble credential", "file"],
      [reserved.queue_token_file, "queue credential", "file"],
    ] as const) {
      if (!existsSync(path) || lstatSync(path).isSymbolicLink()
          || (kind === "directory" ? !lstatSync(path).isDirectory() : !lstatSync(path).isFile())
          || !pathIsWithin(this.runRoot, realpathSync(path))) {
        throw new LiveTypedTurnError("capture_run_identity_mismatch", `${label} is not a safe run-owned ${kind}`);
      }
    }
    if ((lstatSync(credentials).mode & 0o077) !== 0
        || (lstatSync(reserved.pebble_token_file).mode & 0o077) !== 0
        || (lstatSync(reserved.queue_token_file).mode & 0o077) !== 0) {
      throw new LiveTypedTurnError("capture_run_identity_mismatch", "Sandbox capture credentials are not owner-only");
    }
    let actualStartTicks = "";
    try {
      const stat = readFileSync(`/proc/${reserved.process.pid}/stat`, "utf8");
      actualStartTicks = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19] || "";
      process.kill(reserved.process.pid, 0);
    } catch {
      throw new LiveTypedTurnError("capture_run_identity_mismatch", "Sandbox capture sibling is not running");
    }
    if (actualStartTicks !== reserved.process.start_ticks) {
      throw new LiveTypedTurnError("capture_run_identity_mismatch", "Sandbox capture sibling process identity changed");
    }
    return {
      ingressUrl: reserved.ingress_url,
      pebbleTokenFile: reserved.pebble_token_file,
      captureDatabasePath: join(captureState, "state.db"),
      journalRoot,
      processPid: reserved.process.pid,
    };
  }

  async submitPebbleCapture(input: PebbleCaptureRequest): Promise<PebbleCaptureReceipt> {
    const capture = this.readCaptureRunBinding();
    const form = new FormData();
    form.set("transcription", input.transcription);
    form.set("recordedAt", String(input.recorded_at_ms));
    form.set("client", input.client);
    const response = await this.requester(`${capture.ingressUrl}/pebble`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${readFileSync(capture.pebbleTokenFile, "utf8").trim()}`,
        ...(input.trigger === undefined ? {} : { "X-Index-Trigger": input.trigger }),
        ...(input.webhook_version === undefined ? {} : { "X-Index-Webhook-Version": input.webhook_version }),
      },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => ({})) as JsonObject;
    return {
      ...input,
      http_status: response.status,
      event_id: typeof payload.event_id === "string" ? payload.event_id : null,
      duplicate: typeof payload.duplicate === "boolean" ? payload.duplicate : null,
      status: typeof payload.status === "string" ? payload.status : null,
      source_trigger: typeof payload.trigger === "string" ? payload.trigger : null,
      source_webhook_version: typeof payload.webhook_version === "string" ? payload.webhook_version : null,
      destination_kind: payload.destination_kind === "slack" || payload.destination_kind === "journal"
        ? payload.destination_kind
        : null,
      terminal_receipt: typeof payload.terminal_receipt === "string" ? payload.terminal_receipt : null,
      error: typeof payload.error === "string" ? payload.error : null,
    };
  }

  async waitForJournalCapture(receipt: PebbleCaptureReceipt): Promise<JournalCaptureObservation> {
    if (!receipt.event_id || receipt.destination_kind !== "journal" || receipt.source_trigger !== "single-click-hold") {
      throw new LiveTypedTurnError("input_identity_mismatch", "Journal observation requires the exact single-click receipt");
    }
    const capture = this.readCaptureRunBinding();
    const auth = await this.slack("auth.test", {});
    if (auth.team_id !== this.lane.team_id || auth.user_id !== this.lane.installer_user_id
      || slackWorkspaceDomainFromAuth(auth.url) !== this.lane.browser.canonical_workspace_domain) {
      throw new LiveTypedTurnError("user_token_identity_mismatch", "Sandbox user token does not identify this lane");
    }
    type Row = { event_id: string; status: string; journal_sink: string; message_text: string;
      delivery_kind: string; journal_file_path: string | null; slack_message_ts: string | null };
    let row: Row | null = null;
    const deadline = Date.now() + this.drainTimeoutMs;
    while (Date.now() <= deadline) {
      this.readCaptureRunBinding();
      row = withReadonlyDatabase(capture.captureDatabasePath, database => database.query(
        "SELECT event_id,status,journal_sink,message_text,delivery_kind,journal_file_path,slack_message_ts FROM capture_events WHERE event_id=?",
      ).get(receipt.event_id) as Row | null);
      if (row?.status === "delivered") break;
      await this.wait(this.pollIntervalMs);
    }
    if (!row || row.status !== "delivered" || row.delivery_kind !== "journal" || row.journal_sink !== "thinkering-inbox"
      || !row.journal_file_path || basename(row.journal_file_path) !== row.journal_file_path || row.slack_message_ts !== null) {
      throw new LiveTypedTurnError("journal_receipt_mismatch", "Thinkering journal did not settle with its exact configured sink");
    }
    const path = join(capture.journalRoot, row.journal_file_path);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !pathIsWithin(capture.journalRoot, realpathSync(path))
      || !readFileSync(path).equals(Buffer.from(row.message_text))) {
      throw new LiveTypedTurnError("journal_receipt_mismatch", "Journal file must equal the immutable run-owned captured bytes");
    }
    const started = readJsonFile(this.runMetadataPath, "Sandbox run metadata").started_at;
    const since = typeof started === "string" ? Date.parse(started) : NaN;
    if (!Number.isFinite(since)) throw new LiveTypedTurnError("run_identity_mismatch", "Run start time is missing");
    let messages = 0;
    for (const channel of [this.lane.dm_channel_id, ...Object.values(this.lane.channels).map(value => value.id)]) {
      const history = await this.slack("conversations.history", { channel, oldest: String(since / 1000), limit: 1 });
      messages += Array.isArray(history.messages) ? history.messages.length : 0;
    }
    const counts = withReadonlyDatabase(this.stateDatabasePath, database => ({
      inputs: Number((database.query("SELECT COUNT(*) AS count FROM slack_user_input_claims").get() as {count:number}).count),
      turns: Number((database.query("SELECT COUNT(*) AS count FROM turns").get() as {count:number}).count),
    }));
    const captureRows = withReadonlyDatabase(capture.captureDatabasePath, database => Number((database.query(
      "SELECT COUNT(*) AS count FROM capture_events",
    ).get() as {count:number}).count));
    await this.waitForRunSettled();
    return { event_id: row.event_id, sink: row.journal_sink, capture_rows: captureRows,
      journal_file: row.journal_file_path, journal_sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      journal_inode: stat.ino, journal_mtime_ms: stat.mtimeMs, slack_messages: messages,
      input_claims: counts.inputs, turns: counts.turns, run_owned_unsettled: 0 };
  }

  async waitForPebbleTriggerRouting(input: {
    lane: LaneFixtureIdentities;
    single: PebbleCaptureReceipt;
    double: PebbleCaptureReceipt;
    test: PebbleCaptureReceipt;
    legacy: PebbleCaptureReceipt;
    unknown: PebbleCaptureReceipt;
    unknown_event_id: string;
  }): Promise<PebbleTriggerRoutingObservation> {
    if (input.lane.lane_id !== this.lane.lane_id
        || [input.single, input.double, input.test, input.legacy].some((receipt) => !receipt.event_id)
        || input.unknown.event_id !== null || !/^[0-9a-f]{64}$/.test(input.unknown_event_id)) {
      throw new LiveTypedTurnError("input_identity_mismatch", "Pebble observation does not identify the exact case inputs");
    }
    const capture = this.readCaptureRunBinding();
    const auth = await this.slack("auth.test", {});
    if (auth.team_id !== this.lane.team_id || auth.user_id !== this.lane.installer_user_id
        || slackWorkspaceDomainFromAuth(auth.url) !== this.lane.browser.canonical_workspace_domain) {
      throw new LiveTypedTurnError("user_token_identity_mismatch", "Sandbox user token does not identify this lane");
    }
    type CaptureRow = {
      event_id: string;
      message_text: string;
      client_msg_id: string;
      source_trigger: string | null;
      source_webhook_version: string | null;
      delivery_kind: "slack" | "journal";
      status: string;
      slack_message_ts: string | null;
      journal_file_path: string | null;
    };
    const expectedReceipts = [input.single, input.double, input.test, input.legacy];
    const deadline = Date.now() + this.turnTimeoutMs;
    let rows = new Map<string, CaptureRow>();
    while (Date.now() <= deadline) {
      this.readCaptureRunBinding();
      rows = withReadonlyDatabase(capture.captureDatabasePath, (database) => new Map(
        (database.query(`SELECT event_id, message_text, client_msg_id, source_trigger,
          source_webhook_version, delivery_kind, status, slack_message_ts, journal_file_path
          FROM capture_events WHERE event_id IN (?, ?, ?, ?)`)
          .all(...expectedReceipts.map((receipt) => receipt.event_id)) as CaptureRow[])
          .map((row) => [row.event_id, row]),
      ));
      if (rows.size === 4 && [...rows.values()].every((row) => row.status === "delivered")) break;
      await this.wait(this.pollIntervalMs);
    }
    if (rows.size !== 4 || [...rows.values()].some((row) => row.status !== "delivered")) {
      throw new LiveTypedTurnError("capture_delivery_timeout", "Sandbox capture rows did not all reach durable delivery");
    }
    const unknownRows = withReadonlyDatabase(capture.captureDatabasePath, (database) => Number((database.query(
      "SELECT COUNT(*) AS count FROM capture_events WHERE event_id=?",
    ).get(input.unknown_event_id) as { count: number }).count));
    const history = await this.slack("conversations.history", { channel: this.lane.dm_channel_id, limit: 200 });
    const messages = (Array.isArray(history.messages) ? history.messages : []).filter(isRecord);
    const noSlackCounts = (receipt: PebbleCaptureReceipt, eventId: string) => {
      const slackMessageCount = messages.filter((message) => message.client_msg_id === captureClientMessageId(eventId)
        || String(message.text || "").includes(receipt.transcription)).length;
      const durable = withReadonlyDatabase(this.stateDatabasePath, (database) => database.query(`
        SELECT COUNT(DISTINCT claim.slack_user_msg_ts) AS input_claims,
               COUNT(DISTINCT turn.id) AS turns
        FROM slack_user_input_claims claim
        LEFT JOIN turns turn ON turn.id=claim.turn_id
        WHERE claim.user_text LIKE '%' || ? || '%'
      `).get(receipt.transcription) as { input_claims: number; turns: number });
      return { slackMessageCount, inputClaims: Number(durable.input_claims), turns: Number(durable.turns) };
    };
    const singleNoSlack = noSlackCounts(input.single, input.single.event_id!);
    const unknownNoSlack = noSlackCounts(input.unknown, input.unknown_event_id);

    const rowEffect = async (receipt: PebbleCaptureReceipt): Promise<PebbleRouteEffect> => {
      const row = rows.get(receipt.event_id!)!;
      if (row.source_trigger !== receipt.source_trigger
          || row.source_webhook_version !== receipt.source_webhook_version
          || row.delivery_kind !== receipt.destination_kind) {
        throw new LiveTypedTurnError("capture_provenance_mismatch", "Durable capture provenance differs from ingress receipt");
      }
      if (row.delivery_kind === "journal") {
        if (!row.journal_file_path || basename(row.journal_file_path) !== row.journal_file_path
            || row.slack_message_ts !== null) {
          throw new LiveTypedTurnError("journal_receipt_mismatch", "Journal capture has an invalid terminal receipt");
        }
        const filePath = join(capture.journalRoot, row.journal_file_path);
        if (!existsSync(filePath) || lstatSync(filePath).isSymbolicLink() || !lstatSync(filePath).isFile()
            || !pathIsWithin(capture.journalRoot, realpathSync(filePath))) {
          throw new LiveTypedTurnError("journal_receipt_mismatch", "Journal capture file is not a safe run-owned regular file");
        }
        const bytes = readFileSync(filePath);
        if (!bytes.equals(Buffer.from(row.message_text))) {
          throw new LiveTypedTurnError("journal_receipt_mismatch", "Journal capture bytes differ from the persisted effect");
        }
        return {
          event_id: row.event_id,
          capture_status: "delivered",
          source_trigger: row.source_trigger,
          source_webhook_version: row.source_webhook_version,
          destination_kind: "journal",
          slack_message_count: singleNoSlack.slackMessageCount,
          slack_message_ts: null,
          input_claims: singleNoSlack.inputClaims,
          turns: singleNoSlack.turns,
          delivered_responses: 0,
          journal_file_name: row.journal_file_path,
          journal_sha256: createHash("sha256").update(bytes).digest("hex"),
          permalink: null,
        };
      }
      if (!row.slack_message_ts || row.journal_file_path !== null) {
        throw new LiveTypedTurnError("slack_receipt_mismatch", "Slack capture has an invalid terminal receipt");
      }
      const roots = messages.filter((message) => message.ts === row.slack_message_ts
        && message.user === this.lane.installer_user_id);
      const durable = withReadonlyDatabase(this.stateDatabasePath, (database) => database.query(`
        SELECT COUNT(DISTINCT claim.slack_user_msg_ts) AS input_claims,
               COUNT(DISTINCT turn.id) AS turns,
               COUNT(DISTINCT CASE WHEN turn.status='done' AND turn.delivery_status='delivered'
                 AND chunk.delivered_at IS NOT NULL THEN turn.id || ':' || chunk.chunk_index END) AS delivered_responses,
               SUM(CASE WHEN claim.kind='turn' AND claim.user_id=? THEN 1 ELSE 0 END) AS exact_claims
        FROM slack_user_input_claims claim
        LEFT JOIN turns turn ON turn.id=claim.turn_id
        LEFT JOIN turn_delivery_chunks chunk ON chunk.turn_id=turn.id
        WHERE claim.slack_channel_id=? AND claim.slack_user_msg_ts=?
      `).get(this.lane.installer_user_id, this.lane.dm_channel_id, row.slack_message_ts) as {
        input_claims: number;
        turns: number;
        delivered_responses: number;
        exact_claims: number | null;
      });
      const permalink = roots.length === 1
        ? requiredString((await this.slack("chat.getPermalink", {
          channel: this.lane.dm_channel_id,
          message_ts: row.slack_message_ts,
        })).permalink, "the Pebble capture permalink")
        : null;
      if (permalink) assertPermalink(permalink, this.lane.browser.canonical_workspace_domain, this.lane.dm_channel_id, row.slack_message_ts);
      return {
        event_id: row.event_id,
        capture_status: "delivered",
        source_trigger: row.source_trigger,
        source_webhook_version: row.source_webhook_version,
        destination_kind: "slack",
        slack_message_count: roots.length,
        slack_message_ts: row.slack_message_ts,
        input_claims: Number(durable.exact_claims || 0),
        turns: Number(durable.turns),
        delivered_responses: Number(durable.delivered_responses),
        journal_file_name: null,
        journal_sha256: null,
        permalink,
      };
    };

    let double: PebbleRouteEffect | null = null;
    let test: PebbleRouteEffect | null = null;
    let legacy: PebbleRouteEffect | null = null;
    while (Date.now() <= deadline) {
      this.assertRunBinding();
      double = await rowEffect(input.double);
      test = await rowEffect(input.test);
      legacy = await rowEffect(input.legacy);
      if ([double, test, legacy].every((effect) => effect.input_claims === 1
          && effect.turns === 1 && effect.delivered_responses === 1 && effect.slack_message_count === 1)) break;
      await this.wait(this.pollIntervalMs);
    }
    if (!double || !test || !legacy || [double, test, legacy].some((effect) => effect.input_claims !== 1
        || effect.turns !== 1 || effect.delivered_responses !== 1 || effect.slack_message_count !== 1)) {
      throw new LiveTypedTurnError("pebble_slack_turn_timeout", "Pebble Slack captures did not reach exact terminal turns");
    }
    const single = await rowEffect(input.single);
    await this.waitForRunSettled();
    return {
      api_app_id: this.assertRunBinding().app_id,
      ingress_active: true,
      capture_process_pid: capture.processPid,
      single,
      double,
      test,
      legacy,
      unknown: {
        event_id: input.unknown_event_id,
        capture_rows: unknownRows,
        slack_message_count: unknownNoSlack.slackMessageCount,
        input_claims: unknownNoSlack.inputClaims,
        turns: unknownNoSlack.turns,
        journal_file_count: existsSync(join(capture.journalRoot, `pebble-${input.unknown_event_id}.md`)) ? 1 : 0,
      },
      run_owned_unsettled: 0,
    };
  }

  async waitForRunSettled(): Promise<void> {
    const deadline = Date.now() + this.drainTimeoutMs;
    let unsettled = -1;
    while (Date.now() <= deadline) {
      this.assertRunBinding();
      unsettled = withReadonlyDatabase(this.stateDatabasePath, (database) => Number((database.query(`
        SELECT
          (SELECT COUNT(*) FROM slack_user_input_claims WHERE kind='pending')
          + (SELECT COUNT(*) FROM turns WHERE status IN ('queued', 'running', 'delivering'))
          + (SELECT COUNT(*) FROM sessions WHERE status='running')
          + (SELECT COUNT(*) FROM turn_steering_messages WHERE status IN ('queued', 'sending'))
          + (SELECT COUNT(*) FROM turn_delivery_chunks WHERE delivered_at IS NULL)
          + (SELECT COUNT(*) FROM agent_progress_messages WHERE creation_state<>'posted' OR dirty<>0)
          + (SELECT COUNT(*) FROM turn_artifact_batches WHERE status IN ('collecting', 'pending'))
          + (SELECT COUNT(*) FROM turn_artifact_deliveries WHERE status IN ('pending', 'sending'))
          + (SELECT COUNT(*) FROM turns WHERE status_projection_status IN ('pending', 'sending'))
          + (SELECT COUNT(*) FROM slack_thread_statuses WHERE projection_status IN ('pending', 'sending'))
          + (SELECT COUNT(*) FROM slack_root_summary_projections WHERE projection_status IN ('pending', 'sending'))
          + (SELECT COUNT(*) FROM slack_agent_session_status_projections WHERE projection_status IN ('pending', 'sending'))
          + (SELECT COUNT(*) FROM slack_agent_session_title_projections WHERE projection_status IN ('pending', 'sending'))
          + (SELECT COUNT(*) FROM turn_reaction_cleanups WHERE cleanup_status IN ('pending', 'sending'))
          AS count
      `).get() as { count: number }).count));
      if (unsettled === 0) return;
      await this.wait(this.pollIntervalMs);
    }
    throw new LiveTypedTurnError(
      "run_settle_timeout",
      `Exact sandbox run retained ${unsettled} unsettled durable owner(s)`,
    );
  }

  async waitForTodoCapture(input: {
    lane: LaneFixtureIdentities;
    receipt: TypedTurnPostReceipt;
  }): Promise<TodoCaptureObservation> {
    const postedInput = this.postedInputs.get(`${input.receipt.channel_id}:${input.receipt.message_ts}`);
    if (!postedInput || input.lane.lane_id !== this.lane.lane_id
        || input.receipt.channel_id !== this.lane.channels.capture.id
        || postedInput.clientMessageId !== input.receipt.client_message_id) {
      throw new LiveTypedTurnError("input_identity_mismatch", "Todo-capture wait does not identify this adapter's input");
    }
    const deadline = Date.now() + this.turnTimeoutMs;
    while (Date.now() <= deadline) {
      const ready = this.assertRunBinding();
      const capture = withReadonlyDatabase(this.stateDatabasePath, (database) => database.query(`
        SELECT kind, turn_id, user_id, user_text, inline_capture,
               capture_vault_status, capture_list_status,
               capture_confirmation_status, capture_confirmation_attempts
        FROM slack_user_input_claims
        WHERE slack_channel_id=? AND slack_user_msg_ts=?
      `).get(input.receipt.channel_id, input.receipt.message_ts) as DurableCaptureRow | null);
      if (!capture || capture.kind === "pending"
          || ["pending", "sending"].includes(capture.capture_confirmation_status)) {
        await this.wait(this.pollIntervalMs);
        continue;
      }
      if (capture.kind !== "capture"
          || capture.turn_id !== null
          || capture.user_id !== this.lane.installer_user_id
          || capture.user_text !== postedInput.text
          || capture.inline_capture !== 1
          || capture.capture_vault_status !== "done"
          || capture.capture_list_status !== "skipped"
          || capture.capture_confirmation_status !== "delivered"
          || capture.capture_confirmation_attempts < 1) {
        throw new LiveTypedTurnError(
          "durable_capture_identity_mismatch",
          "Durable state did not join the exact input to one delivered inline todo capture",
        );
      }

      const replies = await this.slack("conversations.replies", {
        channel: input.receipt.channel_id,
        ts: input.receipt.thread_ts,
        limit: 100,
      });
      const messages = (Array.isArray(replies.messages) ? replies.messages : []).filter(isRecord);
      const root = exactSlackMessage(replies, input.receipt.message_ts);
      const reactions = (Array.isArray(root.reactions) ? root.reactions : [])
        .filter(isRecord)
        .filter((reaction) => reaction.name === "white_check_mark");
      const reaction = reactions.length === 1 ? reactions[0]! : null;
      const reactionUsers = reaction && Array.isArray(reaction.users)
        ? reaction.users.map(String).sort()
        : [];
      if (messages.length !== 1
          || root.user !== this.lane.installer_user_id
          || root.text !== postedInput.text
          || root.client_msg_id !== postedInput.clientMessageId
          || !reaction
          || Number(reaction.count) !== 1
          || JSON.stringify(reactionUsers) !== JSON.stringify([this.lane.bot_user_id])) {
        throw new LiveTypedTurnError(
          "slack_capture_confirmation_mismatch",
          "Slack did not expose exactly one bot check-mark reaction and zero todo thread replies",
        );
      }
      return {
        api_app_id: ready.app_id,
        input_channel_id: input.receipt.channel_id,
        input_message_ts: input.receipt.message_ts,
        input_kind: "capture",
        input_user_id: this.lane.installer_user_id,
        input_text: postedInput.text,
        capture_vault_status: "done",
        capture_list_status: "skipped",
        capture_confirmation_status: "delivered",
        capture_confirmation_attempts: capture.capture_confirmation_attempts,
        reaction_name: "white_check_mark",
        reaction_count: Number(reaction.count),
        reaction_user_ids: reactionUsers,
        thread_reply_count: messages.length - 1,
      };
    }
    throw new LiveTypedTurnError(
      "todo_capture_timeout",
      "Exact sandbox todo capture did not reach durable reaction delivery before the deadline",
    );
  }

  async waitForRunning(input: {
    lane: LaneFixtureIdentities;
    receipt: TypedTurnPostReceipt;
  }): Promise<TypedTurnRunningObservation> {
    const postedInput = this.postedInputs.get(`${input.receipt.channel_id}:${input.receipt.message_ts}`);
    if (!postedInput || input.lane.lane_id !== this.lane.lane_id) {
      throw new LiveTypedTurnError("input_identity_mismatch", "Running wait does not identify this adapter's input");
    }
    const deadline = Date.now() + this.turnTimeoutMs;
    while (Date.now() <= deadline) {
      const ready = this.assertRunBinding();
      const turn = this.readDurableTurn(input.receipt.channel_id, input.receipt.message_ts).turn;
      if (!turn || turn.claim_kind === "pending" || turn.turn_status === "queued" || !turn.provider_turn_id) {
        await this.wait(this.pollIntervalMs);
        continue;
      }
      if (turn.turn_status !== "running") {
        throw new LiveTypedTurnError(
          "running_activity_not_observed",
          `Exact typed-turn reached ${turn.turn_status || "missing"} before a running activity was observed`,
        );
      }
      if (turn.input_user_id !== this.lane.installer_user_id
          || turn.input_user_text !== postedInput.text || turn.turn_user_text !== postedInput.text
          || turn.input_files_json !== "[]" || !turn.turn_id || !turn.provider_id
          || !turn.provider_session_uuid || turn.session_status !== "running") {
        throw new LiveTypedTurnError("durable_turn_identity_mismatch", "Running provider turn did not match the exact input");
      }
      const agentSessionStatus = this.readAgentSessionStatusProjection(
        input.receipt.channel_id,
        input.receipt.thread_ts,
      );
      if (!agentSessionStatus || ["pending", "sending"].includes(agentSessionStatus.projection_status)) {
        await this.wait(this.pollIntervalMs);
        continue;
      }
      if (agentSessionStatus.desired_status !== "processing"
          || agentSessionStatus.projection_status !== "delivered"
          || !agentSessionStatus.initial_title
          || agentSessionStatus.desired_revision !== agentSessionStatus.projected_revision) {
        throw new LiveTypedTurnError(
          "agent_session_lifecycle_mismatch",
          "Running provider turn did not have a delivered processing Agent session",
        );
      }
      const replies = await this.slack("conversations.replies", {
        channel: input.receipt.channel_id,
        ts: input.receipt.thread_ts,
        limit: 100,
      });
      const candidates = (Array.isArray(replies.messages) ? replies.messages : [])
        .filter(isRecord)
        .filter((message) => isLaneBotReply(message, this.lane, input.receipt.thread_ts))
        .map((message) => ({ message, task: activityTask(message, "in_progress") }))
        .filter((item) => item.task);
      if (candidates.length === 0 || String(candidates[0]!.task!.title).startsWith("Starting agent")) {
        await this.wait(this.pollIntervalMs);
        continue;
      }
      if (candidates.length !== 1) {
        throw new LiveTypedTurnError("slack_progress_lifecycle_mismatch", "Slack returned multiple running progress replies");
      }
      const progressMessageTs = requiredString(candidates[0]!.message.ts, "the running progress timestamp");
      const activityTaskId = requiredString(candidates[0]!.task!.task_id, "the running activity task ID");
      const activityTitle = requiredString(candidates[0]!.task!.title, "the running activity title");
      if (!/^.+ · .* elapsed$/.test(activityTitle)) {
        throw new LiveTypedTurnError("running_activity_not_observed", "Running activity omitted whole-turn elapsed time");
      }
      const permalink = requiredString((await this.slack("chat.getPermalink", {
        channel: input.receipt.channel_id,
        message_ts: progressMessageTs,
      })).permalink, "the running progress permalink");
      assertPermalink(permalink, this.lane.browser.canonical_workspace_domain, input.receipt.channel_id, progressMessageTs);
      return {
        api_app_id: ready.app_id,
        turn_id: turn.turn_id,
        provider_id: turn.provider_id,
        provider_session_uuid: turn.provider_session_uuid,
        provider_turn_id: turn.provider_turn_id,
        agent_session_status: "processing",
        agent_session_projection_status: "delivered",
        agent_session_desired_revision: agentSessionStatus.desired_revision,
        agent_session_projected_revision: agentSessionStatus.projected_revision,
        agent_session_title: agentSessionStatus.initial_title,
        progress_message_ts: progressMessageTs,
        progress_permalink: permalink,
        activity_task_id: activityTaskId,
        activity_title: activityTitle,
      };
    }
    throw new LiveTypedTurnError("running_activity_timeout", "Exact typed-turn exposed no running Thinking/activity surface");
  }

  async waitForTurn(input: {
    lane: LaneFixtureIdentities;
    receipt: TypedTurnPostReceipt;
    running: TypedTurnRunningObservation;
    marker: string;
  }): Promise<TypedTurnObservation> {
    const postedInput = this.postedInputs.get(`${input.receipt.channel_id}:${input.receipt.message_ts}`);
    if (!postedInput || input.lane.lane_id !== this.lane.lane_id
        || postedInput.clientMessageId !== input.receipt.client_message_id
        || !input.running.progress_message_ts) {
      throw new LiveTypedTurnError("input_identity_mismatch", "Typed-turn receipt was not posted by this exact adapter run");
    }
    const deadline = Date.now() + this.turnTimeoutMs;
    while (Date.now() <= deadline) {
      const ready = this.assertRunBinding();
      const durable = this.readDurableTurn(input.receipt.channel_id, input.receipt.message_ts);
      const turn = durable.turn;
      if (!turn) {
        await this.wait(this.pollIntervalMs);
        continue;
      }
      if (turn.claim_kind !== "pending" && turn.claim_kind !== "turn") {
        throw new LiveTypedTurnError(
          "typed_turn_misclassified",
          `Exact typed-turn input was durably classified as ${turn.claim_kind}`,
        );
      }
      if (turn.claim_kind === "pending" || turn.turn_id == null
          || ["queued", "running", "delivering"].includes(String(turn.turn_status))) {
        await this.wait(this.pollIntervalMs);
        continue;
      }
      if (turn.turn_status !== "done" || turn.delivery_status !== "delivered"
          || turn.session_status !== "idle") {
        throw new LiveTypedTurnError(
          "typed_turn_terminal_failure",
          `Exact typed-turn ended as ${turn.turn_status || "missing"}/${turn.delivery_status || "missing"}`,
        );
      }
      if (turn.input_user_id !== this.lane.installer_user_id
          || turn.input_user_text !== postedInput.text
          || turn.turn_user_text !== postedInput.text
          || turn.input_files_json !== "[]"
          || !turn.provider_id
          || !turn.provider_session_uuid
          || !turn.provider_turn_id
          || turn.turn_id !== input.running.turn_id
          || turn.provider_id !== input.running.provider_id
          || turn.provider_session_uuid !== input.running.provider_session_uuid
          || turn.provider_turn_id !== input.running.provider_turn_id
          || !turn.response_tldr
          || !Number.isSafeInteger(turn.provider_duration_ms)
          || Number(turn.provider_duration_ms) < 0
          || turn.response_thread_ts !== input.receipt.thread_ts
          || durable.chunks.length !== 1
          || durable.chunks[0]?.chunk_index !== 0
          || !durable.chunks[0]?.slack_ts
          || !durable.chunks[0]?.delivered_at
          || !turn.outbound_text) {
        throw new LiveTypedTurnError(
          "durable_turn_identity_mismatch",
          "Durable state did not join the exact input to one provider turn/session and delivered response",
        );
      }
      const responseMessageTs = durable.chunks[0].slack_ts;
      const replies = await this.slack("conversations.replies", {
        channel: input.receipt.channel_id,
        ts: input.receipt.thread_ts,
        limit: 100,
      });
      const responseMessage = exactSlackMessage(replies, responseMessageTs);
      const nativeTable = nativeResponseTable(responseMessage);
      const modelFooter = /_model: (?!unknown\b)[^\n]+ - cwd: [^\n]+_$/.exec(turn.outbound_text)?.[0];
      if (responseMessage.thread_ts !== input.receipt.thread_ts
          || !modelFooter
          || !String(responseMessage.text || "").includes(modelFooter.slice(1, -1))
          || responseMessage.user !== this.lane.bot_user_id
          || responseMessage.bot_id !== this.lane.bot_id
          || responseMessage.app_id !== this.lane.app_id
          || !String(responseMessage.text || "").trimStart().startsWith("TL;DR:")
          || countMarker(turn.response_tldr, input.marker) !== 1
          || countMarker(String(responseMessage.text || ""), input.marker) !== 1
          || !nativeTable) {
        throw new LiveTypedTurnError(
          "slack_terminal_delivery_mismatch",
          "Slack-visible response does not match the exact durable terminal delivery",
        );
      }
      const progressMessage = exactSlackMessage(replies, input.running.progress_message_ts);
      const terminalTask = activityTask(progressMessage, "complete");
      const workCompleteTitle = terminalTask ? requiredString(terminalTask.title, "the Work complete title") : "";
      const expectedWorkCompleteTitle = `Work complete · ${formatDuration(Number(turn.provider_duration_ms))}`;
      if (!isLaneBotReply(progressMessage, this.lane, input.receipt.thread_ts)
          || !terminalTask || workCompleteTitle !== expectedWorkCompleteTitle) {
        throw new LiveTypedTurnError(
          "slack_progress_lifecycle_mismatch",
          "Slack did not terminalize the observed activity as Work complete with provider elapsed time",
        );
      }
      const rootMessage = exactSlackMessage(replies, input.receipt.message_ts);
      const rootText = requiredString(rootMessage.text, "the updated root text");
      const expectedRootSummary = conciergeRootSummary(turn.outbound_text, postedInput.text);
      const expectedRootText = expectedRootSummary ? toMrkdwn(expectedRootSummary) : null;
      const terminalAgentSessionStatus = this.readAgentSessionStatusProjection(
        input.receipt.channel_id,
        input.receipt.thread_ts,
      );
      if (rootMessage.user !== this.lane.installer_user_id
          || !expectedRootText
          || rootText !== expectedRootText
          || Buffer.byteLength(rootText, "utf8") > 4_000
          || !rootText.includes("*Concierge TL;DR*")
          || !rootText.includes(turn.response_tldr)) {
        throw new LiveTypedTurnError(
          "slack_root_summary_mismatch",
          "Slack original root did not exactly match the bounded cumulative TL;DR",
        );
      }
      if (terminalAgentSessionStatus?.desired_status !== "active"
          || terminalAgentSessionStatus.projection_status !== "delivered"
          || terminalAgentSessionStatus.desired_revision
            !== terminalAgentSessionStatus.projected_revision) {
        throw new LiveTypedTurnError(
          "terminal_agent_session_status_mismatch",
          "Terminal Agent-session status was not durably delivered as active",
        );
      }
      const permalinkResponse = await this.slack("chat.getPermalink", {
        channel: input.receipt.channel_id,
        message_ts: responseMessageTs,
      });
      const responsePermalink = requiredString(permalinkResponse.permalink, "the response permalink");
      assertPermalink(
        responsePermalink,
        this.lane.browser.canonical_workspace_domain,
        input.receipt.channel_id,
        responseMessageTs,
      );
      return {
        api_app_id: ready.app_id,
        input_channel_id: input.receipt.channel_id,
        input_message_ts: input.receipt.message_ts,
        input_kind: "turn",
        input_user_id: this.lane.installer_user_id,
        turn_id: turn.turn_id,
        provider_id: turn.provider_id,
        provider_session_uuid: turn.provider_session_uuid,
        provider_turn_id: turn.provider_turn_id,
        turn_status: "done",
        delivery_status: "delivered",
        terminal_agent_session_status: "active",
        terminal_agent_session_projection_status: "delivered",
        terminal_agent_session_desired_revision: terminalAgentSessionStatus.desired_revision,
        terminal_agent_session_projected_revision: terminalAgentSessionStatus.projected_revision,
        progress_message_ts: input.running.progress_message_ts,
        work_complete_title: workCompleteTitle,
        provider_duration_ms: Number(turn.provider_duration_ms),
        response_message_ts: responseMessageTs,
        response_thread_ts: input.receipt.thread_ts,
        response_permalink: responsePermalink,
        response_tldr: turn.response_tldr,
        response_block_types: nativeTable.blockTypes,
        response_table: nativeTable.table,
        root_text: rootText,
        agent_text: turn.outbound_text,
      };
    }
    throw new LiveTypedTurnError(
      "typed_turn_timeout",
      "Exact sandbox typed turn did not reach durable terminal delivery before the deadline",
    );
  }

  private readDrain(receipt: TypedTurnPostReceipt, observation: TypedTurnObservation): TypedTurnDrain {
    return withReadonlyDatabase(this.stateDatabasePath, (database) => {
      const exact = database.query(`
        SELECT
          COUNT(DISTINCT claim.slack_channel_id || ':' || claim.slack_user_msg_ts) AS input_claims,
          COUNT(DISTINCT turn.id) AS turns,
          COUNT(DISTINCT CASE
            WHEN chunk.delivered_at IS NOT NULL AND chunk.slack_ts=? THEN turn.id || ':' || chunk.chunk_index
            ELSE NULL
          END) AS delivered_responses
        FROM slack_user_input_claims claim
        LEFT JOIN turns turn ON turn.id=claim.turn_id
        LEFT JOIN turn_delivery_chunks chunk ON chunk.turn_id=turn.id
        WHERE claim.slack_channel_id=? AND claim.slack_user_msg_ts=? AND turn.id=?
      `).get(
        observation.response_message_ts,
        receipt.channel_id,
        receipt.message_ts,
        observation.turn_id,
      ) as { input_claims: number; turns: number; delivered_responses: number };
      const unsettled = database.query(`
        SELECT
          (SELECT COUNT(*) FROM slack_user_input_claims WHERE kind='pending')
          + (SELECT COUNT(*) FROM turns WHERE status IN ('queued', 'running', 'delivering'))
          + (SELECT COUNT(*) FROM sessions WHERE status='running')
          + (SELECT COUNT(*) FROM turn_steering_messages WHERE status IN ('queued', 'sending'))
          + (SELECT COUNT(*) FROM turn_delivery_chunks WHERE delivered_at IS NULL)
          + (SELECT COUNT(*) FROM agent_progress_messages WHERE creation_state<>'posted' OR dirty<>0)
          + (SELECT COUNT(*) FROM turn_artifact_batches WHERE status IN ('collecting', 'pending'))
          + (SELECT COUNT(*) FROM turn_artifact_deliveries WHERE status IN ('pending', 'sending'))
          + (SELECT COUNT(*) FROM turns WHERE status_projection_status IN ('pending', 'sending'))
          + (SELECT COUNT(*) FROM slack_thread_statuses WHERE projection_status IN ('pending', 'sending'))
          + (SELECT COUNT(*) FROM slack_root_summary_projections WHERE projection_status IN ('pending', 'sending'))
          + (SELECT COUNT(*) FROM slack_agent_session_status_projections WHERE projection_status IN ('pending', 'sending'))
          + (SELECT COUNT(*) FROM slack_agent_session_title_projections WHERE projection_status IN ('pending', 'sending'))
          + (SELECT COUNT(*) FROM turn_reaction_cleanups WHERE cleanup_status IN ('pending', 'sending'))
          AS count
      `).get() as { count: number };
      return {
        run_owned_unsettled: Number(unsettled.count),
        input_claims: Number(exact.input_claims),
        turns: Number(exact.turns),
        delivered_responses: Number(exact.delivered_responses),
      };
    });
  }

  async drain(input: {
    lane: LaneFixtureIdentities;
    receipt: TypedTurnPostReceipt;
    observation: TypedTurnObservation;
  }): Promise<TypedTurnDrain> {
    const allowedChannels = new Set([this.lane.channels.core.id, this.lane.dm_channel_id]);
    if (input.lane.lane_id !== this.lane.lane_id
        || !allowedChannels.has(input.receipt.channel_id)
        || input.observation.input_message_ts !== input.receipt.message_ts) {
      throw new LiveTypedTurnError("input_identity_mismatch", "Drain request does not identify this exact sandbox run input");
    }
    const deadline = Date.now() + this.drainTimeoutMs;
    let drain: TypedTurnDrain | null = null;
    while (Date.now() <= deadline) {
      this.assertRunBinding();
      drain = this.readDrain(input.receipt, input.observation);
      if (drain.run_owned_unsettled === 0) return drain;
      await this.wait(this.pollIntervalMs);
    }
    throw new LiveTypedTurnError(
      "typed_turn_drain_timeout",
      `Exact sandbox run retained ${drain?.run_owned_unsettled ?? "unknown"} unsettled durable owner(s)`,
    );
  }

  async drainTodoCapture(input: {
    lane: LaneFixtureIdentities;
    receipt: TypedTurnPostReceipt;
    observation: TodoCaptureObservation;
  }): Promise<TodoCaptureDrain> {
    if (input.lane.lane_id !== this.lane.lane_id
        || input.receipt.channel_id !== this.lane.channels.capture.id
        || input.observation.input_message_ts !== input.receipt.message_ts) {
      throw new LiveTypedTurnError("input_identity_mismatch", "Todo-capture drain does not identify this exact run input");
    }
    const deadline = Date.now() + this.drainTimeoutMs;
    let drain: TodoCaptureDrain | null = null;
    while (Date.now() <= deadline) {
      this.assertRunBinding();
      drain = withReadonlyDatabase(this.stateDatabasePath, (database) => {
        const exact = database.query(`
          SELECT COUNT(*) AS input_claims,
                 SUM(CASE WHEN turn_id IS NOT NULL THEN 1 ELSE 0 END) AS turns,
                 SUM(CASE WHEN capture_confirmation_status='delivered' THEN 1 ELSE 0 END)
                   AS delivered_confirmations
          FROM slack_user_input_claims
          WHERE slack_channel_id=? AND slack_user_msg_ts=? AND kind='capture'
        `).get(input.receipt.channel_id, input.receipt.message_ts) as {
          input_claims: number;
          turns: number;
          delivered_confirmations: number;
        };
        const unsettled = database.query(`
          SELECT
            (SELECT COUNT(*) FROM slack_user_input_claims WHERE kind='pending')
            + (SELECT COUNT(*) FROM slack_user_input_claims
               WHERE capture_confirmation_status IN ('pending', 'sending'))
            + (SELECT COUNT(*) FROM turns WHERE status IN ('queued', 'running', 'delivering'))
            + (SELECT COUNT(*) FROM sessions WHERE status='running')
            + (SELECT COUNT(*) FROM turn_steering_messages WHERE status IN ('queued', 'sending'))
            + (SELECT COUNT(*) FROM turn_delivery_chunks WHERE delivered_at IS NULL)
            + (SELECT COUNT(*) FROM turn_artifact_batches WHERE status IN ('collecting', 'pending'))
            + (SELECT COUNT(*) FROM turn_artifact_deliveries WHERE status IN ('pending', 'sending'))
            + (SELECT COUNT(*) FROM turns WHERE status_projection_status IN ('pending', 'sending'))
            + (SELECT COUNT(*) FROM slack_thread_statuses WHERE projection_status IN ('pending', 'sending'))
            + (SELECT COUNT(*) FROM slack_root_summary_projections WHERE projection_status IN ('pending', 'sending'))
            + (SELECT COUNT(*) FROM slack_agent_session_status_projections WHERE projection_status IN ('pending', 'sending'))
            + (SELECT COUNT(*) FROM slack_agent_session_title_projections WHERE projection_status IN ('pending', 'sending'))
            + (SELECT COUNT(*) FROM turn_reaction_cleanups WHERE cleanup_status IN ('pending', 'sending'))
            AS count
        `).get() as { count: number };
        return {
          run_owned_unsettled: Number(unsettled.count),
          input_claims: Number(exact.input_claims),
          turns: Number(exact.turns || 0),
          delivered_confirmations: Number(exact.delivered_confirmations || 0),
        };
      });
      if (drain.run_owned_unsettled === 0) return drain;
      await this.wait(this.pollIntervalMs);
    }
    throw new LiveTypedTurnError(
      "todo_capture_drain_timeout",
      `Exact sandbox run retained ${drain?.run_owned_unsettled ?? "unknown"} unsettled durable owner(s)`,
    );
  }
}
