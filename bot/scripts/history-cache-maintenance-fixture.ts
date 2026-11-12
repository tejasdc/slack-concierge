#!/usr/bin/env bun
import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HistoryCacheMaintenance, HostCacheRestic, type CacheRestic } from "../src/provider-history-cache-maintenance";
import { decodeStoredSdkRow } from "../src/provider-history-object-spans";
import { migrateHistorySnapshot } from "../src/provider-history-object-migrate";

for (const script of ["deploy.sh", "deployment-control-launcher.sh"]) {
  const checked = Bun.spawn(["bash", "-n", join(import.meta.dir, script)], {stderr: "inherit"});
  assert.equal(await checked.exited, 0, `shell syntax: ${script}`);
}
const engine = new Database(":memory:");
console.log(JSON.stringify({runtime: Bun.version, sqlite: engine.query("SELECT sqlite_version() AS version").get()}));
engine.close();

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
class MemoryRestic implements CacheRestic {
  snapshots = new Map<string, Map<string, Buffer>>();
  failBackup = false;
  failReadback = false;
  afterBackup?: () => void;
  async backup(paths: string[]) {
    if (this.failBackup) throw new Error("backup_failed");
    const id = hash(randomUUID());
    this.snapshots.set(id, new Map(paths.map(path => [path, readFileSync(path)])));
    this.afterBackup?.();
    return id;
  }
  async readback(snapshot: string, path: string, target?: string) {
    const bytes = this.snapshots.get(snapshot)?.get(path);
    if (!bytes) throw new Error("snapshot_missing");
    if (target) writeFileSync(target, bytes, {flag: "wx", mode: 0o600});
    return {sha256: this.failReadback ? "0".repeat(64) : hash(bytes), bytes: bytes.length};
  }
}

export function fixture() {
  const state = mkdtempSync(join(tmpdir(), "history-cache-maintenance-")), objects = join(state, "objects");
  const session = randomUUID(), source = join(state, "source.jsonl"), path = join(state, "provider-history-cache", `${session}.sqlite`);
  const sdk = (uuid: string, type: string, content: unknown) => ({uuid, type, session_id: session,
    parent_tool_use_id: null, parent_agent_id: null, message: {content}, customSdkMetadata: "retained"});
  const rows = [sdk("old-compacted", "user", "Only an older version has me"),
    sdk("user", "user", "Read this"),
    sdk("tool", "assistant", [{type: "tool_use", id: "call", name: "Read", input: {path: "/fixture"}}]),
    sdk("result", "user", [{type: "tool_result", tool_use_id: "call", content: "result".repeat(100_000)}]),
    sdk("synthetic", "user", "Queued synthetic prompt"), sdk("mismatch", "user", "normalized"),
    sdk("duplicate", "user", "ambiguous")];
  const raw = rows.slice(1).filter(row => row.uuid !== "synthetic").map(row => ({uuid: row.uuid,
    type: row.type, sessionId: session, message: row.uuid === "mismatch" ? {content: "raw"} : row.message}));
  raw.push(raw.at(-1)!);
  const bytes = raw.map(row => JSON.stringify(row)).join("\n") + "\n";
  writeFileSync(source, bytes);
  const sha256 = hash(bytes), object = join(objects, "sha256", sha256.slice(0, 2), sha256);
  const plan = randomUUID(), snapshot = hash("host-snapshot");
  const put = (path: string, data: string | object) => {
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
  };
  put(object, bytes); chmodSync(object, 0o444);
  const planText = JSON.stringify({schema: 1, id: plan, files: [{digest: sha256, size: Buffer.byteLength(bytes)}]});
  put(join(objects, "plans", `${plan}.json`), planText);
  const proof = {schema: 1, plan, planDigest: hash(planText), snapshot};
  put(join(objects, "proofs", `${plan}.json`), {...proof, objects: [sha256]});
  put(join(objects, "backups", `${plan}.json`), proof);
  put(join(objects, "proofs/by-object", `${sha256}.json`), {...proof, sha256, bytes: Buffer.byteLength(bytes), verifiedAt: new Date().toISOString()});
  mkdirSync(dirname(path), {recursive: true});
  const db = new Database(path);
  db.exec(`PRAGMA journal_mode=DELETE;
    CREATE TABLE meta(session_uuid TEXT,cwd TEXT,source_path TEXT,source_size INTEGER,source_mtime_ms REAL,
      generation TEXT,row_count INTEGER,history_format INTEGER);
    CREATE TABLE rows(ordinal INTEGER PRIMARY KEY,uuid TEXT,json TEXT);
    CREATE INDEX rows_uuid ON rows(uuid);
    CREATE TABLE message_ids(id TEXT PRIMARY KEY,ordinal INTEGER);
    CREATE TABLE tool_names(tool_id TEXT PRIMARY KEY,name TEXT);`);
  const info = lstatSync(source);
  db.query("INSERT INTO meta VALUES(?,?,?,?,?,?,?,?)").run(session, state, source, info.size, info.mtimeMs, "generation-before", rows.length, 2);
  rows.forEach((row, ordinal) => {
    db.query("INSERT INTO rows VALUES(?,?,?)").run(ordinal, row.uuid, JSON.stringify(row));
    db.query("INSERT INTO message_ids VALUES(?,?)").run(row.uuid, ordinal);
  });
  db.query("INSERT INTO tool_names VALUES('call','Read')").run();
  db.close();
  const status = JSON.stringify({generation: "generation-before", needs_reimport: 0, history_format: 2});
  writeFileSync(path + ".verified.json", status);
  const restic = new MemoryRestic();
  let stopped = true;
  const maintenance = new HistoryCacheMaintenance(state, restic, () => { if (!stopped) throw new Error("owner_running"); }, objects);
  const cleanup=()=>{
    // The release manager seals its artifact directories 0555. The disposable
    // fixture owner must reopen ONLY its own directories before unlinking them.
    // Never follow a fixture's symlink into shared dependencies or another root.
    const writable=(path:string)=>{
      chmodSync(path,0o700);
      for(const entry of readdirSync(path,{withFileTypes:true}))if(entry.isDirectory()&&!entry.isSymbolicLink())writable(join(path,entry.name));
    };
    writable(state);rmSync(state,{recursive:true,force:true});
  };
  return {state, session, source, path, rows, object, sha256, status, objects, restic, maintenance,
    setStopped: (value: boolean) => { stopped = value; }, cleanup};
}

