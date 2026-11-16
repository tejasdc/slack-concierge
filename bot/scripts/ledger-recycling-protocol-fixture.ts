import assert from 'node:assert/strict';
import {mock} from 'bun:test';
import {EventEmitter} from 'node:events';
import {Database} from 'bun:sqlite';
import {ledgerWriteResults} from '../src/ledger-write-results';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {enableLedgerAdmission,runLedgerSegment,ledgerAdmissionSnapshot} from '../src/ledger-admission';
if(process.platform!=='linux'){console.log(JSON.stringify({fixture:'ledger-recycling-protocol',status:'not-applicable',platform:process.platform}));process.exit(0);}
const scratch=mkdtempSync('/tmp/concierge-ledger-protocol-');writeFileSync(scratch+'/state.db','disposable mocked ledger identity');
process.env.CONCIERGE_STATE_DIR=scratch;
let changes=0;
const workers:FakeWorker[]=[];
class FakeWorker extends EventEmitter {
 role:string;workerId:string;sent:any[]=[];terminated=false;
 constructor(_path:unknown,options:any){super();this.role=options.workerData.role;this.workerId=options.workerData.workerId;workers.push(this);}
 unref(){}
 postMessage(message:any){this.sent.push(message);}
 terminate(){this.terminated=true;assert.notEqual(this.role,'checkpoint','parent has no destructive checkpoint retirement path');return Promise.resolve(0);}
}
(globalThis as any).__walProtocolWorker=FakeWorker;
writeFileSync(scratch+'/worker-shim.ts','export const Worker = globalThis.__walProtocolWorker;');
mock.module('../src/state-database',()=>({db:{inTransaction:false,query:()=>({get:()=>({n:changes,version:'3.53.2',sourceId:'fixture-controlled'})}),exec(){}}}));
const logs:any[]=[];
mock.module('../src/log',()=>({log(...args:any[]){logs.push(args);}}));
const source=resolve(import.meta.dir,'../src');
// Bun preloads the native Worker export; replace only that import boundary in a
// byte-for-byte source body, rather than pretending the built-in mock took effect.
const coordinator=readFileSync(source+'/ledger-durability.ts','utf8')
 .replace("from 'node:worker_threads'",`from '${scratch}/worker-shim.ts'`)
 .replace(/from '\.\/([^']+)'/g,(_match,name)=>`from '${source}/${name}'`);
writeFileSync(scratch+'/coordinator.ts',coordinator);
const durability=await import(scratch+'/coordinator.ts');
const {ledgerDurable}=await import('../src/ledger-durability-barrier');
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const until=async(predicate:()=>boolean,label:string)=>{
 const deadline=performance.now()+8000;
 while(!predicate()){assert.ok(performance.now()<deadline,label);await Bun.sleep(2);}
};
durability.startLedgerDurability(scratch);
const sync=workers.find(worker=>worker.role==='sync')!,old=workers.find(worker=>worker.role==='checkpoint')!;
assert.ok(sync,JSON.stringify({logs,workers:workers.length,counters:durability.ledgerDurabilityCounters(),platform:process.platform}));
sync.emit('message',{ready:true});await tick();enableLedgerAdmission();
durability.enableLedgerRecycling();
const closed=(worker:FakeWorker,retirementId:number|null)=>({kind:'ledger-closed',workerId:worker.workerId,retirementId,
 pendingStatements:0,inTransaction:false,finalized:7,nativeClosed:true,custody:'private-fixed-sql'});
