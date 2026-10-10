import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Release fixtures cannot open live stores through raw SQLite or filesystem APIs.
 * Mount isolation is inherited by descendants and ends with the check process. */
export function privateDatabaseCommand(command: string[]): string[] {
  if (process.platform !== 'linux') return command;
  const state = join(homedir(), '.local/state/concierge');
  if (!existsSync(state)) return command;
  // A child of this boundary inherits the inaccessible mount. Linux refuses another
  // user namespace after capabilities are dropped, and none is needed to hide it again.
  try { accessSync(state, constants.R_OK | constants.X_OK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EACCES') return command; throw error; }
  if (!existsSync('/usr/bin/bwrap')) throw new Error('Release database isolation requires bubblewrap.');
  return ['/usr/bin/bwrap', '--die-with-parent', '--bind', '/', '/', '--dev', '/dev', '--unshare-user', '--uid', '0', '--gid', '0',
    '--cap-drop', 'ALL', '--tmpfs', realpathSync(state), '--chmod', '000', realpathSync(state), '--', ...command];
}
