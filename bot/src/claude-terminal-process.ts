import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {isProcessIdentityAlive, parentPid, processIdentity} from './runtime-identity';
import type {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';

export const CLAUDE_TERMINAL_SCOPE = 'service:claude-terminal';
export const CLAUDE_TERMINAL_PROCESS_PREFIX = 'claude-terminal:';
export const CLAUDE_TERMINAL_SOURCE = 'terminal-source';

export function terminalClaudeProcessKey(identity: ReturnType<typeof processIdentity>) {
  return CLAUDE_TERMINAL_PROCESS_PREFIX+createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

type CommandTurn = {status:string; stop_requested_at?:string|null; provider_admission_intended_at?:string|null;
  turn_kind?:string; session_id?:number; owner_instance_id?:string|null};

/** Source custody is separate from the scheduler's running-work state. */
export function isLiveCommandTurn(db: Database, turn: CommandTurn|null|undefined): boolean {
  if (!turn || turn.stop_requested_at) return false;
  if (turn.status === 'running') return !!turn.provider_admission_intended_at;
  if (turn.status !== CLAUDE_TERMINAL_SOURCE || turn.turn_kind !== CLAUDE_TERMINAL_SOURCE) return false;
  const owner = db.query(`SELECT process.pid,process.boot_id AS bootId,process.process_start_ticks AS startTicks
    FROM process_instances process JOIN sessions session ON session.id=?
    WHERE process.instance_id=? AND session.status<>'archived'
      AND COALESCE(json_extract(session.native_metadata_json,'$.suspended'),0)=0
      AND NOT EXISTS (SELECT 1 FROM turns WHERE session_id=session.id AND status IN ('running','delivering'))`)
    .get(turn.session_id ?? null,turn.owner_instance_id ?? null) as ReturnType<typeof processIdentity>|null;
  return !!owner && isProcessIdentityAlive(owner);
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
