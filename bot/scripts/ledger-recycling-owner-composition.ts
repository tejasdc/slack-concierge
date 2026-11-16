import assert from 'node:assert/strict';
import {Database} from 'bun:sqlite';
import {existsSync,writeFileSync,readFileSync,openSync,fstatSync,statSync,mkdtempSync,closeSync} from 'node:fs';
import {runLedgerSegment,ledgerAdmissionSnapshot} from '../src/ledger-admission';
import {protectedOwnerReceipt} from '../src/protected-owner-receipt';
import {ledgerDurable} from '../src/ledger-durability-barrier';
if(!process.env.LEDGER_LATCH_ROOT){
 const root=mkdtempSync('/tmp/wal9747-owner-composition-');
 const compile=Bun.spawn(['cc','-shared','-fPIC','-O2','-pthread',import.meta.dir+'/ledger-recycling-sync-latch.c','-ldl','-o',root+'/latch.so'],{stdout:'pipe',stderr:'pipe'});
 const compilerTimer=setTimeout(()=>compile.kill('SIGKILL'),10000);
 const [compiled,out,err]=await Promise.all([compile.exited,new Response(compile.stdout).text(),new Response(compile.stderr).text()]);
 clearTimeout(compilerTimer);writeFileSync(root+'/compile.txt',out+err);assert.equal(compiled,0,err);
 const child=Bun.spawn([process.execPath,import.meta.path],{env:{...process.env,LEDGER_LATCH_ROOT:root,LEDGER_LATCH_DB:root+'/state.db',LD_PRELOAD:root+'/latch.so'},stdout:'pipe',stderr:'pipe'});
 let expired=false;
 const release=()=>{for(const phase of ['checkpoint','header','receipt1','receipt2'])writeFileSync(root+'/'+phase+'.release','1');};
 const deadline=setTimeout(()=>{expired=true;release();child.kill('SIGKILL');},90000);
 try{
  const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  writeFileSync(root+'/stdout.txt',stdout);writeFileSync(root+'/stderr.txt',stderr);
  console.log(stdout.trim());console.log(JSON.stringify({artifact:root,exit,expired}));
  assert.equal(expired,false,'owned acceptance deadline');assert.equal(exit,0,stderr);
 }finally{clearTimeout(deadline);release();if(child.exitCode===null)child.kill('SIGKILL');await child.exited;}
 process.exit(0);
}
const scratch=process.env.LEDGER_LATCH_ROOT!;
assert.ok(scratch?.startsWith('/tmp/'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=scratch+'/capture';
let server:{stop(closeActiveConnections?:boolean):Promise<void>}|undefined;
let originalDescriptor:number|undefined;
try {
const [{SessionOwner},{db},{requestApiHandler,supervisorControlResponse},durability]=await Promise.all([
 import('../src/session-owner'),import('../src/state'),import('../src/routed-request-api'),import('../src/ledger-durability')]);
db.exec('CREATE TABLE native_fence(value);INSERT INTO native_fence VALUES(0)');
const owner=new SessionOwner({available:()=>true,wake:()=>{},stop:async()=>false,steer:()=>false},scratch);
const handle=requestApiHandler(null,null,undefined,owner);
server=Bun.serve({unix:scratch+'/owner.sock',fetch:request=>supervisorControlResponse(request)??protectedOwnerReceipt(()=>handle(request))});
const bounded=async<T>(operation:Promise<T>,label:string):Promise<T>=>{
 let timeout:ReturnType<typeof setTimeout>;
 try{return await Promise.race([operation,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(Error(`timeout ${label}`)),15000);})]);}
 finally{clearTimeout(timeout!);}
};
const until=async(predicate:()=>boolean,label:string)=>{await bounded((async()=>{while(!predicate())await Bun.sleep(2);})(),label);};
const send=(action:string,text:string,project=false)=>fetch('http://owner/sessions/v1/sessions',{unix:scratch+'/owner.sock',method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientActionId:action,provider:'codex',purpose:'chat',...(project?{project:'bounded'}:{}),firstInput:{text}})} as any);
durability.startLedgerDurability(scratch);
await until(()=>durability.ledgerDurabilityCounters().mode==='deferred','original descriptor readiness');
durability.activateLedgerMaintenance();
const baseline=await send(crypto.randomUUID(),'baseline durable input');assert.equal(baseline.status,202);
await baseline.json();
const earlierSyncs=durability.ledgerDurabilityCounters().syncs;
const fd=originalDescriptor=openSync(scratch+'/state.db-wal','r'),identity=fstatSync(fd);
const reader=new Database(scratch+'/state.db',{readonly:true});reader.exec('BEGIN');
const oldCount=(reader.query('SELECT count(*) n FROM sessions').get() as any).n;
let ready!:()=>void,external!:()=>void;
const entered=new Promise<void>(resolve=>{ready=resolve;});
const project=new Promise<void>(resolve=>{external=resolve;});
(owner as any).locateProject=async()=>{ready();await project;return {name:null,path:scratch,cwd:scratch,runner:null};};
const action=crypto.randomUUID();let returned=false;
const pending=send(action,'exact original deferred input',true).then(result=>{returned=true;return result;});
await bounded(entered,'project preparation');
const frontier=(db.query('SELECT total_changes() n').get() as any).n;
writeFileSync(scratch+'/armed','1');
const maintenance=durability.recycleLedger();
await until(()=>ledgerAdmissionSnapshot().phase==='maintenance','closed admission');
external();
const controls:any[]=[];
const ping=async(phase:string)=>{
 const response=await bounded(fetch('http://owner/supervisor/ping',{unix:scratch+'/owner.sock'} as any),phase);
 assert.equal(response.status,200);assert.equal((await response.json() as any).ok,true);
 assert.equal(returned,false);assert.equal((db.query('SELECT total_changes() n').get() as any).n,frontier);
 controls.push({phase,reply:true,frontier});
};
await ping('finite old reader');
assert.equal((reader.query('SELECT count(*) n FROM sessions').get() as any).n,oldCount);
reader.exec('COMMIT');reader.close();
await until(()=>existsSync(scratch+'/checkpoint.entered'),'checkpoint main fsync');
await ping('checkpoint main fsync held');
const duringCheckpoint=new Database(scratch+'/state.db',{readonly:true});
assert.equal((duringCheckpoint.query('SELECT count(*) n FROM sessions').get() as any).n,oldCount);duringCheckpoint.close();
writeFileSync(scratch+'/checkpoint.release','1');
await until(()=>existsSync(scratch+'/header.entered'),'worker primer header fsync');
await ping('worker primer header fsync held');
const duringPrime=new Database(scratch+'/state.db',{readonly:true});
assert.equal((duringPrime.query('SELECT count(*) n FROM sessions').get() as any).n,oldCount);duringPrime.close();
writeFileSync(scratch+'/hold-receipt','1');
writeFileSync(scratch+'/header.release','1');
await bounded(maintenance,'successful recycling');
await until(()=>existsSync(scratch+'/receipt1.entered'),'resumed input original-descriptor sync');
assert.equal(returned,false,'mutation response remains held before its original-descriptor sync');
let providerEffect=false;
const effect=runLedgerSegment(()=>db.query('UPDATE native_fence SET value=value+1').run())
 .then(()=>ledgerDurable({kind:'provider_input',id:action})).then(()=>{providerEffect=true;});
