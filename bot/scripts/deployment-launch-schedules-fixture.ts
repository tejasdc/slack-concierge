import assert from 'node:assert/strict';
import {Database} from 'bun:sqlite';
import {spawn as spawnNode} from 'node:child_process';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {runFixtureChild} from './fixture-child';

if(process.platform!=='linux'){console.log(JSON.stringify({fixture:'deployment-launch-schedules',status:'not-applicable',platform:process.platform}));process.exit(0);}
if(!process.argv.includes('--isolated')) {
 const isolation=fs.mkdtempSync('/tmp/wal79-launch-isolation-'),deny=join(isolation,'systemctl-deny');
 fs.writeFileSync(deny,'#!/bin/sh\nprintf "%s\\n" "$*" >> "$SYSTEMCTL_DENY_LOG"\nexit 97\n',{mode:0o755});
 const {privateDatabaseCommand}=await import('../src/private-database-command');
 const token=join(isolation,'dummy-token');fs.writeFileSync(token,'owned-fixture-token');
 const tokenPaths=['/etc/agent-inbox.token','/etc/concierge/pebble-index.token','/etc/concierge/thinkering.token','/etc/concierge/capture-queue.token'];
 const command=privateDatabaseCommand(['/usr/bin/bwrap','--die-with-parent','--bind','/','/','--dev','/dev','--tmpfs','/etc','--dir','/etc/concierge','--dir','/etc/alternatives',...tokenPaths.flatMap(path=>['--ro-bind',token,path]),'--ro-bind',fs.realpathSync('/usr/bin/awk'),'/etc/alternatives/awk','--ro-bind',deny,'/usr/bin/systemctl','--',process.execPath,import.meta.path,'--isolated'],true);
 let code=1;try{
 const receipt=await runFixtureChild({command:command[0]!,args:command.slice(1),env:{...process.env,SYSTEMCTL_DENY_LOG:join(isolation,'denied.calls'),SHIM_QUERY_LOG:join(isolation,'shim.calls'),CONCIERGE_SERVICE:'concierge-fixture-only.service'},deadlineMs:45000,fixture:'deployment-launch-schedules',onOutput:(stream,chunk)=>process[stream].write(chunk)});
 console.error(JSON.stringify({childOutcome:receipt.childOutcome}));code=0;
 }finally{console.error(JSON.stringify({isolation,exit:code,unexpectedSystemctlDenied:fs.existsSync(join(isolation,'denied.calls'))}));}
 process.exit(code);
}

const root=fs.mkdtempSync('/tmp/wal79-launch-schedules-');
const releaseRoot=join(root,'release'),runtime=join(root,'runtime'),serviceFile=join(root,'service.json');
fs.mkdirSync(join(releaseRoot,'releases'),{recursive:true});fs.mkdirSync(runtime);fs.mkdirSync(join(root,'state'));
Object.assign(process.env,{CONCIERGE_DEPLOYMENT_RELEASE_ROOT:releaseRoot,
 CONCIERGE_DEPLOYMENT_RUNTIME_DIR:runtime,CONCIERGE_STATE_DIR:join(root,'state'),FIXTURE_SERVICE_FILE:serviceFile,
 FIXTURE_RESULT:join(root,'result.json'),FIXTURE_READY:join(root,'ready.json'),CONCIERGE_CAPTURE_RUNTIME_DIR:join(root,'capture-runtime')});
