import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Database} from 'bun:sqlite';
import {chmodSync,copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,renameSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {ledgerWriteResults} from '../src/ledger-write-results';
import {TrustedRootReleaseManager,releaseFileSetDigest} from '../src/deployment-release';
import {acquireLaunchLock,captureManagedLaunches,captureManagedLaunchesAsync,deploymentSelectionLock,holdLegacyLaunch,launchReleaseCommand,
 managedLaunchesDrained,processBootId,processStartTicks,semanticCommandPath,launchAuthorityReferences,type ApplicationSelection} from '../src/deployment-launch-authority';

if(process.platform!=='linux'){console.log(JSON.stringify({fixture:'deployment-launch-authority',status:'not-applicable',platform:process.platform}));process.exit(0);}
const root=mkdtempSync('/tmp/wal9747-launch-authority-');
process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT=join(root,'release');
process.env.CONCIERGE_DEPLOYMENT_RUNTIME_DIR=join(root,'runtime');
process.env.CONCIERGE_STATE_DIR=join(root,'state');
const releaseRoot=process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT!,runtime=process.env.CONCIERGE_DEPLOYMENT_RUNTIME_DIR!;
mkdirSync(join(releaseRoot,'releases'),{recursive:true});mkdirSync(runtime);mkdirSync(process.env.CONCIERGE_STATE_DIR!);
const deadline=setTimeout(()=>{for(const phase of ['checkpoint','header'])writeFileSync(join(root,phase+'.release'),'1');process.exit(1);},25000);
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function seal(path:string){for(const name of readdirSync(path)){const child=join(path,name);if(statSync(child).isDirectory())seal(child);else chmodSync(child,0o444);}chmodSync(path,0o555);}
function artifact(name:string,commands:Record<string,string>,capable:boolean,authority=true){
 const stage=join(releaseRoot,'releases','.'+name);mkdirSync(stage);
 const files:Record<string,string>={'control/deploy.sh':'echo fixture-deploy',
  'control/deployment-repair.js':'console.log("fixture-repair")','control/release-manager.js':'console.log("fixture-manager")',
  'bot/src/index.js':capable?'export const conciergeLedgerCommandsV1=true;':'throw Error("Static legacy main must not execute during inspection");',
  'control/deployment-launcher.sh':'echo fixture-launch','control/deployment-control-launcher.sh':'echo fixture-control',...commands};
 if(capable)files['control/deployment-ledger-commands.json']='{"format":1}';
 if(authority)files['control/deployment-command-authority.json']='{"format":1}';
 for(const [file,text]of Object.entries(files)){mkdirSync(dirname(join(stage,file)),{recursive:true});writeFileSync(join(stage,file),text);}
 const unsigned={format:2,git_commit:'a'.repeat(40),control_git_commit:'b'.repeat(40),source_tree_digest:hash(name),control_source_tree_digest:hash(name),
  runtime_digest:releaseFileSetDigest(stage,Object.keys(files)),compatibility_digest:hash('compatible'),files:Object.fromEntries(Object.entries(files).map(([file,text])=>[file,hash(text)]))};
 const digest=hash(JSON.stringify(unsigned));writeFileSync(join(stage,'manifest.json'),JSON.stringify({...unsigned,artifact_digest:digest}));seal(stage);
 const path=join(releaseRoot,'releases',digest);renameSync(stage,path);return path;
}
const wait=async(predicate:()=>boolean,label:string)=>{const start=Date.now();while(!predicate()){assert.ok(Date.now()-start<10000,label);await Bun.sleep(2);}};
let database:Database|undefined;
try{
 const query=(args:string[])=>args[0]==='list-units'?'concierge-deploy-old.service loaded active running old\n':args[0]==='list-jobs'?'41 concierge-control-recovery-old.service start waiting\n':
  'InvocationID=old\nControlGroup=\nActiveState=activating\nJob=41';
 const captured=captureManagedLaunches('artifact',query);
 assert.equal(captured.units.length,2,'accepted queued launch is retained even without MainPID/cgroup');
 assert.deepEqual(await captureManagedLaunchesAsync('artifact',async args=>query(args)),captured);
 assert.equal(await managedLaunchesDrained(captured,async args=>query(args)),false);
 assert.equal(await managedLaunchesDrained(captured,async()=> 'InvocationID=old\nActiveState=inactive\nJob=0'),true);

 const selection=(await acquireLaunchLock(deploymentSelectionLock(),true))!;
 let selected=false;
 const pending=acquireLaunchLock(deploymentSelectionLock(),false).then(lock=>{selected=true;return lock!;});
 await Bun.sleep(15);assert.equal(selected,false,'selection waits asynchronously behind protected epoch');await selection();await (await pending)();

 const probe=join(root,'probe.js');
 writeFileSync(probe,`import{attestedLegacyLaunch}from ${JSON.stringify(join(import.meta.dir,'../src/deployment-launch-authority.ts'))};import{writeFileSync}from'node:fs';writeFileSync(process.env.PROBE_RESULT,JSON.stringify({attested:attestedLegacyLaunch(),main:import.meta.path,args:process.argv.slice(2)}));`);
 const old=artifact('old',{},false,false);
 const capable=artifact('capable',{'control/application/session-turn-queue.js':readFileSync(probe,'utf8')},true);
 const controller=artifact('controller',{'control/session-turn-queue.js':readFileSync(probe,'utf8')},false,true);
 symlinkSync(controller,join(releaseRoot,'control'));symlinkSync(old,join(releaseRoot,'current'));
 mkdirSync(join(releaseRoot,'launch-authority'),{recursive:true});writeFileSync(join(releaseRoot,'launch-authority/selected.json'),JSON.stringify({format:1,artifact:controller}));
 copyFileSync(process.execPath,join(runtime,'bun-engine'));chmodSync(join(runtime,'bun-engine'),0o555);
 const oldApplication:ApplicationSelection={artifact:old,pid:process.pid,controlPid:0,state:'active',invocationId:'old',bootId:processBootId(),startTicks:processStartTicks(process.pid)};
 for(const [label,original]of [['source',join(import.meta.dir,'session-turn-queue.ts')],['sealed',join(old,'control/session-turn-queue.js')],['pinned',join(root,'helpers','c'.repeat(40),'bot/scripts/session-turn-queue.js')]]){
  process.env.PROBE_RESULT=join(root,label+'.json');
  assert.equal(await launchReleaseCommand('bun',['run',original!,'resume','--turn-id','7'],async()=>oldApplication),0);
  const result=JSON.parse(readFileSync(process.env.PROBE_RESULT,'utf8'));
  assert.equal(result.attested,true,label+' enters FULL only under inherited kernel lifetime');
  assert.equal(result.main,semanticCommandPath(controller,'session-turn-queue'));assert.deepEqual(result.args,['resume','--turn-id','7']);
 }
 process.env.PROBE_RESULT=join(root,'new.json');
 assert.equal(await launchReleaseCommand('bun',[join(old,'control/session-turn-queue.js'),'resume','--turn-id','7'],async()=>({...oldApplication,artifact:capable,invocationId:'new'})),0);
 const modern=JSON.parse(readFileSync(process.env.PROBE_RESULT,'utf8'));assert.equal(modern.attested,false,'capable generation does not inherit old lifetime');
 assert.equal(modern.main,semanticCommandPath(capable,'session-turn-queue'));

 // An actual SQLite VM teardown waits in fsync while the launcher's lifetime
 // description remains locked. The descriptor is not inferred from JS exit hooks.
 const compiled=Bun.spawnSync(['cc','-shared','-fPIC','-O2',join(import.meta.dir,'ledger-recycling-sync-latch.c'),'-ldl','-o',join(root,'hold.so')]);
 assert.equal(compiled.exitCode,0,compiled.stderr.toString());
 const path=join(root,'native.db');database=ledgerWriteResults(new Database(path));database.exec('PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE witness(n);INSERT INTO witness VALUES(1)');
 const nativeSource=`import{Database}from'bun:sqlite';import{writeFileSync,readFileSync}from'node:fs';import{attestedLegacyLaunch}from ${JSON.stringify(join(import.meta.dir,'../src/deployment-launch-authority.ts'))};const db=new Database(process.env.LEDGER_LATCH_DB);db.exec('PRAGMA wal_autocheckpoint=0;INSERT INTO witness VALUES(2)');writeFileSync(process.env.PROBE_RESULT,JSON.stringify({attested:attestedLegacyLaunch(),fdinfo:readFileSync('/proc/self/fdinfo/3','utf8')}));writeFileSync(process.env.LEDGER_LATCH_ROOT+'/armed','1');process.exit(0);`;
 const nativeController=artifact('native',{'control/session-turn-queue.js':nativeSource},false,true);
 const swap=join(releaseRoot,'next');symlinkSync(nativeController,swap);renameSync(swap,join(releaseRoot,'control'));
 process.env.LEDGER_LATCH_ROOT=root;process.env.LEDGER_LATCH_DB=path;process.env.LD_PRELOAD=join(root,'hold.so');process.env.PROBE_RESULT=join(root,'native.json');
 let returned=false;
 const execution=launchReleaseCommand('bun',[join(old,'control/session-turn-queue.js')],async()=>oldApplication).then(code=>{returned=true;return code;});
 await wait(()=>existsSync(join(root,'checkpoint.entered')),'actual native exit synchronization entered');
 const held=await holdLegacyLaunch(nativeController,oldApplication);
 const lifetimePath=join(releaseRoot,'launch-authority/legacy',held.identity.generation+'.lock');await held.release();
 assert.equal(JSON.parse(readFileSync(process.env.PROBE_RESULT,'utf8')).attested,true);
 assert.equal(await acquireLaunchLock(lifetimePath,true,true),null,'outer launcher retains FD through actual SQLite cleanup');
 assert.equal(returned,false,'a child JS exit cannot certify native cleanup');
 writeFileSync(join(root,'checkpoint.release'),'1');writeFileSync(join(root,'header.release'),'1');assert.equal(await execution,0);
 const reclaimed=await acquireLaunchLock(lifetimePath,true,true);assert.ok(reclaimed,'lock releases after native process close');await reclaimed!();
 const referenceRoot=join(root,'reference-proof');mkdirSync(referenceRoot);
 const reference=join(referenceRoot,'bootstrap.json'),retainedArtifact=join(root,'retained-bootstrap-artifact');
 writeFileSync(reference,JSON.stringify({artifact:retainedArtifact,nativeComplete:false}));
 assert.ok(launchAuthorityReferences(referenceRoot).includes(retainedArtifact));
 writeFileSync(reference,JSON.stringify({artifact:retainedArtifact,nativeComplete:true}));
 assert.ok(!launchAuthorityReferences(referenceRoot).includes(retainedArtifact),'completed finite bootstrap stops retaining its old artifact');
 console.log(JSON.stringify({status:'passed',root,checks:['queued-intents','selection-exclusion','source-sealed-pinned-route','old-new-full-compatibility','actual-native-cleanup-fd','completed-bootstrap-reference-retirement']}));
}finally{
 clearTimeout(deadline);for(const phase of ['checkpoint','header'])writeFileSync(join(root,phase+'.release'),'1');database?.close();delete process.env.LD_PRELOAD;
}
