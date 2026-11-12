import { readFileSync, realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseShell } from './history-rewrite-policy';

const THINKERING_SOURCE = '/root/workspace/thinkering';
const THINKERING_INSTALLED = '/srv/thinkering';
const INSTALLED_ENTRANCE = `${THINKERING_INSTALLED}/current/scripts/deploy.sh`;
const POLICY_FILE = `${THINKERING_INSTALLED}/retention-policy.json`;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const RETENTION_ACTIONS = new Set(['prune', 'activate', 'rollback', 'policy-upgrade']);

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function refusalForScript(script: string, action: string, cwd: string): string | null {
  if (!RETENTION_ACTIONS.has(action)) return null;
  const candidate = resolve(cwd, script);
  if (!inside(candidate, THINKERING_SOURCE) && !inside(candidate, THINKERING_INSTALLED)) return null;
  const name = basename(candidate);
  if (name !== 'deploy.sh' && name !== 'deployment.mjs') return null;
  const route = `Use /srv/thinkering/current/scripts/deploy.sh retention-status to inspect the pinned policy, then /srv/thinkering/current/scripts/deploy.sh ${action} only when the installed release matches that policy. Normal activation uses npm run ship.`;
  if (name === 'deployment.mjs' || candidate !== INSTALLED_ENTRANCE)
    return `Refused: direct Thinkering cleanup from this source can run an obsolete retention policy. ${route}`;
  try {
    const policy = JSON.parse(readFileSync(POLICY_FILE, 'utf8')) as { version?: number; revision?: string; releasePath?: string };
    if (policy.version !== 1 || typeof policy.revision !== 'string' || !/^[0-9a-f]{40}$/.test(policy.revision)
      || policy.releasePath !== `${THINKERING_INSTALLED}/releases/${policy.revision}`
      || realpathSync(INSTALLED_ENTRANCE) !== `${policy.releasePath}/scripts/deploy.sh`)
      return `Refused: the installed Thinkering cleanup entrance does not match its pinned retention policy. ${route}`;
  } catch {
    return `Refused: the installed Thinkering cleanup authority could not be verified. ${route}`;
  }
  return null;
}

/** Managed release commands that can prune must use the installed, pinned Thinkering entrance. */
export function thinkeringRetentionCommandRefusal(source: string, cwd: string, depth = 0): string | null {
  if (depth > 4) return null;
  let dir = cwd;
  for (const command of parseShell(source)) {
    for (const substitution of command.substitutions) {
      const nested = thinkeringRetentionCommandRefusal(substitution, dir, depth + 1);
      if (nested) return nested;
    }
    const words = command.words.map(word => word.text);
    if (!words.length) continue;
    if (words[0] === 'cd') {
      dir = resolve(dir, words[1] ?? process.env.HOME ?? '/');
      continue;
    }
    let index = 0;
    while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index++;
    while (['sudo', 'env', 'nice', 'ionice', 'nohup', 'timeout', 'flock', 'command', 'exec'].includes(basename(words[index] ?? ''))) {
      const wrapper = basename(words[index] ?? '');
      index++;
      while (index < words.length && (words[index]!.startsWith('-') || /^\d+(?:[smh])?$/.test(words[index]!)
        || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!))) index++;
      if (wrapper === 'flock' && words[index]) index++;
    }
    const executable = basename(words[index] ?? '');
    if (SHELLS.has(executable) && /^-[a-z]*c[a-z]*$/.test(words[index + 1] ?? '')) {
      const nested = thinkeringRetentionCommandRefusal(words[index + 2] ?? '', dir, depth + 1);
      if (nested) return nested;
      continue;
    }
    if (executable === 'npm' && words[index + 1] === 'run' && words[index + 2] === 'prune'
      && (inside(dir, THINKERING_SOURCE) || inside(dir, THINKERING_INSTALLED)))
      return 'Refused: a checkout-owned Thinkering prune script may use an obsolete retention policy. Use the installed cleanup entrance after checking retention-status.';
    let scriptIndex = index;
    if (executable === 'node' || SHELLS.has(executable)) {
      scriptIndex++;
      while (words[scriptIndex]?.startsWith('-')) scriptIndex++;
    }
    const script = words[scriptIndex];
    if (!script) continue;
    const action = words[scriptIndex + 1] ?? '';
    const found = refusalForScript(script, action, dir);
    if (found) return found;
  }
  return null;
}
