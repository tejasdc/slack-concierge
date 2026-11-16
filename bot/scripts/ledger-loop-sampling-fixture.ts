import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import ts from 'typescript';
import {enableLedgerAdmission,maintainLedger,ledgerCallback,ledgerAdmissionSnapshot} from '../src/ledger-admission';

const source=readFileSync(join(import.meta.dir,'../src/session-owner.ts'),'utf8');
const tree=ts.createSourceFile('session-owner.ts',source,ts.ScriptTarget.Latest,true);
const sampler=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='startOwnerLoopMonitor');
assert.ok(sampler);
const current=sampler.getText(tree);
const held=readFileSync(join(import.meta.dir,'ledger-held-loop-sampler-2026-11-15.source.txt'),'utf8');
assert.equal(createHash('sha256').update(held).digest('hex'),'dacdae15daba8e5e7a6993c8544e4e0b3232a3a15b2702641f97d37308c6f367');
// The retained source is the actual held-WAL draft sampler, not a proposed
// alternative implementation. Both schedules use real timers and the real gate.
const run=async(body:string)=>{
 let samples=0,heartbeats=0,release=()=>{},ticks=0,clock=0,finishTicks=()=>{};
 const ticked=new Promise<void>(resolve=>finishTicks=resolve);
 const stalls:number[]=[];
 const consumptions:Promise<unknown>[]=[];
 const compiled=ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.None}}).outputText;
 const monitor=new Function('ledgerCallback','takeStorageInterval','noteOwnerStall','performance','setInterval',
  `let ownerLoopMonitor=null,previousTickAt=0;const ownerRequestsInFlight=new Map();
   const startOwnerResponsivenessWatch=()=>{},startStorageIntervals=()=>{},taskClockMs=()=>performance.now(),freshBlockTask=()=>({}),log=()=>{};
   ${compiled};return{start:startOwnerLoopMonitor,stop:()=>clearInterval(ownerLoopMonitor)};`)
  (ledgerCallback,()=>{samples++;return{calls:0};},(lag:number)=>stalls.push(lag),{now:()=>clock},(sample:()=>unknown,interval:number)=>{
   assert.equal(interval,250,'production sampling cadence is unchanged');
   const timer=setInterval(()=>{if(ticks>=3)return;clock+=250;ticks++;const consumed=sample();if(consumed&&typeof (consumed as any).then==='function')consumptions.push(Promise.resolve(consumed));if(ticks===3)finishTicks();},1);
   return timer;
  });
 const maintenance=maintainLedger(()=>new Promise<void>(resolve=>release=resolve));await Bun.sleep(0);
 const pulse=setInterval(()=>heartbeats++,1);
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>Response.json({live:true,phase:ledgerAdmissionSnapshot().phase})});
 try{
  monitor.start();await ticked;
  const reply=await (await fetch(`http://127.0.0.1:${server.port}/`)).json() as any;
  assert.equal(reply.live,true);assert.equal(reply.phase,'maintenance');assert.ok(heartbeats>0,'native loop advances while maintenance is held');
  const during=samples;
  monitor.stop();release();await maintenance;await Promise.all(consumptions);
  return{samplesDuringMaintenance:during,samplesAfterResume:samples,stalls,heartbeats};
 }finally{monitor.stop();clearInterval(pulse);server.stop(true);release();await maintenance;}
};
enableLedgerAdmission();
const old=await run(held);
assert.equal(old.samplesDuringMaintenance,0);
assert.ok(old.stalls.some(lag=>lag>=200),'held draft manufactures admission wait as loop lag');
const repaired=await run(current);
assert.ok(repaired.samplesDuringMaintenance>=2,'actual sampler clock keeps advancing behind closed business admission');
assert.deepEqual(repaired.stalls,[],'admission wait alone creates no owner stall');
const commandSource=readFileSync(join(import.meta.dir,'../src/index.ts'),'utf8');
const commandTree=ts.createSourceFile('index.ts',commandSource,ts.ScriptTarget.Latest,true);
let command:ts.FunctionDeclaration|undefined;
const findCommand=(node:ts.Node)=>{if(ts.isFunctionDeclaration(node)&&node.name?.text==='runHostCommand')command=node;ts.forEachChild(node,findCommand);};findCommand(commandTree);
assert.ok(command);
const commandBody=ts.transpileModule(command.getText(commandTree),{compilerOptions:{target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.None}}).outputText;
let hostChild:ChildProcess|undefined,hostExited:Promise<void>=Promise.resolve();
const trackedSpawn=(...args:any[])=>{hostChild=(spawn as any)(...args);hostExited=new Promise<void>((resolve,reject)=>{hostChild!.once('error',reject);hostChild!.once('close',()=>resolve());});return hostChild;};
const runHostCommand=new Function('spawn','ledgerCallback',commandBody+';return runHostCommand;')(trackedSpawn,ledgerCallback);
let reopen=()=>{},deadline:ReturnType<typeof setTimeout>|undefined;
const commandMaintenance=maintainLedger(()=>new Promise<void>(resolve=>reopen=resolve));await Bun.sleep(0);
try{
 const result=await Promise.race([runHostCommand({command:'exec /bin/sleep 60',cwd:import.meta.dir,timeoutMs:10}),
  new Promise<never>((_resolve,reject)=>deadline=setTimeout(()=>reject(Error('Host command deadline queued behind admission')),2000))]);
 assert.equal(result.timedOut,true);assert.equal(ledgerAdmissionSnapshot().phase,'maintenance');
}finally{if(deadline)clearTimeout(deadline);reopen();await commandMaintenance;if(hostChild&&hostChild.exitCode===null&&hostChild.signalCode===null)hostChild.kill('SIGKILL');await hostExited;}
console.log(JSON.stringify({fixture:'ledger-loop-sampling',old,repaired,actualHostCommandDeadlineLive:true,
 boundary:'actual private sampler source and native timer delivery; controlled monotonic clock/cadence adapter avoids a host-load latency assertion; storage/reporting collaborators are memory-only; no full owner/provider lifecycle claim'}));
