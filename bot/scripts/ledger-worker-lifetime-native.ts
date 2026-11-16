import {strict as assert} from 'node:assert';
import {Database} from 'bun:sqlite';
import {Worker as NativeWorker} from 'node:worker_threads';
import {mock} from 'bun:test';
import {existsSync,writeFileSync,readFileSync,openSync,readSync,fstatSync,statSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {runLedgerSegment,ledgerAdmissionSnapshot} from '../src/ledger-admission';
import {ledgerWriteResults} from '../src/ledger-write-results';
const root=process.env.LEDGER_LATCH_ROOT!,mode=process.env.LEDGER_NATIVE_MODE!;
const raw=ledgerWriteResults(new Database(root+'/state.db'));raw.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA wal_autocheckpoint=0;CREATE TABLE application(value);INSERT INTO application VALUES(1)');
const fd=openSync(root+'/state.db-wal','r'),identity=fstatSync(fd);
let checkpointCount=0,forceCalls=0,queuedExecutions=0,pumpEntries=0;
const workers:ObservedWorker[]=[],messages:any[]=[];
class ObservedWorker extends NativeWorker{
 role:string;workerId:string;ended=false;
 constructor(_path:any,options:any){
  const role=options.workerData.role,isFirst=role==='checkpoint'&&checkpointCount++===0;
  super(new URL('./ledger-worker-lifetime-fault-worker.ts',import.meta.url),{workerData:{...options.workerData,fixtureRoot:root,fixtureMode:isFirst?mode:'healthy'}});
  this.role=role;this.workerId=options.workerData.workerId;workers.push(this);
  this.on('exit',()=>{this.ended=true;});
 }
 emit(event:any,...args:any[]):boolean{
  if(event==='message'){
   const message=args[0];messages.push({workerId:this.workerId,role:this.role,message,at:Date.now()});
   writeFileSync(root+'/messages.json',JSON.stringify(messages,null,2));
   if(message.kind==='ledger-closed')assert.ok(existsSync(root+'/'+this.workerId+'.native-close'),'native SQLite deallocation precedes certificate');
   if(mode==='lost-success'&&this.role==='checkpoint'&&this===workers.find(w=>w.role==='checkpoint')&&message.kind==='recycled'){
    writeFileSync(root+'/success.reply-lost',JSON.stringify(message));
    queueMicrotask(()=>this.emit('error',Error('controlled lost success reply after commit')));return true;
   }
  }
  return super.emit(event,...args);
 }
 terminate():Promise<number>{if(this.role==='checkpoint'){forceCalls++;writeFileSync(root+'/UNSAFE.force','attached checkpoint force attempted');throw Error('forbidden destructive checkpoint termination');}return super.terminate();}
}
(globalThis as any).__lifetimeWorker=ObservedWorker;
writeFileSync(root+'/worker-shim.ts','export const Worker=globalThis.__lifetimeWorker;');
const db=new Proxy(raw,{get(target,property){if(property==='inTransaction'){pumpEntries++;writeFileSync(root+'/pump.entries',String(pumpEntries));}const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});
mock.module('../src/state-database',()=>({db}));mock.module('../src/log',()=>({log(){}}));
const sourceRoot=resolve(import.meta.dir,'../src');
const original=readFileSync(sourceRoot+'/ledger-durability.ts','utf8');
const source=original.replace("from 'node:worker_threads'",`from '${root}/worker-shim.ts'`).replace(/from '\.\/([^']+)'/g,(_m,name)=>`from '${sourceRoot}/${name}'`);
writeFileSync(root+'/coordinator-body.ts',source);
const durability=await import(root+'/coordinator-body.ts');
const {ledgerDurable}=await import('../src/ledger-durability-barrier');
durability.startLedgerDurability(root);
while(durability.ledgerDurabilityCounters().mode!=='deferred')await Bun.sleep(2);
durability.activateLedgerMaintenance();
const header=()=>{const data=Buffer.alloc(32);assert.equal(readSync(fd,data,0,32,0),32);return data.subarray(12,24).toString('hex');};
const originalGeneration=header();
let cycle:Promise<void>|null=null,cycleError:string|null=null;
const begin=()=>{
 cycle=durability.recycleLedger();
 void cycle.then(()=>writeFileSync(root+'/cycle.complete',JSON.stringify({gate:ledgerAdmissionSnapshot(),generation:header()})),error=>{cycleError=String(error);writeFileSync(root+'/cycle.failed',cycleError);});
 void runLedgerSegment(()=>{queuedExecutions++;raw.exec('UPDATE application SET value=value+1');});
};
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
 const path=new URL(request.url).pathname;
 if(path==='/ping')return Response.json({ok:true,gate:ledgerAdmissionSnapshot(),forceCalls,pumpEntries,queuedExecutions,counters:durability.ledgerDurabilityCounters()});
 if(path==='/cycle'){begin();return Response.json({begun:true});}
 if(path==='/queue'){void runLedgerSegment(()=>{queuedExecutions++;raw.exec('UPDATE application SET value=value+1');});return Response.json({retained:true});}
 if(path==='/fault'){
  const worker=workers.find(w=>w.role==='checkpoint')!;
  if(['own-error','own-exit','uncaught-close-refusal','own-exit-close-refusal'].includes(mode))worker.postMessage({kind:mode.startsWith('own-exit')?'fixture-own-exit':'fixture-own-error'});
  else worker.emit('error',Error('controlled requested checkpoint retirement while attached'));
  return Response.json({forceCalls,gate:ledgerAdmissionSnapshot()});
 }
 if(path==='/next'){
  assert.equal(cycleError,null);if(cycle)await cycle;
  await runLedgerSegment(()=>raw.exec('UPDATE application SET value=value+1'));await ledgerDurable();
  const before=header();await durability.recycleLedger();const after=header();assert.notEqual(after,before);assert.equal(forceCalls,0);
  assert.equal(fstatSync(fd).ino,identity.ino);assert.equal(statSync(root+'/state.db-wal').ino,identity.ino);assert.equal(fstatSync(fd).nlink,1);
  writeFileSync(root+'/next.complete',JSON.stringify({before,after,originalGeneration,forceCalls,queuedExecutions,syncWorkers:workers.filter(w=>w.role==='sync').length,
   certificates:messages.filter(r=>r.message.kind==='ledger-closed'),allocation:{bytes:statSync(root+'/state.db-wal').size,allocated:statSync(root+'/state.db-wal').blocks*512}}));
  return Response.json({ok:true});
 }
 if(path==='/stop'){
  // Owned fixture cleanup only: disconnect coordinator event consumers, then cooperatively
  // close every remaining private connection, including the intentionally refused one.
  for(const worker of workers.filter(w=>w.role==='checkpoint'&&!w.ended)){
   worker.removeAllListeners();const closed=new Promise<void>((resolve,reject)=>{worker.on('message',m=>{if(m.kind==='ledger-closed'){assert.ok(existsSync(root+'/'+worker.workerId+'.native-close'));resolve();}if(m.kind==='close-refused')reject(Error(m.error));});});
   const ended=new Promise<void>(resolve=>worker.once('exit',()=>resolve()));worker.postMessage({kind:'retire',retirementId:999999});await closed;await ended;worker.ended=true;
  }
  for(const worker of workers.filter(w=>w.role==='sync'&&!w.ended)){worker.removeAllListeners();await worker.terminate();}
  writeFileSync(root+'/cleanup.json',JSON.stringify({forceCalls,allCheckpointWorkersExited:workers.filter(w=>w.role==='checkpoint').every(w=>w.ended||w.threadId===-1),gate:ledgerAdmissionSnapshot()}));
  setImmediate(()=>{closeSync(fd);raw.close(true);server.stop(true);process.exit(0);});return Response.json({stopping:true});
 }
 return new Response('missing',{status:404});
}});
writeFileSync(root+'/ready.json',JSON.stringify({port:server.port,pid:process.pid,mode,workerId:workers.find(w=>w.role==='checkpoint')!.workerId,bun:Bun.version,revision:Bun.revision}));
