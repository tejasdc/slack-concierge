import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  ARCHIVED_QUEUED_TURN_ERROR,
  QUEUED_TURN_STATUS_TEXT,
  RETRYING_PROVIDER_TURN_STATUS_TEXT,
  parkedProviderTurnStatusText,
} from "./text";

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

const codexRemoteMirrorEventsSchema = `(
  observation_sequence    INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_thread_uuid    TEXT NOT NULL,
  provider_item_id        TEXT NOT NULL,
  provider_turn_id        TEXT NOT NULL,
  authorizing_session_id  INTEGER REFERENCES sessions(id),
  item_kind               TEXT NOT NULL CHECK(item_kind IN ('user', 'agent')),
  payload_text            TEXT NOT NULL,
  slack_channel_id        TEXT NOT NULL,
  slack_thread_ts         TEXT NOT NULL,
  client_msg_id           TEXT NOT NULL UNIQUE,
  status                  TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sending', 'delivered', 'parked')),
  slack_message_ts        TEXT,
  attempts                INTEGER NOT NULL DEFAULT 0,
  error                   TEXT,
  next_attempt_ms         INTEGER,
  created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider_thread_uuid, provider_item_id)
)`;

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
  provider_binding_token TEXT,
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
  mode                TEXT NOT NULL DEFAULT 'live' CHECK(mode IN ('live', 'held')),
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

