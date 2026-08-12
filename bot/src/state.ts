import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// Fail closed. No home-directory default. Both production and every test
// MUST explicitly set CONCIERGE_STATE_DIR:
//   - Production: systemd sets CONCIERGE_STATE_DIR=/root/.local/state/concierge
//   - Tests: bunfig.toml [test].preload runs tests/preload.ts which sets a
//     per-run /tmp scratch dir and CONCIERGE_TEST_MODE=1
//
// If nothing sets it, we refuse to open any database rather than
// silently defaulting to the production path. That default-fallback is
// the exact class of bug that wiped 63 channel rows on 2026-08-07.
const configuredDir = process.env.CONCIERGE_STATE_DIR;
if (!configuredDir) {
  throw new Error(
    "state.ts requires CONCIERGE_STATE_DIR to be set. " +
      "Production: systemd unit sets it to /root/.local/state/concierge. " +
      "Tests: bunfig.toml [test].preload sets it to /tmp/concierge-test-<pid>. " +
      "Refusing to fall back to a default path.",
  );
}

// Canonicalize via realpath so a symlink can't smuggle in a home-directory
// target under a /tmp mask (the guard below would false-pass otherwise).
mkdirSync(configuredDir, { recursive: true });
const canonicalDir = realpathSync(configuredDir);

// Test-mode guard: the canonical dir must NOT resolve inside $HOME. On AX41
// production this means any test process is structurally unable to touch
// /root/.local/state/concierge.
if (process.env.CONCIERGE_TEST_MODE === "1") {
  const canonicalHome = realpathSync(homedir());
  const rel = resolve(canonicalDir);
  if (rel === canonicalHome || rel.startsWith(canonicalHome + "/")) {
    throw new Error(
      `state.ts test-mode guard: CONCIERGE_STATE_DIR (${configuredDir}) ` +
        `canonicalizes to ${canonicalDir} which is inside home (${canonicalHome}). ` +
        `A test process is not allowed to open a DB inside home, including ` +
        `via a symlink. Point CONCIERGE_STATE_DIR at a real /tmp path.`,
    );
  }
}

