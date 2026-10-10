#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from 'node:child_process';
import { ledgerWriteResults } from "../src/ledger-write-results";

const stateDirectory = process.env.CONCIERGE_STATE_DIR;
if (!stateDirectory) throw new Error("CONCIERGE_STATE_DIR is required.");
const statePath = join(stateDirectory, "state.db");
if (!existsSync(statePath)) throw new Error(`Concierge state database does not exist: ${statePath}`);
const backupOnly = process.argv.includes('--backup-only');
const schemaOnly = process.argv.includes('--schema-only');
if (backupOnly && schemaOnly) throw new Error('Choose backup-only or schema-only, never both.');
const backupArgument = process.argv.indexOf('--backup-path');
const backupPath = (backupArgument >= 0 ? process.argv[backupArgument + 1] : undefined)
  || process.env.CONCIERGE_DEPLOYMENT_MIGRATION_BACKUP
  || join(stateDirectory, "backups", `state.pre-deployment-repair.${Date.now()}.db`);
mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });

/**
 * Every deployment writes a full copy of the ledger (1.4 GB on 2026-10-07) and nothing removed
 * them: 278 copies, 151 GB, filled the disk that evening and Concierge and the capture service
 * could not start. After a migration that succeeded, only the newest copies are kept. Hand-made
 * backups in the same folder have other names and are never touched. Twenty copies (38 GB at
 * 1.9 GB each) still left the 436 GB disk at 17 GB free on 2026-10-09, and that evening the hourly
 * Thinkering backup's 21 GB temporary snapshot filled it and every write failed. Eight copies keep a
 * day of rollbacks at the usual pace of releases for 15 GB.
 */
const AUTOMATIC_COPIES_KEPT = 8;
function pruneAutomaticCopies(): number {
  if (process.env.CONCIERGE_DEPLOYMENT_MIGRATION_BACKUP) return 0;
  const folder = dirname(backupPath);
  const copies = readdirSync(folder).filter(name => /^state\.pre-deployment-repair\.\d+\.db$/.test(name))
    .sort((a, b) => Number(b.split(".")[2]) - Number(a.split(".")[2]));
  for (const name of copies.slice(AUTOMATIC_COPIES_KEPT))
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(folder, name + suffix), { force: true });
  return Math.max(0, copies.length - AUTOMATIC_COPIES_KEPT);
}

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

if (!backupOnly) {
  // An admission drain preserves agent hosts; it does not stop the serving owner's writes.
  // Schema work requires the coordinator fully stopped, including its prestart recovery.
  const service = process.env.CONCIERGE_SERVICE || 'concierge-bot.service';
  const status = spawnSync('systemctl', ['show', service, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'MainPID', '-p', 'ControlPID'], { encoding: 'utf8' });
  const values = Object.fromEntries(status.stdout.trim().split('\n').map(line => line.split('=')));
  if (status.status !== 0 || values.LoadState !== 'loaded' || !['inactive', 'failed'].includes(values.ActiveState)
    || values.MainPID !== '0' || values.ControlPID !== '0')
    throw new Error(`Schema migration requires ${service} fully stopped; observed ${JSON.stringify(values)}.`);
}

if (!schemaOnly) {
  // The live backup is a read-only snapshot; it does not reserve the service's writer.
  const source = new Database(statePath, { readonly: true });
  try {
    source.exec('PRAGMA busy_timeout=5000');
    checks(source);
    source.exec(`VACUUM INTO ${quotedSqlPath(backupPath)}`);
  } finally { source.close(); }
  const backup = new Database(backupPath, { readonly: true });
  try { checks(backup); } finally { backup.close(); }
} else if (!existsSync(backupPath)) throw new Error(`Verified migration backup is missing: ${backupPath}`);

if (backupOnly) {
  console.log(JSON.stringify({ status: 'backed_up', backup_path: backupPath }));
  process.exit(0);
}

const { db: migrationDatabase } = await import("../src/state-database");
try {
  // Reserve the writer before either schema owner loads. Importing state first and
  // beginning here left a lock hand-off where the live service could win the writer,
  // making this deployment-owned migration fail after its idle gate was claimed.
  migrationDatabase.exec("BEGIN IMMEDIATE");
  await import("../src/state");
  await import("../src/deployment-state");
  if (process.argv.includes("--force-failure")) throw new Error("forced deployment repair migration failure");
  migrationDatabase.exec("COMMIT");
} catch (error) {
  try { migrationDatabase.exec("ROLLBACK"); } catch {}
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

// The whole-ledger integrity and foreign-key checks run after COMMIT, on a read transaction. Run
// inside the writer reservation they held the live service's writer for 32 s at 18:28 on
// 2026-10-09 (1.9 GB ledger): every owner write, heartbeats included, waited out its busy timeout
// and failed. The schema change is additive, the same checks already passed on the source before
// the backup, and a failure here stops the deployment with that backup named.
try {
  checks(migrationDatabase);
} catch (error) {
  console.error(JSON.stringify({ status: "migrated_check_failed", backup_path: backupPath,
    error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
}
console.log(JSON.stringify({ status: "migrated", backup_path: backupPath, pruned: pruneAutomaticCopies() }));
migrationDatabase.close();
