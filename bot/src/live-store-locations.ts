/**
 * Where Concierge's live stores really are. The state directory is the ledger's one address:
 * moving a database to its own filesystem leaves it there as a link to its current home
 * (bot/scripts/relocate-ledger.ts), so following those links names every live location, for the
 * agent command check and for the release checks' sandbox alike.
 *
 * Kept apart from the command check's own text on purpose: that check reads the scripts a command
 * launches, and a bundle carrying its copy-command patterns would look like a copy script.
 */
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch {}
  try { return join(realpathSync(dirname(path)), basename(path)); } catch { return resolve(path); }
}

export type LiveStores = { directories: string[]; files: { dev: number; ino: number }[] };

/** Every directory holding a live store, and the identity of each database file in them. */
export function liveStores(stateDir = join(homedir(), '.local/state/concierge')): LiveStores {
  const directories = new Set([canonicalPath(stateDir)]);
  let entries: string[] = [];
  try { entries = readdirSync(stateDir).filter(name => /\.db$/.test(name)); } catch {}
  for (const name of entries) directories.add(dirname(canonicalPath(join(stateDir, name))));
  const files: LiveStores['files'] = [];
  for (const directory of directories) {
    let names: string[] = [];
    try { names = readdirSync(directory).filter(name => /\.db(?:-wal)?$/.test(name)); } catch {}
    for (const name of names) {
      try { const { dev, ino } = statSync(join(directory, name)); files.push({ dev, ino }); } catch {}
    }
  }
  return { directories: [...directories], files };
}
