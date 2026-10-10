// Moves Concierge's ledger onto its own filesystem, once, while the update runner holds the drained
// coordinator stopped. Usage: relocate-ledger.js <state-dir> <ledger-home>
// Exit 0 means "moved" or "nothing to do yet"; non-zero means the original stayed authoritative.
// See docs/architecture/LEDGER-DURABILITY.md (The ledger's own filesystem).
import { Database } from 'bun:sqlite';
import { ledgerWriteResults } from '../src/ledger-write-results';
import { spawnSync } from 'node:child_process';
import { closeSync, createReadStream, writeSync, existsSync, fsyncSync, linkSync, lstatSync, openSync, renameSync, rmSync, statSync,
  statfsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

const [stateDir, ledgerHome] = process.argv.slice(2);
if (!stateDir || !ledgerHome) throw new Error('usage: relocate-ledger <state-dir> <ledger-home>');
const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
const say = (line: string) => writeSync(1, `ledger move: ${line}\n`);

if (spawnSync('mountpoint', ['-q', ledgerHome]).status !== 0) { say(`${ledgerHome} is not mounted; nothing to do`); process.exit(0); }
if (!existsSync(join(ledgerHome, '.concierge-ledger-filesystem'))) throw new Error(`${ledgerHome} is mounted but is not the prepared ledger filesystem`);

const fsyncPath = (path: string) => { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
/** Processes other than this one holding any of the paths open. */
const otherHolders = (paths: string[]) => {
  const present = paths.filter(path => existsSync(path));
  if (!present.length) return [];
  const result = spawnSync('fuser', present, { encoding: 'utf8' });
  return (result.stdout ?? '').split(/\s+/).filter(Boolean).map(Number).filter(pid => pid && pid !== process.pid);
};
const sameBytes = async (a: string, b: string) => {
  if (statSync(a).size !== statSync(b).size) return false;
  const left = createReadStream(a, { highWaterMark: 1 << 20 })[Symbol.asyncIterator]();
  const right = createReadStream(b, { highWaterMark: 1 << 20 })[Symbol.asyncIterator]();
  let pendingA = Buffer.alloc(0), pendingB = Buffer.alloc(0);
  for (;;) {
    if (!pendingA.length) { const next = await left.next(); pendingA = next.done ? Buffer.alloc(0) : next.value; if (next.done && !pendingB.length) return true; }
    if (!pendingB.length) { const next = await right.next(); pendingB = next.done ? Buffer.alloc(0) : next.value; }
    const n = Math.min(pendingA.length, pendingB.length);
    if (!n) return pendingA.length === pendingB.length;
    if (!pendingA.subarray(0, n).equals(pendingB.subarray(0, n))) return false;
    pendingA = pendingA.subarray(n); pendingB = pendingB.subarray(n);
  }
};

for (const name of ['state.db', 'meaning-index.db']) {
  const here = join(stateDir, name), there = join(ledgerHome, name), moving = `${there}.moving`;
  const entry = lstatSync(here, { throwIfNoEntry: false });
  if (!entry) continue;
  if (entry.isSymbolicLink()) { say(`${name} already lives on ${ledgerHome}`); continue; }
  // The original stays authoritative until its path is swapped, so a destination left by an
  // interrupted earlier move is stale: it is set aside, never used.
  for (const leftover of [there, moving]) if (existsSync(leftover)) {
    renameSync(leftover, `${leftover}.stale-${stamp}`);
    say(`set aside ${leftover} left by an interrupted move`);
  }
  const size = statSync(here).size;
  const free = (path: string) => { const s = statfsSync(path); return s.bavail * s.bsize; };
  // The image is sparse on the root filesystem: the copy needs the root filesystem's space.
  if (free(stateDir) < size * 2 + 2 * 1024 ** 3 || free(ledgerHome) < size + 1024 ** 3) {
    say(`not enough free space to copy ${name} (${size} bytes); left in place`); process.exit(0);
  }
  if (otherHolders([here, `${here}-wal`, `${here}-shm`]).length) { say(`${name} is open elsewhere; left in place`); process.exit(0); }
  // Writes no rows: it checkpoints and holds the writer lock while the file is copied and swapped.
  const source = ledgerWriteResults(new Database(here));
  source.exec('PRAGMA busy_timeout = 5000');
  const checkpoint = source.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number; log: number };
  if (checkpoint.busy !== 0 || checkpoint.log !== 0) throw new Error(`checkpoint incomplete: ${JSON.stringify(checkpoint)}`);
  // The writer lock is held from here until no other process can still write the old file.
  source.exec('BEGIN IMMEDIATE');
  let swapped = false;
  try {
    if (otherHolders([here, `${here}-wal`, `${here}-shm`]).length) { say(`${name} was opened during the move; left in place`); continue; }
    spawnSync('cp', ['--sparse=always', here, moving], { stdio: 'inherit' });
    fsyncPath(moving);
    if (!(await sameBytes(here, moving))) throw new Error(`copy of ${name} differs from the original`);
    const copy = new Database(moving, { readonly: true });
    const integrity = (copy.query('PRAGMA integrity_check').all() as { integrity_check: string }[]).map(row => row.integrity_check);
    const foreign = copy.query('PRAGMA foreign_key_check').all();
    copy.close();
    rmSync(`${moving}-wal`, { force: true }); rmSync(`${moving}-shm`, { force: true });
    if (integrity.join() !== 'ok' || foreign.length) throw new Error(`copy of ${name} failed its checks: ${integrity.slice(0, 3).join('; ')} foreign_key=${foreign.length}`);
    renameSync(moving, there);
    fsyncPath(there); fsyncPath(ledgerHome);
    const kept = `${here}.before-own-filesystem-${stamp}`;
    linkSync(here, kept);
    if (otherHolders([here, `${here}-wal`, `${here}-shm`]).length) throw new Error(`${name} was opened during the move; left in place`);
    symlinkSync(there, `${here}.link-${stamp}`);
    renameSync(`${here}.link-${stamp}`, here);
    fsyncPath(stateDir);
    swapped = true;
    // A process that opened the old file just before the swap waits for this lock and then fails;
    // the lock is released only once nothing else has the old file open.
    for (let waited = 0; otherHolders([kept, `${here}-wal`]).length && waited < 60; waited++) await Bun.sleep(1000);
    if (otherHolders([kept]).length) throw new Error(`a process still holds the retired ${name} after 60 s; investigate before writes resume`);
    say(`${name} now lives on ${ledgerHome}; the verified original is kept as ${kept}`);
  } finally {
    try { source.exec('ROLLBACK'); } catch { /* nothing held */ }
    source.close();
    if (swapped) { rmSync(`${here}-wal`, { force: true }); rmSync(`${here}-shm`, { force: true }); }
  }
}
