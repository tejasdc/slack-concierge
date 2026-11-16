import assert from 'node:assert/strict';
import {existsSync,fstatSync,mkdirSync,mkdtempSync,openSync,closeSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {runFixtureChild} from './fixture-child';

if(process.platform!=='linux'){console.log(JSON.stringify({fixture:'deployment-ledger-handover',status:'not-applicable',platform:process.platform}));process.exit(0);}
if(!process.argv.includes('--native-body')){
 const root=mkdtempSync('/tmp/wal9747-handover-');
 await runFixtureChild({command:'cc',args:['-shared','-fPIC','-O2',join(import.meta.dir,'ledger-recycling-sync-latch.c'),'-ldl','-o',join(root,'latch.so')],env:process.env,deadlineMs:10000,fixture:'handover-latch-compile',requireCheckpoint:false});
 await runFixtureChild({command:process.execPath,args:[import.meta.path,'--native-body'],
  env:{...process.env,LD_PRELOAD:join(root,'latch.so'),LEDGER_LATCH_ROOT:root,LEDGER_LATCH_DB:join(root,'state.db')},
  deadlineMs:30000,fixture:'deployment-ledger-handover',requireCheckpoint:false,onOutput:(stream,chunk)=>process[stream].write(chunk)});
 process.exit(0);
}
const root=process.env.LEDGER_LATCH_ROOT!;
assert.ok(root.startsWith('/tmp/wal9747-handover-'));
process.env.CONCIERGE_STATE_DIR=root;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(root,'capture');
process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT=join(root,'deployment');
const until=async(predicate:()=>boolean,label:string)=>{const end=Date.now()+15000;while(!predicate()){assert.ok(Date.now()<end,label);await Bun.sleep(2);}};
const [{db},{SessionOwner},{requestApiHandler,localOwnerRequestApiHandler,supervisorControlResponse},durability,{protectedOwnerReceipt},admission,barrier,authority,handover]=await Promise.all([
 import('../src/state'),import('../src/session-owner'),import('../src/routed-request-api'),import('../src/ledger-durability'),import('../src/protected-owner-receipt'),
 import('../src/ledger-admission'),import('../src/ledger-durability-barrier'),import('../src/deployment-launch-authority'),import('../src/deployment-ledger-handover')]);
const runId=crypto.randomUUID(),digest='a'.repeat(64),commit='b'.repeat(40);
db.query("INSERT INTO deployment_runs(id,target,unit_name,status,candidate_commit,candidate_artifact_digest) VALUES(?,'concierge','handover-fixture','releasing',?,?)").run(runId,commit,digest);
db.exec('CREATE TABLE old_supervisor_witness(n);INSERT INTO old_supervisor_witness VALUES(0)');
const owner=new SessionOwner({available:()=>true,wake:()=>{},stop:async()=>false,steer:()=>false},root);
const handle=localOwnerRequestApiHandler(requestApiHandler(null,null,undefined,owner),undefined,owner);
const server=Bun.serve({unix:join(root,'owner.sock'),fetch:request=>supervisorControlResponse(request)??protectedOwnerReceipt(()=>handle(request))});
const ping=async()=>{
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),1000);
 try{const response=await fetch('http://owner/supervisor/ping',{unix:join(root,'owner.sock'),signal:controller.signal} as any);assert.equal(response.status,200);}
 finally{clearTimeout(timeout);}
};
let child:ReturnType<typeof Bun.spawn>|undefined,descriptor:number|undefined;
const release=()=>{for(const phase of ['checkpoint','header','receipt1','receipt2'])writeFileSync(join(root,phase+'.release'),'1');};
try{
 durability.startLedgerDurability(root);
 await until(()=>durability.ledgerDurabilityCounters().mode==='deferred','original sync descriptor is ready');
 descriptor=openSync(join(root,'state.db-wal'),'r');const original=fstatSync(descriptor);
 durability.installLedgerMaintenanceAuthority(authority.acquireRecyclingLaunchAuthority);
 durability.activateLedgerMaintenance({recycling:false});
 const application:import('../src/deployment-launch-authority').ApplicationSelection={artifact:join(root,'sealed-new'),pid:process.pid,
  invocationId:'fixture-owner',state:'activating',controlPid:0,bootId:authority.processBootId(),startTicks:authority.processStartTicks(process.pid)};
 let enabled=false,primeCount=0;
 const coordinator=handover.installDeploymentLedgerHandover(application,digest,{
  application:async()=>({...application,state:'active'}),acquire:authority.acquireRecyclingLaunchAuthority,prove:barrier.ledgerDurable,
  prime:async()=>{primeCount++;await durability.initializeLedgerRecycling();writeFileSync(join(root,'hold-receipt'),'1');},
  enable:()=>{enabled=true;durability.enableLedgerRecycling();}});
 const oldPath=join(process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT!,'releases','c'.repeat(64),'control');mkdirSync(oldPath,{recursive:true});
 const deployChild=join(root,'deploy-child.js');
 writeFileSync(deployChild,`const response=await fetch('http://owner/internal/deployment-run',{unix:${JSON.stringify(join(root,'owner.sock'))},method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation:'succeed',runId:${JSON.stringify(runId)},repo:${JSON.stringify(root)},deployedCommit:${JSON.stringify(commit)},serviceInvocationId:'fixture-owner',evidence:{runtime_sha:${JSON.stringify(commit)}}})});if(!response.ok)throw Error(await response.text());await response.json();await Bun.write(${JSON.stringify(join(root,'succeed-response'))},'received');`);
 const supervisor=join(oldPath,'deployment-repair.js');
 writeFileSync(supervisor,`import{Database}from'bun:sqlite';import{writeFileSync}from'node:fs';const db=new Database(${JSON.stringify(join(root,'state.db'))});db.exec('PRAGMA synchronous=FULL;PRAGMA wal_autocheckpoint=0');writeFileSync(${JSON.stringify(join(root,'ancestor-open'))},'1');while(!await Bun.file(${JSON.stringify(join(root,'ancestor-go'))}).exists())await Bun.sleep(2);const child=Bun.spawnSync([process.execPath,${JSON.stringify(deployChild)}],{stdout:'inherit',stderr:'inherit'});if(child.exitCode!==0)process.exit(1);db.exec('UPDATE old_supervisor_witness SET n=n+1');writeFileSync(${JSON.stringify(join(root,'armed'))},'1');process.exit(0);`);
 child=Bun.spawn([process.execPath,supervisor],{env:process.env,stdout:'inherit',stderr:'inherit'});
 await until(()=>existsSync(join(root,'ancestor-open')),'old enclosing supervisor has opened SQLite');
 const participants=authority.selectedLedgerProcesses({entries:()=>[String(child!.pid)],canonical:path=>path===join(root,'state.db')});
 assert.equal(participants.length,1,'actual supported sealed supervisor main is captured');
 authority.prepareLaunchAuthority();
 authority.saveLaunchBootstrap({format:1,artifact:application.artifact,bootId:application.bootId,units:[],processes:participants,launchersClosed:true});
 writeFileSync(join(root,'ancestor-go'),'1');
 await until(()=>existsSync(join(root,'checkpoint.entered')),'old ancestor native cleanup is held after deploy child response');
 assert.ok(existsSync(join(root,'succeed-response')),'existing success response did not wait for enclosing supervisor');
 const pending=db.query("SELECT count(*) n FROM deployment_run_events WHERE run_id=? AND event='ledger_handover_pending'").get(runId) as any;
 assert.equal(pending.n,1,'compatible success registered durable pending handover');
 assert.equal((db.query("SELECT status FROM deployment_runs WHERE id=?").get(runId) as any).status,'succeeded');
 await assert.rejects(coordinator.reconcile(),/Prior managed release still owns native cleanup/);
 assert.equal(enabled,false);assert.equal(primeCount,0);assert.equal(admission.ledgerAdmissionSnapshot().phase,'serving');await ping();
 assert.equal(await authority.selectedProcessAlive(participants[0]!),true,'kernel identity remains live during native fsync');
 release();assert.equal(await child.exited,0);assert.equal(await authority.selectedProcessAlive(participants[0]!),false);
 assert.equal((db.query('SELECT n FROM old_supervisor_witness').get() as any).n,1,'old ancestor terminal mutation completed once after deploy child');
 for(const phase of ['receipt1','receipt2']){const path=join(root,phase+'.release');if(existsSync(path))await Bun.write(path,'1');}
 // Re-arm only receipt1 after the prime; the initial old cleanup latches stay released.
 const fs=await import('node:fs');fs.unlinkSync(join(root,'receipt1.release'));
 let returned=false;const completed=coordinator.reconcile().then(()=>{returned=true;});
 await until(()=>existsSync(join(root,'receipt1.entered')),'actual original descriptor holds completion receipt');
 assert.equal(primeCount,1);assert.equal(enabled,false);assert.equal(returned,false);await ping();
 const receipt=readFileSync(join(root,'receipt1.entered'),'utf8');assert.match(receipt,/original-descriptor-fdatasync/);
 assert.notEqual(Number(/tid=(\d+)/.exec(receipt)![1]),process.pid,'completion proof runs on original sync worker');
 const current=statSync(join(root,'state.db-wal'));assert.equal(current.dev,original.dev);assert.equal(current.ino,original.ino);assert.ok(fstatSync(descriptor).nlink>0);
 writeFileSync(join(root,'receipt1.release'),'1');await completed;assert.equal(enabled,true);
 assert.equal((db.query("SELECT count(*) n FROM deployment_run_events WHERE event='ledger_handover_complete'").get() as any).n,1);
 await coordinator.reconcile();assert.equal(primeCount,1,'same owner reconciles once');
 let restartPrime=0,restartEnable=0;
 const restarted=new handover.DeploymentLedgerHandover(handover.ownerHandover({...application,invocationId:'new-invocation',startTicks:application.startTicks+'1'},digest),{
  application:async()=>({...application,invocationId:'new-invocation',startTicks:application.startTicks+'1'}),acquire:async()=>()=>{},
  prove:barrier.ledgerDurable,prime:async()=>{restartPrime++;},enable:()=>{restartEnable++;}});
 await restarted.reconcile();assert.equal(restartPrime,1);assert.equal(restartEnable,1,'prior completion does not authorize restarted incarnation');
 const headerTrace=readFileSync(join(root,'sync.log'),'utf8');
 assert.equal(headerTrace.split('\n').some(line=>line.includes(`tid=${process.pid} `)),false,'resumed owner did not synchronize the fresh WAL header');
 console.log(JSON.stringify({fixture:'deployment-ledger-handover',status:'passed',root,oldAncestor:child.pid,ownerPid:process.pid,completionSync:receipt.trim(),primeCount,restartPrime,
  proof:'actual owner route, existing success, SQLite ancestor native cleanup, initial native worker prime, held original-fd completion receipt; synthetic supervised identity and restart native collaborator'}));
}finally{
 release();if(child&&child.exitCode===null){child.kill('SIGKILL');await child.exited;}await server.stop(true);
 if(descriptor!==undefined)closeSync(descriptor);
 await admission.runLedgerSegment(()=>db.close());
}
process.exit(0);
