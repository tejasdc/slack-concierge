import { Database } from 'bun:sqlite';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function checkSqliteBackup(database: Database): void {
  const integrity = database.query('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok')
    throw new Error(`SQLite integrity_check failed: ${JSON.stringify(integrity)}`);
  const foreignKeys = database.query('PRAGMA foreign_key_check').all();
  if (foreignKeys.length) throw new Error(`SQLite foreign_key_check failed: ${JSON.stringify(foreignKeys)}`);
}

function syncPath(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function identity(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Backup must be a regular file.');
  return { device: stat.dev, inode: stat.ino, bytes: stat.size, modified: stat.mtimeMs };
}

/** A certificate is written only after verification and durable publication. A crash between
 * the two leaves an uncounted complete copy; it can never evict a verified recovery copy. */
function certify(path: string, source: string, staging: string): void {
  const receipt = { version: 1, integrity: 'ok', foreignKeys: 'ok', source,
    verifiedAt: new Date().toISOString(), ...identity(path) };
  const temporary = join(staging, 'verified.json');
  writeFileSync(temporary, JSON.stringify(receipt) + '\n', { mode: 0o600, flag: 'wx' });
  syncPath(temporary);
  renameSync(temporary, `${path}.verified.json`);
  syncPath(dirname(path));
}

export function isVerifiedBackup(path: string): boolean {
  try {
    const proof = JSON.parse(readFileSync(`${path}.verified.json`, 'utf8'));
    const file = identity(path);
    return proof.version === 1 && proof.integrity === 'ok' && proof.foreignKeys === 'ok'
      && Object.entries(file).every(([key, value]) => proof[key] === value)
      && !existsSync(`${path}-wal`) && !existsSync(`${path}-journal`);
  } catch { return false; }
}

/** The deployment owner is the sole publisher. Never expose VACUUM's unfinished output under
 * the rollback filename, and never prune anything to make room before this copy succeeds. */
export function publishSqliteBackup(sourcePath: string, destination: string): void {
  const folder = dirname(destination);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const reservation = `${destination}.publishing`;
  mkdirSync(reservation, { mode: 0o700 });
  const temporary = join(reservation, 'partial.db');
  try {
    if (existsSync(destination) || existsSync(`${destination}.verified.json`))
      throw new Error('Refusing to replace an existing backup.');
    const source = new Database(sourcePath, { readonly: true });
    try {
      source.exec('PRAGMA busy_timeout=5000');
      source.exec(`VACUUM INTO '${temporary.replaceAll("'", "''")}'`);
    } finally { source.close(); }
    const backup = new Database(temporary, { readonly: true });
    try { checkSqliteBackup(backup); } finally { backup.close(); }
    chmodSync(temporary, 0o400);
    syncPath(temporary);
    renameSync(temporary, destination);
    syncPath(folder);
    certify(destination, sourcePath, reservation);
  } finally { rmSync(reservation, { recursive: true, force: true }); }
}

/** An older installed controller can hand the new candidate an unmarked backup. Verify that
 * exact offline file before use; merely existing is not migration protection. */
export function verifyMigrationBackup(path: string): void {
  if (isVerifiedBackup(path)) return;
  identity(path);
  const staging = mkdtempSync(join(dirname(path), `.${basename(path)}-verify-`));
  try {
    const database = new Database(path, { readonly: true });
    try { checkSqliteBackup(database); } finally { database.close(); }
    if (existsSync(`${path}-wal`) || existsSync(`${path}-journal`))
      throw new Error('Migration backup must be a closed standalone database.');
    syncPath(path);
    certify(path, 'legacy-controller-backup', staging);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

/**
 * Retention for automatic pre-update copies: the newest `keep` verified copies, and only as many
 * of those as fit in `maxBytes` (the newest one always stays). Counting only verified copies kept
 * an unverified file from evicting a proven one, but it also meant nothing ever removed copies made
 * before certificates existed: seven 2.4 GB copies from 2026-10-10 sat uncounted beside six
 * certified ones and took the root disk under its 50 GB floor on 2026-10-12. An unverified copy is
 * now removed once a newer verified copy exists (it can never be a rollback source and is
 * superseded); one newer than every verified copy, or still being published, is left alone.
 */
export function pruneVerifiedBackups(folder: string, keep: number, maxBytes = Number.POSITIVE_INFINITY): number {
  if (!Number.isSafeInteger(keep) || keep < 1) throw new Error('At least one verified backup must be kept.');
  const stamp = (name: string) => Number(name.split('.')[2]);
  const automatic = readdirSync(folder).filter(name => /^state\.pre-deployment-repair\.\d+\.db$/.test(name))
    .sort((a, b) => stamp(b) - stamp(a));
  const verified = automatic.filter(name => isVerifiedBackup(join(folder, name)));
  let removed = 0, bytes = 0, kept = 0, full = false;
  for (const name of verified) {
    const size = lstatSync(join(folder, name)).size;
    if (!full && kept < keep && (kept === 0 || bytes + size <= maxBytes)) { kept++; bytes += size; continue; }
    full = true;
    // Remove its qualification before its bytes. An interrupted prune cannot count a missing file.
    rmSync(join(folder, `${name}.verified.json`));
    rmSync(join(folder, name));
    removed++;
  }
  const newestVerified = verified.length ? stamp(verified[0]!) : null;
  for (const name of automatic) {
    if (verified.includes(name) || newestVerified === null || stamp(name) >= newestVerified) continue;
    if (existsSync(join(folder, `${name}.publishing`))) continue;
    for (const suffix of ['.verified.json', '-wal', '-shm', '-journal', ''])
      rmSync(join(folder, name + suffix), { force: true });
    removed++;
  }
  syncPath(folder);
  return removed;
}
