import assert from 'node:assert/strict';
import {mock} from 'bun:test';
import {Database} from 'bun:sqlite';
import {Worker as NativeWorker} from 'node:worker_threads';
import {mkdtempSync,writeFileSync,readFileSync,openSync,fstatSync,statSync,closeSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {ledgerWriteResults} from '../src/ledger-write-results';
import {observedDatabase} from '../src/storage-observation';
import {runLedgerSegment,ledgerAdmissionSnapshot,assertLedgerSql} from '../src/ledger-admission';
const mode=process.argv[2]??'own-exit',baseline=process.argv.includes('--old'),root=mkdtempSync('/tmp/wal79-pregrant-');
process.env.CONCIERGE_STATE_DIR=root;
const original=ledgerWriteResults(new Database(root+'/state.db'));original.exec('PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE application(value);INSERT INTO application VALUES(1);PRAGMA user_version=-23');
const db=observedDatabase(original,assertLedgerSql),fd=openSync(root+'/state.db-wal','r'),identity=fstatSync(fd);
const sourceRoot=resolve(import.meta.dir,'../src');
const baselineOption=process.argv.indexOf('--baseline-dir'),base=baselineOption>=0?resolve(process.argv[baselineOption+1]!):null;
if(baseline&&!base)throw Error('The --old comparison requires --baseline-dir pointing to its retained exact pre-repair source.');
const workerSource=baseline?base+'/ledger-durability-worker.ts':sourceRoot+'/ledger-durability-worker.ts';
const sourcePath=baseline?base+'/ledger-durability.ts':sourceRoot+'/ledger-durability.ts';
const workers:ObservedWorker[]=[],trace:any[]=[],authority:any[]=[];
let finishing=false;
const baselineComplete=Symbol('baseline complete');
const record=(value:any)=>{trace.push({...value,at:Date.now(),admission:ledgerAdmissionSnapshot()});writeFileSync(root+'/trace.json',JSON.stringify(trace,null,2));};
// Baseline source imports its protocol sibling; keep that unchanged source boundary local.
if(baseline)writeFileSync(base+'/ledger-checkpoint-protocol.ts',readFileSync(sourceRoot+'/ledger-checkpoint-protocol.ts'));
writeFileSync(root+'/native-entry.ts',`import {parentPort,workerData} from 'node:worker_threads';await import(workerData.sourcePath);parentPort!.on('message',m=>{if(m.kind==='fixture-own-exit')process.exit(0);if(m.kind==='fixture-own-error')throw Error('disposable pregrant failure');});`);
class ObservedWorker extends NativeWorker {
 role:string;workerId:string;ended=false;exitObserved:Promise<void>;private finishExit!:()=>void;
 constructor(_path:any,options:any){super(root+'/native-entry.ts',{workerData:{...options.workerData,sourcePath:workerSource,quietBytes:1,forceBytes:1}});this.role=options.workerData.role;this.workerId=options.workerData.workerId;this.exitObserved=new Promise<void>(r=>this.finishExit=r);workers.push(this);}
 emit(name:any,...args:any[]):boolean{if(name==='message')record({direction:'worker-to-owner',workerId:this.workerId,role:this.role,message:args[0]});if(name==='exit'){this.ended=true;this.finishExit?.();record({kind:'exit',workerId:this.workerId,role:this.role});if(finishing)return true;}return super.emit(name,...args);}
 postMessage(message:any){record({direction:'owner-to-worker',workerId:this.workerId,role:this.role,message});super.postMessage(message);}
 terminate():Promise<number>{assert.notEqual(this.role,'checkpoint','checkpoint native force forbidden');return super.terminate();}
}
(globalThis as any).__pregrantWorker=ObservedWorker;writeFileSync(root+'/worker-shim.ts','export const Worker=globalThis.__pregrantWorker;');
mock.module('../src/state-database',()=>({db}));mock.module('../src/log',()=>({log(){}}));
const source=readFileSync(sourcePath,'utf8').replace("from 'node:worker_threads'",`from '${root}/worker-shim.ts'`).replace(/from '\.\/([^']+)'/g,(_m,name)=>`from '${sourceRoot}/${name}'`);
writeFileSync(root+'/owner.ts',source);const coordinator=await import(root+'/owner.ts');const {ledgerDurable}=await import('../src/ledger-durability-barrier');
let ready=true,rejectHealthy=true,releases=0,releaseHealthyGrant:(()=>void)|undefined;
coordinator.installLedgerMaintenanceAuthority(async()=>{const snapshot=ledgerAdmissionSnapshot();const entry={attempt:authority.length+1,at:Date.now(),epoch:snapshot.epoch,phase:snapshot.phase,ready};authority.push(entry);
 if(!ready||rejectHealthy&&authority.length>1){rejectHealthy=false;record({kind:'pregrant-refused',...entry});throw Error('disposable legacy lifetime still owns launch authority');}
 if(!baseline&&authority.length===3)await new Promise<void>(r=>releaseHealthyGrant=r);
 record({kind:'authority-acquired',...entry});return async()=>{assert.equal(ledgerAdmissionSnapshot().phase,'serving');await Promise.resolve();releases++;record({kind:'authority-released',epoch:ledgerAdmissionSnapshot().epoch});};});
