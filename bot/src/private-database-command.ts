import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { liveStores } from './live-store-locations';

function loopBackingFiles(directories: string[]): string[] {
  const mounts = readFileSync('/proc/self/mountinfo', 'utf8').split('\n').flatMap(line => {
    const parts = line.split(' ');
    const separator = parts.indexOf('-');
    if (separator < 0 || !/^\/dev\/loop\d+$/.test(parts[separator + 2] ?? '')) return [];
    const mountPoint = parts[4].replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    return [{ mountPoint, device: basename(parts[separator + 2]) }];
  });
  const files = new Set<string>();
  for (const directory of directories) {
    const mount = mounts.filter(({ mountPoint }) => directory === mountPoint || directory.startsWith(`${mountPoint}/`))
      .sort((a, b) => b.mountPoint.length - a.mountPoint.length)[0];
    if (!mount) continue;
    const backing = readFileSync(`/sys/block/${mount.device}/loop/backing_file`, 'utf8').trim();
    const file = realpathSync(backing);
    if (!statSync(file).isFile()) throw new Error(`Live store loop backing is not a file: ${file}`);
    files.add(file);
  }
  return [...files];
}

/** Release fixtures cannot open live stores through raw SQLite or filesystem APIs.
 * Mount isolation is inherited by descendants and ends with the check process. */
export function privateDatabaseCommand(command: string[], allowPrivateMounts = false): string[] {
  if (process.platform !== 'linux') return command;
  const state = join(homedir(), '.local/state/concierge');
  if (!existsSync(state)) return command;
  // A child of this boundary inherits the inaccessible mount. Ordinary checks
  // drop capabilities; the code launcher uses a second user namespace so its
  // mount-capable children cannot unmount the protected outer mounts.
  try { accessSync(state, constants.R_OK | constants.X_OK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EACCES') return command; throw error; }
  if (!existsSync('/usr/bin/bwrap')) throw new Error('Release database isolation requires bubblewrap.');
  // The ledger's own filesystem is reached directly too, not only through the state directory's
  // link, so every live directory that link record names is hidden (2026-10-16).
  const directories = liveStores(state).directories.filter(directory => existsSync(directory));
  const hidden = [
    ...loopBackingFiles(directories).flatMap(file => ['--ro-bind', '/dev/null', file]),
    ...directories.flatMap(directory => ['--tmpfs', directory, '--chmod', '000', directory]),
  ];
  const outer = ['/usr/bin/bwrap', '--die-with-parent', '--bind', '/', '/', '--dev', '/dev',
    '--unshare-user', '--uid', '0', '--gid', '0', ...hidden, '--'];
  if (allowPrivateMounts) {
    // The outer mounts are locked in this less privileged namespace. The
    // phone-width checker can mount its own overlay without exposing the ledger.
    return [...outer, '/usr/bin/bwrap', '--die-with-parent', '--bind', '/', '/', '--dev', '/dev',
      '--unshare-user', '--uid', '0', '--gid', '0', '--cap-drop', 'ALL',
      '--cap-add', 'CAP_SYS_ADMIN', '--cap-add', 'CAP_DAC_OVERRIDE',
      '--', ...command];
  }
  return [...outer.slice(0, -1), '--cap-drop', 'ALL', '--', ...command];
}
