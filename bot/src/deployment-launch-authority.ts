import {createHash} from 'node:crypto';
import {closeSync,existsSync,fstatSync,lstatSync,mkdirSync,openSync,readFileSync,readlinkSync,readdirSync,realpathSync,renameSync,statSync,writeFileSync} from 'node:fs';
import {basename,join,resolve} from 'node:path';
import {execFile,execFileSync,spawn,spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir as mkdirAsync,open as openAsync,readFile as readFileAsync,readdir as readdirAsync,rename as renameAsync,unlink as unlinkAsync,writeFile as writeFileAsync} from 'node:fs/promises';
import {isLiveLedgerPath} from './ledger-access-policy';
import {processNativeLifetimeEnded,processNativeLifetimesEnded} from './runtime-identity';

const runFile=promisify(execFile);
export const LEDGER_COMMAND_EXPORT='conciergeLedgerCommandsV1';
export const LAUNCH_AUTHORITY_CAPABILITY='control/deployment-launch-authority.js';
export const deploymentReleaseRoot=()=>resolve(process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT??'/var/lib/slack-concierge-deployment');
export const deploymentRuntimeRoot=()=>resolve(process.env.CONCIERGE_DEPLOYMENT_RUNTIME_DIR??'/usr/local/lib/slack-concierge-deployment');
export const launchAuthorityRoot=()=>join(deploymentReleaseRoot(),'launch-authority');
export const deploymentSelectionLock=()=>join(launchAuthorityRoot(),'selection.lock');
export type ManagedLaunch={unit:string;invocationId:string;controlGroup:string;device:number;inode:number;bootId:string};
export type SelectedProcess={pid:number;bootId:string;startTicks:string;main:string;device:number;inode:number};
export type LaunchBootstrap={format:1;artifact:string;bootId:string;units:ManagedLaunch[];processes:SelectedProcess[];launchersClosed?:boolean;nativeComplete?:boolean};

function publish(path:string,value:unknown){
 const temporary=path+'.'+process.pid+'.tmp';
 writeFileSync(temporary,JSON.stringify(value),{mode:0o600});renameSync(temporary,path);
}
async function publishAsync(path:string,value:unknown){
 const temporary=path+'.'+process.pid+'.tmp';await writeFileAsync(temporary,JSON.stringify(value),{mode:0o600});await renameAsync(temporary,path);
}
export function prepareLaunchAuthority(){
 mkdirSync(join(launchAuthorityRoot(),'legacy'),{recursive:true,mode:0o700});
}
/** File-only controller operations run outside the serving process. Their short
 * publication lock is independent of every inherited legacy lifetime lock. */
export function withLaunchSelection<T>(operation:()=>T,root=launchAuthorityRoot()):T{
 mkdirSync(root,{recursive:true,mode:0o700});
 const fd=openSync(join(root,'selection.lock'),'a',0o600);
 try{
  const held=spawnSync('/usr/bin/flock',['-x','3'],{stdio:['ignore','ignore','pipe',fd]});
  if(held.status!==0)throw Error('Release publication exclusion was not acquired.');
  return operation();
 }finally{closeSync(fd);}
}
/** flock operates on the shared open-file description passed as descriptor 3.
 * The launcher keeps its own reference through the child's full native exit. */
export type HeldLaunchLock=(()=>Promise<void>)&{descriptor:number};
export async function acquireLaunchLock(path:string,exclusive:boolean,nonblocking=false):Promise<null|HeldLaunchLock>{
 await mkdirAsync(join(launchAuthorityRoot(),'legacy'),{recursive:true,mode:0o700});
 const handle=await openAsync(path,'a',0o600),fd=handle.fd;
 try{
  const child=spawn('/usr/bin/flock',[exclusive?'-x':'-s',...(nonblocking?['-n']:[]),'3'],
   {stdio:['ignore','ignore','pipe',fd]});
  const code=await new Promise<number>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code??1));});
  if(code!==0){await handle.close();if(nonblocking&&code===1)return null;throw Error('Release selection lock was not acquired.');}
  let closing:Promise<void>|null=null;return Object.assign(()=>closing??=(handle.close()),{descriptor:fd});
 }catch(error){try{await handle.close();}catch{}throw error;}
}

