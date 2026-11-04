/**
 * A Concierge runner (docs/architecture/RUNNERS.md): a machine that pulls work from the owner over
 * outbound HTTPS. It opens no port. It claims a job, heartbeats its lease, streams sequenced events
 * and finishes under one operation id, and on restart takes back the attempts it recorded.
 *
 * Environment: CONCIERGE_OWNER_URL (the owner's agent entrance), CONCIERGE_RUNNER_TOKEN_FILE (a
 * runner token from `POST /runner/v1/token` on the owner's machine), CONCIERGE_RUNNER_STATE (this
 * runner's own folder). `--once` handles at most one job and exits (the probe check uses it).
 *
 * Job kinds run here today: `probe`, which echoes its payload. Agent turns are the next kind; they
 * run inside the existing execution host, whose journal is the event source (RUNNERS.md, "Turns").
 */
import {mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';

const owner=process.env.CONCIERGE_OWNER_URL?.replace(/\/+$/,'');
const tokenFile=process.env.CONCIERGE_RUNNER_TOKEN_FILE;
const stateDir=process.env.CONCIERGE_RUNNER_STATE;
if(!owner||!tokenFile||!stateDir){console.error('CONCIERGE_OWNER_URL, CONCIERGE_RUNNER_TOKEN_FILE and CONCIERGE_RUNNER_STATE are required.');process.exit(2);}
const token=readFileSync(tokenFile,'utf8').trim();
mkdirSync(stateDir,{recursive:true,mode:0o700});
const held=join(stateDir,'attempts.json');
const once=process.argv.includes('--once');

type Held=Record<string,{jobId:string;epoch:number;sentSeq:number}>;
const readHeld=():Held=>{try{return JSON.parse(readFileSync(held,'utf8'));}catch{return {};}};
const writeHeld=(value:Held)=>{writeFileSync(held+'.tmp',JSON.stringify(value),{mode:0o600});renameSync(held+'.tmp',held);};

async function call(path:string,body:unknown):Promise<any> {
  const response=await fetch(`${owner}/runner/v1/${path}`,{method:'POST',signal:AbortSignal.timeout(30_000),
    headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json().catch(()=>({ok:false,error:`HTTP ${response.status}`}));
  if(!response.ok)throw Object.assign(new Error(result.detail??result.error??`HTTP ${response.status}`),{code:result.error});
  return result;
}

async function runProbe(job:{jobId:string;attemptId:string;epoch:number;payload:any}) {
  const state=readHeld();state[job.attemptId]={jobId:job.jobId,epoch:job.epoch,sentSeq:0};writeHeld(state);
  const beat=await call('heartbeat',{attemptId:job.attemptId,epoch:job.epoch});
  const events=[{seq:1,frame:{k:'started',runner:process.env.CONCIERGE_RUNNER_NAME??null,pid:process.pid}},
    {seq:2,frame:{k:'echo',text:job.payload?.text??null,commandsSeen:beat.commands.length}}];
  const acked=await call('events',{attemptId:job.attemptId,epoch:job.epoch,events});
  // A resend of an acknowledged sequence stores nothing twice; this proves it on every probe.
  const again=await call('events',{attemptId:job.attemptId,epoch:job.epoch,events});
  const finished=await call('finish',{attemptId:job.attemptId,epoch:job.epoch,operationId:`finish:${job.attemptId}`,
    result:{echoed:job.payload?.text??null,ackedSeq:acked.ackedSeq,resendAckedSeq:again.ackedSeq}});
  const after=readHeld();delete after[job.attemptId];writeHeld(after);
  return finished;
}

// Take back what this runner held before a restart; a stale attempt is no longer this runner's.
const before=Object.keys(readHeld());
if(before.length){
  const {attempts}=await call('reacquire',{attemptIds:before});
  const state=readHeld();
  for(const attempt of attempts){if(attempt.stale)delete state[attempt.attemptId];else state[attempt.attemptId]!.epoch=attempt.epoch;}
  writeHeld(state);
  console.log(JSON.stringify({event:'runner_reacquired',attempts}));
}
for(let idle=0;;) {
  const {job}=await call('claim',{kinds:['probe']});
  if(job){
    const result=job.kind==='probe'?await runProbe(job):null;
    console.log(JSON.stringify({event:'runner_job_finished',jobId:job.jobId,attemptId:job.attemptId,result}));
    if(once)break;
    idle=0;continue;
  }
  if(once&&++idle>=15){console.log(JSON.stringify({event:'runner_no_job'}));break;}
  await Bun.sleep(2_000);
}
