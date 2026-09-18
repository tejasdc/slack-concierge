import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export interface ProcessIdentity { pid: number; bootId: string; startTicks: string }

const darwin = process.platform === "darwin";
let darwinBootId: string | null = null;

function command(executable: string, args: string[]): string {
  const result = spawnSync(executable, args, { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`${executable} ${args.join(" ")} failed with ${result.status}`);
  return result.stdout.trim();
}

export function readBootId(): string {
  if (!darwin) return readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
  // A per-boot UUID the kernel keeps until the next boot, the same fact Linux exposes.
  return darwinBootId ??= command("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]);
}

export function readProcessStartTicks(pid: number): string {
  if (darwin) {
    const started = command("/bin/ps", ["-o", "lstart=", "-p", String(pid)]);
    if (!started) throw new Error(`process ${pid} is not running`);
    return started;
  }
  const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
  const fieldsAfterCommand = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  return fieldsAfterCommand[19]; // field 22; this array begins at field 3
}

function parentPid(pid: number): number | null {
  if (darwin) {
    const parent = command("/bin/ps", ["-o", "ppid=", "-p", String(pid)]);
    return parent ? Number(parent) : null;
  }
  const status = readFileSync(`/proc/${pid}/status`, "utf-8");
  const parent = status.match(/^PPid:\s+(\d+)$/m)?.[1];
  return parent ? Number(parent) : null;
}

export function currentProcessIdentity(): ProcessIdentity {
  return processIdentity(process.pid);
}

export function processIdentity(pid: number): ProcessIdentity {
  return { pid, bootId: readBootId(), startTicks: readProcessStartTicks(pid) };
}

export function isAncestorProcess(candidatePid: number, childPid = process.pid): boolean {
  let pid = childPid;
  const visited = new Set<number>();
  while (pid > 1 && !visited.has(pid)) {
    if (pid === candidatePid) return true;
    visited.add(pid);
    try {
      const parent = parentPid(pid);
      if (!parent) return false;
      pid = parent;
    } catch {
      return false;
    }
  }
  return pid === candidatePid;
}

export function isProcessIdentityAlive(identity: ProcessIdentity): boolean {
  if (!identity.pid || !identity.bootId || !identity.startTicks) return false;
  if (identity.bootId !== readBootId()) return false;
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    // An unprivileged service gets EPERM for a live root-owned deploy process.
    // Existence is still proven by the matching, readable proc start time.
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  try {
    return readProcessStartTicks(identity.pid) === identity.startTicks;
  } catch {
    return false;
  }
}
