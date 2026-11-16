import { accessSync, constants, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, realpathSync, readlinkSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
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
export function privateDatabaseCommand(command: string[], allowPrivateMounts = false, additionalOuterArgs: string[] = [], masks?:PrivateDatabaseMasks): string[] {
  if (process.platform !== 'linux') return command;
  if (additionalOuterArgs.length===0 && hasVerifiedPrivateCodeBoundary(process.env)) return command;
  const state = join(homedir(), '.local/state/concierge');
  if (!existsSync(state) && additionalOuterArgs.length===0) return command;
  // A child of this boundary inherits the inaccessible mount. Ordinary checks
  // drop capabilities; the code launcher uses a second user namespace so its
  // mount-capable children cannot unmount the protected outer mounts.
  let stateReadable=existsSync(state);
  if(stateReadable)try { accessSync(state, constants.R_OK | constants.X_OK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EACCES') {
      if(additionalOuterArgs.length===0)return command;
      stateReadable=false;
    } else throw error;
  }
  if (!existsSync('/usr/bin/bwrap')) throw new Error('Release database isolation requires bubblewrap.');
  // The ledger's own filesystem is reached directly too, not only through the state directory's
  // link, so every live directory that link record names is hidden (2026-10-16).
  const directories = stateReadable?liveStores(state).directories.filter(directory => existsSync(directory)):[];
  const backingFiles=loopBackingFiles(directories);
  const nullSource=statSync('/dev/null');
  const hidden = [
    ...backingFiles.flatMap(file => ['--ro-bind', '/dev/null', file]),
    ...directories.flatMap(directory => ['--tmpfs', directory, '--chmod', '000', directory]),
  ];
  const databaseMasks=masks??{directories,backingFiles,nullIdentity:{device:nullSource.dev,inode:nullSource.ino}};
  const outer = ['/usr/bin/bwrap', '--die-with-parent', '--bind', '/', '/', '--dev', '/dev',
    // Home/layout rebinds must precede protected masks: bwrap bind sources can
    // reference the original root, so a later layout bind could expose them again.
    '--unshare-user', '--uid', '0', '--gid', '0', ...additionalOuterArgs, ...hidden,
    '--setenv','CONCIERGE_PRIVATE_DATABASE_MASKS',JSON.stringify(databaseMasks),'--'];
  if (allowPrivateMounts) {
    // The outer mounts are locked in this less privileged namespace. The
    // disposable checks can mount their own overlays without exposing the ledger.
    return [...outer, '/usr/bin/bwrap', '--die-with-parent', '--bind', '/', '/', '--dev', '/dev',
      '--unshare-user', '--uid', '0', '--gid', '0', '--cap-drop', 'ALL',
      '--cap-add', 'CAP_SYS_ADMIN', '--cap-add', 'CAP_DAC_OVERRIDE',
      // Nested private fixture namespaces map their parent UID0. Linux5.12+
      // requires SETFCAP in this private namespace; no host capability is gained.
      '--cap-add', 'CAP_SETFCAP',
      '--', ...command];
  }
  return [...outer.slice(0, -1), '--cap-drop', 'ALL', '--', ...command];
}

const CODEX_ENDPOINT_ENV=['CONCIERGE_CODEX_APP_SERVER_SOCKET','CONCIERGE_CODEX_RUNNER','CONCIERGE_CODEX_EXECUTABLE',
  'CONCIERGE_CODEX_CLI','CONCIERGE_CODEX_BIN','CODEX_CLI','CODEX_HOME','CODEX_SYSTEM_DIR','CONCIERGE_CODEX_SYSTEM_DIR'];
const PROCESS_CONTROL_COMMANDS=['systemctl','systemd-run','prlimit','busctl'];

type PrivateDatabaseMasks={directories:string[];backingFiles:string[];nullIdentity:{device:number;inode:number}};

export function hasVerifiedPrivateCodeBoundary(environment:NodeJS.ProcessEnv):boolean {
  if(environment.CONCIERGE_PRIVATE_CODE_BOUNDARY_VERIFIED!=='1')return false;
  try {
    if(readlinkSync('/proc/self/ns/pid')!==environment.CONCIERGE_PRIVATE_CODE_PID_NAMESPACE)return false;
    const home=environment.CONCIERGE_PRIVATE_CODE_HOME_DIRECTORY;
    if(!home||realpathSync(homedir())!==home||(environment.HOME??null)!==JSON.parse(environment.CONCIERGE_PRIVATE_CODE_HOME_ORIGINAL??'null'))return false;
    const mounts=readFileSync('/proc/self/mountinfo','utf8').split('\n').map(line=>line.split(' '));
    const hasMount=(point:string,type:string)=>mounts.some(row=>row[4]===point&&row[row.indexOf('-')+1]===type);
    const codex=join(home,'.codex');
    if(!mounts.some(row=>row[4]===home)||!hasMount(codex,'tmpfs'))return false;
    const codexIdentity=JSON.parse(environment.CONCIERGE_PRIVATE_CODE_CODEX_IDENTITY??'null');
    const codexMetadata=statSync(codex);
    if(!Array.isArray(codexIdentity)||codexMetadata.dev!==codexIdentity[0]||codexMetadata.ino!==codexIdentity[1])return false;
    const blocked=JSON.parse(environment.CONCIERGE_PRIVATE_BLOCKED_EXECUTABLES??'[]') as string[];
    const falseFile=statSync('/usr/bin/false');
    if(blocked.length===0||blocked.some(path=>{const item=statSync(path);return item.dev!==falseFile.dev||item.ino!==falseFile.ino;}))return false;
    const masks=JSON.parse(environment.CONCIERGE_PRIVATE_DATABASE_MASKS??'null') as PrivateDatabaseMasks|null;
    if(!masks||!Array.isArray(masks.directories)||!Array.isArray(masks.backingFiles)||!masks.nullIdentity)return false;
    const state=join(home,'.local/state/concierge');
    if(existsSync(state)){const item=statSync(state);if((item.mode&0o777)!==0||!hasMount(realpathSync(state),'tmpfs'))return false;}
    for(const directory of masks.directories){
      const item=statSync(directory);
      if((item.mode&0o777)!==0||!hasMount(directory,'tmpfs'))return false;
    }
    const nullFile=masks.nullIdentity;
    for(const path of masks.backingFiles){
      const item=statSync(path);
      if(!item.isCharacterDevice()||item.dev!==nullFile.device||item.ino!==nullFile.inode||!mounts.some(row=>row[4]===path))return false;
    }
    return true;
  }catch{return false;}
}

function resolvedControlExecutables(pathValue:string|undefined):string[] {
  const directories=new Set(['/usr/bin','/bin','/usr/sbin','/sbin','/usr/local/bin','/usr/local/sbin',
    ...(pathValue??'').split(':').map(directory=>directory||process.cwd())]);
  const paths=new Set<string>();
  for(const name of PROCESS_CONTROL_COMMANDS)for(const directory of directories){
    const candidate=join(directory,name);
    try{if(existsSync(candidate)&&statSync(candidate).isFile())paths.add(realpathSync(candidate));}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  return [...paths].sort();
}

export function privateCodeHomeMountArgs(homeDirectory:string):{args:string[];staging:string;cleanup:()=>void} {
  const home=realpathSync(homeDirectory);
  if(home==='/'||!statSync(home).isDirectory())throw new Error('Private code isolation requires a non-root home directory.');
  const codexHome=join(home,'.codex');
  const codexEntry=lstatSync(codexHome,{throwIfNoEntry:false});
  if(codexEntry?.isSymbolicLink())throw new Error('Private code isolation refuses a symlinked Codex home.');
  if(codexEntry&&!codexEntry.isDirectory())throw new Error('Private code isolation requires the Codex home path to be a directory.');
  const entries=readdirSync(home).filter(name=>name!=='.codex');
  const staging=join('/tmp',`concierge-private-home-${randomUUID()}`);
  const sourceAlias=join('/tmp',`concierge-private-home-source-${randomUUID()}`);
  mkdirSync(staging,{mode:0o700});
  try {
    mkdirSync(sourceAlias,{mode:0o700});
    for(const name of entries){
      const source=join(home,name),target=join(staging,name),entry=lstatSync(source);
      if(entry.isSymbolicLink()){
        try {
          const resolved=realpathSync(source);
          if(resolved===codexHome||resolved.startsWith(`${codexHome}/`))
            throw new Error(`Private code isolation found a home alias to Codex data: ${name}`);
        }catch(error){
          if(error instanceof Error&&error.message.startsWith('Private code isolation found'))throw error;
          if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
        }
        symlinkSync(readlinkSync(source),target);
      }else if(entry.isDirectory())mkdirSync(target,{mode:entry.mode&0o777});
      else {const fd=openSync(target,'w',entry.mode&0o777);closeSync(fd);}
      if(!entry.isSymbolicLink())symlinkSync(source,join(sourceAlias,name));
    }
    const args:string[]=['--dir',sourceAlias,'--bind',home,sourceAlias,
      '--bind',staging,home,'--tmpfs',staging];
    for(const name of entries){
      const entry=lstatSync(join(home,name));
      if(!entry.isSymbolicLink())args.push('--bind',join(sourceAlias,name),join(home,name));
    }
    args.push('--tmpfs',sourceAlias,'--dir',join(home,'.codex'),
      '--tmpfs',join(home,'.codex'),'--chmod','0700',join(home,'.codex'));
    return {args,staging,cleanup:()=>{try{rmSync(staging,{recursive:true,force:true});}finally{rmSync(sourceAlias,{recursive:true,force:true});}}};
  }catch(error){try{rmSync(staging,{recursive:true,force:true});}finally{rmSync(sourceAlias,{recursive:true,force:true});}throw error;}
}

const PRIVATE_CODE_PREFLIGHT=`import hashlib,json,os,stat,sys
spec=json.loads(sys.argv[1]); args=sys.argv[2:]
if args and args[0]=='--': args=args[1:]
if not args: raise SystemExit('PRIVATE_CODE_COMMAND_REQUIRED')
if os.environ.get('HOME') != spec['homeEnvironment']: raise SystemExit('PRIVATE_CODE_HOME_ENV_CHANGED')
if os.readlink('/proc/self/ns/pid') == spec['parentPidNamespace']: raise SystemExit('PRIVATE_CODE_PID_NAMESPACE_NOT_PRIVATE')
mounts=[]
for line in open('/proc/self/mountinfo',encoding='utf-8'):
 fields=line.split(); sep=fields.index('-'); point=fields[4].replace('\\040',' '); fstype=fields[sep+1]
 mounts.append((point,fstype))
state_path=os.path.join(spec['homeDirectory'],'.local/state/concierge')
try: state_metadata=os.stat(state_path)
except FileNotFoundError: state_mask='absent'
else:
 actual=os.path.realpath(state_path)
 if stat.S_IMODE(state_metadata.st_mode)!=0 or not any(point in (state_path,actual) and fstype=='tmpfs' for point,fstype in mounts): raise SystemExit('PRIVATE_CODE_LIVE_DATABASE_MASK_UNCONFIRMED')
 state_mask='masked'
for directory in spec['databaseMasks']['directories']:
 item=os.stat(directory)
 if stat.S_IMODE(item.st_mode)!=0 or not any(point==directory and fstype=='tmpfs' for point,fstype in mounts): raise SystemExit('PRIVATE_CODE_DATABASE_DIRECTORY_MASK_UNCONFIRMED:'+directory)
expected_null=spec['databaseMasks']['nullIdentity']
for path in spec['databaseMasks']['backingFiles']:
 item=os.stat(path)
 if not stat.S_ISCHR(item.st_mode) or (item.st_dev,item.st_ino)!=(expected_null['device'],expected_null['inode']) or not any(point==path for point,_ in mounts): raise SystemExit('PRIVATE_CODE_BACKING_MASK_UNCONFIRMED:'+path)
if not any(point==spec['homeDirectory'] for point,_ in mounts): raise SystemExit('PRIVATE_CODE_HOME_NOT_OVERLAID')
if ('/proc','proc') not in mounts: raise SystemExit('PRIVATE_CODE_PROC_NOT_PRIVATE')
codex=os.path.join(spec['homeDirectory'],'.codex')
if not any(point==codex and fstype=='tmpfs' for point,fstype in mounts): raise SystemExit('PRIVATE_CODE_CODEX_HOME_NOT_TMPFS')
if not os.path.isdir(codex) or os.listdir(codex): raise SystemExit('PRIVATE_CODE_CODEX_HOME_NOT_EMPTY_TMPFS')
false=os.stat('/usr/bin/false')
for path in spec['blockedExecutables']:
 item=os.stat(path)
 if (item.st_dev,item.st_ino)!=(false.st_dev,false.st_ino): raise SystemExit('PRIVATE_CODE_CONTROL_EXECUTABLE_NOT_BLOCKED:'+path)
for name in spec['clearedCodexEnvironment']:
 if os.environ.get(name): raise SystemExit('PRIVATE_CODE_CODEX_ENV_INHERITED:'+name)
os.environ['CONCIERGE_PRIVATE_CODE_BOUNDARY_VERIFIED']='1'
os.environ['CONCIERGE_PRIVATE_CODE_HOME_ORIGINAL']=json.dumps(spec['homeEnvironment'])
os.environ['CONCIERGE_PRIVATE_BLOCKED_EXECUTABLES']=json.dumps(spec['blockedExecutables'])
os.environ['CONCIERGE_PRIVATE_DATABASE_MASK_VERIFIED']=state_mask
os.environ['CONCIERGE_PRIVATE_DATABASE_MASKS']=json.dumps(spec['databaseMasks'],separators=(',',':'))
os.environ['CONCIERGE_PRIVATE_CODE_PID_NAMESPACE']=os.readlink('/proc/self/ns/pid')
os.environ['CONCIERGE_PRIVATE_CODE_HOME_DIRECTORY']=spec['homeDirectory']
codex_metadata=os.stat(codex)
os.environ['CONCIERGE_PRIVATE_CODE_CODEX_IDENTITY']=json.dumps([codex_metadata.st_dev,codex_metadata.st_ino])
os.execvpe(args[0],args,os.environ)`;

/**
 * Add the independent process/data boundary used by the private-code entrance.
 * This layer runs inside the existing locked live-store namespace and verifies
 * itself before it execs any fixture or application module.
 */
export function privateCodeCommand(command:string[],environment:NodeJS.ProcessEnv):{command:string[];environment:NodeJS.ProcessEnv;cleanup:()=>void} {
  // As privateDatabaseCommand always has: isolation hides the live ledger, so a machine without
  // one (a Mac peer, GitHub's runner) runs the command as before. Checks that need the verified
  // boundary refuse to start without it rather than passing unisolated.
  if(process.platform!=='linux'||!existsSync(join(homedir(),'.local/state/'+'concierge')))
    return {command,environment:{...environment},cleanup:()=>{}};
  if(hasVerifiedPrivateCodeBoundary(environment))return {command,environment:{...environment},cleanup:()=>{}};
  const homeDirectory=realpathSync(homedir());
  const configuredHome=environment.HOME??homedir();
  if(realpathSync(configuredHome)!==homeDirectory)throw new Error('Private code isolation requires HOME to name the active home directory.');
  const home=privateCodeHomeMountArgs(homeDirectory);
  try{
    const blockedExecutables=resolvedControlExecutables(environment.PATH);
    const parentPidNamespace=readlinkSync('/proc/self/ns/pid');
    const sanitized={...environment};
    for(const name of CODEX_ENDPOINT_ENV)delete sanitized[name];
    const state=join(homedir(),'.local/state/concierge');
    const directories=existsSync(state)?liveStores(state).directories.filter(directory=>existsSync(directory)):[];
    const nullSource=statSync('/dev/null');
    const databaseMasks={directories,backingFiles:loopBackingFiles(directories),nullIdentity:{device:nullSource.dev,inode:nullSource.ino}};
    const spec={homeDirectory,homeEnvironment:environment.HOME??null,parentPidNamespace,
      databaseMasks,
      blockedExecutables,clearedCodexEnvironment:CODEX_ENDPOINT_ENV};
    const preflight=['/usr/bin/python3','-I','-S','-c',PRIVATE_CODE_PREFLIGHT,JSON.stringify(spec),'--',...command];
    const outerIsolation=['--unshare-pid','--proc','/proc',...home.args,
      ...blockedExecutables.flatMap(path=>['--ro-bind','/usr/bin/false',path])];
    const databaseProtected=privateDatabaseCommand(preflight,true,outerIsolation,databaseMasks);
    return {command:databaseProtected,environment:sanitized,cleanup:home.cleanup};
  }catch(error){home.cleanup();throw error;}
}