/** This is the existing managed launch set, not a scan for privileged executables.
 * Install the machine wrappers before enumerating: later selections necessarily use
 * them; already accepted jobs and their cgroups remain bootstrap obligations. */
const unitList=['list-units','--all','--plain','--no-legend','--no-pager','--type=service'];
const jobList=['list-jobs','--no-legend','--no-pager'];
const unitDetails=(unit:string)=>['show',unit,'-p','InvocationID','-p','ControlGroup','-p','ActiveState','-p','Job'];
function managedLaunchNames(unitRows:string,jobRows:string):Set<string>{
 const own=process.env.CONCIERGE_SERVICE??'concierge-bot.service';
 const names=new Set<string>();
 for(const line of unitRows.split('\n')){
  const unit=line.trim().split(/\s+/)[0]??'';
  if(/^concierge-(?:deploy-|deployment-repair@|control-recovery-).*\.service$/.test(unit))names.add(unit);
 }
 for(const line of jobRows.split('\n')){
  const unit=line.trim().split(/\s+/)[1]??'';
  if(unit!==own&&/^concierge-(?:deploy-|deployment-repair@|control-recovery-).*\.service$/.test(unit))names.add(unit);
 }
 return names;
}
export function captureManagedLaunches(artifact:string,query:(args:string[])=>string=args=>execFileSync('/usr/bin/systemctl',args,{encoding:'utf8'})):LaunchBootstrap{
 const names=managedLaunchNames(query(unitList),query(jobList));
 const units:ManagedLaunch[]=[];
 for(const unit of names){
  const fields=Object.fromEntries(query(unitDetails(unit)).trim().split('\n').map(line=>line.split('=')));
  if(['inactive','failed'].includes(fields.ActiveState??'')&&(!fields.Job||fields.Job==='0'))continue;
  const path=fields.ControlGroup?join('/sys/fs/cgroup',fields.ControlGroup):'';
  const stat=path&&existsSync(path)?statSync(path):null;
  // A queued job without a cgroup is still an obligation. Its first selection
  // goes through the installed wrapper; an already selected old launcher has
  // its existing unit cgroup before ExecStart is entered.
  units.push({unit,invocationId:fields.InvocationID??'',controlGroup:fields.ControlGroup??'',
   device:stat?.dev??0,inode:stat?.ino??0,bootId:processBootId()});
 }
 return{format:1,artifact,bootId:processBootId(),units,processes:[]};
}
export async function captureManagedLaunchesAsync(artifact:string,query:(args:string[])=>Promise<string>=async args=>(await runFile('/usr/bin/systemctl',args)).stdout):Promise<LaunchBootstrap>{
 const rows=new Map<string,string>();
 const collect=async(args:string[])=>{const value=await query(args);rows.set(JSON.stringify(args),value);return value;};
 const [units,jobs]=await Promise.all([collect(unitList),collect(jobList)]);
 await Promise.all([...managedLaunchNames(units,jobs)].map(unit=>collect(unitDetails(unit))));
 return captureManagedLaunches(artifact,args=>rows.get(JSON.stringify(args))!);
}

/** Only already selected supported Concierge entrypoints are bootstrap roots.
 * Current managed selection redirects their future descendants before SQLite. */
