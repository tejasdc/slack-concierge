/** Pure finite release-check utility. Never import the application state graph here. */
import {closeSync,mkdirSync,readFileSync,writeFileSync,writeSync,openSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {enrollFixedCheck,bindFixedCheck,recheckFixedCheck,fixedCheckEnvironment,type CheckEnrollment} from '../src/deployment-check-binding';
import {privateCodeCommand,PRIVATE_RUNTIME_BIND_FD} from '../src/private-database-command';
import {runFixtureChild} from './fixture-child';
import POLICY from './release-check-policy.json';

function remaining(){
 const deadline=process.env.FIXED_PRESENTATION_DEADLINE_NS;
 if(!deadline||!/^\d+$/.test(deadline))throw Error('Fixed presentation deadline is absent.');
 const milliseconds=Number((BigInt(deadline)-process.hrtime.bigint())/1_000_000n);
 if(milliseconds<=POLICY.cleanupMs)throw Error('Fixed presentation work budget has ended.');
 return milliseconds-POLICY.cleanupMs;
}
const mode=process.argv[2],peer=Number(process.argv[3]);
if(!Number.isSafeInteger(peer)||peer<=1)throw Error('Fixed presentation peer is absent.');
if(mode==='enroll')console.log(JSON.stringify(await enrollFixedCheck(peer)));
else if(mode==='resource'){
 const status=Number(process.env.FIXED_PRESENTATION_STATUS_FD),runtime=Number(process.env.FIXED_PRESENTATION_RUNTIME_FD);
 const check=process.env.FIXED_PRESENTATION_CHECK_ID;
 if(!check||!Number.isSafeInteger(status)||status<=4||runtime!==3)throw Error('Fixed presentation resource capabilities are absent.');
 const cancel=new AbortController();
 const stop=()=>cancel.abort();
 process.stdin.resume();process.stdin.once('end',stop);process.on('SIGTERM',stop);process.on('SIGINT',stop);
 // Only this outer utility retains the result pipe. The owned native guardian
 // forwards explicit streams and its retained runtime, never this descriptor.
 try{
  const env={...process.env};delete env.CONCIERGE_FIXTURE_SHARED_GROUP;
  await runFixtureChild({command:'bun',args:[import.meta.path,'execute',String(peer),process.argv[4]!],
   env,utilityRuntimeFd:runtime,requireOwnedGroup:true,deadlineMs:remaining(),fixture:'fixed-presentation',requireCheckpoint:false,
   signal:cancel.signal,onOutput:(stream,chunk)=>process[stream].write(chunk)});
  writeSync(status,JSON.stringify({kind:'result',check,code:0,cleanup:'complete'}));
 }finally{closeSync(status);process.off('SIGTERM',stop);process.off('SIGINT',stop);process.stdin.destroy();}
}else if(mode==='execute'){
 const enrollment=JSON.parse(readFileSync(process.argv[4]!,'utf8')) as CheckEnrollment;
 remaining();
 const binding=await bindFixedCheck(peer,enrollment);
 const directory=join(enrollment.root,`runtime-${process.pid}`),target=join(directory,'bun');
 mkdirSync(directory,{mode:0o700});writeFileSync(target,'',{mode:0o555});
 const env=fixedCheckEnvironment(binding),entrance=join(binding.source,'bot/scripts/presentation-release-check.ts');
 const isolated=privateCodeCommand([target,entrance,'--bounded-child'],env,{fd:binding.runtimeFd,target,...binding.runtime});
 try{
  const stdio:any[]=['ignore','pipe','pipe','ignore'];stdio[PRIVATE_RUNTIME_BIND_FD]=isolated.executableFd;
  const code=await new Promise<number>((resolve,reject)=>{
   const child=spawn(isolated.command[0]!,isolated.command.slice(1),{cwd:join(binding.source,'bot'),env:isolated.environment,stdio});
   child.stdout!.pipe(process.stdout);child.stderr!.pipe(process.stderr);
   child.once('error',reject);child.once('close',(code,signal)=>signal?reject(Error(`Fixed presentation exited by ${signal}.`)):resolve(code??1));
  });
  if(code!==0)throw Error(`Fixed presentation graph refused with exit ${code}.`);
  remaining();await recheckFixedCheck(binding);
 }finally{isolated.cleanup();closeSync(binding.runtimeFd);}
}else throw Error('Unknown fixed presentation utility role.');
