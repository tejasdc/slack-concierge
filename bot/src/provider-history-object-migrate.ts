/** Operator-only conversion of one immutable Claude history snapshot. Run with Concierge stopped. */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, openSync, renameSync, statfsSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {ledgerRows} from "./ledger-rows";
import {
  decodeStoredSdkRow, provenHostTranscriptObject, scanRawMessageLines,
  type RawMessageSpan, type StoredSdkRowReference,
} from "./provider-history-object-spans";

type CacheMeta = {
  session_uuid: string; source_path: string; source_size: number;
  source_mtime_ms: number; generation: string; row_count: number;
};

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export function requireStoppedServices(units: string[]) {
  for (const unit of units) {
    const check = Bun.spawnSync(["systemctl", "show", unit, "-p", "LoadState", "-p", "ActiveState", "-p", "SubState", "-p", "MainPID", "-p", "ControlPID"], { stderr: "ignore" });
    const state = Object.fromEntries(check.stdout.toString().trim().split("\n").map(line => line.split("=")));
    if (check.exitCode !== 0 || state.LoadState !== "loaded" || !["inactive", "failed"].includes(state.ActiveState)
      || !["dead", "failed"].includes(state.SubState) || state.MainPID !== "0" || state.ControlPID !== "0")
      throw new Error(`HISTORY_MIGRATION_REQUIRES_STOPPED_${unit.toUpperCase().replace(/[^A-Z]/g, "_")}`);
  }
}
export function requireQuiescentHost() {
  requireStoppedServices(["concierge-bot.service", "remote-box-backup.service"]);
}

export type ConversionGate = {
  path: string;
  quiescent: () => void;
  validate: () => Promise<void>;
  prove: typeof provenHostTranscriptObject;
  decode: typeof decodeStoredSdkRow;
  stagingPath?: string;
  keepPrepared?: () => boolean;
  afterCopy?: () => void;
  beforePublish?: (path: string, result: {changed: boolean}) => Promise<void>;
};

async function compareSnapshots(path: string, next: string, decode: typeof decodeStoredSdkRow) {
  const before = new Database(path, { readonly: true, strict: true });
  const after = new Database(next, { readonly: true, strict: true });
  try {
    const left = before.query("SELECT * FROM meta").get() as any;
    const right = after.query("SELECT * FROM meta").get() as any;
    if (!left || !right || left.generation === right.generation) throw new Error("HISTORY_GENERATION_NOT_REPLACED");
    delete left.generation; delete right.generation;
    if (!isDeepStrictEqual(left, right)) throw new Error("HISTORY_METADATA_CHANGED");
    const compare=(sql:string,project=(row:any)=>row,error="HISTORY_INDEX_CHANGED")=>{
      const a=ledgerRows<any>(before,sql),b=ledgerRows<any>(after,sql);
      try {for(;;) {
        const x=a.next(),y=b.next();
        if(x.done!==y.done)throw new Error("HISTORY_ROW_COUNT_CHANGED");
        if(x.done)break;
        if(!isDeepStrictEqual(project(x.value),project(y.value)))throw new Error(error);
      }} finally {a.return(undefined);b.return(undefined);}
    };
    for (const table of ["message_ids", "tool_names"]) compare(`SELECT * FROM ${table} ORDER BY 1`);
    compare("SELECT * FROM rows ORDER BY ordinal",row=>({ordinal:row.ordinal,uuid:row.uuid,value:decode(row.json)}),"HISTORY_ROW_CHANGED");
  } finally { before.close(); after.close(); }
}

export async function publishPreparedHistorySnapshot(gate: ConversionGate, temporary: string) {
  gate.quiescent();
  const before = fingerprint(gate.path);
  const db = new Database(temporary, {readonly:true,strict:true});
  try {
    const check = db.query("PRAGMA integrity_check").all() as {integrity_check:string}[];
    if (check.length !== 1 || check[0]?.integrity_check !== "ok") throw new Error("INVALID_HISTORY_SNAPSHOT_COPY");
  } finally { db.close(); }
  await compareSnapshots(gate.path, temporary, gate.decode);
  await gate.validate();
  gate.quiescent();
  if (!sameFingerprint(before, fingerprint(gate.path))) throw new Error("HISTORY_SNAPSHOT_CHANGED");
  const descriptor = openSync(temporary, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporary, gate.path);
  syncParent(gate.path);
}

