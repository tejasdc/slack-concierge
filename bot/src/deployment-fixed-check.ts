/** Candidate-owned fixed gate bridge; no application/database imports. */
import {closeSync,existsSync,mkdirSync,openSync,readFileSync,writeFileSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {locateFixedCheckEnrollment,locateFixedCheckResource} from './deployment-check-binding';
import {fixedPresentationNativeProgram} from './fixed-presentation-native';
import POLICY from '../scripts/release-check-policy.json';

/** Only the candidate preflight in the selected normal deploy may enroll. */
export async function establishFixedPresentationResource():Promise<boolean>{
 const located=locateFixedCheckEnrollment();
 if(!located)return false;
 // A second setup under the same live attempt cannot silently replace its
 // original resource, code, socket or an uncertain prior setup.
 mkdirSync(located.root,{mode:0o700});
 const entry=resolve(import.meta.dir,'../scripts/deployment-fixed-check-resource.ts');
 const graph:Record<string,string>={};
 const built=await Bun.build({entrypoints:[entry],target:'bun',outdir:located.root,naming:'resource.js',plugins:[{
  name:'closed-release-check-resource',setup(build){
   build.onResolve({filter:/^(?:bun:sqlite|sqlite3|better-sqlite3)$/},()=>{throw Error('Fixed check resource imported a database opener.');});
   build.onLoad({filter:/\.[cm]?[jt]sx?$/},async args=>{
    const bytes=readFileSync(args.path);
    graph[args.path]=createHash('sha256').update(bytes).digest('hex');
    return undefined;
   });
  },
 }]});
 if(!built.success)throw new AggregateError(built.logs,'Fixed presentation resource build failed.');
 writeFileSync(join(located.root,'source-graph.json'),JSON.stringify(graph,null,2));
 const native=join(located.root,'native.py');writeFileSync(native,fixedPresentationNativeProgram(POLICY),{mode:0o400});
 const runtime=openSync('/proc/self/exe','r'),program=openSync(native,'r');
 try{
  const child=spawn('/usr/bin/python3',['-I','-S','-B','/proc/self/fd/5','--authority'],{
   cwd:located.root,env:{...process.env},stdio:['ignore','ignore','ignore',runtime,'pipe',program],
  });
  await new Promise<void>((resolve,reject)=>{
   let ready='',settled=false;
   const finish=(error?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve();};
   const timer=setTimeout(()=>{child.kill('SIGTERM');finish(Error('Fixed presentation resource did not become ready within its existing check budget.'));},POLICY.deadlineMs);
   const stream=child.stdio[4]!;
   stream.on('data',chunk=>{ready+=String(chunk);if(ready.length>6){child.kill('SIGTERM');finish(Error('Invalid fixed presentation readiness.'));}});
   stream.once('end',()=>finish(ready==='ready\n'?undefined:Error('Fixed presentation resource refused enrollment.')));
   child.once('error',finish);child.once('exit',(code,signal)=>{if(!settled)finish(Error(`Fixed presentation resource exited before readiness: ${code}/${signal}.`));});
  });
  child.unref();
  return true;
 }finally{closeSync(runtime);closeSync(program);}
}

/** Positive resource absence is distinct from an existing resource's refusal. */
export function forwardFixedPresentation():number|null{
 const root=locateFixedCheckResource();
 if(root===null)return null;
 const native=join(root,'native.py');
 if(!existsSync(native))throw Error('Enrolled presentation resource lost its fixed program.');
 const program=openSync(native,'r');
 try{
  const result=spawnSync('/usr/bin/python3',['-I','-S','-B','/proc/self/fd/5','--forwarder'],{
   cwd:root,env:{...process.env},stdio:['inherit','inherit','inherit','ignore','ignore',program],
  });
  if(result.error)throw result.error;
  if(result.signal)throw Error(`Fixed presentation forwarding ended by ${result.signal}.`);
  return result.status??1;
 }finally{closeSync(program);}
}
