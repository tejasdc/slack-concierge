import { Database } from 'bun:sqlite';
import { chmodSync, closeSync, existsSync, fdatasyncSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, statfsSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ledgerWriteResults } from './ledger-write-results';

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
    for (const suffix of ['.verified.json', '-wal', '-shm', '-journal', ''])
      rmSync(join(folder, name + suffix), { force: true });
    removed++;
  }
  // Staging left by a publisher killed mid-copy (it can hold gigabytes) is superseded once a newer
  // verified copy exists, like an unverified copy. A newer one may belong to a running publisher.
  for (const name of readdirSync(folder)) {
    if (!name.endsWith('.publishing')) continue;
    const copy = name.slice(0, -'.publishing'.length);
    if (AUTOMATIC_COPY_NAME.test(copy) && newestVerified !== null && stamp(copy) < newestVerified)
      rmSync(join(folder, name), { recursive: true, force: true });
  }
  syncPath(folder);
  return removed;
}

/** Automatic pre-update copies: `.db` is a plain SQLite copy, `.db.zst` a compressed one. */
export const AUTOMATIC_COPY_NAME = /^state\.pre-deployment-repair\.\d+\.db(\.zst)?$/;
/** Created inside a compressed copy's staging folder once its ledger snapshot is pinned. */
export const PINNED_MARKER = 'pinned';

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

export function zstdCommand(): string {
  const found = Bun.which('zstd', { PATH: `${process.env.PATH ?? ''}:/usr/bin:/bin` });
  if (!found) throw new Error('The zstd command is required for a compressed ledger copy.');
  return found;
}

function fileState(path: string) {
  const stat = statSync(realpathSync(path));
  return { size: stat.size, modifiedNs: stat.mtimeMs, changedNs: stat.ctimeMs, inode: stat.ino, device: stat.dev };
}

/**
 * Writes the ledger's exact bytes as of the call, compressed, as a verified copy, without keeping
 * Concierge stopped while it streams. Call it with every other ledger writer stopped; once
 * `onPinned` has run, Concierge may start and write again.
 *
 * The pin: the log is checkpointed into the main file and emptied (TRUNCATE) while this process
 * holds the writer reservation, and a read transaction then starts on the empty log. SQLite gives
 * such a reader read-mark 0, and copying log pages into the main file needs that mark exclusively,
 * so until this reader ends every later commit stays in the log and the main file's bytes cannot
 * change (checked on this server 2026-11-18: 20,000 rows and an index written by another process,
 * its PASSIVE checkpoint copied nothing and TRUNCATE returned busy; the main file was byte-identical).
 * The main file is then the snapshot. The copy checks it (integrity and foreign keys, on the pinned
 * reader), streams it through zstd with no uncompressed file, and confirms the main file's size and
 * change times never moved, so a broken pin fails the copy instead of certifying a mixed file.
 *
 * Streamed in the stopped window, an 18.0 GB ledger kept Concierge stopped 76 s longer on
 * 2026-11-18 (237 MB/s), and that grows with the ledger. While pinned the owner's checkpoints wait
 * and its log grows by what it writes during the copy.
 * `freeFloorBytes`: the copy stops and is removed if the disk would fall below that much free.
 */