function withSnapshotCopy<T extends {changed: boolean}>(
  gate: ConversionGate, run: (db: Database) => Promise<T>,
): Promise<T> {
  const path = gate.path;
  const before = fingerprint(path);
  const space = statfsSync(dirname(path));
  if (space.bavail * space.bsize < before.size * 2 + 1024 * 1024 * 1024)
    throw new Error("HISTORY_MIGRATION_INSUFFICIENT_SPACE");
  const temporary = gate.stagingPath || `${path}.${process.pid}.${randomUUID()}.object-next`;
  let db: Database;
  let copied=false;
  try {
    copyFileSync(path, temporary, constants.COPYFILE_EXCL);
    copied=true;
    gate.afterCopy?.();
    db = new Database(temporary, { strict: true });
  } catch (error) {
    if(copied && existsSync(temporary))unlinkSync(temporary);
    throw error;
  }
  return run(db).then(async result => {
    if (!result.changed) { db.close(); unlinkSync(temporary); return result; }
    const check = db.query("PRAGMA quick_check").get() as { quick_check: string } | null;
    if (check?.quick_check !== "ok") throw new Error("INVALID_HISTORY_SNAPSHOT_COPY");
    db.close();
    gate.quiescent();
    if (!sameFingerprint(before, fingerprint(path))) throw new Error("HISTORY_SNAPSHOT_CHANGED");
    await gate.validate();
    await gate.beforePublish?.(temporary, result);
    await publishPreparedHistorySnapshot(gate, temporary);
    return result;
  }).catch(error => {
    try { db.close(); } catch {}
    if (!gate.keepPrepared?.() && existsSync(temporary)) unlinkSync(temporary);
    throw error;
  });
}

export async function migrateHistorySnapshot(sessionUuid: string, gate: ConversionGate) {
  gate.quiescent();
  await gate.validate();
  const path = gate.path;
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
    const result = await withSnapshotCopy(gate, async db => {
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
      if (!await gate.prove(scan.sourceSha256, scan.sourceBytes))
        return { changed: false, referenced: existing.count,
          full: meta.row_count - existing.count, reason: "unproven_object" };
      const update = db.query("UPDATE rows SET json=? WHERE ordinal=?");
      const candidates = db.query("SELECT * FROM candidate WHERE ordinal>? ORDER BY ordinal LIMIT 100");
      let referenced = 0;
      let lastOrdinal = -1;
      db.exec("BEGIN");
      try {
        for (;;) {
          const page = candidates.all(lastOrdinal) as Array<{
            ordinal:number;metadata_json:string;span_offset:number;span_length:number;span_sha256:string
          }>;
          if (!page.length) break;
          for (const row of page) {
            const reference: StoredSdkRowReference = {
              conciergeRawReference: 1, objectSha256: scan.sourceSha256, objectBytes: scan.sourceBytes,
              span: { offset: row.span_offset, length: row.span_length, sha256: row.span_sha256 },
              metadata: JSON.parse(row.metadata_json),
            };
            update.run(JSON.stringify(reference), row.ordinal);
            referenced++;
            lastOrdinal = row.ordinal;
          }
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      if (referenced) {
        db.query("UPDATE meta SET generation=?").run(`object-${randomUUID()}`);
        db.exec("VACUUM");
      }
      return { changed: referenced > 0, newlyReferenced: referenced,
        referenced: existing.count + referenced,
        full: meta.row_count - existing.count - referenced,
        object: scan.sourceSha256 };
    });
    const afterAllocatedBytes = fingerprint(path).blocks * 512;
    return { ...result, allocatedBeforeBytes: beforeAllocatedBytes,
      allocatedAfterBytes: afterAllocatedBytes,
      allocatedSavedBytes: beforeAllocatedBytes - afterAllocatedBytes };
  } finally { original.close(); }
}

export async function materializeHistorySnapshot(gate: ConversionGate) {
  gate.quiescent();
  await gate.validate();
  return withSnapshotCopy(gate, async db => {
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
        update.run(JSON.stringify(gate.decode(row.json)), row.ordinal);
        restored++;
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    if (restored) db.query("UPDATE meta SET generation=?").run(`materialized-${randomUUID()}`);
    return { changed: restored > 0, restored };
  });
}

if (import.meta.main) {
  const [command, sessionUuid] = process.argv.slice(2);
  if (!sessionUuid || !SESSION_UUID.test(sessionUuid) || !["migrate", "materialize"].includes(command || ""))
    throw new Error("USAGE: provider-history-object-migrate.ts migrate|materialize <session-uuid>");
  throw new Error("USE_DEPLOYMENT_CONTROL_HISTORY_CACHE_MAINTENANCE");
}
