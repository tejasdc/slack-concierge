import { readFileSync } from "node:fs";

export interface ProcessIdentity { pid: number; bootId: string; startTicks: string }

export function readBootId(): string {
  return readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
}

export function readProcessStartTicks(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
  const fieldsAfterCommand = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  return fieldsAfterCommand[19]; // field 22; this array begins at field 3
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
      const status = readFileSync(`/proc/${pid}/status`, "utf-8");
      const parent = status.match(/^PPid:\s+(\d+)$/m)?.[1];
      if (!parent) return false;
      pid = Number(parent);
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
    return readProcessStartTicks(identity.pid) === identity.startTicks;
  } catch {
    return false;
  }
}
