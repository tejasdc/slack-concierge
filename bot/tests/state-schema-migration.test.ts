import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scratch: string[] = [];

afterAll(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

function runStateImport(stateDirectory: string) {
  return Bun.spawnSync({
    cmd: [process.execPath, "--eval", 'await import("./src/state.ts")'],
    cwd: resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      CONCIERGE_STATE_DIR: stateDirectory,
      CONCIERGE_TEST_MODE: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function importState(stateDirectory: string) {
  const result = runStateImport(stateDirectory);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

function createLegacyDatabase(includeAuthorizingSession: boolean) {
  const stateDirectory = mkdtempSync(join(tmpdir(), "concierge-schema-migration-"));
  scratch.push(stateDirectory);
  const database = new Database(join(stateDirectory, "state.db"), { create: true });
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE sessions (
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
    INSERT INTO sessions (
      id, slack_channel_id, slack_thread_ts, provider_id, agent_session_uuid
    ) VALUES (42, 'C_LEGACY', '1.1', 'codex', 'legacy-thread');
    CREATE TABLE codex_remote_mirror_events (
      provider_thread_uuid    TEXT NOT NULL,
      provider_item_id        TEXT NOT NULL,
      provider_turn_id        TEXT NOT NULL,
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
      updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ${includeAuthorizingSession ? ", authorizing_session_id INTEGER REFERENCES sessions(id)" : ""},
      PRIMARY KEY(provider_thread_uuid, provider_item_id)
    );
  `);
  const authorizingColumn = includeAuthorizingSession ? ", authorizing_session_id" : "";
  const authorizingValue = includeAuthorizingSession ? ", 42" : "";
  database.exec(`
    INSERT INTO codex_remote_mirror_events (
      provider_thread_uuid, provider_item_id, provider_turn_id, item_kind, payload_text,
      slack_channel_id, slack_thread_ts, client_msg_id, status, slack_message_ts,
      attempts, error, next_attempt_ms, created_at, updated_at${authorizingColumn}
    ) VALUES (
      'legacy-thread', 'request', 'turn-1', 'user', 'Request',
      'C_LEGACY', '1.1', 'client-request', 'delivered', 'slack-request',
      2, NULL, NULL, '2026-08-19 10:00:00', '2026-08-19 10:01:00'${authorizingValue}
    );
    INSERT INTO codex_remote_mirror_events (
      provider_thread_uuid, provider_item_id, provider_turn_id, item_kind, payload_text,
      slack_channel_id, slack_thread_ts, client_msg_id, status, slack_message_ts,
      attempts, error, next_attempt_ms, created_at, updated_at${authorizingColumn}
    ) VALUES (
      'legacy-thread', 'answer', 'turn-1', 'agent', 'Answer',
      'C_LEGACY', '1.1', 'client-answer', 'pending', NULL,
      1, 'retry later', 12345, '2026-08-19 10:02:00', '2026-08-19 10:03:00'${authorizingValue}
    );
  `);
  database.close();
  return stateDirectory;
}

describe("state schema migration", () => {
  for (const includeAuthorizingSession of [false, true]) {
    test(`adds the Codex Remote observation sequence without data loss${
      includeAuthorizingSession ? " and preserves authorization" : ""
    }`, () => {
      const stateDirectory = createLegacyDatabase(includeAuthorizingSession);

      importState(stateDirectory);
      importState(stateDirectory);

      const migrated = new Database(join(stateDirectory, "state.db"), { readonly: true });
      const tableColumns = migrated.query("PRAGMA table_info(codex_remote_mirror_events)").all() as Array<{
        name: string;
        pk: number;
      }>;
      expect(tableColumns.find((column) => column.name === "observation_sequence")).toMatchObject({ pk: 1 });
      expect(tableColumns.find((column) => column.name === "provider_thread_uuid")).toMatchObject({ pk: 0 });
      expect(migrated.query(`
        SELECT observation_sequence, provider_item_id, status, slack_message_ts, attempts,
               error, next_attempt_ms, authorizing_session_id
        FROM codex_remote_mirror_events
        ORDER BY observation_sequence
      `).all()).toEqual([
        {
          observation_sequence: 1,
          provider_item_id: "request",
          status: "delivered",
          slack_message_ts: "slack-request",
          attempts: 2,
          error: null,
          next_attempt_ms: null,
          authorizing_session_id: includeAuthorizingSession ? 42 : null,
        },
        {
          observation_sequence: 2,
          provider_item_id: "answer",
          status: "pending",
          slack_message_ts: null,
          attempts: 1,
          error: "retry later",
          next_attempt_ms: 12345,
          authorizing_session_id: includeAuthorizingSession ? 42 : null,
        },
      ]);
      expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
      migrated.close();
    });
  }

  test("rolls back without replacing the legacy table when copied data violates integrity", () => {
    const stateDirectory = createLegacyDatabase(true);
    const legacy = new Database(join(stateDirectory, "state.db"));
    legacy.exec("PRAGMA foreign_keys=OFF; UPDATE codex_remote_mirror_events SET authorizing_session_id=999");
    legacy.close();

    const result = runStateImport(stateDirectory);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("FOREIGN KEY constraint failed");

    const unchanged = new Database(join(stateDirectory, "state.db"), { readonly: true });
    const columns = unchanged.query("PRAGMA table_info(codex_remote_mirror_events)").all() as Array<{
      name: string;
    }>;
    expect(columns.some((column) => column.name === "observation_sequence")).toBeFalse();
    expect(unchanged.query("SELECT COUNT(*) AS count FROM codex_remote_mirror_events").get()).toEqual({ count: 2 });
    expect(unchanged.query(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type='table' AND name='codex_remote_mirror_events_with_sequence'
    `).get()).toBeNull();
    unchanged.close();
  });
});
