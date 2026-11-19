import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {parentPid, processIdentity} from './runtime-identity';
import {createHash} from 'node:crypto';

export const CLAUDE_TERMINAL_SCOPE = 'service:claude-terminal';
export const CLAUDE_TERMINAL_PROCESS_PREFIX = 'claude-terminal:';

export function terminalClaudeProcessKey(identity: ReturnType<typeof processIdentity>) {
  return CLAUDE_TERMINAL_PROCESS_PREFIX+createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

/** The deployment hook can run under a shell wrapper between Bun and Claude. */
export function terminalClaudePid(sessionId: string, childPid = process.pid): number | null {
  try {
    let pid = parentPid(childPid);
    for (let depth = 0; pid && pid > 1 && depth < 12; depth++, pid = parentPid(pid)) {
      if (isTerminalClaude(pid, sessionId)) return pid;
    }
  } catch { /* The launcher may have exited. */ }
  return null;
}

export function isTerminalClaude(pid: number, sessionId: string): boolean {
  if (!Number.isSafeInteger(pid) || pid < 2 || !/^[0-9a-f-]{36}$/i.test(sessionId)) return false;
  try {
    let executable: string;
    let args: string[];
    if (process.platform === 'linux') {
      executable = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
      args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    } else if (process.platform === 'darwin') {
      const result = spawnSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'ucmd=', '-o', 'command='],
        {encoding:'utf8', timeout:1000});
      if (result.status !== 0) return false;
      [executable, ...args] = result.stdout.trim().split(/\s+/);
    } else return false;
    // A managed SDK launch is print mode. Require the interactive process's explicit binding
    // to the same UUID, rather than choosing a conversation from cwd or its latest activity.
    const resume = args.findIndex(arg => arg === '--resume' || arg === '-r');
    return /^(claude|\d+\.\d+\.\d+)$/.test(basename(executable))
      && resume > 0 && args[resume + 1] === sessionId
      && !args.some(arg => arg === '-p' || arg === '--print' || arg === '--input-format');
  } catch { return false; }
}