const until=async(check:()=>boolean,label:string,ms=15000)=>{const end=Date.now()+ms;while(!check()){assert.ok(Date.now()<end,label);await Bun.sleep(2);}};
const requests=()=>trace.filter(t=>t.direction==='worker-to-owner'&&t.message?.kind==='maintenance-request');
const recycled=()=>trace.filter(t=>t.direction==='worker-to-owner'&&t.message?.kind==='recycled');
const http=Bun.serve({port:0,async fetch(request){if(new URL(request.url).pathname==='/sql'){await runLedgerSegment(()=>db.exec('UPDATE application SET value=value+1'));return Response.json({sql:true});}return Response.json({live:true});}});
const serving=async(epoch:number)=>{assert.equal(ledgerAdmissionSnapshot().phase,'serving');assert.equal(ledgerAdmissionSnapshot().epoch,epoch);assert.deepEqual(await(await fetch(`http://127.0.0.1:${http.port}/sql`)).json(),{sql:true});assert.deepEqual(await(await fetch(`http://127.0.0.1:${http.port}/live`)).json(),{live:true});await ledgerDurable();assert.equal(ledgerAdmissionSnapshot().epoch,epoch);};
try {
 coordinator.startLedgerDurability(root);await until(()=>coordinator.ledgerDurabilityCounters().mode==='deferred','original descriptor sync ready');
 coordinator.activateLedgerMaintenance({recycling:false});await coordinator.initializeLedgerRecycling();assert.equal(ledgerAdmissionSnapshot().epoch,1);assert.equal(releases,1);assert.equal(requests().length,0);
 coordinator.enableLedgerRecycling();await until(()=>authority.length>=2,'first actual five-second eligibility request refused');assert.equal(recycled().length,1);await serving(1);
 const first=requests()[0];assert.ok(first);assert.equal(first.admission.epoch,1);
 if(baseline){await Bun.sleep(5500);assert.equal(authority.length,2);assert.equal(requests().length,1);console.log(JSON.stringify({pass:true,baselineStuck:true,root,first,authority,originalWorker:workers.find(w=>w.role==='checkpoint')!.workerId}));throw baselineComplete;}
 await until(()=>requests().length===2&&!!releaseHealthyGrant,'second eligibility attempt waits for external authority');
 const originalCheckpoint=workers.find(w=>w.role==='checkpoint')!;
 originalCheckpoint.postMessage({kind:'maintenance-deferred',workerId:originalCheckpoint.workerId,requestId:first.message.requestId,obligationId:first.message.obligationId});
 originalCheckpoint.postMessage({kind:'maintenance-deferred',workerId:'foreign-incarnation',requestId:requests()[1].message.requestId,obligationId:first.message.obligationId});
 originalCheckpoint.postMessage({kind:'resumed',epoch:1});
 await Bun.sleep(5100);assert.equal(requests().length,2,'stale request/foreign incarnation/completed epoch cannot clear current pending attempt');await serving(1);releaseHealthyGrant!();
 await until(()=>recycled().length>=2,'later unchanged five-second tick completes retained obligation');await until(()=>ledgerAdmissionSnapshot().phase==='serving','first cycle resumes');
 const second=requests()[1];assert.equal(first.workerId,second.workerId);assert.equal(first.message.obligationId,second.message.obligationId);assert.ok(second.message.requestId>first.message.requestId);assert.equal(recycled()[1].workerId,first.workerId);
 // Stale attempt/epoch messages cannot clear a later pending obligation or grant.
 originalCheckpoint.postMessage({kind:'maintenance-deferred',workerId:originalCheckpoint.workerId,requestId:first.message.requestId,obligationId:first.message.obligationId});
 originalCheckpoint.postMessage({kind:'resumed',epoch:1});
 await until(()=>recycled().length>=3,'original worker next periodic cycle');await until(()=>ledgerAdmissionSnapshot().phase==='serving','next original cycle resumes');
 assert.equal(recycled()[2].workerId,first.workerId);assert.notEqual(requests()[2].message.obligationId,first.message.obligationId);
 const faultEpoch=ledgerAdmissionSnapshot().epoch;ready=false;const attemptsBeforeFault=authority.length;
 originalCheckpoint.postMessage({kind:mode==='own-error'?'fixture-own-error':'fixture-own-exit'});
 await until(()=>authority.length>attemptsBeforeFault,'faulted incarnation pregrant authority refused');await until(()=>originalCheckpoint.ended,'original strict cleanup then own exit');await serving(faultEpoch);
 assert.equal(authority.length,attemptsBeforeFault+1,'error plus own exit share one retained pregrant obligation until replacement cadence');
 assert.equal(workers.filter(w=>w.role==='checkpoint').length,1);assert.ok(trace.some(t=>t.workerId===originalCheckpoint.workerId&&t.message?.kind==='ledger-closed'));
 ready=true;
 await until(()=>workers.filter(w=>w.role==='checkpoint').length===2,'retained dead-worker obligation retries then replaces after strict cleanup',15000);
 await until(()=>recycled().length>=4,'replacement primes original retained recovery epoch');await until(()=>ledgerAdmissionSnapshot().phase==='serving','faulted recovery resumes');assert.equal(ledgerAdmissionSnapshot().epoch,faultEpoch+1);
 await until(()=>recycled().length>=5,'replacement next periodic cycle');await until(()=>ledgerAdmissionSnapshot().phase==='serving','replacement next cycle resumes');
 assert.equal(workers.filter(w=>w.role==='sync').length,1);assert.equal(workers.filter(w=>w.role==='checkpoint').length,2);assert.equal(releases,5);
 assert.equal(fstatSync(fd).ino,identity.ino);assert.equal(statSync(root+'/state.db-wal').ino,identity.ino);assert.equal((await runLedgerSegment(()=>db.query('PRAGMA user_version').get()) as any).user_version,-23);
 console.log(JSON.stringify({pass:true,mode,root,requests:requests().map(t=>({workerId:t.workerId,requestId:t.message.requestId,obligationId:t.message.obligationId,at:t.at,epoch:t.admission.epoch})),epochs:recycled().map(t=>({workerId:t.workerId,epoch:t.message.epoch})),authority,releases,originalSyncWorkers:1,checkpointWorkers:2,servingSqlAndHttpAfterEachPregrantRefusal:true,sameEligibleObligationRetried:true,staleRequestIncarnationAndCompletedEpochIgnored:true,deadIncarnationRecoveredWithoutManualTrigger:true,nativeCloseAndOwnExitBeforeReplacement:true,originalDescriptorRetained:true,limits:'Actual coordinator/worker source bodies, real Bun SQLite and original sync worker; only imports redirected for observation/fault wrapper, threshold sizes overridden to1byte in disposable workerData. Original5000ms interval and replacement cadence retained. Own error/exit injected by wrapper listener; authority refusal and readiness controlled. No production provider/service/state.'}));
}catch(error){if(error!==baselineComplete)throw error;}finally{
 finishing=true;http.stop(true);const checkpoint=workers.filter(w=>w.role==='checkpoint').at(-1);if(checkpoint&&!checkpoint.ended){checkpoint.postMessage({kind:'retire',retirementId:999});await checkpoint.exitObserved;}
 // Final fixture shutdown suppresses only the deliberate retirement's coordinator
 // exit notification. The original descriptor worker remains until process exit.
 closeSync(fd);await runLedgerSegment(()=>original.close(true));writeFileSync(root+'/cleanup.json',JSON.stringify({checkpointClosedAndExited:checkpoint?.ended,originalSyncLivesUntilWholeFixtureExit:true,externalWalFdClosed:true,canonicalClosed:true,httpStopped:true}));
}
process.exit(0);
