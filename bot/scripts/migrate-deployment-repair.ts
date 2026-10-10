#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from 'node:child_process';
import { checkSqliteBackup as checks, publishSqliteBackup, pruneVerifiedBackups, verifyMigrationBackup } from '../src/verified-sqlite-backup';

/**
 * The schema this release's code builds, read from a database it creates from nothing. Run in a
 * child whose state directory is a scratch folder, because opening the ledger module binds to the
 * state directory at import. Tables are described by their columns (an added column changes a
 * table's stored SQL text differently on a fresh build and on an upgraded ledger); indexes,
 * triggers and views by their SQL.
 */
type SchemaShape = { tables: Record<string, string[]>; objects: Record<string, string> };
function schemaShape(database: Database): SchemaShape {
  const rows = database.query("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all() as { type: string; name: string; sql: string }[];
  const tables: Record<string, string[]> = {}, objects: Record<string, string> = {};
  for (const row of rows) {
    if (row.type === "table") tables[row.name] = (database.query("SELECT name FROM pragma_table_info(?)").all(row.name) as { name: string }[]).map(column => column.name).sort();
    else objects[`${row.type}:${row.name}`] = row.sql.replace(/\s+/g, " ").trim();
  }
  return { tables, objects };
}
if (process.argv.includes("--empty-schema")) {
  const scratchDirectory = process.env.CONCIERGE_STATE_DIR;
  if (!scratchDirectory || !realpathSync(scratchDirectory).startsWith(`${realpathSync(tmpdir())}/concierge-schema-plan-`))
    throw new Error('Schema rehearsal requires its private temporary state directory.');
  const { db: scratch } = await import("../src/state-database");
  await import("../src/state");
  await import("../src/deployment-state");
  console.log(JSON.stringify(schemaShape(scratch as unknown as Database)));
  process.exit(0);
}

const stateDirectory = process.env.CONCIERGE_STATE_DIR;
if (!stateDirectory) throw new Error("CONCIERGE_STATE_DIR is required.");
const statePath = join(stateDirectory, "state.db");
if (!existsSync(statePath)) throw new Error(`Concierge state database does not exist: ${statePath}`);
const backupOnly = process.argv.includes('--backup-only');
const backupIfNeeded = process.argv.includes('--backup-if-needed');
const schemaOnly = process.argv.includes('--schema-only');
if ([backupOnly, backupIfNeeded, schemaOnly].filter(Boolean).length > 1) throw new Error('Choose one of backup-only, backup-if-needed or schema-only.');
const backupArgument = process.argv.indexOf('--backup-path');
const namedBackup = (backupArgument >= 0 ? process.argv[backupArgument + 1] : undefined) || process.env.CONCIERGE_DEPLOYMENT_MIGRATION_BACKUP || '';
const backupPath = namedBackup || join(stateDirectory, "backups", `state.pre-deployment-repair.${Date.now()}.db`);
mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });

/**
 * What this release's schema step would add to the live ledger: missing tables, columns, indexes,
 * triggers or views, or one whose SQL differs. Nothing means the step only re-runs what every
 * Concierge start already runs, so a full copy of the ledger protects nothing. Copying 2.3 GB on
 * every update anyway filled the disk to 99% on 2026-10-10 (ten copies in 90 minutes) and added
 * gigabytes of writes an hour on the disk that stalls the owner.
 */
function schemaChanges(): string[] {
  const scratch = mkdtempSync(join(tmpdir(), "concierge-schema-plan-"));
  try {
    const { CONCIERGE_DEPLOYMENT_MIGRATION_BACKUP: _drop, ...environment } = process.env;
    const child = spawnSync(process.execPath, [Bun.main, "--empty-schema"], {
      encoding: "utf8", timeout: 120_000, env: { ...environment, CONCIERGE_STATE_DIR: scratch } });
    if (child.status !== 0) throw new Error(`The release's schema could not be built for comparison: ${(child.stderr || String(child.error ?? "")).slice(-1500)}`);
    const wanted = JSON.parse(child.stdout.trim().split("\n").at(-1)!) as SchemaShape;
    const live = new Database(statePath, { readonly: true });
    let have: SchemaShape;
    try { live.exec("PRAGMA busy_timeout=5000"); have = schemaShape(live); } finally { live.close(); }
    const changes: string[] = [];
    for (const [table, columns] of Object.entries(wanted.tables)) {
      const present = have.tables[table];
      if (!present) { changes.push(`table ${table}`); continue; }
      for (const column of columns) if (!present.includes(column)) changes.push(`column ${table}.${column}`);
    }
    for (const [key, sql] of Object.entries(wanted.objects)) if (have.objects[key] !== sql) changes.push(key);
    return changes;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

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
// Failed or legacy unverified names cannot evict a proven recovery copy. Prune only after
// the replacement is verified and durably published, including when later release checks fail.
function pruneAutomaticCopies(keep = AUTOMATIC_COPIES_KEPT): number {
  if (process.env.CONCIERGE_DEPLOYMENT_MIGRATION_BACKUP) return 0;
  return pruneVerifiedBackups(dirname(backupPath), keep);
}

if (!backupOnly && !backupIfNeeded && !process.argv.includes('--plan')) {
  // An admission drain preserves agent hosts; it does not stop the serving owner's writes.
  // Schema work requires the coordinator fully stopped, including its prestart recovery.
  const service = process.env.CONCIERGE_SERVICE || 'concierge-bot.service';
  const status = spawnSync('systemctl', ['show', service, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'MainPID', '-p', 'ControlPID'], { encoding: 'utf8' });
  const values = Object.fromEntries(status.stdout.trim().split('\n').map(line => line.split('=')));
  if (status.status !== 0 || values.LoadState !== 'loaded' || !['inactive', 'failed'].includes(values.ActiveState)
    || values.MainPID !== '0' || values.ControlPID !== '0')
    throw new Error(`Schema migration requires ${service} fully stopped; observed ${JSON.stringify(values)}.`);
}

function backUp() {
  publishSqliteBackup(statePath, backupPath);
  pruneAutomaticCopies();
}

if (process.argv.includes('--plan')) {
  // Read-only: what this release's schema step would add to the live ledger.
  console.log(JSON.stringify({ status: 'planned', changes: schemaChanges() }));
  process.exit(0);
}
if (backupIfNeeded) {
  // Run from the release being installed, before the coordinator stops: its own code says what its
  // schema step would add, and only then is the ledger copied.
  const changes = schemaChanges();
  if (changes.length) backUp();
  console.log(JSON.stringify(changes.length ? { status: 'backed_up', backup_path: backupPath, changes }
    : { status: 'no_schema_change', backup_path: null, changes }));
  process.exit(0);
}
if (schemaOnly && !namedBackup) {
  // No copy was taken because the release would change nothing. Confirm that with the coordinator
  // stopped; if it no longer holds, copy now rather than change the schema without one.
  const changes = schemaChanges();
  if (!changes.length) {
    console.log(JSON.stringify({ status: 'unchanged', backup_path: null }));
    process.exit(0);
  }
  backUp();
} else if (!schemaOnly) backUp();
else verifyMigrationBackup(backupPath);

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
// and failed. The schema change is additive, the same checks already passed on the completed
// backup, and a failure here stops the deployment with that backup named.
try {
  checks(migrationDatabase);
} catch (error) {
  console.error(JSON.stringify({ status: "migrated_check_failed", backup_path: backupPath,
    error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
}
console.log(JSON.stringify({ status: "migrated", backup_path: backupPath, pruned: pruneAutomaticCopies() }));
migrationDatabase.close();
