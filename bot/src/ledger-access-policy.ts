import { existsSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

/** Live schema has one owner. A helper importing a command must not migrate the ledger
 * before it runs that command; even a no-op UPDATE acquires SQLite's only writer. */
export function ledgerAccess(directory: string, main: string, readWorker: boolean) {
  const production = join(homedir(), '.local/state/concierge');
  const canonical = existsSync(production) ? realpathSync(production) : resolve(production);
  const sameFile = (left: string, right: string) => {
    if (!existsSync(left) || !existsSync(right)) return false;
    const a = statSync(left), b = statSync(right);
    return a.dev === b.dev && a.ino === b.ino;
  };
  const live = directory === canonical || sameFile(join(directory, 'state.db'), join(canonical, 'state.db'));
  const name = basename(main).replace(/\.[cm]?[jt]s$/, '');
  const readCommands: Record<string, readonly string[]> = {
    'release-manager': ['lkg', 'current', 'install-runtime', 'restore-lkg', 'set-control'],
    'deploy-state': ['status', 'get', 'active'],
  };
  const readonly = readWorker || (readCommands[name]?.includes(process.argv[2] ?? '') ?? false);
  const command = new Set(['deploy-state', 'release-manager', 'recover-deployment', 'session-turn-queue',
    'native-pipeline-continuation', 'clear-stale-account-notices', 'repair-inbox-needs']);
  const schema = !readonly && (!live && !command.has(name) || name === 'index' || name === 'migrate-deployment-repair');
  if (live) {
    const owners = new Set(['index', 'migrate-deployment-repair', 'deploy-state', 'release-manager',
      'recover-deployment', 'session-turn-queue', 'native-pipeline-continuation',
      'clear-stale-account-notices', 'repair-inbox-needs', 'native-read-worker',
      'provider-history-page-worker', 'provider-history-sync-worker']);
    // Bundles keep the reviewed entrypoint name. Source helpers must be this package's own
    // entrypoint, not an ad-hoc script importing its modules from a rehearsal directory.
    const source = /\.ts$/.test(main);
    const packageRoot = resolve(import.meta.dir, '..');
    const isSourceEntrypoint = [join(packageRoot, 'src', `${name}.ts`), join(packageRoot, 'scripts', `${name}.ts`)]
      .some(path => existsSync(path) && realpathSync(path) === realpathSync(main));
    const isReleaseEntrypoint = /\/slack-concierge-deployment\/releases\/[a-f0-9]+\/(?:control\/)?bot\/(?:src|scripts)\//.test(realpathSync(main));
    const isReleaseWorker = /\/slack-concierge-deployment\/releases\/[a-f0-9]+\/control\/application\//.test(realpathSync(main));
    const isReleaseController = /\/slack-concierge-deployment\/releases\/[a-f0-9]+\/control\/[^/]+\.js$/.test(realpathSync(main));
    const relativeHelper = realpathSync(main).slice(`${canonical}/helpers/`.length);
    const isPinnedHelper = realpathSync(main).startsWith(`${canonical}/helpers/`)
      && /^[a-f0-9]{40}\/bot\/scripts\/[^/]+\.js$/.test(relativeHelper);
    if (!owners.has(name) || !(source ? isSourceEntrypoint : isReleaseEntrypoint || isReleaseWorker || isReleaseController || isPinnedHelper))
      throw new Error('Live ledger access is reserved for installed owner and deployment commands. Run rehearsals on a bounded diagnostic snapshot.');
    if (schema && process.platform === 'linux') {
      const service = process.env.CONCIERGE_SERVICE || 'concierge-bot.service';
      const status = spawnSync('systemctl', ['show', service, '-p', 'MainPID', '-p', 'ControlPID', '-p', 'ActiveState'], { encoding: 'utf8' });
      const fields = Object.fromEntries(status.stdout.trim().split('\n').map(line => line.split('=')));
      const owner = name === 'index' && Number(fields.MainPID) === process.pid;
      const stopped = name === 'migrate-deployment-repair' && fields.MainPID === '0' && fields.ControlPID === '0'
        && ['inactive', 'failed'].includes(fields.ActiveState);
      if (status.status !== 0 || !(owner || stopped))
        throw new Error('Live schema setup requires the supervised owner startup or a fully stopped coordinator.');
    }
  }
  return { live, schema, readonly };
}
