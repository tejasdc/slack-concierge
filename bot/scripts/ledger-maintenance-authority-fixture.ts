import assert from 'node:assert/strict';
import {mock} from 'bun:test';
import {EventEmitter} from 'node:events';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {runLedgerSegment,ledgerAdmissionSnapshot} from '../src/ledger-admission';
const root=mkdtempSync('/tmp/wal9747-maintenance-authority-');writeFileSync(root+'/state.db','private mocked ledger identity');
let changes=0,reads=0;
const workers:ControlledWorker[]=[];
class ControlledWorker extends EventEmitter{
 role:string;workerId:string;sent:any[]=[];
 constructor(_path:any,options:any){super();this.role=options.workerData.role;this.workerId=options.workerData.workerId;workers.push(this);}
 unref(){}postMessage(message:any){this.sent.push(message);}terminate(){assert.notEqual(this.role,'checkpoint');return Promise.resolve(0);}
}
(globalThis as any).__authorityWorker=ControlledWorker;
writeFileSync(root+'/worker.ts','export const Worker=globalThis.__authorityWorker;');
mock.module('../src/state-database',()=>({db:{inTransaction:false,query:()=>({get:()=>{reads++;return {n:changes,version:'3.53.2',sourceId:'controlled'};}}),exec(){}}}));
mock.module('../src/log',()=>({log(){}}));
const sourceRoot=resolve(import.meta.dir,'../src');
const source=readFileSync(sourceRoot+'/ledger-durability.ts','utf8').replace("from 'node:worker_threads'",`from '${root}/worker.ts'`).replace(/from '\.\/([^']+)'/g,(_m,name)=>`from '${sourceRoot}/${name}'`);
writeFileSync(root+'/coordinator.ts',source);const coordinator=await import(root+'/coordinator.ts');
const {ledgerDurable}=await import('../src/ledger-durability-barrier');
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const events:string[]=[];let grant!:()=>void;
const acquired=new Promise<void>(resolve=>grant=resolve);
coordinator.installLedgerMaintenanceAuthority(async()=>{events.push('acquire');await acquired;events.push('granted');return()=>{assert.equal(ledgerAdmissionSnapshot().phase,'serving');events.push('release');};});
coordinator.startLedgerDurability(root);
const sync=workers.find(w=>w.role==='sync')!,checkpoint=workers.find(w=>w.role==='checkpoint')!;
sync.emit('message',{ready:true});await tick();coordinator.activateLedgerMaintenance({recycling:false});
assert.equal(ledgerAdmissionSnapshot().enabled,true);assert.equal(checkpoint.sent.some(m=>m.kind==='enable'),false);
await assert.rejects(coordinator.recycleLedger(),/not enabled/);assert.equal(ledgerAdmissionSnapshot().epoch,0);
await runLedgerSegment(()=>{changes++;});const earlier=ledgerDurable();await tick();sync.emit('message',{id:sync.sent.at(-1).id,ms:0});await earlier;
coordinator.enableLedgerRecycling();assert.equal(checkpoint.sent.some(m=>m.kind==='enable'),true);
const before=reads;
const cycle=coordinator.recycleLedger();assert.equal(coordinator.recycleLedger(),cycle,'one pending authority/cycle obligation');
await tick();assert.deepEqual(events,['acquire']);assert.equal(reads,before);assert.equal(ledgerAdmissionSnapshot().phase,'serving');
await runLedgerSegment(()=>{changes++;});grant();await tick();
assert.equal(ledgerAdmissionSnapshot().phase,'maintenance');assert.equal(checkpoint.sent.some(m=>m.kind==='recycle'),false,'original sync proof precedes checkpoint grant');
sync.emit('message',{id:sync.sent.at(-1).id,ms:0});await tick();
const epoch=checkpoint.sent.find(m=>m.kind==='recycle').epoch;
let accepted=false;const queued=runLedgerSegment(()=>{accepted=true;changes++;});
if(process.argv.includes('--close-refusal')){
 void cycle.catch(()=>{});checkpoint.emit('error',Error('controlled private close failure'));await tick();
 checkpoint.emit('message',{kind:'close-refused',workerId:checkpoint.workerId,error:'uncertain native close'});
 await assert.rejects(cycle,/close refused/);assert.equal(ledgerAdmissionSnapshot().phase,'failed');assert.deepEqual(events,['acquire','granted']);assert.equal(accepted,false);
 console.log(JSON.stringify({pass:true,authorityRetainedAfterRefusal:true,events}));process.exit(0);
}
checkpoint.emit('message',{kind:'recycled',epoch,ms:0});await cycle;await queued;
assert.equal(accepted,true);assert.deepEqual(events,['acquire','granted','release']);
assert.throws(()=>coordinator.installLedgerMaintenanceAuthority(async()=>()=>{}),/installed once/);
const child=Bun.spawn([process.execPath,import.meta.path,'--close-refusal'],{stdout:'pipe',stderr:'pipe'});
const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);assert.equal(exit,0,stderr);
console.log(JSON.stringify({pass:true,events,checks:['lexical admission while recycling withheld','direct recycle withheld','one external acquisition before epoch/SQLite','frontier sampled only after authority grant','original durability proof before checkpoint','release only after admission resumes','failed-closed epoch retains external authority','no late authority replacement'],refusal:JSON.parse(stdout)}));process.exit(0);