export function selectedLedgerProcesses(sources:{entries?:()=>string[];canonical?:(path:string)=>boolean}={}):SelectedProcess[]{
 const names=new Set<string>([...RELEASE_LEDGER_HELPERS,'deploy','deployment-control-launcher']);
 const processes:SelectedProcess[]=[];
 for(const entry of (sources.entries??(()=>readdirSync('/proc')))()){
  if(!/^\d+$/.test(entry))continue;
  const pid=Number(entry);
  try{
   const environment=Object.fromEntries(readFileSync(`/proc/${pid}/environ`,'utf8').split('\0').filter(Boolean).map(row=>{const i=row.indexOf('=');return[row.slice(0,i),row.slice(i+1)];}));
   const state=environment.CONCIERGE_STATE_DIR;
   if(state&&!(sources.canonical??isLiveLedgerPath)(join(state,'state.db')))continue;
   const argv=readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0');
   const cwd=realpathSync(`/proc/${pid}/cwd`);
   const stable=join(deploymentRuntimeRoot(),'control');
   const script=argv.slice(1).find(arg=>resolve(cwd,arg)===stable
    ||/\.(?:[cm]?[jt]s|sh)$/.test(arg)&&names.has(basename(arg).replace(/\.(?:[cm]?[jt]s|sh)$/,'')));
   if(!script)continue;
   const resolved=resolve(cwd,script);
   const installed=resolved===stable;
   // Bash keeps the selected script's descriptor even after the installed file
   // is atomically replaced. Its kernel identity is stronger than the new path.
   const loaded=installed&&existsSync(`/proc/${pid}/fd/255`)?`/proc/${pid}/fd/255`:resolved;
   const main=loaded===resolved?realpathSync(resolved):readlinkSync(loaded);
   const source=/\/slack-concierge\/(?:\.wt\/[^/]+\/)?bot\/scripts\//.test(main)
    ||main.startsWith(resolve(environment.CONCIERGE_REPO??'/var/lib/slack-concierge-deployment/source')+'/bot/scripts/');
   const sealed=main.startsWith(join(deploymentReleaseRoot(),'releases')+'/')&&/\/[a-f0-9]{64}\/(?:control\/|bot\/scripts\/)/.test(main);
   const pinned=/\/concierge\/helpers\/[a-f0-9]{40}\/bot\/scripts\//.test(main);
   if(!source&&!sealed&&!pinned&&!installed)continue;
   const stat=statSync(loaded);
   processes.push({pid,bootId:processBootId(),startTicks:processStartTicks(pid),main,device:stat.dev,inode:stat.ino});
  }catch(error){if(!['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
 }
 return processes;
}

export async function selectedProcessAlive(identity:SelectedProcess):Promise<boolean>{
 return !await processNativeLifetimeEnded(identity);
}

export function launchBootstrapPath(){return join(launchAuthorityRoot(),'bootstrap.json');}
export function saveLaunchBootstrap(value:LaunchBootstrap){
 prepareLaunchAuthority();
 if(existsSync(launchBootstrapPath()))return;
 publish(launchBootstrapPath(),value);
}

export async function managedLaunchesDrained(value:LaunchBootstrap,query:(args:string[])=>Promise<string>=async args=>(await runFile('/usr/bin/systemctl',args)).stdout):Promise<boolean>{
 if(value.bootId!==processBootId()||value.units.length===0)return true;
 const [unitRows,jobRows]=await Promise.all([query(unitList),query(jobList)]);
 const existing=new Set(unitRows.split('\n').map(row=>row.trim().split(/\s+/)[0]));
 const jobs=new Set(jobRows.split('\n').map(row=>row.trim().split(/\s+/)[1]));
 for(const unit of value.units){
  if(jobs.has(unit.unit))return false;
  if(unit.controlGroup){
   const path=join('/sys/fs/cgroup',unit.controlGroup);
   if(existsSync(path)){
    const stat=statSync(path);
    if(stat.dev===unit.device&&stat.ino===unit.inode&&/\bpopulated 1\b/.test(readFileSync(join(path,'cgroup.events'),'utf8')))return false;
   }
  }else if(existing.has(unit.unit)){
   const fields=Object.fromEntries((await query(unitDetails(unit.unit))).trim().split('\n').map(line=>line.split('=')));
   if(fields.Job&&fields.Job!=='0'||!['inactive','failed'].includes(fields.ActiveState??''))return false;
  }
 }
 return true;
}

export async function retiredLaunchesDrained():Promise<boolean>{
 let bootstrap:LaunchBootstrap;
 try{bootstrap=JSON.parse(await readFileAsync(launchBootstrapPath(),'utf8'));}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
 if(bootstrap.format!==1||!Array.isArray(bootstrap.processes)||!Array.isArray(bootstrap.units))throw Error('Invalid release bootstrap custody.');
 if(!bootstrap.nativeComplete&&!await processNativeLifetimesEnded(bootstrap.processes))return false;
 if(!bootstrap.nativeComplete&&!bootstrap.launchersClosed){
  // Accepted unit intents can be created by an old launcher after its initial
  // capture. Once those launchers have exited, one final managed selection
  // closes that frontier; later factories necessarily use the machine wrappers.
  const late=await captureManagedLaunchesAsync(bootstrap.artifact);
  bootstrap.units=[...bootstrap.units,...late.units];bootstrap.launchersClosed=true;
  await publishAsync(launchBootstrapPath(),bootstrap);
 }
 if(!bootstrap.nativeComplete){
  if(!await managedLaunchesDrained(bootstrap))return false;
  bootstrap.nativeComplete=true;await publishAsync(launchBootstrapPath(),bootstrap);
 }
 for(const name of await readdirAsync(join(launchAuthorityRoot(),'legacy'))){
  if(!/^[a-f0-9]{64}\.lock$/.test(name))continue;
  const release=await acquireLaunchLock(join(launchAuthorityRoot(),'legacy',name),true,true);
  if(!release)return false;await release();
  // The selection exclusion is still held, so no participant can have opened
  // this generation between the empty lifetime proof and retirement.
  for(const path of [name.replace(/\.lock$/,'.json'),name]){
   try{await unlinkAsync(join(launchAuthorityRoot(),'legacy',path));}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
 }
 return true;
}

export async function acquireRecyclingLaunchAuthority():Promise<HeldLaunchLock>{
 const release=(await acquireLaunchLock(deploymentSelectionLock(),true))!;
 try{if(!await retiredLaunchesDrained())throw Error('Prior managed release still owns native cleanup.');return release;}
 catch(error){await release();throw error;}
}

export function launchAuthorityReferences(root=launchAuthorityRoot()):string[]{
 if(!existsSync(root))return[];
 const references:string[]=[];
 if(existsSync(join(root,'bootstrap.json'))){
  const bootstrap=JSON.parse(readFileSync(join(root,'bootstrap.json'),'utf8')) as LaunchBootstrap;
  if(!bootstrap.nativeComplete)references.push(bootstrap.artifact);
 }
 if(existsSync(join(root,'selected.json')))references.push(JSON.parse(readFileSync(join(root,'selected.json'),'utf8')).artifact);
 const directory=join(root,'legacy');
 if(existsSync(directory))for(const name of readdirSync(directory))if(name.endsWith('.json')){
  const record=JSON.parse(readFileSync(join(directory,name),'utf8')) as LegacyLaunchIdentity;
  const lock=spawnSync('/usr/bin/flock',['-n','-x',join(directory,record.generation+'.lock'),'/usr/bin/true']);
  if(lock.status===0)continue;
  if(lock.status!==1)throw Error('Cannot inspect the retained release lifetime for pruning.');
  references.push(record.artifact,record.application.artifact);
 }
 return references;
}

export type ApplicationSelection={artifact:string;pid:number;invocationId:string;state:string;controlPid:number;bootId:string;startTicks:string;artifactDigest?:string;ledgerCommands?:boolean};
export function applicationIncarnation(application:ApplicationSelection){
 const {artifact,pid,invocationId,bootId,startTicks}=application;
 return{artifact,pid,invocationId,bootId,startTicks};
}
export function processStartTicks(pid:number):string {
 const value=readFileSync(`/proc/${pid}/stat`,'utf8');return value.slice(value.lastIndexOf(')')+2).trim().split(/\s+/)[19]!;
}
export function processBootId():string{return readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();}
export function commandCapability(artifact:string):boolean {
 const main=join(artifact,'bot/src/index.js');
 if(!existsSync(main))return false;
 return new Bun.Transpiler({loader:'js'}).scan(readFileSync(main,'utf8')).exports.includes(LEDGER_COMMAND_EXPORT);
}
export function authorityCapability(artifact:string):boolean{
 try{return JSON.parse(readFileSync(join(artifact,'control/deployment-command-authority.json'),'utf8')).format===1;}catch{return false;}
}
export function semanticCommandPath(artifact:string,name:string):string{
 return join(artifact,commandCapability(artifact)?'control/application':'control',name+'.js');
}
export async function verifiedAuthorityArtifact(artifact:string):Promise<string>{
 const {TrustedRootReleaseManager,defaultReleaseEnvironment}=await import('./deployment-release');
 const manager=new TrustedRootReleaseManager(defaultReleaseEnvironment(process.env.CONCIERGE_REPO??'/var/lib/slack-concierge-deployment/source'));
 const path=realpathSync(artifact);manager.verify(path);
 const sealed=(entry:string)=>{const stat=lstatSync(entry);if(stat.mode&0o222)throw Error('Selected release is not sealed.');if(stat.isDirectory())for(const name of readdirSync(entry))sealed(join(entry,name));};
 sealed(path);return path;
}
export async function runningApplication():Promise<ApplicationSelection>{
 const arguments_=['show',process.env.CONCIERGE_SERVICE??'concierge-bot.service','-p','MainPID','-p','ControlPID','-p','ActiveState','-p','InvocationID'];
 const {stdout}=await runFile('/usr/bin/systemctl',arguments_);
 const fields=Object.fromEntries(stdout.trim().split('\n').map(line=>line.split('=')));
 const pid=Number(fields.MainPID??0),controlPid=Number(fields.ControlPID??0);
 const startTicks=pid>1?processStartTicks(pid):'';
 const artifact=await verifiedAuthorityArtifact(pid>1?realpathSync(`/proc/${pid}/cwd`):realpathSync(join(deploymentReleaseRoot(),'current')));
 if(pid>1){
  const args=readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0');
  const main=args[1]==='run'?args[2]:args[1];
  if(!main?.endsWith('/bot/src/index.js'))
   throw Error('The supervised application identity is not the installed owner.');
  const oldPrimaryAlias=!commandCapability(artifact)&&main===join(deploymentReleaseRoot(),'current/bot/src/index.js');
  if(main!==join(artifact,'bot/src/index.js')&&!oldPrimaryAlias)
   throw Error('The supervised application code and working directory disagree.');
 }
 const after=Object.fromEntries((await runFile('/usr/bin/systemctl',arguments_)).stdout.trim().split('\n').map(line=>line.split('=')));
 if(after.MainPID!==fields.MainPID||after.InvocationID!==fields.InvocationID||(pid>1&&processStartTicks(pid)!==startTicks))
  throw Error('The supervised application changed during identity observation.');
 return{artifact,pid,controlPid,state:fields.ActiveState??'',
  invocationId:fields.InvocationID??'',bootId:processBootId(),startTicks,
  artifactDigest:JSON.parse(readFileSync(join(artifact,'manifest.json'),'utf8')).artifact_digest,ledgerCommands:commandCapability(artifact)};
}

/** Hashing the sealed artifact and asking systemd are external controller work,
 * including when the caller is the accepting application's reconciliation loop. */
export async function runningApplicationOffOwner():Promise<ApplicationSelection>{
 const {stdout}=await runFile(join(deploymentRuntimeRoot(),'control'),['inspect-application']);
 const application=JSON.parse(stdout.trim()) as ApplicationSelection;
 if(!application||typeof application.artifact!=='string'||!Number.isSafeInteger(application.pid)
  ||typeof application.invocationId!=='string'||typeof application.bootId!=='string'||typeof application.startTicks!=='string'
  ||!/^[a-f0-9]{64}$/.test(application.artifactDigest??'')||typeof application.ledgerCommands!=='boolean')
  throw Error('The installed release authority returned no application incarnation.');
 return application;
}

export type LegacyLaunchIdentity={format:1;generation:string;artifact:string;application:ApplicationSelection};
export function legacyGeneration(artifact:string,application:ApplicationSelection):string{
 return createHash('sha256').update(JSON.stringify({artifact,application:applicationIncarnation(application)})).digest('hex');
}
export async function holdLegacyLaunch(artifact:string,application:ApplicationSelection):Promise<{identity:LegacyLaunchIdentity;release:HeldLaunchLock}>{
 const generation=legacyGeneration(artifact,application);
 const identity:LegacyLaunchIdentity={format:1,generation,artifact,application};
 prepareLaunchAuthority();
 const path=join(launchAuthorityRoot(),'legacy',generation+'.json');
 if(!existsSync(path))publish(path,identity);
 const release=(await acquireLaunchLock(join(launchAuthorityRoot(),'legacy',generation+'.lock'),false))!;
 return{identity,release};
}
/** This is an inherited kernel file description, not a boolean environment permission.
 * Its outer selected launcher retains the lock until its child has completed native exit. */
export function attestedLegacyLaunch():boolean{
 try{
  const descriptor=Number(process.env.CONCIERGE_RELEASE_LIFETIME_FD);
  const generation=process.env.CONCIERGE_RELEASE_LIFETIME_GENERATION??'';
  if(!Number.isSafeInteger(descriptor)||descriptor<3||!/^[a-f0-9]{64}$/.test(generation))return false;
  const path=join(launchAuthorityRoot(),'legacy',generation+'.lock');
  const held=fstatSync(descriptor),expected=statSync(path);
  if(held.dev!==expected.dev||held.ino!==expected.ino||expected.mode&0o022)return false;
  const info=readFileSync(`/proc/self/fdinfo/${descriptor}`,'utf8');
  if(!/lock:.*FLOCK\s+ADVISORY\s+READ\b/.test(info))return false;
  const record=JSON.parse(readFileSync(join(launchAuthorityRoot(),'legacy',generation+'.json'),'utf8')) as LegacyLaunchIdentity;
  return record.format===1&&record.generation===generation&&legacyGeneration(record.artifact,record.application)===generation;
 }catch{return false;}
}

export const RELEASE_LEDGER_HELPERS=['deployment-repair','deploy-state','recover-deployment','session-turn-queue','clear-stale-account-notices','repair-inbox-needs','drain-status','release-manager'] as const;
const helpers=new Set<string>(RELEASE_LEDGER_HELPERS);
let preinstallLegacy:{pid:number;startTicks:string;main:string;application:ApplicationSelection}|null=null;
export function preinstallLegacyLaunch():boolean{return preinstallLegacy?.pid===process.pid;}
/** The same supported source command is retained: a live legacy operation re-enters the
 * installed machine wrapper before loading writable state. An unavailable POST never grants it. */
async function enterCurrentLaunchAuthority(anchor:{artifact:string;engine:string;engineDigest:string}):Promise<never>{
 const main=realpathSync(Bun.main),name=main.split('/').at(-1)!.replace(/\.[cm]?[jt]s$/,'');
 if(!helpers.has(name))throw Error('Live legacy mutation requires the selected release command authority.');
 const selected=await verifiedAuthorityArtifact(anchor.artifact);
 if(!commandCapability(selected)&&!authorityCapability(selected))throw Error('The anchored release cannot select compatible commands.');
 if(!/^[a-f0-9]{64}$/.test(anchor.engineDigest)||anchor.engine!==join(deploymentRuntimeRoot(),'engines',anchor.engineDigest,'bun'))throw Error('The anchored engine identity is invalid.');
 const engine=anchor.engine;
 if(!existsSync(engine))throw Error('The anchored release engine is unavailable; no ledger was opened.');
 const child=spawn(engine,[semanticCommandPath(selected,'deployment-launch-authority'),'bun',main,...process.argv.slice(2)],{env:process.env,stdio:'inherit'});
 const code=await new Promise<number>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code??1));});
 process.exit(code);
}

