import { Database } from "bun:sqlite";
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
addColumn("channels", "session_mode", "session_mode TEXT NOT NULL DEFAULT 'per-thread'");
addColumn("channels", "default_session_uuid", "default_session_uuid TEXT");
addColumn("sessions", "parent_message_idx", "parent_message_idx INTEGER");
addColumn("turns", "owner_instance_id", "owner_instance_id TEXT");
addColumn("turns", "delivery_status", "delivery_status TEXT NOT NULL DEFAULT 'not_ready'");
addColumn("turns", "delivered_at", "delivered_at DATETIME");
addColumn("turns", "delivery_error", "delivery_error TEXT");
addColumn("turns", "delivery_attempts", "delivery_attempts INTEGER NOT NULL DEFAULT 0");
addColumn("turns", "outbound_text", "outbound_text TEXT");
addColumn("process_instances", "process_start_ticks", "process_start_ticks TEXT");

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
           t.slack_user_msg_ts, t.slack_bot_msg_ts, t.agent_text, t.outbound_text, t.status,
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
    db.query("UPDATE sessions SET status='idle' WHERE id=?").run(turn.session_id);
    interrupted = true;
  })();
  return interrupted;
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
  provider_default: ProviderId;
  mode: ChannelMode;
  bot_user_id: string | null;
  canvas_id: string | null;
  list_id: string | null;
  list_title_column_id: string | null;
  list_completed_column_id: string | null;
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
  provider_default?: ProviderId;
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

export function updateChannelProvider(chanId: string, provider: ProviderId) {
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
        list_completed_column_id=?
    WHERE slack_channel_id=?
  `).run(
    list.listId,
    list.titleColumnId ?? null,
    list.completedColumnId ?? null,
    chanId,
  );
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

export function getSessionForSlackMessage(chanId: string, messageTs: string): SessionRow | null {
  return db.query(`
    SELECT s.*
    FROM sessions s
    JOIN turns t ON t.session_id = s.id
    WHERE s.slack_channel_id = ?
      AND (t.slack_user_msg_ts = ? OR t.slack_bot_msg_ts = ?)
    ORDER BY t.id DESC
    LIMIT 1
  `).get(chanId, messageTs, messageTs) as SessionRow | null;
}

export function resolveForkParentSession(chanId: string, messageTs?: string | null): SessionRow | null {
  const ts = messageTs?.trim();
  if (ts) {
    return getSessionForThread(chanId, ts) || getSessionForSlackMessage(chanId, ts);
  }
  return getLatestSession(chanId);
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

export function startTurn(sessionId: number, userTs: string, userText: string): { id: number; duplicate: boolean } {
  const result = db.query(`
    INSERT INTO turns (session_id, slack_user_msg_ts, user_text, status)
    VALUES (?, ?, ?, 'running')
    ON CONFLICT(session_id, slack_user_msg_ts) DO NOTHING
  `).run(sessionId, userTs, userText);
  const row = db.query("SELECT id FROM turns WHERE session_id=? AND slack_user_msg_ts=?").get(sessionId, userTs) as any;
  return { id: Number(row.id), duplicate: result.changes === 0 };
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
): AcquireTurnResult {
  return db.transaction((): AcquireTurnResult => {
    if (db.query("SELECT 1 FROM deployment_drain WHERE singleton=1").get()) {
      return { id: 0, duplicate: false, acquired: false, busy: false, draining: true };
    }
  const insert = db.query(`
    INSERT INTO turns (session_id, slack_user_msg_ts, user_text, status)
    VALUES (?, ?, ?, 'queued')
    ON CONFLICT(session_id, slack_user_msg_ts) DO NOTHING
  `).run(sessionId, userTs, userText);
  const row = db.query("SELECT id FROM turns WHERE session_id=? AND slack_user_msg_ts=?").get(sessionId, userTs) as any;
  const id = Number(row.id);
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

export function finishTurn(turnId: number, status: "done" | "error" | "cancelled", agentText: string | null) {
  db.query("UPDATE turns SET status=?, agent_text=?, ended_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(status, agentText, turnId);
}

export function markTurnDelivering(turnId: number, agentText: string, outboundText = agentText, chunkCount = 1) {
  db.transaction(() => {
    db.query(`UPDATE turns SET status='delivering', agent_text=?, outbound_text=?, delivery_status='pending',
              delivery_error=NULL WHERE id=? AND status='running'`).run(agentText, outboundText, turnId);
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

export function markTurnDelivered(turnId: number) {
  db.transaction(() => {
    const turn = db.query("SELECT session_id FROM turns WHERE id=? AND status='delivering'").get(turnId) as any;
    if (!turn) return;
    db.query(`UPDATE turns SET status='done', delivery_status='delivered', delivered_at=CURRENT_TIMESTAMP,
              ended_at=CURRENT_TIMESTAMP, owner_instance_id=NULL WHERE id=?`).run(turnId);
    db.query("UPDATE sessions SET status='idle' WHERE id=?").run(turn.session_id);
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
  return db.query(`UPDATE turns SET owner_instance_id=NULL, delivery_status='pending'
    WHERE id=? AND status='delivering' AND owner_instance_id=?`).run(turnId, ownerInstanceId).changes === 1;
}

export function setSessionStatus(sessionId: number, status: "idle" | "running" | "error" | "archived") {
  db.query("UPDATE sessions SET status=? WHERE id=?").run(status, sessionId);
}
