/** Bounded read-only allocation inventory from the owner state, never transcript bytes. */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type HistoryStorageKind = "claude" | "codex";

export function historyStorageStatus(stateDir: string, kind: HistoryStorageKind, after = "", limit = 1000) {
  if (!stateDir.startsWith("/") || (kind !== "claude" && kind !== "codex")
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 2000)
    throw new Error("INVALID_HISTORY_STORAGE_REQUEST");
  const folder = join(stateDir, kind === "claude" ? "provider-history-cache" : "codex-history-window");
  let names: string[];
  try { names = readdirSync(folder).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { kind, exists: false, scanned: 0, logicalBytes: 0, allocatedBytes: 0,
        complete: true, next: null, largest: [] };
    throw error;
  }
  const valid = kind === "claude"
    ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sqlite$/i
    : /^[A-Za-z0-9_-]{1,128}\.json$/;
  if (after && !valid.test(after)) throw new Error("INVALID_HISTORY_STORAGE_CURSOR");
  const candidates = names.filter(name => valid.test(name) && name > after);
  const page = candidates.slice(0, limit);
  let logicalBytes = 0, allocatedBytes = 0;
  const largest: Array<{name:string;logicalBytes:number;allocatedBytes:number}> = [];
  for (const name of page) {
    const info = lstatSync(join(folder, name));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("INVALID_HISTORY_STORAGE_FILE");
    const entry = { name, logicalBytes: info.size, allocatedBytes: info.blocks * 512 };
    logicalBytes += entry.logicalBytes;
    allocatedBytes += entry.allocatedBytes;
    largest.push(entry);
    largest.sort((a, b) => b.allocatedBytes - a.allocatedBytes || a.name.localeCompare(b.name));
    if (largest.length > 8) largest.pop();
  }
  return { kind, exists: true, scanned: page.length, logicalBytes, allocatedBytes,
    complete: candidates.length <= page.length, next: candidates.length > page.length ? page.at(-1) : null,
    largest };
}
