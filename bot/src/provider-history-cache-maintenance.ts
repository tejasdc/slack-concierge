/** One closed cache generation, pinned locally and independently read back from Restic. */
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { open } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { checkSqliteBackup } from "./verified-sqlite-backup";
import { decodeStoredSdkRow, provenHostTranscriptObject } from "./provider-history-object-spans";
import { materializeHistorySnapshot, migrateHistorySnapshot, publishPreparedHistorySnapshot, requireQuiescentHost, type ConversionGate } from "./provider-history-object-migrate";
import {HISTORY_CACHE_READER_FORMAT,historyCacheRequirements,assertHistoryCacheReader} from "./provider-history-cache-compatibility";
import {CACHE_BACKUP_POLICY, CacheBackupAdmission} from "./provider-history-cache-admission";
import {logToStderr} from "./log";
import {ledgerRows} from "./ledger-rows";

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
function publishOnce(path: string,value: unknown) {
  if(existsSync(path)) {
    if(!isDeepStrictEqual(JSON.parse(readFileSync(path,"utf8")),value))throw new Error("HISTORY_OPERATION_CONFLICT");
  } else publish(path,value);
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
  constructor(readonly command = [RESTIC], readonly admission?: CacheBackupAdmission) {}
  private async run(args: string[], payload: boolean, target?: string) {
    this.admission?.check();
    const scratch=mkdtempSync(join(this.admission?.folder??tmpdir(),"native-restic-"));
    const destination = target ? await open(target, "wx", 0o600) : null;
    // GNU timeout owns and forwards termination to its process group, including
    // Restic's SFTP transport. Never signal an inferred or already-reaped PGID.
    const child = Bun.spawn(["timeout", `--kill-after=${CACHE_BACKUP_POLICY.killGraceMs/1000}s`, `${CACHE_BACKUP_POLICY.maxMs / 1000}s`,
      "nice", "-n", String(CACHE_BACKUP_POLICY.nice), ...this.command, "--no-cache", "--limit-upload", String(CACHE_BACKUP_POLICY.transferKiB),
      "--limit-download", String(CACHE_BACKUP_POLICY.transferKiB), "--pack-size", String(CACHE_BACKUP_POLICY.packMiB),
      "-o", `sftp.connections=${CACHE_BACKUP_POLICY.sftpConnections}`, ...args],
      { stdout: "pipe", stderr: "ignore", env: {...process.env, TMPDIR:scratch,GOMAXPROCS: String(CACHE_BACKUP_POLICY.goProcessors)} });
    this.admission?.ownNative(() => child.kill("SIGTERM"));
    let bytes = 0, control = "";
    const hash = createHash("sha256");
    try {
      this.admission?.observeProcess();
      for await (const chunk of child.stdout) {
        this.admission?.check();
        this.admission?.observeProcess();
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
      this.admission?.check();
      if (exit !== 0) throw new Error(`HISTORY_RESTIC_FAILED_${args[0]}_EXIT_${exit}`);
      await destination?.sync();
      return { sha256: hash.digest("hex"), bytes, control };
    } finally {
      child.kill("SIGTERM"); await child.exited; this.admission?.ownNative(); await destination?.close();
      rmSync(scratch,{recursive:true,force:true});
    }
  }
  async backup(paths: string[], tag: string) {
    // A process exit after the server accepted a snapshot must not cause a new
    // backup merely to obtain another receipt. Full readback still proves bytes.
    const found = await this.run(["snapshots", "--json", "--tag", tag], false);
    const snapshots = JSON.parse(found.control);
    if (!Array.isArray(snapshots) || snapshots.length > 1) throw new Error("HISTORY_BACKUP_SNAPSHOT_AMBIGUOUS");
    if (snapshots.length === 1) {
      if (!SHA.test(snapshots[0]?.id)) throw new Error("HISTORY_BACKUP_SNAPSHOT_UNKNOWN");
      return snapshots[0].id as string;
    }
    const output = await this.run(["backup", "--json", "--quiet", "--no-scan", "--read-concurrency", String(CACHE_BACKUP_POLICY.readers), "--tag", tag, ...paths], false);
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
    readonly quiescent = requireQuiescentHost, readonly objects = OBJECTS,
    readonly checkpoint: (point: string) => void = () => {}, readonly admission?: CacheBackupAdmission) {
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
  requireReader(session: string) {
    const directory=historyCacheRequirements(this.state);
    mkdirSync(directory,{recursive:true,mode:0o700}); sync(this.root);
    publishOnce(join(directory,`${session}.json`),HISTORY_CACHE_READER_FORMAT);
  }
  clearReaderIfFull(session: string) {
    const db=openSnapshot(this.cache(session));
    try {
      for(const row of ledgerRows<any>(db,"SELECT json FROM rows WHERE json LIKE '%\"conciergeRawReference\":1%'"))
        if(JSON.parse(row.json)?.conciergeRawReference===1)return;
    } finally {db.close();}
    const marker=join(historyCacheRequirements(this.state),`${session}.json`);
    if(existsSync(marker)){unlinkSync(marker);sync(dirname(marker));}
  }
  async prepare(session: string) {
    const path = this.cache(session), id = randomUUID(), folder = this.batch(id), pin = join(folder, "cache.sqlite");
    this.admission?.limit(identity(path).size);
    mkdirSync(this.root, {recursive: true, mode: 0o700});
    sync(this.state);
    mkdirSync(folder, {mode: 0o700});
    sync(this.root);
    logToStderr("info","history_cache_backup_started",{id,session});
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
      for (const row of ledgerRows<any>(db,"SELECT json FROM rows WHERE json LIKE '%\"conciergeRawReference\":1%'")) {
        const ref = JSON.parse(row.json);
        if (ref?.conciergeRawReference !== 1) continue;
        const dep = {sha256: ref.objectSha256, bytes: ref.objectBytes};
        if (refs.has(dep.sha256) && refs.get(dep.sha256)!.bytes !== dep.bytes) throw new Error("HISTORY_AMBIGUOUS_DEPENDENCY");
        refs.set(dep.sha256, dep);
      }
      // Only the exact, unchanged mirror version can add new references. A missing
      // source leaves existing full rows available, but cannot authorize new ones.
      const source = identity(meta.source_path);
      this.admission?.limit(cacheIdentity.size + source.size + [...refs.values()].reduce((sum, dep) => sum + dep.bytes, 0));
      if (source.size !== meta.source_size || source.mtimeMs !== meta.source_mtime_ms) throw new Error("HISTORY_SOURCE_CHANGED");
      const candidate = await digest(meta.source_path);
      if (await provenHostTranscriptObject(candidate.sha256, candidate.bytes, this.objects)) refs.set(candidate.sha256, candidate);
      dependencies = [...refs.values()];
      this.admission?.limit(cacheIdentity.size + source.size + dependencies.reduce((sum, dep) => sum + dep.bytes, 0));
      if (!dependencies.length) throw new Error("HISTORY_NO_PROVEN_OBJECT");
      for (const dep of dependencies) {
        if (!await provenHostTranscriptObject(dep.sha256, dep.bytes, this.objects)) throw new Error("HISTORY_UNPROVEN_DEPENDENCY");
      }
    } finally { db.close(); }
    const status = sidecar(path + ".verified.json");
    const manifest: Manifest = {schema: 1, id, session, generation: meta.generation, cacheIdentity,
      cache: await digest(pin), sidecar: status, dependencies};
    const manifestPath = join(folder, "manifest.json");
    this.admission?.check();
    publish(manifestPath, manifest);
    return this.prove(id, started);
  }
  async prove(id: string, started = performance.now()) {
    const folder=this.batch(id),manifestPath=join(folder,"manifest.json"),pin=join(folder,"cache.sqlite");
    const manifest=JSON.parse(readFileSync(manifestPath,"utf8")) as Manifest;
    if(manifest.schema!==1 || manifest.id!==id || !UUID.test(manifest.session))throw new Error("INVALID_HISTORY_BACKUP_MANIFEST");
    this.admission?.limit(manifest.cache.bytes + manifest.dependencies.reduce((sum,dep)=>sum+dep.bytes,0));
    if(!isDeepStrictEqual(identity(pin),manifest.cacheIdentity) || !isDeepStrictEqual(await digest(pin),manifest.cache))throw new Error("HISTORY_BACKUP_PIN_CHANGED");
    if(existsSync(join(folder,"receipt.json"))) {
      await this.proof(id,false);
      const receipt=JSON.parse(readFileSync(join(folder,"receipt.json"),"utf8"));
      return {id,session:manifest.session,alreadyProven:true,snapshot:receipt.snapshot as string,generation:manifest.generation,
        dependencies:manifest.dependencies.length,durationMs:performance.now()-started,pinAllocatedBytes:lstatSync(pin).blocks*512};
    }
    if(existsSync(join(folder,"backup-failed.json")))throw new Error("HISTORY_BACKUP_FAILED_NEW_BATCH_REQUIRED");
    for(const dep of manifest.dependencies)if(!await provenHostTranscriptObject(dep.sha256,dep.bytes,this.objects))throw new Error("HISTORY_UNPROVEN_DEPENDENCY");
    const paths = [pin, manifestPath, ...manifest.dependencies.map(dep => this.object(dep))];
    const backupPath=join(folder,"backup.json");
    let snapshot: string;
    if(existsSync(backupPath))snapshot=JSON.parse(readFileSync(backupPath,"utf8")).snapshot;
    else try {
      snapshot=await this.restic.backup(paths, `concierge-history-cache:${id}`);
      if(!SHA.test(snapshot))throw new Error("HISTORY_BACKUP_SNAPSHOT_UNKNOWN");
      publish(backupPath,{schema:1,snapshot});
    } catch(error) {
      publishOnce(join(folder,"backup-failed.json"),{schema:1,error:error instanceof Error?error.message:"HISTORY_BACKUP_UNKNOWN"});throw error;
    }
    if (!SHA.test(snapshot)) throw new Error("HISTORY_BACKUP_SNAPSHOT_UNKNOWN");
    for (const file of paths) {
      const expected = file === pin ? manifest.cache : file === manifestPath ? await digest(file)
        : manifest.dependencies.find(dep => this.object(dep) === file)!;
      if (!isDeepStrictEqual(await this.restic.readback(snapshot, file), expected)) throw new Error("HISTORY_BACKUP_READBACK_FAILED");
    }
    // A hash-equal full offsite stream is this integrity-checked SQLite file.
    // Neither a partial backup nor an unverified stream can create the receipt.
    this.admission?.check();
    publish(join(folder, "receipt.json"), {schema: 1, snapshot, manifest: await digest(manifestPath), verifiedAt: new Date().toISOString()});
    return {id, session:manifest.session, snapshot, generation: manifest.generation, dependencies: manifest.dependencies.length,
      durationMs: performance.now() - started, pinAllocatedBytes: lstatSync(pin).blocks * 512};
  }
  async proof(id: string, matchLive = true, requirePin = true): Promise<Manifest> {
    const folder = this.batch(id), manifestPath = join(folder, "manifest.json");
    const receipt = JSON.parse(readFileSync(join(folder, "receipt.json"), "utf8"));
    if (receipt.schema !== 1 || !SHA.test(receipt.snapshot) || !isDeepStrictEqual(receipt.manifest, await digest(manifestPath)))
      throw new Error("HISTORY_CACHE_BACKUP_NOT_PROVEN");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    if (manifest.schema !== 1 || manifest.id !== id || !UUID.test(manifest.session)) throw new Error("INVALID_HISTORY_BACKUP_MANIFEST");
    this.admission?.limit(manifest.cache.bytes+manifest.dependencies.reduce((sum,dep)=>sum+dep.bytes,0));
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
    const manifest = await this.proof(id,false), path = this.cache(manifest.session), folder = this.batch(id);
    if(existsSync(join(folder,"restore-intent.json")))throw new Error(existsSync(join(folder,"restore.json"))
      ? "HISTORY_CONVERSION_ROLLED_BACK" : "HISTORY_CONVERSION_ROLLBACK_PENDING");
    const intentPath=join(folder,"conversion.json"), prepared=join(folder,`converted-${randomUUID()}.sqlite`), resultPath=join(folder,"result.json");
    const live=await digest(path);
    if(existsSync(resultPath)) {
      const result=JSON.parse(readFileSync(resultPath,"utf8"));
      if(!isDeepStrictEqual(live,result.after))throw new Error("HISTORY_CACHE_GENERATION_CHANGED");
      return result;
    }
    for (const dep of manifest.dependencies) {
      if (!await provenHostTranscriptObject(dep.sha256, dep.bytes, this.objects)) throw new Error("HISTORY_UNPROVEN_DEPENDENCY");
    }
    const gate: ConversionGate={
      path, stagingPath:prepared, keepPrepared:()=>existsSync(intentPath), quiescent: this.quiescent,
      afterCopy:()=>this.checkpoint("conversion_staged"),
      validate: async () => {
        this.admission?.check();
        requireClosedSnapshot(path);
        if(!isDeepStrictEqual(identity(path),manifest.cacheIdentity)
          || sidecar(path+".verified.json")!==manifest.sidecar)throw new Error("HISTORY_CACHE_GENERATION_CHANGED");
        const db=openSnapshot(path);
        try {
          const meta=db.query("SELECT source_path,source_size,source_mtime_ms FROM meta").get() as any;
          const source=identity(meta.source_path);
          if(source.size!==meta.source_size || source.mtimeMs!==meta.source_mtime_ms)throw new Error("HISTORY_SOURCE_CHANGED");
        } finally {db.close();}
      },
      decode: json => decodeStoredSdkRow(json, this.objects),
      beforePublish: async (next,result) => {
        const report=await this.conversionReport(id,manifest,result,next,performance.now()-started);
        this.admission?.check();
        this.requireReader(manifest.session);
        publishOnce(intentPath,{schema:1,changed:true,before:manifest.cache,after:report.after,result:report,prepared:basename(next)});
        this.checkpoint("conversion_intent");
      },
      prove: async (sha, bytes) => manifest.dependencies.some(dep => dep.sha256 === sha && dep.bytes === bytes)
        ? provenHostTranscriptObject(sha, bytes, this.objects) : null,
    };
    if(existsSync(intentPath)) {
      const intent=JSON.parse(readFileSync(intentPath,"utf8"));
      if(intent.schema!==1 || !isDeepStrictEqual(intent.before,manifest.cache) || !intent.result
        || !isDeepStrictEqual(intent.after,intent.result.after))throw new Error("HISTORY_CONVERSION_INTENT_INVALID");
      if(isDeepStrictEqual(live,manifest.cache)) {
        const name=intent.prepared??"converted.sqlite";
        if(!/^converted(?:-[a-f0-9-]{36})?\.sqlite$/.test(name))throw new Error("HISTORY_PREPARED_GENERATION_CHANGED");
        const accepted=join(folder,name);
        if(!isDeepStrictEqual(await digest(accepted),intent.after))throw new Error("HISTORY_PREPARED_GENERATION_CHANGED");
        await publishPreparedHistorySnapshot(gate,accepted);
      } else if(!isDeepStrictEqual(live,intent.after))throw new Error("HISTORY_CONVERSION_TARGET_AMBIGUOUS");
      return this.finishConversion(id,manifest,intent.result,true);
    }
    await gate.validate();
    const result=await migrateHistorySnapshot(manifest.session,gate);
    if(result.changed) {
      const intent=JSON.parse(readFileSync(intentPath,"utf8"));
      return this.finishConversion(id,manifest,intent.result,false);
    }
    const report=await this.conversionReport(id,manifest,result,path,performance.now()-started);
    publishOnce(resultPath,report);
    return report;
  }
  async conversionReport(id:string,manifest:Manifest,result:{changed:boolean},next:string,durationMs:number) {
    const path=this.cache(manifest.session), before=lstatSync(join(this.batch(id),"cache.sqlite")).blocks*512;
    const after=lstatSync(next).blocks*512, retainedPinAllocatedBytes=result.changed?before:0;
    const retainedStagingAllocatedBytes=readdirSync(this.batch(id)).filter(name=>/^converted(?:-[a-f0-9-]{36})?\.sqlite$/.test(name))
      .map(name=>join(this.batch(id),name)).filter(path=>path!==next).reduce((sum,path)=>sum+lstatSync(path).blocks*512,0);
    const mirror = openSnapshot(path);
    let mirrorAllocatedBytes: number;
    try { mirrorAllocatedBytes = lstatSync((mirror.query("SELECT source_path FROM meta").get() as any).source_path).blocks * 512; }
    finally { mirror.close(); }
    return {...result,id,before:manifest.cache,after:await digest(next),retainedPinAllocatedBytes,retainedStagingAllocatedBytes,durationMs,mirrorAllocatedBytes,
      allocatedBeforeBytes:before,allocatedAfterBytes:after,allocatedSavedBytes:before-after,
      allocatedBeforeIncludingMirrorBytes:before+mirrorAllocatedBytes,
      allocatedAfterIncludingMirrorAndPinBytes:after+mirrorAllocatedBytes+retainedPinAllocatedBytes+retainedStagingAllocatedBytes,
      netAllocatedSavedBytes:before-after-retainedPinAllocatedBytes-retainedStagingAllocatedBytes};
  }
  async finishConversion(id:string,manifest:Manifest,report:any,recovered:boolean) {
    const path=this.cache(manifest.session);
    if(!isDeepStrictEqual(await digest(path),report.after))throw new Error("HISTORY_CONVERSION_TARGET_AMBIGUOUS");
    this.admission?.check();
    this.requireReader(manifest.session);
    this.checkpoint("conversion_published");
    const db=openSnapshot(path);
    let generation:string;
    try {generation=(db.query("SELECT generation FROM meta").get() as any).generation;} finally {db.close();}
    let current:any;
    try {current=JSON.parse(sidecar(path+".verified.json")??"null");} catch {}
    // A verifier that already checkpointed this exact new generation is newer
    // evidence; a resumed publication must not replace it with the old checkpoint.
    if(current?.generation!==generation)carryVerifierStatus(path,manifest.generation,manifest.sidecar);
    this.checkpoint("conversion_sidecar");
    const completed={...report,recovered};
    publishOnce(join(this.batch(id),"result.json"),completed);
    this.checkpoint("conversion_result");
    return completed;
  }
  async materialize(session: string) {
    this.quiescent();
    const path = this.cache(session), status = sidecar(path + ".verified.json");
    this.admission?.limit(identity(path).size);
    const db = openSnapshot(path);
    const generation = (db.query("SELECT generation FROM meta").get() as any).generation;
    const dependencies = new Map<string, number>();
    try {
      for (const row of ledgerRows<any>(db,"SELECT json FROM rows WHERE json LIKE '%\"conciergeRawReference\":1%'")) {
        const ref = JSON.parse(row.json);
        if (ref?.conciergeRawReference === 1) dependencies.set(ref.objectSha256, ref.objectBytes);
      }
    } finally { db.close(); }
    this.admission?.limit(identity(path).size+[...dependencies.values()].reduce((sum,size)=>sum+size,0));
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
    this.clearReaderIfFull(session);
    return result;
  }
  async restore(id: string) {
    this.quiescent();
    const manifest = await this.proof(id, false, false), path = this.cache(manifest.session);
    const folder = this.batch(id);
    const result = JSON.parse(readFileSync(join(folder, existsSync(join(folder, "result.json")) ? "result.json" : "conversion.json"), "utf8"));
    const before = existsSync(path) ? await digest(path) : null;
    if (!result.changed || before !== null && !isDeepStrictEqual(before, result.after)
      && !isDeepStrictEqual(before,manifest.cache)) throw new Error("HISTORY_ROLLBACK_TARGET_CHANGED");
    const intentPath=join(folder,"restore-intent.json");
    if(!existsSync(intentPath))publish(intentPath,{schema:1,before:result.after,after:manifest.cache,
      beforeSidecar:sidecar(path+".verified.json")});
    const intent=JSON.parse(readFileSync(intentPath,"utf8"));
    if(intent.schema!==1 || !isDeepStrictEqual(intent.before,result.after) || !isDeepStrictEqual(intent.after,manifest.cache))
      throw new Error("HISTORY_ROLLBACK_INTENT_INVALID");
    const status=sidecar(path+".verified.json");
    if(status!==intent.beforeSidecar && status!==manifest.sidecar)throw new Error("HISTORY_ROLLBACK_VERIFIER_CHANGED");
    const temporary = `${path}.${randomUUID()}.rollback`;
    if(!isDeepStrictEqual(before,manifest.cache))try {
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
      this.admission?.check();
      if (!isDeepStrictEqual(existsSync(path) ? await digest(path) : null, before)) throw new Error("HISTORY_ROLLBACK_TARGET_CHANGED");
      renameSync(temporary, path); sync(dirname(path));
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    this.checkpoint("restore_published");
    this.admission?.check();
    replaceSidecar(path + ".verified.json", manifest.sidecar);
    this.checkpoint("restore_sidecar");
    this.clearReaderIfFull(manifest.session);
    const restored={restored:manifest.generation};
    publishOnce(join(folder,"restore.json"),restored);
    return restored;
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
        netAllocatedSavedBytes: result.netAllocatedSavedBytes + releasedBytes});
      this.admission?.check();
      unlinkSync(pin); sync(folder);
    }
    // A crash after unlink can finish its receipt without replaying a release.
    const released = JSON.parse(readFileSync(intent, "utf8"));
    publish(join(folder, "release.json"), released);
    return released;
  }
  async queue(id: string) {
    if(existsSync(join(this.root,"attempt.json")))throw new Error("HISTORY_OPTIONAL_ATTEMPT_REQUIRES_RECOVERY");
    const folder=this.batch(id),manifest=await this.proof(id,false);
    if(existsSync(join(folder,"restore-intent.json")))throw new Error("HISTORY_CONVERSION_ROLLBACK_PENDING");
    if(existsSync(join(folder,"conversion.json"))) {
      const intent=JSON.parse(readFileSync(join(folder,"conversion.json"),"utf8")),live=await digest(this.cache(manifest.session));
      if(intent.schema!==1 || !isDeepStrictEqual(intent.before,manifest.cache) || !intent.result
        || !isDeepStrictEqual(intent.after,intent.result.after))throw new Error("HISTORY_CONVERSION_INTENT_INVALID");
      if(!isDeepStrictEqual(live,intent.after))await this.proof(id);
    } else await this.proof(id);
    publishOnce(join(this.root, "pending.json"), {id});
    return {queued: id};
  }
  status(id?:string) {
    const read=(path:string)=>existsSync(path)?JSON.parse(readFileSync(path,"utf8")):null;
    if(!id)return {pending:read(join(this.root,"pending.json")),attempt:read(join(this.root,"attempt.json"))};
    const folder=this.batch(id),manifest=read(join(folder,"manifest.json"));
    return {id,session:manifest?.session,generation:manifest?.generation,retainedPin:existsSync(join(folder,"cache.sqlite")),
      backup:read(join(folder,"receipt.json")),conversionIntent:!!read(join(folder,"conversion.json")),
      acceptedSnapshot:read(join(folder,"backup.json")),backupFailure:read(join(folder,"backup-failed.json")),
      result:read(join(folder,"result.json")),rollback:read(join(folder,"restore.json")),
      failures:readdirSync(folder).filter(name=>/^failure-[a-f0-9-]+\.json$/.test(name)).map(name=>read(join(folder,name)))};
  }
  async applyPending() {
    const pending = join(this.root, "pending.json");
    // Consume the queue before attempting work. A durable attempt can be resumed
    // deliberately; a failed optional batch never becomes every release's job.
    const attempt=join(this.root,"attempt.json");
    if(!existsSync(attempt)) {
      if (!existsSync(pending)) return {status: "no_pending_batch"};
      renameSync(pending,attempt);sync(this.root);
    }
    const {id} = JSON.parse(readFileSync(attempt, "utf8"));
    let result;
    try { result = await this.migrate(id); }
    catch (error) {
      const message=error instanceof Error?error.message:"HISTORY_OPTIONAL_CONVERSION_FAILED";
      // Exact operation state stays with its batch, including any prepared or
      // published generation; never call a published conversion a stale skip.
      const folder=this.batch(id);
      let rollback="not_needed",rollbackError:string|undefined;
      if(existsSync(join(folder,"conversion.json"))) {
        try {
          const manifest=await this.proof(id,false),intent=JSON.parse(readFileSync(join(folder,"conversion.json"),"utf8"));
          const current=await digest(this.cache(manifest.session));
          if(isDeepStrictEqual(current,intent.after) || existsSync(join(folder,"restore-intent.json"))) {
            await this.restore(id);rollback="restored_original";
          } else if(!isDeepStrictEqual(current,manifest.cache))rollback="target_changed_preserved";
        } catch(recoveryError) {
          rollback="unresolved_preserved";rollbackError=recoveryError instanceof Error?recoveryError.message:"HISTORY_RECOVERY_UNKNOWN";
        }
      }
      result={status:message==="HISTORY_CACHE_GENERATION_CHANGED" && !existsSync(join(folder,"conversion.json"))
        ? "skipped_changed_generation" : "failed_optional_conversion",id,error:message,rollback,...(rollbackError?{rollbackError}:{})};
      publish(join(folder,`failure-${randomUUID()}.json`),result);
      try {
        const manifest=await this.proof(id,false);
        this.clearReaderIfFull(manifest.session);
      } catch { /* Keep unknown custody fenced by the required-reader marker. */ }
    }
    const folder=this.batch(id);
    renameSync(attempt,join(folder,`attempt-${randomUUID()}.json`));sync(folder);sync(this.root);
    return result;
  }
}

