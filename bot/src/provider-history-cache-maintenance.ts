/** One closed cache generation, pinned locally and independently read back from Restic. */
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { open } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { checkSqliteBackup } from "./verified-sqlite-backup";
import { decodeStoredSdkRow, provenHostTranscriptObject } from "./provider-history-object-spans";
import { materializeHistorySnapshot, migrateHistorySnapshot, requireQuiescentHost, requireStoppedServices } from "./provider-history-object-migrate";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const RESTIC = "/root/workspace/remote-box/scripts/restic.sh";
const OBJECTS = "/root/transcript-objects";

function sync(path: string) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function publish(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
  sync(temporary);
  // Receipts never silently replace an earlier operation's evidence.
  try { linkSync(temporary, path); sync(dirname(path)); }
  finally { unlinkSync(temporary); }
}
function identity(path: string) {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink()) throw new Error("HISTORY_NOT_REGULAR");
  return { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs };
}
async function digest(path: string) {
  const before = identity(path), hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (!isDeepStrictEqual(before, identity(path))) throw new Error("HISTORY_FILE_CHANGED");
  return { sha256: hash.digest("hex"), bytes: before.size };
}
function sidecar(path: string): string | null {
  try {
    if (identity(path).size > 64 * 1024) throw new Error("HISTORY_SIDECAR_TOO_LARGE");
    return readFileSync(path, "utf8");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function replaceSidecar(path: string, text: string | null) {
  if (text === null) { if (existsSync(path)) unlinkSync(path); }
  else {
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, text, {mode: 0o600, flag: "wx"}); sync(temporary);
    renameSync(temporary, path);
  }
  sync(dirname(path));
}
function requireClosedSnapshot(path: string) {
  if (["-wal", "-shm", "-journal"].some(suffix => existsSync(path + suffix)))
    throw new Error("HISTORY_SNAPSHOT_HAS_SIDECARS");
}
function openSnapshot(path: string) {
  identity(path);
  requireClosedSnapshot(path);
  return new Database(path, { readonly: true, strict: true });
}
function carryVerifierStatus(path: string, generation: string, original: string | null) {
  if (original === null) return;
  let status: any;
  try { status = JSON.parse(original); } catch { return; }
  if (!status || typeof status !== "object" || status.generation !== generation) return;
  const db = openSnapshot(path);
  try { status.generation = (db.query("SELECT generation FROM meta").get() as any).generation; }
  finally { db.close(); }
  replaceSidecar(path + ".verified.json", JSON.stringify(status));
}

export interface CacheRestic {
  backup(paths: string[], tag: string): Promise<string>;
  readback(snapshot: string, path: string, target?: string): Promise<{sha256: string; bytes: number}>;
}

/** No payload is buffered in memory or extracted to a second local cache copy. */
export class HostCacheRestic implements CacheRestic {
  constructor(readonly command = [RESTIC]) {}
  private async run(args: string[], payload: boolean, target?: string) {
    const destination = target ? await open(target, "wx", 0o600) : null;
    const child = Bun.spawn([...this.command, ...args], { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30 * 60 * 1000);
    let bytes = 0, control = "";
    const hash = createHash("sha256");
    try {
      for await (const chunk of child.stdout) {
        bytes += chunk.length;
        if (payload) hash.update(chunk);
        else {
          if (bytes > 1024 * 1024) throw new Error("HISTORY_BACKUP_CONTROL_TOO_LARGE");
          control += Buffer.from(chunk).toString("utf8");
        }
        if (destination) {
          for (let offset = 0; offset < chunk.length;) {
            const wrote = await destination.write(chunk, offset, chunk.length - offset);
            if (!wrote.bytesWritten) throw new Error("HISTORY_RESTORE_SHORT_WRITE");
            offset += wrote.bytesWritten;
          }
        }
      }
      const exit = await child.exited;
      if (exit !== 0) throw new Error(`HISTORY_RESTIC_FAILED_${args[0]}_EXIT_${exit}`);
      await destination?.sync();
      return { sha256: hash.digest("hex"), bytes, control };
    } finally { clearTimeout(timer); child.kill(); await child.exited; await destination?.close(); }
  }
  async backup(paths: string[], tag: string) {
    const output = await this.run(["backup", "--json", "--quiet", "--tag", tag, ...paths], false);
    const summaries = output.control.trim().split("\n").map(line => JSON.parse(line))
      .filter(row => row.message_type === "summary");
    if (summaries.length !== 1 || !SHA.test(summaries[0]?.snapshot_id)) throw new Error("HISTORY_BACKUP_SNAPSHOT_UNKNOWN");
    return summaries[0].snapshot_id as string;
  }
  async readback(snapshot: string, path: string, target?: string) {
    if (!SHA.test(snapshot)) throw new Error("HISTORY_BACKUP_SNAPSHOT_UNKNOWN");
    const {sha256, bytes} = await this.run(["dump", snapshot, path], true, target);
    return {sha256, bytes};
  }
}

type Dependency = { sha256: string; bytes: number };
type Manifest = {
  schema: 1; id: string; session: string; generation: string;
  cacheIdentity: ReturnType<typeof identity>; cache: Dependency;
  sidecar: string | null; dependencies: Dependency[];
};

/** Explicit roots exist only for disposable native-file fixtures, never CLI flags. */
export class HistoryCacheMaintenance {
  readonly root: string;
  constructor(readonly state: string, readonly restic: CacheRestic,
    readonly quiescent = requireQuiescentHost, readonly objects = OBJECTS) {
    this.root = join(state, "history-cache-maintenance");
  }
  cache(session: string) {
    if (!UUID.test(session)) throw new Error("INVALID_HISTORY_SESSION");
    return join(this.state, "provider-history-cache", `${session}.sqlite`);
  }
  batch(id: string) {
    if (!UUID.test(id)) throw new Error("INVALID_HISTORY_BATCH");
    return join(this.root, id);
  }
  object(dep: Dependency) {
    if (!SHA.test(dep.sha256) || !Number.isSafeInteger(dep.bytes) || dep.bytes < 0) throw new Error("INVALID_HISTORY_DEPENDENCY");
    return join(this.objects, "sha256", dep.sha256.slice(0, 2), dep.sha256);
  }
  async prepare(session: string) {
    const path = this.cache(session), id = randomUUID(), folder = this.batch(id), pin = join(folder, "cache.sqlite");
    mkdirSync(this.root, {recursive: true, mode: 0o700});
    sync(this.state);
    mkdirSync(folder, {mode: 0o700});
    sync(this.root);
    console.error(JSON.stringify({event: "history_cache_backup_started", id, session, at: new Date().toISOString()}));
    const started = performance.now();
    requireClosedSnapshot(path);
    linkSync(path, pin);
    sync(pin); sync(folder);
    const cacheIdentity = identity(pin), db = openSnapshot(pin);
    let meta: any, dependencies: Dependency[];
    try {
      checkSqliteBackup(db);
      meta = db.query("SELECT * FROM meta").get();
      if (!meta || meta.session_uuid !== session || typeof meta.generation !== "string"
        || (db.query("SELECT count(*) AS n FROM rows").get() as any).n !== meta.row_count) throw new Error("INVALID_HISTORY_CACHE");
      const refs = new Map<string, Dependency>();
      for (const row of db.query("SELECT json FROM rows WHERE json LIKE '%\"conciergeRawReference\":1%'").iterate() as IterableIterator<any>) {
        const ref = JSON.parse(row.json);
        if (ref?.conciergeRawReference !== 1) continue;
        const dep = {sha256: ref.objectSha256, bytes: ref.objectBytes};
        if (refs.has(dep.sha256) && refs.get(dep.sha256)!.bytes !== dep.bytes) throw new Error("HISTORY_AMBIGUOUS_DEPENDENCY");
        refs.set(dep.sha256, dep);
      }
      // Only the exact, unchanged mirror version can add new references. A missing
      // source leaves existing full rows available, but cannot authorize new ones.
      const source = identity(meta.source_path);
      if (source.size !== meta.source_size || source.mtimeMs !== meta.source_mtime_ms) throw new Error("HISTORY_SOURCE_CHANGED");
      const candidate = await digest(meta.source_path);
      if (await provenHostTranscriptObject(candidate.sha256, candidate.bytes, this.objects)) refs.set(candidate.sha256, candidate);
      dependencies = [...refs.values()];
      if (!dependencies.length) throw new Error("HISTORY_NO_PROVEN_OBJECT");
      for (const dep of dependencies) {
        if (!await provenHostTranscriptObject(dep.sha256, dep.bytes, this.objects)) throw new Error("HISTORY_UNPROVEN_DEPENDENCY");
      }
    } finally { db.close(); }
    const status = sidecar(path + ".verified.json");
    const manifest: Manifest = {schema: 1, id, session, generation: meta.generation, cacheIdentity,
      cache: await digest(pin), sidecar: status, dependencies};
    const manifestPath = join(folder, "manifest.json");
    publish(manifestPath, manifest);
    const paths = [pin, manifestPath, ...dependencies.map(dep => this.object(dep))];
    const snapshot = await this.restic.backup(paths, `concierge-history-cache:${id}`);
    if (!SHA.test(snapshot)) throw new Error("HISTORY_BACKUP_SNAPSHOT_UNKNOWN");
    for (const file of paths) {
      const expected = file === pin ? manifest.cache : file === manifestPath ? await digest(file)
        : dependencies.find(dep => this.object(dep) === file)!;
      if (!isDeepStrictEqual(await this.restic.readback(snapshot, file), expected)) throw new Error("HISTORY_BACKUP_READBACK_FAILED");
    }
    // A hash-equal full offsite stream is this integrity-checked SQLite file.
    // Neither a partial backup nor an unverified stream can create the receipt.
    publish(join(folder, "receipt.json"), {schema: 1, snapshot, manifest: await digest(manifestPath), verifiedAt: new Date().toISOString()});
    return {id, session, snapshot, generation: meta.generation, dependencies: dependencies.length,
      durationMs: performance.now() - started, pinAllocatedBytes: lstatSync(pin).blocks * 512};
  }
  async proof(id: string, matchLive = true, requirePin = true): Promise<Manifest> {
    const folder = this.batch(id), manifestPath = join(folder, "manifest.json");
    const receipt = JSON.parse(readFileSync(join(folder, "receipt.json"), "utf8"));
    if (receipt.schema !== 1 || !SHA.test(receipt.snapshot) || !isDeepStrictEqual(receipt.manifest, await digest(manifestPath)))
      throw new Error("HISTORY_CACHE_BACKUP_NOT_PROVEN");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    if (manifest.schema !== 1 || manifest.id !== id || !UUID.test(manifest.session)) throw new Error("INVALID_HISTORY_BACKUP_MANIFEST");
    const pin = join(folder, "cache.sqlite");
    if (requirePin && (!isDeepStrictEqual(identity(pin), manifest.cacheIdentity) || !isDeepStrictEqual(await digest(pin), manifest.cache)))
      throw new Error("HISTORY_BACKUP_PIN_CHANGED");
    if (matchLive) {
      requireClosedSnapshot(this.cache(manifest.session));
      if (!isDeepStrictEqual(identity(this.cache(manifest.session)), manifest.cacheIdentity)
        || sidecar(this.cache(manifest.session) + ".verified.json") !== manifest.sidecar) throw new Error("HISTORY_CACHE_GENERATION_CHANGED");
    }
    if (requirePin) {
      const db = openSnapshot(pin);
      try {
        checkSqliteBackup(db);
        if ((db.query("SELECT generation FROM meta").get() as any)?.generation !== manifest.generation) throw new Error("HISTORY_CACHE_GENERATION_CHANGED");
      } finally { db.close(); }
    }
    if (!Array.isArray(manifest.dependencies) || !manifest.dependencies.length) throw new Error("INVALID_HISTORY_DEPENDENCIES");
    for (const dep of manifest.dependencies) this.object(dep);
    return manifest;
  }
  async migrate(id: string) {
    const started = performance.now();
    this.quiescent();
    const manifest = await this.proof(id), path = this.cache(manifest.session), folder = this.batch(id);
    if (existsSync(join(folder, "result.json"))) throw new Error("HISTORY_BATCH_ALREADY_APPLIED");
    for (const dep of manifest.dependencies) {
      if (!await provenHostTranscriptObject(dep.sha256, dep.bytes, this.objects)) throw new Error("HISTORY_UNPROVEN_DEPENDENCY");
    }
    const result = await migrateHistorySnapshot(manifest.session, {
      path, quiescent: this.quiescent, validate: async () => { await this.proof(id); },
      decode: json => decodeStoredSdkRow(json, this.objects),
      beforePublish: async next => {
        publish(join(folder, "conversion.json"), {changed: true, after: await digest(next)});
      },
      prove: async (sha, bytes) => manifest.dependencies.some(dep => dep.sha256 === sha && dep.bytes === bytes)
        ? provenHostTranscriptObject(sha, bytes, this.objects) : null,
    });
    if (result.changed) carryVerifierStatus(path, manifest.generation, manifest.sidecar);
    const pin = join(folder, "cache.sqlite"), retainedPinAllocatedBytes = result.changed ? lstatSync(pin).blocks * 512 : 0;
    const mirror = openSnapshot(path);
    let mirrorAllocatedBytes: number;
    try { mirrorAllocatedBytes = lstatSync((mirror.query("SELECT source_path FROM meta").get() as any).source_path).blocks * 512; }
    finally { mirror.close(); }
    const report = {...result, id, before: manifest.cache, after: await digest(path), retainedPinAllocatedBytes,
      durationMs: performance.now() - started, mirrorAllocatedBytes,
      allocatedBeforeIncludingMirrorBytes: result.allocatedBeforeBytes + mirrorAllocatedBytes,
      allocatedAfterIncludingMirrorAndPinBytes: result.allocatedAfterBytes + mirrorAllocatedBytes + retainedPinAllocatedBytes,
      netAllocatedSavedBytes: result.allocatedSavedBytes - retainedPinAllocatedBytes};
    publish(join(folder, "result.json"), report);
    return report;
  }
  async materialize(session: string) {
    this.quiescent();
    const path = this.cache(session), status = sidecar(path + ".verified.json"), db = openSnapshot(path);
    const generation = (db.query("SELECT generation FROM meta").get() as any).generation;
    const dependencies = new Map<string, number>();
    try {
      for (const row of db.query("SELECT json FROM rows WHERE json LIKE '%\"conciergeRawReference\":1%'").iterate() as IterableIterator<any>) {
        const ref = JSON.parse(row.json);
        if (ref?.conciergeRawReference === 1) dependencies.set(ref.objectSha256, ref.objectBytes);
      }
    } finally { db.close(); }
    for (const [sha256, bytes] of dependencies) {
      const path = this.object({sha256, bytes});
      if (!existsSync(path)) {
        if (this.objects !== OBJECTS) throw new Error("HISTORY_OBJECT_UNAVAILABLE");
        const restored = Bun.spawn(["python3", "/root/workspace/remote-box/scripts/transcript_objects.py", "restore", sha256],
          {stdout: "ignore", stderr: "ignore"});
        if (await restored.exited !== 0) throw new Error("HISTORY_OBJECT_RESTORE_FAILED");
      }
      if (!await provenHostTranscriptObject(sha256, bytes, this.objects)) throw new Error("HISTORY_UNPROVEN_DEPENDENCY");
    }
    const result = await materializeHistorySnapshot({path, quiescent: this.quiescent,
      validate: async () => {}, prove: provenHostTranscriptObject,
      decode: json => decodeStoredSdkRow(json, this.objects)});
    if (result.changed) carryVerifierStatus(path, generation, status);
    return result;
  }
  async restore(id: string) {
    this.quiescent();
    const manifest = await this.proof(id, false, false), path = this.cache(manifest.session);
    const folder = this.batch(id);
    const result = JSON.parse(readFileSync(join(folder, existsSync(join(folder, "result.json")) ? "result.json" : "conversion.json"), "utf8"));
    const before = existsSync(path) ? await digest(path) : null;
    if (!result.changed || before !== null && !isDeepStrictEqual(before, result.after)) throw new Error("HISTORY_ROLLBACK_TARGET_CHANGED");
    const temporary = `${path}.${randomUUID()}.rollback`;
    try {
      const pin = join(folder, "cache.sqlite");
      if (existsSync(pin)) {
        await this.proof(id, false);
        linkSync(pin, temporary);
      } else {
        const receipt = JSON.parse(readFileSync(join(folder, "receipt.json"), "utf8"));
        if (!isDeepStrictEqual(await this.restic.readback(receipt.snapshot, pin, temporary), manifest.cache)) throw new Error("HISTORY_BACKUP_READBACK_FAILED");
      }
      const db = openSnapshot(temporary);
      try {
        checkSqliteBackup(db);
        if ((db.query("SELECT generation FROM meta").get() as any)?.generation !== manifest.generation) throw new Error("HISTORY_CACHE_GENERATION_CHANGED");
      } finally { db.close(); }
      this.quiescent();
      if (!isDeepStrictEqual(existsSync(path) ? await digest(path) : null, before)) throw new Error("HISTORY_ROLLBACK_TARGET_CHANGED");
      renameSync(temporary, path); sync(dirname(path));
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    replaceSidecar(path + ".verified.json", manifest.sidecar);
    return {restored: manifest.generation};
  }
  async release(id: string) {
    const manifest = await this.proof(id, false, false), folder = this.batch(id), path = this.cache(manifest.session);
    if (existsSync(join(folder, "release.json"))) return JSON.parse(readFileSync(join(folder, "release.json"), "utf8"));
    const result = JSON.parse(readFileSync(join(folder, "result.json"), "utf8"));
    if (!isDeepStrictEqual(await digest(path), result.after)) throw new Error("HISTORY_RELEASE_TARGET_CHANGED");
    const pin = join(folder, "cache.sqlite"), intent = join(folder, "release-intent.json");
    if (existsSync(pin)) {
      await this.proof(id, false);
      const stat = lstatSync(pin), releasedBytes = stat.nlink === 1 ? stat.blocks * 512 : 0;
      if (!existsSync(intent)) publish(intent, {releasedBytes,
        netAllocatedSavedBytes: result.allocatedSavedBytes - result.retainedPinAllocatedBytes + releasedBytes});
      unlinkSync(pin); sync(folder);
    }
    // A crash after unlink can finish its receipt without replaying a release.
    const released = JSON.parse(readFileSync(intent, "utf8"));
    publish(join(folder, "release.json"), released);
    return released;
  }
  async queue(id: string) {
    await this.proof(id);
    publish(join(this.root, "pending.json"), {id});
    return {queued: id};
  }
  async applyPending() {
    const pending = join(this.root, "pending.json");
    if (!existsSync(pending)) return {status: "no_pending_batch"};
    const {id} = JSON.parse(readFileSync(pending, "utf8"));
    let result;
    try { result = await this.migrate(id); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== "HISTORY_CACHE_GENERATION_CHANGED") throw error;
      result = {status: "skipped_changed_generation", id};
      publish(join(this.batch(id), "skipped.json"), result);
    }
    unlinkSync(pending); sync(this.root);
    return result;
  }
}

if (import.meta.main) {
  const state = process.env.CONCIERGE_STATE_DIR || join(homedir(), ".local/state/concierge");
  const args = process.argv.slice(2);
  if (args[0] !== "--locked") {
    const root = join(state, "history-cache-maintenance");
    mkdirSync(root, {recursive: true, mode: 0o700});
    const child = Bun.spawn(["flock", "--nonblock", join(root, "operation.lock"), process.execPath,
      process.argv[1]!, "--locked", ...args], {stdout: "inherit", stderr: "inherit"});
    process.exit(await child.exited);
  }
  const [command, id] = args.slice(1);
  if (command === "prepare" || command === "release") requireStoppedServices(["remote-box-backup.service"]);
  const maintenance = new HistoryCacheMaintenance(state, new HostCacheRestic());
  const result = command === "prepare" && id ? await maintenance.prepare(id)
    : command === "queue" && id ? await maintenance.queue(id)
    : command === "apply-pending" ? await maintenance.applyPending()
    : command === "materialize" && id ? await maintenance.materialize(id)
    : command === "restore" && id ? await maintenance.restore(id)
    : command === "release" && id ? await maintenance.release(id)
    : (() => { throw new Error("USAGE: history-cache prepare|queue|materialize|restore|release <id> | apply-pending"); })();
  console.log(JSON.stringify(result));
}
