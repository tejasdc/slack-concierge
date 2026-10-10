// Moves Concierge's ledger onto its own filesystem, once, while the update runner holds the drained
// coordinator stopped; with --back, returns it to the state directory (the rollback).
// Usage: relocate-ledger.js <state-dir> <ledger-home> [--back]
// Exit 0 means "done" or "nothing to do yet"; non-zero means the authoritative file did not change.
// See docs/architecture/LEDGER-DURABILITY.md (The ledger's own filesystem).
import { Database } from 'bun:sqlite';
import { ledgerWriteResults } from '../src/ledger-write-results';
import { otherHolders } from './ledger-file-holders';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, openSync, realpathSync, renameSync, rmSync,
  statSync, statfsSync, symlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [stateDir, ledgerHome, mode] = process.argv.slice(2);
if (!stateDir || !ledgerHome || (mode && mode !== '--back')) throw new Error('usage: relocate-ledger <state-dir> <ledger-home> [--back]');
const back = mode === '--back';
const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
const say = (line: string) => writeSync(1, `ledger ${back ? 'rollback' : 'move'}: ${line}\n`);

const fsyncPath = (path: string) => { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
// Compared by a separate process: closing a descriptor this process opened on the database file
// would release every POSIX lock this process holds on it, including the writer fence below.
const sameBytes = (a: string, b: string) => spawnSync('cmp', ['-s', a, b]).status === 0;
const freeBytes = (path: string) => { const s = statfsSync(path); return s.bavail * s.bsize; };

/**
 * Copies `source` to `destination` and runs `publish` to make the copy authoritative, with no
 * committed write left outside the copy. SQLite's writer lock is taken first and held until nothing
 * can still write the retired file; the log is proved empty under that lock, so the main file alone
 * is the whole ledger. Returns false, with nothing changed, when another process has the file open.
 */
async function fencedCopyAndSwap(source: string, destination: string, retired: string, publish: () => void): Promise<boolean> {
  const parts = [source, `${source}-wal`, `${source}-shm`];
  if (otherHolders(parts).length) { say(`${source} is open elsewhere; left in place`); return false; }
  const ledger = ledgerWriteResults(new Database(source));
  ledger.exec('PRAGMA busy_timeout = 5000');
  let locked = false;
  try {
    for (let attempt = 0; ; attempt++) {
      const checkpoint = ledger.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number; log: number };
      if (checkpoint.busy !== 0) throw new Error(`checkpoint blocked: ${JSON.stringify(checkpoint)}`);
      ledger.exec('BEGIN IMMEDIATE');
      locked = true;
      // Under the writer lock nothing can append; an empty log means every commit is in the main file.
      if (!existsSync(`${source}-wal`) || statSync(`${source}-wal`).size === 0) break;
      ledger.exec('ROLLBACK'); locked = false;
      if (attempt >= 20) throw new Error('writes kept arriving between checkpoint and lock');
      await Bun.sleep(100);
    }
    if (otherHolders(parts).length) { say(`${source} was opened during the copy; left in place`); return false; }
    const moving = `${destination}.moving`;
    if (spawnSync('cp', ['--sparse=always', source, moving], { stdio: 'inherit' }).status !== 0) throw new Error(`could not copy ${source}`);
    fsyncPath(moving);
    if (!sameBytes(source, moving)) throw new Error(`copy of ${source} differs from the original`);
    const copy = new Database(moving, { readonly: true });
    const integrity = (copy.query('PRAGMA integrity_check').all() as { integrity_check: string }[]).map(row => row.integrity_check);
    const foreign = copy.query('PRAGMA foreign_key_check').all();
    copy.close();
    rmSync(`${moving}-wal`, { force: true }); rmSync(`${moving}-shm`, { force: true });
    if (integrity.join() !== 'ok' || foreign.length) throw new Error(`copy failed its checks: ${integrity.slice(0, 3).join('; ')} foreign_key=${foreign.length}`);
    renameSync(moving, destination);
    fsyncPath(destination); fsyncPath(dirname(destination));
    if (otherHolders(parts).length) { rmSync(destination, { force: true }); say(`${source} was opened during the copy; left in place`); return false; }
    publish();
    // Whatever opened the retired file just before the swap is waiting for this lock. The lock is
    // held until nothing has that file open; a holder that will not let go is stopped, never outwaited.
    for (let waited = 0; ; waited++) {
      // By its retired name: after the swap, the original path may lead to the new file.
      const holders = otherHolders([retired, `${source}-wal`]);
      if (!holders.length) break;
      if (waited === 30 || waited === 60) {
        say(`process ${holders.join(', ')} still holds the retired ${retired}; ${waited === 30 ? 'asking it to stop' : 'stopping it'}`);
        for (const pid of holders) try { process.kill(pid, waited === 30 ? 'SIGTERM' : 'SIGKILL'); } catch { /* already gone */ }
      } else if (waited % 10 === 0 && waited) say(`waiting for ${holders.join(', ')} to release the retired ${retired}`);
      await Bun.sleep(1000);
    }
    return true;
  } finally {
    if (locked) try { ledger.exec('ROLLBACK'); } catch { /* released */ }
    ledger.close();
  }
}