export async function publishCompressedLedgerCopy(sourcePath: string, destination: string, freeFloorBytes: number,
  onPinned: (reservation: string) => void = () => {}): Promise<{ bytes: number; sourceBytes: number; sha256: string }> {
  if (!destination.endsWith('.zst')) throw new Error('A compressed ledger copy is named .zst.');
  const folder = dirname(destination);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const reservation = `${destination}.publishing`;
  mkdirSync(reservation, { mode: 0o700 });
  const temporary = join(reservation, 'partial.db.zst');
  let writer: Database | null = null, reader: Database | null = null, input: number | null = null;
  let compressor: ReturnType<typeof Bun.spawn> | null = null;
  try {
    if (existsSync(destination) || existsSync(`${destination}.verified.json`))
      throw new Error('Refusing to replace an existing backup.');
    writer = ledgerWriteResults(new Database(sourcePath));
    const checkpoint = writer.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number };
    writer.exec('BEGIN IMMEDIATE');
    // SQLite keeps the log beside the real file, not beside the state directory's link to it.
    const wal = `${realpathSync(sourcePath)}-wal`;
    if (checkpoint.busy !== 0 || (existsSync(wal) && statSync(wal).size !== 0))
      throw new Error('The ledger could not be checkpointed into its main file; another connection holds it.');
    reader = new Database(sourcePath, { readonly: true });
    reader.exec('BEGIN');
    const pageSize = (reader.query('PRAGMA page_size').get() as { page_size: number }).page_size;
    const pageCount = (reader.query('PRAGMA page_count').get() as { page_count: number }).page_count;
    writer.exec('ROLLBACK');
    writer.close(); writer = null;
    const sourceBytes = pageSize * pageCount;
    const pinned = fileState(sourcePath);
    if (pinned.size !== sourceBytes)
      throw new Error(`Ledger file size ${pinned.size} is not its ${pageCount} pages of ${pageSize} bytes.`);
    onPinned(reservation);

    checkSqliteBackup(reader);
    const hash = new Bun.CryptoHasher('sha256');
    // Four threads, not every core: the copy now streams while Concierge serves (2026-11-18 live
    // rate 237 MB/s was the ledger filesystem's read, not compression).
    const running = Bun.spawn([zstdCommand(), '-3', '-T4', '-q', '-c'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    compressor = running;
    const output = openSync(temporary, 'wx', 0o600);
    let bytes = 0, unflushed = 0, stopped: Error | null = null;
    const flushAndCheckFloor = () => {
      fdatasyncSync(output); unflushed = 0;
      const disk = statfsSync(folder);
      if (Number(disk.bavail) * Number(disk.bsize) >= freeFloorBytes) return;
      stopped = new Error(`The compressed ledger copy stopped at ${(bytes / 1024 ** 3).toFixed(1)} GiB: the disk fell below its ${(freeFloorBytes / 1024 ** 3).toFixed(1)} GiB free margin.`);
      running.kill();
    };
    const drain = (async () => {
      for await (const chunk of running.stdout) {
        if (stopped) continue;
        try {
          writeSync(output, chunk);
          bytes += chunk.byteLength; unflushed += chunk.byteLength;
          if (unflushed >= COPY_FLUSH_BYTES) flushAndCheckFloor();
        } catch (error) {
          // A failed write (a full disk, an I/O error) must stop zstd too: left running, it would
          // block on its unread output and the read loop would wait on it forever with the pin held.
          stopped = new Error(`The compressed ledger copy could not be written: ${error instanceof Error ? error.message : String(error)}`);
          running.kill();
        }
      }
      if (!stopped) {
        try { flushAndCheckFloor(); } catch (error) {
          stopped = new Error(`The compressed ledger copy could not be written: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })();
    try {
      // Closing a descriptor on the ledger drops this process's POSIX locks on it, including the
      // pinned reader's, so it stays open until that reader has closed (finally, below).
      input = openSync(sourcePath, 'r');
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
    const after = fileState(sourcePath);
    if (after.size !== pinned.size || after.modifiedNs !== pinned.modifiedNs || after.changedNs !== pinned.changedNs
      || after.inode !== pinned.inode || after.device !== pinned.device)
      throw new Error('The ledger main file changed while it was being copied; the copy is not a snapshot.');
    const sha256 = hash.digest('hex');
    chmodSync(temporary, 0o400);
    syncPath(temporary);
    renameSync(temporary, destination);
    syncPath(folder);
    certify(destination, sourcePath, reservation, { format: 'zstd', sourceBytes, sha256 });
    return { bytes: statSync(destination).size, sourceBytes, sha256 };
  } finally {
    if (compressor && compressor.exitCode === null) { compressor.kill(); await compressor.exited; }
    if (writer) { try { writer.exec('ROLLBACK'); } catch {} writer.close(); }
    if (reader) { try { reader.exec('COMMIT'); } catch {} reader.close(); }
    if (input !== null) closeSync(input);
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
