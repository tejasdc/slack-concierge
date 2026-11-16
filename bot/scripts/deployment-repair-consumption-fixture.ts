import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,chmodSync,rmSync,existsSync} from 'node:fs';
import {runRepairAgent,RepairAttemptIntegrityError} from '../src/deployment-repair-agent';
const root=mkdtempSync('/tmp/wal79-repair-agent-');
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
const until=async(check:()=>boolean)=>{const end=Date.now()+5000;while(!check()){assert.ok(Date.now()<end,'bounded readiness');await Bun.sleep(2);}};
const uuid='01a039f1-9e1b-71d1-8f89-a6431c3d53b0';
let ownedPid=0;
try {
 const executable=root+'/provider';
 process.env.CONCIERGE_CODEX_BIN=executable;
 const writeProvider=(resident:boolean)=>{writeFileSync(executable,`#!${process.execPath}\nif(process.argv.includes('--help'))process.exit(0);\nconsole.log(JSON.stringify({thread_id:${JSON.stringify(uuid)}}));\nawait Bun.write(${JSON.stringify(root+'/emitted')},'1');\n${resident?'setInterval(()=>{},1000);':''}\n`);chmodSync(executable,0o700);};
 writeProvider(false);
 const spawn=deferred(),session=deferred(),spawnSeen=deferred(),sessionSeen=deferred();let done=false;
 const order:string[]=[];
 const pending=runRepairAgent({kind:'repair',cwd:root,prompt:'disposable',outputPath:root+'/output',finalMessagePath:root+'/final',deadlineMs:Date.now()+15000,
  onSpawn:async pid=>{ownedPid=pid;order.push('spawn-held');spawnSeen.resolve();await spawn.promise;order.push('spawn-durable');},
  onSession:async id=>{assert.equal(id,uuid);order.push('session-held');sessionSeen.resolve();await session.promise;order.push('session-durable');}},process.cwd()).then(code=>{done=true;return code;});
 await spawnSeen.promise;await until(()=>existsSync(root+'/emitted'));
 await until(()=>!existsSync(`/proc/${ownedPid}`));
 assert.equal(done,false);assert.deepEqual(order,['spawn-held']);spawn.resolve();
 await sessionSeen.promise;assert.equal(done,false);session.resolve();assert.equal(await pending,0);
 assert.ok(readFileSync(root+'/output','utf8').includes(uuid));
 writeProvider(true);ownedPid=0;
 const error=new Error('original asynchronous bookkeeping refusal');
 await assert.rejects(runRepairAgent({kind:'repair',cwd:root,prompt:'disposable',outputPath:root+'/rejected-output',finalMessagePath:root+'/final',deadlineMs:Date.now()+15000,
  onSpawn:async pid=>{ownedPid=pid;await Promise.resolve();},onSession:async()=>{await Promise.resolve();throw error;}},process.cwd()),e=>e instanceof RepairAttemptIntegrityError&&e.message.includes(error.message));
 assert.throws(()=>process.kill(ownedPid,0));assert.ok(readFileSync(root+'/rejected-output','utf8').includes(uuid));
 console.log(JSON.stringify({actualProducer:true,childExitWhileSpawnHeld:true,order,successWaitsBookkeeping:true,asynchronousFailureStopsOwnedGroup:true,originalOutputRetained:true}));
} finally {if(ownedPid)try{process.kill(-ownedPid,'SIGKILL');}catch{}rmSync(root,{recursive:true,force:true});}
