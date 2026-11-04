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
      // Concierge's hosted execution and registered command watches are stopped by their
      // supervisor. The shared Codex App Server scope has no turn-end owner for children.
      if (/^0::\/agents\.slice\/concierge-exec-[^/\n]+\.service(?:\/|$)/m.test(cgroup)) continue;
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
