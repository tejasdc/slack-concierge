import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

export interface ManagedProjectRow {
  slack_channel_id: string | null;
  slack_channel_name: string;
  vault_path: string;
  code_path: string;
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
