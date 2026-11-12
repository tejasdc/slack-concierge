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
export function requireBackupWindow(now = Date.now(), show = showBackupUnit) {
  for (const service of CACHE_BACKUP_POLICY.services) {
    const state = show(service, ["LoadState", "ActiveState", "SubState", "MainPID", "ControlPID", "Job"]);
    if (state.LoadState !== "loaded" || state.ActiveState !== "inactive" || state.SubState !== "dead"
      || state.MainPID !== "0" || state.ControlPID !== "0" || state.Job !== "")
      throw new Error("HISTORY_BACKUP_BUSY_OR_UNKNOWN");
    const timer = show(service.replace(/\.service$/, ".timer"), ["LoadState", "ActiveState", "SubState", "NextElapseUSecRealtime"]);
    const due = Date.parse(timer.NextElapseUSecRealtime);
    if (timer.LoadState !== "loaded" || timer.ActiveState !== "active" || timer.SubState !== "waiting"
      || !Number.isFinite(due) || due - now <= CACHE_BACKUP_POLICY.maxMs + CACHE_BACKUP_POLICY.scheduleMarginMs)
      throw new Error("HISTORY_BACKUP_WINDOW_UNAVAILABLE");
  }
}

export function readCacheLoad(pid = process.pid) {
  const pressure = Number(/^some avg10=([\d.]+)/m.exec(readFileSync("/proc/pressure/io", "utf8"))?.[1]);
  const available = Number(/^MemAvailable:\s+(\d+) kB/m.exec(readFileSync("/proc/meminfo", "utf8"))?.[1]) * 1024;
  const devices: Record<string, {readBytes: number; writeBytes: number; busyMs: number}> = {};
  for (const line of readFileSync("/proc/diskstats", "utf8").trim().split("\n")) {
    const fields = line.trim().split(/\s+/), name = fields[2]!;
    // Observe physical devices once, rather than summing md and its members.
    if (!existsSync(`/sys/block/${name}/device`)) continue;
    devices[name] = {readBytes: Number(fields[5]) * 512, writeBytes: Number(fields[9]) * 512, busyMs: Number(fields[12])};
  }
  if (!Number.isFinite(pressure) || !Number.isFinite(available) || !Object.keys(devices).length
    || Object.values(devices).some(counters=>Object.values(counters).some(value=>!Number.isFinite(value)||value<0)))
    throw new Error("HISTORY_LOAD_OBSERVATION_UNKNOWN");
  let readBytes = 0, writeBytes = 0, rssBytes = 0, cpuTicks = 0, processes = 0;
  const seen = new Set<number>();
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
  return {at: performance.now(), pressure, available, devices, process: {readBytes, writeBytes, rssBytes, cpuTicks, processes}};
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
  constructor(readonly folder: string, readonly window = requireBackupWindow, readonly load = readCacheLoad) {}
  private fail(error: unknown) {
    this.failure ??= error instanceof Error ? error : new Error("HISTORY_BACKUP_OBSERVATION_UNKNOWN");
    this.stopNative?.();
  }
  check() {
    if (performance.now() - this.started >= CACHE_BACKUP_POLICY.maxMs) this.fail(new Error("HISTORY_BACKUP_DEADLINE"));
    if (this.failure) throw this.failure;
    if (performance.now() - this.windowCheckedAt >= CACHE_BACKUP_POLICY.sampleMs) {
      this.window(); this.windowCheckedAt = performance.now();
    }
  }
  limit(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > CACHE_BACKUP_POLICY.maxInputBytes)
      throw new Error("HISTORY_BACKUP_SMALL_TRIAL_ONLY");
    this.check();
  }
  sample() {
    this.check();
    const value = this.load();
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
      || value.available < CACHE_BACKUP_POLICY.minAvailableBytes) throw new Error("HISTORY_BACKUP_LOAD_BUSY");
  }
  observeProcess(value = this.load().process) {
    this.peakRssBytes=Math.max(this.peakRssBytes,value.rssBytes);
    this.peakProcesses=Math.max(this.peakProcesses,value.processes);
    this.peakProcessReadBytes=Math.max(this.peakProcessReadBytes,value.readBytes);
    this.peakProcessWriteBytes=Math.max(this.peakProcessWriteBytes,value.writeBytes);
    this.peakCpuTicks=Math.max(this.peakCpuTicks,value.cpuTicks);
  }
  async start() {
    mkdirSync(this.folder, {recursive: true, mode: 0o700});
    process.on("SIGTERM", this.interrupted); process.on("SIGINT", this.interrupted);
    this.sample();
    await Bun.sleep(CACHE_BACKUP_POLICY.sampleMs);
    this.sample();
    this.timer = setInterval(() => {try {this.sample();} catch (error) {this.fail(error);}}, CACHE_BACKUP_POLICY.sampleMs);
  }
  ownNative(stop?: () => void) {this.stopNative = stop;}
  finish(error?: unknown) {
    if (this.timer) clearInterval(this.timer);
    process.off("SIGTERM", this.interrupted); process.off("SIGINT", this.interrupted);
    const report = {schema: 1, id: this.id, policy: CACHE_BACKUP_POLICY, elapsedMs: performance.now() - this.started,
      status: error || this.failure ? "refused_or_interrupted" : "completed", error: this.failure?.message ?? (error instanceof Error ? error.message : undefined),
      samples: this.samples, peakRssBytes: this.peakRssBytes, peakProcesses: this.peakProcesses,
      peakProcessReadBytes:this.peakProcessReadBytes,peakProcessWriteBytes:this.peakProcessWriteBytes,peakCpuTicks:this.peakCpuTicks,
      peakIoPressure: this.peakPressure, peakDiskBusyPercent: this.peakDiskBusyPercent,
      first: this.first, last: this.last,
      scope: "Sampled own process tree and whole-device counters; no physical rate guarantee or causal attribution."};
    writeFileSync(join(this.folder, `load-${this.id}.json`), JSON.stringify(report) + "\n", {flag: "wx", mode: 0o600});
    return report;
  }
}
