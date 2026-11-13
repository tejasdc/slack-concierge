/** Concierge's small-cache trial contract; no host allocation or backup lock changes. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Initial trial, not a claim about the disk's throughput. Broaden only after
// reviewing process/device observations and product responsiveness from a small run.
export const CACHE_BACKUP_POLICY = {
  version: 1, maxInputBytes: 8 * 1024 * 1024, transferKiB: 512, packMiB: 4,
  nice: 19, goProcessors: 1, readers: 1, sftpConnections: 1, killGraceMs: 2000,
  maxMs: 5 * 60_000, scheduleMarginMs: 60_000, sampleMs: 1000,
  maxIoPressure: 5, maxDiskBusyPercent: 50, minAvailableBytes: 1024 * 1024 * 1024,
  services: ["remote-box-backup.service", "remote-box-thinkering-backup.service"],
} as const;

function showBackupUnit(unit: string, properties: string[]): Record<string,string> {
  const child = Bun.spawnSync(["timeout", "2s", "systemctl", "show", unit,
    ...properties.flatMap(property => ["-p", property])], {stderr: "ignore", env: {...process.env, LC_ALL: "C", TZ: "UTC"}});
  if (child.exitCode !== 0) throw new Error("HISTORY_BACKUP_OBSERVATION_UNKNOWN");
  return Object.fromEntries(child.stdout.toString().trim().split("\n").map(line => line.split(/=(.*)/s).slice(0, 2)));
}
export function requireBackupWindow(now = Date.now(), show = showBackupUnit,
  observed?: (unit: string, state: Record<string,string>) => void) {
  for (const service of CACHE_BACKUP_POLICY.services) {
    const state = show(service, ["LoadState", "ActiveState", "SubState", "MainPID", "ControlPID", "Job"]);
    observed?.(service, state);
    if (state.LoadState !== "loaded" || state.ActiveState !== "inactive" || state.SubState !== "dead"
      || state.MainPID !== "0" || state.ControlPID !== "0" || state.Job !== "")
      throw new Error("HISTORY_BACKUP_BUSY_OR_UNKNOWN");
    const timer = show(service.replace(/\.service$/, ".timer"), ["LoadState", "ActiveState", "SubState", "NextElapseUSecRealtime"]);
    observed?.(service.replace(/\.service$/, ".timer"), timer);
    const due = Date.parse(timer.NextElapseUSecRealtime);
    if (timer.LoadState !== "loaded" || timer.ActiveState !== "active" || timer.SubState !== "waiting"
      || !Number.isFinite(due) || due - now <= CACHE_BACKUP_POLICY.maxMs + CACHE_BACKUP_POLICY.scheduleMarginMs)
      throw new Error("HISTORY_BACKUP_WINDOW_UNAVAILABLE");
  }
}

export interface CacheLoad {
  at: number; pressure: number; available: number;
  devices: Record<string, {readBytes: number; writeBytes: number; busyMs: number}>;
  process: {readBytes: number; writeBytes: number; rssBytes: number; cpuTicks: number; processes: number};
  raw?: {startedAt: number; finishedAt: number; monotonicMs: number; ioPressure: string; diskstats: string[];
    dirtyBytes: number; writebackBytes: number; members: Array<{pid: number; startTicks: string; state: string}>;
    membersTruncated: number};
}

/** A bounded in-memory trace; writes occur only when the existing report is persisted. */
export class CacheBackupTrace {
  private entries: Array<Record<string, unknown>> = [];
  private bytes = 0;
  private dropped = 0;
  readonly anchor = {atMs: performance.now(), monotonicMs: Number(process.hrtime.bigint()) / 1e6, wallAtMs: Date.now()};
  event(kind: string, fields: Record<string, unknown> = {}) {
    const value = {kind, ...fields, atMs: performance.now(), monotonicMs: Number(process.hrtime.bigint()) / 1e6, wallAtMs: Date.now()};
    const encoded = JSON.stringify(value), bytes = Buffer.byteLength(encoded);
    if (this.entries.length >= 2048 || this.bytes + bytes > 2 * 1024 * 1024) { this.dropped++; return; }
    this.entries.push(JSON.parse(encoded)); this.bytes += bytes;
  }
  summary() { return {schema: 1, anchor: {...this.anchor}, events: structuredClone(this.entries), dropped: this.dropped,
    complete: this.dropped === 0, maxEvents: 2048, maxBytes: 2 * 1024 * 1024}; }
}