/** Serving clients decide before any writable module import. FULL compatibility is
 * attested by existing release launch authority; socket errors are never a fallback signal. */
export async function deploymentLedgerMode():Promise<'owner'|'legacy'>{
 const directory=process.env.CONCIERGE_STATE_DIR;
 if(!directory||!isLiveLedgerPath(join(directory,'state.db'))||process.platform!=='linux')return'legacy';
 if(attestedLegacyLaunch()||preinstallLegacyLaunch())return'legacy';
 const application=await runningApplication();
 if(application.pid>1&&commandCapability(application.artifact))return'owner';
 let anchor:{format:number;artifact:string;engine:string;engineDigest:string}|null=null;
 try{anchor=JSON.parse(readFileSync(join(launchAuthorityRoot(),'selected.json'),'utf8'));}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(anchor){
  if(anchor.format!==1||typeof anchor.artifact!=='string')throw Error('The installed release authority identity is invalid.');
  return enterCurrentLaunchAuthority(anchor);
 }
 if(application.pid<=1||commandCapability(application.artifact))throw Error('Preinstallation compatibility requires the verified running legacy application.');
 const main=realpathSync(Bun.main),name=basename(main).replace(/\.[cm]?[jt]s$/,'');
 if(!helpers.has(name))throw Error('The current operation is not a supported ledger command.');
 // Publication precedes finite bootstrap capture. A caller that selected this
 // legacy mode is already this exact live main/process before publication and
 // keeps its original mode until its native lifetime ends.
 preinstallLegacy={pid:process.pid,startTicks:processStartTicks(process.pid),main,application};
 return'legacy';
}

