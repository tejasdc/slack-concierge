/** Read-only context for one explicit diagnostic run; never an admission substitute. */
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {CacheBackupTrace, CACHE_BACKUP_POLICY, readCacheLoad, requireBackupWindow} from "../src/provider-history-cache-admission";
import type {CacheRestic} from "../src/provider-history-cache-maintenance";

const byteIdentity = (bytes: Buffer) => ({bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")});

/** Retains only disposable byte identities and observed transport results, never payloads or paths. */
export class DisposableCacheEvidence {
  private evidence = {
    original: {before: null as ReturnType<typeof byteIdentity> | null,
      after: null as ReturnType<typeof byteIdentity> | null, afterReadFailed: false},
    acceptedSnapshot: null as string | null, adoptedSnapshot: null as string | null,
    fullReadbackVerifiedSnapshot: null as string | null,
    readbacks: [] as Array<{snapshot: string; sha256: string; bytes: number}>, readbackFailures: 0,
  };
  captureOriginal(bytes: Buffer) {this.evidence.original.before = byteIdentity(bytes);}
  captureAfter(read: () => Buffer) {
    try {const bytes = read(); this.evidence.original.after = byteIdentity(bytes); return bytes;}
    catch {this.evidence.original.afterReadFailed = true;}
  }
  // This marker is reached only after prepare's exact full-stream comparisons and receipt publication.
  fullReadbackVerified(snapshot: string) {this.evidence.fullReadbackVerifiedSnapshot = snapshot;}
  wrap(restic: CacheRestic): CacheRestic {
    return {
      backup: async (paths, tag) => {
        const snapshot = await restic.backup(paths, tag);
        if (this.evidence.acceptedSnapshot === null) this.evidence.acceptedSnapshot = snapshot;
        else this.evidence.adoptedSnapshot = snapshot;
        return snapshot;
      },
      readback: async (snapshot, path, target) => {
        try {
          const result = await restic.readback(snapshot, path, target);
          this.evidence.readbacks.push({snapshot, sha256: result.sha256, bytes: result.bytes});
          return result;
        } catch (error) {this.evidence.readbackFailures++; throw error;}
      },
    };
  }
  summary() {return structuredClone(this.evidence);}
}

export function traceBackupWindow(trace: CacheBackupTrace) {
  const startedAt = performance.now(), units: unknown[] = [];
  let failure: unknown;
  try { requireBackupWindow(Date.now(), undefined, (unit, state) => units.push({unit, state, atMs: performance.now()})); }
  catch (error) {failure = error; throw error;}
  finally {trace.event("backup_window", {startedAt, units, error: failure ? String(failure) : null});}
}

export async function observeCacheInterval(trace: CacheBackupTrace, phase: string, durationMs = 60_000) {
  trace.event("phase_start", {phase, requestedMs: durationMs});
  const until = performance.now() + durationMs;
  do {
    try {trace.event("observer_sample", {phase, load: readCacheLoad()});}
    catch (error) {trace.event("observer_sample_unknown", {phase, error: String(error)});}
    try {traceBackupWindow(trace);} catch { /* Observation records refusal; it admits no work. */ }
    if (performance.now() >= until) break;
    await Bun.sleep(Math.min(CACHE_BACKUP_POLICY.sampleMs, until - performance.now()));
  } while (true);
  trace.event("phase_end", {phase});
}

export function cacheObservationContext() {
  const read = (path: string) => {try {return readFileSync(path, "utf8").trim();} catch {return null;}};
  const cgroup = read("/proc/self/cgroup");
  const unified = /^0::(\/.*)$/m.exec(cgroup ?? "")?.[1];
  const base = unified && !unified.split("/").includes("..") ? `/sys/fs/cgroup${unified}` : null;
  return {kernel: read("/proc/sys/kernel/osrelease"), kernelBuild: read("/proc/version"), distro: read("/etc/os-release"),
    bootId: read("/proc/sys/kernel/random/boot_id"),
    mounts: read("/proc/self/mountinfo")?.split("\n").filter(line => / - (ext4|xfs|btrfs|tmpfs|cgroup2) /.test(line)) ?? null,
    cgroup: {path: unified ?? null, ioStat: base ? read(`${base}/io.stat`) : null,
      memoryStat: base ? read(`${base}/memory.stat`) : null,
      scope: "Existing process cgroup; may include other work, no allocation or attribution lease."}};
}

export function knownChildrenAfterCleanup(trace: CacheBackupTrace) {
  const known = new Map<string, {pid: number; startTicks: string}>();
  for (const event of trace.summary().events) {
    const load = event.load as ReturnType<typeof readCacheLoad> | undefined;
    for (const member of load?.raw?.members ?? [])
      if (member.pid !== process.pid) known.set(`${member.pid}:${member.startTicks}`, member);
  }
  return [...known.values()].map(member => {
    try {
      const stat = readFileSync(`/proc/${member.pid}/stat`, "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return {...member, observed: fields[19] === member.startTicks ? fields[0] : "pid_reused"};
    } catch (error) {return {...member, observed: (error as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : "unknown"};}
  });
}

const EVENTS = ["ledger_durability_slow_sync", "ledger_durability_sync_stalled", "ledger_durability_lost",
  "ledger_durability_thread_failed", "owner_event_loop_lag", "foreground_owner_dependency_delayed"];
const numeric = (value: unknown, depth = 0): unknown => {
  if (typeof value === "number" || value === null) return value;
  if (!value || typeof value !== "object" || Array.isArray(value) || depth >= 3) return undefined;
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const found = numeric(item, depth + 1); return found === undefined ? [] : [[key, found]];
  }));
};

export function parseForegroundJournalRow(line: string) {
  const row = JSON.parse(line), message = JSON.parse(row.MESSAGE);
  if (!EVENTS.includes(message.event)) return null;
  const metrics = Object.fromEntries(["ms", "sync_ms", "queue_ms", "fdatasync_ms", "delivery_ms", "waiters",
    "released_waiters", "lag_ms", "elapsed_ms", "header_ms", "storage"].flatMap(key => {
    const value = numeric(message[key]); return value === undefined ? [] : [[key, value]];
  }));
  return {event: message.event, monotonicMs: Number(row.__MONOTONIC_TIMESTAMP) / 1000,
    wallAtMs: Number(row.__REALTIME_TIMESTAMP) / 1000, bootId: row._BOOT_ID, metrics};
}

export async function foregroundJournalEvidence(startedAtMs: number, endedAtMs: number) {
  // Filter before export. Do not retain dialogue, request IDs, routes or receipt joins.
  let child;
  try {child = Bun.spawn(["timeout", "8s", "journalctl", "-u", "concierge-bot.service", "--no-pager", "-o", "json",
    "--since", `@${Math.floor(startedAtMs / 1000)}`, "--until", `@${Math.ceil(endedAtMs / 1000)}`,
    "--grep", EVENTS.join("|"), "--lines=1000", "--output-fields=__MONOTONIC_TIMESTAMP,__REALTIME_TIMESTAMP,_BOOT_ID,MESSAGE"],
    {stdout: "pipe", stderr: "ignore"});}
  catch (error) {return {available: false, error: String(error), events: [], requestedInterval: {startedAtMs, endedAtMs}};}
  const events: unknown[] = []; let bytes = 0, pending = "", rows = 0, tooLarge = false, invalid = 0;
  try {
    for await (const chunk of child.stdout) {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) {tooLarge = true; child.kill("SIGTERM"); break;}
      pending += Buffer.from(chunk).toString("utf8");
      const lines = pending.split("\n"); pending = lines.pop()!;
      for (const line of lines) {
        rows++;
        try {
          const event = parseForegroundJournalRow(line); if (event) events.push(event);
        } catch {invalid++;}
      }
    }
    const exitCode = await child.exited;
    return {available: exitCode === 0 && !tooLarge, exitCode, truncated: tooLarge || rows >= 1000,
      invalid, pendingBytes: Buffer.byteLength(pending), events, requestedInterval: {startedAtMs, endedAtMs},
      scope: "Retrospective thresholded journal evidence; absence does not establish durable-response latency or meaningful traffic."};
  } finally {child.kill("SIGTERM"); await child.exited;}
}
