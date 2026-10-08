import {spawn} from 'node:child_process';

type Termination =
 | {kind:'exit';code:number|null;signal:NodeJS.Signals|null}
 | {kind:'spawn-failure';error:string}
 | {kind:'deadline'};

function tail(previous:string,chunk:unknown){return (previous+String(chunk)).slice(-8192);}

/** Own one scratch fixture's process group and settle without waiting forever for inherited pipes. */
export async function runFixtureChild(options:{
 command:string;args:string[];env:NodeJS.ProcessEnv;deadlineMs:number;fixture:string;
}):Promise<Record<string,unknown>>{
 const started=performance.now();
 let stdout='',stderr='',exit:{code:number|null;signal:NodeJS.Signals|null}|null=null;
 let groupStopped=false;
 let child:ReturnType<typeof spawn>;
 try{child=spawn(options.command,options.args,{env:options.env,stdio:['ignore','pipe','pipe'],detached:true});}
 catch(error){throw new Error(`${options.fixture} spawn failure: ${String(error)}`);}
 const stopGroup=()=>{
  if(!child.pid||groupStopped)return;groupStopped=true;
  try{process.kill(-child.pid,'SIGKILL');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')stderr=tail(stderr,`\nprocess-group stop failed: ${String(error)}`);}
 };
 child.stdout?.on('data',chunk=>{stdout=tail(stdout,chunk);});
 child.stderr?.on('data',chunk=>{stderr=tail(stderr,chunk);});
 let deadlineTimer:ReturnType<typeof setTimeout>|undefined;
 let drainTimer:ReturnType<typeof setTimeout>|undefined;
 const termination=await new Promise<Termination>(resolve=>{
  let settled=false;
  const finish=(value:Termination)=>{
   if(settled)return;settled=true;
   if(deadlineTimer)clearTimeout(deadlineTimer);
   if(drainTimer)clearTimeout(drainTimer);
   resolve(value);
  };
  child.once('error',error=>{stopGroup();finish({kind:'spawn-failure',error:String(error)});});
  child.once('exit',(code,signal)=>{
   exit={code,signal};
   // The fixture may have started a worker that inherited stdout/stderr.
   // Reap the whole owned group; a short bounded drain keeps final child output.
   stopGroup();
   drainTimer=setTimeout(()=>finish({kind:'exit',code,signal}),Math.min(200,Math.max(1,options.deadlineMs-(performance.now()-started))));
  });
  child.once('close',(code,signal)=>finish({kind:'exit',code:exit?.code??code,signal:exit?.signal??signal}));
  deadlineTimer=setTimeout(()=>{stopGroup();finish({kind:'deadline'});},options.deadlineMs);
 });
 stopGroup();
 child.stdout?.destroy();child.stderr?.destroy();
 const elapsedMs=Math.round(performance.now()-started);
 const phases=stderr.split('\n').flatMap(line=>{try{const row=JSON.parse(line);return typeof row.phase==='string'?[row.phase]:[];}catch{return [];}}).slice(-12);
 const diagnostics=`termination=${termination.kind} code=${termination.kind==='exit'?termination.code:'n/a'} signal=${termination.kind==='exit'?termination.signal:'n/a'} elapsedMs=${elapsedMs} phases=${JSON.stringify(phases)} stderr=${stderr} stdout=${stdout}`;
 if(termination.kind==='spawn-failure')throw new Error(`${options.fixture} spawn failure: ${termination.error}; ${diagnostics}`);
 if(termination.kind==='deadline')throw new Error(`${options.fixture} deadline after ${options.deadlineMs}ms; ${diagnostics}`);
 if(termination.code!==0)throw new Error(`${options.fixture} child failed; ${diagnostics}`);
 const result=stdout.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}})
  .find(row=>row?.fixture===options.fixture);
 if(!result)throw new Error(`${options.fixture} exited without final checkpoint; ${diagnostics}`);
 return {...result,childOutcome:{kind:'success',code:0,elapsedMs,phases}};
}
