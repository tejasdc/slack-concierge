import assert from 'node:assert/strict';
import{mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,chmodSync,copyFileSync,openSync,closeSync,fstatSync,unlinkSync}from'node:fs';
assert.equal(process.env.CONCIERGE_PRIVATE_CODE_BOUNDARY_VERIFIED,'1');
if(process.argv.includes('--utility-runtime-child')){
 const runtime=fstatSync(4);
 assert.equal(runtime.dev,Number(process.env.OWNED_RUNTIME_DEVICE));
 assert.equal(runtime.ino,Number(process.env.OWNED_RUNTIME_INODE));
 assert.equal(existsSync(process.env.OWNED_RUNTIME_ORIGINAL!),false);
 console.log(JSON.stringify({fixture:'owned-runtime-child',pid:process.pid,device:runtime.dev,inode:runtime.ino,originalUnlinked:true}));
 process.exit(0);
}
const{runFixtureChild,fixtureGroupNativeExited}=await import('./fixture-child');
const{processIdentity,processNativeLifetimeEnded}=await import('../src/runtime-identity');
const inherited=process.env.CONCIERGE_FIXTURE_SHARED_GROUP==='1';
assert.ok(!process.argv.includes('--require-owned-group')||!inherited,'standalone native group proof requires an owning root');
const root=mkdtempSync('/tmp/owned-native-thread-runner-'),binary=root+'/native',source=root+'/native.c';
writeFileSync(source,'#include <pthread.h>\n#include <unistd.h>\n#include <stdio.h>\nstatic void *worker(void *x){for(;;)pause();return x;}\nint main(int n,char **a){FILE *f=fopen(a[1],"w");fprintf(f,"%d %d",getpid(),getpgrp());fclose(f);pthread_t id;if(pthread_create(&id,0,worker,0))return 2;pthread_exit(0);}\n');
const compile=Bun.spawnSync(['cc','-pthread',source,'-o',binary]);assert.equal(compile.exitCode,0,compile.stderr.toString());
const wait=async(check:()=>boolean|Promise<boolean>)=>{const deadline=Date.now()+5000;while(!await check()){assert.ok(Date.now()<deadline);await Bun.sleep(2);}};
let pid=0,group=0;
try{
const unexecutable=root+'/not-executable';writeFileSync(unexecutable,'#!/bin/sh\nexit 0\n');chmodSync(unexecutable,0o600);
for(const command of [root+'/does-not-exist',unexecutable]){
 await assert.rejects(runFixtureChild({command,args:[],env:process.env,deadlineMs:1000,fixture:'owned-spawn-failure',requireCheckpoint:false,requireOwnedGroup:!inherited}),error=>/spawn failure/.test(String(error))&&/pid=not-started/.test(String(error)));
}
let failedExecSpawnNotifications=0;
if(!inherited){
 const{spawnOwnedProcessGroup}=await import('../src/owned-process-group');
 for(const command of [root+'/does-not-exist',unexecutable]){
  const errors:string[]=[];
  const child=spawnOwnedProcessGroup([command],{env:process.env},error=>errors.push(String(error)));
  child.stdout.resume();child.stderr.resume();
  const spawned=child.identity.then(identity=>{if(identity)failedExecSpawnNotifications++;});
  try{await child.exited;await spawned;assert.equal(await child.identity,null);assert.equal(await child.pid,null);assert.equal(failedExecSpawnNotifications,0);assert.match(errors[0]!,/No such file|Permission denied/);}
  finally{await child.dispose(true);}
  assert.equal(errors.length,1,'explicit exec failure produces no contradictory started/outcome status');
 }
 const runtimePath=root+'/retained-utility-bun';copyFileSync(process.execPath,runtimePath);
 const runtimeFd=openSync(runtimePath,'r'),runtimeIdentity=fstatSync(runtimeFd);unlinkSync(runtimePath);
 const errors:string[]=[];
 const utility=spawnOwnedProcessGroup(['bun',import.meta.path,'--utility-runtime-child'],{
  env:{...process.env,OWNED_RUNTIME_DEVICE:String(runtimeIdentity.dev),OWNED_RUNTIME_INODE:String(runtimeIdentity.ino),OWNED_RUNTIME_ORIGINAL:runtimePath},
  utilityRuntimeFd:runtimeFd,
 },error=>errors.push(String(error)));
 // Both subsequent execs must use their inherited file capability: its former
 // pathname is gone, and the original holder releases its descriptor now.
 closeSync(runtimeFd);
 let output='';const drained=(async()=>{for await(const chunk of utility.stdout)output+=String(chunk);})();utility.stderr.resume();
 try{
  assert.equal(await utility.exited,0);await drained;assert.deepEqual(errors,[]);
  const receipt=JSON.parse(output.trim());assert.equal(receipt.fixture,'owned-runtime-child');
  assert.deepEqual([receipt.device,receipt.inode],[runtimeIdentity.dev,runtimeIdentity.ino]);
 }finally{await utility.dispose(errors.length>0);}
 assert.equal(await fixtureGroupNativeExited(utility.groupPid!),true,'retained-runtime custodian completes its native group');
}
await assert.rejects(runFixtureChild({command:process.execPath,args:['-e','process.exit(0)'],cwd:root+'/absent-directory',env:process.env,deadlineMs:1000,fixture:inherited?'nested-spawn-failure':'guardian-spawn-failure',requireCheckpoint:false,requireOwnedGroup:!inherited}),/spawn failure/);
const pending=runFixtureChild({command:binary,args:[root+'/identity'],env:process.env,deadlineMs:1000,fixture:'native-thread-runner',requireCheckpoint:false,requireOwnedGroup:!inherited});
const result=pending.then(()=>null,error=>error);
await wait(()=>existsSync(root+'/identity')&&/^\d+ \d+$/.test(readFileSync(root+'/identity','utf8')));[pid,group]=readFileSync(root+'/identity','utf8').split(' ').map(Number);
await wait(()=>readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1]!.startsWith('Z '));
const identity=processIdentity(pid);
assert.equal(await processNativeLifetimeEnded(identity),false,'zombie leader cannot certify the living native worker');
const parentGroup=Number(readFileSync('/proc/self/stat','utf8').split(') ')[1]!.split(' ')[2]);
if(inherited)assert.equal(group,parentGroup,'nested native child stays in the enclosing suite group');
else {assert.notEqual(group,parentGroup);assert.equal(await fixtureGroupNativeExited(group),false,'owned native group still has its live worker');}
const error=await result;assert.match(String(error),/deadline/);
assert.match(String(error),inherited?/custody=leader_under_parent/:/custody=owned_group/);
assert.equal(await processNativeLifetimeEnded(identity),true,'actual runner cleanup waits for the complete native child');
if(!inherited)assert.equal(await fixtureGroupNativeExited(group),true,'standalone owner certifies the whole native group');
console.log(JSON.stringify({fixture:'owned-process-group-native',custody:inherited?'leader-under-parent-group':'owned-group',pid,group,providerSpawnFailure:true,unexecutableSpawnFailure:true,failedExecSpawnNotifications:inherited?null:failedExecSpawnNotifications,guardianSpawnFailure:!inherited,nestedSpawnFailure:inherited,zombieLeaderWhileWorkerAlive:true,nativeCompleteBeforeKill:false,actualRunnerDeadline:true,nativeProcessCompleteAtReturn:true,nativeGroupCompleteAtReturn:inherited?null:true,error:String(error)}));
}finally{if(pid&&existsSync(`/proc/${pid}/stat`))try{process.kill(pid,'SIGKILL');}catch{}rmSync(root,{recursive:true,force:true});}
