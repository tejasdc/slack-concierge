import type { Database } from "bun:sqlite";
import { visibleSlackRootSql } from "./slack-thread-identity";

export const ROUTER_SEARCH_VERSION = 1;
export type RouterSearchSourceKind = "turn_input" | "steering_input" | "delivered_tldr";

export function slackTimestampUs(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{1,10}\.\d{1,6}$/.test(value)) return null;
  const [seconds, fraction] = value.split(".");
  const microseconds = BigInt(seconds!) * 1_000_000n + BigInt(fraction!.padEnd(6, "0"));
  return microseconds <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(microseconds) : null;
}

export function slackTimestampUsSql(column: string) {
  const seconds = `substr(${column}, 1, instr(${column}, '.')-1)`;
  const fraction = `substr(${column}, instr(${column}, '.')+1)`;
  const integer = `(CAST(${seconds} AS INTEGER)*1000000 + CAST(substr(${fraction} || '000000', 1, 6) AS INTEGER))`;
  return `CASE WHEN typeof(${column})='text' AND ${column} NOT GLOB '*[^0-9.]*'
    AND length(${seconds}) BETWEEN 1 AND 10 AND length(${fraction}) BETWEEN 1 AND 6
    AND instr(${fraction}, '.')=0 AND ${integer}<=9007199254740991 THEN ${integer} END`;
}

type SearchSource = {
  source_kind: RouterSearchSourceKind;
  source_id: number;
  turn_id: number;
  slack_channel_id: string;
  slack_thread_ts: string;
  slack_message_ts: string;
  content: string;
};

function projectSource(database: Database, source: SearchSource) {
  const messageUs = slackTimestampUs(source.slack_message_ts);
  const rootUs = slackTimestampUs(source.slack_thread_ts);
  if (messageUs === null || rootUs === null || rootUs > messageUs
      || !/^[CGD][A-Z0-9]+$/.test(source.slack_channel_id)) return;
  database.query(`INSERT INTO router_search_documents
    (source_kind, source_id, turn_id, slack_channel_id, slack_thread_ts,
     slack_message_ts, slack_message_ts_us, occurred_at, content)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_kind, source_id) DO UPDATE SET
      slack_channel_id=excluded.slack_channel_id, slack_thread_ts=excluded.slack_thread_ts,
      slack_message_ts=excluded.slack_message_ts, slack_message_ts_us=excluded.slack_message_ts_us,
      occurred_at=excluded.occurred_at, content=excluded.content
    WHERE slack_channel_id IS NOT excluded.slack_channel_id OR slack_thread_ts IS NOT excluded.slack_thread_ts
      OR slack_message_ts IS NOT excluded.slack_message_ts OR content IS NOT excluded.content`)
    .run(source.source_kind, source.source_id, source.turn_id, source.slack_channel_id, source.slack_thread_ts,
      source.slack_message_ts, messageUs, new Date(Math.floor(messageUs / 1000)).toISOString(), source.content);
}

// Called only inside the transaction that accepts this exact source mutation.
export function projectRouterSearchSource(database: Database, kind: RouterSearchSourceKind, id: number) {
  const source = database.query(`SELECT * FROM router_search_sources WHERE source_kind=? AND source_id=?`)
    .get(kind, id) as SearchSource | null;
  if (source) projectSource(database, source);
}

export function refreshRouterSearchTurnIdentity(database: Database, turnId: number) {
  for (const source of database.query("SELECT * FROM router_search_sources WHERE turn_id=?").all(turnId) as SearchSource[]) {
    projectSource(database, source);
  }
}

export function rebuildRouterSearchIndex(database: Database) {
  return database.transaction(() => {
    // FTS deletion requires existing postings, including during recovery from
    // missing index rows. Restore that precondition before replacing documents.
    database.exec("INSERT INTO router_search_fts(router_search_fts) VALUES('rebuild')");
    database.exec("DELETE FROM router_search_documents");
    for (const source of database.query("SELECT * FROM router_search_sources ORDER BY turn_id, source_kind, source_id").iterate()) {
      projectSource(database, source as SearchSource);
    }
    database.query(`INSERT INTO router_search_index_state(singleton, version) VALUES(1, ?)
      ON CONFLICT(singleton) DO UPDATE SET version=excluded.version`).run(ROUTER_SEARCH_VERSION);
  })();
}

