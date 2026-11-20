import {AsyncLocalStorage} from 'node:async_hooks';

/**
 * Where one history read spent its time, gathered across the read worker and its history worker
 * and logged on the read's line. The 2026-11-20 nightly review found Codex and Claude window reads
 * over 300 ms at p95 while each spent under a millisecond in the ledger, and nothing recorded which
 * part of the read took the rest. Values are milliseconds unless the name says otherwise.
 */
export type HistoryReadPhases=Record<string,number|string>;
const current=new AsyncLocalStorage<HistoryReadPhases>();

export function withHistoryReadPhases<T>(phases:HistoryReadPhases,run:()=>T):T {
  return current.run(phases,run);
}
export function historyReadPhases():HistoryReadPhases|undefined {
  return current.getStore();
}
/** Adds to a phase, so one that happens several times (a listing per page) reads as its total. */
export function notePhase(name:string,ms:number) {
  const phases=current.getStore();
  if(phases)phases[name]=Math.round(((Number(phases[name])||0)+ms)*10)/10;
}
export function noteDetail(name:string,value:number|string) {
  const phases=current.getStore();
  if(phases)phases[name]=value;
}
export async function timedPhase<T>(name:string,run:()=>Promise<T>):Promise<T> {
  const started=performance.now();
  try{return await run();}finally{notePhase(name,performance.now()-started);}
}
