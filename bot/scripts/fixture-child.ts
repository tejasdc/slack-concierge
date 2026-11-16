import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {spawnOwnedProcessGroup} from '../src/owned-process-group';
import {readFileSync,readdirSync} from 'node:fs';
import CHECK_POLICY from './release-check-policy.json';
import {processNativeLifetimesEnded,readBootId,type ProcessIdentity} from '../src/runtime-identity';

type Termination =
 | {kind:'exit';code:number|null;signal:NodeJS.Signals|null}
 | {kind:'spawn-failure';error:string}
 | {kind:'cancelled'}
 | {kind:'deadline'};

function tail(previous:string,chunk:unknown){return (previous+String(chunk)).slice(-8192);}
function head(previous:string,chunk:unknown){return previous.length>=65_536?previous:(previous+String(chunk)).slice(0,65_536);}

/** This is the new session/group created for this child, not a machine-wide
 * liveness snapshot. After group SIGKILL, native members must finish before the
 * owner returns. A zombie leader alone is insufficient when another native
 * thread still owns the shared descriptor table. */
export async function fixtureGroupNativeExited(pgid:number):Promise<boolean> {
 try {process.kill(-pgid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return true;throw error;}
 if(process.platform!=='linux')return false;
 const identities:ProcessIdentity[]=[];
 for(const name of readdirSync('/proc')){
  if(!/^\d+$/.test(name))continue;
  try {
   const stat=readFileSync(`/proc/${name}/stat`,'utf8');
   const fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);
   if(Number(fields[2])!==pgid)continue;
   identities.push({pid:Number(name),bootId:readBootId(),startTicks:fields[19]!});
  }catch(error){if(!['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
 }
 // A group still visible to the kernel but absent from this observation is
 // uncertain, not empty. Observe it again while the same cleanup budget remains.
 return identities.length>0&&await processNativeLifetimesEnded(identities);
}

// Structured log lines carry stacks too; the child's own failure is its first plain error line.
function failureLine(text:string){
 const lines=text.split('\n').map(line=>line.trim()).filter(line=>line&&!line.startsWith('{')&&!line.startsWith('at '));
 return (lines.find(line=>/^(error:|[A-Z][A-Za-z]*Error\b)/.test(line))
  ??lines.find(line=>/\b(assert|failed|did not)\b/i.test(line)))?.slice(0,1000)??null;
}

/** Own one scratch fixture's process group and settle without waiting forever for inherited pipes. */
export async function runFixtureChild(options:{
 command:string;args:string[];env:NodeJS.ProcessEnv;deadlineMs:number;fixture:string;
 cwd?:string;signal?:AbortSignal;requireCheckpoint?:boolean;
 requireOwnedGroup?:boolean;
 utilityRuntimeFd?:number;
 onOutput?:(stream:'stdout'|'stderr',chunk:Buffer)=>void;
}):Promise<Record<string,unknown>>{
 const started=performance.now();
 let stdout='',stderr='',stderrHead='',exit:{code:number|null;signal:NodeJS.Signals|null}|null=null;
 let groupStopped=false;
 // A bounded outer check owns one kernel group for its entire fixture tree.
 // Nested fixture helpers inherit it instead of escaping the outer cancellation.
 const ownsGroup=options.env.CONCIERGE_FIXTURE_SHARED_GROUP!=='1';
 if(options.requireOwnedGroup&&!ownsGroup)throw new Error(`${options.fixture} requires its own process group; inherited shared-group state cannot certify complete cleanup.`);
 if(options.utilityRuntimeFd!==undefined&&!ownsGroup)throw new Error(`${options.fixture} retained utility runtime requires its owning process group.`);
 let child:Pick<ReturnType<typeof spawn>,'pid'|'stdout'|'stderr'|'on'|'once'|'kill'>;
 let owned:ReturnType<typeof spawnOwnedProcessGroup>|undefined;
 try{
  const env={...options.env,CONCIERGE_FIXTURE_SHARED_GROUP:'1'};
  if(ownsGroup){
   const events=new EventEmitter();let providerPid:number|undefined;
   owned=spawnOwnedProcessGroup([options.command,...options.args],{cwd:options.cwd,env,utilityRuntimeFd:options.utilityRuntimeFd},error=>events.emit('error',error));
   Object.assign(events,{stdout:owned.stdout,stderr:owned.stderr});
   Object.defineProperty(events,'pid',{get:()=>providerPid});
   owned.pid.then(pid=>{providerPid=pid??undefined;});
   owned.outcome.then(({code,signal})=>events.emit('exit',code,signal));
   owned.closed.then(()=>events.emit('close',null,null));
   child=events as unknown as typeof child;
  }else child=spawn(options.command,options.args,{cwd:options.cwd,env,stdio:['ignore','pipe','pipe']});
 }
 catch(error){throw new Error(`${options.fixture} spawn failure: ${String(error)}`);}
 const stopGroup=()=>{
  if((!owned&&!child.pid)||groupStopped)return;groupStopped=true;
  try{if(owned)owned.signal('SIGKILL');else child.kill('SIGKILL');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')stderr=tail(stderr,`\nprocess-group stop failed: ${String(error)}`);}
 };
 child.stdout?.on('data',chunk=>{stdout=tail(stdout,chunk);options.onOutput?.('stdout',chunk);});
 child.stderr?.on('data',chunk=>{stderrHead=head(stderrHead,chunk);stderr=tail(stderr,chunk);options.onOutput?.('stderr',chunk);});
 let leaderReaped=false;
 const reaped=()=>{leaderReaped=true;};
 let deadlineTimer:ReturnType<typeof setTimeout>|undefined;
 let drainTimer:ReturnType<typeof setTimeout>|undefined;
 let cancel!:()=>void;
 const terminating=new Promise<Termination>(resolve=>{
  let settled=false;
  const finish=(value:Termination)=>{
   if(settled)return;settled=true;
   if(deadlineTimer)clearTimeout(deadlineTimer);
   if(drainTimer)clearTimeout(drainTimer);
   resolve(value);
  };
  cancel=()=>{stopGroup();finish({kind:'cancelled'});};
  child.on('error',error=>{if(!child.pid)reaped();stopGroup();finish({kind:'spawn-failure',error:String(error)});});
  child.once('exit',(code,signal)=>{
   reaped();
   exit={code,signal};
   // The fixture may have started a worker that inherited stdout/stderr.
   // Reap the whole owned group; a short bounded drain keeps final child output.
   stopGroup();
   drainTimer=setTimeout(()=>finish({kind:'exit',code,signal}),Math.min(200,Math.max(1,options.deadlineMs-(performance.now()-started))));
  });
  child.once('close',(code,signal)=>finish({kind:'exit',code:exit?.code??code,signal:exit?.signal??signal}));
  deadlineTimer=setTimeout(()=>{stopGroup();finish({kind:'deadline'});},options.deadlineMs);
 });
 // A release gate cancellation reaches every group this fixture has actually launched.
 // Their exit settles the callers normally, so their owned scratch finally blocks run.
 process.on('SIGTERM',cancel);process.on('SIGINT',cancel);
 options.signal?.addEventListener('abort',cancel,{once:true});
 if(options.signal?.aborted)cancel();
 const termination=await terminating;
 stopGroup();
 let cleanupConfirmed=false;
 const cleanupDeadline=performance.now()+CHECK_POLICY.cleanupMs;
 try {
  do {
   cleanupConfirmed=leaderReaped&&(!ownsGroup||!owned?.groupPid||await fixtureGroupNativeExited(owned.groupPid));
   if(cleanupConfirmed)break;
   await new Promise<void>(resolve=>setImmediate(resolve));
  }while(performance.now()<cleanupDeadline);
 }finally {process.off('SIGTERM',cancel);process.off('SIGINT',cancel);options.signal?.removeEventListener('abort',cancel);}
 child.stdout?.destroy();child.stderr?.destroy();
 const elapsedMs=Math.round(performance.now()-started);
 const phases=stderr.split('\n').flatMap(line=>{try{const row=JSON.parse(line);return typeof row.phase==='string'?[row.phase]:[];}catch{return [];}}).slice(-12);
 const failure=failureLine(stderr)??failureLine(stderrHead);
 const diagnostics=`pid=${child.pid??'not-started'} custody=${ownsGroup?'owned_group':'leader_under_parent'} ${failure?`failure=${JSON.stringify(failure)} `:''}termination=${termination.kind} code=${termination.kind==='exit'?termination.code:'n/a'} signal=${termination.kind==='exit'?termination.signal:'n/a'} elapsedMs=${elapsedMs} phases=${JSON.stringify(phases)} stderr=${stderr} stdout=${stdout}`;
 if(!cleanupConfirmed)throw new Error(`${options.fixture} child cleanup unconfirmed; ${diagnostics}`);
 if(termination.kind==='cancelled')throw new Error(`${options.fixture} cancelled after owned child exit; ${diagnostics}`);
 if(termination.kind==='spawn-failure')throw new Error(`${options.fixture} spawn failure: ${termination.error}; ${diagnostics}`);
 if(termination.kind==='deadline')throw new Error(`${options.fixture} deadline after ${options.deadlineMs}ms; ${diagnostics}`);
 if(termination.code!==0)throw new Error(`${options.fixture} child failed; ${diagnostics}`);
 if(options.requireCheckpoint===false)return {fixture:options.fixture,childOutcome:{kind:'success',code:0,elapsedMs,phases,cleanupScope:ownsGroup?'group':'leader-under-parent-group'}};
 const result=stdout.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}})
  .find(row=>row?.fixture===options.fixture);
 if(!result)throw new Error(`${options.fixture} exited without final checkpoint; ${diagnostics}`);
 return {...result,childOutcome:{kind:'success',code:0,elapsedMs,phases,cleanupScope:ownsGroup?'group':'leader-under-parent-group'}};
}