export const db = new Database(`${canonicalDir}/state.db`, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

function columns(table: string): Set<string> {
  return new Set(
    db.query(`PRAGMA table_info(${table})`).all().map((row: any) => String(row.name)),
  );
}

function addColumn(table: string, name: string, sql: string) {
  if (!columns(table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${sql}`);
}

db.exec(`
CREATE TABLE IF NOT EXISTS channels (
  slack_channel_id   TEXT PRIMARY KEY,
  slack_channel_name TEXT NOT NULL,
  group_name         TEXT,
  name               TEXT,
  vault_path         TEXT NOT NULL,
  code_path          TEXT,
  additional_paths   TEXT DEFAULT '[]',
  provider_default   TEXT NOT NULL DEFAULT 'codex',
  mode               TEXT NOT NULL DEFAULT 'agent-auto',
  bot_user_id        TEXT,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  slack_channel_id   TEXT NOT NULL,
  slack_thread_ts    TEXT NOT NULL,
  provider_id        TEXT NOT NULL,
  agent_session_uuid TEXT,
  parent_session_id  INTEGER,
  parent_message_idx INTEGER,
  status             TEXT NOT NULL DEFAULT 'idle',
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_turn_at       DATETIME,
  UNIQUE(slack_channel_id, slack_thread_ts, provider_id)
);

CREATE TABLE IF NOT EXISTS turns (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id         INTEGER NOT NULL REFERENCES sessions(id),
  slack_user_msg_ts  TEXT NOT NULL,
  slack_bot_msg_ts   TEXT,
  user_text          TEXT NOT NULL,
  agent_text         TEXT,
  status             TEXT NOT NULL DEFAULT 'queued',
  started_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at           DATETIME,
  UNIQUE(session_id, slack_user_msg_ts)
);

CREATE TABLE IF NOT EXISTS turn_steering_messages (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id            INTEGER NOT NULL REFERENCES turns(id),
  slack_user_msg_ts  TEXT NOT NULL,
  reply_thread_ts    TEXT,
  user_text          TEXT NOT NULL,
  replay_text        TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'queued',
  provider_sent_at   DATETIME,
  error              TEXT,
  notice_status      TEXT NOT NULL DEFAULT 'not_needed',
  notice_attempts    INTEGER NOT NULL DEFAULT 0,
  notice_error       TEXT,
  notice_next_attempt_ms INTEGER,
  notice_parked_at   DATETIME,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(turn_id, slack_user_msg_ts)
);

CREATE TABLE IF NOT EXISTS slack_user_input_claims (
  slack_channel_id  TEXT NOT NULL,
  slack_user_msg_ts TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK(kind IN ('pending', 'turn', 'steering', 'capture', 'ignored', 'draining')),
  claim_token       TEXT NOT NULL,
  owner_instance_id TEXT,
  turn_id           INTEGER REFERENCES turns(id) ON DELETE CASCADE,
  reply_thread_ts   TEXT,
  user_id           TEXT,
  user_text         TEXT,
  files_json        TEXT NOT NULL DEFAULT '[]',
  inline_capture    INTEGER NOT NULL DEFAULT 0,
  capture_vault_status TEXT NOT NULL DEFAULT 'not_needed',
  capture_list_status TEXT NOT NULL DEFAULT 'not_needed',
  capture_list_item_id TEXT,
  capture_confirmation_status TEXT NOT NULL DEFAULT 'not_needed',
  capture_confirmation_attempts INTEGER NOT NULL DEFAULT 0,
  capture_confirmation_error TEXT,
  capture_confirmation_next_attempt_ms INTEGER,
  capture_confirmation_parked_at DATETIME,
  processing_error  TEXT,
  recovery_notice_status TEXT NOT NULL DEFAULT 'not_needed',
  recovery_notice_attempts INTEGER NOT NULL DEFAULT 0,
  recovery_notice_error TEXT,
  recovery_notice_next_attempt_ms INTEGER,
  recovery_notice_parked_at DATETIME,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(slack_channel_id, slack_user_msg_ts)
);

CREATE TABLE IF NOT EXISTS process_instances (
  instance_id        TEXT PRIMARY KEY,
  pid                INTEGER NOT NULL,
  boot_id            TEXT NOT NULL,
  process_start_ticks TEXT,
  started_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  heartbeat_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  stopped_at         DATETIME
);

CREATE TABLE IF NOT EXISTS deployment_drain (
  singleton           INTEGER PRIMARY KEY CHECK (singleton=1),
  token               TEXT NOT NULL,
  owner_pid           INTEGER NOT NULL,
  owner_boot_id       TEXT NOT NULL,
  owner_start_ticks   TEXT NOT NULL,
  claimed_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS turn_delivery_chunks (
  turn_id            INTEGER NOT NULL REFERENCES turns(id),
  chunk_index        INTEGER NOT NULL,
  slack_ts           TEXT,
  delivered_at       DATETIME,
  PRIMARY KEY(turn_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS comparison_requests (
  request_id           TEXT PRIMARY KEY,
  slack_channel_id     TEXT NOT NULL,
  requested_by         TEXT NOT NULL,
  source_session_id    INTEGER NOT NULL,
  source_message_ts    TEXT NOT NULL,
  target_provider      TEXT NOT NULL,
  target_model         TEXT,
  comparison_thread_ts TEXT,
  turn_id              INTEGER,
  status               TEXT NOT NULL DEFAULT 'claimed',
  error                TEXT,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS slack_thread_statuses (
  slack_channel_id       TEXT NOT NULL,
  slack_thread_ts        TEXT NOT NULL,
  slack_status_msg_ts    TEXT NOT NULL DEFAULT '',
  message_generation     INTEGER NOT NULL DEFAULT 0,
  thread_tldr            TEXT,
  summary_through_turn_id INTEGER,
  desired_text           TEXT,
  desired_turn_id        INTEGER,
  desired_revision       INTEGER NOT NULL DEFAULT 0,
  projected_revision     INTEGER NOT NULL DEFAULT 0,
  projection_status      TEXT NOT NULL DEFAULT 'not_needed',
  projection_attempts    INTEGER NOT NULL DEFAULT 0,
  projection_error       TEXT,
  projection_next_attempt_ms INTEGER,
  projection_parked_at   DATETIME,
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(slack_channel_id, slack_thread_ts)
);
`);

// A Slack message is one logical input even when Slack retries its event or
// provider timing changes how the router sees the thread. Backfill existing
// rows with ordinary turns first so upgrades preserve the oldest ownership.
db.exec(`
  INSERT OR IGNORE INTO slack_user_input_claims (
    slack_channel_id, slack_user_msg_ts, kind, claim_token, turn_id
  )
  SELECT s.slack_channel_id, t.slack_user_msg_ts, 'turn', 'legacy-turn:' || t.id, t.id
  FROM turns t
  JOIN sessions s ON s.id=t.session_id;

  INSERT OR IGNORE INTO slack_user_input_claims (
    slack_channel_id, slack_user_msg_ts, kind, claim_token, turn_id
  )
  SELECT s.slack_channel_id, steering.slack_user_msg_ts,
         'steering', 'legacy-steering:' || steering.id, t.id
  FROM turn_steering_messages steering
  JOIN turns t ON t.id=steering.turn_id
  JOIN sessions s ON s.id=t.session_id;
`);

addColumn("channels", "group_name", "group_name TEXT");
addColumn("channels", "name", "name TEXT");
addColumn("channels", "additional_paths", "additional_paths TEXT DEFAULT '[]'");
addColumn("channels", "provider_default", "provider_default TEXT NOT NULL DEFAULT 'codex'");
addColumn("channels", "mode", "mode TEXT NOT NULL DEFAULT 'agent-auto'");
addColumn("channels", "bot_user_id", "bot_user_id TEXT");
addColumn("channels", "canvas_id", "canvas_id TEXT");
addColumn("channels", "list_id", "list_id TEXT");
addColumn("channels", "list_title_column_id", "list_title_column_id TEXT");
addColumn("channels", "list_completed_column_id", "list_completed_column_id TEXT");
addColumn("channels", "list_creation_intent_id", "list_creation_intent_id TEXT");
addColumn("channels", "list_creation_started_at_ms", "list_creation_started_at_ms INTEGER");
addColumn("channels", "session_mode", "session_mode TEXT NOT NULL DEFAULT 'per-thread'");
addColumn("channels", "default_session_uuid", "default_session_uuid TEXT");
addColumn("sessions", "parent_message_idx", "parent_message_idx INTEGER");
addColumn("turns", "owner_instance_id", "owner_instance_id TEXT");
addColumn("turns", "delivery_status", "delivery_status TEXT NOT NULL DEFAULT 'not_ready'");
addColumn("turns", "delivered_at", "delivered_at DATETIME");
addColumn("turns", "delivery_error", "delivery_error TEXT");
addColumn("turns", "delivery_attempts", "delivery_attempts INTEGER NOT NULL DEFAULT 0");
addColumn("turns", "outbound_text", "outbound_text TEXT");
addColumn("turns", "replay_text", "replay_text TEXT");
addColumn("turns", "unreplayable_attachment_count", "unreplayable_attachment_count INTEGER NOT NULL DEFAULT 0");
addColumn("turns", "provider_started_at", "provider_started_at DATETIME");
addColumn("turns", "slack_reply_thread_ts", "slack_reply_thread_ts TEXT");
addColumn("turns", "response_tldr", "response_tldr TEXT");
addColumn("turn_steering_messages", "notice_status", "notice_status TEXT NOT NULL DEFAULT 'not_needed'");
addColumn("turn_steering_messages", "notice_attempts", "notice_attempts INTEGER NOT NULL DEFAULT 0");
addColumn("turn_steering_messages", "notice_error", "notice_error TEXT");
addColumn("turn_steering_messages", "reply_thread_ts", "reply_thread_ts TEXT");
addColumn("turn_steering_messages", "notice_next_attempt_ms", "notice_next_attempt_ms INTEGER");
addColumn("turn_steering_messages", "notice_parked_at", "notice_parked_at DATETIME");
addColumn("slack_user_input_claims", "reply_thread_ts", "reply_thread_ts TEXT");
addColumn("slack_user_input_claims", "user_id", "user_id TEXT");
addColumn("slack_user_input_claims", "user_text", "user_text TEXT");
addColumn("slack_user_input_claims", "files_json", "files_json TEXT NOT NULL DEFAULT '[]'");
addColumn("slack_user_input_claims", "inline_capture", "inline_capture INTEGER NOT NULL DEFAULT 0");
addColumn("slack_user_input_claims", "capture_vault_status", "capture_vault_status TEXT NOT NULL DEFAULT 'not_needed'");
addColumn("slack_user_input_claims", "capture_list_status", "capture_list_status TEXT NOT NULL DEFAULT 'not_needed'");
addColumn("slack_user_input_claims", "capture_list_item_id", "capture_list_item_id TEXT");
addColumn("slack_user_input_claims", "capture_confirmation_status", "capture_confirmation_status TEXT NOT NULL DEFAULT 'not_needed'");
addColumn("slack_user_input_claims", "capture_confirmation_attempts", "capture_confirmation_attempts INTEGER NOT NULL DEFAULT 0");
addColumn("slack_user_input_claims", "capture_confirmation_error", "capture_confirmation_error TEXT");
addColumn("slack_user_input_claims", "capture_confirmation_next_attempt_ms", "capture_confirmation_next_attempt_ms INTEGER");
addColumn("slack_user_input_claims", "capture_confirmation_parked_at", "capture_confirmation_parked_at DATETIME");
addColumn("slack_user_input_claims", "processing_error", "processing_error TEXT");
addColumn("slack_user_input_claims", "recovery_notice_status", "recovery_notice_status TEXT NOT NULL DEFAULT 'not_needed'");
addColumn("slack_user_input_claims", "recovery_notice_attempts", "recovery_notice_attempts INTEGER NOT NULL DEFAULT 0");
addColumn("slack_user_input_claims", "recovery_notice_error", "recovery_notice_error TEXT");
addColumn("slack_user_input_claims", "recovery_notice_next_attempt_ms", "recovery_notice_next_attempt_ms INTEGER");
addColumn("slack_user_input_claims", "recovery_notice_parked_at", "recovery_notice_parked_at DATETIME");
addColumn("comparison_requests", "turn_id", "turn_id INTEGER");
addColumn("process_instances", "process_start_ticks", "process_start_ticks TEXT");
addColumn("slack_thread_statuses", "message_generation", "message_generation INTEGER NOT NULL DEFAULT 0");
addColumn("slack_thread_statuses", "desired_text", "desired_text TEXT");
addColumn("slack_thread_statuses", "desired_turn_id", "desired_turn_id INTEGER");
addColumn("slack_thread_statuses", "desired_revision", "desired_revision INTEGER NOT NULL DEFAULT 0");
addColumn("slack_thread_statuses", "projected_revision", "projected_revision INTEGER NOT NULL DEFAULT 0");
addColumn("slack_thread_statuses", "projection_status", "projection_status TEXT NOT NULL DEFAULT 'not_needed'");
addColumn("slack_thread_statuses", "projection_attempts", "projection_attempts INTEGER NOT NULL DEFAULT 0");
addColumn("slack_thread_statuses", "projection_error", "projection_error TEXT");
addColumn("slack_thread_statuses", "projection_next_attempt_ms", "projection_next_attempt_ms INTEGER");
addColumn("slack_thread_statuses", "projection_parked_at", "projection_parked_at DATETIME");

export type ChannelMode = "agent-auto" | "agent-tag" | "silent";
export type SessionMode = "per-thread" | "single-persistent";
export type ProviderId = "codex" | "claude-code";

export interface RecoverableTurnRow {
  id: number;
  session_id: number;
  slack_channel_id: string;
  slack_thread_ts: string;
  slack_user_msg_ts: string;
  slack_bot_msg_ts: string | null;
  slack_reply_thread_ts: string | null;
  response_tldr: string | null;
  agent_text: string | null;
  outbound_text: string | null;
  status: "running" | "delivering";
  owner_instance_id: string | null;
  owner_pid: number | null;
  owner_boot_id: string | null;
  owner_process_start_ticks: string | null;
}

export function registerProcessInstance(instanceId: string, pid: number, bootId: string, processStartTicks: string) {
  db.query(`
    INSERT INTO process_instances (instance_id, pid, boot_id, process_start_ticks)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(instance_id) DO UPDATE SET
      pid=excluded.pid, boot_id=excluded.boot_id, process_start_ticks=excluded.process_start_ticks,
      heartbeat_at=CURRENT_TIMESTAMP, stopped_at=NULL
  `).run(instanceId, pid, bootId, processStartTicks);
}

export function heartbeatProcessInstance(instanceId: string) {
  db.query("UPDATE process_instances SET heartbeat_at=CURRENT_TIMESTAMP WHERE instance_id=?").run(instanceId);
}

export function stopProcessInstance(instanceId: string) {
  db.query("UPDATE process_instances SET stopped_at=CURRENT_TIMESTAMP WHERE instance_id=?").run(instanceId);
}

export function clearAbandonedDrain(isAlive: (identity: { pid: number; bootId: string; startTicks: string }) => boolean) {
  const gate = db.query("SELECT * FROM deployment_drain WHERE singleton=1").get() as any;
  if (gate && !isAlive({ pid: gate.owner_pid, bootId: gate.owner_boot_id, startTicks: gate.owner_start_ticks })) {
    db.query("DELETE FROM deployment_drain WHERE singleton=1 AND token=?").run(gate.token);
  }
}

export function listRecoverableTurns(): RecoverableTurnRow[] {
  return db.query(`
    SELECT t.id, t.session_id, s.slack_channel_id, s.slack_thread_ts,
           t.slack_user_msg_ts, t.slack_bot_msg_ts, t.slack_reply_thread_ts,
           t.response_tldr, t.agent_text, t.outbound_text, t.status,
           t.owner_instance_id, p.pid AS owner_pid, p.boot_id AS owner_boot_id,
           p.process_start_ticks AS owner_process_start_ticks
    FROM turns t
    JOIN sessions s ON s.id=t.session_id
    LEFT JOIN process_instances p ON p.instance_id=t.owner_instance_id
    WHERE t.status IN ('running', 'delivering')
    ORDER BY t.id
  `).all() as RecoverableTurnRow[];
}

export function interruptOrphanedTurn(turnId: number, observedOwnerId: string | null, reason: string): boolean {
  let interrupted = false;
  db.transaction(() => {
    const turn = db.query(`SELECT session_id FROM turns WHERE id=? AND status='running'
      AND owner_instance_id IS ?`).get(turnId, observedOwnerId) as any;
    if (!turn) return;
    db.query(`UPDATE turns SET status='interrupted', agent_text=?, delivery_status='not_available',
              delivery_error=?, ended_at=CURRENT_TIMESTAMP WHERE id=?`).run(reason, reason, turnId);
    db.query(`UPDATE turn_steering_messages
              SET status=CASE WHEN status='sending' THEN 'ambiguous' ELSE 'failed' END,
                  error=?, notice_status='pending', notice_next_attempt_ms=0
              WHERE turn_id=? AND status IN ('queued', 'sending')`).run(reason, turnId);
    db.query(`UPDATE turn_steering_messages
              SET notice_status='pending', notice_next_attempt_ms=0
              WHERE turn_id=? AND status='ambiguous' AND notice_status='deferred'`).run(turnId);
    db.query("UPDATE sessions SET status='idle' WHERE id=?").run(turn.session_id);
    interrupted = true;
  })();
  return interrupted;
}

export function recoverUnsettledSteeringMessages(
  isAlive: (identity: { pid: number; bootId: string; startTicks: string }) => boolean,
): { failed: number; ambiguous: number } {
  const unsettled = db.query(`
    SELECT steering.id, steering.status, turn.owner_instance_id,
           process.pid, process.boot_id, process.process_start_ticks
    FROM turn_steering_messages steering
    JOIN turns turn ON turn.id=steering.turn_id
    LEFT JOIN process_instances process ON process.instance_id=turn.owner_instance_id
    WHERE steering.status IN ('queued', 'sending')
    ORDER BY steering.id
  `).all() as Array<{
    id: number;
    status: "queued" | "sending";
    owner_instance_id: string | null;
    pid: number | null;
    boot_id: string | null;
    process_start_ticks: string | null;
  }>;
  const recovered = { failed: 0, ambiguous: 0 };
  for (const steering of unsettled) {
    const ownerAlive = steering.pid != null && isAlive({
      pid: steering.pid,
      bootId: steering.boot_id || "",
      startTicks: steering.process_start_ticks || "",
    });
    if (ownerAlive) continue;
    if (steering.status === "queued") {
      recovered.failed += db.query(`
        UPDATE turn_steering_messages
        SET status='failed',
            error='The provider turn ended before this steering message could be sent.',
            notice_status='pending', notice_next_attempt_ms=0
        WHERE id=? AND status='queued'
      `).run(steering.id).changes;
      continue;
    }
    recovered.ambiguous += db.query(`
      UPDATE turn_steering_messages
      SET status='ambiguous',
          error='Concierge stopped before provider acknowledgement could be durably recorded.',
          notice_status='pending', notice_next_attempt_ms=0
      WHERE id=? AND status='sending'
    `).run(steering.id).changes;
  }
  return recovered;
}

export function claimOrphanedDelivery(turnId: number, observedOwnerId: string | null, ownerInstanceId: string): boolean {
  return db.query(`UPDATE turns SET owner_instance_id=?
                   WHERE id=? AND status='delivering' AND owner_instance_id IS ?`)
    .run(ownerInstanceId, turnId, observedOwnerId).changes === 1;
}

export interface ChannelRow {
  slack_channel_id: string;
  slack_channel_name: string;
  group_name: string | null;
  name: string;
  vault_path: string;
  code_path: string | null;
  additional_paths: string;
  provider_default: string;
  mode: ChannelMode;
  bot_user_id: string | null;
  canvas_id: string | null;
  list_id: string | null;
  list_title_column_id: string | null;
  list_completed_column_id: string | null;
  list_creation_intent_id: string | null;
  list_creation_started_at_ms: number | null;
  session_mode: SessionMode;
  default_session_uuid: string | null;
}

export function updateChannelDefaultSessionUuid(chanId: string, uuid: string) {
  db.query("UPDATE channels SET default_session_uuid=? WHERE slack_channel_id=?").run(uuid, chanId);
}

export interface SessionRow {
  id: number;
  slack_channel_id: string;
  slack_thread_ts: string;
  provider_id: ProviderId;
  agent_session_uuid: string | null;
  parent_session_id: number | null;
  parent_message_idx: number | null;
  status: string;
}

export interface SlackThreadStatusRow {
  slack_channel_id: string;
  slack_thread_ts: string;
  slack_status_msg_ts: string;
  message_generation: number;
  thread_tldr: string | null;
  summary_through_turn_id: number | null;
  desired_text: string | null;
  desired_turn_id: number | null;
  desired_revision: number;
  projected_revision: number;
  projection_status: "not_needed" | "pending" | "sending" | "delivered" | "parked";
  projection_attempts: number;
  projection_error: string | null;
  projection_next_attempt_ms: number | null;
  projection_parked_at: string | null;
}

export interface SlackThreadResponseRow {
  turn_id: number;
  user_text: string;
  response_tldr: string | null;
  agent_text: string | null;
}

export interface SessionUserPromptRow {
  slack_user_msg_ts: string;
  user_text: string | null;
  replay_ready: number;
  status: string;
  unreplayable_attachment_count: number;
}

export interface TurnSteeringMessageRow {
  id: number;
  turn_id: number;
  slack_user_msg_ts: string;
  reply_thread_ts: string | null;
  user_text: string;
  replay_text: string;
  status: "queued" | "sending" | "sent" | "failed" | "ambiguous";
  provider_sent_at: string | null;
  error: string | null;
  notice_status: "not_needed" | "deferred" | "pending" | "sending" | "delivered" | "parked";
  notice_attempts: number;
  notice_error: string | null;
  notice_next_attempt_ms: number | null;
  notice_parked_at: string | null;
}

export interface SlackUserInputClaimRow {
  slack_channel_id: string;
  slack_user_msg_ts: string;
  kind: "pending" | "turn" | "steering" | "capture" | "ignored" | "draining";
  claim_token: string;
  owner_instance_id: string | null;
  turn_id: number | null;
  reply_thread_ts: string | null;
  user_id: string | null;
  user_text: string | null;
  files_json: string;
  inline_capture: number;
  capture_vault_status: "not_needed" | "pending" | "done";
  capture_list_status: "not_needed" | "pending" | "done" | "skipped";
  capture_list_item_id: string | null;
  capture_confirmation_status: "not_needed" | "pending" | "sending" | "delivered" | "parked";
  capture_confirmation_attempts: number;
  capture_confirmation_error: string | null;
  capture_confirmation_next_attempt_ms: number | null;
  capture_confirmation_parked_at: string | null;
  processing_error: string | null;
  recovery_notice_status: "not_needed" | "pending" | "sending" | "delivered" | "parked";
  recovery_notice_attempts: number;
  recovery_notice_error: string | null;
  recovery_notice_next_attempt_ms: number | null;
  recovery_notice_parked_at: string | null;
}

export interface SteeringFailureNoticeRow extends TurnSteeringMessageRow {
  slack_channel_id: string;
  slack_thread_ts: string;
}

export interface SlackInputRecoveryNoticeRow extends SlackUserInputClaimRow {
  slack_thread_ts: string;
}

export interface InlineCaptureConfirmationRow extends SlackUserInputClaimRow {
  slack_thread_ts: string;
}

export interface ComparisonRequestRow {
  request_id: string;
  slack_channel_id: string;
  requested_by: string;
  source_session_id: number;
  source_message_ts: string;
  target_provider: ProviderId;
  target_model: string | null;
  comparison_thread_ts: string | null;
  turn_id: number | null;
  status: string;
  error: string | null;
}

export function parseAdditionalPaths(row: Pick<ChannelRow, "additional_paths"> | null): string[] {
  if (!row?.additional_paths) return [];
  try {
    const parsed = JSON.parse(row.additional_paths);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function getChannel(chanId: string): ChannelRow | null {
  return db.query("SELECT * FROM channels WHERE slack_channel_id = ?").get(chanId) as ChannelRow | null;
}

export function getChannelByCodePath(codePath: string): ChannelRow | null {
  return db.query("SELECT * FROM channels WHERE code_path = ? LIMIT 1").get(codePath) as ChannelRow | null;
}

export function getAllChannels(): ChannelRow[] {
  return db.query("SELECT * FROM channels ORDER BY slack_channel_name").all() as ChannelRow[];
}

export function upsertChannel(row: {
  slack_channel_id: string;
  slack_channel_name: string;
  group_name: string | null;
  name: string;
  vault_path: string;
  code_path?: string | null;
  provider_default?: string;
  mode?: ChannelMode;
  bot_user_id?: string | null;
}) {
  db.query(`
    INSERT INTO channels (
      slack_channel_id, slack_channel_name, group_name, name, vault_path, code_path,
      provider_default, mode, bot_user_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slack_channel_id) DO UPDATE SET
      slack_channel_name=excluded.slack_channel_name,
      group_name=excluded.group_name,
      name=excluded.name,
      vault_path=excluded.vault_path,
      code_path=COALESCE(excluded.code_path, channels.code_path),
      provider_default=COALESCE(excluded.provider_default, channels.provider_default),
      mode=COALESCE(excluded.mode, channels.mode),
      bot_user_id=COALESCE(excluded.bot_user_id, channels.bot_user_id)
  `).run(
    row.slack_channel_id,
    row.slack_channel_name,
    row.group_name,
    row.name,
    row.vault_path,
    row.code_path ?? null,
    row.provider_default ?? "codex",
    row.mode ?? "agent-auto",
    row.bot_user_id ?? null,
  );
}

export function updateChannelCodePath(chanId: string, codePath: string) {
  db.query("UPDATE channels SET code_path=? WHERE slack_channel_id=?").run(codePath, chanId);
}

export function attachSlackChannelToCodePath(codePath: string, chanId: string, chanName: string): boolean {
  const result = db.query(`
    UPDATE channels
    SET slack_channel_id=?, slack_channel_name=?
    WHERE code_path=? AND slack_channel_id IS NULL
  `).run(chanId, chanName, codePath);
  return result.changes === 1;
}

export function updateChannelMode(chanId: string, mode: ChannelMode) {
  db.query("UPDATE channels SET mode=? WHERE slack_channel_id=?").run(mode, chanId);
}

export function updateChannelProvider(chanId: string, provider: string) {
  db.query("UPDATE channels SET provider_default=? WHERE slack_channel_id=?").run(provider, chanId);
}

export function updateChannelCanvasId(chanId: string, canvasId: string | null) {
  db.query("UPDATE channels SET canvas_id=? WHERE slack_channel_id=?").run(canvasId, chanId);
}

export function updateChannelListState(
  chanId: string,
  list: {
    listId: string | null;
    titleColumnId?: string | null;
    completedColumnId?: string | null;
  },
) {
  db.query(`
    UPDATE channels
    SET list_id=?,
        list_title_column_id=?,
        list_completed_column_id=?,
        list_creation_intent_id=NULL,
        list_creation_started_at_ms=NULL
    WHERE slack_channel_id=?
  `).run(
    list.listId,
    list.titleColumnId ?? null,
    list.completedColumnId ?? null,
    chanId,
  );
}

export interface ChannelListCreationIntent {
  id: string;
  startedAtMs: number;
}

export function beginChannelListCreationIntent(chanId: string): ChannelListCreationIntent | null {
  return db.transaction(() => {
    const current = db.query(`
      SELECT list_id, list_creation_intent_id, list_creation_started_at_ms
      FROM channels WHERE slack_channel_id=?
    `).get(chanId) as any;
    if (!current || current.list_id) return null;
    if (!current.list_creation_intent_id) {
      const intentId = randomUUID();
      const startedAtMs = Date.now();
      db.query(`
        UPDATE channels
        SET list_creation_intent_id=?, list_creation_started_at_ms=?
        WHERE slack_channel_id=? AND list_id IS NULL AND list_creation_intent_id IS NULL
      `).run(intentId, startedAtMs, chanId);
    }
    const intent = db.query(`
      SELECT list_creation_intent_id, list_creation_started_at_ms
      FROM channels WHERE slack_channel_id=? AND list_id IS NULL
    `).get(chanId) as any;
    return intent?.list_creation_intent_id
      ? { id: String(intent.list_creation_intent_id), startedAtMs: Number(intent.list_creation_started_at_ms) }
      : null;
  })();
}

export function clearChannelListState(chanId: string, expectedListId: string): boolean {
  const replacementIntentId = randomUUID();
  const replacementStartedAtMs = Date.now();
  return db.query(`
    UPDATE channels
    SET list_id=NULL, list_title_column_id=NULL, list_completed_column_id=NULL,
        list_creation_intent_id=?, list_creation_started_at_ms=?
    WHERE slack_channel_id=? AND list_id=?
  `).run(replacementIntentId, replacementStartedAtMs, chanId, expectedListId).changes === 1;
}

export function setAdditionalPaths(chanId: string, paths: string[]) {
  db.query("UPDATE channels SET additional_paths=? WHERE slack_channel_id=?").run(JSON.stringify([...new Set(paths)]), chanId);
}

export function getSession(chanId: string, threadTs: string, provider: ProviderId): SessionRow | null {
  return db.query("SELECT * FROM sessions WHERE slack_channel_id=? AND slack_thread_ts=? AND provider_id=?")
    .get(chanId, threadTs, provider) as SessionRow | null;
}

export function getSessionForThread(chanId: string, threadTs: string): SessionRow | null {
  return db.query("SELECT * FROM sessions WHERE slack_channel_id=? AND slack_thread_ts=? ORDER BY id ASC LIMIT 1")
    .get(chanId, threadTs) as SessionRow | null;
}

export function getSessionByUuid(chanId: string, uuid: string): SessionRow | null {
  return db.query(`
    SELECT * FROM sessions
    WHERE slack_channel_id=? AND agent_session_uuid=?
    ORDER BY id ASC
    LIMIT 1
  `).get(chanId, uuid) as SessionRow | null;
}

export function getSessionById(sessionId: number): SessionRow | null {
  return db.query("SELECT * FROM sessions WHERE id=?").get(sessionId) as SessionRow | null;
}

export function listSessionUserPrompts(
  sessionId: number,
  throughMessageTs?: string | null,
): SessionUserPromptRow[] {
  const through = throughMessageTs?.trim();
  type OrderedPromptRow = SessionUserPromptRow & {
    turn_order: number;
    source_kind: number;
    source_id: number;
  };
  const rows = db.query(`
    SELECT slack_user_msg_ts, user_text, replay_ready, status, unreplayable_attachment_count,
           turn_order, source_kind, source_id
    FROM (
      SELECT t.session_id,
             t.slack_user_msg_ts,
             t.replay_text AS user_text,
             CASE WHEN t.replay_text IS NOT NULL AND t.provider_started_at IS NOT NULL THEN 1 ELSE 0 END AS replay_ready,
             t.status,
             t.unreplayable_attachment_count,
             t.id AS turn_order,
             t.id AS source_id,
             0 AS source_kind
      FROM turns t
      UNION ALL
      SELECT t.session_id,
             steering.slack_user_msg_ts,
             steering.replay_text AS user_text,
             CASE WHEN steering.provider_sent_at IS NOT NULL THEN 1 ELSE 0 END AS replay_ready,
             CASE
               WHEN steering.status='failed' THEN 'steering_failed'
               WHEN steering.status='ambiguous' THEN 'steering_ambiguous'
               WHEN steering.status='queued' THEN 'steering_queued'
               WHEN steering.status='sending' THEN 'steering_sending'
               WHEN t.status IN ('running', 'delivering') THEN 'running'
               ELSE steering.status
             END AS status,
             0 AS unreplayable_attachment_count,
             t.id AS turn_order,
             steering.id AS source_id,
             1 AS source_kind
      FROM turn_steering_messages steering
      JOIN turns t ON t.id=steering.turn_id
    ) prompts
    WHERE session_id=?
    ORDER BY turn_order, source_kind, source_id
  `).all(sessionId) as OrderedPromptRow[];

  let selectedRows = rows;
  if (through) {
    const exactPromptIndex = rows.findIndex((row) => row.slack_user_msg_ts === through);
    if (exactPromptIndex >= 0) {
      selectedRows = rows.slice(0, exactPromptIndex + 1);
    } else {
      const deliveredTurn = db.query(`
        SELECT t.id
        FROM turns t
        LEFT JOIN turn_delivery_chunks chunk ON chunk.turn_id=t.id
        WHERE t.session_id=? AND (t.slack_bot_msg_ts=? OR chunk.slack_ts=?)
        ORDER BY t.id DESC
        LIMIT 1
      `).get(sessionId, through, through) as { id: number } | null;
      selectedRows = deliveredTurn
        ? rows.filter((row) => row.turn_order <= deliveredTurn.id)
        : [];
    }
  }

  return selectedRows.map(({ turn_order: _turnOrder, source_kind: _sourceKind, source_id: _sourceId, ...row }) => row);
}

export function claimSlackUserInput(
  chanId: string,
  slackUserMessageTs: string,
  claimToken: string,
  ownerInstanceId: string,
  envelope: {
    replyThreadTs?: string | null;
    userId?: string | null;
    userText?: string | null;
    files?: unknown[];
  } = {},
): { claimed: boolean; row: SlackUserInputClaimRow } {
  return db.transaction(() => {
    const inserted = db.query(`
      INSERT INTO slack_user_input_claims (
        slack_channel_id, slack_user_msg_ts, kind, claim_token, owner_instance_id,
        reply_thread_ts, user_id, user_text, files_json, inline_capture,
        capture_vault_status, capture_list_status
      ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slack_channel_id, slack_user_msg_ts) DO NOTHING
    `).run(
      chanId,
      slackUserMessageTs,
      claimToken,
      ownerInstanceId,
      envelope.replyThreadTs || slackUserMessageTs,
      envelope.userId || null,
      envelope.userText ?? null,
      JSON.stringify(envelope.files || []),
      0,
      "not_needed",
      "not_needed",
    );
    return {
      claimed: inserted.changes === 1,
      row: getSlackUserInputClaim(chanId, slackUserMessageTs)!,
    };
  })();
}

export function beginInlineCapture(
  chanId: string,
  slackUserMessageTs: string,
  claimToken: string,
): boolean {
  return db.transaction(() => {
    const result = db.query(`
      UPDATE slack_user_input_claims
      SET inline_capture=1,
          capture_vault_status='pending',
          capture_list_status='pending'
      WHERE slack_channel_id=? AND slack_user_msg_ts=?
        AND claim_token=? AND kind='pending' AND inline_capture=0
    `).run(chanId, slackUserMessageTs, claimToken);
    if (result.changes === 1) return true;
    const claim = getSlackUserInputClaim(chanId, slackUserMessageTs);
    return claim?.claim_token === claimToken
      && claim.kind === "pending"
      && claim.inline_capture === 1;
  })();
}

export function classifySlackUserInput(
  chanId: string,
  slackUserMessageTs: string,
  claimToken: string,
  kind: "capture" | "ignored" | "draining",
): boolean {
  return db.query(`
    UPDATE slack_user_input_claims
    SET kind=?, owner_instance_id=NULL,
        recovery_notice_status=CASE WHEN ?='draining' THEN 'pending' ELSE recovery_notice_status END,
        recovery_notice_error=CASE WHEN ?='draining' THEN NULL ELSE recovery_notice_error END,
        recovery_notice_next_attempt_ms=CASE WHEN ?='draining' THEN 0 ELSE recovery_notice_next_attempt_ms END,
        recovery_notice_parked_at=CASE WHEN ?='draining' THEN NULL ELSE recovery_notice_parked_at END
    WHERE slack_channel_id=? AND slack_user_msg_ts=?
      AND claim_token=? AND kind='pending'
  `).run(
    kind,
    kind,
    kind,
    kind,
    kind,
    chanId,
    slackUserMessageTs,
    claimToken,
  ).changes === 1;
}

export function markInlineCaptureVaultDone(
  chanId: string,
  slackUserMessageTs: string,
  claimToken: string,
): boolean {
  const result = db.query(`
    UPDATE slack_user_input_claims
    SET capture_vault_status='done'
    WHERE slack_channel_id=? AND slack_user_msg_ts=? AND claim_token=?
      AND kind='pending' AND inline_capture=1
      AND capture_vault_status IN ('pending', 'done')
  `).run(chanId, slackUserMessageTs, claimToken);
  return result.changes === 1;
}

export function markInlineCaptureListDone(
  chanId: string,
  slackUserMessageTs: string,
  claimToken: string,
  itemId: string,
): boolean {
  const result = db.query(`
    UPDATE slack_user_input_claims
    SET capture_list_status='done', capture_list_item_id=?, processing_error=NULL
    WHERE slack_channel_id=? AND slack_user_msg_ts=? AND claim_token=?
      AND kind='pending' AND inline_capture=1
      AND capture_list_status IN ('pending', 'done')
  `).run(itemId, chanId, slackUserMessageTs, claimToken);
  return result.changes === 1;
}

export function markInlineCaptureListSkipped(
  chanId: string,
  slackUserMessageTs: string,
  claimToken: string,
  reason: string,
): boolean {
  const result = db.query(`
    UPDATE slack_user_input_claims
    SET capture_list_status='skipped', processing_error=?
    WHERE slack_channel_id=? AND slack_user_msg_ts=? AND claim_token=?
      AND kind='pending' AND inline_capture=1
      AND capture_list_status IN ('pending', 'skipped')
  `).run(reason, chanId, slackUserMessageTs, claimToken);
  return result.changes === 1;
}

export function finishInlineCapture(
  chanId: string,
  slackUserMessageTs: string,
  claimToken: string,
): boolean {
  const result = db.query(`
    UPDATE slack_user_input_claims
    SET kind='capture', owner_instance_id=NULL,
        capture_confirmation_status='pending',
        capture_confirmation_next_attempt_ms=0
    WHERE slack_channel_id=? AND slack_user_msg_ts=? AND claim_token=?
      AND kind='pending' AND inline_capture=1
      AND capture_vault_status='done'
      AND capture_list_status IN ('done', 'skipped')
  `).run(chanId, slackUserMessageTs, claimToken);
  if (result.changes === 1) return true;
  return getSlackUserInputClaim(chanId, slackUserMessageTs)?.kind === "capture";
}

export function releasePendingSlackUserInput(
  chanId: string,
  slackUserMessageTs: string,
  claimToken: string,
): boolean {
  return db.query(`
    DELETE FROM slack_user_input_claims
    WHERE slack_channel_id=? AND slack_user_msg_ts=?
      AND claim_token=? AND kind='pending'
  `).run(chanId, slackUserMessageTs, claimToken).changes === 1;
}

export function failPendingSlackUserInput(
  chanId: string,
  slackUserMessageTs: string,
  claimToken: string,
  error: string,
): boolean {
  return db.query(`
    UPDATE slack_user_input_claims
    SET kind='ignored', owner_instance_id=NULL, processing_error=?,
        recovery_notice_status='pending', recovery_notice_next_attempt_ms=0
    WHERE slack_channel_id=? AND slack_user_msg_ts=?
      AND claim_token=? AND kind='pending'
  `).run(error, chanId, slackUserMessageTs, claimToken).changes === 1;
}

export function createTurnSteeringMessage(
  turnId: number,
  slackUserMessageTs: string,
  userText: string,
  replayText: string,
  inputClaimToken?: string,
  replyThreadTs?: string,
):
  | { row: TurnSteeringMessageRow; duplicate: false }
  | { row: TurnSteeringMessageRow | null; duplicate: true } {
  return db.transaction(() => {
    const owner = db.query(`
      SELECT s.slack_channel_id
      FROM turns t
      JOIN sessions s ON s.id=t.session_id
      WHERE t.id=?
    `).get(turnId) as { slack_channel_id: string } | null;
    if (!owner) throw new Error(`Cannot steer missing turn ${turnId}`);

    const claimToken = inputClaimToken || randomUUID();
    const claim = inputClaimToken
      ? db.query(`
          UPDATE slack_user_input_claims
          SET kind='steering', turn_id=?, owner_instance_id=NULL
          WHERE slack_channel_id=? AND slack_user_msg_ts=?
            AND claim_token=? AND kind='pending'
        `).run(turnId, owner.slack_channel_id, slackUserMessageTs, claimToken)
      : db.query(`
          INSERT INTO slack_user_input_claims (
            slack_channel_id, slack_user_msg_ts, kind, claim_token, turn_id
          ) VALUES (?, ?, 'steering', ?, ?)
          ON CONFLICT(slack_channel_id, slack_user_msg_ts) DO NOTHING
        `).run(owner.slack_channel_id, slackUserMessageTs, claimToken, turnId);
    if (claim.changes === 0) {
      const row = db.query(`
        SELECT steering.*
        FROM turn_steering_messages steering
        JOIN turns t ON t.id=steering.turn_id
        JOIN sessions s ON s.id=t.session_id
        WHERE s.slack_channel_id=? AND steering.slack_user_msg_ts=?
        ORDER BY steering.id ASC
        LIMIT 1
      `).get(owner.slack_channel_id, slackUserMessageTs) as TurnSteeringMessageRow | null;
      return { row, duplicate: true } as const;
    }

    const inserted = db.query(`
      INSERT INTO turn_steering_messages (
        turn_id, slack_user_msg_ts, reply_thread_ts, user_text, replay_text
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(turn_id, slack_user_msg_ts) DO NOTHING
    `).run(turnId, slackUserMessageTs, replyThreadTs || null, userText, replayText);
    const row = db.query(`SELECT * FROM turn_steering_messages WHERE turn_id=? AND slack_user_msg_ts=?`)
      .get(turnId, slackUserMessageTs) as TurnSteeringMessageRow;
    if (inserted.changes === 0) return { row, duplicate: true } as const;
    return { row, duplicate: false } as const;
  })();
}

export function getSlackUserInputClaim(
  chanId: string,
  slackUserMessageTs: string,
): SlackUserInputClaimRow | null {
  return db.query(`
    SELECT *
    FROM slack_user_input_claims
    WHERE slack_channel_id=? AND slack_user_msg_ts=?
  `).get(chanId, slackUserMessageTs) as SlackUserInputClaimRow | null;
}

export function releaseOrphanedSlackInputClaims(
  isAlive: (identity: { pid: number; bootId: string; startTicks: string }) => boolean,
): number {
  const pending = listOrphanedSlackInputClaims(isAlive);
  let released = 0;
  for (const claim of pending) {
    if (claim.inline_capture) continue;
    released += db.query(`
      UPDATE slack_user_input_claims
      SET kind='ignored', owner_instance_id=NULL,
          processing_error='Concierge stopped before this message was durably classified.',
          recovery_notice_status='pending', recovery_notice_next_attempt_ms=0
      WHERE slack_channel_id=? AND slack_user_msg_ts=? AND claim_token=? AND kind='pending'
    `).run(claim.slack_channel_id, claim.slack_user_msg_ts, claim.claim_token).changes;
  }
  return released;
}

export function listOrphanedSlackInputClaims(
  isAlive: (identity: { pid: number; bootId: string; startTicks: string }) => boolean,
): SlackUserInputClaimRow[] {
  const pending = db.query(`
    SELECT claim.*, process.pid, process.boot_id, process.process_start_ticks
    FROM slack_user_input_claims claim
    LEFT JOIN process_instances process ON process.instance_id=claim.owner_instance_id
    WHERE claim.kind='pending'
  `).all() as Array<SlackUserInputClaimRow & {
    pid: number | null;
    boot_id: string | null;
    process_start_ticks: string | null;
  }>;
  return pending.filter((claim) => {
    const ownerAlive = claim.pid != null && isAlive({
      pid: claim.pid,
      bootId: claim.boot_id || "",
      startTicks: claim.process_start_ticks || "",
    });
    return !ownerAlive;
  });
}

export function getSlackInputRecoveryNotice(
  chanId: string,
  slackUserMessageTs: string,
): SlackInputRecoveryNoticeRow | null {
  return db.query(`
    SELECT claim.*, COALESCE(claim.reply_thread_ts, claim.slack_user_msg_ts) AS slack_thread_ts
    FROM slack_user_input_claims claim
    WHERE claim.slack_channel_id=? AND claim.slack_user_msg_ts=?
  `).get(chanId, slackUserMessageTs) as SlackInputRecoveryNoticeRow | null;
}

export function listPendingSlackInputRecoveryNotices(): SlackInputRecoveryNoticeRow[] {
  return db.query(`
    SELECT claim.*, COALESCE(claim.reply_thread_ts, claim.slack_user_msg_ts) AS slack_thread_ts
    FROM slack_user_input_claims claim
    WHERE claim.recovery_notice_status='pending'
    ORDER BY claim.created_at, claim.slack_channel_id, claim.slack_user_msg_ts
  `).all() as SlackInputRecoveryNoticeRow[];
}

export function claimSlackInputRecoveryNotice(
  chanId: string,
  slackUserMessageTs: string,
  nowMs = Date.now(),
): SlackInputRecoveryNoticeRow | null {
  return db.transaction(() => {
    const claimed = db.query(`
      UPDATE slack_user_input_claims
      SET recovery_notice_status='sending',
          recovery_notice_attempts=recovery_notice_attempts+1,
          recovery_notice_error=NULL
      WHERE slack_channel_id=? AND slack_user_msg_ts=?
        AND recovery_notice_status='pending'
        AND COALESCE(recovery_notice_next_attempt_ms, 0) <= ?
    `).run(chanId, slackUserMessageTs, nowMs);
    if (claimed.changes === 0) return null;
    return getSlackInputRecoveryNotice(chanId, slackUserMessageTs);
  })();
}

export function markSlackInputRecoveryNoticeDelivered(chanId: string, slackUserMessageTs: string) {
  const result = db.query(`
    UPDATE slack_user_input_claims
    SET recovery_notice_status='delivered', recovery_notice_error=NULL,
        recovery_notice_next_attempt_ms=NULL
    WHERE slack_channel_id=? AND slack_user_msg_ts=? AND recovery_notice_status='sending'
  `).run(chanId, slackUserMessageTs);
  if (result.changes !== 1) throw new Error("Slack input recovery notice was not in sending state.");
}

export function markSlackInputRecoveryNoticeRetry(
  chanId: string,
  slackUserMessageTs: string,
  error: string,
  nextAttemptMs: number,
) {
  const result = db.query(`
    UPDATE slack_user_input_claims
    SET recovery_notice_status='pending', recovery_notice_error=?,
        recovery_notice_next_attempt_ms=?
    WHERE slack_channel_id=? AND slack_user_msg_ts=? AND recovery_notice_status='sending'
  `).run(error, nextAttemptMs, chanId, slackUserMessageTs);
  if (result.changes !== 1) throw new Error("Slack input recovery notice retry lost its sending lease.");
}

export function parkSlackInputRecoveryNotice(chanId: string, slackUserMessageTs: string, error: string) {
  const result = db.query(`
    UPDATE slack_user_input_claims
    SET recovery_notice_status='parked', recovery_notice_error=?,
        recovery_notice_next_attempt_ms=NULL, recovery_notice_parked_at=CURRENT_TIMESTAMP
    WHERE slack_channel_id=? AND slack_user_msg_ts=? AND recovery_notice_status='sending'
  `).run(error, chanId, slackUserMessageTs);
  if (result.changes !== 1) throw new Error("Slack input recovery notice could not be parked.");
}

export function recoverSlackInputRecoveryNoticeClaims(): number {
  return db.query(`
    UPDATE slack_user_input_claims
    SET recovery_notice_status='pending',
        recovery_notice_error='Notice delivery interrupted before completion.',
        recovery_notice_next_attempt_ms=0
    WHERE recovery_notice_status='sending'
  `).run().changes;
}

export function getInlineCaptureConfirmation(
  chanId: string,
  slackUserMessageTs: string,
): InlineCaptureConfirmationRow | null {
  return db.query(`
    SELECT claim.*, COALESCE(claim.reply_thread_ts, claim.slack_user_msg_ts) AS slack_thread_ts
    FROM slack_user_input_claims claim
    WHERE claim.slack_channel_id=? AND claim.slack_user_msg_ts=?
      AND claim.kind='capture'
  `).get(chanId, slackUserMessageTs) as InlineCaptureConfirmationRow | null;
}

export function listPendingInlineCaptureConfirmations(): InlineCaptureConfirmationRow[] {
  return db.query(`
    SELECT claim.*, COALESCE(claim.reply_thread_ts, claim.slack_user_msg_ts) AS slack_thread_ts
    FROM slack_user_input_claims claim
    WHERE claim.kind='capture' AND claim.capture_confirmation_status='pending'
    ORDER BY claim.created_at, claim.slack_channel_id, claim.slack_user_msg_ts
  `).all() as InlineCaptureConfirmationRow[];
}

export function claimInlineCaptureConfirmation(
  chanId: string,
  slackUserMessageTs: string,
  nowMs = Date.now(),
): InlineCaptureConfirmationRow | null {
  return db.transaction(() => {
    const claimed = db.query(`
      UPDATE slack_user_input_claims
      SET capture_confirmation_status='sending',
          capture_confirmation_attempts=capture_confirmation_attempts+1,
          capture_confirmation_error=NULL
      WHERE slack_channel_id=? AND slack_user_msg_ts=? AND kind='capture'
        AND capture_confirmation_status='pending'
        AND COALESCE(capture_confirmation_next_attempt_ms, 0) <= ?
    `).run(chanId, slackUserMessageTs, nowMs);
    if (claimed.changes === 0) return null;
    return getInlineCaptureConfirmation(chanId, slackUserMessageTs);
  })();
}

export function markInlineCaptureConfirmationDelivered(chanId: string, slackUserMessageTs: string) {
  const result = db.query(`
    UPDATE slack_user_input_claims
    SET capture_confirmation_status='delivered', capture_confirmation_error=NULL,
        capture_confirmation_next_attempt_ms=NULL
    WHERE slack_channel_id=? AND slack_user_msg_ts=?
      AND capture_confirmation_status='sending'
  `).run(chanId, slackUserMessageTs);
  if (result.changes !== 1) throw new Error("Inline capture confirmation was not in sending state.");
}

export function markInlineCaptureConfirmationRetry(
  chanId: string,
  slackUserMessageTs: string,
  error: string,
  nextAttemptMs: number,
) {
  const result = db.query(`
    UPDATE slack_user_input_claims
    SET capture_confirmation_status='pending', capture_confirmation_error=?,
        capture_confirmation_next_attempt_ms=?
    WHERE slack_channel_id=? AND slack_user_msg_ts=?
      AND capture_confirmation_status='sending'
  `).run(error, nextAttemptMs, chanId, slackUserMessageTs);
  if (result.changes !== 1) throw new Error("Inline capture confirmation retry lost its sending lease.");
}

export function parkInlineCaptureConfirmation(chanId: string, slackUserMessageTs: string, error: string) {
  const result = db.query(`
    UPDATE slack_user_input_claims
    SET capture_confirmation_status='parked', capture_confirmation_error=?,
        capture_confirmation_next_attempt_ms=NULL,
        capture_confirmation_parked_at=CURRENT_TIMESTAMP
    WHERE slack_channel_id=? AND slack_user_msg_ts=?
      AND capture_confirmation_status='sending'
  `).run(error, chanId, slackUserMessageTs);
  if (result.changes !== 1) throw new Error("Inline capture confirmation could not be parked.");
}

export function recoverInlineCaptureConfirmationClaims(): number {
  return db.query(`
    UPDATE slack_user_input_claims
    SET capture_confirmation_status='pending',
        capture_confirmation_error='Confirmation delivery interrupted before completion.',
        capture_confirmation_next_attempt_ms=0
    WHERE capture_confirmation_status='sending'
  `).run().changes;
}

function steeringStatus(steeringMessageId: number): TurnSteeringMessageRow["status"] | null {
  return (db.query("SELECT status FROM turn_steering_messages WHERE id=?").get(steeringMessageId) as any)?.status || null;
}

export function markTurnSteeringMessageSending(steeringMessageId: number) {
  const result = db.query(`UPDATE turn_steering_messages SET status='sending'
            WHERE id=? AND status='queued'`).run(steeringMessageId);
  if (result.changes !== 1 && steeringStatus(steeringMessageId) !== "sending") {
    throw new Error(`Steering ${steeringMessageId} could not enter sending state.`);
  }
}

export function markTurnSteeringMessageSent(steeringMessageId: number) {
  const result = db.query(`UPDATE turn_steering_messages
            SET status='sent', provider_sent_at=CURRENT_TIMESTAMP, error=NULL,
                notice_status='not_needed', notice_error=NULL,
                notice_next_attempt_ms=NULL, notice_parked_at=NULL
            WHERE id=? AND status IN ('sending', 'ambiguous')`).run(steeringMessageId);
  if (result.changes !== 1 && steeringStatus(steeringMessageId) !== "sent") {
    throw new Error(`Steering ${steeringMessageId} acknowledgement could not be persisted.`);
  }
}

export function markTurnSteeringMessageFailed(steeringMessageId: number, error: string) {
  const result = db.query(`UPDATE turn_steering_messages
            SET status='failed', error=?, notice_status='pending', notice_next_attempt_ms=0
            WHERE id=? AND status IN ('queued', 'sending')`).run(error, steeringMessageId);
  if (result.changes !== 1 && steeringStatus(steeringMessageId) !== "failed") {
    throw new Error(`Steering ${steeringMessageId} failure could not be persisted.`);
  }
}

export function markTurnSteeringMessageAmbiguous(steeringMessageId: number, error: string) {
  const result = db.query(`UPDATE turn_steering_messages
            SET status='ambiguous', error=?, notice_status='deferred', notice_next_attempt_ms=NULL
            WHERE id=? AND status='sending'`).run(error, steeringMessageId);
  const status = steeringStatus(steeringMessageId);
  if (result.changes !== 1 && status !== "ambiguous" && status !== "sent") {
    throw new Error(`Steering ${steeringMessageId} ambiguity could not be persisted.`);
  }
}

export function finalizeTurnSteeringMessageAmbiguity(steeringMessageId: number): boolean {
  const result = db.query(`UPDATE turn_steering_messages
    SET notice_status='pending', notice_next_attempt_ms=0
    WHERE id=? AND status='ambiguous' AND notice_status='deferred'
  `).run(steeringMessageId);
  if (result.changes === 1) return true;
  const row = db.query("SELECT status, notice_status FROM turn_steering_messages WHERE id=?")
    .get(steeringMessageId) as { status: string; notice_status: string } | null;
  if (row?.status === "sent" || row?.notice_status === "pending" || row?.notice_status === "delivered") return false;
  throw new Error(`Steering ${steeringMessageId} ambiguity could not be finalized.`);
}

export function getSteeringFailureNotice(steeringMessageId: number): SteeringFailureNoticeRow | null {
  return db.query(`
    SELECT steering.*, s.slack_channel_id,
           COALESCE(steering.reply_thread_ts, s.slack_thread_ts) AS slack_thread_ts
    FROM turn_steering_messages steering
    JOIN turns t ON t.id=steering.turn_id
    JOIN sessions s ON s.id=t.session_id
    WHERE steering.id=?
  `).get(steeringMessageId) as SteeringFailureNoticeRow | null;
}

export function claimSteeringFailureNotice(steeringMessageId: number, nowMs = Date.now()): SteeringFailureNoticeRow | null {
  return db.transaction(() => {
    const claimed = db.query(`UPDATE turn_steering_messages
      SET notice_status='sending', notice_attempts=notice_attempts+1, notice_error=NULL
      WHERE id=? AND notice_status='pending' AND status IN ('failed', 'ambiguous')
        AND COALESCE(notice_next_attempt_ms, 0) <= ?
    `).run(steeringMessageId, nowMs);
    if (claimed.changes === 0) return null;
    return getSteeringFailureNotice(steeringMessageId);
  })();
}

export function markSteeringFailureNoticeDelivered(steeringMessageId: number) {
  const result = db.query(`UPDATE turn_steering_messages
            SET notice_status='delivered', notice_error=NULL, notice_next_attempt_ms=NULL
            WHERE id=? AND notice_status='sending'`).run(steeringMessageId);
  if (result.changes !== 1) throw new Error(`Steering notice ${steeringMessageId} lost its sending lease.`);
}

export function markSteeringFailureNoticeFailed(
  steeringMessageId: number,
  error: string,
  nextAttemptMs = Date.now(),
) {
  const result = db.query(`UPDATE turn_steering_messages
            SET notice_status='pending', notice_error=?, notice_next_attempt_ms=?
            WHERE id=? AND notice_status='sending'`).run(error, nextAttemptMs, steeringMessageId);
  if (result.changes !== 1) throw new Error(`Steering notice ${steeringMessageId} retry lost its sending lease.`);
}

export function parkSteeringFailureNotice(steeringMessageId: number, error: string) {
  const result = db.query(`UPDATE turn_steering_messages
    SET notice_status='parked', notice_error=?, notice_next_attempt_ms=NULL,
        notice_parked_at=CURRENT_TIMESTAMP
    WHERE id=? AND notice_status='sending'
  `).run(error, steeringMessageId);
  if (result.changes !== 1) throw new Error(`Steering notice ${steeringMessageId} could not be parked.`);
}

export function recoverSteeringFailureNoticeClaims(): number {
  return db.query(`UPDATE turn_steering_messages
    SET notice_status='pending', notice_error='Notice delivery interrupted before completion.',
        notice_next_attempt_ms=0
    WHERE notice_status='sending' AND status IN ('failed', 'ambiguous')
  `).run().changes;
}

export function recoverDeferredSteeringFailureNotices(
  isAlive: (identity: { pid: number; bootId: string; startTicks: string }) => boolean,
): number {
  const deferred = db.query(`
    SELECT steering.id, turn.status AS turn_status,
           process.pid, process.boot_id, process.process_start_ticks
    FROM turn_steering_messages steering
    JOIN turns turn ON turn.id=steering.turn_id
    LEFT JOIN process_instances process ON process.instance_id=turn.owner_instance_id
    WHERE steering.status='ambiguous' AND steering.notice_status='deferred'
  `).all() as Array<{
    id: number;
    turn_status: string;
    pid: number | null;
    boot_id: string | null;
    process_start_ticks: string | null;
  }>;
  let recovered = 0;
  for (const steering of deferred) {
    const acknowledgementCouldStillArrive = steering.turn_status === "running"
      && steering.pid != null
      && isAlive({
        pid: steering.pid,
        bootId: steering.boot_id || "",
        startTicks: steering.process_start_ticks || "",
      });
    if (acknowledgementCouldStillArrive) continue;
    recovered += db.query(`
      UPDATE turn_steering_messages
      SET notice_status='pending', notice_next_attempt_ms=0
      WHERE id=? AND status='ambiguous' AND notice_status='deferred'
    `).run(steering.id).changes;
  }
  return recovered;
}

export function listPendingSteeringFailureNotices(): SteeringFailureNoticeRow[] {
  return db.query(`
    SELECT steering.*, s.slack_channel_id,
           COALESCE(steering.reply_thread_ts, s.slack_thread_ts) AS slack_thread_ts
    FROM turn_steering_messages steering
    JOIN turns t ON t.id=steering.turn_id
    JOIN sessions s ON s.id=t.session_id
    WHERE steering.notice_status='pending'
      AND steering.status IN ('failed', 'ambiguous')
    ORDER BY steering.id
  `).all() as SteeringFailureNoticeRow[];
}

export function updateTurnSteeringReplayText(steeringMessageId: number, replayText: string) {
  db.query(`UPDATE turn_steering_messages SET replay_text=? WHERE id=? AND status='queued'`)
    .run(replayText, steeringMessageId);
}

export function setTurnReplayInput(turnId: number, replayText: string, unreplayableAttachmentCount: number) {
  db.query(`UPDATE turns SET replay_text=?, unreplayable_attachment_count=? WHERE id=?`)
    .run(replayText, unreplayableAttachmentCount, turnId);
}

export function markTurnProviderStarted(turnId: number) {
  db.query("UPDATE turns SET provider_started_at=COALESCE(provider_started_at, CURRENT_TIMESTAMP) WHERE id=?")
    .run(turnId);
}

function sessionForSlackMessage(
  chanId: string,
  messageTs: string,
  includeUnacceptedSteering: boolean,
): SessionRow | null {
  return db.query(`
    SELECT s.*
    FROM sessions s
    JOIN turns t ON t.session_id = s.id
    LEFT JOIN turn_delivery_chunks chunk ON chunk.turn_id = t.id
    LEFT JOIN turn_steering_messages steering ON steering.turn_id = t.id
    WHERE s.slack_channel_id = ?
      AND (
        t.slack_user_msg_ts = ?
        OR t.slack_bot_msg_ts = ?
        OR chunk.slack_ts = ?
        OR (steering.slack_user_msg_ts = ? AND (? = 1 OR steering.status = 'sent'))
      )
    ORDER BY t.id DESC
    LIMIT 1
  `).get(chanId, messageTs, messageTs, messageTs, messageTs, includeUnacceptedSteering ? 1 : 0) as SessionRow | null;
}

export function getSessionForSlackMessage(chanId: string, messageTs: string): SessionRow | null {
  return sessionForSlackMessage(chanId, messageTs, false);
}

export function getSteeringMessageForSlackMessage(
  chanId: string,
  messageTs: string,
): TurnSteeringMessageRow | null {
  return db.query(`
    SELECT steering.*
    FROM turn_steering_messages steering
    JOIN turns t ON t.id=steering.turn_id
    JOIN sessions s ON s.id=t.session_id
    WHERE s.slack_channel_id=? AND steering.slack_user_msg_ts=?
    ORDER BY steering.id DESC
    LIMIT 1
  `).get(chanId, messageTs) as TurnSteeringMessageRow | null;
}

export function resolveComparisonSourceSession(
  chanId: string,
  messageTs: string,
): SessionRow | null {
  return sessionForSlackMessage(chanId, messageTs, true);
}

export function claimComparisonRequest(input: {
  requestId: string;
  channelId: string;
  requestedBy: string;
  sourceSessionId: number;
  sourceMessageTs: string;
  targetProvider: ProviderId;
  targetModel: string | null;
}): { claimed: boolean; row: ComparisonRequestRow } {
  return db.transaction(() => {
    const result = db.query(`
      INSERT INTO comparison_requests (
        request_id, slack_channel_id, requested_by, source_session_id,
        source_message_ts, target_provider, target_model
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_id) DO NOTHING
    `).run(
      input.requestId,
      input.channelId,
      input.requestedBy,
      input.sourceSessionId,
      input.sourceMessageTs,
      input.targetProvider,
      input.targetModel,
    );
    const row = db.query("SELECT * FROM comparison_requests WHERE request_id=?")
      .get(input.requestId) as ComparisonRequestRow;
    return { claimed: result.changes === 1, row };
  })();
}

export function attachComparisonThread(requestId: string, threadTs: string) {
  db.query(`UPDATE comparison_requests
            SET comparison_thread_ts=?, status='running', updated_at=CURRENT_TIMESTAMP
            WHERE request_id=?`).run(threadTs, requestId);
}

export function attachComparisonTurn(requestId: string, turnId: number) {
  db.query(`UPDATE comparison_requests
            SET turn_id=?, status='running', updated_at=CURRENT_TIMESTAMP
            WHERE request_id=?`).run(turnId, requestId);
}

export function finishComparisonRequest(requestId: string, status: "done" | "error", error: string | null = null) {
  db.query(`UPDATE comparison_requests
            SET status=?, error=?, updated_at=CURRENT_TIMESTAMP
            WHERE request_id=?`).run(status, error, requestId);
}

export function finishComparisonFromTurnOutcome(
  requestId: string,
  outcome: { status: string; error?: string },
): { status: "done" } | { status: "error"; error: string } {
  if (outcome.status === "delivered") {
    finishComparisonRequest(requestId, "done");
    return { status: "done" };
  }
  const detail = outcome.error ? `: ${outcome.error}` : "";
  const error = `Comparison turn ended with ${outcome.status}${detail}`;
  finishComparisonRequest(requestId, "error", error);
  return { status: "error", error };
}

export function reconcileComparisonRequests(): { done: number; error: number; pending: number } {
  return db.transaction(() => {
    const requests = db.query(`
      SELECT request_id, turn_id
      FROM comparison_requests
      WHERE status IN ('claimed', 'running')
      ORDER BY created_at, request_id
    `).all() as Array<{ request_id: string; turn_id: number | null }>;
    let done = 0;
    let error = 0;
    let pending = 0;

    for (const request of requests) {
      if (request.turn_id == null) {
        finishComparisonRequest(
          request.request_id,
          "error",
          "Concierge restarted before the comparison provider turn was created.",
        );
        error += 1;
        continue;
      }
      const turn = db.query("SELECT status, delivery_status FROM turns WHERE id=?")
        .get(request.turn_id) as { status: string; delivery_status: string } | null;
      if (!turn) {
        finishComparisonRequest(request.request_id, "error", "The comparison provider turn no longer exists.");
        error += 1;
      } else if (turn.status === "done" && turn.delivery_status === "delivered") {
        finishComparisonRequest(request.request_id, "done");
        done += 1;
      } else if (["error", "interrupted", "cancelled", "delivery_parked"].includes(turn.status)) {
        finishComparisonRequest(request.request_id, "error", `Comparison provider turn ended with ${turn.status}.`);
        error += 1;
      } else {
        pending += 1;
      }
    }
    return { done, error, pending };
  })();
}

export function resolveForkParentSession(chanId: string, messageTs?: string | null): SessionRow | null {
  const ts = messageTs?.trim();
  let parent: SessionRow | null;
  if (ts) {
    // Provider session forks cannot remove history after a steering input, so
    // a steering reply is not an honest point-in-time fork boundary.
    if (getSteeringMessageForSlackMessage(chanId, ts)) return null;
    parent = getSessionForSlackMessage(chanId, ts) || getSessionForThread(chanId, ts);
  } else {
    parent = getLatestSession(chanId);
  }
  if (!parent || parent.status === "running") return null;

  // A provider fork clones its complete hidden session; it cannot reconstruct
  // an earlier Slack boundary. Refuse the whole session while a turn is live
  // or any guidance might have reached the provider without a durable answer.
  const unsafe = db.query(`
    SELECT 1 AS unsafe
    FROM turns turn
    LEFT JOIN turn_steering_messages steering ON steering.turn_id = turn.id
    WHERE turn.session_id=?
      AND (
        turn.status IN ('running', 'delivering')
        OR steering.status IN ('queued', 'sending', 'ambiguous')
      )
    LIMIT 1
  `).get(parent.id);
  return unsafe ? null : parent;
}

export function getLatestSession(chanId: string): SessionRow | null {
  return db.query("SELECT * FROM sessions WHERE slack_channel_id=? ORDER BY COALESCE(last_turn_at, created_at) DESC LIMIT 1")
    .get(chanId) as SessionRow | null;
}

export function createOrGetSession(chanId: string, threadTs: string, provider: ProviderId): SessionRow {
  db.query(`
    INSERT INTO sessions (slack_channel_id, slack_thread_ts, provider_id)
    VALUES (?, ?, ?)
    ON CONFLICT(slack_channel_id, slack_thread_ts, provider_id) DO NOTHING
  `).run(chanId, threadTs, provider);
  return getSession(chanId, threadTs, provider)!;
}

export function upsertSession(
  chanId: string,
  threadTs: string,
  provider: ProviderId,
  uuid: string | null,
  extra: { parentSessionId?: number | null; parentMessageIdx?: number | null; status?: string } = {},
) {
  db.query(`
    INSERT INTO sessions (
      slack_channel_id, slack_thread_ts, provider_id, agent_session_uuid,
      parent_session_id, parent_message_idx, last_turn_at, status
    )
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(slack_channel_id, slack_thread_ts, provider_id) DO UPDATE SET
      agent_session_uuid = COALESCE(excluded.agent_session_uuid, sessions.agent_session_uuid),
      parent_session_id = COALESCE(excluded.parent_session_id, sessions.parent_session_id),
      parent_message_idx = COALESCE(excluded.parent_message_idx, sessions.parent_message_idx),
      last_turn_at = CURRENT_TIMESTAMP,
      status=excluded.status
  `).run(
    chanId,
    threadTs,
    provider,
    uuid,
    extra.parentSessionId ?? null,
    extra.parentMessageIdx ?? null,
    extra.status ?? "idle",
  );
}

export function startTurn(
  sessionId: number,
  userTs: string,
  userText: string,
  inputClaimToken?: string,
): { id: number; duplicate: boolean } {
  return db.transaction(() => {
    const session = db.query("SELECT slack_channel_id FROM sessions WHERE id=?")
      .get(sessionId) as { slack_channel_id: string } | null;
    if (!session) throw new Error(`Cannot start a turn for missing session ${sessionId}`);

    const claimToken = inputClaimToken || randomUUID();
    const claim = inputClaimToken
      ? db.query(`
          UPDATE slack_user_input_claims
          SET kind='turn', owner_instance_id=NULL
          WHERE slack_channel_id=? AND slack_user_msg_ts=?
            AND claim_token=? AND kind='pending'
        `).run(session.slack_channel_id, userTs, claimToken)
      : db.query(`
          INSERT INTO slack_user_input_claims (
            slack_channel_id, slack_user_msg_ts, kind, claim_token
          ) VALUES (?, ?, 'turn', ?)
          ON CONFLICT(slack_channel_id, slack_user_msg_ts) DO NOTHING
        `).run(session.slack_channel_id, userTs, claimToken);
    if (claim.changes === 0) {
      const existing = getSlackUserInputClaim(session.slack_channel_id, userTs);
      return { id: Number(existing?.turn_id || 0), duplicate: true };
    }

    const result = db.query(`
      INSERT INTO turns (session_id, slack_user_msg_ts, slack_reply_thread_ts, user_text, status)
      VALUES (?, ?, ?, ?, 'running')
      ON CONFLICT(session_id, slack_user_msg_ts) DO NOTHING
    `).run(sessionId, userTs, userTs, userText);
    const row = db.query("SELECT id FROM turns WHERE session_id=? AND slack_user_msg_ts=?")
      .get(sessionId, userTs) as { id: number };
    const id = Number(row.id);
    db.query(`UPDATE slack_user_input_claims SET turn_id=?
              WHERE slack_channel_id=? AND slack_user_msg_ts=? AND claim_token=?`)
      .run(id, session.slack_channel_id, userTs, claimToken);
    return { id, duplicate: result.changes === 0 };
  })();
}

export type AcquireTurnResult =
  | { id: number; duplicate: true; acquired: false; busy: false }
  | { id: number; duplicate: false; acquired: true; busy: false }
  | { id: number; duplicate: false; acquired: false; busy: true }
  | { id: number; duplicate: false; acquired: false; busy: false; draining: true };

export function acquireSessionTurn(
  sessionId: number,
  userTs: string,
  userText: string,
  ownerInstanceId: string | null = null,
  inputClaimToken?: string,
  replyThreadTs?: string,
): AcquireTurnResult {
  return db.transaction((): AcquireTurnResult => {
    const session = db.query("SELECT slack_channel_id FROM sessions WHERE id=?")
      .get(sessionId) as { slack_channel_id: string } | null;
    if (!session) throw new Error(`Cannot acquire a turn for missing session ${sessionId}`);

    const existingClaim = getSlackUserInputClaim(session.slack_channel_id, userTs);
    if (existingClaim && (!inputClaimToken || existingClaim.claim_token !== inputClaimToken)) {
      return { id: Number(existingClaim.turn_id || 0), duplicate: true, acquired: false, busy: false };
    }
    if (db.query("SELECT 1 FROM deployment_drain WHERE singleton=1").get()) {
      if (inputClaimToken) {
        db.query(`
          UPDATE slack_user_input_claims
          SET kind='draining', owner_instance_id=NULL,
              recovery_notice_status='pending', recovery_notice_error=NULL,
              recovery_notice_next_attempt_ms=0, recovery_notice_parked_at=NULL
          WHERE slack_channel_id=? AND slack_user_msg_ts=?
            AND claim_token=? AND kind='pending'
        `).run(session.slack_channel_id, userTs, inputClaimToken);
      }
      return { id: 0, duplicate: false, acquired: false, busy: false, draining: true };
    }

    const claimToken = inputClaimToken || randomUUID();
    const claim = inputClaimToken
      ? db.query(`
          UPDATE slack_user_input_claims
          SET kind='turn', owner_instance_id=NULL
          WHERE slack_channel_id=? AND slack_user_msg_ts=?
            AND claim_token=? AND kind='pending'
        `).run(session.slack_channel_id, userTs, claimToken)
      : db.query(`
          INSERT INTO slack_user_input_claims (
            slack_channel_id, slack_user_msg_ts, kind, claim_token
          ) VALUES (?, ?, 'turn', ?)
          ON CONFLICT(slack_channel_id, slack_user_msg_ts) DO NOTHING
        `).run(session.slack_channel_id, userTs, claimToken);
    if (claim.changes === 0) {
      const winner = getSlackUserInputClaim(session.slack_channel_id, userTs);
      return { id: Number(winner?.turn_id || 0), duplicate: true, acquired: false, busy: false };
    }

    const insert = db.query(`
      INSERT INTO turns (session_id, slack_user_msg_ts, slack_reply_thread_ts, user_text, status)
      VALUES (?, ?, ?, ?, 'queued')
      ON CONFLICT(session_id, slack_user_msg_ts) DO NOTHING
    `).run(sessionId, userTs, replyThreadTs || userTs, userText);
    const row = db.query("SELECT id FROM turns WHERE session_id=? AND slack_user_msg_ts=?")
      .get(sessionId, userTs) as { id: number };
    const id = Number(row.id);
    db.query(`UPDATE slack_user_input_claims SET turn_id=?
              WHERE slack_channel_id=? AND slack_user_msg_ts=? AND claim_token=?`)
      .run(id, session.slack_channel_id, userTs, claimToken);
    if (insert.changes === 0) return { id, duplicate: true, acquired: false, busy: false };

    const lock = db.query(`
      UPDATE sessions
      SET status='running', last_turn_at=CURRENT_TIMESTAMP
      WHERE id=? AND status <> 'running'
    `).run(sessionId);
    if (lock.changes === 0) {
      db.query(`
        UPDATE turns
        SET status='cancelled',
            agent_text='Session is already running another provider turn.',
            ended_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(id);
      return { id, duplicate: false, acquired: false, busy: true };
    }

    db.query("UPDATE turns SET status='running', owner_instance_id=? WHERE id=?").run(ownerInstanceId, id);
    return { id, duplicate: false, acquired: true, busy: false };
  })();
}

export function attachBotMessage(turnId: number, ts: string) {
  db.query("UPDATE turns SET slack_bot_msg_ts=? WHERE id=?").run(ts, turnId);
}

export function getSlackThreadStatus(chanId: string, threadTs: string): SlackThreadStatusRow | null {
  return db.query(`SELECT * FROM slack_thread_statuses
                   WHERE slack_channel_id=? AND slack_thread_ts=?`)
    .get(chanId, threadTs) as SlackThreadStatusRow | null;
}

export function associateLegacyTurnsWithSlackThread(chanId: string, threadTs: string, messageTimestamps: string[]) {
  if (messageTimestamps.length === 0) return 0;
  return db.transaction(() => {
    let associated = 0;
    const updateTurn = db.query(`
      UPDATE turns SET slack_reply_thread_ts=?
      WHERE slack_reply_thread_ts IS NULL AND slack_user_msg_ts=?
        AND session_id IN (SELECT id FROM sessions WHERE slack_channel_id=?)
    `);
    const updateClaim = db.query(`
      UPDATE slack_user_input_claims SET reply_thread_ts=?
      WHERE reply_thread_ts IS NULL AND slack_channel_id=? AND slack_user_msg_ts=? AND kind='turn'
    `);
    for (const messageTs of messageTimestamps) {
      associated += updateTurn.run(threadTs, messageTs, chanId).changes;
      updateClaim.run(threadTs, chanId, messageTs);
    }
    return associated;
  })();
}

export function findLegacySlackThreadStatusMessage(chanId: string, threadTs: string): string | null {
  const row = db.query(`
    SELECT t.slack_bot_msg_ts
    FROM turns t
    JOIN sessions s ON s.id=t.session_id
    LEFT JOIN channels channel ON channel.slack_channel_id=s.slack_channel_id
    LEFT JOIN slack_user_input_claims claim
      ON claim.slack_channel_id=s.slack_channel_id
     AND claim.slack_user_msg_ts=t.slack_user_msg_ts
    WHERE s.slack_channel_id=?
      AND (
        t.slack_reply_thread_ts=?
        OR (t.slack_reply_thread_ts IS NULL AND claim.reply_thread_ts=?)
        OR (
          t.slack_reply_thread_ts IS NULL AND claim.reply_thread_ts IS NULL
          AND (
            (COALESCE(channel.session_mode, 'per-thread')='per-thread' AND s.slack_thread_ts=?)
            OR t.slack_user_msg_ts=?
          )
        )
      )
      AND t.slack_bot_msg_ts IS NOT NULL
    ORDER BY t.id ASC
    LIMIT 1
  `).get(chanId, threadTs, threadTs, threadTs, threadTs) as { slack_bot_msg_ts: string } | null;
  return row?.slack_bot_msg_ts || null;
}

export function setSlackThreadStatusMessage(chanId: string, threadTs: string, statusMessageTs: string) {
  db.query(`
    INSERT INTO slack_thread_statuses (slack_channel_id, slack_thread_ts, slack_status_msg_ts)
    VALUES (?, ?, ?)
    ON CONFLICT(slack_channel_id, slack_thread_ts) DO UPDATE SET
      slack_status_msg_ts=excluded.slack_status_msg_ts,
      updated_at=CURRENT_TIMESTAMP
  `).run(chanId, threadTs, statusMessageTs);
}

export function requestSlackThreadStatusProjection(input: {
  channel: string;
  threadTs: string;
  text: string;
  turnId?: number | null;
  legacyMessageTs?: string | null;
}): SlackThreadStatusRow {
  return db.transaction(() => {
    db.query(`
      INSERT INTO slack_thread_statuses (
        slack_channel_id, slack_thread_ts, slack_status_msg_ts, desired_text,
        desired_turn_id, desired_revision, projection_status
      ) VALUES (?, ?, ?, ?, ?, 1, 'pending')
      ON CONFLICT(slack_channel_id, slack_thread_ts) DO UPDATE SET
        slack_status_msg_ts=CASE
          WHEN slack_thread_statuses.slack_status_msg_ts='' THEN excluded.slack_status_msg_ts
          ELSE slack_thread_statuses.slack_status_msg_ts
        END,
        desired_text=excluded.desired_text,
        desired_turn_id=excluded.desired_turn_id,
        desired_revision=slack_thread_statuses.desired_revision+1,
        projection_status='pending',
        projection_attempts=0,
        projection_error=NULL,
        projection_next_attempt_ms=0,
        projection_parked_at=NULL,
        updated_at=CURRENT_TIMESTAMP
    `).run(
      input.channel,
      input.threadTs,
      input.legacyMessageTs || "",
      input.text,
      input.turnId || null,
    );
    const row = getSlackThreadStatus(input.channel, input.threadTs)!;
    if (input.turnId && row.slack_status_msg_ts) {
      db.query("UPDATE turns SET slack_bot_msg_ts=? WHERE id=?")
        .run(row.slack_status_msg_ts, input.turnId);
    }
    return row;
  })();
}

export function claimSlackThreadStatusProjection(
  chanId: string,
  threadTs: string,
  nowMs: number,
): SlackThreadStatusRow | null {
  const claimed = db.query(`
    UPDATE slack_thread_statuses
    SET projection_status='sending', projection_attempts=projection_attempts+1,
        projection_error=NULL, updated_at=CURRENT_TIMESTAMP
    WHERE slack_channel_id=? AND slack_thread_ts=? AND projection_status='pending'
      AND COALESCE(projection_next_attempt_ms, 0) <= ?
  `).run(chanId, threadTs, nowMs);
  return claimed.changes === 1 ? getSlackThreadStatus(chanId, threadTs) : null;
}

export function recordSlackThreadStatusMessage(
  chanId: string,
  threadTs: string,
  generation: number,
  messageTs: string,
): SlackThreadStatusRow | null {
  return db.transaction(() => {
    db.query(`
      UPDATE slack_thread_statuses SET slack_status_msg_ts=?, updated_at=CURRENT_TIMESTAMP
      WHERE slack_channel_id=? AND slack_thread_ts=? AND message_generation=?
        AND slack_status_msg_ts=''
    `).run(messageTs, chanId, threadTs, generation);
    const row = getSlackThreadStatus(chanId, threadTs);
    if (row?.slack_status_msg_ts && row.desired_turn_id) {
      db.query("UPDATE turns SET slack_bot_msg_ts=? WHERE id=?")
        .run(row.slack_status_msg_ts, row.desired_turn_id);
    }
    return row;
  })();
}

export function replaceMissingSlackThreadStatusMessage(
  chanId: string,
  threadTs: string,
  generation: number,
  expectedMessageTs: string,
) {
  db.query(`
    UPDATE slack_thread_statuses
    SET slack_status_msg_ts='', message_generation=message_generation+1,
        projection_status='pending', projection_attempts=0, projection_error=NULL,
        projection_next_attempt_ms=0, projection_parked_at=NULL,
        updated_at=CURRENT_TIMESTAMP
    WHERE slack_channel_id=? AND slack_thread_ts=? AND message_generation=?
      AND slack_status_msg_ts=?
  `).run(chanId, threadTs, generation, expectedMessageTs);
}

export function markSlackThreadStatusProjectionDelivered(
  chanId: string,
  threadTs: string,
  revision: number,
) {
  db.transaction(() => {
    db.query(`
      UPDATE slack_thread_statuses
      SET projected_revision=MAX(projected_revision, ?),
          projection_status=CASE WHEN desired_revision=? THEN 'delivered' ELSE 'pending' END,
          projection_error=NULL, projection_next_attempt_ms=NULL, projection_parked_at=NULL,
          updated_at=CURRENT_TIMESTAMP
      WHERE slack_channel_id=? AND slack_thread_ts=?
    `).run(revision, revision, chanId, threadTs);
    const row = getSlackThreadStatus(chanId, threadTs);
    if (row?.slack_status_msg_ts && row.desired_turn_id) {
      db.query("UPDATE turns SET slack_bot_msg_ts=? WHERE id=?")
        .run(row.slack_status_msg_ts, row.desired_turn_id);
    }
  })();
}

export function markSlackThreadStatusProjectionRetry(
  chanId: string,
  threadTs: string,
  revision: number,
  error: string,
  nextAttemptMs: number,
) {
  db.query(`
    UPDATE slack_thread_statuses
    SET projection_status=CASE WHEN desired_revision=? THEN 'pending' ELSE projection_status END,
        projection_error=?,
        projection_next_attempt_ms=CASE WHEN desired_revision=? THEN ? ELSE 0 END,
        updated_at=CURRENT_TIMESTAMP
    WHERE slack_channel_id=? AND slack_thread_ts=?
  `).run(revision, error, revision, nextAttemptMs, chanId, threadTs);
}

export function parkSlackThreadStatusProjection(
  chanId: string,
  threadTs: string,
  revision: number,
  error: string,
) {
  db.query(`
    UPDATE slack_thread_statuses
    SET projection_status=CASE WHEN desired_revision=? THEN 'parked' ELSE 'pending' END,
        projection_error=?, projection_next_attempt_ms=NULL,
        projection_parked_at=CASE WHEN desired_revision=? THEN CURRENT_TIMESTAMP ELSE NULL END,
        updated_at=CURRENT_TIMESTAMP
    WHERE slack_channel_id=? AND slack_thread_ts=?
  `).run(revision, error, revision, chanId, threadTs);
}

export function recoverSlackThreadStatusProjectionClaims() {
  return db.query(`
    UPDATE slack_thread_statuses
    SET projection_status='pending', projection_next_attempt_ms=0,
        projection_error='Status projection interrupted before completion.',
        updated_at=CURRENT_TIMESTAMP
    WHERE projection_status='sending'
  `).run().changes;
}

export function listPendingSlackThreadStatusProjections(): SlackThreadStatusRow[] {
  return db.query(`
    SELECT * FROM slack_thread_statuses
    WHERE projection_status='pending'
    ORDER BY updated_at, slack_channel_id, slack_thread_ts
  `).all() as SlackThreadStatusRow[];
}

export function listSlackThreadResponses(chanId: string, threadTs: string): SlackThreadResponseRow[] {
  return db.query(`
    SELECT t.id AS turn_id, t.user_text, t.response_tldr, t.agent_text
    FROM turns t
    JOIN sessions s ON s.id=t.session_id
    LEFT JOIN channels channel ON channel.slack_channel_id=s.slack_channel_id
    LEFT JOIN slack_user_input_claims claim
      ON claim.slack_channel_id=s.slack_channel_id
     AND claim.slack_user_msg_ts=t.slack_user_msg_ts
    WHERE s.slack_channel_id=?
      AND (
        t.slack_reply_thread_ts=?
        OR (t.slack_reply_thread_ts IS NULL AND claim.reply_thread_ts=?)
        OR (
          t.slack_reply_thread_ts IS NULL AND claim.reply_thread_ts IS NULL
          AND (
            (COALESCE(channel.session_mode, 'per-thread')='per-thread' AND s.slack_thread_ts=?)
            OR t.slack_user_msg_ts=?
          )
        )
      )
      AND t.status='done' AND t.delivery_status IN ('delivered', 'not_ready')
    ORDER BY t.id ASC
  `).all(chanId, threadTs, threadTs, threadTs, threadTs) as SlackThreadResponseRow[];
}

export function advanceSlackThreadSummary(input: {
  channel: string;
  threadTs: string;
  statusMessageTs: string;
  turnId: number;
  tldr: string;
}): SlackThreadStatusRow {
  db.query(`
    INSERT INTO slack_thread_statuses (
      slack_channel_id, slack_thread_ts, slack_status_msg_ts, thread_tldr, summary_through_turn_id
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(slack_channel_id, slack_thread_ts) DO UPDATE SET
      thread_tldr=excluded.thread_tldr,
      summary_through_turn_id=excluded.summary_through_turn_id,
      updated_at=CURRENT_TIMESTAMP
    WHERE slack_thread_statuses.summary_through_turn_id IS NULL
       OR slack_thread_statuses.summary_through_turn_id < excluded.summary_through_turn_id
  `).run(input.channel, input.threadTs, input.statusMessageTs, input.tldr, input.turnId);
  return getSlackThreadStatus(input.channel, input.threadTs)!;
}

export function finishTurn(turnId: number, status: "done" | "error" | "cancelled", agentText: string | null) {
  db.query("UPDATE turns SET status=?, agent_text=?, ended_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(status, agentText, turnId);
}

export function markTurnDelivering(
  turnId: number,
  agentText: string,
  outboundText = agentText,
  chunkCount = 1,
  responseTldr: string | null = null,
) {
  db.transaction(() => {
    db.query(`UPDATE turns SET status='delivering', agent_text=?, outbound_text=?, response_tldr=?, delivery_status='pending',
              delivery_error=NULL WHERE id=? AND status='running'`).run(agentText, outboundText, responseTldr, turnId);
    for (let index = 0; index < chunkCount; index += 1) {
      db.query("INSERT OR IGNORE INTO turn_delivery_chunks (turn_id, chunk_index) VALUES (?, ?)").run(turnId, index);
    }
  })();
}

export function deliveredChunkIndexes(turnId: number): Set<number> {
  return new Set((db.query("SELECT chunk_index FROM turn_delivery_chunks WHERE turn_id=? AND delivered_at IS NOT NULL")
    .all(turnId) as any[]).map((row) => Number(row.chunk_index)));
}

export function markDeliveryChunkDelivered(turnId: number, chunkIndex: number, slackTs: string | null) {
  db.query(`UPDATE turn_delivery_chunks SET slack_ts=?, delivered_at=CURRENT_TIMESTAMP
            WHERE turn_id=? AND chunk_index=? AND delivered_at IS NULL`).run(slackTs, turnId, chunkIndex);
}

export function recordDeliveryAttempt(turnId: number, error: string | null) {
  db.query(`UPDATE turns SET delivery_attempts=delivery_attempts+1, delivery_error=?
            WHERE id=? AND status='delivering'`).run(error, turnId);
}

export function markTurnResponseDelivered(turnId: number): SlackThreadStatusRow | null {
  return db.transaction(() => {
    const turn = db.query(`
      SELECT t.session_id, t.slack_user_msg_ts, t.slack_reply_thread_ts, t.slack_bot_msg_ts, t.response_tldr,
             s.slack_channel_id, s.slack_thread_ts
      FROM turns t
      JOIN sessions s ON s.id=t.session_id
      WHERE t.id=? AND t.status='delivering'
    `).get(turnId) as any;
    if (!turn) return null;
    db.query(`UPDATE turns SET delivery_status='delivered', delivered_at=COALESCE(delivered_at, CURRENT_TIMESTAMP),
              delivery_error=NULL WHERE id=?`).run(turnId);
    if (!turn.slack_bot_msg_ts || !turn.response_tldr) return null;
    return advanceSlackThreadSummary({
      channel: turn.slack_channel_id,
      threadTs: turn.slack_reply_thread_ts || turn.slack_user_msg_ts,
      statusMessageTs: turn.slack_bot_msg_ts,
      turnId,
      tldr: turn.response_tldr,
    });
  })();
}

export function finishDeliveredTurn(turnId: number): boolean {
  return db.transaction(() => {
    const turn = db.query(`SELECT session_id FROM turns
      WHERE id=? AND status='delivering' AND delivery_status='delivered'`).get(turnId) as any;
    if (!turn) return false;
    db.query(`UPDATE turns SET status='done', ended_at=CURRENT_TIMESTAMP, owner_instance_id=NULL
              WHERE id=?`).run(turnId);
    db.query("UPDATE sessions SET status='idle' WHERE id=?").run(turn.session_id);
    return true;
  })();
}

export function markTurnDeliveryFailed(turnId: number, error: string) {
  db.query(`UPDATE turns SET delivery_status='pending', delivery_error=?
            WHERE id=? AND status='delivering'`).run(error, turnId);
}

export function parkTurnDelivery(turnId: number, ownerInstanceId: string, error: string | null = null): boolean {
  return db.transaction(() => {
    const turn = db.query(`SELECT session_id FROM turns WHERE id=? AND status='delivering'
      AND owner_instance_id=?`).get(turnId, ownerInstanceId) as any;
    if (!turn) return false;
    db.query(`UPDATE turns SET status='delivery_parked', delivery_status='parked', delivery_error=COALESCE(?, delivery_error),
      ended_at=CURRENT_TIMESTAMP, owner_instance_id=NULL WHERE id=?`).run(error, turnId);
    db.query("UPDATE sessions SET status='idle' WHERE id=?").run(turn.session_id);
    return true;
  })();
}

export function relinquishTurnDelivery(turnId: number, ownerInstanceId: string): boolean {
  return db.query(`UPDATE turns SET owner_instance_id=NULL,
      delivery_status=CASE WHEN delivery_status='delivered' THEN 'delivered' ELSE 'pending' END
    WHERE id=? AND status='delivering' AND owner_instance_id=?`).run(turnId, ownerInstanceId).changes === 1;
}

export function setSessionStatus(sessionId: number, status: "idle" | "running" | "error" | "archived") {
  db.query("UPDATE sessions SET status=? WHERE id=?").run(status, sessionId);
}
