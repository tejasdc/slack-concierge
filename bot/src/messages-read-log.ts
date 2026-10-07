import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * One line per agent read of his texts that withheld something, and per direct read of the
 * Messages databases that was refused, in this machine's Concierge diagnostics. It never holds
 * message words: who asked, what was asked, and how many texts of which kind were withheld, so a
 * run of attempts to fish for codes is visible afterwards.
 */
export function messagesReadLogPath(environment: NodeJS.ProcessEnv = process.env): string {
  const state = environment.CONCIERGE_STATE_DIR?.trim()
    || (process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'concierge') : '/root/.local/state/concierge');
  return join(state, 'diagnostics', 'messages-reads.jsonl');
}

export function recordMessagesRead(entry: Record<string, unknown>): void {
  const path = messagesReadLogPath();
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ppid: process.ppid, ...entry }) + '\n', { mode: 0o600 });
}
