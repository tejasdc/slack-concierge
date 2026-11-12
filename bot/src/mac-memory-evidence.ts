import { execFile } from "node:child_process";

/**
 * What the Mac's memory was doing around an owner freeze (docs/plans/2026-11-12-mac-held-work-pacing.md).
 *
 * The 2026-11-12 reading of the Mac's freezes was an inference: every freeze used a second or two of
 * processor across a minute of blocking, and a Mac at full swap compressing the idle owner and faulting
 * it back in fits that. A page-in count at the moment of a freeze would turn it into an observation.
 *
 * The freeze records themselves read nothing: a sampler keeps the latest reading, taken with
 * asynchronous child processes that never run on the owner's blocked path, and a record copies it.
 * Only macOS has these counters; elsewhere nothing is sampled and nothing is added.
 */
export type MacMemoryEvidence = {
  mem_pressure_level?: number;
  swap_used_mb?: number;
  swap_total_mb?: number;
  owner_compressed_mb?: number;
  pageins_since_previous?: number;
  mem_sample_age_ms?: number;
};

type Reading = { atMs: number; pressure: number | null; swapUsedMb: number | null; swapTotalMb: number | null; compressedMb: number | null; pageins: number | null };
let latest: Reading | null = null;
let pageinsAtPreviousRecord: number | null = null;

export function parsePageins(vmStat: string): number | null {
  const pageSize = Number(vmStat.match(/page size of (\d+) bytes/)?.[1]);
  const pages = Number(vmStat.match(/^Pageins:\s+(\d+)\./m)?.[1]);
  return Number.isFinite(pages) && Number.isFinite(pageSize) && pageSize > 0 ? pages : null;
}
export function parseSwapUsage(text: string): { usedMb: number; totalMb: number } | null {
  const total = Number(text.match(/total = ([\d.]+)M/)?.[1]), used = Number(text.match(/used = ([\d.]+)M/)?.[1]);
  return Number.isFinite(total) && Number.isFinite(used) ? { usedMb: Math.round(used), totalMb: Math.round(total) } : null;
}
/** The last number of `top -stats cmprs` output: "208M", "512K", "1.2G", with a trailing +/- change mark. */
export function parseCompressed(top: string): number | null {
  const last = top.trim().split("\n").pop()?.trim().match(/^([\d.]+)([KMG])[+-]?$/);
  if (!last) return null;
  const value = Number(last[1]);
  return Math.round(last[2] === "K" ? value / 1024 : last[2] === "G" ? value * 1024 : value);
}

const run = (command: string, args: string[]) => new Promise<string | null>(resolve =>
  execFile(command, args, { encoding: "utf8", timeout: 10_000 }, (error, stdout) => resolve(error ? null : stdout)));

async function sample(): Promise<void> {
  const [vm, swap, pressure, top] = await Promise.all([
    run("/usr/bin/vm_stat", []), run("/usr/sbin/sysctl", ["-n", "vm.swapusage"]),
    run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
    run("/usr/bin/top", ["-l", "1", "-n", "0", "-pid", String(process.pid), "-stats", "cmprs"]),
  ]);
  const swapUsage = swap ? parseSwapUsage(swap) : null, level = Number(pressure?.trim());
  latest = { atMs: Date.now(), pressure: Number.isInteger(level) ? level : null, swapUsedMb: swapUsage?.usedMb ?? null,
    swapTotalMb: swapUsage?.totalMb ?? null, compressedMb: top ? parseCompressed(top) : null, pageins: vm ? parsePageins(vm) : null };
}

/** Starts sampling on macOS; a no-op elsewhere and when already started in this thread. */
let timer: ReturnType<typeof setInterval> | null = null;
export function startMacMemorySampler(intervalMs = 15_000): void {
  if (process.platform !== "darwin" || timer) return;
  void sample();
  timer = setInterval(() => void sample(), intervalMs);
  timer.unref?.();
}

/** Copied into a freeze record. Page-ins are counted since the previous record, so the first record carries none. */
export function macMemoryEvidence(nowMs = Date.now()): MacMemoryEvidence {
  if (!latest) return {};
  const evidence: MacMemoryEvidence = { mem_sample_age_ms: nowMs - latest.atMs };
  if (latest.pressure !== null) evidence.mem_pressure_level = latest.pressure;
  if (latest.swapUsedMb !== null) { evidence.swap_used_mb = latest.swapUsedMb; evidence.swap_total_mb = latest.swapTotalMb!; }
  if (latest.compressedMb !== null) evidence.owner_compressed_mb = latest.compressedMb;
  if (latest.pageins !== null) {
    if (pageinsAtPreviousRecord !== null) evidence.pageins_since_previous = Math.max(0, latest.pageins - pageinsAtPreviousRecord);
    pageinsAtPreviousRecord = latest.pageins;
  }
  return evidence;
}
