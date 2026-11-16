import { existsSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {attestedLegacyLaunch,preinstallLegacyLaunch,RELEASE_LEDGER_HELPERS} from './deployment-launch-authority';

function canonicalLedgerDirectory():string {
  const production=join(homedir(),'.local/state/concierge');
  return existsSync(production)?realpathSync(production):resolve(production);
}

/** File identity also recognizes a caller's symlink or hardlink alias. */
export function sameLedgerFile(left:string,right:string):boolean {
  if(!existsSync(left)||!existsSync(right))return false;
  const a=statSync(left),b=statSync(right);
  return a.dev===b.dev&&a.ino===b.ino;
}

export function isLiveLedgerPath(path:string):boolean {
  const canonical=join(canonicalLedgerDirectory(),'state.db');
  return resolve(path)===canonical||sameLedgerFile(path,canonical);
}

export function requireOfflineReleaseServiceStopped(service:string,
  read:(service:string)=>{status:number|null;stdout:string}) {
  const status=read(service);
  const fields=Object.fromEntries(status.stdout.trim().split('\n').map(line => line.split('=')));
  if(status.status!==0||fields.LoadState!=='loaded'||!['inactive','failed'].includes(fields.ActiveState??'')
    ||!['dead','failed'].includes(fields.SubState??'')||fields.MainPID!=='0'||fields.ControlPID!=='0'||fields.Job!=='')
    throw new Error(`Offline release pointer publication requires ${service} fully stopped; observed ${JSON.stringify(fields)}.`);
}

/** Live schema has one owner. A helper importing a command must not migrate the ledger
 * before it runs that command; even a no-op UPDATE acquires SQLite's only writer. */
export function ledgerAccess(directory: string, main: string, readWorker: boolean) {
  const canonical = canonicalLedgerDirectory();
  const live = directory === canonical || isLiveLedgerPath(join(directory,'state.db'));
  const legacy=live&&(attestedLegacyLaunch()||preinstallLegacyLaunch());
  const name = basename(main).replace(/\.[cm]?[jt]s$/, '');
  const offlinePointerCommands = new Set(['activate','restore-lkg','promote','set-control']);
  if (live && process.platform === 'linux' && name === 'release-manager'
      && offlinePointerCommands.has(process.argv[2] ?? '') && process.env.CONCIERGE_RELEASE_OFFLINE === '1') {
    const service = process.env.CONCIERGE_SERVICE || 'concierge-bot.service';
    requireOfflineReleaseServiceStopped(service,unit=>{
      const status=spawnSync('systemctl',['show',unit,'-p','LoadState','-p','ActiveState','-p','SubState',
        '-p','MainPID','-p','ControlPID','-p','Job'],{encoding:'utf8'});
      return {status:status.status,stdout:status.stdout};
    });
  }
  const readCommands: Record<string, readonly string[]> = {
    'release-manager': ['lkg', 'current', 'install-runtime', 'install-launchers', 'restore-lkg', 'set-control'],
    'deploy-state': ['show', 'desired', 'repair-show'],
  };
  // The installed release controller sends its pre-stop mutations to the serving owner.
  // Its own connection only reads provenance, so it cannot hold the WAL writer during a build.
  const ownerServedReleaseCommand = live && process.platform === 'linux'
    && !legacy
    && name === 'release-manager'
    && ['prepare', 'activate', 'restore-lkg', 'lkg', 'promote', 'set-control', 'prune'].includes(process.argv[2] ?? '');
  // Claiming a run was still an independent live writer after release preparation moved
  // to the owner. Its short-lived connection held WAL locks while it closed under disk load.
  const ownerServedDeploymentCommand = live && process.platform === 'linux'
    && !legacy
    && name === 'deploy-state'
    && ['claim', 'phase', 'show', 'desired', 'succeed', 'fail', 'preserved-checkout'].includes(process.argv[2] ?? '');
  const forbidControllerLedgerOpen = live && process.platform === 'linux'
    && (ownerServedReleaseCommand || ownerServedDeploymentCommand
      || (!legacy && RELEASE_LEDGER_HELPERS.includes(name as typeof RELEASE_LEDGER_HELPERS[number]))
      || name === 'native-pipeline-continuation'
      || (name === 'release-manager' && ['install-runtime', 'install-launchers', 'current', 'set-control'].includes(process.argv[2] ?? '')));
  // Canonical native readers remain physically readonly even if a future caller
  // forgets to propagate its role environment before the worker's static imports.
  const nativeReader=['native-read-worker','provider-history-page-worker','provider-history-sync-worker'].includes(name);
  const readonly = readWorker || nativeReader || ownerServedReleaseCommand || ownerServedDeploymentCommand
    || (!legacy&&(readCommands[name]?.includes(process.argv[2] ?? '') ?? false));
  const command = new Set<string>([...RELEASE_LEDGER_HELPERS,'native-pipeline-continuation']);
  const schema = !readonly && (!live && !command.has(name) || name === 'index' || name === 'migrate-deployment-repair');
  if (live) {
    const owners = new Set<string>(['index', 'migrate-deployment-repair', ...RELEASE_LEDGER_HELPERS,
      'native-pipeline-continuation', 'native-read-worker',
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
  return { live, schema, readonly, ownerServedReleaseCommand, ownerServedDeploymentCommand,
    forbidControllerLedgerOpen };
}
