import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import {controlSocketListeners} from './codex-daemon-file-limit';

export type CodexLeftoverProcess = { pid: number; name: string; startTicks: string; cgroup: string };

/** Inspect after the provider turn has ended, when ordinary tool processes have exited. */
export async function codexLeftoverProcesses(threadId: string,options:{strict?:boolean}={}): Promise<CodexLeftoverProcess[]> {
  if (process.platform !== 'linux' || !/^[0-9a-f-]{36}$/.test(threadId)) {
    if(options.strict)throw new Error('Current Codex process observation requires a local Linux thread identity.');
    return [];
  }
  const entries = await readdir('/proc');
  const matches: CodexLeftoverProcess[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const cgroup = (await readFile(`/proc/${pid}/cgroup`, 'utf8')).trim();
      // Only the shared Codex App Server scope lacks a turn-end owner. Hosted execution units,
      // registered command watches and other systemd services (a ship job) stop their own children.
      if (!/^0::\/agents\.slice\/codex-app-server-[^/\n]+\.scope(?:\/|$)/m.test(cgroup)) continue;
      const environment = (await readFile(`/proc/${pid}/environ`)).toString().split('\0');
      if (!environment.includes(`CODEX_THREAD_ID=${threadId}`)) continue;
      const command = (await readFile(`/proc/${pid}/cmdline`)).toString().split('\0')[0] ?? '';
      if (command.includes('agent-browser') || /\/(?:chrome|chrome_crashpad_handler)$/.test(command)) continue;
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z' || fields[0] === 'X') continue;
      const startTicks = fields[19]; // proc stat field 22, after pid and parenthesized comm.
      if (!startTicks || !/^\d+$/.test(startTicks)) continue;
      matches.push({ pid, name: (await readFile(`/proc/${pid}/comm`, 'utf8')).trim(), startTicks, cgroup });
    } catch(error) {
      const code=(error as NodeJS.ErrnoException).code;
      // Process exit is a disposition. An unreadable live candidate is not evidence of absence.
      if(options.strict&&!['ENOENT','ESRCH','ENOTDIR'].includes(code??''))
        throw new Error(`Current Codex process observation could not inspect PID ${pid}: ${code??'unknown error'}`);
    }
  }
  return matches;
}

/** Recovery must not turn a partial diagnostic scan into a clean process disposition. */
export async function observeCodexCustodyProcesses(threadId:string,socketPath:string,nativePid?:number):Promise<CodexLeftoverProcess[]> {
  if(process.platform!=='linux'||!/^[0-9a-f-]{36}$/.test(threadId)||!socketPath.startsWith('/'))
    throw new Error('Current custody process observation requires its exact local Linux native endpoint and thread.');
  const listeners=controlSocketListeners(socketPath);
  if(!listeners.length)throw new Error('The actual native endpoint listener could not be identified for process observation.');
  if(nativePid!==undefined&&!listeners.includes(nativePid))
    throw new Error('The observed native control endpoint no longer belongs to the connected peer incarnation.');
  for(const pid of listeners){
    const cgroup=await readFile(`/proc/${pid}/cgroup`,'utf8');
    if(!/^0::\/agents\.slice\/codex-app-server-[^/\n]+\.scope(?:\/|$)/m.test(cgroup))
      throw new Error('The actual native endpoint is outside the managed process scope; its effects remain unobserved.');
  }
  return codexLeftoverProcesses(threadId,{strict:true});
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
