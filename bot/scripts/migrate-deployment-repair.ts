#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const stateDirectory = process.env.CONCIERGE_STATE_DIR;
if (!stateDirectory) throw new Error("CONCIERGE_STATE_DIR is required.");
const statePath = join(stateDirectory, "state.db");
if (!existsSync(statePath)) throw new Error(`Concierge state database does not exist: ${statePath}`);
const backupPath = process.env.CONCIERGE_DEPLOYMENT_MIGRATION_BACKUP
  || join(stateDirectory, "backups", `state.pre-deployment-repair.${Date.now()}.db`);
mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });

function quotedSqlPath(path: string) {
  return `'${path.replaceAll("'", "''")}'`;
}

function checks(database: Database) {
  const integrity = database.query("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
  const foreignKeys = database.query("PRAGMA foreign_key_check").all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error(`SQLite integrity_check failed: ${JSON.stringify(integrity)}`);
  }
  if (foreignKeys.length !== 0) {
    throw new Error(`SQLite foreign_key_check failed: ${JSON.stringify(foreignKeys)}`);
  }
}

const source = new Database(statePath);
source.exec("PRAGMA busy_timeout=5000; PRAGMA wal_checkpoint(FULL)");
checks(source);
source.exec(`VACUUM INTO ${quotedSqlPath(backupPath)}`);
source.close();

let migrationDatabase: Database | null = null;
try {
  migrationDatabase = (await import("../src/state")).db;
  migrationDatabase.exec("BEGIN IMMEDIATE");
  await import("../src/deployment-state");
  if (process.argv.includes("--force-failure")) throw new Error("forced deployment repair migration failure");
  checks(migrationDatabase);
  migrationDatabase.exec("COMMIT");
  console.log(JSON.stringify({ status: "migrated", backup_path: backupPath }));
} catch (error) {
  try { migrationDatabase?.exec("ROLLBACK"); } catch {}
  const restored = new Database(statePath, { readonly: true });
  checks(restored);
  restored.close();
  console.error(JSON.stringify({
    status: "rolled_back",
    backup_path: backupPath,
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exit(1);
}