export function readCacheLoad(pid = process.pid): CacheLoad {
  const startedAt = performance.now(), ioPressure = readFileSync("/proc/pressure/io", "utf8");
  const meminfo = readFileSync("/proc/meminfo", "utf8");
  const pressure = Number(/^some avg10=([\d.]+)/m.exec(ioPressure)?.[1]);
  const memoryBytes = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(meminfo)?.[1]) * 1024;
  const available = memoryBytes("MemAvailable");
  const devices: Record<string, {readBytes: number; writeBytes: number; busyMs: number}> = {};
  const diskstats: string[] = [];
  for (const line of readFileSync("/proc/diskstats", "utf8").trim().split("\n")) {
    const fields = line.trim().split(/\s+/), name = fields[2]!;
    // Observe physical devices once, rather than summing md and its members.
    if (!existsSync(`/sys/block/${name}/device`)) continue;
    diskstats.push(line);
    devices[name] = {readBytes: Number(fields[5]) * 512, writeBytes: Number(fields[9]) * 512, busyMs: Number(fields[12])};
  }
  if (!Number.isFinite(pressure) || !Number.isFinite(available) || !Object.keys(devices).length
    || Object.values(devices).some(counters=>Object.values(counters).some(value=>!Number.isFinite(value)||value<0)))
    throw new Error("HISTORY_LOAD_OBSERVATION_UNKNOWN");
  let readBytes = 0, writeBytes = 0, rssBytes = 0, cpuTicks = 0, processes = 0;
  const seen = new Set<number>();
  const members: Array<{pid: number; startTicks: string; state: string}> = [];
  const visit = (current: number) => {
    if (seen.has(current)) return;
    seen.add(current);
    try {
      const io = readFileSync(`/proc/${current}/io`, "utf8"), status = readFileSync(`/proc/${current}/status`, "utf8");
      readBytes += Number(/^read_bytes:\s+(\d+)/m.exec(io)?.[1]);
      writeBytes += Number(/^write_bytes:\s+(\d+)/m.exec(io)?.[1]);
      rssBytes += Number(/^VmRSS:\s+(\d+) kB/m.exec(status)?.[1] || 0) * 1024;
      const stat=readFileSync(`/proc/${current}/stat`,"utf8"),fields=stat.slice(stat.lastIndexOf(")")+2).split(" ");
      cpuTicks+=Number(fields[11])+Number(fields[12]);
      if (members.length < 128) members.push({pid: current, startTicks: fields[19]!, state: fields[0]!});
      processes++;
      for (const task of readdirSync(`/proc/${current}/task`))
        for (const child of readFileSync(`/proc/${current}/task/${task}/children`, "utf8").trim().split(/\s+/).filter(Boolean)) visit(Number(child));
    } catch (error) {
      if (current !== pid && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  };
  visit(pid);
  if (![readBytes, writeBytes, rssBytes, cpuTicks].every(Number.isFinite)) throw new Error("HISTORY_LOAD_OBSERVATION_UNKNOWN");
  const at = performance.now();
  return {at, pressure, available, devices, process: {readBytes, writeBytes, rssBytes, cpuTicks, processes},
    raw: {startedAt, finishedAt: at, monotonicMs: Number(process.hrtime.bigint()) / 1e6,
      ioPressure, diskstats, dirtyBytes: memoryBytes("Dirty"), writebackBytes: memoryBytes("Writeback"),
      members, membersTruncated: Math.max(0, processes - members.length)}};
}

type Load = ReturnType<typeof readCacheLoad>;
export class CacheBackupAdmission {
  readonly id = randomUUID();
  readonly started = performance.now();
  private failure: Error | null = null;
  private previous?: Load;
  private first?: Load;
  private last?: Load;
  private samples = 0;
  private peakRssBytes = 0;
  private peakProcesses = 0;
  private peakDiskBusyPercent = 0;
  private peakPressure = 0;
  private peakProcessReadBytes = 0;
  private peakProcessWriteBytes = 0;
  private peakCpuTicks = 0;
  private timer?: ReturnType<typeof setInterval>;
  private stopNative?: () => void;
  private windowCheckedAt = -Infinity;
  private interrupted = () => this.fail(new Error("HISTORY_BACKUP_INTERRUPTED"));
  constructor(readonly folder: string, readonly window = requireBackupWindow, readonly load = readCacheLoad,
    readonly trace = new CacheBackupTrace()) {}
  private fail(error: unknown) {
    if (!this.failure) this.trace.event("stop_decision", {error: error instanceof Error ? error.message : "HISTORY_BACKUP_OBSERVATION_UNKNOWN"});
    this.failure ??= error instanceof Error ? error : new Error("HISTORY_BACKUP_OBSERVATION_UNKNOWN");
    if (this.stopNative) this.trace.event("native_stop_requested", {error: this.failure.message});
    this.stopNative?.();
  }
  check() {
    if (performance.now() - this.started >= CACHE_BACKUP_POLICY.maxMs) this.fail(new Error("HISTORY_BACKUP_DEADLINE"));
    if (this.failure) throw this.failure;
    if (performance.now() - this.windowCheckedAt >= CACHE_BACKUP_POLICY.sampleMs) {
      try { this.window(); this.windowCheckedAt = performance.now(); }
      catch (error) { this.trace.event("backup_window_refusal", {error: String(error)}); throw error; }
    }
  }
  limit(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > CACHE_BACKUP_POLICY.maxInputBytes)
      throw new Error("HISTORY_BACKUP_SMALL_TRIAL_ONLY");
    this.check();
  }
  sample() {
    try { this.sampleLoad(); }
    catch (error) { this.trace.event("sample_refused", {error: String(error)}); throw error; }
  }
  private sampleLoad() {
    this.check();
    const value = this.load();
    const intervals: Record<string, {elapsedMs: number; busyDeltaMs: number; busyPercent: number}> = {};
    if (this.previous) for (const [name, counters] of Object.entries(value.devices)) {
      const old = this.previous.devices[name];
      if (old) intervals[name] = {elapsedMs: value.at - this.previous.at, busyDeltaMs: counters.busyMs - old.busyMs,
        busyPercent: 100 * (counters.busyMs - old.busyMs) / (value.at - this.previous.at)};
    }
    this.trace.event("load_sample", {load: value, intervals});
    this.first ??= value; this.last = value; this.samples++;
    this.observeProcess(value.process);
    this.peakPressure = Math.max(this.peakPressure, value.pressure);
    if(this.previous && Object.keys(this.previous.devices).sort().join(",")!==Object.keys(value.devices).sort().join(","))
      throw new Error("HISTORY_LOAD_OBSERVATION_UNKNOWN");
    if (this.previous) for (const [device, counters] of Object.entries(value.devices)) {
      const old = this.previous.devices[device];
      if (!old || value.at <= this.previous.at || counters.busyMs < old.busyMs) throw new Error("HISTORY_LOAD_OBSERVATION_UNKNOWN");
      this.peakDiskBusyPercent = Math.max(this.peakDiskBusyPercent, 100 * (counters.busyMs - old.busyMs) / (value.at - this.previous.at));
    }
    this.previous = value;
    if (value.pressure > CACHE_BACKUP_POLICY.maxIoPressure || this.peakDiskBusyPercent > CACHE_BACKUP_POLICY.maxDiskBusyPercent
      || value.available < CACHE_BACKUP_POLICY.minAvailableBytes) {
      this.trace.event("load_refusal", {pressure: value.pressure, peakDiskBusyPercent: this.peakDiskBusyPercent, available: value.available});
      throw new Error("HISTORY_BACKUP_LOAD_BUSY");
    }
  }
  observeProcess(value = this.load().process) {
    this.peakRssBytes=Math.max(this.peakRssBytes,value.rssBytes);
    this.peakProcesses=Math.max(this.peakProcesses,value.processes);
    this.peakProcessReadBytes=Math.max(this.peakProcessReadBytes,value.readBytes);
    this.peakProcessWriteBytes=Math.max(this.peakProcessWriteBytes,value.writeBytes);
    this.peakCpuTicks=Math.max(this.peakCpuTicks,value.cpuTicks);
  }
  async start() {
    this.trace.event("admission_start");
    mkdirSync(this.folder, {recursive: true, mode: 0o700});
    process.on("SIGTERM", this.interrupted); process.on("SIGINT", this.interrupted);
    this.sample();
    await Bun.sleep(CACHE_BACKUP_POLICY.sampleMs);
    this.sample();
    this.timer = setInterval(() => {try {this.sample();} catch (error) {this.fail(error);}}, CACHE_BACKUP_POLICY.sampleMs);
    this.trace.event("admission_admitted");
  }
  ownNative(stop?: () => void) {this.stopNative = stop; this.trace.event(stop ? "native_owned" : "native_detached");}
  finish(error?: unknown) {
    if (this.timer) clearInterval(this.timer);
    process.off("SIGTERM", this.interrupted); process.off("SIGINT", this.interrupted);
    this.trace.event("admission_finished", {error: this.failure?.message ?? (error instanceof Error ? error.message : null)});
    this.trace.event("admission_report_write_start");
    const report = {schema: 2, id: this.id, policy: CACHE_BACKUP_POLICY, elapsedMs: performance.now() - this.started,
      status: error || this.failure ? "refused_or_interrupted" : "completed", error: this.failure?.message ?? (error instanceof Error ? error.message : undefined),
      samples: this.samples, peakRssBytes: this.peakRssBytes, peakProcesses: this.peakProcesses,
      peakProcessReadBytes:this.peakProcessReadBytes,peakProcessWriteBytes:this.peakProcessWriteBytes,peakCpuTicks:this.peakCpuTicks,
      peakIoPressure: this.peakPressure, peakDiskBusyPercent: this.peakDiskBusyPercent,
      first: this.first, last: this.last, trace: this.trace.summary(),
      scope: "Sampled own process tree and whole-device counters; no physical rate guarantee or causal attribution."};
    writeFileSync(join(this.folder, `load-${this.id}.json`), JSON.stringify(report) + "\n", {flag: "wx", mode: 0o600});
    this.trace.event("admission_report_write_end");
    return report;
  }
}
