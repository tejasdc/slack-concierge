import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {log} from './log';

export type UsagePeriod='today'|'week';

/**
 * Who used each account, computed in the background and answered from the latest result.
 *
 * It used to be computed when the Accounts page asked. On 2026-10-08 the owner was stalling on
 * something else, the answer took 50 seconds, the page gave up at 30 and told Tejas "the session
 * owner did not answer". Now the usage watch refreshes it at most every few minutes in a separate
 * process, and a read returns what is already there with the time it was computed; only the very
 * first read after a start waits for one scan. No agent is involved at any point.
 */
const REFRESH_EVERY_MS=5*60_000;
let latest:{computedAt:string;both:Record<UsagePeriod,unknown>}|null=null;
let running:Promise<void>|null=null;

function scan():Promise<void>{
  if(running)return running;
  const started=Date.now();
  running=new Promise<void>((resolve,reject)=>{
    const installed=join(import.meta.dir,'../../control/bot/scripts/usage-breakdown-reader.js');
    const reader=existsSync(installed)?installed:join(import.meta.dir,'../scripts/usage-breakdown-reader.ts');
    const child=spawn(process.execPath,[reader,'--both'],{stdio:['ignore','pipe','pipe']});
    let output='',error='';
    child.stdout.setEncoding('utf8').on('data',(chunk:string)=>{output+=chunk;});
    child.stderr.setEncoding('utf8').on('data',(chunk:string)=>{error+=chunk.slice(0,2000);});
    child.on('error',reject);
    child.on('close',code=>{
      if(code!==0)return reject(new Error(error||`Usage scan exited ${code}`));
      try{latest={computedAt:new Date().toISOString(),both:JSON.parse(output)};resolve();}catch(cause){reject(cause);}
    });
  }).then(()=>log('info','usage_breakdown_refreshed',{duration_ms:Date.now()-started}),
    error=>{log('error','usage_breakdown_refresh_failed',{duration_ms:Date.now()-started,error:String(error).slice(0,500)});throw error;})
    .finally(()=>{running=null;});
  return running;
}

/** Called on every usage reading; starts a background scan when the last one is older than five minutes. */
export function refreshUsageBreakdownIfStale():void{
  if(latest&&Date.now()-Date.parse(latest.computedAt)<REFRESH_EVERY_MS)return;
  void scan().catch(()=>{});
}

export async function usageBreakdown(period:UsagePeriod):Promise<unknown>{
  if(!latest)await scan();
  else refreshUsageBreakdownIfStale();
  const result=latest!.both[period] as Record<string,unknown>;
  return {...result,computedAt:latest!.computedAt};
}
