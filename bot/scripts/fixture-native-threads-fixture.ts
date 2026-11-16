import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixtureGroupNativeExited} from './fixture-child';
import {processIdentity,processNativeLifetimeEnded} from '../src/runtime-identity';
import {selectedProcessAlive} from '../src/deployment-launch-authority';
if(process.platform!=='linux'){console.log(JSON.stringify({fixture:'fixture-native-threads',status:'not-applicable',platform:process.platform}));process.exit(0);}
const root=mkdtempSync('/tmp/concierge-owned-native-threads-');
const source=join(root,'native.c'),binary=join(root,'native');
writeFileSync(source,'#include <pthread.h>\n#include <unistd.h>\nstatic void *worker(void *x){for(;;)pause();return x;}\nint main(){pthread_t id;if(pthread_create(&id,0,worker,0))return 2;pthread_exit(0);}\n');
const compile=Bun.spawnSync(['cc','-pthread',source,'-o',binary]);assert.equal(compile.exitCode,0,compile.stderr.toString());
const child=spawn(binary,[],{detached:true,stdio:'ignore'});
let ended=false;const exited=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',()=>{ended=true;resolve();});});
const end=Date.now()+5000;
try{
 let zombie=false;
 while(!zombie){assert.ok(Date.now()<end,'owned main thread reaches pthread_exit');
  if(child.pid&&existsSync(`/proc/${child.pid}/stat`)){const stat=readFileSync(`/proc/${child.pid}/stat`,'utf8');zombie=stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]==='Z';}
  if(!zombie)await Bun.sleep(2);
 }
 assert.equal(ended,false,'live native thread still holds the process lifetime');
 const identity=processIdentity(child.pid!);
 assert.equal(await processNativeLifetimeEnded(identity),false);
 assert.equal(await selectedProcessAlive({...identity,main:binary,device:0,inode:0}),true,'bootstrap retains the native worker after its leader exits');
 assert.equal(await fixtureGroupNativeExited(child.pid!),false,'a zombie leader cannot certify native descriptor cleanup');
}finally{
 if(child.pid){try{process.kill(-child.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}}
 await exited;assert.equal(await fixtureGroupNativeExited(child.pid!),true,'complete owned native group is gone after reaping');
}
console.log(JSON.stringify({fixture:'fixture-native-threads',status:'passed',root,pid:child.pid,zombieLeader:true,
 nativeCompleteWhileWorkerLive:false,cleanupNativeComplete:true}));
