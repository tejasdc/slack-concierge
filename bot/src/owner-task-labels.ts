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
// [0] heartbeat, [1] running label id (0: none), [2] when it was set, [3] last ended label id,
// [4] when it ended, [5] label id the watchdog saw for the current block (negative: unmarked,
// the value is minus the last ended label), [6] block sequence. Times are ms since `origin`.
const shared=new Int32Array(new SharedArrayBuffer(32));
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

/** Record which work is running now. Cheap enough for every ledger statement and log line. */
export function markTask():void {
  if(!watchdog)return;
  const id=context.getStore();
  if(id===undefined)return;
  Atomics.store(shared,1,id);Atomics.store(shared,2,nowMs());
}

function ended(id:number):void {
  if(Atomics.load(shared,1)!==id)return;
  Atomics.store(shared,3,id);Atomics.store(shared,4,nowMs());Atomics.store(shared,1,0);
}

function runMarked<T>(id:number,work:()=>T):T {
  return context.run(id,()=>{
    if(watchdog){Atomics.store(shared,1,id);Atomics.store(shared,2,nowMs());}
    try {return work();} finally {if(watchdog)ended(id);}
  });
}

/** Run work under a name; anything it starts, including after awaits, carries the same name. */
export function withTaskLabel<T>(label:string,work:()=>T):T {
  return runMarked(labelId(label),work);
}

/** The label the watchdog saw for the latest block, for the loop-lag line written after it. */
export function lastBlockTask():{task:string;task_marked:boolean;block:number}|null {
  if(!watchdog)return null;
  const id=Atomics.load(shared,5),block=Atomics.load(shared,6);
  if(!block)return null;
  return id>0?{task:labelNames[id]??'unknown',task_marked:true,block}:{task:labelNames[-id]??'none',task_marked:false,block};
}

function creatingSite(kind:string):string {
  // Line 0 is "Error", 1 this function, 2 the timer wrapper, 3 the code that started the timer.
  const frame=(new Error().stack??'').split('\n')[3]?.trim().replace(/^at /,'')??'unknown';
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
  watchdog=new Worker(releaseWorkerPath('owner-task-watchdog-worker'),{workerData:{shared:shared.buffer,labels:labelNames,origin}});
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
  Atomics.store(shared,0,nowMs());Atomics.store(shared,1,startup);Atomics.store(shared,2,nowMs());
  // The heartbeat itself is not labelled work: it must not overwrite the label it would report.
  let started=false;
  const beat=plainInterval(()=>{
    if(!started){started=true;ended(startup);}
    Atomics.store(shared,0,nowMs());
  },50);
  beat.unref?.();
}