const publish=(path:string,value:unknown)=>{fs.writeFileSync(path+'.tmp',JSON.stringify(value));fs.renameSync(path+'.tmp',path);};
publish(serviceFile,{pid:0,state:'inactive',invocation:'initial',units:'',jobs:'',details:{},owned:[]});
const observed=()=>JSON.parse(fs.readFileSync(serviceFile,'utf8'));
const update=(value:Record<string,unknown>)=>publish(serviceFile,{...observed(),...value});
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const results:unknown[]=[],failures:unknown[]=[];
const children:Array<ReturnType<typeof Bun.spawn>>=[];
const wait=async(test:()=>boolean,label:string)=>{const deadline=Date.now()+8000;while(!test()){assert.ok(Date.now()<deadline,label);await Bun.sleep(2);}};
const deadline=setTimeout(()=>{for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');console.error('fixture deadline');process.exit(2);},45000);

// Only systemd observations and host-wide process/unit enumeration are controlled.
// Executable, argv, cwd, seals, flock descriptors and native child exits remain real.
const childShim=join(root,'child-shim.ts'),fsShim=join(root,'fs-shim.ts');
const policyShim=join(root,'canonical-policy-shim.ts');
fs.writeFileSync(policyShim,`import{join}from'node:path';export function isLiveLedgerPath(path:string){return process.env.FIXTURE_CANONICAL_MODE==='1'&&path===join(process.env.CONCIERGE_STATE_DIR!,'state.db');}`);
fs.writeFileSync(childShim,`import * as cp from 'node:child_process';import{readFileSync}from'node:fs';import{promisify}from'node:util';export const {spawn,spawnSync,fork,exec,execSync,ChildProcess}=cp;
function query(args:string[]){const s=JSON.parse(readFileSync(process.env.FIXTURE_SERVICE_FILE!,'utf8'));require('node:fs').appendFileSync(process.env.SHIM_QUERY_LOG,JSON.stringify({pid:process.pid,args,at:Date.now()})+String.fromCharCode(10));if(args[0]==='list-units')return s.units;if(args[0]==='list-jobs')return s.jobs;
if(args.includes('MainPID'))return ['MainPID='+s.pid,'ControlPID=0','ActiveState='+s.state,'InvocationID='+s.invocation].join(String.fromCharCode(10));
if(args[0]!=='show')throw Error('Unsupported controlled systemctl query');return s.details[args[1]]??['InvocationID=none','ControlGroup=','ActiveState=inactive','Job=0'].join(String.fromCharCode(10));}
export const execFileSync=(file:string,args:string[],options?:any)=>file==='/usr/bin/systemctl'?query(args):cp.execFileSync(file,args,options);
export const execFile:any=(...args:any[])=>{if(args[0]==='/usr/bin/systemctl'){const cb=args.at(-1);queueMicrotask(()=>cb(null,query(args[1]),''));return {};}return (cp.execFile as any)(...args);};
execFile[promisify.custom]=async(file:string,args:string[])=>file==='/usr/bin/systemctl'?{stdout:query(args),stderr:''}:promisify(cp.execFile)(file,args);
`);
const fsExports=Object.keys(fs).filter(name=>/^[A-Za-z_$][\w$]*$/.test(name)&&!['default','readdirSync'].includes(name)).map(name=>`export const ${name}=fs.${name};`).join('\n');
fs.writeFileSync(fsShim,`import * as fs from 'node:fs';${fsExports}export function readdirSync(path:any,options?:any):any{if(path==='/proc')return JSON.parse(fs.readFileSync(process.env.FIXTURE_SERVICE_FILE!,'utf8')).owned.map(String);if(['/run/systemd/transient','/run/systemd/system','/etc/systemd/system'].includes(String(path)))return [];return fs.readdirSync(path,options);}`);
const plugin={name:'controlled-service-observation',setup(build:any){
 build.onLoad({filter:/\.ts$/},(args:any)=>{if([childShim,fsShim,policyShim].includes(args.path))return;let contents=fs.readFileSync(args.path,'utf8');contents=contents.replace(/from\s*(["'])(?:node:)?child_process\1/g,'from '+JSON.stringify(childShim)).replace(/from\s*(["'])(?:node:)?fs\1/g,'from '+JSON.stringify(fsShim));if(args.path.endsWith('/deployment-launch-authority.ts'))contents=contents.replace("from './ledger-access-policy'",'from '+JSON.stringify(policyShim));return {contents,loader:'ts'};});
}};
const driverEntry=join(root,'driver.ts');fs.writeFileSync(driverEntry,`export * from ${JSON.stringify(resolve(import.meta.dir,'../src/deployment-launch-authority.ts'))};export{TrustedRootReleaseManager,releaseFileSetDigest}from ${JSON.stringify(resolve(import.meta.dir,'../src/deployment-release.ts'))};`);
const built=await Bun.build({entrypoints:[driverEntry,join(import.meta.dir,'deployment-launch-authority.ts')],target:'bun',naming:'[name].[ext]',outdir:join(root,'compiled'),plugins:[plugin]});
assert.equal(built.success,true,String(built.logs));
for(const output of built.outputs){const bytes=await output.text();assert.ok(bytes.includes('FIXTURE_SERVICE_FILE')&&bytes.includes('Unsupported controlled systemctl query'),'service observation shim must be compiled before native launch');}
const driver=await import(join(root,'compiled/driver.js'));
const cli=fs.readFileSync(join(root,'compiled/deployment-launch-authority.js'),'utf8');
const application=`import{writeFileSync,readFileSync}from'node:fs';writeFileSync(process.env.FIXTURE_READY,JSON.stringify({pid:process.pid,cwd:process.cwd(),argv:process.argv,main:import.meta.path,BunMain:Bun.main,metaDir:import.meta.dir,kernelCmdline:readFileSync('/proc/self/cmdline','utf8').split(String.fromCharCode(0)),startupManifest:process.env.CONCIERGE_RELEASE_MANIFEST?JSON.parse(readFileSync(process.env.CONCIERGE_RELEASE_MANIFEST,'utf8')).artifact_digest:null}));setInterval(()=>{},1000);`;
const probe=`import{attestedLegacyLaunch}from ${JSON.stringify(join(root,'compiled/driver.js'))};import{writeFileSync}from'node:fs';writeFileSync(process.env.FIXTURE_RESULT,JSON.stringify({attested:attestedLegacyLaunch(),fd:process.env.CONCIERGE_RELEASE_LIFETIME_FD??null,generation:process.env.CONCIERGE_RELEASE_LIFETIME_GENERATION??null,main:import.meta.path,args:process.argv.slice(2)}));`;
function seal(path:string){for(const file of fs.readdirSync(path)){const p=join(path,file);if(fs.statSync(p).isDirectory())seal(p);else fs.chmodSync(p,0o444);}fs.chmodSync(path,0o555);}
function artifact(name:string,capable:boolean,authority:boolean,extra:Record<string,string>={}) {
 const stage=join(releaseRoot,'releases','.'+name);fs.mkdirSync(stage);
 const files:Record<string,string>={'bot/src/index.js':application,'control/deploy.sh':'echo owned-deploy',
  'control/deployment-repair.js':probe,'control/session-turn-queue.js':'throw Error("old helper must be rebound");','control/release-manager.js':'console.log("owned-manager")',
  'control/deployment-launcher.sh':fs.readFileSync(join(import.meta.dir,'deployment-launcher.sh'),'utf8'),
  'control/deployment-control-launcher.sh':fs.readFileSync(join(import.meta.dir,'deployment-control-launcher.sh'),'utf8')};
 if(capable){files['control/deployment-ledger-commands.json']='{"format":1}';files['bot/src/index.js']+='\nexport const conciergeLedgerCommandsV1=true;';}
 if(authority)files['control/deployment-command-authority.json']='{"format":1}';
 const prefix=capable?'control/application':'control';
 if(capable||authority){files[prefix+'/deployment-launch-authority.js']=cli;files[prefix+'/session-turn-queue.js']=probe;files[prefix+'/release-manager.js']=probe;}
 Object.assign(files,extra);
 for(const [file,bytes]of Object.entries(files)){fs.mkdirSync(dirname(join(stage,file)),{recursive:true});fs.writeFileSync(join(stage,file),bytes);}
 const unsigned={format:2,git_commit:'a'.repeat(40),control_git_commit:'b'.repeat(40),source_tree_digest:sha(name),control_source_tree_digest:sha(name),runtime_digest:driver.releaseFileSetDigest(stage,Object.keys(files)),compatibility_digest:sha('compatible'),files:Object.fromEntries(Object.entries(files).map(([file,bytes])=>[file,sha(bytes)]))};
 const digest=sha(JSON.stringify(unsigned));fs.writeFileSync(join(stage,'manifest.json'),JSON.stringify({...unsigned,artifact_digest:digest}));seal(stage);const path=join(releaseRoot,'releases',digest);fs.renameSync(stage,path);return path;
}
const pointer=(name:string,path:string)=>{const next=join(releaseRoot,'.'+name+'-'+crypto.randomUUID());fs.symlinkSync(path,next);fs.renameSync(next,join(releaseRoot,name));};
async function launch(command:string[],cwd?:string){const child=Bun.spawn(command,{cwd,env:process.env,stdout:'pipe',stderr:'pipe'});children.push(child);update({owned:[...observed().owned,child.pid]});return child;}
async function startApplication(command:string[],cwd?:string){fs.rmSync(process.env.FIXTURE_READY!,{force:true});const child=await launch(command,cwd);await wait(()=>fs.existsSync(process.env.FIXTURE_READY!), 'application ready');const info=JSON.parse(fs.readFileSync(process.env.FIXTURE_READY!,'utf8'));update({pid:child.pid,state:'active',invocation:'app-'+child.pid});return {child,info};}
async function stop(child:ReturnType<typeof Bun.spawn>){if(child.exitCode===null)child.kill('SIGTERM');await child.exited;}
try {
 const supervisorProgram=`import{Database}from'bun:sqlite';import{writeFileSync,existsSync}from'node:fs';const db=new Database(process.env.FIXTURE_NATIVE_DB);db.exec('PRAGMA journal_mode=WAL;CREATE TABLE original_work(id TEXT,phase TEXT,PRIMARY KEY(id,phase))');const row=db.query('INSERT INTO original_work VALUES(?,?)');row.run(process.env.FIXTURE_ORIGINAL_ID,'before-child');writeFileSync(process.env.FIXTURE_SUPERVISOR+'.started',String(process.pid));while(!existsSync(process.env.FIXTURE_SUPERVISOR+'.run-child'))await Bun.sleep(2);const child=Bun.spawnSync([process.env.CONCIERGE_DEPLOYMENT_RUNTIME_DIR+'/control','deploy'],{stdout:'pipe',stderr:'pipe',env:process.env});if(child.exitCode!==0){console.error(Buffer.from(child.stderr).toString());process.exit(4);}row.run(process.env.FIXTURE_ORIGINAL_ID,'after-child');writeFileSync(process.env.FIXTURE_SUPERVISOR+'.after-child','0');while(!existsSync(process.env.FIXTURE_SUPERVISOR+'.exit'))await Bun.sleep(2);process.exit(0);`;
 const hybridDeploy=`#!/bin/sh\nset -eu\n"$CONCIERGE_DEPLOYMENT_RUNTIME_DIR/bun" "$CONCIERGE_DEPLOYMENT_CONTROL_ROOT/session-turn-queue.js" resume --turn-id 7\n`;
 const selectedProgram=`import{Database}from'bun:sqlite';import{writeFileSync,existsSync}from'node:fs';const db=new Database(process.env.FIXTURE_PRESELECT_BASE+'.db');db.exec('PRAGMA journal_mode=WAL;CREATE TABLE original(id TEXT PRIMARY KEY)');db.query('INSERT INTO original VALUES(?)').run('original-preselected-79');writeFileSync(process.env.FIXTURE_PRESELECT_BASE+'.native',String(process.pid));while(!existsSync(process.env.FIXTURE_PRESELECT_BASE+'.native-exit'))await Bun.sleep(2);process.exit(0);`;
 const selectedDeploy=`#!/bin/sh\nexec '${process.execPath}' "$CONCIERGE_DEPLOYMENT_CONTROL_ROOT/preselected-native.js"\n`;
 const preinstallProgram=`import{Database}from'bun:sqlite';import{writeFileSync,existsSync}from'node:fs';import{deploymentLedgerMode,preinstallLegacyLaunch}from ${JSON.stringify(join(root,'compiled/driver.js'))};const base=process.env.FIXTURE_PREINSTALL;const mode=await deploymentLedgerMode();writeFileSync(base+'.mode',JSON.stringify({pid:process.pid,mode,preinstall:preinstallLegacyLaunch(),databaseExists:existsSync(base+'.db')}));while(!existsSync(base+'.open'))await Bun.sleep(2);const db=new Database(base+'.db');db.exec('PRAGMA journal_mode=WAL;CREATE TABLE original(id TEXT PRIMARY KEY)');db.query('INSERT INTO original VALUES(?)').run('original-preinstall-79');writeFileSync(base+'.native',JSON.stringify({pid:process.pid,preinstall:preinstallLegacyLaunch()}));while(!existsSync(base+'.exit'))await Bun.sleep(2);process.exit(0);`;
 const old=artifact('old',false,false,{'control/deployment-repair.js':supervisorProgram,'control/preselected-native.js':selectedProgram,'control/deploy.sh':selectedDeploy,'control/deploy-state.js':preinstallProgram}),modern=artifact('modern',true,true),hybrid=artifact('hybrid',false,true,{'control/deploy.sh':hybridDeploy});
 pointer('current',old);pointer('control',hybrid);
 const manager=new driver.TrustedRootReleaseManager({repositoryRoot:root,releaseRoot,installRoot:runtime,bunExecutable:process.execPath});
 manager.installRuntime();
 const normal=await startApplication([join(runtime,'launch')]);
 const raw=fs.readFileSync(`/proc/${normal.child.pid}/cmdline`,'utf8').split(String.fromCharCode(0));console.error(JSON.stringify({case:'canonical-primary-kernel-argv',raw,expected:join(old,'bot/src/index.js')}));
 let loaded:any;try{loaded=await driver.runningApplication();assert.equal(loaded.artifact,old);assert.equal(loaded.pid,normal.child.pid);}catch(error){failures.push({case:'installed-primary-wrapper',error:String(error),raw});console.error(JSON.stringify({failure:failures.at(-1)}));}
 pointer('current',modern);if(loaded)assert.equal((await driver.runningApplication()).artifact,old,'pointer promotion does not replace loaded app');
 const inspection=await launch([join(runtime,'control'),'inspect-application']);
 const [inspectionBytes,inspectionError,inspectionCode]=await Promise.all([new Response(inspection.stdout).text(),new Response(inspection.stderr).text(),inspection.exited]);assert.equal(inspectionCode,0,inspectionError);const inspected=JSON.parse(inspectionBytes);assert.equal(inspected.artifact,old);assert.equal(inspected.pid,normal.child.pid);assert.equal(inspected.ledgerCommands,false);assert.equal(inspected.artifactDigest,old.split('/').at(-1));
 results.push({case:'actual-installed-application-inspection-after-pointer-change',inspected});
 results.push({case:'installed-primary-wrapper',canonicalIdentity:!!loaded,pointerChangePreservesLoadedIdentity:!!loaded,pid:normal.child.pid,argv:normal.info.argv});
 // Future source, sealed and pinned inputs all enter the actual installed runtime wrapper.
 const originals=[join(root,'source/bot/scripts/session-turn-queue.ts'),join(old,'control/session-turn-queue.js'),join(root,'state/helpers','c'.repeat(40),'bot/scripts/session-turn-queue.js')];
 for(const original of originals){if(!fs.existsSync(original)){const sealed=original.startsWith(old);if(!sealed){fs.mkdirSync(dirname(original),{recursive:true});fs.writeFileSync(original,'throw Error("Original helper must be rebound before execution");');}}fs.rmSync(process.env.FIXTURE_RESULT!,{force:true});const child=await launch([join(runtime,'bun'),'run',original,'resume','--turn-id','7']);assert.equal(await child.exited,0,await new Response(child.stderr).text());const result=JSON.parse(fs.readFileSync(process.env.FIXTURE_RESULT!,'utf8'));assert.equal(result.main,driver.semanticCommandPath(hybrid,'session-turn-queue'));assert.equal(result.attested,true);assert.deepEqual(result.args,['resume','--turn-id','7']);results.push({case:'managed-original-rebinding',original,result});}
 // A real old Bun supervisor blocks synchronously on its child, then still owns SQLite.
 process.env.FIXTURE_NATIVE_DB=join(root,'original-native.db');process.env.FIXTURE_ORIGINAL_ID='original-launch-79';process.env.FIXTURE_SUPERVISOR=join(root,'supervisor');
 const supervisor=await launch([join(runtime,'bun-engine'),join(old,'control/deployment-repair.js')]);
 await wait(()=>fs.existsSync(process.env.FIXTURE_SUPERVISOR+'.started'),'old native supervisor ready');
 const selected=driver.selectedLedgerProcesses({entries:()=>[String(supervisor.pid)],canonical:()=>true});assert.equal(selected.length,1);assert.equal(selected[0].pid,supervisor.pid);
 const bootstrap=driver.captureManagedLaunches(hybrid,(args:string[])=>args[0]==='list-units'?'':args[0]==='list-jobs'?'':'');driver.saveLaunchBootstrap({...bootstrap,processes:selected});
 fs.writeFileSync(process.env.FIXTURE_SUPERVISOR+'.run-child','1');await wait(()=>fs.existsSync(process.env.FIXTURE_SUPERVISOR+'.after-child'),'child completes without ancestor deadlock');
 assert.equal(supervisor.exitCode,null);assert.equal(await driver.retiredLaunchesDrained(),false,'child completion does not retire native supervisor');
 const selection=await driver.acquireLaunchLock(driver.deploymentSelectionLock(),true,true);assert.ok(selection,'child released selection before waiting ancestor');selection();
 update({jobs:'41 concierge-deploy-late.service start waiting',details:{'concierge-deploy-late.service':'InvocationID=late\nControlGroup=\nActiveState=activating\nJob=41'}});
 fs.writeFileSync(process.env.FIXTURE_SUPERVISOR+'.exit','1');assert.equal(await supervisor.exited,0);
 assert.equal(await driver.retiredLaunchesDrained(),false,'late accepted unit intent remains before launch');
 update({jobs:'',details:{'concierge-deploy-late.service':'InvocationID=late\nControlGroup=\nActiveState=inactive\nJob=0'}});
 assert.equal(await driver.retiredLaunchesDrained(),true);const grant=await driver.acquireRecyclingLaunchAuthority();grant();
 const read=new Database(process.env.FIXTURE_NATIVE_DB,{readonly:true});const rows=read.query('SELECT * FROM original_work ORDER BY rowid').all();read.close();assert.deepEqual(rows,[{id:'original-launch-79',phase:'before-child'},{id:'original-launch-79',phase:'after-child'}]);
 results.push({case:'old-supervisor-after-child-and-late-accepted-unit',supervisor:supervisor.pid,nativeExitConfirmed:true,rows,noSelfDeadlock:true,lateIntentHeld:true});
 // A retained lifetime anchor is preserved by the actual pruning implementation.
 const retained=artifact('retained-lifetime',false,true),unused=artifact('unused',false,true);
 const held=await driver.holdLegacyLaunch(retained,loaded);const pruned=manager.pruneReleases([],0);assert.ok(!pruned.removed.includes(retained.split('/').at(-1)));assert.ok(pruned.removed.includes(unused.split('/').at(-1)));await held.release();const after=manager.pruneReleases([],0);assert.ok(after.removed.includes(retained.split('/').at(-1)));results.push({case:'prune-retains-active-lifetime-anchor',retainedWhileHeld:true,retiredAfterRelease:true});
 await stop(normal.child);
 const modernApp=await startApplication([join(runtime,'launch')]);assert.equal((await driver.runningApplication()).artifact,modern);
 const stale=await driver.holdLegacyLaunch(hybrid,loaded);
 process.env.CONCIERGE_RELEASE_LIFETIME_FD='3';process.env.CONCIERGE_RELEASE_LIFETIME_GENERATION=stale.identity.generation;
 const next=spawnNode(join(runtime,'bun'),[join(old,'control/session-turn-queue.js'),'resume','--turn-id','7'],
  {env:process.env,stdio:['ignore','pipe','pipe',stale.release.descriptor]});
 const newCode=await new Promise<number|null>((resolve,reject)=>{next.once('error',reject);next.once('close',code=>resolve(code));next.stdout?.resume();next.stderr?.resume();});
 delete process.env.CONCIERGE_RELEASE_LIFETIME_FD;delete process.env.CONCIERGE_RELEASE_LIFETIME_GENERATION;await stale.release();assert.equal(newCode,0);
 const modernResult=JSON.parse(fs.readFileSync(process.env.FIXTURE_RESULT!,'utf8'));
 assert.equal(modernResult.main,driver.semanticCommandPath(modern,'session-turn-queue'));assert.equal(modernResult.attested,false);assert.equal(modernResult.fd,null);
 results.push({case:'new-generation-rejects-inherited-old-authority',modernResult});await stop(modernApp.child);

 // Boot the unchanged old primary before publishing the new runtime wrapper.
 const aliasRoot=join(root,'legacy-boot'),aliasRuntime=join(root,'legacy-runtime');
 fs.mkdirSync(join(aliasRoot,'releases'),{recursive:true});fs.mkdirSync(aliasRuntime);
 const copies=new Map<string,string>();
 for(const artifact of [old,modern,hybrid]){const dest=join(aliasRoot,'releases',artifact.split('/').at(-1)!);fs.cpSync(artifact,dest,{recursive:true,preserveTimestamps:true});copies.set(artifact,dest);}
 fs.symlinkSync(copies.get(old)!,join(aliasRoot,'current'));fs.symlinkSync(copies.get(old)!,join(aliasRoot,'control'));
 process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT=aliasRoot;process.env.CONCIERGE_DEPLOYMENT_RUNTIME_DIR=aliasRuntime;
 const aliasManager=new driver.TrustedRootReleaseManager({repositoryRoot:root,releaseRoot:aliasRoot,installRoot:aliasRuntime,bunExecutable:process.execPath});aliasManager.installRuntime();
 const alias=await startApplication([join(aliasRuntime,'launch')],copies.get(old));assert.equal(alias.child.pid,alias.info.pid);
 const aliasKernel=fs.readFileSync(`/proc/${alias.child.pid}/cmdline`,'utf8').split(String.fromCharCode(0));
 assert.ok(aliasKernel.includes(join(aliasRoot,'current/bot/src/index.js')));
 assert.equal(alias.info.BunMain,join(copies.get(old)!,'bot/src/index.js'));assert.equal(alias.info.metaDir,join(copies.get(old)!,'bot/src'));
 const preinstallBase=join(root,'preinstall');process.env.FIXTURE_PREINSTALL=preinstallBase;process.env.FIXTURE_CANONICAL_MODE='1';
 const preinstallHelper=await launch([join(aliasRuntime,'bun'),join(copies.get(old)!,'control/deploy-state.js')]);delete process.env.FIXTURE_CANONICAL_MODE;
 await wait(()=>fs.existsSync(preinstallBase+'.mode'),'actual preinstallation mode decision before SQLite open');
 const preinstallMode=JSON.parse(fs.readFileSync(preinstallBase+'.mode','utf8'));assert.deepEqual(preinstallMode,{pid:preinstallHelper.pid,mode:'legacy',preinstall:true,databaseExists:false});assert.equal(fs.existsSync(join(aliasRoot,'launch-authority/selected.json')),false);
 // Both participants originate at the actual installed, extensionless old control.
 // DEBUG pauses before its exec without changing the selected script's native FD.
 const early=join(root,'early'),selectedBase=join(root,'preselected'),fakeBin=join(root,'bin');fs.mkdirSync(fakeBin);
 const bashEnv=join(root,'bash-env');fs.writeFileSync(bashEnv,`fixture_pause(){ if [[ "$0" == "$FIXTURE_STABLE_CONTROL" && "$1" == exec* ]]; then trap - DEBUG; printf '%s' "$$" > "$FIXTURE_EARLY.started"; while [[ ! -e "$FIXTURE_EARLY.release" ]]; do sleep .01; done; fi; }; trap 'fixture_pause "$BASH_COMMAND"' DEBUG\n`);
 process.env.FIXTURE_STABLE_CONTROL=join(aliasRuntime,'control');process.env.FIXTURE_EARLY=early;process.env.BASH_ENV=bashEnv;
 const beforeWrapper=fs.statSync(join(aliasRuntime,'control'));
 const earlyControl=await launch(['/usr/bin/bash',join(aliasRuntime,'control'),'deploy']);delete process.env.BASH_ENV;
 await wait(()=>fs.existsSync(early+'.started'),'actual stable control selected before exec');
 fs.writeFileSync(join(fakeBin,'readlink'),`#!/bin/sh\nv=$(/usr/bin/readlink "$@") || exit $?\nif [ "$*" = "-f $FIXTURE_PRESELECT_CONTROL" ]; then printf '%s' "$v" > "$FIXTURE_PRESELECT_BASE.selected"; while [ ! -e "$FIXTURE_PRESELECT_BASE.release-selection" ]; do sleep .01; done; fi\nprintf '%s\\n' "$v"\n`,{mode:0o755});
 process.env.FIXTURE_PRESELECT_BASE=selectedBase;process.env.FIXTURE_PRESELECT_CONTROL=join(aliasRoot,'control/control');
 const priorPath=process.env.PATH;process.env.PATH=fakeBin+':'+priorPath;
 const selectedControl=await launch([join(aliasRuntime,'control'),'deploy']);process.env.PATH=priorPath;
 await wait(()=>fs.existsSync(selectedBase+'.selected'),'old artifact resolved before publication');
 fs.unlinkSync(join(aliasRoot,'control'));fs.symlinkSync(copies.get(hybrid)!,join(aliasRoot,'control'));aliasManager.installRuntime();
 const selectedProcesses=driver.selectedLedgerProcesses({entries:()=>[String(earlyControl.pid),String(selectedControl.pid),String(preinstallHelper.pid)],canonical:()=>true});
 assert.equal(selectedProcesses.length,3,'accepted prepublication stable invocations and before-open helper are retained');
 const nativeStable=selectedProcesses.find((row:any)=>row.pid===earlyControl.pid)!;
 assert.equal(nativeStable.inode,beforeWrapper.ino);assert.equal(nativeStable.device,beforeWrapper.dev);
 driver.saveLaunchBootstrap({...driver.captureManagedLaunches(copies.get(hybrid),(args:string[])=>''),processes:selectedProcesses});
 assert.equal(await driver.retiredLaunchesDrained(),false);
 fs.writeFileSync(preinstallBase+'.open','1');await wait(()=>fs.existsSync(preinstallBase+'.native'),'same original legacy helper opens SQLite after publication');assert.deepEqual(JSON.parse(fs.readFileSync(preinstallBase+'.native','utf8')),{pid:preinstallHelper.pid,preinstall:true});assert.equal(await driver.retiredLaunchesDrained(),false);
 fs.writeFileSync(selectedBase+'.release-selection','1');await wait(()=>fs.existsSync(selectedBase+'.native'),'original selected artifact enters native Bun');
 assert.equal(Number(fs.readFileSync(selectedBase+'.native','utf8')),selectedControl.pid,'exec preserves original selected participant identity');
 fs.writeFileSync(early+'.release','1');assert.equal(await earlyControl.exited,0);
 assert.equal(await driver.retiredLaunchesDrained(),false,'original native child remains after other selected launcher returns');
 fs.writeFileSync(selectedBase+'.native-exit','1');assert.equal(await selectedControl.exited,0);
 assert.equal(await driver.retiredLaunchesDrained(),false,'before-open legacy mode retains its original native lifetime after other captured jobs finish');
 fs.writeFileSync(preinstallBase+'.exit','1');assert.equal(await preinstallHelper.exited,0);
 assert.equal(await driver.retiredLaunchesDrained(),true);
 const preinstallRead=new Database(preinstallBase+'.db',{readonly:true});assert.deepEqual(preinstallRead.query('SELECT id FROM original').all(),[{id:'original-preinstall-79'}]);preinstallRead.close();
 results.push({case:'actual-preinstall-mode-before-first-sqlite-open',preinstallMode,captured:selectedProcesses.find((row:any)=>row.pid===preinstallHelper.pid),publicationBeforeOriginalOpen:true,originalNativeLifetimeFencesEligibility:true,eligibleAfterNativeExit:true,noReplay:true,canonicalPolicy:'owned path classified live by controlled dependency only'});
 const selectedRead=new Database(selectedBase+'.db',{readonly:true});assert.deepEqual(selectedRead.query('SELECT id FROM original').all(),[{id:'original-preselected-79'}]);selectedRead.close();
 results.push({case:'actual-preselected-extensionless-control-outside-unit',participants:selectedProcesses,originalFdBeforeReplacement:true,oldArtifactExecPreservesIdentity:true,nativeExitBeforeDrain:true,noReplay:true});
 fs.unlinkSync(join(aliasRoot,'current'));fs.symlinkSync(copies.get(modern)!,join(aliasRoot,'current'));
 console.error(JSON.stringify({case:'old-primary-loaded-before-wrapper-upgrade',info:alias.info,aliasKernel,current:fs.realpathSync(join(aliasRoot,'current'))}));
 try {const identity=await driver.runningApplication();assert.equal(identity.artifact,copies.get(old));assert.equal(identity.pid,alias.info.pid);results.push({case:'unchanged-old-primary-before-wrapper-upgrade',identity,info:alias.info,aliasKernel});}
 catch(error){const failure={case:'unchanged-old-primary-before-wrapper-upgrade',error:String(error),pid:alias.child.pid,info:alias.info,aliasKernel};failures.push(failure);console.error(JSON.stringify({failure}));}
 await stop(alias.child);
 const modernAlias=await startApplication([join(aliasRuntime,'bun-engine'),join(aliasRoot,'current/bot/src/index.js')],copies.get(modern));
 await assert.rejects(driver.runningApplication(),/code|canonical|identity|artifact/i);
 results.push({case:'capable-app-mutable-alias-refused',pid:modernAlias.info.pid});await stop(modernAlias.child);
 process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT=releaseRoot;process.env.CONCIERGE_DEPLOYMENT_RUNTIME_DIR=runtime;
 // Run the unchanged old capture installer. Its absolute credential paths are
 // independently overlaid with owned dummy files by the outer namespace.
 const capture=process.env.CONCIERGE_CAPTURE_RUNTIME_DIR!,captureConfig=join(root,'capture-config'),captureUnits=join(root,'capture-units');
 fs.mkdirSync(captureConfig);fs.mkdirSync(captureUnits);fs.writeFileSync(join(captureConfig,'capture-routes.toml'),'# owned fixture routes\n');fs.writeFileSync(join(captureUnits,'agent-inbox.service'),'# owned fixture unit\n');
 const oldDeploy=join(root,'old-deploy99.sh');
 const historical=Bun.spawnSync(['/usr/bin/git','-C',resolve(import.meta.dir,'../..'),'show','99e66d2460c0b0ad8c58e5ac5d11fa002129c149:bot/scripts/deploy.sh'],{stdout:'pipe',stderr:'pipe'});assert.equal(historical.exitCode,0,Buffer.from(historical.stderr).toString());fs.writeFileSync(oldDeploy,historical.stdout);
 const captureInstall=join(root,'capture-install.sh');
 fs.writeFileSync(captureInstall,`#!/bin/bash\nset -euo pipefail\nsource "$FIXTURE_OLD_DEPLOY"\nCONTROL_CONFIG_DIR="$FIXTURE_CAPTURE_CONFIG"\ninstall_capture_runtime\ncapture_runtime_fingerprint > "$FIXTURE_CAPTURE_FINGERPRINT"\n`);
 // The old installer runs the repository-wide retry-architecture lint before building capture;
 // that lint is its own release check, so here a scratch repository with the real source and
 // dependencies records the call instead of repeating the whole-repository scan per install.
 const captureRepo=join(root,'capture-repo'),lintCalls=join(root,'capture-lint.calls'),realBot=resolve(import.meta.dir,'..');
 fs.mkdirSync(join(captureRepo,'bot/scripts'),{recursive:true});
 for(const name of ['src','node_modules','package.json'])fs.symlinkSync(join(realBot,name),join(captureRepo,'bot',name));
 fs.writeFileSync(join(captureRepo,'bot/scripts/retry-architecture-lint.ts'),`require('node:fs').appendFileSync(${JSON.stringify(lintCalls)},'lint\\n');\n`);
 const captureEnv={...process.env,CONCIERGE_REPO:captureRepo,CONCIERGE_BUN_BIN:join(runtime,'bun'),CONCIERGE_CAPTURE_CONFIG_DEST:join(root,'capture-routes.toml'),CONCIERGE_SYSTEMD_DIR:captureUnits,FIXTURE_OLD_DEPLOY:oldDeploy,FIXTURE_CAPTURE_CONFIG:captureConfig,FIXTURE_CAPTURE_FINGERPRINT:join(root,'capture-fingerprint')};
 async function installCapture(){const child=Bun.spawn(['/bin/bash',captureInstall],{env:captureEnv,stdout:'pipe',stderr:'pipe'});children.push(child);const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);fs.appendFileSync(join(root,'capture-install.stdout'),out);fs.appendFileSync(join(root,'capture-install.stderr'),err);assert.equal(code,0,err);return fs.readFileSync(captureEnv.FIXTURE_CAPTURE_FINGERPRINT,'utf8').trim();}
 const originalEngine=JSON.parse(fs.readFileSync(join(releaseRoot,'launch-authority/selected.json'),'utf8')).engine;
 const firstCapture=await installCapture(),firstWrapper=fs.readFileSync(join(capture,'bun'),'utf8');
 pointer('control',modern);manager.installRuntime();
 assert.equal(fs.readFileSync(join(runtime,'bun'),'utf8'),firstWrapper,'ordinary release preserves the copied generic engine wrapper bytes');
 const sameCapture=await installCapture();assert.equal(fs.readFileSync(lintCalls,'utf8'),'lint\nlint\n','the old installer still invokes its lint before each capture build');assert.equal(sameCapture,firstCapture,'actual old installer fingerprint stays unchanged across ordinary artifact promotion');
 const changedEngine=join(root,'changed-engine');fs.copyFileSync(process.execPath,changedEngine);fs.appendFileSync(changedEngine,'\nowned-engine-byte-change-79\n');fs.chmodSync(changedEngine,0o555);
 const changedManager=new driver.TrustedRootReleaseManager({repositoryRoot:root,releaseRoot,installRoot:runtime,bunExecutable:changedEngine});changedManager.installRuntime();
 const nextEngine=JSON.parse(fs.readFileSync(join(releaseRoot,'launch-authority/selected.json'),'utf8')).engine;assert.notEqual(nextEngine,originalEngine);
 const copied=Bun.spawnSync([join(capture,'bun'),'-e','console.log(process.execPath)'],{env:process.env});assert.equal(copied.exitCode,0,Buffer.from(copied.stderr).toString());assert.equal(Buffer.from(copied.stdout).toString().trim(),originalEngine,'copied capture wrapper keeps its actual old immutable engine');
 const heldEngine=changedManager.pruneReleases([],0);assert.equal(fs.existsSync(originalEngine),true,'copied capture wrapper retains its old engine through actual pruning');assert.equal(heldEngine.enginesRemoved.includes(originalEngine.split('/').at(-2)),false);
 const changedCapture=await installCapture();assert.notEqual(changedCapture,firstCapture,'different engine bytes change the actual old installer fingerprint');
 const afterCapture=changedManager.pruneReleases([],0);assert.equal(fs.existsSync(originalEngine),false,'old engine can retire after capture wrapper moves and no native user remains');
 results.push({case:'unchanged-old-capture-installer-immutable-engine',oldDeploySha256:sha(fs.readFileSync(oldDeploy)),firstCapture,sameCapture,changedCapture,originalEngine,nextEngine,heldEngine,afterCapture,copiedOldEnginePreserved:true});
 assert.equal(fs.existsSync(process.env.SYSTEMCTL_DENY_LOG!),false,'no systemctl query may bypass controlled observation');
 console.log(JSON.stringify({fixture:'deployment-launch-schedules',root,results,failures,systemctlDenied: false}));
} finally {clearTimeout(deadline);for(const child of children)await stop(child).catch(()=>{});
 const enginePaths=[join(root,'changed-engine')];for(const lane of [runtime,join(root,'legacy-runtime')]){const engines=join(lane,'engines');if(fs.existsSync(engines))for(const name of fs.readdirSync(engines))if(/^[a-f0-9]{64}$/.test(name))enginePaths.push(join(engines,name,'bun'));const raw=join(lane,'bun-engine');if(fs.existsSync(raw)&&!fs.lstatSync(raw).isSymbolicLink())enginePaths.push(raw);}
 const cleaned=[];for(const path of enginePaths)if(fs.existsSync(path)){const hash=createHash('sha256');for await(const chunk of fs.createReadStream(path))hash.update(chunk);const bytes=fs.statSync(path).size;fs.unlinkSync(path);cleaned.push({path,bytes,sha256:hash.digest('hex')});}console.error(JSON.stringify({ownedExecutableCopiesCleaned:cleaned}));}
if(failures.length)process.exitCode=1;