export async function launchReleaseCommand(mode:string,args:string[],observeApplication:()=>Promise<ApplicationSelection>=runningApplication):Promise<number>{
const engine=process.execPath;
const helperNames=helpers;
 let releaseSelection:HeldLaunchLock|undefined,releaseLifetime:HeldLaunchLock|undefined;
try{
 releaseSelection=(await acquireLaunchLock(deploymentSelectionLock(),false))!;
 const control=await verifiedAuthorityArtifact(join(deploymentReleaseRoot(),'control'));
 const selectedAuthority=await verifiedAuthorityArtifact(JSON.parse(readFileSync(join(deploymentReleaseRoot(),'launch-authority/selected.json'),'utf8')).artifact);
 if(mode==='control'&&args.length===1&&args[0]==='inspect-application'){
  process.stdout.write(JSON.stringify(await observeApplication()));return 0;
 }
 let cmd:string[],env={...process.env,CONCIERGE_BUN_BIN:join(deploymentRuntimeRoot(),'bun')};
 let lifetime:Awaited<ReturnType<typeof holdLegacyLaunch>>|undefined;
 if(mode==='bun'){
  const original=args[0]==='run'?args[1]:args[0];
  const name=basename(original??'').replace(/\.[cm]?[jt]s$/,'');
  const rest=args.slice(args[0]==='run'?2:1);
  if(name==='release-manager'&&['install-runtime','install-launchers'].includes(rest[0]??'')){
   cmd=[engine,semanticCommandPath(selectedAuthority,'release-manager'),...rest];
  }else if(original&&helperNames.has(name)&&(name!=='drain-status'||['claim','recover','release','holds'].includes(rest[0]??''))){
   const application=await observeApplication();
   const semanticArtifact=commandCapability(application.artifact)?application.artifact:authorityCapability(control)?control:selectedAuthority;
   if(!commandCapability(semanticArtifact)&&!authorityCapability(semanticArtifact))throw Error('No verified release provides compatible ledger commands.');
   const script=semanticCommandPath(semanticArtifact,name);
   if(!existsSync(script))throw Error('The selected semantic ledger command is absent.');
   if(application.pid===0||!commandCapability(application.artifact))lifetime=await holdLegacyLaunch(control,application);
   cmd=[engine,script,...rest];
  }else cmd=[engine,...args];
 }else if(mode==='control'){
  // An old shell remains usable, while every canonical helper it starts enters
  // this same runtime dispatcher before loading its ledger modules.
  const application=await observeApplication();
  if(!authorityCapability(control))lifetime=await holdLegacyLaunch(control,application);
  env.CONCIERGE_DEPLOYMENT_CONTROL_ROOT=join(control,'control');
  cmd=['/usr/bin/bash',join(control,'control/deployment-control-launcher.sh'),...args];
 }else throw Error('Unknown release launch mode.');
 delete env.CONCIERGE_RELEASE_LIFETIME_FD;
 delete env.CONCIERGE_RELEASE_LIFETIME_GENERATION;
 if(lifetime){
  releaseLifetime=lifetime.release;
  env.CONCIERGE_RELEASE_LIFETIME_FD='3';
  env.CONCIERGE_RELEASE_LIFETIME_GENERATION=lifetime.identity.generation;
 }
 const child=spawn(cmd[0]!,cmd.slice(1),{env,stdio:lifetime?['inherit','inherit','inherit',lifetime.release.descriptor]:'inherit'});
 const closed=new Promise<number>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve(code??(signal?1:0)));});
 // Child selection is enclosed by the short lock; ancestor lifetime is a
 // different open description, and never delays promotion of its own child.
 await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
 await releaseSelection();releaseSelection=undefined;
 const forward=(signal:NodeJS.Signals)=>child.kill(signal);
 const term=()=>forward('SIGTERM'),interrupt=()=>forward('SIGINT');
 process.on('SIGTERM',term);process.on('SIGINT',interrupt);
 const code=await closed;
 process.off('SIGTERM',term);process.off('SIGINT',interrupt);
 await releaseLifetime?.();releaseLifetime=undefined;
 return code;
}
finally{await releaseSelection?.();await releaseLifetime?.();}
}
