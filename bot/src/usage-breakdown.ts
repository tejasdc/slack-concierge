import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {existsSync,readFileSync,renameSync,statSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
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
/**
 * The page's read is answered by a read worker, a separate process from the owner whose usage
 * watch keeps the result fresh, so each worker started empty and its first read waited for a
 * whole scan: every read for two nights took about 2 s (nightly review, 2026-10-30). The latest
 * result therefore lives in one file beside the ledger that every process reads; a reader scans
 * itself only when no result exists or the file has gone unrefreshed for three intervals.
 */
const RESULT_STALE_MS=3*REFRESH_EVERY_MS;
type Result={computedAt:string;both:Record<UsagePeriod,unknown>};
let latest:Result|null=null;
let loadedMtimeMs=0;
let running:Promise<void>|null=null;

function resultPath(){
  return join(process.env.CONCIERGE_STATE_DIR??join(homedir(),'.local/state/concierge'),'usage-breakdown-latest.json');
}

function publish(result:Result){
  latest=result;
  try{
    const path=resultPath(),temporary=`${path}.${process.pid}.tmp`;
    writeFileSync(temporary,JSON.stringify(result),{mode:0o600});
    renameSync(temporary,path);
    loadedMtimeMs=statSync(path).mtimeMs;
  }catch(error){log('warn','usage_breakdown_publish_failed',{error:String(error).slice(0,300)});}
}

/** The newer of this process's own result and the shared file. */
function current():Result|null{
  try{
    const path=resultPath();
    const mtimeMs=statSync(path).mtimeMs;
    if(mtimeMs===loadedMtimeMs)return latest;
    const stored=JSON.parse(readFileSync(path,'utf8')) as Result;
    loadedMtimeMs=mtimeMs;
    if(typeof stored?.computedAt==='string'&&stored.both&&(!latest||stored.computedAt>latest.computedAt))latest=stored;
  }catch{/* No shared result yet; this process's own, if any, stands. */}
  return latest;
}

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
      try{publish({computedAt:new Date().toISOString(),both:JSON.parse(output)});resolve();}catch(cause){reject(cause);}
    });
  }).then(()=>log('info','usage_breakdown_refreshed',{duration_ms:Date.now()-started}),
    error=>{log('error','usage_breakdown_refresh_failed',{duration_ms:Date.now()-started,error:String(error).slice(0,500)});throw error;})
    .finally(()=>{running=null;});
  return running;
}

/** Called on every usage reading; starts a background scan when the last one is older than five minutes. */
export function refreshUsageBreakdownIfStale():void{
  const latest=current();
  if(latest&&Date.now()-Date.parse(latest.computedAt)<REFRESH_EVERY_MS)return;
  void scan().catch(()=>{});
}

export async function usageBreakdown(period:UsagePeriod):Promise<unknown>{
  let known=current();
  if(!known){await scan();known=latest;}
  else if(Date.now()-Date.parse(known.computedAt)>=RESULT_STALE_MS)void scan().catch(()=>{});
  const result=known!.both[period] as Record<string,unknown>;
  return {...result,computedAt:known!.computedAt};
}