if (back) {
  for (const name of ['state.db', 'meaning-index.db']) {
    const link = join(stateDir, name);
    if (!lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) { say(`${name} is not moved; nothing to roll back`); continue; }
    const target = realpathSync(link);
    if (freeBytes(stateDir) < statSync(target).size + 2 * 1024 ** 3) throw new Error(`not enough free space to copy ${name} back`);
    const copy = `${link}.rollback-${stamp}`;
    if (!(await fencedCopyAndSwap(target, copy, target, () => { renameSync(copy, link); fsyncPath(stateDir); }))) process.exit(1);
    say(`${name} is back in ${stateDir}; the moved copy remains at ${target}`);
  }
  process.exit(0);
}

if (spawnSync('mountpoint', ['-q', ledgerHome]).status !== 0) { say(`${ledgerHome} is not mounted; nothing to do`); process.exit(0); }
if (!existsSync(join(ledgerHome, '.concierge-ledger-filesystem'))) throw new Error(`${ledgerHome} is mounted but is not the prepared ledger filesystem`);
for (const name of ['state.db', 'meaning-index.db']) {
  const here = join(stateDir, name), there = join(ledgerHome, name);
  const entry = lstatSync(here, { throwIfNoEntry: false });
  if (!entry) continue;
  if (entry.isSymbolicLink()) { say(`${name} already lives on ${ledgerHome}`); continue; }
  // The original stays authoritative until its path is swapped, so a destination left by an
  // interrupted earlier move is stale: it is set aside, never used.
  for (const leftover of [there, `${there}.moving`]) if (existsSync(leftover)) {
    renameSync(leftover, `${leftover}.stale-${stamp}`);
    say(`set aside ${leftover} left by an interrupted move`);
  }
  const size = statSync(here).size;
  // The image is sparse on the root filesystem: the copy needs the root filesystem's space.
  if (freeBytes(stateDir) < size * 2 + 2 * 1024 ** 3 || freeBytes(ledgerHome) < size + 1024 ** 3) {
    say(`not enough free space to copy ${name} (${size} bytes); left in place`); process.exit(0);
  }
  const kept = `${here}.before-own-filesystem-${stamp}`;
  const moved = await fencedCopyAndSwap(here, there, kept, () => {
    linkSync(here, kept);
    symlinkSync(there, `${here}.link-${stamp}`);
    renameSync(`${here}.link-${stamp}`, here);
    fsyncPath(stateDir);
  });
  if (!moved) continue;
  rmSync(`${here}-wal`, { force: true }); rmSync(`${here}-shm`, { force: true });
  say(`${name} now lives on ${ledgerHome}; the verified original is kept as ${kept}`);
}