export async function check(name: string, run: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture();
  try { await run(f); console.log(JSON.stringify({check: name, status: "passed"})); }
  finally { f.cleanup(); }
}
export function rowsAt(f: ReturnType<typeof fixture>) {
  const db = new Database(f.path, {readonly: true});
  try { return (db.query("SELECT json FROM rows ORDER BY ordinal").all() as any[]).map(row => decodeStoredSdkRow(row.json, f.objects)); }
  finally { db.close(); }
}

if (process.argv.includes("--cleanup-probe")) {
  const f=fixture(),outside=mkdtempSync(join(tmpdir(),"history-cache-outside-")),sealed=join(f.state,"sealed");
  try {
    mkdirSync(sealed);writeFileSync(join(sealed,"payload"),"fixture");chmodSync(sealed,0o555);
    chmodSync(outside,0o500);symlinkSync(outside,join(f.state,"external"));
    f.cleanup();assert.equal(existsSync(f.state),false);
    assert.equal(lstatSync(outside).mode&0o777,0o500,"cleanup must not follow a link outside its owned tree");
    console.log(JSON.stringify({check:"sealed fixture cleanup as ordinary user without following symlinks",status:"passed",uid:process.getuid?.()}));
  } finally {chmodSync(outside,0o700);rmSync(outside,{recursive:true,force:true});}
  process.exit(0);
}
if (import.meta.main) {
await check("exact backup, selective conversion, SDK readback, pin accounting and materialization", async f => {
  const before = readFileSync(f.path), sourceBefore = readFileSync(f.source), beforeInode = lstatSync(f.path).ino;
  const prepared = await f.maintenance.prepare(f.session);
  assert.equal(lstatSync(join(f.maintenance.batch(prepared.id), "cache.sqlite")).ino, beforeInode);
  assert.deepEqual(readFileSync(f.path), before);
  assert.equal(readFileSync(f.path + ".verified.json", "utf8"), f.status);
  await f.maintenance.queue(prepared.id);
  const result = await f.maintenance.applyPending() as any;
  assert.equal(result.newlyReferenced, 3);
  assert.equal(result.full, 4);
  assert.ok(result.allocatedSavedBytes > 0);
  assert.ok(result.netAllocatedSavedBytes < 0, "old inode remains allocated while pinned");
  assert.deepEqual(rowsAt(f), f.rows);
  assert.deepEqual(readFileSync(f.source), sourceBefore);
  assert.equal(JSON.parse(readFileSync(f.path + ".verified.json", "utf8")).generation.startsWith("object-"), true);
  const repeat = await f.maintenance.prepare(f.session);
  const noChange = await f.maintenance.migrate(repeat.id);
  assert.equal(noChange.changed, false); assert.equal(noChange.referenced, 3); assert.equal(noChange.full, 4);
  assert.equal((await f.maintenance.release(repeat.id)).releasedBytes, 0, "a link to the still-live inode is not reclaimed storage");
  const released = await f.maintenance.release(prepared.id);
  assert.deepEqual(await f.maintenance.release(prepared.id), released, "release retry must not replay unlink");
  assert.ok(released.releasedBytes > 0);
  assert.equal(released.netAllocatedSavedBytes, result.allocatedSavedBytes);
  // Recover exact original bytes from the offsite generation after releasing the pin.
  await f.maintenance.restore(prepared.id);
  assert.deepEqual(readFileSync(f.path), before);
  assert.equal(readFileSync(f.path + ".verified.json", "utf8"), f.status);
  // Conversion, then inverse representation without consulting the source.
  const again = await f.maintenance.prepare(f.session);
  await f.maintenance.migrate(again.id);
  unlinkSync(f.source);
  assert.equal((await f.maintenance.materialize(f.session)).restored, 3);
  assert.deepEqual(rowsAt(f), f.rows);
  console.log(JSON.stringify({measurement: result, released}));
});
await check("complete row equality rejects a bad decoder before publication", async f => {
  const original = readFileSync(f.path), originalInode = lstatSync(f.path).ino;
  await assert.rejects(migrateHistorySnapshot(f.session, {path: f.path, quiescent: () => {},
    validate: async () => {}, prove: async () => f.object,
    decode: json => {
      const value = decodeStoredSdkRow(json, f.objects);
      return JSON.parse(json).conciergeRawReference === 1 ? {...value, message: {content: "incorrect reconstruction"}} as any : value;
    }}), /HISTORY_ROW_CHANGED/);
  assert.deepEqual(readFileSync(f.path), original); assert.equal(lstatSync(f.path).ino, originalInode);
});

await check("failed backup never authorizes replacement", async f => {
  const original = readFileSync(f.path), ino = lstatSync(f.path).ino;
  f.restic.failBackup = true;
  await assert.rejects(f.maintenance.prepare(f.session), /backup_failed/);
  const batch = readdirSync(f.maintenance.root).find(name => name !== "operation.lock")!;
  await assert.rejects(f.maintenance.migrate(batch));
  assert.equal(lstatSync(f.path).ino, ino); assert.deepEqual(readFileSync(f.path), original);
});
await check("failed full readback never creates receipt", async f => {
  f.restic.failReadback = true;
  await assert.rejects(f.maintenance.prepare(f.session), /READBACK_FAILED/);
  const batch = readdirSync(f.maintenance.root)[0]!;
  assert.equal(existsSync(join(f.maintenance.batch(batch), "receipt.json")), false);
});
await check("SQLite sidecars refuse a supposedly closed generation", async f => {
  const original = readFileSync(f.path);
  writeFileSync(f.path + "-journal", "unexpected journal");
  await assert.rejects(f.maintenance.prepare(f.session), /HAS_SIDECARS/);
  assert.deepEqual(readFileSync(f.path), original);
});
await check("owner running, source drift, sidecar drift and replaced generation refuse", async f => {
  const prepared = await f.maintenance.prepare(f.session), original = readFileSync(f.path);
  f.setStopped(false); await assert.rejects(f.maintenance.migrate(prepared.id), /owner_running/); f.setStopped(true);
  writeFileSync(f.path + ".verified.json", "{}");
  await assert.rejects(f.maintenance.migrate(prepared.id), /GENERATION_CHANGED/);
  writeFileSync(f.path + ".verified.json", f.status);
  writeFileSync(f.source, "changed\n");
  await assert.rejects(f.maintenance.migrate(prepared.id), /SOURCE_CHANGED/);
  assert.deepEqual(readFileSync(f.path), original);
  const replacement = f.path + ".replacement"; copyFileSync(f.path, replacement); renameSync(replacement, f.path);
  await f.maintenance.queue(prepared.id).then(() => assert.fail("changed inode must refuse"), () => {});
});
await check("a changed live generation during backup keeps exact old backup and skips queue", async f => {
  const before = readFileSync(f.path);
  f.restic.afterBackup = () => { const next = f.path + ".replacement"; copyFileSync(f.path, next); renameSync(next, f.path); };
  const prepared = await f.maintenance.prepare(f.session);
  assert.deepEqual(readFileSync(join(f.maintenance.batch(prepared.id), "cache.sqlite")), before);
  await assert.rejects(f.maintenance.queue(prepared.id), /GENERATION_CHANGED/);
});
await check("queued generation drift is skipped without conversion", async f => {
  const prepared = await f.maintenance.prepare(f.session); await f.maintenance.queue(prepared.id);
  writeFileSync(f.path + ".verified.json", "{}");
  assert.equal((await f.maintenance.applyPending() as any).status, "skipped_changed_generation");
  assert.equal(lstatSync(f.path).ino, lstatSync(join(f.maintenance.batch(prepared.id), "cache.sqlite")).ino);
});
await check("corrupt or missing objects preserve full rows and ambiguous rollback refuses", async f => {
  const prepared = await f.maintenance.prepare(f.session), before = readFileSync(f.path);
  chmodSync(f.object, 0o644); writeFileSync(f.object, "x".repeat(lstatSync(f.object).size)); chmodSync(f.object, 0o444);
  await assert.rejects(f.maintenance.migrate(prepared.id), /UNPROVEN_DEPENDENCY/);
  assert.deepEqual(readFileSync(f.path), before);
  unlinkSync(f.object);
  await assert.rejects(f.maintenance.migrate(prepared.id), /UNPROVEN_DEPENDENCY/);
  assert.deepEqual(readFileSync(f.path), before);
});
await check("rollback and pin release refuse a newer cache", async f => {
  const prepared = await f.maintenance.prepare(f.session); await f.maintenance.migrate(prepared.id);
  const next = f.path + ".newer"; copyFileSync(f.path, next);
  const db = new Database(next); db.query("UPDATE meta SET generation='newer'").run(); db.close(); renameSync(next, f.path);
  await assert.rejects(f.maintenance.restore(prepared.id), /ROLLBACK_TARGET_CHANGED/);
  await assert.rejects(f.maintenance.release(prepared.id), /RELEASE_TARGET_CHANGED/);
});
await check("native Restic backup, full stream readback and exact restore", async f => {
  const repository = join(f.state, "restic-repo"), password = join(f.state, "fixture-password");
  writeFileSync(password, "disposable-fixture-password", {mode: 0o600});
  const command = ["restic", "--no-cache", "-r", repository, "--password-file", password];
  const init = Bun.spawn([...command, "init"], {stdout: "ignore", stderr: "inherit"});
  assert.equal(await init.exited, 0);
  const native = new HistoryCacheMaintenance(f.state, new HostCacheRestic(command), () => {}, f.objects);
  const original = readFileSync(f.path), prepared = await native.prepare(f.session);
  assert.match(prepared.snapshot, /^[a-f0-9]{64}$/);
  const folder=native.batch(prepared.id);
  assert.equal(await new HostCacheRestic(command).backup([join(folder,"cache.sqlite"),join(folder,"manifest.json"),f.object],
    `concierge-history-cache:${prepared.id}`),prepared.snapshot,"unique native tag must recover the accepted snapshot without another backup");
  await native.migrate(prepared.id);
  await native.release(prepared.id);
  await native.restore(prepared.id);
  assert.deepEqual(readFileSync(f.path), original);
});
await check("publication interruption keeps exact pin rollback usable", async f => {
  const prepared = await f.maintenance.prepare(f.session), original = readFileSync(f.path);
  await f.maintenance.migrate(prepared.id);
  unlinkSync(join(f.maintenance.batch(prepared.id), "result.json"));
  await f.maintenance.restore(prepared.id);
  assert.deepEqual(readFileSync(f.path), original);
});
await check("missing offsite backup refuses rollback without replacing current bytes", async f => {
  const prepared = await f.maintenance.prepare(f.session);
  await f.maintenance.migrate(prepared.id); await f.maintenance.release(prepared.id);
  const current = readFileSync(f.path);
  f.restic.snapshots.delete(prepared.snapshot);
  await assert.rejects(f.maintenance.restore(prepared.id), /snapshot_missing/);
  assert.deepEqual(readFileSync(f.path), current);
});
console.log("history cache maintenance fixture passed");
}
