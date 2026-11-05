import {AsyncLocalStorage} from 'node:async_hooks';
import {Worker} from 'node:worker_threads';
import {releaseWorkerPath} from './release-worker';

/**
 * Names the owner's work so a block of its one event loop can be attributed while it happens.
 *
 * On 2026-11-04 the owner's loop was held 2,040 ms by pure JavaScript (22:21Z) with no request in
 * flight, and memory jumped to 1.9 GB; the loop-lag record could only say that something had held
 * it, and JSC's sampling profiler stalls this loop for seconds when it starts (PR #484, closed). So
 * the work carries its own name instead: every timer callback, owner request and the work they
 * start runs under a label that follows it through awaits (AsyncLocalStorage), and the main thread
 * writes the current label and a heartbeat into shared memory at points it already passes: timer
 * callbacks, ledger statements and log lines. A watchdog thread reads that memory, so it can name
 * the label and record memory while the main thread is still blocked. Writing a label is one
 * Atomics store; a label is captured from the creating stack only for a timer started outside any
 * labelled work.
 */
const context=new AsyncLocalStorage<number>();
const shared=new Int32Array(new SharedArrayBuffer(16)); // [heartbeat ms mod 2^31, label id, marked at ms mod 2^31]
const labelIds=new Map<string,number>(),labelNames:string[]=['idle'];
let watchdog:Worker|null=null;
const nowMs=()=>Date.now()%2**31;

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
  Atomics.store(shared,1,context.getStore()??0);
  Atomics.store(shared,2,nowMs());
}

/** Run work under a name; anything it starts, including after awaits, carries the same name. */
export function withTaskLabel<T>(label:string,work:()=>T):T {
  return context.run(labelId(label),()=>{markTask();return work();});
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
    const inherited=context.getStore();
    const id=inherited??labelId(creatingSite(kind));
    const labelled=function(this:unknown,...args:unknown[]) {
      // The label stays set after the callback returns: work it awaits resumes without passing any
      // marking point, and a block there must still name it. The watchdog reports how long before
      // the block the label was set, so a stale label shows as stale.
      return context.run(id,()=>{markTask();return (callback as Function).apply(this,args);});
    };
    return original.call(this,labelled,...rest);
  };
  // Keep the originals' own properties (promisify hooks and the like) on the wrappers.
  for(const key of Reflect.ownKeys(original))if(!(key in wrapped))Object.defineProperty(wrapped,key,Object.getOwnPropertyDescriptor(original,key)!);
  return wrapped as unknown as F;
}

/** Owner process only: label every timer, start the heartbeat and the watchdog thread. */
export function installOwnerTaskLabels():void {
  if(watchdog)return;
  watchdog=new Worker(releaseWorkerPath('owner-task-watchdog-worker'),{workerData:{shared:shared.buffer,labels:labelNames}});
  watchdog.unref();
  const plainInterval=globalThis.setInterval;
  globalThis.setTimeout=wrapTimer('timeout',globalThis.setTimeout);
  globalThis.setInterval=wrapTimer('interval',globalThis.setInterval);
  globalThis.setImmediate=wrapTimer('immediate',globalThis.setImmediate);
  Atomics.store(shared,0,nowMs());
  // The heartbeat itself is not labelled work: it must not overwrite the label it would report.
  const beat=plainInterval(()=>{Atomics.store(shared,0,nowMs());},50);
  beat.unref?.();
}
