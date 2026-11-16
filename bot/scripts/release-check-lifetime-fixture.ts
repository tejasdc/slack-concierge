import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {runFixtureChild,fixtureGroupNativeExited} from './fixture-child';

const nativeExited=(pid:number)=>{try{return readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1]!.startsWith('Z ');}catch{return true;}};
const mode=process.argv[2],directory=process.argv[3];
const wait=async(check:()=>boolean|Promise<boolean>,label='owned child readiness')=>{const deadline=Date.now()+5000;while(!await check()){assert.ok(Date.now()<deadline,label);await Bun.sleep(2);}};
if(mode==='--leaf') {
 writeFileSync(join(directory!,'leaf.pid'),String(process.pid));
 setInterval(()=>{},1000);
 await new Promise(()=>{});
} else if(mode==='--nested') {
 const fields=readFileSync('/proc/self/stat','utf8').split(') ')[1]!.split(' ');
 writeFileSync(join(directory!,'group.pid'),fields[2]!);
 await runFixtureChild({command:process.execPath,args:[import.meta.path,'--leaf',directory!],env:process.env,
  deadlineMs:60_000,fixture:'nested-child',requireCheckpoint:false});
} else if(mode==='--inherited-pipe') {
 spawn(process.execPath,[import.meta.path,'--leaf',directory!],{stdio:['ignore','inherit','inherit']});
 await wait(()=>existsSync(join(directory!,'leaf.pid')));process.exit(0);
} else if(mode==='--guardian'||mode==='--guardian-hard') {
 const pending=runFixtureChild({command:process.execPath,args:[import.meta.path,'--nested',directory!],env:process.env,
  deadlineMs:60000,fixture:'root-guardian',requireCheckpoint:false,requireOwnedGroup:true});
 if(mode==='--guardian-hard'){await wait(()=>existsSync(join(directory!,'leaf.pid')));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);}
 let error:string|null=null;try{await pending;}catch(failure){error=String(failure);}
 const leaf=Number(readFileSync(join(directory!,'leaf.pid'),'utf8'));
 writeFileSync(join(directory!,'guardian.return'),JSON.stringify({error,leafNativeExited:nativeExited(leaf)}));
 process.exitCode=error?1:0;
} else {
 const root=mkdtempSync('/tmp/release-check-lifetime-'),owned:number[]=[];
 try {
  const {runCheckSuite,selectReleaseCheckGroup,releaseCheckMatrix}=await import(process.env.CHECK_RUNNER_MODULE??'./run-release-checks');
  const inventory=JSON.parse(readFileSync(join(import.meta.dir,'release-checks.json'),'utf8'));
  assert.deepEqual(releaseCheckMatrix().include.map((row:{group:string})=>row.group),Object.keys(inventory));
  const {default:sharedInventory}=await import('./release-checks.json');
  const mutableInventory=sharedInventory as Record<string,string[][]>;
  try {
   mutableInventory['fixture-added-group']=[['not-executed']];
   assert.ok(releaseCheckMatrix().include.some(row=>String(row.group)==='fixture-added-group'),'matrix derives newly declared groups');
   assert.equal(selectReleaseCheckGroup(['--group','fixture-added-group']),'fixture-added-group');
   mutableInventory['fixture-added-group']=[];
   assert.throws(()=>releaseCheckMatrix(),/must contain commands/,'a missing command group cannot produce a passing matrix');
  }finally{delete mutableInventory['fixture-added-group'];}
  for(const group of Object.keys(inventory))assert.equal(selectReleaseCheckGroup(['--group',group]),group);
  assert.equal(selectReleaseCheckGroup([]),'build');assert.equal(selectReleaseCheckGroup(['--history-cache']),'historyCache');
  for(const args of [['--ci'],['--group'],['--group','missing'],['--group','build','--history-cache']])assert.throws(()=>selectReleaseCheckGroup(args));
  const workflow=readFileSync(join(import.meta.dir,'../../.github/workflows/release-check.yml'),'utf8');
  const fanIn=/# release-check-fan-in-start\n([\s\S]*?)\n\s*# release-check-fan-in-end/.exec(workflow)?.[1];
  assert.ok(fanIn,'exercise the actual required-result shell, not a fixture copy');
  const success={...process.env,SELECTION_RESULT:'success',GROUP_RESULT:'success',SELECTED_SOURCE:'same-source',GITHUB_SHA:'same-source'};
  assert.equal(Bun.spawnSync(['/usr/bin/bash','-c',fanIn],{env:success,stdout:'pipe',stderr:'pipe'}).exitCode,0);
  for(const failure of [{SELECTION_RESULT:'failure'},{SELECTION_RESULT:'cancelled'},{GROUP_RESULT:'failure'},
   {GROUP_RESULT:'cancelled'},{GROUP_RESULT:'skipped'},{GROUP_RESULT:''},{SELECTED_SOURCE:''},{GITHUB_SHA:''},{SELECTED_SOURCE:'different-source'}]){
   assert.notEqual(Bun.spawnSync(['/usr/bin/bash','-c',fanIn],{env:{...success,...failure},stdout:'pipe',stderr:'pipe'}).exitCode,0,JSON.stringify(failure));
  }
  const started=performance.now();
  await assert.rejects(runCheckSuite([[process.execPath,import.meta.path,'--nested',root]],{
   deadlineAt:Date.now()+1000,parallelChecks:1,root:join(root,'checks')}),error=>/cancelled|deadline/.test(String(error)));
  const nested=Number(readFileSync(join(root,'leaf.pid'),'utf8'));owned.push(nested);
  console.error(JSON.stringify({phase:'nested-cancelled',pid:nested,nativeExited:nativeExited(nested)}));
  assert.ok(nativeExited(nested),'nested descendant must complete native exit at helper return');
  const elapsedMs=Math.round(performance.now()-started);assert.ok(elapsedMs>=950&&elapsedMs<6000,'causal deadline and cleanup bound');
  rmSync(join(root,'leaf.pid'));
  await runFixtureChild({command:process.execPath,args:[import.meta.path,'--inherited-pipe',root],env:process.env,
   deadlineMs:2000,fixture:'inherited-pipe',requireCheckpoint:false});
  const inherited=Number(readFileSync(join(root,'leaf.pid'),'utf8'));owned.push(inherited);
  assert.ok(nativeExited(inherited),'inherited-pipe descendant must complete native exit at helper return');
  rmSync(join(root,'leaf.pid'));
  await assert.rejects(runFixtureChild({command:process.execPath,args:[import.meta.path,'--leaf',root],env:{...process.env,CONCIERGE_FIXTURE_SHARED_GROUP:'1'},deadlineMs:1000,fixture:'root-shared-refusal',requireCheckpoint:false,requireOwnedGroup:true}),/requires its own process group/);
  assert.equal(existsSync(join(root,'leaf.pid')),false,'refusal precedes child spawn');
  const guards=[];
  for(const mode of ['--guardian','--guardian-hard']) {
   for(const file of ['leaf.pid','group.pid','guardian.return'])rmSync(join(root,file),{force:true});
   const child=spawn('/usr/bin/timeout',['--kill-after=1s','1s',process.execPath,import.meta.path,mode,root],{stdio:['ignore','pipe','pipe']});
   const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code));child.stdout?.resume();child.stderr?.resume();});
   const group=Number(readFileSync(join(root,'group.pid'),'utf8'));
   const leaf=Number(readFileSync(join(root,'leaf.pid'),'utf8'));owned.push(leaf);assert.notEqual(code,0);
   if(mode==='--guardian'){const receipt=JSON.parse(readFileSync(join(root,'guardian.return'),'utf8'));assert.equal(receipt.leafNativeExited,true);assert.equal(await fixtureGroupNativeExited(group),true);guards.push({mode,code,cleanupAtReturn:true});}
   else {assert.equal(existsSync(join(root,'guardian.return')),false);await wait(()=>fixtureGroupNativeExited(group),'exact-pipe EOF owned group cleanup');assert.ok(nativeExited(leaf));guards.push({mode,code,passingReceipt:false,callerHardKillEofCleanup:true,nativeGroupEnded:true});}
  }
  console.log(JSON.stringify({fixture:'release-check-lifetime',nestedDeadlineFails:true,nestedNativeExit:true,
   inheritedPipeNativeExit:true,elapsedMs,boundMs:6000,cleanupIncludesOwnedGroupExit:true,leafNativeExitAtReturn:true,rootSharedStateRefused:true,guards}));
 } finally {
  for(const pid of owned)if(!nativeExited(pid))try{process.kill(pid,'SIGKILL');}catch{}
  rmSync(root,{recursive:true,force:true});
 }
}
