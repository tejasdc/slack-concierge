import { homedir } from 'node:os';
import { join } from 'node:path';

/** Each machine installs this wrapper outside the changing release tree. */
export function installedRouterActionsPath(home = homedir()): string {
  return join(home, '.local', 'bin', 'router-actions.sh');
}
