import { Database } from 'bun:sqlite';
import { chmodSync, closeSync, existsSync, fdatasyncSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, statfsSync, writeFileSync, writeSync } from 'node:fs';
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
function certify(path: string, source: string, staging: string, extra: Record<string, unknown> = {}): void {
  const receipt = { version: 1, integrity: 'ok', foreignKeys: 'ok', source,
    verifiedAt: new Date().toISOString(), ...extra, ...identity(path) };
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
  const automatic = readdirSync(folder).filter(name => AUTOMATIC_COPY_NAME.test(name))
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
    for (const suffix of ['.verified.json', LEDGER_CHECK_SUFFIX, '-wal', '-shm', '-journal', ''])
      rmSync(join(folder, name + suffix), { force: true });
    removed++;
  }
  // A ledger check whose copy was never written (the update failed before its stopped window)
  // is superseded once a newer verified copy exists, like an unverified copy.
  for (const name of readdirSync(folder)) {
    if (!name.endsWith(LEDGER_CHECK_SUFFIX)) continue;
    const copy = name.slice(0, -LEDGER_CHECK_SUFFIX.length);
    if (!AUTOMATIC_COPY_NAME.test(copy) || existsSync(join(folder, copy)) || existsSync(join(folder, `${copy}.publishing`))) continue;
    if (newestVerified === null || stamp(copy) >= newestVerified) continue;
    rmSync(join(folder, name), { force: true });
  }
  syncPath(folder);
  return removed;
}

/** Automatic pre-update copies: `.db` is a plain SQLite copy, `.db.zst` a compressed one. */
export const AUTOMATIC_COPY_NAME = /^state\.pre-deployment-repair\.\d+\.db(\.zst)?$/;
/** Beside a planned compressed copy: the whole-ledger check made while Concierge was still serving. */
export const LEDGER_CHECK_SUFFIX = '.ledger-check.json';

export type LedgerCheck = { integrity: 'ok'; foreignKeys: 'ok'; checkedAt: string; device: number; inode: number };

function ledgerFileIdentity(path: string) {
  const stat = statSync(realpathSync(path));
  return { device: stat.dev, inode: stat.ino };
}

/**
 * The whole-ledger integrity and foreign-key check, run on the ledger itself through a read-only
 * connection. A compressed copy is the ledger's own bytes, so this check is what proves the copy
 * is a sound database. It runs while Concierge is still serving: on the stopped ledger it took
 * about two minutes at 8.4 GB (2026-11-04), longer than an agent's command waits.
 */
export function checkLedgerInPlace(path: string): LedgerCheck {
  const database = new Database(path, { readonly: true });
  try {
    database.exec('PRAGMA busy_timeout=5000');
    checkSqliteBackup(database);
  } finally { database.close(); }
  return { integrity: 'ok', foreignKeys: 'ok', checkedAt: new Date().toISOString(), ...ledgerFileIdentity(path) };
}

export function recordLedgerCheck(copyPath: string, check: LedgerCheck): void {
  const temporary = `${copyPath}${LEDGER_CHECK_SUFFIX}.partial`;
  writeFileSync(temporary, JSON.stringify(check) + '\n', { mode: 0o600 });
  syncPath(temporary);
  renameSync(temporary, `${copyPath}${LEDGER_CHECK_SUFFIX}`);
  syncPath(dirname(copyPath));
}

/** The serving-time check recorded for this planned copy, when it checked this same ledger file. */
export function recordedLedgerCheck(copyPath: string, ledgerPath: string): LedgerCheck | null {
  try {
    const check = JSON.parse(readFileSync(`${copyPath}${LEDGER_CHECK_SUFFIX}`, 'utf8')) as LedgerCheck;
    const file = ledgerFileIdentity(ledgerPath);
    return check.integrity === 'ok' && check.foreignKeys === 'ok' && check.device === file.device && check.inode === file.inode
      ? check : null;
  } catch { return null; }
}

/** Compressed size over ledger size for the newest verified compressed copy, or null. */
export function lastCompressionRatio(folder: string): number | null {
  const stamp = (name: string) => Number(name.split('.')[2]);
  for (const name of readdirSync(folder).filter(name => AUTOMATIC_COPY_NAME.test(name) && name.endsWith('.zst'))
    .sort((a, b) => stamp(b) - stamp(a))) {
    if (!isVerifiedBackup(join(folder, name))) continue;
    try {
      const proof = JSON.parse(readFileSync(join(folder, `${name}.verified.json`), 'utf8'));
      if (proof.sourceBytes > 0 && proof.bytes > 0) return proof.bytes / proof.sourceBytes;
    } catch {}
  }
  return null;
}

