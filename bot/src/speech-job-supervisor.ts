import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {log} from './log';

const unit='concierge-speech-worker';
let launching:Promise<void>|null=null;
function run(command:string,args:string[]):Promise<{code:number|null;stderr:string}>{
 return new Promise(resolve=>{
  const child=spawn(command,args,{stdio:['ignore','ignore','pipe']});let stderr='';
  child.stderr.on('data',chunk=>{stderr+=String(chunk).slice(0,1000);});
  child.once('error',error=>resolve({code:null,stderr:String(error)}));
  child.once('close',code=>resolve({code,stderr}));
 });
}
function workerEntry(){
 const bundled='/var/lib/slack-concierge-deployment/current/bot/src/speech-job-worker.js';
 if(existsSync(bundled))return bundled;
 const source=join(import.meta.dir,'speech-job-worker.ts');
 if(existsSync(source))return source;
 throw new Error('The speech worker is absent from the installed release.');
}
/** Starts one independent, supervised lane. The unit keeps working while Concierge restarts. */
export function ensureSpeechWorker(stateDir:string):Promise<void>{
 if(process.platform!=='linux')return Promise.resolve();
 // Scratch tests launch the pure worker directly and never touch the machine supervisor.
 if(process.env.CONCIERGE_TEST_MODE==='1')return Promise.resolve();
 if(launching)return launching;
 launching=(async()=>{
  const active=await run('systemctl',['is-active','--quiet',`${unit}.service`]);
  if(active.code===0)return;
  await run('systemctl',['reset-failed',`${unit}.service`]);
  const entry=workerEntry();
  const result=await run('systemd-run',[
   `--unit=${unit}`,'--service-type=exec','--collect','--no-block','--quiet',
   '--property=Restart=always','--property=RestartSec=2s','--property=KillMode=control-group',
   '--description=Concierge independent speech transcription',
   `--setenv=CONCIERGE_STATE_DIR=${stateDir}`,
   process.execPath,'run',entry]);
  if(result.code!==0){
   const now=await run('systemctl',['is-active','--quiet',`${unit}.service`]);
   if(now.code!==0)throw new Error(`Speech worker supervisor refused startup: ${result.stderr.slice(0,300)}`);
  }
 })().catch(error=>{log('error','speech_worker_start_failed',{reason:error instanceof Error?error.message:'unknown'});throw error;})
  .finally(()=>{launching=null;});
 return launching;
}