export function initializeRouterSearchIndex(database: Database) {
  database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS router_search_index_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS router_search_documents (
        id INTEGER PRIMARY KEY,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('turn_input','steering_input','delivered_tldr')),
        source_id INTEGER NOT NULL,
        turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        slack_channel_id TEXT NOT NULL,
        slack_thread_ts TEXT NOT NULL,
        slack_message_ts TEXT NOT NULL,
        slack_message_ts_us INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        content TEXT NOT NULL,
        UNIQUE(source_kind, source_id)
      );
      CREATE INDEX IF NOT EXISTS router_search_destination ON router_search_documents(slack_channel_id, slack_thread_ts, slack_message_ts_us);
      CREATE INDEX IF NOT EXISTS router_search_turn ON router_search_documents(turn_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS router_search_fts USING fts5(content, content='router_search_documents', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER IF NOT EXISTS router_search_insert AFTER INSERT ON router_search_documents BEGIN
        INSERT INTO router_search_fts(rowid, content) VALUES(new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS router_search_delete AFTER DELETE ON router_search_documents BEGIN
        INSERT INTO router_search_fts(router_search_fts, rowid, content) VALUES('delete', old.id, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS router_search_update AFTER UPDATE ON router_search_documents BEGIN
        INSERT INTO router_search_fts(router_search_fts, rowid, content) VALUES('delete', old.id, old.content);
        INSERT INTO router_search_fts(rowid, content) VALUES(new.id, new.content);
      END;
      CREATE VIEW IF NOT EXISTS router_search_sources AS
      WITH visible_turns AS NOT MATERIALIZED (
        SELECT t.*, s.slack_channel_id, ${visibleSlackRootSql()} AS visible_root
        FROM turns t JOIN sessions s ON s.id=t.session_id
        LEFT JOIN channels channel ON channel.slack_channel_id=s.slack_channel_id
        LEFT JOIN slack_user_input_claims claim ON claim.slack_channel_id=s.slack_channel_id AND claim.slack_user_msg_ts=t.slack_user_msg_ts
      ), fragments AS (
      SELECT 'turn_input' AS source_kind, t.id AS source_id, t.id AS turn_id,
        t.slack_channel_id, t.visible_root AS slack_thread_ts, t.slack_user_msg_ts AS slack_message_ts, t.user_text AS content
      FROM visible_turns t WHERE t.turn_kind='slack_user' AND trim(t.user_text)<>''
      UNION ALL
      SELECT 'steering_input', steering.id, t.id, t.slack_channel_id,
        COALESCE(steering.reply_thread_ts, claim.reply_thread_ts, t.visible_root), steering.slack_user_msg_ts, steering.user_text
      FROM visible_turns t JOIN turn_steering_messages steering ON steering.turn_id=t.id
      LEFT JOIN slack_user_input_claims claim ON claim.slack_channel_id=t.slack_channel_id AND claim.slack_user_msg_ts=steering.slack_user_msg_ts
      WHERE steering.status='sent' AND trim(steering.user_text)<>''
      UNION ALL
      SELECT 'delivered_tldr', t.id, t.id, t.slack_channel_id, t.visible_root,
        (SELECT chunk.slack_ts FROM turn_delivery_chunks chunk WHERE chunk.turn_id=t.id AND chunk.delivered_at IS NOT NULL
          ORDER BY ${slackTimestampUsSql("chunk.slack_ts")} DESC LIMIT 1), t.response_tldr
      FROM visible_turns t WHERE t.delivery_status='delivered' AND trim(t.response_tldr)<>''
      ) SELECT *, ${slackTimestampUsSql("slack_message_ts")} AS slack_message_ts_us,
        ${slackTimestampUsSql("slack_thread_ts")} AS slack_thread_ts_us FROM fragments;
    `);
    const state = database.query("SELECT version FROM router_search_index_state WHERE singleton=1").get() as { version: number } | null;
    if (state?.version !== ROUTER_SEARCH_VERSION) rebuildRouterSearchIndex(database);
  })();
}
