import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

const dir = `${homedir()}/.local/state/concierge`;
mkdirSync(dir, { recursive: true });
export const db = new Database(`${dir}/state.db`, { create: true });
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS channels (
  slack_channel_id  TEXT PRIMARY KEY,
  slack_channel_name TEXT NOT NULL,
  vault_path        TEXT NOT NULL,
  code_path         TEXT,
  additional_paths  TEXT DEFAULT '[]',
  provider_default  TEXT NOT NULL DEFAULT 'codex',
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  slack_channel_id  TEXT NOT NULL,
  slack_thread_ts   TEXT NOT NULL,
  provider_id       TEXT NOT NULL,
  agent_session_uuid TEXT,
  parent_session_id INTEGER,
  status            TEXT NOT NULL DEFAULT 'idle',
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_turn_at      DATETIME,
  UNIQUE(slack_channel_id, slack_thread_ts, provider_id)
);
`);

export function getChannel(chanId: string) {
  return db.prepare("SELECT * FROM channels WHERE slack_channel_id = ?").get(chanId) as any;
}
export function upsertChannel(row: any) {
  db.prepare(`INSERT INTO channels (slack_channel_id, slack_channel_name, vault_path, code_path)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(slack_channel_id) DO UPDATE SET
                slack_channel_name=excluded.slack_channel_name,
                vault_path=excluded.vault_path,
                code_path=excluded.code_path`)
    .run(row.slack_channel_id, row.slack_channel_name, row.vault_path, row.code_path);
}
export function getSession(chanId: string, threadTs: string, provider: string) {
  return db.prepare("SELECT * FROM sessions WHERE slack_channel_id=? AND slack_thread_ts=? AND provider_id=?")
    .get(chanId, threadTs, provider) as any;
}
export function upsertSession(chanId: string, threadTs: string, provider: string, uuid: string | null) {
  db.prepare(`INSERT INTO sessions (slack_channel_id, slack_thread_ts, provider_id, agent_session_uuid, last_turn_at, status)
              VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, 'idle')
              ON CONFLICT(slack_channel_id, slack_thread_ts, provider_id) DO UPDATE SET
                agent_session_uuid = COALESCE(excluded.agent_session_uuid, sessions.agent_session_uuid),
                last_turn_at = CURRENT_TIMESTAMP,
                status='idle'`)
    .run(chanId, threadTs, provider, uuid);
}
