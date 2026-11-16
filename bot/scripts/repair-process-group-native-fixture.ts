import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,chmodSync,rmSync,readdirSync,readlinkSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';

// No application graph is imported until the independent outer entrance proved
// process, store, executable and provider-home isolation.
assert.equal(process.env.CONCIERGE_PRIVATE_CODE_BOUNDARY_VERIFIED,'1');
assert.ok(process.env.CONCIERGE_PRIVATE_CODE_STATE);
const {runRepairAgent,RepairAttemptIntegrityError,RepairAttemptStoppedError}=await import('../src/deployment-repair-agent');
const root=mkdtempSync('/tmp/repair-group-native-');
const uuid='01a039f1-9e1b-71d1-8f89-a6431c3d53b0';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve};};
const until=async(check:()=>boolean)=>{const deadline=Date.now()+10000;while(!check()){assert.ok(Date.now()<deadline,'bounded owned native barrier');await Bun.sleep(2);}};
const alive=(pid:number)=>{try{return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`,'utf8'));}catch{return false;}};
const ppid=(pid:number)=>Number(readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1]!.split(' ')[1]);
const processes=new Set<number>();
const negativeSignals:number[]=[];
const kill=process.kill.bind(process);
process.kill=((pid:number,signal?:NodeJS.Signals|number)=>{if(pid<0)negativeSignals.push(pid);return kill(pid,signal);}) as typeof process.kill;
const cases:any[]=[];
let count=0;
function provider(mode:'exit'|'survivor'|'resident') {
 const dir=join(root,String(++count));require('node:fs').mkdirSync(dir);
 const executable=join(dir,'provider');
 const survivor=mode==='survivor';
 const descendant=`process.on('SIGTERM',()=>{});await Bun.write(${JSON.stringify(join(dir,'descendant-ready'))},String(process.pid));setInterval(()=>{},1000);`;
 const code=`#!${process.execPath}
if(process.argv.includes('--help'))process.exit(0);
import{spawn}from'node:child_process';import{existsSync}from'node:fs';
if(${survivor}){spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'}).unref();while(!existsSync(${JSON.stringify(join(dir,'descendant-ready'))}))await Bun.sleep(1);}
await Bun.write(${JSON.stringify(join(dir,'identity'))},JSON.stringify({pid:process.pid,ppid:process.ppid,fd:process.env.CONCIERGE_RELEASE_LIFETIME_FD??null,generation:process.env.CONCIERGE_RELEASE_LIFETIME_GENERATION??null}));
process.stderr.write('original-stderr\\n');
process.stdout.write(JSON.stringify({thread_id:${JSON.stringify(uuid)},text:'exact \\u2028 \\u2029 bytes'})+'\\n');
process.stdout.write('unterminated-original-record');
${mode==='resident'?"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);":''}
`;
 writeFileSync(executable,code);chmodSync(executable,0o700);
 process.env.CONCIERGE_CODEX_BIN=executable;
 const input={kind:'repair' as const,cwd:dir,prompt:'scratch native custody',outputPath:join(dir,'output'),finalMessagePath:join(dir,'final'),deadlineMs:Date.now()+20000};
 return{dir,input};
}
function retainOutput(dir:string){const output=readFileSync(join(dir,'output'),'utf8');assert.ok(output.includes('original-stderr\n'));assert.ok(output.includes('exact \u2028 \u2029 bytes'));assert.ok(output.includes('unterminated-original-record\n'));}
async function failureAfterExit(callback:'spawn'|'session',survivor:boolean,guardianLoss=false){
 const {dir,input}=provider(survivor?'survivor':'exit');
 const held=deferred(),seen=deferred();let providerPid=0,guardianPid=0;
 const refusal='original late '+callback+' rejection';
 const pending=runRepairAgent({...input,onSpawn:async pid=>{providerPid=pid;processes.add(pid);guardianPid=ppid(pid);processes.add(guardianPid);if(callback==='spawn'){seen.resolve();await held.promise;throw Error(refusal);}},
 onSession:async id=>{assert.equal(id,uuid);seen.resolve();await held.promise;throw Error(refusal);}},process.cwd());
 const settled=pending.then(()=>({error:null}),error=>({error}));
 await seen.promise;try{await until(()=>existsSync(join(dir,'identity'))&&!alive(providerPid));}catch(error){console.error({dir,callback,survivor,guardianLoss,providerPid,guardianPid,output:existsSync(input.outputPath)?readFileSync(input.outputPath,'utf8'):'none'});throw error;}
 let descendant=0;
 if(survivor){descendant=Number(readFileSync(join(dir,'descendant-ready'),'utf8'));processes.add(descendant);assert.equal(alive(descendant),true);}
 assert.equal(alive(guardianPid),true,'guardian anchors group after provider exit');
 if(guardianLoss){kill(guardianPid,'SIGKILL');await until(()=>!alive(guardianPid));}
 held.resolve();const result=await settled;
 assert.ok(result.error,'bookkeeping rejection is not success');
 if(!guardianLoss){assert.ok(result.error instanceof RepairAttemptIntegrityError);assert.ok(result.error.message.includes(refusal));}
 await until(()=>!alive(guardianPid));
 if(descendant){if(guardianLoss)assert.equal(alive(descendant),true,'dead guardian cannot rediscover a group target');else await until(()=>!alive(descendant));}
 assert.deepEqual(negativeSignals,[],'caller never signals a numeric process group');retainOutput(dir);
 cases.push({callback,survivor,guardianLoss,providerPid,guardianPid,descendant,error:String(result.error),negativeSignals:[...negativeSignals]});
}
try{
 // Deliberately stale inherited release markers may never describe fd3's status pipe.
 process.env.CONCIERGE_RELEASE_LIFETIME_FD='3';process.env.CONCIERGE_RELEASE_LIFETIME_GENERATION='a'.repeat(64);
 await failureAfterExit('spawn',false);
 await failureAfterExit('session',false);
 await failureAfterExit('session',true);
 await failureAfterExit('session',true,true);
 // Existing deadline and five-second escalation stay physical while business
 // bookkeeping is held. A TERM-ignoring provider must die before that hold opens.
 {
  const {dir,input}=provider('resident'),held=deferred(),seen=deferred();let pid=0,guardian=0,settled=false;
  const started=performance.now();
  const pending=runRepairAgent({...input,deadlineMs:Date.now()+1000,onSpawn:async value=>{pid=value;processes.add(pid);guardian=ppid(pid);processes.add(guardian);seen.resolve();await held.promise;},onSession:()=>{}},process.cwd());
  const result=pending.then(()=>{settled=true;return null;},error=>{settled=true;return error;});
  await seen.promise;await until(()=>existsSync(join(dir,'identity')));await until(()=>!alive(pid));
  assert.equal(settled,false);assert.ok(performance.now()-started>=5000,'existing grace elapsed');held.resolve();
  const error=await result;assert.ok(error instanceof RepairAttemptStoppedError);retainOutput(dir);
  cases.push({deadlineWhileBookkeepingHeld:true,graceElapsedMs:performance.now()-started,error:String(error)});
 }
 // A vanished caller closes only its own pipe; the still-owned guardian stops
 // its current group without waiting for business code or rediscovering a PID.
 {
  const {dir,input}=provider('resident');
  const harness=join(dir,'caller.ts'),identity=join(dir,'caller-identity');
  writeFileSync(harness,`import{writeFileSync,existsSync}from'node:fs';
if(process.env.CONCIERGE_PRIVATE_CODE_BOUNDARY_VERIFIED!=='1')throw Error('outer boundary required');
const{runRepairAgent}=await import(${JSON.stringify(join(import.meta.dir,'../src/deployment-repair-agent.ts'))});
void runRepairAgent({...${JSON.stringify(input)},onSpawn:async pid=>{writeFileSync(${JSON.stringify(identity)},String(pid));await new Promise(()=>{});},onSession:()=>{}},${JSON.stringify(process.cwd())});
while(!existsSync(${JSON.stringify(join(dir,'identity'))}))await Bun.sleep(1);
await Bun.write(${JSON.stringify(join(dir,'caller-ready'))},'1');
await new Promise(resolve=>process.stdin.once('data',resolve));process.exit(19);`);
  const caller=spawn(process.execPath,[harness],{stdio:['pipe','pipe','pipe']});processes.add(caller.pid!);
  const closed=new Promise<number|null>(resolve=>caller.once('close',code=>resolve(code)));
  let errors='';caller.stderr!.on('data',chunk=>errors+=String(chunk));caller.stdout!.resume();
  await until(()=>existsSync(join(dir,'caller-ready')));
  const pid=Number(readFileSync(identity,'utf8')),guardian=ppid(pid);processes.add(pid);processes.add(guardian);
  const privatePipes=[0,3].map(fd=>readlinkSync(`/proc/${guardian}/fd/${fd}`));
  const inherited=readdirSync(`/proc/${pid}/fd`).flatMap(fd=>{try{return[readlinkSync(`/proc/${pid}/fd/${fd}`)];}catch{return[];}});
  assert.equal(privatePipes.some(pipe=>inherited.includes(pipe)),false,'provider inherits neither guardian control nor status');
  caller.stdin!.end('exit');assert.equal(await closed,19,errors);
  await until(()=>!alive(pid)&&!alive(guardian));
  cases.push({callerEofCleanup:true,termIgnoringProviderStopped:true,privateControlAndStatusNotInherited:true});
 }
 // Success retains the baseline boundary: the guardian releases after logical
 // drain; detached descendants with closed stdio are not promised completed.
 {
  const {dir,input}=provider('survivor');let pid=0,guardian=0;
  const code=await runRepairAgent({...input,onSpawn:value=>{pid=value;guardian=ppid(pid);processes.add(pid);processes.add(guardian);},onSession:()=>{}},process.cwd());
  const identity=JSON.parse(readFileSync(join(dir,'identity'),'utf8'));
  assert.equal(identity.pid,pid);assert.equal(identity.ppid,guardian);assert.equal(identity.fd,null);assert.equal(identity.generation,null);
  assert.equal(code,0);assert.equal(alive(guardian),false);
  const descendant=Number(readFileSync(join(dir,'descendant-ready'),'utf8'));processes.add(descendant);assert.equal(alive(descendant),true);retainOutput(dir);
  cases.push({success:true,actualProviderIdentity:true,releaseMarkersRemoved:true,descendantCompletionNotClaimed:true});
 }
 console.log(JSON.stringify({fixture:'repair-process-group-native',cases,negativeSignals,independentBoundary:true}));
}finally{
 process.kill=kill;
 for(const pid of processes)if(alive(pid))try{kill(pid,'SIGKILL');}catch{}
 rmSync(root,{recursive:true,force:true});
}
