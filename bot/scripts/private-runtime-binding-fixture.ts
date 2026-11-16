import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFileSync,openSync,closeSync,fstatSync,mkdtempSync,mkdirSync,writeFileSync,readFileSync,unlinkSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {privateCodeCommand,hasVerifiedPrivateCodeBoundary,PRIVATE_RUNTIME_BIND_FD} from '../src/private-database-command';

const inherited=hasVerifiedPrivateCodeBoundary(process.env);
if(process.argv.includes('--fresh'))assert.equal(inherited,false,'fresh runtime binding must start outside the private boundary');
const root=mkdtempSync(join(import.meta.dir,'../../tmp/reviews/private-runtime-'));
const runtimeDirectory=join(root,'runtime');mkdirSync(runtimeDirectory);
const original=join(root,'original-bun'),target=join(runtimeDirectory,'bound-bun'),sentinel=join(root,'setup-only');
let runtime=-1,secret=-1;
try{
 copyFileSync(process.execPath,original);runtime=openSync(original,'r');
 const image=fstatSync(runtime,{bigint:true}),digest=createHash('sha256').update(readFileSync(runtime)).digest('hex');
 unlinkSync(original);writeFileSync(target,'',{mode:0o555});writeFileSync(sentinel,'owned setup descriptor');secret=openSync(sentinel,'r');
 const secretImage=fstatSync(secret,{bigint:true});
 const state=join(root,'state');mkdirSync(state);
 const body=`
 import assert from 'node:assert/strict';import{statSync,fstatSync,readdirSync,readlinkSync,readFileSync}from'node:fs';import{createHash}from'node:crypto';import{spawnSync}from'node:child_process';
 assert.equal(process.env.CONCIERGE_PRIVATE_CODE_BOUNDARY_VERIFIED,'1');
 const actual=statSync(process.execPath,{bigint:true});
 assert.equal(createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),${JSON.stringify(digest)});
 assert.equal(actual.mode&0o222n,0n);
 const leaked=[];for(const name of readdirSync('/proc/self/fd'))try{const item=fstatSync(Number(name),{bigint:true});if(item.dev===BigInt(${JSON.stringify(String(secretImage.dev))})&&item.ino===BigInt(${JSON.stringify(String(secretImage.ino))}))leaked.push(name);}catch{}
 assert.deepEqual(leaked,[]);assert.equal(process.execPath,${JSON.stringify(target)});
 const relaunched=spawnSync(process.execPath,['-e','console.log(process.execPath)'],{encoding:'utf8',timeout:5000});
 assert.equal(relaunched.error,undefined);assert.equal(relaunched.status,0,String(relaunched.stderr));assert.equal(relaunched.stdout.trim(),process.execPath);
 console.log(JSON.stringify({fixture:'private-runtime-binding-body',path:process.execPath,device:String(actual.dev),inode:String(actual.ino),sourceDevice:${JSON.stringify(String(image.dev))},sourceInode:${JSON.stringify(String(image.ino))},sha256:${JSON.stringify(digest)},setupDescriptorAbsent:true,relaunch:true,pidNamespace:readlinkSync('/proc/self/ns/pid')}));`;
 const binding={fd:runtime,target,device:String(image.dev),inode:String(image.ino),sha256:digest};
 const env={...process.env,CONCIERGE_STATE_DIR:state,CONCIERGE_STATE_DB:join(state,'state.db'),CONCIERGE_PRIVATE_CODE_STATE:state,CONCIERGE_TEST_MODE:'1'};
 assert.throws(()=>privateCodeCommand([target,'-e',body],env,{...binding,sha256:'0'.repeat(64)}),/retained loaded executable/);
 const isolated=privateCodeCommand([target,'-e',body],env,binding);
 try{
  const stdio:any[]=['ignore','pipe','pipe',secret];stdio[PRIVATE_RUNTIME_BIND_FD]=isolated.executableFd;
  const child=spawnSync(isolated.command[0]!,isolated.command.slice(1),{env:isolated.environment,stdio,encoding:'utf8',timeout:10000});
  assert.equal(child.error,undefined,String(child.error));assert.equal(child.status,0,String(child.stderr));
  const receipt=JSON.parse(String(child.stdout).trim());assert.equal(receipt.setupDescriptorAbsent,true);
  assert.equal(readFileSync(target).length,0,'private runtime bytes must not alter the owning filesystem');
  console.log(JSON.stringify({fixture:'private-runtime-binding',inherited,originalUnlinkedBeforeSpawn:true,retainedLoadedRuntime:true,wrongHashRefused:true,receipt}));
 }finally{isolated.cleanup();}
}finally{
 if(runtime>=0)closeSync(runtime);if(secret>=0)closeSync(secret);rmSync(root,{recursive:true,force:true});
}