if (import.meta.main) {
  const state = process.env.CONCIERGE_STATE_DIR || join(homedir(), ".local/state/concierge");
  const args = process.argv.slice(2);
  if (args[0] !== "--locked") {
    const root = join(state, "history-cache-maintenance");
    mkdirSync(root, {recursive: true, mode: 0o700});
    const child = Bun.spawn(["flock", "--nonblock", join(root, "operation.lock"),
      "timeout", `--kill-after=${CACHE_BACKUP_POLICY.killGraceMs/1000}s`, `${CACHE_BACKUP_POLICY.maxMs/1000}s`, "nice", "-n", String(CACHE_BACKUP_POLICY.nice), process.execPath,
      process.argv[1]!, "--locked", ...args], {stdout: "inherit", stderr: "inherit"});
    process.exit(await child.exited);
  }
  const [command, id] = args.slice(1);
  if(command==="check-readers") {
    const artifacts=args.slice(2);
    if(!artifacts.length)throw new Error("HISTORY_CACHE_READER_NOT_PROVEN");
    for(const artifact of artifacts) {
      const files=JSON.parse(readFileSync(join(artifact,"manifest.json"),"utf8")).files;
      assertHistoryCacheReader(artifact,files);assertHistoryCacheReader(artifact,files,true);
    }
    process.stdout.write(JSON.stringify({status:"history_cache_readers_proven"})+"\n");process.exit(0);
  }
  const admission = command === "status" ? undefined : new CacheBackupAdmission(join(state,"history-cache-maintenance"));
  const maintenance = new HistoryCacheMaintenance(state, new HostCacheRestic(undefined,admission),requireQuiescentHost,OBJECTS,undefined,admission);
  let result, failure: unknown;
  try {
  await admission?.start();
  result = command === "prepare" && id ? await maintenance.prepare(id)
    : command === "prove" && id ? await maintenance.prove(id)
    : command === "queue" && id ? await maintenance.queue(id)
    : command === "apply-pending" ? await maintenance.applyPending()
    : command === "resume" && id ? await maintenance.migrate(id)
    : command === "status" ? maintenance.status(id)
    : command === "materialize" && id ? await maintenance.materialize(id)
    : command === "restore" && id ? await maintenance.restore(id)
    : command === "release" && id ? await maintenance.release(id)
    : (() => { throw new Error("USAGE: history-cache prepare|prove|queue|resume|materialize|restore|release <id> | status [id] | apply-pending | check-readers <artifacts...>"); })();
  admission?.check();
  } catch(error) {failure=error;throw error;}
  finally {if(admission)logToStderr("info","history_cache_load",admission.finish(failure));}
  process.stdout.write(JSON.stringify(result)+"\n");
}
