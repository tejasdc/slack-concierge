import {AsyncLocalStorage} from 'node:async_hooks';
import {Worker} from 'node:worker_threads';
import {releaseWorkerPath} from './release-worker';

/**
 * Names the owner's work so a block of its one event loop can be attributed while it happens.
 *
 * On 2026-11-04 the owner's loop was held 2,040 ms by pure JavaScript (22:21Z) with no request in
 * flight, and memory jumped to 1.9 GB; the loop-lag record could only say that something had held
 * it, and JSC's sampling profiler stalls this loop for seconds when it starts (PR #484, closed). So
 * the work carries its own name: every timer callback, owner request and the work they start runs
 * under a label that follows it through awaits (AsyncLocalStorage). The main thread stores the
 * running label in shared memory when a timer callback or labelled request starts, and again at
 * every ledger statement, log line and JSON parse or stringify (where the label is right even inside awaited work); when
 * the synchronous part of a callback returns it clears the label and remembers which one ended. A
 * block in awaited work that passed no marking point is therefore reported as unmarked, with the
 * label that ended last and how long before the block: never as whichever other timer ran
 * meanwhile (review of PR #489). A watchdog thread reads that memory while the main thread is
 * blocked. Clock: monotonic milliseconds since the owner started, shared with the worker.
 */
const context=new AsyncLocalStorage<number>();
// Labels: [0] running label id (0: none), [1] last ended label id, [2] label id the watchdog saw
// for the latest block (negative: unmarked, minus the last ended label), [3] block sequence.
// Times, in ms since `origin` as 64-bit floats so they never wrap: [0] heartbeat, [1] running label
// set, [2] last label ended, [3] latest block started.
const shared=new Int32Array(new SharedArrayBuffer(16)),times=new Float64Array(new SharedArrayBuffer(32));
const origin=performance.timeOrigin+performance.now();
const labelIds=new Map<string,number>(),labelNames:string[]=['none'];
let watchdog:Worker|null=null;
const nowMs=()=>Math.round(performance.timeOrigin+performance.now()-origin);

function labelId(label:string):number {
  let id=labelIds.get(label);
  if(id===undefined){
    id=labelNames.push(label)-1;labelIds.set(label,id);
    watchdog?.postMessage({id,label});
  }
  return id;
}

function setRunning(id:number):void {Atomics.store(shared,0,id);times[1]=nowMs();}
function ended(id:number,restore:number):void {
  if(Atomics.load(shared,0)!==id)return;
  Atomics.store(shared,1,id);times[2]=nowMs();Atomics.store(shared,0,restore);
}

let clearQueued=false;
/**
 * Record which work is running now: at ledger statements, log lines and JSON calls. Inside
 * awaited work there is no callback to clear the label when that piece of work finishes, so a
 * microtask does: it runs once the current continuation's synchronous part is over, before any
 * unrelated callback can run (second review of PR #489: a finished request's label otherwise
 * stayed "running" into the next unrelated block).
 */
export function markTask():void {
  if(!watchdog)return;
  const id=context.getStore();
  if(id===undefined||Atomics.load(shared,0)===id)return;
  setRunning(id);
  if(clearQueued)return;
  clearQueued=true;
  queueMicrotask(()=>{clearQueued=false;ended(id,0);});
}

function runMarked<T>(id:number,work:()=>T):T {
  return context.run(id,()=>{
    if(!watchdog)return work();
    const outer=Atomics.load(shared,0);
    setRunning(id);
    try {return work();} finally {ended(id,outer);if(outer)times[1]=nowMs();}
  });
}

/** Run work under a name; anything it starts, including after awaits, carries the same name. */
export function withTaskLabel<T>(label:string,work:()=>T):T {
  return runMarked(labelId(label),work);
}

/** The label the watchdog saw for the latest block, for the loop-lag line written after it. */
export function lastBlockTask(sinceMs:number):{task:string;task_marked:boolean;block:number}|null {
  if(!watchdog)return null;
  const id=Atomics.load(shared,2),block=Atomics.load(shared,3);
  // Only a block that started after `sinceMs` (the previous lag tick) belongs to this lag line.
  if(!block||times[3]<sinceMs-60)return null; // a block starts at the last heartbeat, up to 50 ms before it began
  return id>0?{task:labelNames[id]??'unknown',task_marked:true,block}:{task:labelNames[-id]??'none',task_marked:false,block};
}

/** The shared clock, for the lag monitor's tick times. */
export function taskClockMs():number {return nowMs();}

function creatingSite(kind:string):string {
  // Line 0 is "Error", 1 this function, 2 the timer wrapper, 3 on the code that started the timer;
  // built-in frames (a Promise constructor around the timer) name nothing useful, so skip them.
  const frames=(new Error().stack??'').split('\n').slice(3).map(line=>line.trim().replace(/^at /,''));
  const frame=frames.find(line=>!/native|^new Promise|^Promise/.test(line))??frames[0]??'unknown';
  const name=frame.split(' (')[0]!,file=(frame.match(/\(([^)]+)\)/)?.[1]??frame).split('/').pop()!.replace(/:\d+$/,'');
  return `${kind} ${name} ${file}`.slice(0,160);
}

function wrapTimer<F extends (...args:any[])=>any>(kind:string,original:F):F {
  const wrapped=function(this:unknown,callback:unknown,...rest:unknown[]) {
    if(typeof callback!=='function')return original.call(this,callback,...rest);
    const id=context.getStore()??labelId(creatingSite(kind));
    const labelled=function(this:unknown,...args:unknown[]) {return runMarked(id,()=>(callback as Function).apply(this,args));};
    return original.call(this,labelled,...rest);
  };
  // Keep the originals' own properties (promisify hooks and the like) on the wrappers.
  for(const key of Reflect.ownKeys(original))if(!(key in wrapped))Object.defineProperty(wrapped,key,Object.getOwnPropertyDescriptor(original,key)!);
  return wrapped as unknown as F;
}

/** Owner process only: label every timer, start the heartbeat and the watchdog thread. */
export function installOwnerTaskLabels():void {
  if(watchdog)return;
  watchdog=new Worker(releaseWorkerPath('owner-task-watchdog-worker'),{workerData:{shared:shared.buffer,times:times.buffer,labels:labelNames,origin}});
  watchdog.unref();
  const plainInterval=globalThis.setInterval;
  globalThis.setTimeout=wrapTimer('timeout',globalThis.setTimeout);
  globalThis.setInterval=wrapTimer('interval',globalThis.setInterval);
  globalThis.setImmediate=wrapTimer('immediate',globalThis.setImmediate);
  // JSON work is where large pure-JavaScript blocks spend their time (the 2026-11-04 memory jumps
  // grew strings and heap together), and inside awaited work the label it reads is the right one.
  const parse=JSON.parse,stringify=JSON.stringify;
  JSON.parse=function(this:unknown,...args:Parameters<typeof parse>){markTask();return parse.apply(this,args);} as typeof parse;
  JSON.stringify=function(this:unknown,...args:Parameters<typeof stringify>){markTask();return stringify.apply(this,args);} as typeof stringify;
  // Module loading that follows this install is startup, not an unexplained block.
  const startup=labelId('startup');
  times[0]=nowMs();setRunning(startup);
  // The heartbeat itself is not labelled work: it must not overwrite the label it would report.
  let started=false;
  const beat=plainInterval(()=>{
    if(!started){started=true;ended(startup,0);}
    times[0]=nowMs();
  },50);
  beat.unref?.();
}
