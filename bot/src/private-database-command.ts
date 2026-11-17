import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync, statSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { liveStores } from './live-store-locations';
import { agentLedgerImageCommand, LEDGER_IMAGE_PATH } from './agent-ledger-image-boundary';

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

const TMPFS_MAGIC = 0x01021994;
/** True when the canonical state directory is already the boundary's own mask: an empty,
 * mode-000 tmpfs. A permission probe alone is not enough: the private code entrance keeps
 * CAP_DAC_OVERRIDE for its mount-capable children, so the mask still reads as accessible
 * there, and a nested user namespace then fails with "setting up uid map" (2026-11-17).
 * The mask counts only inside a non-initial user namespace, where inherited mounts are locked.
 * In the initial namespace (an agent shell under systemd's own mask) root could unmount it,
 * so the launcher still wraps the command to lock that mask for mount-capable children. */
export function inheritedDatabaseBoundary(state = join(homedir(), '.local/state/concierge')): boolean {
  try { accessSync(state, constants.R_OK | constants.X_OK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EACCES') return true; throw error; }
  const initialUserNamespace = /^\s*0\s+0\s+4294967295\s*$/.test(readFileSync('/proc/self/uid_map', 'utf8'));
  return !initialUserNamespace && (statSync(state).mode & 0o7777) === 0 && statfsSync(state).type === TMPFS_MAGIC
    && readdirSync(state).length === 0;
}

function inheritedLegacyImageMask(): boolean {
  if (/^\s*0\s+0\s+4294967295\s*$/.test(readFileSync('/proc/self/uid_map', 'utf8'))) return false;
  try {
    const image = statSync(LEDGER_IMAGE_PATH);
    return image.isCharacterDevice() && image.rdev === statSync('/dev/null').rdev;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Release fixtures cannot open live stores through raw SQLite or filesystem APIs.
 * Mount isolation is inherited by descendants and ends with the check process. */
export function privateDatabaseCommand(command: string[], allowPrivateMounts = false): string[] {
  if (process.platform !== 'linux') return command;
  const state = join(homedir(), '.local/state/concierge');
  if (!existsSync(state)) return agentLedgerImageCommand(command);
  // A child of this boundary inherits the masked directory. Ordinary checks
  // drop capabilities; the code launcher uses a second user namespace so its
  // mount-capable children cannot unmount the protected outer mounts.
  if (inheritedDatabaseBoundary(state)) {
    // The preceding sealed builder masks the image with /dev/null and drops capabilities.
    // Its children cannot replace that mask or create the new launcher's user namespaces.
    // Reuse that byte-isolation boundary only here; agent launches still require deny-open.
    if (inheritedLegacyImageMask()) return command;
    return agentLedgerImageCommand(command);
  }
  if (!existsSync('/usr/bin/bwrap')) throw new Error('Release database isolation requires bubblewrap.');
  // The ledger's own filesystem is reached directly too, not only through the state directory's
  // link, so every live directory that link record names is hidden (2026-10-16).
  const directories = liveStores(state).directories.filter(directory => existsSync(directory));
  const hidden = [
    ...[...new Set([...loopBackingFiles(directories), ...(existsSync(LEDGER_IMAGE_PATH) ? [LEDGER_IMAGE_PATH] : [])])]
      .flatMap(file => ['--ro-bind', '/run/systemd/inaccessible/chr', file]),
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
