/**
 * What is at a path, as a durable watch compares it (docs/architecture/WATCHES.md). Pure file reads,
 * no ledger: the owner runs it for its own machine and a runner for its own (runner-machine-calls.ts).
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";

/** A file up to this size is versioned by its content; a bigger one by modification time and size. */
export const WATCH_HASH_LIMIT_BYTES = 4 * 1024 * 1024;
export const MAX_DIRECTORY_ENTRIES = 20_000;
const NAMED_ENTRIES_LIMIT = 500;

export type PathVersion = {
  type: "absent" | "file" | "directory" | "other";
  mode: "absent" | "content-hash" | "mtime-size" | "directory-entries";
  size: number | null; mtimeMs: number | null; digest: string | null;
  entryCount: number | null;
  /** name -> [size, mtimeMs]; kept only for a small directory, to name what changed. */
  entries: Record<string, [number, number]> | null;
  /** New registrations also pin the link target; older baselines omit it and keep their old comparison. */
  linkTargetDigest?:string|null;
};
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** What is at `path` now. A missing path is a version (`absent`), not an error: appearing is a change. */
export function observePath(path: string): PathVersion {
  let stat;
  try { stat = statSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR")
      return { type: "absent", mode: "absent", size: null, mtimeMs: null, digest: null, entryCount: null, entries: null };
    throw error;
  }
  let linkTargetDigest:string|null=null;
  try {if(lstatSync(path).isSymbolicLink())linkTargetDigest=sha256(readlinkSync(path));}
  catch { /* The ordinary target observation below still decides whether the path changed. */ }
  if (stat.isDirectory()) {
    const names = readdirSync(path);
    if (names.length > MAX_DIRECTORY_ENTRIES)
      return { type: "directory", mode: "directory-entries", size: null, mtimeMs: null, digest: `too-many:${names.length}`, entryCount: names.length, entries: null };
    const entries: Record<string, [number, number]> = {};
    for (const name of names.sort()) {
      try { const entry = lstatSync(join(path, name)); entries[name] = [entry.size, entry.mtimeMs]; }
      catch { /* removed while listing: it is simply not there */ }
    }
    const digest = sha256(Object.entries(entries).map(([name, [size, mtime]]) => `${name}\0${size}\0${mtime}`).join("\n"));
    return { type: "directory", mode: "directory-entries", size: null, mtimeMs: null, digest, entryCount: Object.keys(entries).length,
      entries: Object.keys(entries).length <= NAMED_ENTRIES_LIMIT ? entries : null, ...(linkTargetDigest?{linkTargetDigest}:{}) };
  }
  if (stat.isFile() && stat.size <= WATCH_HASH_LIMIT_BYTES)
    return { type: "file", mode: "content-hash", size: stat.size, mtimeMs: stat.mtimeMs, digest: sha256(readFileSync(path)), entryCount: null, entries: null, ...(linkTargetDigest?{linkTargetDigest}:{}) };
  return { type: stat.isFile() ? "file" : "other", mode: "mtime-size", size: stat.size, mtimeMs: stat.mtimeMs, digest: null, entryCount: null, entries: null, ...(linkTargetDigest?{linkTargetDigest}:{}) };
}

/** Why `now` is not the baseline version, or null when it is the same version. */
export function versionChange(baseline: PathVersion, now: PathVersion): string | null {
  if (baseline.type !== now.type) {
    if (now.type === "absent") return `it was deleted (it was a ${baseline.type})`;
    if (baseline.type === "absent") return `it appeared (a ${now.type})`;
    return `it changed from a ${baseline.type} to a ${now.type}`;
  }
  if (now.type === "absent") return null;
  if (baseline.linkTargetDigest&&now.linkTargetDigest&&baseline.linkTargetDigest!==now.linkTargetDigest)
    return "the link points to another release";
  if (now.type === "directory") {
    if (now.digest === baseline.digest) return null;
    if (baseline.entries && now.entries) {
      const added = Object.keys(now.entries).filter(name => !baseline.entries![name]);
      const removed = Object.keys(baseline.entries).filter(name => !now.entries![name]);
      const modified = Object.keys(now.entries).filter(name => baseline.entries![name]
        && (baseline.entries![name]![0] !== now.entries![name]![0] || baseline.entries![name]![1] !== now.entries![name]![1]));
      const list = (label: string, names: string[]) => names.length ? `${label} ${names.slice(0, 10).join(", ")}${names.length > 10 ? ` and ${names.length - 10} more` : ""}` : "";
      return `its entries changed: ${[list("added", added), list("removed", removed), list("modified", modified)].filter(Boolean).join("; ")}`;
    }
    return `its entries changed (${baseline.entryCount} entries before, ${now.entryCount} now)`;
  }
  if (baseline.size !== now.size) return `its size changed from ${baseline.size} to ${now.size} bytes`;
  if (baseline.mode === "content-hash") return now.digest !== baseline.digest ? "its content changed" : null;
  return baseline.mtimeMs !== now.mtimeMs ? "its modification time changed (size unchanged; a version by modification time and size cannot prove the content differs)" : null;
}