const COPY_CHUNK_BYTES = 8 * 1024 * 1024;
// Written through to disk in pieces, so no multi-gigabyte dirty backlog holds every other fsync on
// the root filesystem (2026-10-23: a 5.4 GB buffered ledger copy held the owner for 31 seconds).
const COPY_FLUSH_BYTES = 32 * 1024 * 1024;

function zstdCommand(): string {
  const found = Bun.which('zstd', { PATH: `${process.env.PATH ?? ''}:/usr/bin:/bin` });
  if (!found) throw new Error('The zstd command is required for a compressed ledger copy.');
  return found;
}

/**
 * Writes the stopped ledger's exact bytes, compressed, as a verified copy. Nothing uncompressed is
 * written: the ledger is checkpointed into its main file and that file is streamed through zstd, so
 * the copy needs only its compressed size on disk and stops growing one-for-one with the ledger
 * (17.7 GB on 2026-11-18, when a full-size copy plus its margin no longer fit the root disk). The
 * writer reservation is held for the whole read, so no commit can land mid-copy.
 * `freeFloorBytes`: the copy stops and is removed if the disk would fall below that much free.
 * The certificate records the SHA-256 of the ledger bytes; `restoreCompressedCopy` proves it.
 */
export async function publishCompressedLedgerCopy(sourcePath: string, destination: string, check: LedgerCheck,
  freeFloorBytes: number): Promise<{ bytes: number; sourceBytes: number; sha256: string }> {
  if (!destination.endsWith('.zst')) throw new Error('A compressed ledger copy is named .zst.');
  const folder = dirname(destination);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const reservation = `${destination}.publishing`;
  mkdirSync(reservation, { mode: 0o700 });
  const temporary = join(reservation, 'partial.db.zst');
  let database: Database | null = null;
  let compressor: ReturnType<typeof Bun.spawn> | null = null;
  try {
    if (existsSync(destination) || existsSync(`${destination}.verified.json`))
      throw new Error('Refusing to replace an existing backup.');
    const file = ledgerFileIdentity(sourcePath);
    if (file.device !== check.device || file.inode !== check.inode)
      throw new Error('The ledger check was made on a different file than the one being copied.');
    database = new Database(sourcePath);
    database.exec('PRAGMA busy_timeout=5000');
    const checkpoint = database.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number };
    database.exec('BEGIN IMMEDIATE');
    const wal = `${sourcePath}-wal`;
    if (checkpoint.busy !== 0 || (existsSync(wal) && statSync(wal).size !== 0))
      throw new Error('The ledger could not be checkpointed into its main file; another connection holds it.');
    const pageSize = (database.query('PRAGMA page_size').get() as { page_size: number }).page_size;
    const pageCount = (database.query('PRAGMA page_count').get() as { page_count: number }).page_count;
    const sourceBytes = pageSize * pageCount;
    if (statSync(sourcePath).size !== sourceBytes)
      throw new Error(`Ledger file size ${statSync(sourcePath).size} is not its ${pageCount} pages of ${pageSize} bytes.`);

    const hash = new Bun.CryptoHasher('sha256');
    const running = Bun.spawn([zstdCommand(), '-3', '-T0', '-q', '-c'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    compressor = running;
    const output = openSync(temporary, 'wx', 0o600);
    let bytes = 0, unflushed = 0, stopped: Error | null = null;
    const flushAndCheckFloor = () => {
      fdatasyncSync(output); unflushed = 0;
      const disk = statfsSync(folder);
      if (Number(disk.bavail) * Number(disk.bsize) >= freeFloorBytes) return;
      stopped = new Error(`The compressed ledger copy stopped at ${(bytes / 1024 ** 3).toFixed(1)} GiB: the disk fell below its ${(freeFloorBytes / 1024 ** 3).toFixed(1)} GiB free margin. Free space, then deploy again.`);
      running.kill();
    };
    const drain = (async () => {
      for await (const chunk of running.stdout) {
        if (stopped) continue;
        writeSync(output, chunk);
        bytes += chunk.byteLength; unflushed += chunk.byteLength;
        if (unflushed >= COPY_FLUSH_BYTES) flushAndCheckFloor();
      }
      if (!stopped) flushAndCheckFloor();
    })();
    try {
      const input = openSync(sourcePath, 'r');
      try {
        const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
        for (let offset = 0; offset < sourceBytes && !stopped;) {
          const read = readSync(input, buffer, 0, Math.min(buffer.length, sourceBytes - offset), offset);
          if (read <= 0) throw new Error('The ledger ended before its recorded page count.');
          const piece = buffer.subarray(0, read);
          hash.update(piece);
          running.stdin.write(piece);
          await running.stdin.flush();
          offset += read;
        }
      } finally { closeSync(input); }
      if (!stopped) await running.stdin.end();
      const exitCode = await running.exited;
      await drain;
      fsyncSync(output);
      if (stopped) throw stopped;
      if (exitCode !== 0) throw new Error(`zstd failed: ${(await new Response(running.stderr).text()).slice(-500)}`);
    } catch (error) {
      if (stopped) throw stopped;
      throw error;
    } finally { closeSync(output); }
    database.exec('ROLLBACK');
    database.close(); database = null;
    const sha256 = hash.digest('hex');
    chmodSync(temporary, 0o400);
    syncPath(temporary);
    renameSync(temporary, destination);
    syncPath(folder);
    certify(destination, sourcePath, reservation, { format: 'zstd', sourceBytes, sha256, ledgerCheckedAt: check.checkedAt });
    rmSync(`${destination}${LEDGER_CHECK_SUFFIX}`, { force: true });
    syncPath(folder);
    return { bytes: statSync(destination).size, sourceBytes, sha256 };
  } finally {
    if (compressor && compressor.exitCode === null) { compressor.kill(); await compressor.exited; }
    if (database) { try { database.exec('ROLLBACK'); } catch {} database.close(); }
    rmSync(reservation, { recursive: true, force: true });
  }
}

/**
 * Restores a verified compressed copy to a new file, never over an existing one: decompresses it,
 * proves the bytes are the ledger's recorded SHA-256, then re-runs the integrity and foreign-key
 * checks on the result. The operator swaps it in with Concierge stopped, as with a plain copy.
 */
export async function restoreCompressedCopy(copy: string, target: string): Promise<{ sha256: string; bytes: number }> {
  if (!isVerifiedBackup(copy)) throw new Error('Only a verified compressed copy can be restored.');
  const proof = JSON.parse(readFileSync(`${copy}.verified.json`, 'utf8'));
  if (proof.format !== 'zstd' || !/^[0-9a-f]{64}$/.test(proof.sha256 ?? '')) throw new Error('The copy is not a compressed ledger copy.');
  if (existsSync(target)) throw new Error('Refusing to restore over an existing file.');
  const partial = `${target}.restoring`;
  const decompressor = Bun.spawn([zstdCommand(), '-d', '-q', '-c', copy], { stdout: 'pipe', stderr: 'pipe' });
  const hash = new Bun.CryptoHasher('sha256');
  let bytes = 0, unflushed = 0;
  try {
    const output = openSync(partial, 'wx', 0o600);
    try {
      for await (const chunk of decompressor.stdout) {
        hash.update(chunk); writeSync(output, chunk);
        bytes += chunk.byteLength; unflushed += chunk.byteLength;
        if (unflushed >= COPY_FLUSH_BYTES) { fdatasyncSync(output); unflushed = 0; }
      }
      fsyncSync(output);
    } finally { closeSync(output); }
    if (await decompressor.exited !== 0) throw new Error(`zstd failed: ${(await new Response(decompressor.stderr).text()).slice(-500)}`);
    const sha256 = hash.digest('hex');
    if (sha256 !== proof.sha256 || bytes !== proof.sourceBytes) throw new Error('The restored bytes do not match the copied ledger.');
    const restored = new Database(partial, { readonly: true });
    try { checkSqliteBackup(restored); } finally { restored.close(); }
    // The ledger is a write-ahead-log database, so the check's read made an empty log and index
    // beside the file; they must not travel under the old name.
    if (existsSync(`${partial}-wal`) && statSync(`${partial}-wal`).size !== 0) throw new Error('The restore check wrote to the restored copy.');
    rmSync(`${partial}-wal`, { force: true }); rmSync(`${partial}-shm`, { force: true });
    renameSync(partial, target);
    syncPath(dirname(target));
    return { sha256, bytes };
  } catch (error) { rmSync(partial, { force: true }); throw error; }
}