if(process.argv.includes('--close-refusal-child')||process.argv.includes('--lost-close-child')){
 const pending=durability.recycleLedger();let rejected=false;void pending.catch(()=>{rejected=true;});await tick();
 let executed=false;void runLedgerSegment(()=>{executed=true;});
 old.emit('error',Error('controlled close obligation'));await until(()=>old.sent.some(m=>m.kind==='retire'),'cooperative close requested');
 if(process.argv.includes('--close-refusal-child')){
  old.emit('message',{kind:'close-refused',workerId:old.workerId,error:'private native close refused'});
  await until(()=>rejected,'failed-closed maintenance');assert.equal(ledgerAdmissionSnapshot().phase,'failed');
 }else{old.emit('exit',1);await Bun.sleep(5100);assert.equal(ledgerAdmissionSnapshot().phase,'maintenance');}
 assert.equal(executed,false);assert.equal(old.terminated,false);assert.equal(workers.filter(w=>w.role==='checkpoint').length,1);
 console.log(JSON.stringify({pass:true,case:process.argv.at(-1),held:true,forceRequested:false}));process.exit(0);
}
if(process.argv.includes('--sync-loss-child')){
 changes=1;void ledgerDurable().then(()=>console.log('UNSAFE_RECEIPT'));
 await tick();sync.emit('error',Error('disposable original sync worker loss'));
 throw Error('sync loss returned');
}
if(process.argv.includes('--violation-child')){
 const {observedDatabase}=await import('../src/storage-observation');
 const {assertLedgerSql,maintainLedger}=await import('../src/ledger-admission');
 const raw=ledgerWriteResults(new Database(':memory:'));raw.exec('CREATE TABLE t(value)');
 const canonical=observedDatabase(raw,assertLedgerSql);
 durability.activateLedgerMaintenance();
 // While serving no worker can hold the writer: a missed wrap is reported and allowed.
 canonical.query('INSERT INTO t VALUES(1)').run();
 if((raw.query('SELECT count(*) n FROM t').get() as any).n!==1)throw Error('serving-phase miss was not allowed');
 // Inside a maintenance window the same miss must end the owner before SQLite is entered.
 void maintainLedger(()=>new Promise<void>(()=>{}));await tick();
 try{canonical.query('INSERT INTO t VALUES(2)').run();}catch{console.log('UNSAFE_CAUGHT_AS_BUSINESS_RESULT');}
 throw Error('unadmitted mutation returned');
}
changes=1;let receipt1=false;
const first=ledgerDurable().then(()=>{receipt1=true;});await tick();
const id1=sync.sent.at(-1).id;
changes=2;let receipt2=false;
const second=ledgerDurable().then(()=>{receipt2=true;});await tick();
assert.equal(receipt1,false);assert.equal(receipt2,false);
sync.emit('message',{id:id1,ms:0});await first;await tick();
const id2=sync.sent.at(-1).id;assert.notEqual(id1,id2);
sync.emit('message',{id:id1,ms:0});sync.emit('message',{id:id2+999,ms:0});await tick();
assert.equal(receipt2,false,'stale and wrong sync replies cannot cover a later target');
sync.emit('message',{id:id2,ms:0});await second;
const cycle=durability.recycleLedger();await tick();
const grant=old.sent.find(message=>message.kind==='recycle');assert.ok(grant);
let effect=0;
const queued=runLedgerSegment(()=>{changes++;effect++;});
old.emit('message',{kind:'recycled',epoch:grant.epoch+1,ms:0});await tick();
assert.equal(ledgerAdmissionSnapshot().phase,'maintenance');assert.equal(effect,0);
old.emit('message',{kind:'recycled',epoch:grant.epoch,ms:0});
old.emit('error',Error('disposable checkpoint loss after possible prime'));
await until(()=>old.sent.some(message=>message.kind==='retire'),'cooperative close requested under closed admission');
assert.equal(old.terminated,false);
assert.equal(ledgerAdmissionSnapshot().phase,'maintenance');assert.equal(effect,0);
old.emit('message',{kind:'recycled',epoch:grant.epoch,ms:0});await tick();
assert.equal(effect,0,'a possible old success cannot discharge a rejected attempt');
const retirement=old.sent.find(message=>message.kind==='retire');
old.emit('message',{...closed(old,retirement.retirementId),workerId:'stale-incarnation'});
old.emit('message',{...closed(old,retirement.retirementId+1)});await tick();assert.equal(effect,0);
old.emit('message',closed(old,retirement.retirementId));await tick();
assert.equal(workers.filter(worker=>worker.role==='checkpoint').length,1,'native close alone is not own-exit completion');
old.emit('exit',0);
await until(()=>workers.filter(worker=>worker.role==='checkpoint').length===2,'existing replacement interval');
const replacement=workers.filter(worker=>worker.role==='checkpoint')[1];
await until(()=>replacement.sent.some(message=>message.kind==='recycle'),'replacement grant');
const next=replacement.sent.find(message=>message.kind==='recycle');assert.equal(next.epoch,grant.epoch);
old.emit('message',{kind:'recycled',epoch:grant.epoch,ms:0});replacement.emit('message',{kind:'recycled',epoch:grant.epoch+1,ms:0});await tick();
assert.equal(effect,0);assert.equal(ledgerAdmissionSnapshot().phase,'maintenance');
replacement.emit('message',{kind:'recycled',epoch:grant.epoch,ms:0});await cycle;await queued;
assert.equal(effect,1);assert.equal(workers.filter(worker=>worker.role==='sync').length,1);
let providerEffect=false;
const third=ledgerDurable().then(()=>{providerEffect=true;});await tick();
const id3=sync.sent.at(-1).id;
sync.emit('message',{id:id2,ms:0});await tick();assert.equal(providerEffect,false);
replacement.emit('message',{kind:'recycled',epoch:grant.epoch,ms:0});await tick();assert.equal(providerEffect,false,'maintenance completion is not receipt coverage');
sync.emit('message',{id:id3,ms:0});await third;
assert.equal(providerEffect,true);
for(const mode of ['--sync-loss-child','--violation-child','--close-refusal-child','--lost-close-child']){
 const child=Bun.spawn([process.execPath,import.meta.path,mode],{stdout:'pipe',stderr:'pipe'});
 const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 assert.equal(exit,mode==='--lost-close-child'?0:75,JSON.stringify({mode,exit,stdout,stderr}));
 if(mode==='--close-refusal-child')assert.match(stderr,/ledger_maintenance_failed_closed/,'a failed-closed epoch exits to owner recovery instead of holding writes forever');
 assert.doesNotMatch(stdout,/UNSAFE/);
 if(mode==='--sync-loss-child'||mode==='--violation-child')assert.match(stderr,mode==='--sync-loss-child'?/ledger_durability_lost/:/ledger_operation_not_admitted/);
}
console.log(JSON.stringify({fixture:'actual-recycling-and-sync-protocol',pass:true,epoch:grant.epoch,checks:['old sync cannot cover newer target','wrong sync id refused','wrong checkpoint epoch refused','no parent checkpoint terminate','native certificate plus own exit required','wrong close incarnation and retirement refused','close refusal stays failed-closed','lost close certificate stays closed','same epoch replacement','stale worker success refused','one original sync authority','queued mutation executes exactly once','checkpoint result releases no receipt','original sync loss exits before receipt','unadmitted actual SQL exits rather than caught success'],limits:'Actual coordinator and barrier with controlled Worker transport and change counter; real native storage and descriptor evidence lives in the separate composed syscall acceptance.'}));
process.exit(0);
