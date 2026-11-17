import { existsSync, statSync } from 'node:fs';

// This host-owned address remains known after the ledger mount and state links are hidden.
export const LEDGER_IMAGE_PATH = '/var/lib/concierge-ledger.img';
const INACCESSIBLE_DEVICE = '/run/systemd/inaccessible/chr';

function inaccessibleDevice(path: string): boolean {
  try { const stat = statSync(path); return stat.isCharacterDevice() && stat.rdev === 0; }
  catch { return false; }
}

/** Deny even opening the backing image, without moving the owner or backup processes.
 * A null-device bind still opens successfully; systemd's inaccessible 0:0 device does not,
 * including for mount-capable private checks that retain DAC override. */
export function agentLedgerImageCommand(command: string[], paths = [LEDGER_IMAGE_PATH]): string[] {
  if (process.platform !== 'linux') return command;
  const targets = paths.filter(path => existsSync(path) && !inaccessibleDevice(path));
  if (!targets.length) return command;
  if (!existsSync('/usr/bin/bwrap') || !inaccessibleDevice(INACCESSIBLE_DEVICE))
    throw new Error('Agent ledger image isolation requires bubblewrap and systemd inaccessible devices.');
  return ['/usr/bin/bwrap', '--die-with-parent', '--bind', '/', '/', '--dev', '/dev',
    ...targets.flatMap(path => ['--ro-bind', INACCESSIBLE_DEVICE, path]),
    '--unshare-user', '--uid', '0', '--gid', '0', '--',
    // A second user namespace locks the inherited image mount against unmount, while
    // retaining capabilities in that namespace for ordinary root tools/private checks.
    '/usr/bin/bwrap', '--die-with-parent', '--bind', '/', '/', '--dev', '/dev',
    '--unshare-user', '--uid', '0', '--gid', '0', '--cap-add', 'ALL', '--', ...command];
}

export function codexDaemonImageCommand(command: string, args: string[]): string[] {
  return args[0] === 'app-server' && args[1] === 'daemon' && ['start', 'restart'].includes(args[2] ?? '')
    ? agentLedgerImageCommand([command, ...args]) : [command, ...args];
}
