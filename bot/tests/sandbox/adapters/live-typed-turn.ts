import { Database } from "bun:sqlite";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { LaneFixtureIdentities } from "../../../scripts/sandbox-provision";
import { formatDuration } from "../../../src/text";
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
    isRecord(block) && block.type === "task_card" && block.task_id !== "plan-progress" && block.status === status);
  if (tasks.length > 1) {
    throw new LiveTypedTurnError("slack_progress_lifecycle_mismatch", "Slack returned multiple current activity tasks");
  }
  return tasks[0] as JsonObject | undefined || null;
}

function isLaneBotReply(message: JsonObject, lane: LaneFixtureIdentities, threadTs: string): boolean {
  return message.thread_ts === threadTs && message.user === lane.bot_user_id
    && message.bot_id === lane.bot_id && message.app_id === lane.app_id;
}

function normalizedVisibleText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
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

export class LiveTypedTurnAdapter implements TypedTurnAdapter, TodoCaptureAdapter {
  private readonly lane: LaneFixtureIdentities;
  private readonly runId: string;
  private readonly laneNumber: number;
  private readonly runRoot: string;
  private readonly runMetadataPath: string;
  private readonly readyPath: string;
  private readonly stateDatabasePath: string;
  private readonly configPath: string;
  private readonly slack: TypedTurnSlackCaller;
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
    this.slack = options.slack || slackUserCallerFromConfig(this.configPath, options.requester);
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
      if (responseMessage.thread_ts !== input.receipt.thread_ts
          || responseMessage.user !== this.lane.bot_user_id
          || responseMessage.bot_id !== this.lane.bot_id
          || responseMessage.app_id !== this.lane.app_id
          || normalizedVisibleText(responseMessage.text) !== normalizedVisibleText(turn.outbound_text)
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
      if (rootMessage.user !== this.lane.installer_user_id
          || !rootText.startsWith(postedInput.text)
          || !rootText.includes("*Concierge TL;DR*")
          || !rootText.includes(turn.response_tldr)) {
        throw new LiveTypedTurnError(
          "slack_root_summary_mismatch",
          "Slack original root omitted the cumulative Concierge TL;DR",
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
