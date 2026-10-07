import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {existsSync} from 'node:fs';

export type UsagePeriod='today'|'week';

/** Run the large transcript scan away from the owner event loop. Concurrent callers share one scan. */
let running:Promise<unknown>|null=null;
export function usageBreakdown(period:UsagePeriod):Promise<unknown>{
  if(!running)running=new Promise((resolve,reject)=>{
    const installed=join(import.meta.dir,'../../control/bot/scripts/usage-breakdown-reader.js');
    const reader=existsSync(installed)?installed:join(import.meta.dir,'../scripts/usage-breakdown-reader.ts');
    const child=spawn(process.execPath,[reader,'--both'],
      {stdio:['ignore','pipe','pipe']});
    let output='',error='';
    child.stdout.setEncoding('utf8').on('data',(chunk:string)=>{output+=chunk;});
    child.stderr.setEncoding('utf8').on('data',(chunk:string)=>{error+=chunk.slice(0,2000);});
    child.on('error',reject);
    child.on('close',code=>code===0?resolve(JSON.parse(output)):reject(new Error(error||`Usage scan exited ${code}`)));
  }).finally(()=>{running=null;});
  return running.then((both:any)=>both[period]);
}
