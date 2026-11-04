import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';

export type CodexLeftoverProcess = { pid: number; name: string; startTicks: string; cgroup: string };

/** Inspect after the provider turn has ended, when ordinary tool processes have exited. */
export async function codexLeftoverProcesses(threadId: string): Promise<CodexLeftoverProcess[]> {
  if (process.platform !== 'linux' || !/^[0-9a-f-]{36}$/.test(threadId)) return [];
  const entries = await readdir('/proc');
  const matches: CodexLeftoverProcess[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const environment = (await readFile(`/proc/${pid}/environ`)).toString().split('\0');
      if (!environment.includes(`CODEX_THREAD_ID=${threadId}`)) continue;
      const cgroup = (await readFile(`/proc/${pid}/cgroup`, 'utf8')).trim();
      // Only the shared Codex App Server scope lacks a turn-end owner. Hosted execution units,
      // registered command watches and other systemd services (a ship job) stop their own children.
      if (!/^0::\/agents\.slice\/codex-app-server-[^/\n]+\.scope(?:\/|$)/m.test(cgroup)) continue;
      const command = (await readFile(`/proc/${pid}/cmdline`)).toString().split('\0')[0] ?? '';
      if (command.includes('agent-browser') || /\/(?:chrome|chrome_crashpad_handler)$/.test(command)) continue;
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z' || fields[0] === 'X') continue;
      const startTicks = fields[19]; // proc stat field 22, after pid and parenthesized comm.
      if (!startTicks || !/^\d+$/.test(startTicks)) continue;
      matches.push({ pid, name: (await readFile(`/proc/${pid}/comm`, 'utf8')).trim(), startTicks, cgroup });
    } catch { /* The process may exit while /proc is read. */ }
  }
  return matches;
}

/** Held this long before a report: a detached build or short wait usually ends on its own first. */
export const CODEX_PROCESS_REPORT_GRACE_MS = 10 * 60_000;

/** The same process, not a later one that reused its PID. */
export function codexProcessStillRunning(recorded: Pick<CodexLeftoverProcess, 'pid' | 'startTicks'>): boolean {
  try {
    const stat = readFileSync(`/proc/${recorded.pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[0] !== 'Z' && fields[0] !== 'X' && fields[19] === recorded.startTicks;
  } catch { return false; }
}
