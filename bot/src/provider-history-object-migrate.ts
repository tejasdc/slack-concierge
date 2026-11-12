/** Operator-only conversion of one immutable Claude history snapshot. Run with Concierge stopped. */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, openSync, renameSync, statfsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  decodeStoredSdkRow, provenHostTranscriptObject, scanRawMessageLines,
  type RawMessageSpan, type StoredSdkRowReference,
} from "./provider-history-object-spans";

type CacheMeta = {
  session_uuid: string; source_path: string; source_size: number;
  source_mtime_ms: number; generation: string; row_count: number;
};

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function snapshotPath(sessionUuid: string): string {
  if (!SESSION_UUID.test(sessionUuid)) throw new Error("INVALID_HISTORY_REQUEST");
  return join(process.env.CONCIERGE_STATE_DIR || join(homedir(), ".local", "state", "concierge"),
    "provider-history-cache", `${sessionUuid}.sqlite`);
}

function fingerprint(path: string) {
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error("INVALID_HISTORY_SOURCE");
  return { dev: file.dev, ino: file.ino, size: file.size, blocks: file.blocks,
    mtimeMs: file.mtimeMs, ctimeMs: file.ctimeMs };
}

function sameFingerprint(a: ReturnType<typeof fingerprint>, b: ReturnType<typeof fingerprint>) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function syncParent(path: string) {
  const descriptor = openSync(dirname(path), "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function requireQuiescentHost(allowActiveOwner = false) {
  for (const unit of ["concierge-bot.service", "remote-box-backup.service"]) {
    if (allowActiveOwner && unit === "concierge-bot.service") continue;
    const check = Bun.spawnSync(["systemctl", "is-active", "--quiet", unit], { stdout: "ignore", stderr: "ignore" });
    if (check.exitCode === 0) throw new Error(`HISTORY_MIGRATION_REQUIRES_STOPPED_${unit.toUpperCase().replace(/[^A-Z]/g, "_")}`);
    if (check.exitCode !== 3) throw new Error("HISTORY_MIGRATION_HOST_STATE_UNKNOWN");
  }
}

function withSnapshotCopy<T extends {changed: boolean}>(
  path: string, run: (db: Database) => Promise<T>, allowActiveOwner = false,
): Promise<T> {
  const before = fingerprint(path);
  const space = statfsSync(dirname(path));
  if (space.bavail * space.bsize < before.size * 2 + 1024 * 1024 * 1024)
    throw new Error("HISTORY_MIGRATION_INSUFFICIENT_SPACE");
  const temporary = `${path}.${process.pid}.${randomUUID()}.object-next`;
  let db: Database;
  try {
    copyFileSync(path, temporary);
    db = new Database(temporary, { strict: true });
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  return run(db).then(result => {
    if (!result.changed) { db.close(); unlinkSync(temporary); return result; }
    const check = db.query("PRAGMA quick_check").get() as { quick_check: string } | null;
    if (check?.quick_check !== "ok") throw new Error("INVALID_HISTORY_SNAPSHOT_COPY");
    db.close();
    requireQuiescentHost(allowActiveOwner);
    if (!sameFingerprint(before, fingerprint(path))) throw new Error("HISTORY_SNAPSHOT_CHANGED");
    const descriptor = openSync(temporary, "r");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, path);
    syncParent(path);
    return result;
  }).catch(error => {
    try { db.close(); } catch {}
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  });
}

export async function migrateHistorySnapshot(sessionUuid: string, allowActiveOwner = false) {
  requireQuiescentHost(allowActiveOwner);
  const path = snapshotPath(sessionUuid);
  const beforeAllocatedBytes = fingerprint(path).blocks * 512;
  const original = new Database(path, { readonly: true, strict: true });
  try {
    const meta = original.query("SELECT * FROM meta").get() as CacheMeta | null;
    if (!meta || meta.session_uuid !== sessionUuid) throw new Error("INVALID_HISTORY_CACHE");
    const rowCount = (original.query("SELECT count(*) AS count FROM rows").get() as {count:number}).count;
    if (rowCount !== meta.row_count) throw new Error("INVALID_HISTORY_CACHE_ROW_COUNT");
    const source = fingerprint(meta.source_path);
    if (source.size !== meta.source_size || source.mtimeMs !== meta.source_mtime_ms)
      throw new Error("HISTORY_SOURCE_CHANGED");
    const result = await withSnapshotCopy(path, async db => {
      const existing = db.query("SELECT count(*) AS count FROM rows WHERE json LIKE '{\"conciergeRawReference\":1,%'")
        .get() as {count:number};
      if (existing.count === meta.row_count) return {changed:false,referenced:existing.count,
        full:0,reason:"already_referenced"};
      db.exec("CREATE TEMP TABLE seen_raw_uuid(uuid TEXT PRIMARY KEY, count INTEGER NOT NULL);"
        + "CREATE TEMP TABLE candidate(ordinal INTEGER PRIMARY KEY, metadata_json TEXT NOT NULL,"
        + "span_offset INTEGER NOT NULL,span_length INTEGER NOT NULL,span_sha256 TEXT NOT NULL);");
      const find = db.query("SELECT ordinal,json FROM rows WHERE uuid=? LIMIT 2");
      const seen = db.query("SELECT count FROM seen_raw_uuid WHERE uuid=?");
      const insertSeen = db.query("INSERT INTO seen_raw_uuid VALUES(?,1)");
      const duplicate = db.query("UPDATE seen_raw_uuid SET count=2 WHERE uuid=?");
      const discard = db.query("DELETE FROM candidate WHERE ordinal=?");
      const candidate = db.query("INSERT INTO candidate VALUES(?,?,?,?,?)");
      db.exec("BEGIN");
      let scan;
      try {
        scan = await scanRawMessageLines(meta.source_path, (line, span: RawMessageSpan) => {
          let raw: any;
          try { raw = JSON.parse(line.toString("utf8")); } catch { return; }
          if (typeof raw?.uuid !== "string" || !raw.uuid) return;
          const rows = find.all(raw.uuid) as {ordinal: number; json: string}[];
          if (rows.length !== 1) return;
          if (seen.get(raw.uuid)) { duplicate.run(raw.uuid); discard.run(rows[0]!.ordinal); return; }
          insertSeen.run(raw.uuid);
          const stored = JSON.parse(rows[0]!.json);
          if (!stored || typeof stored !== "object" || stored.conciergeRawReference === 1
            || stored.uuid !== raw.uuid || stored.session_id !== sessionUuid
            || raw.sessionId !== sessionUuid || typeof raw.type !== "string"
            || raw.type !== stored.type
            || !Object.prototype.hasOwnProperty.call(raw, "message")
            || !Object.prototype.hasOwnProperty.call(stored, "message")
            || !isDeepStrictEqual(raw.message, stored.message)) return;
          const { message: _message, ...metadata } = stored;
          candidate.run(rows[0]!.ordinal, JSON.stringify(metadata), span.offset, span.length, span.sha256);
        });
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      if (!sameFingerprint(source, fingerprint(meta.source_path))) throw new Error("HISTORY_SOURCE_CHANGED");
      if (scan.oversizedLine) return { changed: false, referenced: existing.count,
        full: meta.row_count - existing.count, reason: "oversized_line" };
      if (!await provenHostTranscriptObject(scan.sourceSha256, scan.sourceBytes))
        return { changed: false, referenced: existing.count,
          full: meta.row_count - existing.count, reason: "unproven_object" };
      const update = db.query("UPDATE rows SET json=? WHERE ordinal=?");
      const candidates = db.query("SELECT * FROM candidate ORDER BY ordinal");
      let referenced = 0;
      db.exec("BEGIN");
      try {
        for (const row of candidates.iterate() as Iterable<{
          ordinal:number;metadata_json:string;span_offset:number;span_length:number;span_sha256:string
        }>) {
          const reference: StoredSdkRowReference = {
            conciergeRawReference: 1, objectSha256: scan.sourceSha256, objectBytes: scan.sourceBytes,
            span: { offset: row.span_offset, length: row.span_length, sha256: row.span_sha256 },
            metadata: JSON.parse(row.metadata_json),
          };
          update.run(JSON.stringify(reference), row.ordinal);
          referenced++;
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      if (referenced) db.exec("VACUUM");
      return { changed: referenced > 0, newlyReferenced: referenced,
        referenced: existing.count + referenced,
        full: meta.row_count - existing.count - referenced,
        object: scan.sourceSha256 };
    }, allowActiveOwner);
    const afterAllocatedBytes = fingerprint(path).blocks * 512;
    return { ...result, allocatedBeforeBytes: beforeAllocatedBytes,
      allocatedAfterBytes: afterAllocatedBytes,
      allocatedSavedBytes: beforeAllocatedBytes - afterAllocatedBytes };
  } finally { original.close(); }
}

async function materialize(sessionUuid: string) {
  const path = snapshotPath(sessionUuid);
  return withSnapshotCopy(path, async db => {
    const nextRef = db.query("SELECT ordinal,json FROM rows WHERE ordinal>? AND json LIKE '%\"conciergeRawReference\":1%' ORDER BY ordinal LIMIT 1");
    const update = db.query("UPDATE rows SET json=? WHERE ordinal=?");
    let restored = 0;
    let lastOrdinal = -1;
    db.exec("BEGIN");
    try {
      for (;;) {
        const row = nextRef.get(lastOrdinal) as {ordinal:number;json:string} | null;
        if (!row) break;
        lastOrdinal = row.ordinal;
        const parsed = JSON.parse(row.json);
        if (parsed?.conciergeRawReference !== 1) continue;
        update.run(JSON.stringify(decodeStoredSdkRow(row.json)), row.ordinal);
        restored++;
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return { changed: restored > 0, restored };
  });
}

if (import.meta.main) {
  const [command, sessionUuid] = process.argv.slice(2);
  if (!sessionUuid || !SESSION_UUID.test(sessionUuid) || !["migrate", "materialize"].includes(command || ""))
    throw new Error("USAGE: provider-history-object-migrate.ts migrate|materialize <session-uuid>");
  requireQuiescentHost();
  const result = command === "migrate" ? await migrateHistorySnapshot(sessionUuid) : await materialize(sessionUuid);
  process.stdout.write(JSON.stringify(result) + "\n");
}
