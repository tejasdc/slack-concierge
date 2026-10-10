import { existsSync, readdirSync, statSync } from 'node:fs';

/**
 * Processes other than this one holding any of the files open, matched by device and inode (so a
 * renamed or hard-linked file is still recognised) across every process's open descriptors and
 * memory maps. A process that ends mid-scan is skipped; any other failure to read throws, because
 * "could not look" must never pass for "nobody holds it" (relocate-ledger.ts fences on this).
 */
export function otherHolders(paths: string[]): number[] {
  const wanted = new Set(paths.filter(path => existsSync(path)).map(path => { const s = statSync(path); return `${s.dev}:${s.ino}`; }));
  if (!wanted.size) return [];
  const gone = (error: unknown) => ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '');
  const holders = new Set<number>();
  for (const entry of readdirSync('/proc')) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    for (const kind of ['fd', 'map_files']) {
      let names: string[];
      try { names = readdirSync(`/proc/${pid}/${kind}`); } catch (error) { if (gone(error)) break; throw error; }
      for (const name of names) {
        try { const s = statSync(`/proc/${pid}/${kind}/${name}`); if (wanted.has(`${s.dev}:${s.ino}`)) holders.add(pid); }
        catch (error) { if (!gone(error)) throw error; }
      }
    }
  }
  return [...holders];
}
