import type { Database } from 'bun:sqlite';
import { publishProviderFreeNotice } from './provider-free-notice';

/** A typed fact from the paired Mac, never caller-supplied text, paths or commands. */
export function receiveMacDiskWarning(db: Database, value: unknown, verifiedPeer: boolean) {
  if (!verifiedPeer) throw new Error('Mac disk warnings require an authenticated peer.');
  const input = value as { episode?: unknown; freeBytes?: unknown; recovered?: unknown } | null;
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['episode', 'freeBytes', 'recovered'].includes(key))
      || !Number.isSafeInteger(input.episode) || (input.episode as number) < 1
      || !Number.isSafeInteger(input.freeBytes) || (input.freeBytes as number) < 0 || typeof input.recovered !== 'boolean')
    throw new Error('Mac disk warnings require a positive episode and nonnegative freeBytes.');
  const key = `mac-disk-low:${input.episode}`;
  const text = `Mac disk space ${input.recovered ? 'recovered after running low' : 'ran low'}\n\n`
    + (input.recovered ? 'Free space has recovered. This notice records the earlier low-space episode. ' : 'There is less room for swap, builds and downloads. ')
    + `The latest reading is ${((input.freeBytes as number) / 1024 ** 3).toFixed(1)} GiB free. `
    + 'Concierge is checking its own logs and finished work automatically; '
    + 'your personal libraries, Downloads and unrelated caches stay yours. This warning appears once for this low-space episode.';
  const inserted = publishProviderFreeNotice(db, { key, text, kind: 'requested_mac_disk_warning',
    payload: { key, machine: 'mac', freeBytes: input.freeBytes, episode: input.episode, recovered: input.recovered } });
  return { status: inserted ? 'recorded' : 'duplicate', key };
}