CREATE TABLE IF NOT EXISTS fork_requests (
  request_id                    TEXT PRIMARY KEY,
  slack_channel_id              TEXT NOT NULL,
  requested_by                  TEXT NOT NULL,
  source_session_id             INTEGER NOT NULL REFERENCES sessions(id),
  source_message_ts             TEXT,
  source_message_excerpt        TEXT,
  provider_id                   TEXT NOT NULL,
  source_provider_session_uuid  TEXT NOT NULL,
  last_provider_turn_id         TEXT,
  cwd                           TEXT NOT NULL,
  additional_dirs_json          TEXT NOT NULL DEFAULT '[]',
  provider_request_key          TEXT NOT NULL UNIQUE,
  slack_client_msg_id           TEXT NOT NULL UNIQUE,
  status                        TEXT NOT NULL DEFAULT 'claimed',
  owner_instance_id             TEXT,
  forked_provider_session_uuid  TEXT,
  forked_provider_binding_token TEXT,
  slack_message_ts              TEXT,
  delivery_attempts             INTEGER NOT NULL DEFAULT 0,
  error                         TEXT,
  created_at                    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS slack_thread_statuses (
  slack_channel_id       TEXT NOT NULL,
  slack_thread_ts        TEXT NOT NULL,
  slack_status_msg_ts    TEXT NOT NULL DEFAULT '',
  anchor_turn_id         INTEGER REFERENCES turns(id),
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

CREATE TABLE IF NOT EXISTS slack_root_summary_projections (
  slack_channel_id       TEXT NOT NULL,
  slack_thread_ts        TEXT NOT NULL,
  root_message_ts        TEXT NOT NULL,
  desired_text           TEXT NOT NULL,
  desired_turn_id        INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  desired_revision       INTEGER NOT NULL DEFAULT 1,
  projected_revision     INTEGER NOT NULL DEFAULT 0,
  projection_status      TEXT NOT NULL DEFAULT 'pending' CHECK(projection_status IN ('pending', 'sending', 'delivered', 'parked')),
  projection_attempts    INTEGER NOT NULL DEFAULT 0,
  projection_error       TEXT,
  projection_next_attempt_ms INTEGER,
  projection_parked_at   DATETIME,
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(slack_channel_id, slack_thread_ts)
);

CREATE TABLE IF NOT EXISTS slack_agent_session_status_projections (
  slack_channel_id       TEXT NOT NULL,
  slack_thread_ts        TEXT NOT NULL,
  desired_status         TEXT NOT NULL CHECK(desired_status IN ('active', 'processing', 'suspended')),
  desired_revision       INTEGER NOT NULL DEFAULT 1,
  projected_revision     INTEGER NOT NULL DEFAULT 0,
  projection_status      TEXT NOT NULL DEFAULT 'pending' CHECK(projection_status IN ('pending', 'sending', 'delivered', 'parked')),
  projection_attempts    INTEGER NOT NULL DEFAULT 0,
  projection_error       TEXT,
  projection_next_attempt_ms INTEGER,
  projection_parked_at   DATETIME,
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(slack_channel_id, slack_thread_ts)
);

CREATE TABLE IF NOT EXISTS turn_reaction_cleanups (
  turn_id                 INTEGER PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  cleanup_status          TEXT NOT NULL DEFAULT 'pending',
  cleanup_attempts        INTEGER NOT NULL DEFAULT 0,
  cleanup_error           TEXT,
  cleanup_next_attempt_ms INTEGER,
  cleanup_parked_at       DATETIME,
  created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS turn_artifact_batches (
  turn_id             INTEGER PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  ownership_token     TEXT NOT NULL UNIQUE,
  directory_path      TEXT NOT NULL UNIQUE,
  status              TEXT NOT NULL CHECK(status IN ('collecting', 'pending', 'delivered', 'parked', 'ambiguous', 'abandoned')),
  error               TEXT,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS turn_artifact_deliveries (
  artifact_id         TEXT PRIMARY KEY,
  turn_id             INTEGER NOT NULL REFERENCES turn_artifact_batches(turn_id) ON DELETE CASCADE,
  slack_channel_id    TEXT NOT NULL,
  slack_thread_ts     TEXT NOT NULL,
  source_path         TEXT NOT NULL,
  filename            TEXT NOT NULL,
  byte_size           INTEGER NOT NULL,
  source_device       TEXT NOT NULL,
  source_inode        TEXT NOT NULL,
  content_sha256      TEXT NOT NULL,
  source_mtime_ms     REAL NOT NULL,
  status              TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'delivered', 'parked', 'ambiguous')),
  attempts            INTEGER NOT NULL DEFAULT 0,
  next_attempt_ms     INTEGER,
  owner_instance_id   TEXT,
  slack_file_id       TEXT,
  error               TEXT,
  cleanup_after_ms    INTEGER,
  staging_removed_at  DATETIME,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(turn_id, filename)
);

CREATE TABLE IF NOT EXISTS todo_sync_state (
  slack_channel_id        TEXT PRIMARY KEY,
  base_json               TEXT NOT NULL DEFAULT '[]',
  conflict_signature      TEXT,
  historical_migration_complete INTEGER NOT NULL DEFAULT 0,
  ignored_slack_item_ids_json TEXT NOT NULL DEFAULT '[]',
  updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS todo_sync_conflict_notices (
  slack_channel_id        TEXT NOT NULL,
  conflict_signature      TEXT NOT NULL,
  notice_text             TEXT NOT NULL,
  client_msg_id           TEXT NOT NULL UNIQUE,
  status                  TEXT NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared', 'pending', 'sending', 'delivered', 'parked')),
  owner_instance_id       TEXT,
  slack_message_ts        TEXT,
  attempts                INTEGER NOT NULL DEFAULT 0,
  error                   TEXT,
  next_attempt_ms         INTEGER,
  created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(slack_channel_id, conflict_signature)
);

CREATE TABLE IF NOT EXISTS codex_remote_turns (
  provider_thread_uuid    TEXT NOT NULL,
  provider_turn_id        TEXT NOT NULL,
  authorizing_session_id  INTEGER REFERENCES sessions(id),
  slack_channel_id        TEXT NOT NULL,
  slack_thread_ts         TEXT NOT NULL,
  created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(provider_thread_uuid, provider_turn_id)
);

CREATE TABLE IF NOT EXISTS codex_remote_mirror_events ${codexRemoteMirrorEventsSchema};

CREATE TABLE IF NOT EXISTS codex_remote_subscriptions (
  provider_thread_uuid    TEXT PRIMARY KEY,
  initialized_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS codex_remote_observed_items (
  provider_thread_uuid    TEXT NOT NULL,
  provider_item_id        TEXT NOT NULL,
  observed_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(provider_thread_uuid, provider_item_id)
);
`);

function migrateLegacyCodexRemoteMirrorEvents() {
  const currentColumns = columns("codex_remote_mirror_events");
  if (currentColumns.has("observation_sequence")) return;

  const requiredLegacyColumns = [
    "provider_thread_uuid", "provider_item_id", "provider_turn_id", "item_kind",
    "payload_text", "slack_channel_id", "slack_thread_ts", "client_msg_id", "status",
    "slack_message_ts", "attempts", "error", "next_attempt_ms", "created_at", "updated_at",
  ];
  const supportedLegacyColumns = new Set([...requiredLegacyColumns, "authorizing_session_id"]);
  const missingColumns = requiredLegacyColumns.filter((name) => !currentColumns.has(name));
  const unexpectedColumns = [...currentColumns].filter((name) => !supportedLegacyColumns.has(name));
  if (missingColumns.length > 0 || unexpectedColumns.length > 0) {
    throw new Error(
      `Unsupported codex_remote_mirror_events schema: missing=${missingColumns.join(",") || "none"} ` +
        `unexpected=${unexpectedColumns.join(",") || "none"}`,
    );
  }

  const migrationTable = "codex_remote_mirror_events_with_sequence";
  if (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(migrationTable)) {
    throw new Error(`Refusing to overwrite leftover migration table ${migrationTable}`);
  }
  const authorizingSession = currentColumns.has("authorizing_session_id")
    ? "authorizing_session_id"
    : "NULL";

  db.transaction(() => {
    const legacyCount = (db.query(
      "SELECT COUNT(*) AS count FROM codex_remote_mirror_events",
    ).get() as { count: number }).count;
    db.exec(`CREATE TABLE ${migrationTable} ${codexRemoteMirrorEventsSchema}`);
    db.exec(`
      INSERT INTO ${migrationTable} (
        provider_thread_uuid, provider_item_id, provider_turn_id, authorizing_session_id,
        item_kind, payload_text, slack_channel_id, slack_thread_ts, client_msg_id, status,
        slack_message_ts, attempts, error, next_attempt_ms, created_at, updated_at
      )
      SELECT
        provider_thread_uuid, provider_item_id, provider_turn_id, ${authorizingSession},
        item_kind, payload_text, slack_channel_id, slack_thread_ts, client_msg_id, status,
        slack_message_ts, attempts, error, next_attempt_ms, created_at, updated_at
      FROM codex_remote_mirror_events
      ORDER BY rowid
    `);
    const migratedCount = (db.query(
      `SELECT COUNT(*) AS count FROM ${migrationTable}`,
    ).get() as { count: number }).count;
    if (migratedCount !== legacyCount) {
      throw new Error(
        `Codex Remote mirror migration copied ${migratedCount} of ${legacyCount} rows`,
      );
    }
    const foreignKeyViolation = db.query(
      `PRAGMA foreign_key_check(${migrationTable})`,
    ).get();
    if (foreignKeyViolation) {
      throw new Error("Codex Remote mirror migration would violate a foreign key");
    }
    db.exec("DROP TABLE codex_remote_mirror_events");
    db.exec(`ALTER TABLE ${migrationTable} RENAME TO codex_remote_mirror_events`);
  })();
}

migrateLegacyCodexRemoteMirrorEvents();

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
addColumn("deployment_drain", "mode", "mode TEXT NOT NULL DEFAULT 'live' CHECK(mode IN ('live', 'held'))");
addColumn("channels", "provider_default", "provider_default TEXT NOT NULL DEFAULT 'codex'");
addColumn("channels", "mode", "mode TEXT NOT NULL DEFAULT 'agent-auto'");
addColumn("channels", "bot_user_id", "bot_user_id TEXT");
addColumn("channels", "canvas_id", "canvas_id TEXT");
addColumn("channels", "canvas_projected_commit", "canvas_projected_commit TEXT");
addColumn("channels", "list_id", "list_id TEXT");
addColumn("channels", "list_title_column_id", "list_title_column_id TEXT");
addColumn("channels", "list_completed_column_id", "list_completed_column_id TEXT");
addColumn("channels", "list_access_level", "list_access_level TEXT");
addColumn("channels", "list_creation_intent_id", "list_creation_intent_id TEXT");
addColumn("channels", "list_creation_started_at_ms", "list_creation_started_at_ms INTEGER");
addColumn("channels", "session_mode", "session_mode TEXT NOT NULL DEFAULT 'per-thread'");
addColumn("channels", "default_session_uuid", "default_session_uuid TEXT");
addColumn("sessions", "parent_message_idx", "parent_message_idx INTEGER");
addColumn("sessions", "provider_binding_token", "provider_binding_token TEXT");
addColumn("fork_requests", "forked_provider_binding_token", "forked_provider_binding_token TEXT");
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
addColumn("fork_requests", "source_message_excerpt", "source_message_excerpt TEXT");
addColumn("turns", "projection_mode", "projection_mode TEXT NOT NULL DEFAULT 'legacy'");
addColumn("turns", "progress_stream_ts", "progress_stream_ts TEXT");
addColumn("turns", "progress_stream_state", "progress_stream_state TEXT NOT NULL DEFAULT 'not_started'");
addColumn("turns", "progress_stream_error", "progress_stream_error TEXT");
addColumn("turns", "stop_requested_at", "stop_requested_at DATETIME");
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
addColumn("slack_thread_statuses", "anchor_turn_id", "anchor_turn_id INTEGER REFERENCES turns(id)");
backfillSlackThreadStatusAnchors();
addColumn("slack_thread_statuses", "desired_text", "desired_text TEXT");
addColumn("slack_thread_statuses", "desired_turn_id", "desired_turn_id INTEGER");
addColumn("slack_thread_statuses", "desired_revision", "desired_revision INTEGER NOT NULL DEFAULT 0");
addColumn("slack_thread_statuses", "projected_revision", "projected_revision INTEGER NOT NULL DEFAULT 0");
addColumn("slack_thread_statuses", "projection_status", "projection_status TEXT NOT NULL DEFAULT 'not_needed'");
addColumn("slack_thread_statuses", "projection_attempts", "projection_attempts INTEGER NOT NULL DEFAULT 0");
addColumn("slack_thread_statuses", "projection_error", "projection_error TEXT");
addColumn("slack_thread_statuses", "projection_next_attempt_ms", "projection_next_attempt_ms INTEGER");
addColumn("slack_thread_statuses", "projection_parked_at", "projection_parked_at DATETIME");
addColumn("turns", "status_message_generation", "status_message_generation INTEGER NOT NULL DEFAULT 0");
addColumn("turns", "status_desired_text", "status_desired_text TEXT");
addColumn("turns", "status_desired_revision", "status_desired_revision INTEGER NOT NULL DEFAULT 0");
addColumn("turns", "status_projected_revision", "status_projected_revision INTEGER NOT NULL DEFAULT 0");
addColumn("turns", "status_projection_status", "status_projection_status TEXT NOT NULL DEFAULT 'not_needed'");
addColumn("turns", "status_projection_attempts", "status_projection_attempts INTEGER NOT NULL DEFAULT 0");
addColumn("turns", "status_projection_error", "status_projection_error TEXT");
addColumn("turns", "status_projection_next_attempt_ms", "status_projection_next_attempt_ms INTEGER");
addColumn("turns", "status_projection_parked_at", "status_projection_parked_at DATETIME");
addColumn("turns", "provider_turn_id", "provider_turn_id TEXT");
addColumn("turns", "turn_kind", "turn_kind TEXT NOT NULL DEFAULT 'slack_user'");
addColumn("turns", "trigger_key", "trigger_key TEXT");
addColumn("turns", "requested_by_user_id", "requested_by_user_id TEXT");
addColumn("turns", "provider_model", "provider_model TEXT");
addColumn("turns", "reasoning_effort", "reasoning_effort TEXT");
addColumn("turns", "provider_admission_intended_at", "provider_admission_intended_at DATETIME");
addColumn("turns", "dispatch_attempt", "dispatch_attempt INTEGER NOT NULL DEFAULT 0");
addColumn("turns", "dispatch_failure_class", "dispatch_failure_class TEXT");
addColumn("turns", "dispatch_next_attempt_ms", "dispatch_next_attempt_ms INTEGER");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS turns_unique_trigger_key ON turns(turn_kind, trigger_key) WHERE trigger_key IS NOT NULL");
addColumn("todo_sync_state", "historical_migration_complete", "historical_migration_complete INTEGER NOT NULL DEFAULT 0");
addColumn("todo_sync_state", "ignored_slack_item_ids_json", "ignored_slack_item_ids_json TEXT NOT NULL DEFAULT '[]'");
addColumn("todo_sync_conflict_notices", "owner_instance_id", "owner_instance_id TEXT");
addColumn("codex_remote_mirror_events", "authorizing_session_id", "authorizing_session_id INTEGER REFERENCES sessions(id)");
const codexRemoteTurnsNeedAuthorizationBackfill = !columns("codex_remote_turns").has("authorizing_session_id");
if (codexRemoteTurnsNeedAuthorizationBackfill) {
  db.transaction(() => {
    addColumn("codex_remote_turns", "authorizing_session_id", "authorizing_session_id INTEGER REFERENCES sessions(id)");
    db.exec(`
      UPDATE codex_remote_turns AS remote_turn
      SET authorizing_session_id=(
        SELECT event.authorizing_session_id
        FROM codex_remote_mirror_events AS event
        WHERE event.provider_thread_uuid=remote_turn.provider_thread_uuid
          AND event.provider_turn_id=remote_turn.provider_turn_id
          AND event.item_kind='user'
          AND event.authorizing_session_id IS NOT NULL
        ORDER BY event.observation_sequence
        LIMIT 1
      )
    `);
  })();
}
db.exec("CREATE INDEX IF NOT EXISTS sessions_provider_uuid_status_idx ON sessions(provider_id, agent_session_uuid, status)");
db.exec("CREATE INDEX IF NOT EXISTS codex_remote_mirror_events_status_attempt_sequence_idx ON codex_remote_mirror_events(status, next_attempt_ms, observation_sequence)");
db.exec("CREATE INDEX IF NOT EXISTS codex_remote_mirror_events_thread_status_sequence_idx ON codex_remote_mirror_events(slack_channel_id, slack_thread_ts, status, observation_sequence)");

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
  provider_admission_intended_at: string | null;
  turn_kind: string;
  requested_by_user_id: string | null;
  projection_mode: TurnProjectionMode;
  progress_stream_ts: string | null;
  progress_stream_state: TurnProgressStreamRow["progress_stream_state"];
  stop_requested_at: string | null;
  dispatch_attempt: number;
}

export interface TurnArtifactBatchRow {
  turn_id: number;
  ownership_token: string;
  directory_path: string;
  status: "collecting" | "pending" | "delivered" | "parked" | "ambiguous" | "abandoned";
  error: string | null;
}

export interface TurnArtifactDeliveryRow {
  artifact_id: string;
  turn_id: number;
  slack_channel_id: string;
  slack_thread_ts: string;
  directory_path: string;
  source_path: string;
  filename: string;
  byte_size: number;
  source_device: string;
  source_inode: string;
  content_sha256: string;
  source_mtime_ms: number;
  status: "pending" | "sending" | "delivered" | "parked" | "ambiguous";
  attempts: number;
  next_attempt_ms: number | null;
  owner_instance_id: string | null;
  slack_file_id: string | null;
  error: string | null;
  cleanup_after_ms: number | null;
  staging_removed_at: string | null;
}

export interface TurnArtifactRegistration {
  path: string;
  filename: string;
  size: number;
  device: string;
  inode: string;
  sha256: string;
  mtimeMs: number;
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
  if (gate && gate.mode !== "held"
    && !isAlive({ pid: gate.owner_pid, bootId: gate.owner_boot_id, startTicks: gate.owner_start_ticks })) {
    db.query("DELETE FROM deployment_drain WHERE singleton=1 AND token=?").run(gate.token);
  }
}

export function listRecoverableTurns(): RecoverableTurnRow[] {
  return db.query(`
    SELECT t.id, t.session_id, s.slack_channel_id, s.slack_thread_ts,
           t.slack_user_msg_ts, t.slack_bot_msg_ts, t.slack_reply_thread_ts,
           t.response_tldr, t.agent_text, t.outbound_text, t.status,
           t.provider_admission_intended_at, t.turn_kind, t.requested_by_user_id, t.projection_mode,
           t.progress_stream_ts, t.progress_stream_state, t.stop_requested_at, t.dispatch_attempt,
           t.owner_instance_id, p.pid AS owner_pid, p.boot_id AS owner_boot_id,
           p.process_start_ticks AS owner_process_start_ticks
    FROM turns t
    JOIN sessions s ON s.id=t.session_id
    LEFT JOIN process_instances p ON p.instance_id=t.owner_instance_id
    WHERE t.status IN ('running', 'delivering')
    ORDER BY t.id
  `).all() as RecoverableTurnRow[];
}

function queueTurnReactionCleanup(turnId: number) {
  db.query(`
    INSERT INTO turn_reaction_cleanups (turn_id, cleanup_status, cleanup_next_attempt_ms)
    SELECT id, 'pending', 0 FROM turns
    WHERE id=? AND turn_kind IN ('slack_user', 'comparison') AND projection_mode='legacy'
    ON CONFLICT(turn_id) DO NOTHING
  `).run(turnId);
}

export function requestTurnReactionCleanup(turnId: number): TurnReactionCleanupRow {
  queueTurnReactionCleanup(turnId);
  const cleanup = getTurnReactionCleanup(turnId);
  if (!cleanup) throw new Error(`Cannot queue reaction cleanup for missing turn ${turnId}.`);
  return cleanup;
}

export function getTurnReactionCleanup(turnId: number): TurnReactionCleanupRow | null {
  return db.query(`
    SELECT cleanup.turn_id, session.slack_channel_id, turn.slack_user_msg_ts,
           cleanup.cleanup_status, cleanup.cleanup_attempts, cleanup.cleanup_error,
           cleanup.cleanup_next_attempt_ms, cleanup.cleanup_parked_at
    FROM turn_reaction_cleanups cleanup
    JOIN turns turn ON turn.id=cleanup.turn_id
    JOIN sessions session ON session.id=turn.session_id
    WHERE cleanup.turn_id=?
  `).get(turnId) as TurnReactionCleanupRow | null;
}

export function listPendingTurnReactionCleanups(): TurnReactionCleanupRow[] {
  return db.query(`
    SELECT cleanup.turn_id, session.slack_channel_id, turn.slack_user_msg_ts,
           cleanup.cleanup_status, cleanup.cleanup_attempts, cleanup.cleanup_error,
           cleanup.cleanup_next_attempt_ms, cleanup.cleanup_parked_at
    FROM turn_reaction_cleanups cleanup
    JOIN turns turn ON turn.id=cleanup.turn_id
    JOIN sessions session ON session.id=turn.session_id
    WHERE cleanup.cleanup_status='pending'
    ORDER BY cleanup.updated_at, cleanup.turn_id
  `).all() as TurnReactionCleanupRow[];
}

export function claimTurnReactionCleanup(turnId: number, nowMs = Date.now()): TurnReactionCleanupRow | null {
  const claimed = db.query(`
    UPDATE turn_reaction_cleanups
    SET cleanup_status='sending', cleanup_attempts=cleanup_attempts+1,
        updated_at=CURRENT_TIMESTAMP
    WHERE turn_id=? AND cleanup_status='pending'
      AND COALESCE(cleanup_next_attempt_ms, 0) <= ?
  `).run(turnId, nowMs);
  return claimed.changes === 1 ? getTurnReactionCleanup(turnId) : null;
}

export function markTurnReactionCleanupDelivered(turnId: number) {
  const delivered = db.query(`
    UPDATE turn_reaction_cleanups
    SET cleanup_status='delivered', cleanup_error=NULL,
        cleanup_next_attempt_ms=NULL, cleanup_parked_at=NULL,
        updated_at=CURRENT_TIMESTAMP
    WHERE turn_id=? AND cleanup_status='sending'
  `).run(turnId);
  if (delivered.changes !== 1) throw new Error("Turn reaction cleanup was not in sending state.");
}

export function markTurnReactionCleanupRetry(turnId: number, error: string, nextAttemptMs: number) {
  const retried = db.query(`
    UPDATE turn_reaction_cleanups
    SET cleanup_status='pending', cleanup_error=?, cleanup_next_attempt_ms=?,
        updated_at=CURRENT_TIMESTAMP
    WHERE turn_id=? AND cleanup_status='sending'
  `).run(error, nextAttemptMs, turnId);
  if (retried.changes !== 1) throw new Error("Turn reaction cleanup retry lost its sending lease.");
}

export function parkTurnReactionCleanup(turnId: number, error: string) {
  const parked = db.query(`
    UPDATE turn_reaction_cleanups
    SET cleanup_status='parked', cleanup_error=?, cleanup_next_attempt_ms=NULL,
        cleanup_parked_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
    WHERE turn_id=? AND cleanup_status='sending'
  `).run(error, turnId);
  if (parked.changes !== 1) throw new Error("Turn reaction cleanup could not be parked.");
}

export function parkExhaustedTurnReactionCleanup(turnId: number, maximumAttempts: number): boolean {
  return db.query(`
    UPDATE turn_reaction_cleanups
    SET cleanup_status='parked',
        cleanup_error=COALESCE(cleanup_error, 'Reaction cleanup exhausted its retry limit.'),
        cleanup_next_attempt_ms=NULL, cleanup_parked_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP
    WHERE turn_id=? AND cleanup_status='pending' AND cleanup_attempts>=?
  `).run(turnId, maximumAttempts).changes === 1;
}

export function recoverTurnReactionCleanupClaims(): number {
  return db.query(`
    UPDATE turn_reaction_cleanups
    SET cleanup_status='pending',
        cleanup_error=COALESCE(cleanup_error, 'Reaction cleanup interrupted before completion.'),
        cleanup_next_attempt_ms=0, updated_at=CURRENT_TIMESTAMP
    WHERE cleanup_status='sending'
  `).run().changes;
}

const ARTIFACT_FAILURE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function createTurnArtifactBatch(
  turnId: number,
  ownershipToken: string,
  directoryPath: string,
): TurnArtifactBatchRow {
  const existing = getTurnArtifactBatch(turnId);
  if (existing
    && (existing.ownership_token !== ownershipToken || existing.directory_path !== directoryPath)
    && (existing.status !== "collecting" || !artifactReservationIsEmpty(existing.directory_path))) {
    throw new Error(`Cannot replace a non-empty artifact reservation for turn ${turnId}.`);
  }
  const inserted = db.query(`
    INSERT INTO turn_artifact_batches (turn_id, ownership_token, directory_path, status)
    SELECT id, ?, ?, 'collecting' FROM turns WHERE id=? AND status='running'
    ON CONFLICT(turn_id) DO UPDATE SET
      ownership_token=excluded.ownership_token,
      directory_path=excluded.directory_path,
      status='collecting', error=NULL, updated_at=CURRENT_TIMESTAMP
    WHERE turn_artifact_batches.status='collecting'
      AND NOT EXISTS (
        SELECT 1 FROM turn_artifact_deliveries delivery
        WHERE delivery.turn_id=turn_artifact_batches.turn_id
      )
  `).run(ownershipToken, directoryPath, turnId);
  if (inserted.changes !== 1) {
    throw new Error(`Cannot reserve a new artifact directory for turn ${turnId}.`);
  }
  return getTurnArtifactBatch(turnId)!;
}

function artifactReservationIsEmpty(directoryPath: string): boolean {
  if (!directoryPath) return false;
  try {
    const stat = lstatSync(directoryPath);
    return !stat.isSymbolicLink() && stat.isDirectory() && readdirSync(directoryPath).length === 0;
  } catch (error: any) {
    return error?.code === "ENOENT";
  }
}

export function getTurnArtifactBatch(turnId: number): TurnArtifactBatchRow | null {
  return db.query(`
    SELECT turn_id, ownership_token, directory_path, status, error
    FROM turn_artifact_batches WHERE turn_id=?
  `).get(turnId) as TurnArtifactBatchRow | null;
}

export function registerTurnArtifactIntents(
  turnId: number,
  artifacts: TurnArtifactRegistration[],
): TurnArtifactDeliveryRow[] {
  db.transaction(() => {
    const batch = db.query(`
      SELECT batch.directory_path, session.slack_channel_id,
             COALESCE(turn.slack_reply_thread_ts, turn.slack_user_msg_ts) AS slack_thread_ts
      FROM turn_artifact_batches batch
      JOIN turns turn ON turn.id=batch.turn_id
      JOIN sessions session ON session.id=turn.session_id
      WHERE batch.turn_id=? AND batch.status='collecting' AND turn.status='running'
    `).get(turnId) as any;
    if (!batch) throw new Error(`Turn ${turnId} has no collecting artifact batch.`);
    for (const artifact of artifacts) {
      db.query(`
        INSERT INTO turn_artifact_deliveries (
          artifact_id, turn_id, slack_channel_id, slack_thread_ts, source_path, filename,
          byte_size, source_device, source_inode, content_sha256, source_mtime_ms,
          status, next_attempt_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)
      `).run(
        randomUUID(), turnId, batch.slack_channel_id, batch.slack_thread_ts,
        artifact.path, artifact.filename, artifact.size, artifact.device,
        artifact.inode, artifact.sha256, artifact.mtimeMs,
      );
    }
    db.query(`
      UPDATE turn_artifact_batches
      SET status=?, error=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE turn_id=? AND status='collecting'
    `).run(artifacts.length > 0 ? "pending" : "delivered", turnId);
  })();
  return listTurnArtifactDeliveries(turnId);
}

export function listTurnArtifactDeliveries(turnId: number): TurnArtifactDeliveryRow[] {
  return db.query(`
    SELECT delivery.*, batch.directory_path
    FROM turn_artifact_deliveries delivery
    JOIN turn_artifact_batches batch ON batch.turn_id=delivery.turn_id
    WHERE delivery.turn_id=? ORDER BY delivery.created_at, delivery.artifact_id
  `).all(turnId) as TurnArtifactDeliveryRow[];
}

export function getTurnArtifactDelivery(artifactId: string): TurnArtifactDeliveryRow | null {
  return db.query(`
    SELECT delivery.*, batch.directory_path
    FROM turn_artifact_deliveries delivery
    JOIN turn_artifact_batches batch ON batch.turn_id=delivery.turn_id
    WHERE delivery.artifact_id=?
  `).get(artifactId) as TurnArtifactDeliveryRow | null;
}

export function listPendingTurnArtifactDeliveries(): TurnArtifactDeliveryRow[] {
  return db.query(`
    SELECT delivery.*, batch.directory_path
    FROM turn_artifact_deliveries delivery
    JOIN turn_artifact_batches batch ON batch.turn_id=delivery.turn_id
    JOIN turns turn ON turn.id=delivery.turn_id
    WHERE delivery.status='pending' AND turn.status='done'
    ORDER BY delivery.updated_at, delivery.artifact_id
  `).all() as TurnArtifactDeliveryRow[];
}

export function claimTurnArtifactDelivery(
  artifactId: string,
  ownerInstanceId: string,
  nowMs = Date.now(),
): TurnArtifactDeliveryRow | null {
  const claimed = db.query(`
    UPDATE turn_artifact_deliveries
    SET status='sending', attempts=attempts+1, owner_instance_id=?, updated_at=CURRENT_TIMESTAMP
    WHERE artifact_id=? AND status='pending' AND COALESCE(next_attempt_ms, 0)<=?
      AND EXISTS (SELECT 1 FROM turns WHERE id=turn_id AND status='done')
  `).run(ownerInstanceId, artifactId, nowMs);
  return claimed.changes === 1 ? getTurnArtifactDelivery(artifactId) : null;
}

function updateArtifactBatchTerminalStatus(turnId: number) {
  const counts = db.query(`
    SELECT
      SUM(CASE WHEN status IN ('pending', 'sending') THEN 1 ELSE 0 END) AS unsettled,
      SUM(CASE WHEN status='ambiguous' THEN 1 ELSE 0 END) AS ambiguous,
      SUM(CASE WHEN status='parked' THEN 1 ELSE 0 END) AS parked
    FROM turn_artifact_deliveries WHERE turn_id=?
  `).get(turnId) as any;
  if (Number(counts?.unsettled || 0) > 0) return;
  const status = Number(counts?.ambiguous || 0) > 0
    ? "ambiguous"
    : Number(counts?.parked || 0) > 0 ? "parked" : "delivered";
  db.query(`UPDATE turn_artifact_batches SET status=?, updated_at=CURRENT_TIMESTAMP WHERE turn_id=?`)
    .run(status, turnId);
}

function queueArtifactFailureStatus(
  turnId: number,
  filename: string,
  disposition: "parked" | "parked as ambiguous",
  detail: string,
) {
  const note = `Artifact upload for ${filename} was ${disposition}: ${detail}. The response itself was delivered.`;
  db.query(`
    UPDATE turns
    SET status_desired_text=TRIM(COALESCE(status_desired_text, 'Status: done') || '\n\n' || ?),
        status_desired_revision=status_desired_revision+1,
        status_projection_status='pending', status_projection_attempts=0,
        status_projection_error=NULL, status_projection_next_attempt_ms=0,
        status_projection_parked_at=NULL
    WHERE id=?
  `).run(note, turnId);
}

export function markTurnArtifactDelivered(
  artifactId: string,
  ownerInstanceId: string,
  slackFileId: string | null,
): TurnArtifactDeliveryRow {
  let result: TurnArtifactDeliveryRow | null = null;
  db.transaction(() => {
    const current = getTurnArtifactDelivery(artifactId);
    if (!current || current.status !== "sending" || current.owner_instance_id !== ownerInstanceId) {
      throw new Error("Artifact delivery lost its sending lease.");
    }
    db.query(`
      UPDATE turn_artifact_deliveries
      SET status='delivered', owner_instance_id=NULL, slack_file_id=?, error=NULL,
          next_attempt_ms=NULL, cleanup_after_ms=0, updated_at=CURRENT_TIMESTAMP
      WHERE artifact_id=? AND status='sending' AND owner_instance_id=?
    `).run(slackFileId, artifactId, ownerInstanceId);
    updateArtifactBatchTerminalStatus(current.turn_id);
    result = getTurnArtifactDelivery(artifactId);
  })();
  return result!;
}

export function markTurnArtifactRetry(
  artifactId: string,
  ownerInstanceId: string,
  error: string,
  nextAttemptMs: number,
) {
  const retried = db.query(`
    UPDATE turn_artifact_deliveries
    SET status='pending', owner_instance_id=NULL, error=?, next_attempt_ms=?, updated_at=CURRENT_TIMESTAMP
    WHERE artifact_id=? AND status='sending' AND owner_instance_id=?
  `).run(error, nextAttemptMs, artifactId, ownerInstanceId);
  if (retried.changes !== 1) throw new Error("Artifact retry lost its sending lease.");
}

export function parkTurnArtifactDelivery(
  artifactId: string,
  ownerInstanceId: string,
  error: string,
  nowMs = Date.now(),
): TurnArtifactDeliveryRow {
  let result: TurnArtifactDeliveryRow | null = null;
  db.transaction(() => {
    const current = getTurnArtifactDelivery(artifactId);
    if (!current || current.status !== "sending" || current.owner_instance_id !== ownerInstanceId) {
      throw new Error("Artifact delivery could not be parked without its sending lease.");
    }
    db.query(`
      UPDATE turn_artifact_deliveries
      SET status='parked', owner_instance_id=NULL, error=?, next_attempt_ms=NULL,
          cleanup_after_ms=?, updated_at=CURRENT_TIMESTAMP
      WHERE artifact_id=? AND status='sending' AND owner_instance_id=?
    `).run(error, nowMs + ARTIFACT_FAILURE_RETENTION_MS, artifactId, ownerInstanceId);
    queueArtifactFailureStatus(current.turn_id, current.filename, "parked", error);
    updateArtifactBatchTerminalStatus(current.turn_id);
    result = getTurnArtifactDelivery(artifactId);
  })();
  return result!;
}

export function markTurnArtifactAmbiguous(
  artifactId: string,
  ownerInstanceId: string,
  error: string,
  nowMs = Date.now(),
): TurnArtifactDeliveryRow {
  let result: TurnArtifactDeliveryRow | null = null;
  db.transaction(() => {
    const current = getTurnArtifactDelivery(artifactId);
    if (!current || current.status !== "sending" || current.owner_instance_id !== ownerInstanceId) {
      throw new Error("Artifact delivery could not be marked ambiguous without its sending lease.");
    }
    db.query(`
      UPDATE turn_artifact_deliveries
      SET status='ambiguous', owner_instance_id=NULL, error=?, next_attempt_ms=NULL,
          cleanup_after_ms=?, updated_at=CURRENT_TIMESTAMP
      WHERE artifact_id=? AND status='sending' AND owner_instance_id=?
    `).run(error, nowMs + ARTIFACT_FAILURE_RETENTION_MS, artifactId, ownerInstanceId);
    queueArtifactFailureStatus(current.turn_id, current.filename, "parked as ambiguous", error);
    updateArtifactBatchTerminalStatus(current.turn_id);
    result = getTurnArtifactDelivery(artifactId);
  })();
  return result!;
}

export function recoverTurnArtifactDeliveryClaims(
  isAlive: (identity: { pid: number; bootId: string; startTicks: string }) => boolean,
  nowMs = Date.now(),
): number {
  const claims = db.query(`
    SELECT delivery.artifact_id, delivery.turn_id, delivery.filename, delivery.owner_instance_id,
           process.pid, process.boot_id, process.process_start_ticks
    FROM turn_artifact_deliveries delivery
    LEFT JOIN process_instances process ON process.instance_id=delivery.owner_instance_id
    WHERE delivery.status='sending'
  `).all() as any[];
  let recovered = 0;
  for (const claim of claims) {
    if (isAlive({
      pid: Number(claim.pid || 0),
      bootId: String(claim.boot_id || ""),
      startTicks: String(claim.process_start_ticks || ""),
    })) continue;
    db.transaction(() => {
      const error = "Artifact upload outcome is ambiguous because its owning process stopped during Slack upload.";
      const changed = db.query(`
        UPDATE turn_artifact_deliveries
        SET status='ambiguous', owner_instance_id=NULL, error=?, next_attempt_ms=NULL,
            cleanup_after_ms=?, updated_at=CURRENT_TIMESTAMP
        WHERE artifact_id=? AND status='sending' AND owner_instance_id IS ?
      `).run(error, nowMs + ARTIFACT_FAILURE_RETENTION_MS, claim.artifact_id, claim.owner_instance_id);
      if (changed.changes !== 1) return;
      queueArtifactFailureStatus(claim.turn_id, claim.filename, "parked as ambiguous", error);
      updateArtifactBatchTerminalStatus(claim.turn_id);
      recovered += 1;
    })();
  }
  return recovered;
}

export function abandonTurnArtifactBatch(turnId: number, error: string, nowMs = Date.now()) {
  db.transaction(() => {
    db.query(`
      UPDATE turn_artifact_deliveries
      SET status='parked', owner_instance_id=NULL, error=?, next_attempt_ms=NULL,
          cleanup_after_ms=?, updated_at=CURRENT_TIMESTAMP
      WHERE turn_id=? AND status='pending'
    `).run(error, nowMs, turnId);
    db.query(`
      UPDATE turn_artifact_batches SET status='abandoned', error=?, updated_at=CURRENT_TIMESTAMP
      WHERE turn_id=? AND status IN ('collecting', 'pending')
    `).run(error, turnId);
  })();
}

export function listTurnArtifactStagingCleanupDue(nowMs = Date.now()): TurnArtifactDeliveryRow[] {
  return db.query(`
    SELECT delivery.*, batch.directory_path
    FROM turn_artifact_deliveries delivery
    JOIN turn_artifact_batches batch ON batch.turn_id=delivery.turn_id
    WHERE delivery.staging_removed_at IS NULL
      AND delivery.cleanup_after_ms IS NOT NULL AND delivery.cleanup_after_ms<=?
    ORDER BY delivery.cleanup_after_ms, delivery.artifact_id
  `).all(nowMs) as TurnArtifactDeliveryRow[];
}

export function markTurnArtifactStagingRemoved(artifactId: string) {
  db.query(`
    UPDATE turn_artifact_deliveries
    SET staging_removed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
    WHERE artifact_id=? AND status IN ('delivered', 'parked', 'ambiguous')
  `).run(artifactId);
}

export function isTurnArtifactStagingCleanupComplete(turnId: number) {
  const row = db.query(`
    SELECT batch.status,
           COUNT(delivery.artifact_id) AS artifact_count,
           SUM(CASE WHEN delivery.artifact_id IS NOT NULL
                     AND delivery.staging_removed_at IS NULL THEN 1 ELSE 0 END) AS unremoved_count
    FROM turn_artifact_batches batch
    LEFT JOIN turn_artifact_deliveries delivery ON delivery.turn_id=batch.turn_id
    WHERE batch.turn_id=?
    GROUP BY batch.turn_id
  `).get(turnId) as any;
  return Boolean(row)
    && !["collecting", "pending"].includes(String(row.status))
    && Number(row.unremoved_count || 0) === 0;
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
    queueTurnReactionCleanup(turnId);
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

export interface RegistryChannelRow {
  slack_channel_id: string | null;
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
  canvas_projected_commit: string | null;
  list_id: string | null;
  list_title_column_id: string | null;
  list_completed_column_id: string | null;
  list_access_level: string | null;
  list_creation_intent_id: string | null;
  list_creation_started_at_ms: number | null;
  session_mode: SessionMode;
  default_session_uuid: string | null;
}

export type ChannelRow = RegistryChannelRow & { slack_channel_id: string };
export type SlackChannelRow = ChannelRow;

export function bindChannelDefaultSessionUuid(chanId: string, uuid: string): string | null {
  return db.transaction(() => {
    db.query(`UPDATE channels SET default_session_uuid=?
              WHERE slack_channel_id=? AND default_session_uuid IS NULL`).run(uuid, chanId);
    const channel = db.query("SELECT default_session_uuid FROM channels WHERE slack_channel_id=?")
      .get(chanId) as { default_session_uuid: string | null } | null;
    return channel?.default_session_uuid || null;
  })();
}

export interface SessionRow {
  id: number;
  slack_channel_id: string;
  slack_thread_ts: string;
  provider_id: ProviderId;
  agent_session_uuid: string | null;
  provider_binding_token: string | null;
  parent_session_id: number | null;
  parent_message_idx: number | null;
  status: string;
}

export interface CodexSessionMapping {
  session_id: number;
  provider_thread_uuid: string;
  provider_binding_token: string | null;
  project_path: string;
  slack_channel_id: string;
  slack_channel_name: string;
  slack_thread_ts: string;
}

export function providerBindingTokenForPath(providerSessionUuid: string, cwd: string) {
  const rows = db.query(`
    SELECT DISTINCT s.provider_binding_token AS token
    FROM sessions s
    JOIN channels c ON c.slack_channel_id=s.slack_channel_id
    WHERE s.agent_session_uuid=?
      AND COALESCE(c.code_path, c.vault_path)=?
      AND s.provider_binding_token IS NOT NULL
  `).all(providerSessionUuid, cwd) as Array<{ token: string }>;
  if (rows.length > 1) throw new Error("Provider session has ambiguous broker bindings for this project.");
  return rows[0]?.token || null;
}

export function providerBindingTokenForSession(sessionId: number) {
  const row = db.query("SELECT provider_binding_token FROM sessions WHERE id=?")
    .get(sessionId) as { provider_binding_token: string | null } | null;
  return row?.provider_binding_token || null;
}

export interface CodexRemoteMirrorEventRow {
  observation_sequence: number;
  provider_thread_uuid: string;
  provider_item_id: string;
  provider_turn_id: string;
  authorizing_session_id: number | null;
  item_kind: "user" | "agent";
  payload_text: string;
  slack_channel_id: string;
  slack_thread_ts: string;
  client_msg_id: string;
  status: "pending" | "sending" | "delivered" | "parked";
  slack_message_ts: string | null;
  attempts: number;
  error: string | null;
  next_attempt_ms: number | null;
}

export interface TodoSyncStateRow {
  slack_channel_id: string;
  base_json: string;
  conflict_signature: string | null;
  historical_migration_complete: number;
  ignored_slack_item_ids_json: string;
}

export interface TodoSyncConflictNoticeRow {
  slack_channel_id: string;
  conflict_signature: string;
  notice_text: string;
  client_msg_id: string;
  status: "prepared" | "pending" | "sending" | "delivered" | "parked";
  owner_instance_id: string | null;
  slack_message_ts: string | null;
  attempts: number;
  error: string | null;
  next_attempt_ms: number | null;
}

export interface ForkRequestRow {
  request_id: string;
  slack_channel_id: string;
  requested_by: string;
  source_session_id: number;
  source_message_ts: string | null;
  source_message_excerpt: string | null;
  provider_id: ProviderId;
  source_provider_session_uuid: string;
  last_provider_turn_id: string | null;
  cwd: string;
  additional_dirs_json: string;
  provider_request_key: string;
  slack_client_msg_id: string;
  status: "claimed" | "forking" | "forked" | "delivering" | "binding" | "delivered" | "ambiguous" | "error" | "parked";
  owner_instance_id: string | null;
  forked_provider_session_uuid: string | null;
  forked_provider_binding_token: string | null;
  slack_message_ts: string | null;
  delivery_attempts: number;
  error: string | null;
  owner_pid?: number | null;
  owner_boot_id?: string | null;
  owner_process_start_ticks?: string | null;
}

export interface SlackThreadStatusRow {
  slack_channel_id: string;
  slack_thread_ts: string;
  slack_status_msg_ts: string;
  anchor_turn_id: number | null;
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

export interface TurnReactionCleanupRow {
  turn_id: number;
  slack_channel_id: string;
  slack_user_msg_ts: string;
  cleanup_status: "pending" | "sending" | "delivered" | "parked";
  cleanup_attempts: number;
  cleanup_error: string | null;
  cleanup_next_attempt_ms: number | null;
  cleanup_parked_at: string | null;
}

export interface SlackThreadResponseRow {
  turn_id: number;
  user_text: string;
  response_tldr: string | null;
  agent_text: string | null;
}

export interface TurnStatusProjectionRow {
  turn_id: number;
  slack_channel_id: string;
  slack_thread_ts: string;
  slack_status_msg_ts: string;
  message_generation: number;
  desired_text: string | null;
  desired_revision: number;
  projected_revision: number;
  projection_status: "not_needed" | "pending" | "sending" | "delivered" | "parked";
  projection_attempts: number;
  projection_error: string | null;
  projection_next_attempt_ms: number | null;
}

export type TurnProjectionMode = "legacy" | "agent";

export interface TurnProgressStreamRow {
  turn_id: number;
  slack_channel_id: string;
  slack_thread_ts: string;
  requested_by_user_id: string | null;
  progress_stream_ts: string | null;
  progress_stream_state: "not_started" | "starting" | "streaming" | "stopping" | "stopped" | "parked";
  progress_stream_error: string | null;
  stop_requested_at: string | null;
  turn_status: string;
}

export interface SlackRootSummaryProjectionRow {
  slack_channel_id: string;
  slack_thread_ts: string;
  root_message_ts: string;
  desired_text: string;
  desired_turn_id: number;
  desired_revision: number;
  projected_revision: number;
  projection_status: "pending" | "sending" | "delivered" | "parked";
  projection_attempts: number;
  projection_error: string | null;
  projection_next_attempt_ms: number | null;
  projection_parked_at: string | null;
}

export interface SlackAgentSessionStatusProjectionRow {
  slack_channel_id: string;
  slack_thread_ts: string;
  desired_status: "active" | "processing" | "suspended";
  desired_revision: number;
  projected_revision: number;
  projection_status: "pending" | "sending" | "delivered" | "parked";
  projection_attempts: number;
  projection_error: string | null;
  projection_next_attempt_ms: number | null;
  projection_parked_at: string | null;
}

export interface QueuedTurnClaimRow {
  turn_id: number;
  session_id: number;
  slack_channel_id: string;
  session_thread_ts: string;
  provider_id: ProviderId;
  agent_session_uuid: string | null;
  slack_user_msg_ts: string;
  reply_thread_ts: string;
  turn_user_text: string;
  provider_model: string | null;
  reasoning_effort: string | null;
  claim_kind: SlackUserInputClaimRow["kind"] | null;
  claim_turn_id: number | null;
  user_id: string | null;
  claim_user_text: string | null;
  files_json: string | null;
  turn_kind: "slack_user" | "comparison";
  projection_mode: TurnProjectionMode;
  dispatch_attempt: number;
}

export interface SessionUserPromptRow {
  slack_user_msg_ts: string;
  user_text: string | null;
  source_text: string;
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

export function getChannel(chanId: string): SlackChannelRow | null {
  return db.query("SELECT * FROM channels WHERE slack_channel_id = ?").get(chanId) as SlackChannelRow | null;
}

export function getChannelByCodePath(codePath: string): RegistryChannelRow | null {
  return db.query("SELECT * FROM channels WHERE code_path = ? LIMIT 1").get(codePath) as RegistryChannelRow | null;
}

export function getAllChannels(): RegistryChannelRow[] {
  return db.query("SELECT * FROM channels ORDER BY slack_channel_name").all() as RegistryChannelRow[];
}

export function getSlackChannels(): SlackChannelRow[] {
  return db.query(`SELECT * FROM channels
                   WHERE slack_channel_id IS NOT NULL
                   ORDER BY slack_channel_name`).all() as SlackChannelRow[];
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

export function updateChannelCanvasProjectedCommit(chanId: string, commit: string) {
  db.query("UPDATE channels SET canvas_projected_commit=? WHERE slack_channel_id=?").run(commit, chanId);
}

export function updateChannelListState(
  chanId: string,
  list: {
    listId: string | null;
    titleColumnId?: string | null;
    completedColumnId?: string | null;
    accessLevel?: string | null;
  },
) {
  db.query(`
    UPDATE channels
    SET list_id=?,
        list_title_column_id=?,
        list_completed_column_id=?,
        list_access_level=?,
        list_creation_intent_id=NULL,
        list_creation_started_at_ms=NULL
    WHERE slack_channel_id=?
  `).run(
    list.listId,
    list.titleColumnId ?? null,
    list.completedColumnId ?? null,
    list.accessLevel ?? null,
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
  return db.transaction(() => {
    const cleared = db.query(`
      UPDATE channels
      SET list_id=NULL, list_title_column_id=NULL, list_completed_column_id=NULL,
          list_access_level=NULL,
          list_creation_intent_id=?, list_creation_started_at_ms=?
      WHERE slack_channel_id=? AND list_id=?
    `).run(replacementIntentId, replacementStartedAtMs, chanId, expectedListId).changes === 1;
    if (cleared) db.query("DELETE FROM todo_sync_state WHERE slack_channel_id=?").run(chanId);
    return cleared;
  })();
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

export function listUniqueCodexSessionMappings(): CodexSessionMapping[] {
  return db.query(`
    SELECT s.id AS session_id,
           s.agent_session_uuid AS provider_thread_uuid,
           s.provider_binding_token,
           COALESCE(c.code_path, c.vault_path) AS project_path,
           s.slack_channel_id,
           c.slack_channel_name,
           s.slack_thread_ts
    FROM sessions s
    JOIN channels c ON c.slack_channel_id=s.slack_channel_id
    WHERE s.provider_id='codex'
      AND s.status<>'archived'
      AND c.session_mode='per-thread'
      AND s.agent_session_uuid IS NOT NULL
      AND s.agent_session_uuid IN (
        SELECT agent_session_uuid
        FROM sessions
        WHERE provider_id='codex'
          AND status<>'archived'
          AND agent_session_uuid IS NOT NULL
        GROUP BY agent_session_uuid
        HAVING COUNT(*)=1
      )
    ORDER BY s.id
  `).all() as CodexSessionMapping[];
}

export function getUniqueCodexSessionMapping(providerThreadUuid: string): CodexSessionMapping | null {
  return db.query(`
    SELECT s.id AS session_id,
           s.agent_session_uuid AS provider_thread_uuid,
           s.provider_binding_token,
           COALESCE(c.code_path, c.vault_path) AS project_path,
           s.slack_channel_id,
           c.slack_channel_name,
           s.slack_thread_ts
    FROM sessions s
    JOIN channels c ON c.slack_channel_id=s.slack_channel_id
    WHERE s.provider_id='codex'
      AND s.status<>'archived'
      AND c.session_mode='per-thread'
      AND s.agent_session_uuid=?
      AND (
        SELECT COUNT(*)
        FROM sessions duplicate
        WHERE duplicate.provider_id='codex'
          AND duplicate.status<>'archived'
          AND duplicate.agent_session_uuid=?
      )=1
    LIMIT 1
  `).get(providerThreadUuid, providerThreadUuid) as CodexSessionMapping | null;
}

export function getCodexRemoteTurnMapping(
  providerThreadUuid: string,
  providerTurnId: string,
): CodexSessionMapping | null {
  return db.query(`
    SELECT remote_turn.authorizing_session_id AS session_id,
           remote_turn.provider_thread_uuid,
           authorizing_session.provider_binding_token,
           COALESCE(channel.code_path, channel.vault_path) AS project_path,
           remote_turn.slack_channel_id,
           channel.slack_channel_name,
           remote_turn.slack_thread_ts
    FROM codex_remote_turns remote_turn
    JOIN sessions authorizing_session ON authorizing_session.id=remote_turn.authorizing_session_id
    JOIN channels channel ON channel.slack_channel_id=remote_turn.slack_channel_id
    WHERE remote_turn.provider_thread_uuid=?
      AND remote_turn.provider_turn_id=?
      AND remote_turn.authorizing_session_id IS NOT NULL
    LIMIT 1
  `).get(providerThreadUuid, providerTurnId) as CodexSessionMapping | null;
}

export function isConciergeProviderTurn(providerThreadUuid: string, providerTurnId: string): boolean {
  return Boolean(db.query(`
    SELECT 1
    FROM turns t
    JOIN sessions s ON s.id=t.session_id
    WHERE s.provider_id='codex'
      AND s.agent_session_uuid=?
      AND t.provider_turn_id=?
    LIMIT 1
  `).get(providerThreadUuid, providerTurnId));
}

export function isCodexRemoteTurn(providerThreadUuid: string, providerTurnId: string): boolean {
  return Boolean(db.query(`
    SELECT 1 FROM codex_remote_turns
    WHERE provider_thread_uuid=? AND provider_turn_id=?
  `).get(providerThreadUuid, providerTurnId));
}

export function providerThreadHasCodexRemoteInput(providerThreadUuid: string): boolean {
  return Boolean(db.query(`
    SELECT 1 FROM codex_remote_mirror_events
    WHERE provider_thread_uuid=? AND item_kind='user'
    LIMIT 1
  `).get(providerThreadUuid));
}

export function observeCodexRemoteMirrorEvent(input: {
  providerThreadUuid: string;
  providerItemId: string;
  providerTurnId: string;
  authorizingSessionId?: number;
  itemKind: "user" | "agent";
  payloadText: string;
  slackChannelId: string;
  slackThreadTs: string;
  clientMsgId: string;
  recordRemoteTurn?: boolean;
}): boolean {
  if (!input.authorizingSessionId) {
    throw new Error("A durable authorizing session is required for Codex Remote mirroring.");
  }
  return db.transaction(() => {
    const existing = db.query(`
      SELECT 1 FROM codex_remote_mirror_events
      WHERE provider_thread_uuid=? AND provider_item_id=?
    `).get(input.providerThreadUuid, input.providerItemId);
    if (existing) return false;

    if (input.recordRemoteTurn) {
      db.query(`
        INSERT OR IGNORE INTO codex_remote_turns (
          provider_thread_uuid, provider_turn_id, authorizing_session_id,
          slack_channel_id, slack_thread_ts
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        input.providerThreadUuid,
        input.providerTurnId,
        input.authorizingSessionId,
        input.slackChannelId,
        input.slackThreadTs,
      );
    }

    db.query(`
      INSERT INTO codex_remote_mirror_events (
        provider_thread_uuid, provider_item_id, provider_turn_id, authorizing_session_id,
        item_kind, payload_text, slack_channel_id, slack_thread_ts, client_msg_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.providerThreadUuid,
      input.providerItemId,
      input.providerTurnId,
      input.authorizingSessionId,
      input.itemKind,
      input.payloadText,
      input.slackChannelId,
      input.slackThreadTs,
      input.clientMsgId,
    );
    return true;
  })();
}

export function recoverCodexRemoteMirrorClaims(): number {
  return db.query(`
    UPDATE codex_remote_mirror_events
    SET status='pending', next_attempt_ms=0, updated_at=CURRENT_TIMESTAMP
    WHERE status='sending'
  `).run().changes;
}

export function claimCodexRemoteMirrorEvent(nowMs = Date.now()): CodexRemoteMirrorEventRow | null {
  return db.transaction(() => {
    db.query(`
      UPDATE codex_remote_mirror_events AS event
      SET status='parked',
          error='The Codex session no longer has one unique authorized Slack destination.',
          next_attempt_ms=NULL,
          updated_at=CURRENT_TIMESTAMP
      WHERE event.status='pending'
        AND NOT EXISTS (
          SELECT 1
          FROM sessions authorized
          JOIN channels channel ON channel.slack_channel_id=authorized.slack_channel_id
          WHERE authorized.id=event.authorizing_session_id
            AND authorized.provider_id='codex'
            AND authorized.status<>'archived'
            AND authorized.agent_session_uuid=event.provider_thread_uuid
            AND authorized.slack_channel_id=event.slack_channel_id
            AND authorized.slack_thread_ts=event.slack_thread_ts
            AND channel.session_mode='per-thread'
            AND (
              SELECT COUNT(*) FROM sessions duplicate
              WHERE duplicate.provider_id='codex'
                AND duplicate.status<>'archived'
                AND duplicate.agent_session_uuid=event.provider_thread_uuid
            )=1
        )
    `).run();
    db.query(`
      UPDATE codex_remote_mirror_events AS later
      SET status='parked',
          error='Blocked by an earlier parked mirror event in the same Slack thread.',
          next_attempt_ms=NULL,
          updated_at=CURRENT_TIMESTAMP
      WHERE later.status='pending'
        AND EXISTS (
          SELECT 1 FROM codex_remote_mirror_events AS earlier
          WHERE earlier.slack_channel_id=later.slack_channel_id
            AND earlier.slack_thread_ts=later.slack_thread_ts
            AND earlier.observation_sequence < later.observation_sequence
            AND earlier.status='parked'
        )
    `).run();
    const candidate = db.query(`
      SELECT candidate.* FROM codex_remote_mirror_events AS candidate
      WHERE candidate.status='pending' AND COALESCE(candidate.next_attempt_ms, 0) <= ?
        AND NOT EXISTS (
          SELECT 1 FROM codex_remote_mirror_events AS earlier
          WHERE earlier.slack_channel_id=candidate.slack_channel_id
            AND earlier.slack_thread_ts=candidate.slack_thread_ts
            AND earlier.observation_sequence < candidate.observation_sequence
            AND earlier.status IN ('pending', 'sending', 'parked')
        )
      ORDER BY candidate.observation_sequence
      LIMIT 1
    `).get(nowMs) as CodexRemoteMirrorEventRow | null;
    if (!candidate) return null;
    const claimed = db.query(`
      UPDATE codex_remote_mirror_events
      SET status='sending', attempts=attempts+1, error=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE provider_thread_uuid=? AND provider_item_id=? AND status='pending'
    `).run(candidate.provider_thread_uuid, candidate.provider_item_id).changes === 1;
    if (!claimed) return null;
    return db.query(`
      SELECT * FROM codex_remote_mirror_events
      WHERE provider_thread_uuid=? AND provider_item_id=?
    `).get(candidate.provider_thread_uuid, candidate.provider_item_id) as CodexRemoteMirrorEventRow;
  })();
}

export function nextCodexRemoteMirrorAttemptMs(): number | null {
  const row = db.query(`
    SELECT MIN(next_attempt_ms) AS next_attempt_ms
    FROM codex_remote_mirror_events
    WHERE status='pending' AND next_attempt_ms IS NOT NULL
  `).get() as { next_attempt_ms: number | null };
  return row.next_attempt_ms === null ? null : Number(row.next_attempt_ms);
}

export function codexRemoteMirrorEventMappingValid(
  event: Pick<CodexRemoteMirrorEventRow,
    "authorizing_session_id" | "provider_thread_uuid" | "slack_channel_id" | "slack_thread_ts">,
): boolean {
  if (event.authorizing_session_id === null) return false;
  return Boolean(db.query(`
    SELECT 1
    FROM sessions authorized
    JOIN channels channel ON channel.slack_channel_id=authorized.slack_channel_id
    WHERE authorized.id=?
      AND authorized.provider_id='codex'
      AND authorized.status<>'archived'
      AND authorized.agent_session_uuid=?
      AND authorized.slack_channel_id=?
      AND authorized.slack_thread_ts=?
      AND channel.session_mode='per-thread'
      AND (
        SELECT COUNT(*) FROM sessions duplicate
        WHERE duplicate.provider_id='codex'
          AND duplicate.status<>'archived'
          AND duplicate.agent_session_uuid=?
      )=1
  `).get(
    event.authorizing_session_id,
    event.provider_thread_uuid,
    event.slack_channel_id,
    event.slack_thread_ts,
    event.provider_thread_uuid,
  ));
}

export function markCodexRemoteMirrorDelivered(
  providerThreadUuid: string,
  providerItemId: string,
  slackMessageTs: string,
): boolean {
  return db.transaction(() => {
    const event = db.query(`
      SELECT status, slack_message_ts
      FROM codex_remote_mirror_events
      WHERE provider_thread_uuid=? AND provider_item_id=?
    `).get(providerThreadUuid, providerItemId) as {
      status: CodexRemoteMirrorEventRow["status"];
      slack_message_ts: string | null;
    } | null;
    if (!event) return false;
    if (event.status === "delivered") return event.slack_message_ts === slackMessageTs;
    if (event.status !== "sending") return false;
    const transitioned = db.query(`
      UPDATE codex_remote_mirror_events
      SET status='delivered', slack_message_ts=?, error=NULL, next_attempt_ms=NULL,
          updated_at=CURRENT_TIMESTAMP
      WHERE provider_thread_uuid=? AND provider_item_id=? AND status='sending'
    `).run(slackMessageTs, providerThreadUuid, providerItemId).changes === 1;
    if (!transitioned) return false;
    return true;
  })();
}

export function retryCodexRemoteMirrorEvent(
  providerThreadUuid: string,
  providerItemId: string,
  error: string,
  nextAttemptMs: number,
): boolean {
  return db.query(`
    UPDATE codex_remote_mirror_events
    SET status='pending', error=?, next_attempt_ms=?, updated_at=CURRENT_TIMESTAMP
    WHERE provider_thread_uuid=? AND provider_item_id=? AND status='sending'
  `).run(error, nextAttemptMs, providerThreadUuid, providerItemId).changes === 1;
}

export function parkCodexRemoteMirrorEvent(
  providerThreadUuid: string,
  providerItemId: string,
  error: string,
): boolean {
  return db.transaction(() => {
    const event = db.query(`
      SELECT observation_sequence, slack_channel_id, slack_thread_ts
      FROM codex_remote_mirror_events
      WHERE provider_thread_uuid=? AND provider_item_id=? AND status='sending'
    `).get(providerThreadUuid, providerItemId) as {
      observation_sequence: number;
      slack_channel_id: string;
      slack_thread_ts: string;
    } | null;
    if (!event) return false;
    db.query(`
      UPDATE codex_remote_mirror_events
      SET status='parked', error=?, next_attempt_ms=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE provider_thread_uuid=? AND provider_item_id=? AND status='sending'
    `).run(error, providerThreadUuid, providerItemId);
    db.query(`
      UPDATE codex_remote_mirror_events
      SET status='parked',
          error='Blocked by an earlier parked mirror event in the same Slack thread.',
          next_attempt_ms=NULL,
          updated_at=CURRENT_TIMESTAMP
      WHERE slack_channel_id=? AND slack_thread_ts=?
        AND observation_sequence > ? AND status='pending'
    `).run(event.slack_channel_id, event.slack_thread_ts, event.observation_sequence);
    return true;
  })();
}

export function getTodoSyncState(slackChannelId: string): TodoSyncStateRow | null {
  return db.query("SELECT * FROM todo_sync_state WHERE slack_channel_id=?")
    .get(slackChannelId) as TodoSyncStateRow | null;
}

export function commitTodoSyncState(input: {
  slackChannelId: string;
  baseJson: string;
  conflictSignature: string | null;
  historicalMigrationComplete?: boolean;
  ignoredSlackItemIds?: string[];
  conflictNotice?: {
    slackChannelId: string;
    conflictSignature: string;
    noticeText: string;
    clientMsgId: string;
  };
}) {
  db.transaction(() => {
    db.query(`
      INSERT INTO todo_sync_state (
        slack_channel_id, base_json, conflict_signature,
        historical_migration_complete, ignored_slack_item_ids_json
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(slack_channel_id) DO UPDATE SET
        base_json=excluded.base_json,
        conflict_signature=excluded.conflict_signature,
        historical_migration_complete=excluded.historical_migration_complete,
        ignored_slack_item_ids_json=excluded.ignored_slack_item_ids_json,
        updated_at=CURRENT_TIMESTAMP
    `).run(
      input.slackChannelId,
      input.baseJson,
      input.conflictSignature,
      input.historicalMigrationComplete === false ? 0 : 1,
      JSON.stringify(input.ignoredSlackItemIds || []),
    );
    db.query(`
      UPDATE todo_sync_conflict_notices
      SET status='pending', updated_at=CURRENT_TIMESTAMP
      WHERE slack_channel_id=? AND status='prepared'
    `).run(input.slackChannelId);
  })();
}

export function prepareTodoSyncConflictNotice(input: {
  slackChannelId: string;
  conflictSignature: string;
  noticeText: string;
  clientMsgId: string;
}): boolean {
  return db.query(`
    INSERT OR IGNORE INTO todo_sync_conflict_notices (
      slack_channel_id, conflict_signature, notice_text, client_msg_id, status
    ) VALUES (?, ?, ?, ?, 'prepared')
  `).run(
    input.slackChannelId,
    input.conflictSignature,
    input.noticeText,
    input.clientMsgId,
  ).changes === 1;
}

export function recoverTodoSyncConflictNoticeClaims(
  isOwnerAlive?: (identity: { pid: number; bootId: string; startTicks: string }) => boolean,
): number {
  return db.transaction(() => {
    let recovered = db.query(`
      UPDATE todo_sync_conflict_notices
      SET status='pending', owner_instance_id=NULL, next_attempt_ms=0, updated_at=CURRENT_TIMESTAMP
      WHERE status='prepared'
    `).run().changes;
    if (!isOwnerAlive) return recovered;
    const claims = db.query(`
      SELECT notice.slack_channel_id, notice.conflict_signature, notice.owner_instance_id,
             process.pid, process.boot_id, process.process_start_ticks
      FROM todo_sync_conflict_notices notice
      LEFT JOIN process_instances process ON process.instance_id=notice.owner_instance_id
      WHERE notice.status='sending'
    `).all() as Array<{
      slack_channel_id: string;
      conflict_signature: string;
      owner_instance_id: string | null;
      pid: number | null;
      boot_id: string | null;
      process_start_ticks: string | null;
    }>;
    for (const claim of claims) {
      const alive = claim.pid && claim.boot_id && claim.process_start_ticks
        ? isOwnerAlive({ pid: claim.pid, bootId: claim.boot_id, startTicks: claim.process_start_ticks })
        : false;
      if (alive) continue;
      recovered += db.query(`
        UPDATE todo_sync_conflict_notices
        SET status='pending', owner_instance_id=NULL, next_attempt_ms=0, updated_at=CURRENT_TIMESTAMP
        WHERE slack_channel_id=? AND conflict_signature=? AND status='sending' AND owner_instance_id IS ?
      `).run(claim.slack_channel_id, claim.conflict_signature, claim.owner_instance_id).changes;
    }
    return recovered;
  })();
}

export function claimTodoSyncConflictNotice(
  slackChannelId: string,
  ownerInstanceId: string,
  nowMs = Date.now(),
): TodoSyncConflictNoticeRow | null {
  return db.transaction(() => {
    const candidate = db.query(`
      SELECT * FROM todo_sync_conflict_notices
      WHERE slack_channel_id=? AND status='pending' AND COALESCE(next_attempt_ms, 0) <= ?
      ORDER BY created_at, conflict_signature
      LIMIT 1
    `).get(slackChannelId, nowMs) as TodoSyncConflictNoticeRow | null;
    if (!candidate) return null;
    const claimed = db.query(`
      UPDATE todo_sync_conflict_notices
      SET status='sending', owner_instance_id=?, attempts=attempts+1, error=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE slack_channel_id=? AND conflict_signature=? AND status='pending'
    `).run(ownerInstanceId, slackChannelId, candidate.conflict_signature).changes === 1;
    if (!claimed) return null;
    return db.query(`
      SELECT * FROM todo_sync_conflict_notices
      WHERE slack_channel_id=? AND conflict_signature=?
    `).get(slackChannelId, candidate.conflict_signature) as TodoSyncConflictNoticeRow;
  })();
}

export function markTodoSyncConflictNoticeDelivered(
  slackChannelId: string,
  conflictSignature: string,
  slackMessageTs: string,
  ownerInstanceId?: string,
): boolean {
  return db.query(`
    UPDATE todo_sync_conflict_notices
    SET status='delivered', slack_message_ts=?, error=NULL, next_attempt_ms=NULL,
        updated_at=CURRENT_TIMESTAMP
    WHERE slack_channel_id=? AND conflict_signature=? AND owner_instance_id IS ?
      AND (status='sending' OR (status='delivered' AND slack_message_ts=?))
  `).run(slackMessageTs, slackChannelId, conflictSignature, ownerInstanceId || null, slackMessageTs).changes === 1;
}

export function retryTodoSyncConflictNotice(
  slackChannelId: string,
  conflictSignature: string,
  error: string,
  nextAttemptMs: number,
  ownerInstanceId?: string,
): boolean {
  return db.query(`
    UPDATE todo_sync_conflict_notices
    SET status='pending', owner_instance_id=NULL, error=?, next_attempt_ms=?, updated_at=CURRENT_TIMESTAMP
    WHERE slack_channel_id=? AND conflict_signature=? AND status='sending' AND owner_instance_id IS ?
  `).run(error, nextAttemptMs, slackChannelId, conflictSignature, ownerInstanceId || null).changes === 1;
}

export function parkTodoSyncConflictNotice(
  slackChannelId: string,
  conflictSignature: string,
  error: string,
  ownerInstanceId?: string,
): boolean {
  return db.query(`
    UPDATE todo_sync_conflict_notices
    SET status='parked', owner_instance_id=NULL, error=?, next_attempt_ms=NULL, updated_at=CURRENT_TIMESTAMP
    WHERE slack_channel_id=? AND conflict_signature=? AND status='sending' AND owner_instance_id IS ?
  `).run(error, slackChannelId, conflictSignature, ownerInstanceId || null).changes === 1;
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
    SELECT slack_user_msg_ts, user_text, source_text, replay_ready, status, unreplayable_attachment_count,
           turn_order, source_kind, source_id
    FROM (
      SELECT t.session_id,
             t.slack_user_msg_ts,
             t.replay_text AS user_text,
             t.user_text AS source_text,
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
             steering.user_text AS source_text,
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
        SELECT boundary.id
        FROM (
          SELECT t.id
          FROM turns t
          LEFT JOIN turn_delivery_chunks chunk ON chunk.turn_id=t.id
          WHERE t.session_id=? AND (t.slack_bot_msg_ts=? OR chunk.slack_ts=?)
          UNION ALL
          SELECT status.summary_through_turn_id AS id
          FROM slack_thread_statuses status
          JOIN turns summary_turn ON summary_turn.id=status.summary_through_turn_id
          WHERE summary_turn.session_id=? AND status.slack_status_msg_ts=?
        ) boundary
        ORDER BY boundary.id DESC
        LIMIT 1
      `).get(sessionId, through, through, sessionId, through) as { id: number } | null;
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

export function getRunningTurnDispatchAttempt(turnId: number, ownerInstanceId: string): number | null {
  const row = db.query(`
    SELECT dispatch_attempt FROM turns
    WHERE id=? AND status='running' AND owner_instance_id=?
  `).get(turnId, ownerInstanceId) as { dispatch_attempt: number } | null;
  return row?.dispatch_attempt ?? null;
}

export function markTurnProviderAdmissionIntended(
  turnId: number,
  ownerInstanceId: string,
  dispatchAttempt: number,
): boolean {
  return db.query(`
    UPDATE turns
    SET provider_admission_intended_at=COALESCE(provider_admission_intended_at, CURRENT_TIMESTAMP)
    WHERE id=? AND status='running' AND owner_instance_id=? AND dispatch_attempt=?
  `).run(turnId, ownerInstanceId, dispatchAttempt).changes === 1;
}

export interface RunningTurnDispatchBoundary {
  admissionIntended: boolean;
  unsafeSteering: boolean;
  durableArtifactActivity: boolean;
}

export function getRunningTurnDispatchBoundary(
  turnId: number,
  ownerInstanceId: string,
  dispatchAttempt: number,
): RunningTurnDispatchBoundary | null {
  const row = db.query(`
    SELECT provider_admission_intended_at IS NOT NULL AS admission_intended,
           EXISTS(
             SELECT 1 FROM turn_steering_messages
             WHERE turn_id=turns.id AND status IN ('sent', 'sending', 'ambiguous')
           ) AS unsafe_steering,
           (
             EXISTS(SELECT 1 FROM turn_artifact_deliveries WHERE turn_id=turns.id)
             OR EXISTS(
               SELECT 1 FROM turn_artifact_batches
               WHERE turn_id=turns.id AND status<>'collecting'
             )
           ) AS durable_artifact_activity
    FROM turns
    WHERE id=? AND status='running' AND owner_instance_id=? AND dispatch_attempt=?
  `).get(turnId, ownerInstanceId, dispatchAttempt) as {
    admission_intended: number;
    unsafe_steering: number;
    durable_artifact_activity: number;
  } | null;
  return row ? {
    admissionIntended: Boolean(row.admission_intended),
    unsafeSteering: Boolean(row.unsafe_steering),
    durableArtifactActivity: Boolean(row.durable_artifact_activity),
  } : null;
}

export function recordTurnProviderTurnId(turnId: number, providerTurnId: string | null | undefined) {
  if (!providerTurnId) return;
  db.query("UPDATE turns SET provider_turn_id=? WHERE id=?").run(providerTurnId, turnId);
}

export function retryRunningTurnAfterProviderFailure(input: {
  turnId: number;
  ownerInstanceId: string;
  dispatchAttempt: number;
  error: string;
  nextAttemptMs: number;
}): boolean {
  return db.transaction(() => {
    const boundary = getRunningTurnDispatchBoundary(
      input.turnId,
      input.ownerInstanceId,
      input.dispatchAttempt,
    );
    if (!boundary || boundary.unsafeSteering || boundary.durableArtifactActivity) return false;
    const turn = db.query(`
      SELECT session_id FROM turns
      WHERE id=? AND status='running' AND owner_instance_id=? AND dispatch_attempt=?
        AND NOT EXISTS (SELECT 1 FROM turn_artifact_deliveries WHERE turn_id=turns.id)
        AND NOT EXISTS (
          SELECT 1 FROM turn_artifact_batches
          WHERE turn_id=turns.id AND status<>'collecting'
        )
    `).get(input.turnId, input.ownerInstanceId, input.dispatchAttempt) as { session_id: number } | null;
    if (!turn) return false;
    const changed = db.query(`
      UPDATE turns
      SET status='queued', owner_instance_id=NULL, agent_text=?, ended_at=NULL,
          dispatch_failure_class='retryable', dispatch_next_attempt_ms=?,
          status_desired_text=?, status_desired_revision=status_desired_revision+1,
          status_projection_status='pending', status_projection_attempts=0,
          status_projection_error=NULL, status_projection_next_attempt_ms=0,
          status_projection_parked_at=NULL
      WHERE id=? AND status='running' AND owner_instance_id=? AND dispatch_attempt=?
    `).run(
      input.error,
      input.nextAttemptMs,
      RETRYING_PROVIDER_TURN_STATUS_TEXT,
      input.turnId,
      input.ownerInstanceId,
      input.dispatchAttempt,
    );
    if (changed.changes !== 1) return false;
    db.query(`UPDATE sessions
              SET status=CASE WHEN status='archived' THEN status ELSE 'idle' END
              WHERE id=?`).run(turn.session_id);
    return true;
  })();
}

export function requeueOrphanedPreAdmissionTurn(
  turnId: number,
  ownerInstanceId: string | null,
): boolean {
  return db.transaction(() => {
    const turn = db.query(`
      SELECT session_id FROM turns
      WHERE id=? AND status='running' AND owner_instance_id IS ?
        AND turn_kind IN ('slack_user', 'comparison')
        AND provider_admission_intended_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM turn_artifact_deliveries WHERE turn_id=turns.id)
        AND NOT EXISTS (
          SELECT 1 FROM turn_artifact_batches
          WHERE turn_id=turns.id AND status<>'collecting'
        )
    `).get(turnId, ownerInstanceId) as { session_id: number } | null;
    if (!turn) return false;
    const changed = db.query(`
      UPDATE turns
      SET status='queued', owner_instance_id=NULL, ended_at=NULL,
          dispatch_failure_class='retryable', dispatch_next_attempt_ms=0,
          status_desired_text=?, status_desired_revision=status_desired_revision+1,
          status_projection_status='pending', status_projection_attempts=0,
          status_projection_error=NULL, status_projection_next_attempt_ms=0,
          status_projection_parked_at=NULL
      WHERE id=? AND status='running' AND owner_instance_id IS ?
        AND provider_admission_intended_at IS NULL
    `).run(RETRYING_PROVIDER_TURN_STATUS_TEXT, turnId, ownerInstanceId);
    if (changed.changes !== 1) return false;
    db.query(`UPDATE sessions
              SET status=CASE WHEN status='archived' THEN status ELSE 'idle' END
              WHERE id=?`).run(turn.session_id);
    return true;
  })();
}

export function parkRunningTurnAfterProviderFailure(input: {
  turnId: number;
  ownerInstanceId: string;
  dispatchAttempt: number;
  failureClass: "parked_access" | "parked_terminal" | "parked_ambiguous";
  error: string;
  statusText?: string;
}): boolean {
  return db.transaction(() => {
    const boundary = getRunningTurnDispatchBoundary(
      input.turnId,
      input.ownerInstanceId,
      input.dispatchAttempt,
    );
    if (!boundary
      || boundary.durableArtifactActivity
      || (input.failureClass !== "parked_ambiguous" && boundary.unsafeSteering)) return false;
    const turn = db.query(`
      SELECT session_id FROM turns
      WHERE id=? AND status='running' AND owner_instance_id=? AND dispatch_attempt=?
        AND NOT EXISTS (SELECT 1 FROM turn_artifact_deliveries WHERE turn_id=turns.id)
        AND NOT EXISTS (
          SELECT 1 FROM turn_artifact_batches
          WHERE turn_id=turns.id AND status<>'collecting'
        )
    `).get(input.turnId, input.ownerInstanceId, input.dispatchAttempt) as { session_id: number } | null;
    if (!turn) return false;
    const changed = db.query(`
      UPDATE turns
      SET status='parked', owner_instance_id=NULL, agent_text=?, ended_at=CURRENT_TIMESTAMP,
          dispatch_failure_class=?, dispatch_next_attempt_ms=NULL,
          status_desired_text=?, status_desired_revision=status_desired_revision+1,
          status_projection_status='pending', status_projection_attempts=0,
          status_projection_error=NULL, status_projection_next_attempt_ms=0,
          status_projection_parked_at=NULL
      WHERE id=? AND status='running' AND owner_instance_id=? AND dispatch_attempt=?
    `).run(
      input.error,
      input.failureClass,
      input.statusText || parkedProviderTurnStatusText(input.turnId),
      input.turnId,
      input.ownerInstanceId,
      input.dispatchAttempt,
    );
    if (changed.changes !== 1) return false;
    queueTurnReactionCleanup(input.turnId);
    db.query(`UPDATE sessions
              SET status=CASE WHEN status='archived' THEN status ELSE 'idle' END
              WHERE id=?`).run(turn.session_id);
    return true;
  })();
}

export type ResumeParkedTurnResult = "resumed" | "already_queued" | "not_parked" | "unsafe";

export function resumeParkedSessionTurn(turnId: number): ResumeParkedTurnResult {
  return db.transaction(() => {
    const turn = db.query(`
      SELECT turn.status, turn.turn_kind, turn.dispatch_failure_class,
             session.status AS session_status,
             EXISTS(SELECT 1 FROM turn_artifact_deliveries WHERE turn_id=turn.id) AS has_artifacts,
             batch.status AS artifact_batch_status,
             batch.directory_path AS artifact_directory_path,
             EXISTS(
               SELECT 1 FROM turn_steering_messages
               WHERE turn_id=turn.id AND status IN ('sent', 'sending', 'ambiguous')
             ) AS unsafe_steering
      FROM turns turn JOIN sessions session ON session.id=turn.session_id
      LEFT JOIN turn_artifact_batches batch ON batch.turn_id=turn.id
      WHERE turn.id=?
    `).get(turnId) as any;
    if (!turn) return "not_parked";
    if (turn.status === "queued") return "already_queued";
    if (turn.status !== "parked") return "not_parked";
    if (!["slack_user", "comparison"].includes(turn.turn_kind)
      || turn.session_status === "archived"
      || Number(turn.has_artifacts) !== 0
      || Number(turn.unsafe_steering) !== 0
      || turn.dispatch_failure_class === "parked_ambiguous"
      || (turn.artifact_batch_status && turn.artifact_batch_status !== "collecting")
      || (turn.artifact_directory_path
        && !artifactReservationIsEmpty(turn.artifact_directory_path))) return "unsafe";
    const changed = db.query(`
      UPDATE turns
      SET status='queued', ended_at=NULL, dispatch_next_attempt_ms=0,
          provider_admission_intended_at=NULL, provider_started_at=NULL, provider_turn_id=NULL,
          status_desired_text=?, status_desired_revision=status_desired_revision+1,
          status_projection_status='pending', status_projection_attempts=0,
          status_projection_error=NULL, status_projection_next_attempt_ms=0,
          status_projection_parked_at=NULL
      WHERE id=? AND status='parked'
    `).run(QUEUED_TURN_STATUS_TEXT, turnId);
    if (changed.changes !== 1) return "not_parked";
    db.query("DELETE FROM turn_reaction_cleanups WHERE turn_id=?").run(turnId);
    return "resumed";
  })();
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
        OR EXISTS (
          SELECT 1
          FROM slack_thread_statuses status
          WHERE status.slack_channel_id=s.slack_channel_id
            AND status.slack_status_msg_ts=?
            AND status.summary_through_turn_id=t.id
        )
        OR (steering.slack_user_msg_ts = ? AND (? = 1 OR steering.status = 'sent'))
      )
    ORDER BY t.id DESC
    LIMIT 1
  `).get(
    chanId,
    messageTs,
    messageTs,
    messageTs,
    messageTs,
    messageTs,
    includeUnacceptedSteering ? 1 : 0,
  ) as SessionRow | null;
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
  requireComparisonTurnAttachment(requestId, turnId);
}

function requireComparisonTurnAttachment(requestId: string, turnId: number) {
  const attached = db.query(`UPDATE comparison_requests
    SET turn_id=?, status='running', error=NULL, updated_at=CURRENT_TIMESTAMP
    WHERE request_id=? AND status IN ('claimed', 'running')
      AND (turn_id IS NULL OR turn_id=?)
  `).run(turnId, requestId, turnId);
  if (attached.changes !== 1) {
    throw new Error(`Comparison request ${requestId} could not be durably attached to turn ${turnId}.`);
  }
}

export function finishComparisonRequest(requestId: string, status: "done" | "error", error: string | null = null) {
  db.query(`UPDATE comparison_requests
            SET status=?, error=?, updated_at=CURRENT_TIMESTAMP
            WHERE request_id=?`).run(status, error, requestId);
}

export function finishComparisonFromTurnOutcome(
  requestId: string,
  outcome: { status: string; error?: string },
): { status: "done" | "pending" } | { status: "error"; error: string } {
  if (outcome.status === "delivered") {
    finishComparisonRequest(requestId, "done");
    return { status: "done" };
  }
  if (["queued", "retry_queued", "provider_parked"].includes(outcome.status)) {
    return { status: "pending" };
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

export function getProviderTurnBoundaryForSlackMessage(
  chanId: string,
  messageTs: string,
): {
  turnId: number;
  providerTurnId: string | null;
  replayText: string | null;
  sourceKind: "user" | "outcome";
} | null {
  const row = db.query(`
    SELECT t.id, t.provider_turn_id, t.replay_text,
           CASE WHEN t.slack_user_msg_ts=? THEN 'user' ELSE 'outcome' END AS source_kind
    FROM turns t
    JOIN sessions s ON s.id=t.session_id
    LEFT JOIN turn_delivery_chunks chunk ON chunk.turn_id=t.id
    WHERE s.slack_channel_id=?
      AND (
        t.slack_user_msg_ts=?
        OR t.slack_bot_msg_ts=?
        OR chunk.slack_ts=?
        OR EXISTS (
          SELECT 1
          FROM slack_thread_statuses status
          WHERE status.slack_channel_id=s.slack_channel_id
            AND status.slack_status_msg_ts=?
            AND status.summary_through_turn_id=t.id
        )
      )
    ORDER BY t.id DESC
    LIMIT 1
  `).get(messageTs, chanId, messageTs, messageTs, messageTs, messageTs) as {
    id: number;
    provider_turn_id: string | null;
    replay_text: string | null;
    source_kind: "user" | "outcome";
  } | null;
  return row ? {
    turnId: row.id,
    providerTurnId: row.provider_turn_id,
    replayText: row.replay_text,
    sourceKind: row.source_kind,
  } : null;
}

export function getForkSourceMessagePreview(chanId: string, messageTs: string): string | null {
  const boundary = getProviderTurnBoundaryForSlackMessage(chanId, messageTs);
  if (!boundary) return null;
  const row = db.query(`
    SELECT CASE
      WHEN ?='user' THEN turn.user_text
      ELSE COALESCE(
        (
          SELECT status.thread_tldr
          FROM slack_thread_statuses status
          WHERE status.slack_channel_id=?
            AND status.slack_status_msg_ts=?
            AND status.summary_through_turn_id=turn.id
          LIMIT 1
        ),
        turn.response_tldr,
        turn.agent_text,
        turn.outbound_text
      )
    END AS preview
    FROM turns turn
    WHERE turn.id=?
  `).get(boundary.sourceKind, chanId, messageTs, boundary.turnId) as { preview: string | null } | null;
  return row?.preview || null;
}

export function turnHasAcceptedSteering(turnId: number): boolean {
  return Boolean(db.query(`
    SELECT 1
    FROM turn_steering_messages
    WHERE turn_id=? AND status='sent'
    LIMIT 1
  `).get(turnId));
}

export function claimForkRequest(input: {
  requestId: string;
  channelId: string;
  requestedBy: string;
  sourceSessionId: number;
  sourceMessageTs?: string | null;
  sourceMessageExcerpt?: string | null;
  providerId: ProviderId;
  sourceProviderSessionUUID: string;
  lastProviderTurnId?: string | null;
  cwd: string;
  additionalDirs: string[];
}): { claimed: boolean; row: ForkRequestRow } {
  return db.transaction(() => {
    const result = db.query(`
      INSERT INTO fork_requests (
        request_id, slack_channel_id, requested_by, source_session_id,
        source_message_ts, source_message_excerpt, provider_id, source_provider_session_uuid,
        last_provider_turn_id, cwd, additional_dirs_json,
        provider_request_key, slack_client_msg_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_id) DO NOTHING
    `).run(
      input.requestId,
      input.channelId,
      input.requestedBy,
      input.sourceSessionId,
      input.sourceMessageTs || null,
      input.sourceMessageExcerpt || null,
      input.providerId,
      input.sourceProviderSessionUUID,
      input.lastProviderTurnId || null,
      input.cwd,
      JSON.stringify(input.additionalDirs),
      `slack-concierge-fork:${randomUUID()}`,
      randomUUID(),
    );
    const row = getForkRequest(input.requestId);
    if (!row) throw new Error(`Fork request ${input.requestId} was not persisted.`);
    return { claimed: result.changes === 1, row };
  })();
}

export function getForkRequest(requestId: string): ForkRequestRow | null {
  return db.query("SELECT * FROM fork_requests WHERE request_id=?")
    .get(requestId) as ForkRequestRow | null;
}

export function listRecoverableForkRequests(): ForkRequestRow[] {
  return db.query(`
    SELECT request.*, process.pid AS owner_pid, process.boot_id AS owner_boot_id,
           process.process_start_ticks AS owner_process_start_ticks
    FROM fork_requests request
    LEFT JOIN process_instances process ON process.instance_id=request.owner_instance_id
    WHERE request.status IN ('claimed', 'forking', 'forked', 'delivering', 'binding', 'ambiguous')
    ORDER BY request.created_at, request.request_id
  `).all() as ForkRequestRow[];
}

export function beginForkRequest(requestId: string, ownerInstanceId: string): ForkRequestRow | null {
  return db.transaction(() => {
    const result = db.query(`
      UPDATE fork_requests
      SET status='forking', owner_instance_id=?, error=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE request_id=? AND status='claimed'
    `).run(ownerInstanceId, requestId);
    if (result.changes === 0) return null;
    return getForkRequest(requestId);
  })();
}

export function markForkRequestCreated(
  requestId: string,
  ownerInstanceId: string,
  forkedProviderSessionUUID: string,
  forkedProviderBindingToken?: string | null,
) {
  const result = db.query(`
    UPDATE fork_requests
    SET status='forked', forked_provider_session_uuid=?, forked_provider_binding_token=?, error=NULL,
        owner_instance_id=NULL, updated_at=CURRENT_TIMESTAMP
    WHERE request_id=? AND status='forking' AND owner_instance_id=?
  `).run(forkedProviderSessionUUID, forkedProviderBindingToken || null, requestId, ownerInstanceId);
  if (result.changes !== 1) throw new Error(`Fork request ${requestId} lost its provider lease.`);
}

export function markForkRequestRejected(requestId: string, ownerInstanceId: string, error: string) {
  const result = db.query(`
    UPDATE fork_requests
    SET status='error', error=?, owner_instance_id=NULL, updated_at=CURRENT_TIMESTAMP
    WHERE request_id=? AND status='forking' AND owner_instance_id=?
  `).run(error, requestId, ownerInstanceId);
  if (result.changes !== 1) throw new Error(`Fork request ${requestId} could not record provider rejection.`);
}

export function markForkRequestAmbiguous(requestId: string, ownerInstanceId: string, error: string) {
  const result = db.query(`
    UPDATE fork_requests
    SET status='ambiguous', error=?, owner_instance_id=NULL, updated_at=CURRENT_TIMESTAMP
    WHERE request_id=? AND status='forking' AND owner_instance_id=?
  `).run(error, requestId, ownerInstanceId);
  if (result.changes !== 1) throw new Error(`Fork request ${requestId} could not record ambiguity.`);
}

export function recoverForkRequestCreated(requestId: string, forkedProviderSessionUUID: string) {
  const result = db.query(`
    UPDATE fork_requests
    SET status='forked', forked_provider_session_uuid=?, error=NULL,
        owner_instance_id=NULL, updated_at=CURRENT_TIMESTAMP
    WHERE request_id=? AND status IN ('forking', 'ambiguous')
  `).run(forkedProviderSessionUUID, requestId);
  if (result.changes !== 1) throw new Error(`Fork request ${requestId} could not recover its provider result.`);
}

export function resetForkRequestAfterDeadOwner(requestId: string) {
  const result = db.query(`
    UPDATE fork_requests
    SET status='claimed', owner_instance_id=NULL,
        error='Previous provider owner ended before fork completion; retrying.',
        updated_at=CURRENT_TIMESTAMP
    WHERE request_id=? AND status='forking'
  `).run(requestId);
  if (result.changes !== 1) throw new Error(`Fork request ${requestId} could not reset after owner exit.`);
}

export function markForkRequestRecoveryAmbiguous(requestId: string, error: string) {
  const result = db.query(`
    UPDATE fork_requests
    SET status='ambiguous', owner_instance_id=NULL, error=?, updated_at=CURRENT_TIMESTAMP
    WHERE request_id=? AND status='forking'
  `).run(error, requestId);
  if (result.changes !== 1) throw new Error(`Fork request ${requestId} could not record recovery ambiguity.`);
}

export function claimForkRequestDelivery(requestId: string, ownerInstanceId: string): ForkRequestRow | null {
  return db.transaction(() => {
    const result = db.query(`
      UPDATE fork_requests
      SET status='delivering', owner_instance_id=?, delivery_attempts=delivery_attempts+1,
          error=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE request_id=? AND status='forked'
    `).run(ownerInstanceId, requestId);
    if (result.changes === 0) return null;
    return getForkRequest(requestId);
  })();
}

export function markForkRequestDeliveryRetry(requestId: string, ownerInstanceId: string, error: string) {
  const result = db.query(`
    UPDATE fork_requests
    SET status='forked', owner_instance_id=NULL, error=?, updated_at=CURRENT_TIMESTAMP
    WHERE request_id=? AND status='delivering' AND owner_instance_id=?
  `).run(error, requestId, ownerInstanceId);
  if (result.changes !== 1) throw new Error(`Fork request ${requestId} lost its Slack delivery lease.`);
}

export function parkForkRequestDelivery(requestId: string, ownerInstanceId: string, error: string) {
  const result = db.query(`
    UPDATE fork_requests
    SET status='parked', owner_instance_id=NULL, error=?, updated_at=CURRENT_TIMESTAMP
    WHERE request_id=? AND status='delivering' AND owner_instance_id=?
  `).run(error, requestId, ownerInstanceId);
  if (result.changes !== 1) throw new Error(`Fork request ${requestId} could not park Slack delivery.`);
}

export function recoverForkRequestDelivery(requestId: string) {
  const result = db.query(`
    UPDATE fork_requests
    SET status='forked', owner_instance_id=NULL,
        error='Slack delivery owner ended before completion; retrying.',
        updated_at=CURRENT_TIMESTAMP
    WHERE request_id=? AND status='delivering'
  `).run(requestId);
  if (result.changes !== 1) throw new Error(`Fork request ${requestId} could not recover Slack delivery.`);
}

export function markForkRequestAnchorPosted(
  requestId: string,
  ownerInstanceId: string,
  slackMessageTs: string,
): ForkRequestRow {
  const result = db.query(`
    UPDATE fork_requests
    SET status='binding', slack_message_ts=?, owner_instance_id=NULL,
        error=NULL, updated_at=CURRENT_TIMESTAMP
    WHERE request_id=? AND status='delivering' AND owner_instance_id=?
  `).run(slackMessageTs, requestId, ownerInstanceId);
  if (result.changes !== 1) throw new Error(`Fork request ${requestId} could not persist its Slack anchor.`);
  return getForkRequest(requestId)!;
}

export function claimForkRequestBinding(requestId: string, ownerInstanceId: string): ForkRequestRow | null {
  const result = db.query(`
    UPDATE fork_requests
    SET owner_instance_id=?, updated_at=CURRENT_TIMESTAMP
    WHERE request_id=? AND status='binding' AND owner_instance_id IS NULL
  `).run(ownerInstanceId, requestId);
  return result.changes === 1 ? getForkRequest(requestId) : null;
}

export function releaseForkRequestBinding(requestId: string, ownerInstanceId: string, error: string) {
  const result = db.query(`
    UPDATE fork_requests
    SET owner_instance_id=NULL, error=?, updated_at=CURRENT_TIMESTAMP
    WHERE request_id=? AND status='binding' AND owner_instance_id=?
  `).run(error, requestId, ownerInstanceId);
  if (result.changes !== 1) throw new Error(`Fork request ${requestId} lost its binding lease.`);
}

export function parkForkRequestBinding(requestId: string, ownerInstanceId: string, error: string) {
  const result = db.query(`
    UPDATE fork_requests
    SET status='parked', owner_instance_id=NULL, error=?, updated_at=CURRENT_TIMESTAMP
    WHERE request_id=? AND status='binding' AND owner_instance_id=?
  `).run(error, requestId, ownerInstanceId);
  if (result.changes !== 1) throw new Error(`Fork request ${requestId} could not park session binding.`);
}

export function recoverForkRequestBinding(requestId: string) {
  const result = db.query(`
    UPDATE fork_requests
    SET owner_instance_id=NULL,
        error='Fork binding owner ended before the Slack session was created; retrying.',
        updated_at=CURRENT_TIMESTAMP
    WHERE request_id=? AND status='binding'
  `).run(requestId);
  if (result.changes !== 1) throw new Error(`Fork request ${requestId} could not recover session binding.`);
}

export function getForkIngressBarrier(chanId: string, threadTs: string): ForkRequestRow | null {
  return db.query(`
    SELECT * FROM fork_requests
    WHERE slack_channel_id=?
      AND (
        status='delivering'
        OR (status='forked' AND delivery_attempts > 0)
        OR (slack_message_ts=? AND status='binding')
      )
    ORDER BY created_at, request_id
    LIMIT 1
  `).get(chanId, threadTs) as ForkRequestRow | null;
}

export function completeForkRequestDelivery(
  requestId: string,
  ownerInstanceId: string,
): SessionRow {
  return db.transaction(() => {
    const request = getForkRequest(requestId);
    if (
      !request
      || request.status !== "binding"
      || request.owner_instance_id !== ownerInstanceId
      || !request.forked_provider_session_uuid
      || !request.slack_message_ts
    ) {
      throw new Error(`Fork request ${requestId} cannot complete Slack session binding.`);
    }
    db.query(`
      INSERT INTO sessions (
        slack_channel_id, slack_thread_ts, provider_id, agent_session_uuid,
        provider_binding_token, parent_session_id, parent_message_idx, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'idle')
      ON CONFLICT(slack_channel_id, slack_thread_ts, provider_id) DO NOTHING
    `).run(
      request.slack_channel_id,
      request.slack_message_ts,
      request.provider_id,
      request.forked_provider_session_uuid,
      request.forked_provider_binding_token,
      request.source_session_id,
      request.source_message_ts ? Number(request.source_message_ts.replace(".", "")) || null : null,
    );
    const visibleRootSessions = db.query(`
      SELECT * FROM sessions
      WHERE slack_channel_id=? AND slack_thread_ts=?
      ORDER BY id
    `).all(request.slack_channel_id, request.slack_message_ts) as SessionRow[];
    const session = visibleRootSessions.length === 1 ? visibleRootSessions[0] : null;
    if (
      !session
      || session.provider_id !== request.provider_id
      || session.agent_session_uuid !== request.forked_provider_session_uuid
      || session.parent_session_id !== request.source_session_id
    ) {
      throw new Error(
        `Fork anchor ${request.slack_message_ts} is already bound to a different session; refusing to overwrite it.`,
      );
    }
    db.query(`
      UPDATE fork_requests
      SET status='delivered', owner_instance_id=NULL,
          error=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE request_id=? AND status='binding' AND owner_instance_id=?
    `).run(requestId, ownerInstanceId);
    return session;
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

  // A live turn or unsettled guidance has no stable provider boundary. Sent
  // guidance is handled separately when the selected Slack message is mapped:
  // the original request precedes it, while the completed outcome follows it.
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

export function reserveSessionForThread(
  chanId: string,
  threadTs: string,
  requestedProvider: ProviderId,
): { session: SessionRow; created: boolean } {
  return db.transaction(() => {
    const existing = getSessionForThread(chanId, threadTs);
    if (existing) return { session: existing, created: false };
    const session = createOrGetSession(chanId, threadTs, requestedProvider);
    return { session, created: true };
  })();
}

export function upsertSession(
  chanId: string,
  threadTs: string,
  provider: ProviderId,
  uuid: string | null,
  extra: {
    parentSessionId?: number | null;
    parentMessageIdx?: number | null;
    providerBindingToken?: string | null;
    status?: string;
  } = {},
) {
  db.query(`
    INSERT INTO sessions (
      slack_channel_id, slack_thread_ts, provider_id, agent_session_uuid,
      provider_binding_token, parent_session_id, parent_message_idx, last_turn_at, status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(slack_channel_id, slack_thread_ts, provider_id) DO UPDATE SET
      agent_session_uuid = COALESCE(excluded.agent_session_uuid, sessions.agent_session_uuid),
      provider_binding_token = COALESCE(excluded.provider_binding_token, sessions.provider_binding_token),
      parent_session_id = COALESCE(excluded.parent_session_id, sessions.parent_session_id),
      parent_message_idx = COALESCE(excluded.parent_message_idx, sessions.parent_message_idx),
      last_turn_at = CURRENT_TIMESTAMP,
      status=excluded.status
  `).run(
    chanId,
    threadTs,
    provider,
    uuid,
    extra.providerBindingToken ?? null,
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
  | { id: number; duplicate: true; acquired: false; queued: false }
  | { id: number; duplicate: false; acquired: true; queued: false; dispatchAttempt: number }
  | { id: number; duplicate: false; acquired: false; queued: true }
  | { id: number; duplicate: false; acquired: false; queued: false; draining: true };

export function acquireSessionTurn(
  sessionId: number,
  userTs: string,
  userText: string,
  ownerInstanceId: string | null = null,
  inputClaimToken?: string,
  replyThreadTs?: string,
  metadata: {
    userId?: string | null;
    providerModel?: string | null;
    reasoningEffort?: string | null;
    turnKind?: "slack_user" | "comparison";
    comparisonRequestId?: string | null;
    projectionMode?: TurnProjectionMode;
  } = {},
): AcquireTurnResult {
  return db.transaction((): AcquireTurnResult => {
    const session = db.query("SELECT slack_channel_id, status FROM sessions WHERE id=?")
      .get(sessionId) as { slack_channel_id: string; status: string } | null;
    if (!session) throw new Error(`Cannot acquire a turn for missing session ${sessionId}`);
    if (session.status === "archived") throw new Error(`Cannot acquire a turn for archived session ${sessionId}`);

    const existingClaim = getSlackUserInputClaim(session.slack_channel_id, userTs);
    if (existingClaim && (!inputClaimToken || existingClaim.claim_token !== inputClaimToken)) {
      return { id: Number(existingClaim.turn_id || 0), duplicate: true, acquired: false, queued: false };
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
      return { id: 0, duplicate: false, acquired: false, queued: false, draining: true };
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
      return { id: Number(winner?.turn_id || 0), duplicate: true, acquired: false, queued: false };
    }

    const insert = db.query(`
      INSERT INTO turns (
        session_id, slack_user_msg_ts, slack_reply_thread_ts, user_text, status,
        requested_by_user_id, provider_model, reasoning_effort, turn_kind, projection_mode
      )
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, slack_user_msg_ts) DO NOTHING
    `).run(
      sessionId,
      userTs,
      replyThreadTs || userTs,
      userText,
      metadata.userId || null,
      metadata.providerModel || null,
      metadata.reasoningEffort || null,
      metadata.turnKind || "slack_user",
      metadata.projectionMode || "legacy",
    );
    const row = db.query("SELECT id FROM turns WHERE session_id=? AND slack_user_msg_ts=?")
      .get(sessionId, userTs) as { id: number };
    const id = Number(row.id);
    db.query(`UPDATE slack_user_input_claims SET turn_id=?
              WHERE slack_channel_id=? AND slack_user_msg_ts=? AND claim_token=?`)
      .run(id, session.slack_channel_id, userTs, claimToken);
    if (insert.changes === 0) return { id, duplicate: true, acquired: false, queued: false };
    if (metadata.comparisonRequestId) {
      if (metadata.turnKind !== "comparison") {
        throw new Error("Only a comparison turn may attach a comparison request during admission.");
      }
      requireComparisonTurnAttachment(metadata.comparisonRequestId, id);
    }

    const lock = db.query(`
      UPDATE sessions
      SET status='running', last_turn_at=CURRENT_TIMESTAMP
      WHERE id=? AND status <> 'archived'
        AND NOT EXISTS (
          SELECT 1 FROM turns live
          WHERE live.session_id=sessions.id AND live.id<>?
            AND live.status IN ('running', 'delivering')
        )
        AND NOT EXISTS (
          SELECT 1 FROM turns older
          WHERE older.session_id=sessions.id AND older.id<? AND older.status IN ('queued', 'parked')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM turn_artifact_deliveries artifact
          JOIN turns artifact_turn ON artifact_turn.id=artifact.turn_id
          WHERE artifact_turn.session_id=sessions.id
            AND artifact.status IN ('pending', 'sending')
        )
    `).run(sessionId, id, id);
    if (lock.changes === 0) {
      if ((metadata.projectionMode || "legacy") === "legacy") {
        db.query(`
          UPDATE turns
          SET status_desired_text=?, status_desired_revision=status_desired_revision+1,
              status_projection_status='pending', status_projection_attempts=0,
              status_projection_error=NULL, status_projection_next_attempt_ms=0,
              status_projection_parked_at=NULL
          WHERE id=?
        `).run(QUEUED_TURN_STATUS_TEXT, id);
      }
      return { id, duplicate: false, acquired: false, queued: true };
    }

    db.query(`
      UPDATE turns
      SET status='running', owner_instance_id=?, dispatch_attempt=dispatch_attempt+1,
          dispatch_failure_class=NULL, dispatch_next_attempt_ms=NULL,
          provider_admission_intended_at=NULL,
          provider_started_at=NULL, provider_turn_id=NULL,
          agent_text=NULL, ended_at=NULL, progress_stream_ts=NULL,
          progress_stream_state='not_started', progress_stream_error=NULL,
          stop_requested_at=NULL
      WHERE id=?
    `).run(ownerInstanceId, id);
    const attempt = db.query("SELECT dispatch_attempt FROM turns WHERE id=?")
      .get(id) as { dispatch_attempt: number };
    return { id, duplicate: false, acquired: true, queued: false, dispatchAttempt: attempt.dispatch_attempt };
  })();
}

export function claimNextQueuedTurn(ownerInstanceId: string, nowMs = Date.now()): QueuedTurnClaimRow | null {
  return db.transaction(() => {
    if (db.query("SELECT 1 FROM deployment_drain WHERE singleton=1").get()) return null;
    while (true) {
      const candidate = db.query(`
        SELECT turn.id AS turn_id, turn.session_id, session.status AS session_status
        FROM turns turn
        JOIN sessions session ON session.id=turn.session_id
        WHERE turn.status='queued'
          AND COALESCE(turn.dispatch_next_attempt_ms, 0)<=?
          AND NOT EXISTS (
            SELECT 1 FROM turns older
            WHERE older.session_id=turn.session_id AND older.id<turn.id
              AND older.status IN ('queued', 'parked')
          )
          AND NOT EXISTS (
            SELECT 1 FROM turns live
            WHERE live.session_id=turn.session_id AND live.id<>turn.id
              AND live.status IN ('running', 'delivering')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM turn_artifact_deliveries artifact
            JOIN turns artifact_turn ON artifact_turn.id=artifact.turn_id
            WHERE artifact_turn.session_id=turn.session_id
              AND artifact.status IN ('pending', 'sending')
          )
        ORDER BY turn.id
        LIMIT 1
      `).get(nowMs) as { turn_id: number; session_id: number; session_status: string } | null;
      if (!candidate) return null;

      if (candidate.session_status === "archived") {
        const terminalStatusText = `Status: error - ${ARCHIVED_QUEUED_TURN_ERROR}`;
        const terminalized = db.query(`
          UPDATE turns
          SET status='error', agent_text=?, ended_at=CURRENT_TIMESTAMP,
              owner_instance_id=NULL, status_desired_text=?,
              status_desired_revision=status_desired_revision+1,
              status_projection_status='pending', status_projection_attempts=0,
              status_projection_error=NULL, status_projection_next_attempt_ms=0,
              status_projection_parked_at=NULL
          WHERE id=? AND status='queued'
        `).run(ARCHIVED_QUEUED_TURN_ERROR, terminalStatusText, candidate.turn_id);
        if (terminalized.changes !== 1) {
          throw new Error(`Archived queued turn ${candidate.turn_id} could not be terminalized.`);
        }
        queueTurnReactionCleanup(candidate.turn_id);
        continue;
      }

      const claimed = db.query(`
        UPDATE turns
        SET status='running', owner_instance_id=?, dispatch_attempt=dispatch_attempt+1,
            dispatch_failure_class=NULL, dispatch_next_attempt_ms=NULL,
            provider_admission_intended_at=NULL,
            provider_started_at=NULL, provider_turn_id=NULL,
            agent_text=NULL, ended_at=NULL,
            progress_stream_ts=CASE
              WHEN projection_mode='agent' AND progress_stream_state='streaming' THEN progress_stream_ts
              ELSE NULL END,
            progress_stream_state=CASE
              WHEN projection_mode='agent' AND progress_stream_state='streaming' THEN 'streaming'
              ELSE 'not_started' END,
            progress_stream_error=NULL,
            stop_requested_at=NULL
        WHERE id=? AND status='queued'
          AND NOT EXISTS (
            SELECT 1 FROM turns live
            WHERE live.session_id=turns.session_id AND live.id<>turns.id
              AND live.status IN ('running', 'delivering')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM turn_artifact_deliveries artifact
            JOIN turns artifact_turn ON artifact_turn.id=artifact.turn_id
            WHERE artifact_turn.session_id=turns.session_id
              AND artifact.status IN ('pending', 'sending')
          )
      `).run(ownerInstanceId, candidate.turn_id);
      if (claimed.changes !== 1) return null;
      db.query(`UPDATE sessions SET status='running', last_turn_at=CURRENT_TIMESTAMP
                WHERE id=?`).run(candidate.session_id);

      return db.query(`
        SELECT turn.id AS turn_id, turn.session_id,
               session.slack_channel_id, session.slack_thread_ts AS session_thread_ts,
               session.provider_id, session.agent_session_uuid,
               turn.slack_user_msg_ts,
               COALESCE(turn.slack_reply_thread_ts, turn.slack_user_msg_ts) AS reply_thread_ts,
               turn.user_text AS turn_user_text, turn.provider_model, turn.reasoning_effort,
               turn.turn_kind, turn.projection_mode, turn.dispatch_attempt,
               claim.kind AS claim_kind, claim.turn_id AS claim_turn_id, claim.user_id,
               claim.user_text AS claim_user_text, claim.files_json
        FROM turns turn
        JOIN sessions session ON session.id=turn.session_id
        LEFT JOIN slack_user_input_claims claim
          ON claim.slack_channel_id=session.slack_channel_id
         AND claim.slack_user_msg_ts=turn.slack_user_msg_ts
        WHERE turn.id=?
      `).get(candidate.turn_id) as QueuedTurnClaimRow;
    }
  })();
}

export function attachBotMessage(turnId: number, ts: string) {
  db.query("UPDATE turns SET slack_bot_msg_ts=? WHERE id=?").run(ts, turnId);
}

export function getTurnStatusProjection(turnId: number): TurnStatusProjectionRow | null {
  return db.query(`
    SELECT t.id AS turn_id, s.slack_channel_id,
           COALESCE(t.slack_reply_thread_ts, t.slack_user_msg_ts) AS slack_thread_ts,
           COALESCE(t.slack_bot_msg_ts, '') AS slack_status_msg_ts,
           t.status_message_generation AS message_generation,
           t.status_desired_text AS desired_text,
           t.status_desired_revision AS desired_revision,
           t.status_projected_revision AS projected_revision,
           t.status_projection_status AS projection_status,
           t.status_projection_attempts AS projection_attempts,
           t.status_projection_error AS projection_error,
           t.status_projection_next_attempt_ms AS projection_next_attempt_ms
    FROM turns t
    JOIN sessions s ON s.id=t.session_id
    WHERE t.id=?
  `).get(turnId) as TurnStatusProjectionRow | null;
}

export function requestTurnStatusProjection(turnId: number, text: string): TurnStatusProjectionRow {
  const updated = db.query(`
    UPDATE turns
    SET status_desired_text=?, status_desired_revision=status_desired_revision+1,
        status_projection_status='pending', status_projection_attempts=0,
        status_projection_error=NULL, status_projection_next_attempt_ms=0,
        status_projection_parked_at=NULL
    WHERE id=?
  `).run(text, turnId);
  if (updated.changes !== 1) throw new Error(`Cannot project status for missing turn ${turnId}.`);
  return getTurnStatusProjection(turnId)!;
}

export function claimTurnStatusProjection(turnId: number, nowMs: number): TurnStatusProjectionRow | null {
  const claimed = db.query(`
    UPDATE turns
    SET status_projection_status='sending',
        status_projection_attempts=status_projection_attempts+1,
        status_projection_error=NULL
    WHERE id=? AND status_projection_status='pending'
      AND COALESCE(status_projection_next_attempt_ms, 0) <= ?
  `).run(turnId, nowMs);
  return claimed.changes === 1 ? getTurnStatusProjection(turnId) : null;
}

export function recordTurnStatusMessage(turnId: number, generation: number, messageTs: string) {
  return db.transaction(() => {
    const before = getTurnStatusProjection(turnId);
    if (!before) return null;
    const existingThreadStatus = getSlackThreadStatus(before.slack_channel_id, before.slack_thread_ts);
    const legacyStatusMessage = findLegacySlackThreadStatusMessage(
      before.slack_channel_id,
      before.slack_thread_ts,
    );
    const attached = db.query(`
      UPDATE turns SET slack_bot_msg_ts=?
      WHERE id=? AND status_message_generation=? AND slack_bot_msg_ts IS NULL
    `).run(messageTs, turnId, generation);
    if (attached.changes === 1) {
      const replacingThreadAnchor = existingThreadStatus?.anchor_turn_id === turnId
        && !existingThreadStatus.slack_status_msg_ts;
      const rememberedStatusMessage = replacingThreadAnchor
        ? messageTs
        : existingThreadStatus?.slack_status_msg_ts || legacyStatusMessage || messageTs;
      const rememberedAnchor = existingThreadStatus?.anchor_turn_id || (
        rememberedStatusMessage === messageTs
          ? turnId
          : (db.query(`
              SELECT t.id
              FROM turns t
              JOIN sessions s ON s.id=t.session_id
              WHERE s.slack_channel_id=? AND t.slack_bot_msg_ts=?
              ORDER BY t.id ASC
              LIMIT 1
            `).get(before.slack_channel_id, rememberedStatusMessage) as { id: number } | null)?.id || turnId
      );
      ensureSlackThreadStatusMessage(
        before.slack_channel_id,
        before.slack_thread_ts,
        rememberedStatusMessage,
        rememberedAnchor,
      );
    }
    return getTurnStatusProjection(turnId);
  })();
}

export function replaceMissingTurnStatusMessage(
  turnId: number,
  generation: number,
  expectedMessageTs: string,
) {
  db.transaction(() => {
    const projection = getTurnStatusProjection(turnId);
    if (!projection) return;
    db.query(`
      UPDATE slack_thread_statuses
      SET anchor_turn_id=?, updated_at=CURRENT_TIMESTAMP
      WHERE slack_channel_id=? AND slack_thread_ts=? AND anchor_turn_id IS NULL
        AND slack_status_msg_ts=?
    `).run(
      turnId,
      projection.slack_channel_id,
      projection.slack_thread_ts,
      expectedMessageTs,
    );
    const replaced = db.query(`
      UPDATE turns
      SET slack_bot_msg_ts=NULL, status_message_generation=status_message_generation+1,
          status_projection_status='pending', status_projection_attempts=0,
          status_projection_error=NULL, status_projection_next_attempt_ms=0,
          status_projection_parked_at=NULL
      WHERE id=? AND status_message_generation=? AND COALESCE(slack_bot_msg_ts, '')=?
    `).run(turnId, generation, expectedMessageTs);
    if (replaced.changes !== 1) return;
    db.query(`
      UPDATE slack_thread_statuses
      SET slack_status_msg_ts='', message_generation=message_generation+1,
          projection_status='pending', projection_attempts=0, projection_error=NULL,
          projection_next_attempt_ms=0, projection_parked_at=NULL,
          updated_at=CURRENT_TIMESTAMP
      WHERE slack_channel_id=? AND slack_thread_ts=? AND anchor_turn_id=?
        AND slack_status_msg_ts=?
    `).run(
      projection.slack_channel_id,
      projection.slack_thread_ts,
      turnId,
      expectedMessageTs,
    );
  })();
}

export function markTurnStatusProjectionDelivered(turnId: number, revision: number) {
  db.query(`
    UPDATE turns
    SET status_projected_revision=MAX(status_projected_revision, ?),
        status_projection_status=CASE
          WHEN status_desired_revision=? THEN 'delivered' ELSE 'pending' END,
        status_projection_error=NULL, status_projection_next_attempt_ms=NULL,
        status_projection_parked_at=NULL
    WHERE id=?
  `).run(revision, revision, turnId);
}

export function markTurnStatusProjectionRetry(
  turnId: number,
  revision: number,
  error: string,
  nextAttemptMs: number,
) {
  db.query(`
    UPDATE turns
    SET status_projection_status=CASE
          WHEN status_desired_revision=? THEN 'pending' ELSE status_projection_status END,
        status_projection_error=?,
        status_projection_next_attempt_ms=CASE
          WHEN status_desired_revision=? THEN ? ELSE 0 END
    WHERE id=?
  `).run(revision, error, revision, nextAttemptMs, turnId);
}

export function parkTurnStatusProjection(turnId: number, revision: number, error: string) {
  db.query(`
    UPDATE turns
    SET status_projection_status=CASE
          WHEN status_desired_revision=? THEN 'parked' ELSE 'pending' END,
        status_projection_error=?, status_projection_next_attempt_ms=NULL,
        status_projection_parked_at=CASE
          WHEN status_desired_revision=? THEN CURRENT_TIMESTAMP ELSE NULL END
    WHERE id=?
  `).run(revision, error, revision, turnId);
}

export function parkTurnStatusProjectionAfterFailure(turnId: number, text: string, error: string) {
  const parked = db.query(`
    UPDATE turns
    SET status_desired_text=?, status_desired_revision=status_desired_revision+1,
        status_projection_status='parked', status_projection_error=?,
        status_projection_next_attempt_ms=NULL,
        status_projection_parked_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(text, error, turnId);
  if (parked.changes !== 1) throw new Error(`Cannot park status projection for missing turn ${turnId}.`);
  return getTurnStatusProjection(turnId)!;
}

export function recoverTurnStatusProjectionClaims() {
  return db.query(`
    UPDATE turns
    SET status_projection_status='pending', status_projection_next_attempt_ms=0,
        status_projection_error='Turn status projection interrupted before completion.'
    WHERE status_projection_status='sending'
  `).run().changes;
}

export function listPendingTurnStatusProjections(): TurnStatusProjectionRow[] {
  return db.query(`
    SELECT t.id AS turn_id, s.slack_channel_id,
           COALESCE(t.slack_reply_thread_ts, t.slack_user_msg_ts) AS slack_thread_ts,
           COALESCE(t.slack_bot_msg_ts, '') AS slack_status_msg_ts,
           t.status_message_generation AS message_generation,
           t.status_desired_text AS desired_text,
           t.status_desired_revision AS desired_revision,
           t.status_projected_revision AS projected_revision,
           t.status_projection_status AS projection_status,
           t.status_projection_attempts AS projection_attempts,
           t.status_projection_error AS projection_error,
           t.status_projection_next_attempt_ms AS projection_next_attempt_ms
    FROM turns t
    JOIN sessions s ON s.id=t.session_id
    WHERE t.status_projection_status='pending'
      AND (t.projection_mode='legacy' OR t.status_desired_text LIKE '<@%')
    ORDER BY t.id
  `).all() as TurnStatusProjectionRow[];
}

export function getTurnProgressStream(turnId: number): TurnProgressStreamRow | null {
  return db.query(`
    SELECT turn.id AS turn_id, session.slack_channel_id,
           COALESCE(turn.slack_reply_thread_ts, turn.slack_user_msg_ts) AS slack_thread_ts,
           turn.requested_by_user_id, turn.progress_stream_ts,
           turn.progress_stream_state, turn.progress_stream_error,
           turn.stop_requested_at, turn.status AS turn_status
    FROM turns turn
    JOIN sessions session ON session.id=turn.session_id
    WHERE turn.id=? AND turn.projection_mode='agent'
  `).get(turnId) as TurnProgressStreamRow | null;
}

export function beginTurnProgressStream(turnId: number): TurnProgressStreamRow {
  const started = db.query(`
    UPDATE turns
    SET progress_stream_state='starting', progress_stream_error=NULL
    WHERE id=? AND projection_mode='agent' AND status='running'
      AND progress_stream_state='not_started' AND progress_stream_ts IS NULL
  `).run(turnId);
  if (started.changes !== 1) {
    throw new Error(`Turn ${turnId} cannot start an Agent progress stream from its current state.`);
  }
  return getTurnProgressStream(turnId)!;
}

export function recordTurnProgressStreamStarted(turnId: number, streamTs: string): TurnProgressStreamRow {
  const recorded = db.query(`
    UPDATE turns
    SET progress_stream_ts=?, progress_stream_state='streaming', progress_stream_error=NULL
    WHERE id=? AND projection_mode='agent' AND progress_stream_state='starting'
      AND progress_stream_ts IS NULL
  `).run(streamTs, turnId);
  if (recorded.changes !== 1) {
    throw new Error(`Turn ${turnId} lost ownership while recording its Agent progress stream.`);
  }
  return getTurnProgressStream(turnId)!;
}

export function parkTurnProgressStream(turnId: number, error: string): TurnProgressStreamRow | null {
  db.query(`
    UPDATE turns
    SET progress_stream_state='parked', progress_stream_error=?
    WHERE id=? AND projection_mode='agent' AND progress_stream_state<>'stopped'
  `).run(error, turnId);
  return getTurnProgressStream(turnId);
}

export function requestTurnProgressStreamStop(turnId: number): TurnProgressStreamRow | null {
  db.query(`
    UPDATE turns
    SET progress_stream_state=CASE
          WHEN progress_stream_state IN ('streaming', 'parked') AND progress_stream_ts IS NOT NULL THEN 'stopping'
          ELSE progress_stream_state END,
        progress_stream_error=NULL
    WHERE id=? AND projection_mode='agent'
  `).run(turnId);
  return getTurnProgressStream(turnId);
}

export function markTurnProgressStreamStopped(turnId: number): TurnProgressStreamRow | null {
  db.query(`
    UPDATE turns
    SET progress_stream_state='stopped', progress_stream_error=NULL
    WHERE id=? AND projection_mode='agent'
      AND progress_stream_state IN ('streaming', 'stopping')
  `).run(turnId);
  return getTurnProgressStream(turnId);
}

export function requestAgentStopForProgressStream(input: {
  channel: string;
  threadTs: string;
  streamTs: string;
}): number | null {
  return db.transaction(() => {
    const turn = db.query(`
      SELECT turn.id
      FROM turns turn
      JOIN sessions session ON session.id=turn.session_id
      WHERE session.slack_channel_id=?
        AND COALESCE(turn.slack_reply_thread_ts, turn.slack_user_msg_ts)=?
        AND turn.progress_stream_ts=? AND turn.projection_mode='agent'
        AND turn.status='running' AND turn.progress_stream_state IN ('streaming', 'stopping')
      ORDER BY turn.id DESC
      LIMIT 1
    `).get(input.channel, input.threadTs, input.streamTs) as { id: number } | null;
    if (!turn) return null;
    db.query(`
      UPDATE turns SET stop_requested_at=COALESCE(stop_requested_at, CURRENT_TIMESTAMP)
      WHERE id=? AND status='running'
    `).run(turn.id);
    return turn.id;
  })();
}

export function turnStopWasRequested(turnId: number): boolean {
  const row = db.query("SELECT stop_requested_at FROM turns WHERE id=?")
    .get(turnId) as { stop_requested_at: string | null } | null;
  return Boolean(row?.stop_requested_at);
}

export function cancelRunningTurnAndReleaseSession(
  turnId: number,
  ownerInstanceId: string | null,
  reason: string,
): boolean {
  return db.transaction(() => {
    const turn = db.query(`
      SELECT session_id FROM turns
      WHERE id=? AND status='running' AND owner_instance_id IS ?
    `).get(turnId, ownerInstanceId) as { session_id: number } | null;
    if (!turn) return false;
    db.query(`
      UPDATE turns
      SET status='cancelled', agent_text=?, ended_at=CURRENT_TIMESTAMP,
          owner_instance_id=NULL
      WHERE id=?
    `).run(reason, turnId);
    db.query(`
      UPDATE sessions
      SET status=CASE WHEN status='archived' THEN status ELSE 'idle' END
      WHERE id=?
    `).run(turn.session_id);
    return true;
  })();
}

export function requestSlackRootSummaryProjection(input: {
  channel: string;
  threadTs: string;
  turnId: number;
  text: string;
}): SlackRootSummaryProjectionRow {
  db.query(`
    INSERT INTO slack_root_summary_projections (
      slack_channel_id, slack_thread_ts, root_message_ts, desired_text,
      desired_turn_id, desired_revision, projection_status
    ) VALUES (?, ?, ?, ?, ?, 1, 'pending')
    ON CONFLICT(slack_channel_id, slack_thread_ts) DO UPDATE SET
      root_message_ts=excluded.root_message_ts,
      desired_text=excluded.desired_text,
      desired_turn_id=excluded.desired_turn_id,
      desired_revision=slack_root_summary_projections.desired_revision+1,
      projection_status='pending', projection_attempts=0,
      projection_error=NULL, projection_next_attempt_ms=0,
      projection_parked_at=NULL, updated_at=CURRENT_TIMESTAMP
  `).run(input.channel, input.threadTs, input.threadTs, input.text, input.turnId);
  return getSlackRootSummaryProjection(input.channel, input.threadTs)!;
}

export function getSlackRootSummaryProjection(
  channel: string,
  threadTs: string,
): SlackRootSummaryProjectionRow | null {
  return db.query(`
    SELECT * FROM slack_root_summary_projections
    WHERE slack_channel_id=? AND slack_thread_ts=?
  `).get(channel, threadTs) as SlackRootSummaryProjectionRow | null;
}

export function claimSlackRootSummaryProjection(
  channel: string,
  threadTs: string,
  nowMs: number,
): SlackRootSummaryProjectionRow | null {
  const claimed = db.query(`
    UPDATE slack_root_summary_projections
    SET projection_status='sending', projection_attempts=projection_attempts+1,
        projection_error=NULL, updated_at=CURRENT_TIMESTAMP
    WHERE slack_channel_id=? AND slack_thread_ts=? AND projection_status='pending'
      AND COALESCE(projection_next_attempt_ms, 0)<=?
  `).run(channel, threadTs, nowMs);
  return claimed.changes === 1 ? getSlackRootSummaryProjection(channel, threadTs) : null;
}

export function markSlackRootSummaryProjectionDelivered(
  channel: string,
  threadTs: string,
  revision: number,
) {
  db.query(`
    UPDATE slack_root_summary_projections
    SET projected_revision=MAX(projected_revision, ?),
        projection_status=CASE WHEN desired_revision=? THEN 'delivered' ELSE 'pending' END,
        projection_error=NULL, projection_next_attempt_ms=NULL,
        projection_parked_at=NULL, updated_at=CURRENT_TIMESTAMP
    WHERE slack_channel_id=? AND slack_thread_ts=?
  `).run(revision, revision, channel, threadTs);
}

export function markSlackRootSummaryProjectionRetry(
  channel: string,
  threadTs: string,
  revision: number,
  error: string,
  nextAttemptMs: number,
) {
  db.query(`
    UPDATE slack_root_summary_projections
    SET projection_status=CASE WHEN desired_revision=? THEN 'pending' ELSE projection_status END,
        projection_error=?,
        projection_next_attempt_ms=CASE WHEN desired_revision=? THEN ? ELSE 0 END,
        updated_at=CURRENT_TIMESTAMP
    WHERE slack_channel_id=? AND slack_thread_ts=?
  `).run(revision, error, revision, nextAttemptMs, channel, threadTs);
}

export function parkSlackRootSummaryProjection(
  channel: string,
  threadTs: string,
  revision: number,
  error: string,
) {
  db.query(`
    UPDATE slack_root_summary_projections
    SET projection_status=CASE WHEN desired_revision=? THEN 'parked' ELSE 'pending' END,
        projection_error=?, projection_next_attempt_ms=NULL,
        projection_parked_at=CASE WHEN desired_revision=? THEN CURRENT_TIMESTAMP ELSE NULL END,
        updated_at=CURRENT_TIMESTAMP
    WHERE slack_channel_id=? AND slack_thread_ts=?
  `).run(revision, error, revision, channel, threadTs);
}

export function recoverSlackRootSummaryProjectionClaims(): number {
  return db.query(`
    UPDATE slack_root_summary_projections
    SET projection_status='pending', projection_next_attempt_ms=0,
        projection_error='Root summary projection interrupted before completion.',
        updated_at=CURRENT_TIMESTAMP
    WHERE projection_status='sending'
  `).run().changes;
}

export function listPendingSlackRootSummaryProjections(): SlackRootSummaryProjectionRow[] {
  return db.query(`
    SELECT * FROM slack_root_summary_projections
    WHERE projection_status='pending'
    ORDER BY updated_at, slack_channel_id, slack_thread_ts
  `).all() as SlackRootSummaryProjectionRow[];
}

export function requestSlackAgentSessionStatusProjection(input: {
  channel: string;
  threadTs: string;
  status: SlackAgentSessionStatusProjectionRow["desired_status"];
}): SlackAgentSessionStatusProjectionRow {
  db.query(`
    INSERT INTO slack_agent_session_status_projections (
      slack_channel_id, slack_thread_ts, desired_status, desired_revision, projection_status
    ) VALUES (?, ?, ?, 1, 'pending')
    ON CONFLICT(slack_channel_id, slack_thread_ts) DO UPDATE SET
      desired_status=excluded.desired_status,
      desired_revision=slack_agent_session_status_projections.desired_revision+1,
      projection_status='pending', projection_attempts=0,
      projection_error=NULL, projection_next_attempt_ms=0,
      projection_parked_at=NULL, updated_at=CURRENT_TIMESTAMP
  `).run(input.channel, input.threadTs, input.status);
  return getSlackAgentSessionStatusProjection(input.channel, input.threadTs)!;
}

export function getSlackAgentSessionStatusProjection(
  channel: string,
  threadTs: string,
): SlackAgentSessionStatusProjectionRow | null {
  return db.query(`
    SELECT * FROM slack_agent_session_status_projections
    WHERE slack_channel_id=? AND slack_thread_ts=?
  `).get(channel, threadTs) as SlackAgentSessionStatusProjectionRow | null;
}

export function claimSlackAgentSessionStatusProjection(
  channel: string,
  threadTs: string,
  nowMs: number,
): SlackAgentSessionStatusProjectionRow | null {
  const claimed = db.query(`
    UPDATE slack_agent_session_status_projections
    SET projection_status='sending', projection_attempts=projection_attempts+1,
        projection_error=NULL, updated_at=CURRENT_TIMESTAMP
    WHERE slack_channel_id=? AND slack_thread_ts=? AND projection_status='pending'
      AND COALESCE(projection_next_attempt_ms, 0)<=?
  `).run(channel, threadTs, nowMs);
  return claimed.changes === 1 ? getSlackAgentSessionStatusProjection(channel, threadTs) : null;
}

export function markSlackAgentSessionStatusProjectionDelivered(
  channel: string,
  threadTs: string,
  revision: number,
) {
  db.query(`
    UPDATE slack_agent_session_status_projections
    SET projected_revision=MAX(projected_revision, ?),
        projection_status=CASE WHEN desired_revision=? THEN 'delivered' ELSE 'pending' END,
        projection_error=NULL, projection_next_attempt_ms=NULL,
        projection_parked_at=NULL, updated_at=CURRENT_TIMESTAMP
    WHERE slack_channel_id=? AND slack_thread_ts=?
  `).run(revision, revision, channel, threadTs);
}

export function markSlackAgentSessionStatusProjectionRetry(
  channel: string,
  threadTs: string,
  revision: number,
  error: string,
  nextAttemptMs: number,
) {
  db.query(`
    UPDATE slack_agent_session_status_projections
    SET projection_status=CASE WHEN desired_revision=? THEN 'pending' ELSE projection_status END,
        projection_error=?,
        projection_next_attempt_ms=CASE WHEN desired_revision=? THEN ? ELSE 0 END,
        updated_at=CURRENT_TIMESTAMP
    WHERE slack_channel_id=? AND slack_thread_ts=?
  `).run(revision, error, revision, nextAttemptMs, channel, threadTs);
}

export function parkSlackAgentSessionStatusProjection(
  channel: string,
  threadTs: string,
  revision: number,
  error: string,
) {
  db.query(`
    UPDATE slack_agent_session_status_projections
    SET projection_status=CASE WHEN desired_revision=? THEN 'parked' ELSE 'pending' END,
        projection_error=?, projection_next_attempt_ms=NULL,
        projection_parked_at=CASE WHEN desired_revision=? THEN CURRENT_TIMESTAMP ELSE NULL END,
        updated_at=CURRENT_TIMESTAMP
    WHERE slack_channel_id=? AND slack_thread_ts=?
  `).run(revision, error, revision, channel, threadTs);
}

export function recoverSlackAgentSessionStatusProjectionClaims(): number {
  return db.query(`
    UPDATE slack_agent_session_status_projections
    SET projection_status='pending', projection_next_attempt_ms=0,
        projection_error='Agent session status projection interrupted before completion.',
        updated_at=CURRENT_TIMESTAMP
    WHERE projection_status='sending'
  `).run().changes;
}

export function listPendingSlackAgentSessionStatusProjections(): SlackAgentSessionStatusProjectionRow[] {
  return db.query(`
    SELECT * FROM slack_agent_session_status_projections
    WHERE projection_status='pending'
    ORDER BY updated_at, slack_channel_id, slack_thread_ts
  `).all() as SlackAgentSessionStatusProjectionRow[];
}

export function getSlackThreadStatus(chanId: string, threadTs: string): SlackThreadStatusRow | null {
  return db.query(`SELECT * FROM slack_thread_statuses
                   WHERE slack_channel_id=? AND slack_thread_ts=?`)
    .get(chanId, threadTs) as SlackThreadStatusRow | null;
}

function findSlackThreadStatusAnchorTurnId(
  chanId: string,
  threadTs: string,
  statusMessageTs: string,
): number | null {
  if (!statusMessageTs) return null;
  const row = db.query(`
    SELECT t.id
    FROM turns t
    JOIN sessions s ON s.id=t.session_id
    LEFT JOIN channels channel ON channel.slack_channel_id=s.slack_channel_id
    LEFT JOIN slack_user_input_claims claim
      ON claim.slack_channel_id=s.slack_channel_id
     AND claim.slack_user_msg_ts=t.slack_user_msg_ts
    WHERE s.slack_channel_id=? AND t.slack_bot_msg_ts=?
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
    ORDER BY t.id ASC
    LIMIT 1
  `).get(
    chanId,
    statusMessageTs,
    threadTs,
    threadTs,
    threadTs,
    threadTs,
  ) as { id: number } | null;
  return row?.id || null;
}

function resolveSlackThreadStatusAnchor(
  chanId: string,
  threadTs: string,
): SlackThreadStatusRow | null {
  const status = getSlackThreadStatus(chanId, threadTs);
  if (!status || status.anchor_turn_id || !status.slack_status_msg_ts) return status;
  const anchorTurnId = findSlackThreadStatusAnchorTurnId(
    chanId,
    threadTs,
    status.slack_status_msg_ts,
  );
  if (!anchorTurnId) return status;
  db.query(`
    UPDATE slack_thread_statuses
    SET anchor_turn_id=?, updated_at=CURRENT_TIMESTAMP
    WHERE slack_channel_id=? AND slack_thread_ts=? AND anchor_turn_id IS NULL
      AND slack_status_msg_ts=?
  `).run(anchorTurnId, chanId, threadTs, status.slack_status_msg_ts);
  return getSlackThreadStatus(chanId, threadTs);
}

export function backfillSlackThreadStatusAnchors(): number {
  return db.transaction(() => {
    const unresolved = db.query(`
      SELECT slack_channel_id, slack_thread_ts
      FROM slack_thread_statuses
      WHERE anchor_turn_id IS NULL AND slack_status_msg_ts <> ''
      ORDER BY slack_channel_id, slack_thread_ts
    `).all() as Array<{ slack_channel_id: string; slack_thread_ts: string }>;
    let resolved = 0;
    for (const row of unresolved) {
      if (resolveSlackThreadStatusAnchor(row.slack_channel_id, row.slack_thread_ts)?.anchor_turn_id) {
        resolved += 1;
      }
    }
    return resolved;
  })();
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

export function ensureSlackThreadStatusMessage(
  chanId: string,
  threadTs: string,
  statusMessageTs: string,
  anchorTurnId?: number | null,
) {
  db.query(`
    INSERT INTO slack_thread_statuses (
      slack_channel_id, slack_thread_ts, slack_status_msg_ts, anchor_turn_id
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(slack_channel_id, slack_thread_ts) DO UPDATE SET
      slack_status_msg_ts=CASE
        WHEN slack_thread_statuses.slack_status_msg_ts='' THEN excluded.slack_status_msg_ts
        ELSE slack_thread_statuses.slack_status_msg_ts
      END,
      anchor_turn_id=COALESCE(slack_thread_statuses.anchor_turn_id, excluded.anchor_turn_id),
      updated_at=CURRENT_TIMESTAMP
  `).run(chanId, threadTs, statusMessageTs, anchorTurnId || null);
  return getSlackThreadStatus(chanId, threadTs)!;
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
    return getSlackThreadStatus(input.channel, input.threadTs)!;
  })();
}

export function claimSlackThreadStatusProjection(
  chanId: string,
  threadTs: string,
  nowMs: number,
): SlackThreadStatusRow | null {
  return db.transaction(() => {
    resolveSlackThreadStatusAnchor(chanId, threadTs);
    const claimed = db.query(`
      UPDATE slack_thread_statuses
      SET projection_status='sending', projection_attempts=projection_attempts+1,
          projection_error=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE slack_channel_id=? AND slack_thread_ts=? AND projection_status='pending'
        AND COALESCE(projection_next_attempt_ms, 0) <= ?
    `).run(chanId, threadTs, nowMs);
    return claimed.changes === 1 ? getSlackThreadStatus(chanId, threadTs) : null;
  })();
}

export function recordSlackThreadStatusMessage(
  chanId: string,
  threadTs: string,
  generation: number,
  messageTs: string,
): SlackThreadStatusRow | null {
  return db.transaction(() => {
    const attached = db.query(`
      UPDATE slack_thread_statuses SET slack_status_msg_ts=?, updated_at=CURRENT_TIMESTAMP
      WHERE slack_channel_id=? AND slack_thread_ts=? AND message_generation=?
        AND slack_status_msg_ts=''
    `).run(messageTs, chanId, threadTs, generation);
    if (attached.changes === 1) {
      const status = getSlackThreadStatus(chanId, threadTs);
      if (status?.anchor_turn_id) {
        db.query(`
          UPDATE turns SET slack_bot_msg_ts=?
          WHERE id=? AND slack_bot_msg_ts IS NULL
        `).run(messageTs, status.anchor_turn_id);
      }
    }
    return getSlackThreadStatus(chanId, threadTs);
  })();
}

export function replaceMissingSlackThreadStatusMessage(
  chanId: string,
  threadTs: string,
  generation: number,
  expectedMessageTs: string,
) {
  db.transaction(() => {
    const status = resolveSlackThreadStatusAnchor(chanId, threadTs);
    if (!status) return;
    const replaced = db.query(`
      UPDATE slack_thread_statuses
      SET slack_status_msg_ts='', message_generation=message_generation+1,
          projection_status='pending', projection_attempts=0, projection_error=NULL,
          projection_next_attempt_ms=0, projection_parked_at=NULL,
          updated_at=CURRENT_TIMESTAMP
      WHERE slack_channel_id=? AND slack_thread_ts=? AND message_generation=?
        AND slack_status_msg_ts=?
    `).run(chanId, threadTs, generation, expectedMessageTs);
    if (replaced.changes !== 1 || !status.anchor_turn_id) return;
    db.query(`
      UPDATE turns
      SET slack_bot_msg_ts=NULL, status_message_generation=status_message_generation+1,
          status_projection_status='pending', status_projection_attempts=0,
          status_projection_error=NULL, status_projection_next_attempt_ms=0,
          status_projection_parked_at=NULL
      WHERE id=? AND slack_bot_msg_ts=?
    `).run(status.anchor_turn_id, expectedMessageTs);
  })();
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

export function parkSlackThreadStatusProjectionAfterFailure(input: {
  channel: string;
  threadTs: string;
  turnId: number;
  text: string;
  error: string;
}) {
  db.query(`
    INSERT INTO slack_thread_statuses (
      slack_channel_id, slack_thread_ts, slack_status_msg_ts, desired_text,
      desired_turn_id, desired_revision, projection_status, projection_error,
      projection_next_attempt_ms, projection_parked_at
    ) VALUES (?, ?, '', ?, ?, 1, 'parked', ?, NULL, CURRENT_TIMESTAMP)
    ON CONFLICT(slack_channel_id, slack_thread_ts) DO UPDATE SET
      desired_text=excluded.desired_text,
      desired_turn_id=excluded.desired_turn_id,
      desired_revision=slack_thread_statuses.desired_revision+1,
      projection_status='parked', projection_error=excluded.projection_error,
      projection_next_attempt_ms=NULL, projection_parked_at=CURRENT_TIMESTAMP,
      updated_at=CURRENT_TIMESTAMP
  `).run(input.channel, input.threadTs, input.text, input.turnId, input.error);
  return getSlackThreadStatus(input.channel, input.threadTs)!;
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
  db.transaction(() => {
    db.query("UPDATE turns SET status=?, agent_text=?, ended_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(status, agentText, turnId);
    queueTurnReactionCleanup(turnId);
  })();
}

export function failRunningTurnAndReleaseSession(
  turnId: number,
  ownerInstanceId: string,
  error: string,
  terminalStatusText?: string,
): boolean {
  return db.transaction(() => {
    const turn = db.query(`
      SELECT session_id FROM turns
      WHERE id=? AND status='running' AND owner_instance_id=?
    `).get(turnId, ownerInstanceId) as { session_id: number } | null;
    if (!turn) return false;

    if (terminalStatusText) {
      db.query(`
        UPDATE turns
        SET status='error', agent_text=?, ended_at=CURRENT_TIMESTAMP, owner_instance_id=NULL,
            status_desired_text=?, status_desired_revision=status_desired_revision+1,
            status_projection_status='pending', status_projection_attempts=0,
            status_projection_error=NULL, status_projection_next_attempt_ms=0,
            status_projection_parked_at=NULL
        WHERE id=?
      `).run(error, terminalStatusText, turnId);
    } else {
      db.query(`
        UPDATE turns
        SET status='error', agent_text=?, ended_at=CURRENT_TIMESTAMP, owner_instance_id=NULL
        WHERE id=?
      `).run(error, turnId);
    }
    queueTurnReactionCleanup(turnId);
    db.query(`UPDATE sessions
              SET status=CASE WHEN status='archived' THEN status ELSE 'error' END
              WHERE id=?`).run(turn.session_id);
    return true;
  })();
}

export function markTurnDelivering(
  turnId: number,
  agentText: string,
  outboundText = agentText,
  chunkCount = 1,
  responseTldr: string | null = null,
) {
  return db.transaction(() => {
    const transition = db.query(`UPDATE turns SET status='delivering', agent_text=?, outbound_text=?, response_tldr=?, delivery_status='pending',
              delivery_error=NULL WHERE id=? AND status='running' AND stop_requested_at IS NULL`)
      .run(agentText, outboundText, responseTldr, turnId);
    if (transition.changes !== 1) return false;
    for (let index = 0; index < chunkCount; index += 1) {
      db.query("INSERT OR IGNORE INTO turn_delivery_chunks (turn_id, chunk_index) VALUES (?, ?)").run(turnId, index);
    }
    return true;
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
    const visibleThreadTs = turn.slack_reply_thread_ts || turn.slack_user_msg_ts;
    const threadStatus = getSlackThreadStatus(turn.slack_channel_id, visibleThreadTs);
    if (!threadStatus?.slack_status_msg_ts || !turn.response_tldr) return null;
    return advanceSlackThreadSummary({
      channel: turn.slack_channel_id,
      threadTs: visibleThreadTs,
      statusMessageTs: threadStatus.slack_status_msg_ts,
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
    db.query(`UPDATE comparison_requests
              SET status='done', error=NULL, updated_at=CURRENT_TIMESTAMP
              WHERE turn_id=? AND status IN ('claimed', 'running')`).run(turnId);
    queueTurnReactionCleanup(turnId);
    db.query("UPDATE sessions SET status='idle' WHERE id=?").run(turn.session_id);
    return true;
  })();
}

export function markTurnDeliveryFailed(turnId: number, error: string) {
  db.query(`UPDATE turns SET delivery_status='pending', delivery_error=?
            WHERE id=? AND status='delivering'`).run(error, turnId);
}

export function parkTurnDelivery(
  turnId: number,
  ownerInstanceId: string,
  terminalStatusText: string,
  error: string | null = null,
): boolean {
  return db.transaction(() => {
    const turn = db.query(`SELECT session_id FROM turns WHERE id=? AND status='delivering'
      AND owner_instance_id=?`).get(turnId, ownerInstanceId) as any;
    if (!turn) return false;
    db.query(`UPDATE turns SET status='delivery_parked', delivery_status='parked', delivery_error=COALESCE(?, delivery_error),
      ended_at=CURRENT_TIMESTAMP, owner_instance_id=NULL WHERE id=?`).run(error, turnId);
    db.query(`
      UPDATE turns
      SET status_desired_text=?, status_desired_revision=status_desired_revision+1,
          status_projection_status='pending', status_projection_attempts=0,
          status_projection_error=NULL, status_projection_next_attempt_ms=0,
          status_projection_parked_at=NULL
      WHERE id=?
    `).run(terminalStatusText, turnId);
    queueTurnReactionCleanup(turnId);
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