await new Promise<void>(resolve=>setImmediate(resolve));
assert.equal(providerEffect,false);assert.equal(returned,false);
const syncPing=await bounded(fetch('http://owner/supervisor/ping',{unix:scratch+'/owner.sock'} as any),'original descriptor sync held');
assert.equal(syncPing.status,200);
writeFileSync(scratch+'/receipt1.release','1');
await until(()=>existsSync(scratch+'/receipt2.entered'),'later mutation separate original-descriptor sync');
const response=await bounded(pending,'deferred durable response');assert.equal(response.status,202);await response.json();
assert.equal(providerEffect,false,'the earlier sync cannot release the later provider effect');
writeFileSync(scratch+'/receipt2.release','1');await bounded(effect,'later provider effect durable fence');
assert.equal(providerEffect,true);
assert.ok(durability.ledgerDurabilityCounters().syncs>earlierSyncs,'earlier proof cannot cover later application mutation');
const row=db.query('SELECT payload_json FROM session_inputs WHERE action_id=?').get(action) as any;
assert.equal(JSON.parse(row.payload_json).firstInput.text,'exact original deferred input');
assert.equal((db.query('SELECT count(*) n FROM session_inputs WHERE action_id=?').get(action) as any).n,1);
const syncs=readFileSync(scratch+'/sync.log','utf8').trim().split('\n');
assert.ok(syncs.length>=2);assert.ok(syncs.every(line=>!line.includes(`tid=${process.pid} `)),'resumed owner performs no WAL header fsync');
const checkpoint=readFileSync(scratch+'/checkpoint.entered','utf8'),header=readFileSync(scratch+'/header.entered','utf8');
assert.match(checkpoint,/checkpoint-main-fsync/);assert.match(header,/primer-header-fsync/);
const receipt1=readFileSync(scratch+'/receipt1.entered','utf8'),receipt2=readFileSync(scratch+'/receipt2.entered','utf8');
assert.match(receipt1,/original-descriptor-fdatasync/);assert.match(receipt2,/original-descriptor-fdatasync/);
assert.equal(/tid=(\d+)/.exec(receipt1)![1],/tid=(\d+)/.exec(receipt2)![1]);
assert.notEqual(/tid=(\d+)/.exec(receipt1)![1],/tid=(\d+)/.exec(header)![1]);
assert.equal(fstatSync(fd).ino,identity.ino);assert.equal(statSync(scratch+'/state.db-wal').ino,identity.ino);assert.equal(fstatSync(fd).nlink,1);
const fresh=new Database(scratch+'/state.db',{readonly:true});assert.equal((fresh.query('SELECT count(*) n FROM sessions').get() as any).n,oldCount+1);fresh.close();
const allocation=statSync(scratch+'/state.db-wal');
console.log(JSON.stringify({pass:true,bun:Bun.version,sqlite:db.query('SELECT sqlite_version() v').get(),controls,checkpoint,header,receipt1,receipt2,syncs,earlierSyncs,laterSyncs:durability.ledgerDurabilityCounters().syncs,receiptHeldBeforeSync:true,earlierSyncCannotReleaseLaterEffect:true,originalDescriptor:true,walBytes:allocation.size,walAllocatedBytes:allocation.blocks*512,limits:'Actual source owner route, receipt fence, original sync/checkpoint workers and canonical SQL facade; synthetic local client, project preparation and post-fence provider effect. No physical device, production or power-loss proof.'},null,2));
} finally {
  // Release every owned native latch even when an assertion fails; no worker
  // native sync may outlive this acceptance waiting on a forgotten file.
  for(const phase of ['checkpoint','header','receipt1','receipt2'])writeFileSync(scratch+'/'+phase+'.release','1');
  await server?.stop(true);
  if(originalDescriptor!==undefined)closeSync(originalDescriptor);
}
process.exit(0);
