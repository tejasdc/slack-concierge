import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

export interface ManagedProjectRow {
  slack_channel_id: string | null;
  slack_channel_name: string;
  vault_path: string;
  code_path: string;
}

interface ProjectMapping {
  slack_channel_name: string;
  group_name: string | null;
  name: string | null;
  code_path: string;
  vault_path: string;
}

export function replaceManagedProjectMapping(input: {
  stateDbPath: string;
  channelId: string;
  expected: ProjectMapping;
  replacement: ProjectMapping;
}) {
  if (!existsSync(input.stateDbPath)) throw new Error(`Concierge registry does not exist: ${input.stateDbPath}`);
  const database = new Database(input.stateDbPath, { strict: true });
  try {
    const before = input.expected;
    const after = input.replacement;
    const result = database.query(`
      UPDATE channels
      SET slack_channel_name=?, group_name=?, name=?, code_path=?, vault_path=?
      WHERE slack_channel_id=? AND slack_channel_name=? AND group_name IS ?
        AND name IS ? AND code_path=? AND vault_path=?
        AND NOT EXISTS (
          SELECT 1 FROM channels AS other
          WHERE other.rowid != channels.rowid
            AND (other.code_path IN (?, ?) OR other.vault_path IN (?, ?))
        )
    `).run(
      after.slack_channel_name, after.group_name, after.name, after.code_path, after.vault_path,
      input.channelId, before.slack_channel_name, before.group_name, before.name, before.code_path, before.vault_path,
      after.code_path, after.vault_path, after.code_path, after.vault_path,
    );
    if (result.changes !== 1) throw new Error("Project mapping changed or destination is already registered.");
  } finally {
    database.close();
  }
}

export function readManagedProjects(stateDbPath: string): ManagedProjectRow[] {
  if (!existsSync(stateDbPath)) throw new Error(`Concierge registry does not exist: ${stateDbPath}`);
  const database = new Database(stateDbPath, { readonly: true, strict: true });
  try {
    return database.query(`
      SELECT slack_channel_id, slack_channel_name, vault_path, code_path
      FROM channels
      WHERE code_path IS NOT NULL
      ORDER BY slack_channel_name, code_path
    `).all() as ManagedProjectRow[];
  } finally {
    database.close();
  }
}

export function registerAdoptedProject(input: {
  stateDbPath: string;
  projectName: string;
  vaultPath: string;
  codePath: string;
  group: string | null;
  name: string;
}) {
  mkdirSync(dirname(input.stateDbPath), { recursive: true });
  const database = new Database(input.stateDbPath, { create: true, strict: true });
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        slack_channel_id TEXT PRIMARY KEY,
        slack_channel_name TEXT NOT NULL,
        vault_path TEXT NOT NULL,
        code_path TEXT,
        additional_paths TEXT DEFAULT '[]',
        provider_default TEXT NOT NULL DEFAULT 'codex',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        group_name TEXT,
        name TEXT,
        mode TEXT NOT NULL DEFAULT 'agent-auto',
        bot_user_id TEXT,
        canvas_id TEXT,
        list_id TEXT,
        list_title_column_id TEXT,
        list_completed_column_id TEXT
      );
    `);
    database.transaction(() => {
      database.query(`
        INSERT INTO channels (
          slack_channel_id, slack_channel_name, vault_path, code_path,
          additional_paths, provider_default, group_name, name, mode
        )
        SELECT NULL, ?, ?, ?, '[]', 'codex', ?, ?, 'agent-auto'
        WHERE NOT EXISTS (SELECT 1 FROM channels WHERE code_path = ?)
      `).run(
        input.projectName,
        input.vaultPath,
        input.codePath,
        input.group,
        input.name,
        input.codePath,
      );
      database.query(`
        UPDATE channels
        SET vault_path=?, group_name=?, name=?
        WHERE code_path=?
      `).run(input.vaultPath, input.group, input.name, input.codePath);
    })();
  } finally {
    database.close();
  }
}
