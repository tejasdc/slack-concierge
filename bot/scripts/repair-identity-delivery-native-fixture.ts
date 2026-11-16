import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,chmodSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';

assert.equal(process.env.CONCIERGE_PRIVATE_CODE_BOUNDARY_VERIFIED,'1');
const root=mkdtempSync('/tmp/repair-identity-native-');
const baseline=process.argv.includes('--baseline');
const source=process.env.REPAIR_IDENTITY_SOURCE_ROOT??join(import.meta.dir,'../src');
const supervisorEntry=baseline?process.env.REPAIR_IDENTITY_BASELINE_SUPERVISOR:join(source,'deployment-repair-supervisor.ts');
const agentEntry=baseline?process.env.REPAIR_IDENTITY_BASELINE_AGENT:join(source,'deployment-repair-agent.ts');
assert.ok(supervisorEntry&&agentEntry,'exact baseline entries required');
const uuid='01a039f1-9e1b-71d1-8f89-a6431c3d53b0';
try{
 const client=join(root,'scratch-client.ts'),wake=join(root,'scratch-wake.ts');
 writeFileSync(client,'export function repairLedgerClient(){return (globalThis as any).__scratchRepairLedger;}');
 writeFileSync(wake,'export function notifyDeploymentWorker(){throw Error("unexpected worker notification");}');
 // Compile the actual supervisor and actual producer. Only ledger transport and
 // unrelated worker notification are substituted; no production endpoint exists.
 const entry=join(root,'entry.ts');
 writeFileSync(entry,`export {DeploymentRepairSupervisor} from ${JSON.stringify(supervisorEntry)};export {runRepairAgent} from ${JSON.stringify(agentEntry)};`);
 const build=await Bun.build({entrypoints:[entry],target:'bun',outdir:root,naming:'supervisor.js',plugins:[{
  name:'scratch-transport-only',setup(build){
   build.onResolve({filter:/deployment-repair-client$/},()=>({path:client}));
   build.onResolve({filter:/deployment-worker-wake$/},()=>({path:wake}));
  },
 }]});assert.equal(build.success,true,build.logs.map(String).join('\n'));
 const {DeploymentRepairSupervisor,runRepairAgent}=await import(join(root,'supervisor.js'));
 const executable=join(root,'provider'),expectedPath=join(root,'expected');
 writeFileSync(executable,`#!${process.execPath}
if(process.argv.includes('--help'))process.exit(0);
import{readFileSync,writeFileSync}from'node:fs';
const fields=readFileSync('/proc/self/stat','utf8').split(') ').at(-1).split(' ');
const identity={pid:process.pid,bootId:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),startTicks:fields[19]};
writeFileSync(${JSON.stringify(expectedPath)},JSON.stringify({identity,guardianPid:process.ppid}));
const final=process.argv[process.argv.indexOf('-o')+1];
writeFileSync(final,JSON.stringify({status:'repair_committed',commit:'a'.repeat(40),summary:'scratch outcome',blocker:null,next_action:'scratch finished'}));
console.log(JSON.stringify({thread_id:${JSON.stringify(uuid)}}));
`);chmodSync(executable,0o700);process.env.CONCIERGE_CODEX_BIN=executable;
 process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT=root;
 const incidentId='scratch-identity';mkdirSync(join(root,'incidents',incidentId),{recursive:true});
 const childRecords:any[]=[],settlements:any[]=[],bindings:any[]=[];
 (globalThis as any).__scratchRepairLedger={
  assertDeploymentRepairOwner:async()=>{},
  getDeploymentRepairBudget:async()=>({attempts:0,maximumAttempts:3,deadlineMs:Date.now()+15000}),
  prepareDeploymentRepairAgentLaunch:async(input:any)=>({id:input.id}),
  recordDeploymentRepairChild:async(id:string,identity:any)=>{assert.equal(existsSync('/proc/'+identity.pid),false);childRecords.push({id,identity});},
  bindDeploymentRepairSession:async(id:string,session:string)=>bindings.push({id,session}),
  settleDeploymentRepairAgent:async(input:any)=>{settlements.push(input);},
 };
 let reapedBeforeStatusDelivery=false;
 const services={command:()=>{throw Error('unexpected host command');},isAlive:()=>false,
  runAgent(input:any){
   const pending=runRepairAgent(input,root);
   // Block this parent's JS/status consumption while the separate guardian runs.
   // The barrier exits only after the actual fast provider's /proc entry is gone.
   const barrier=spawnSync('/usr/bin/python3',['-I','-S','-c',
    "import json,os,sys,time\np=sys.argv[1];end=time.monotonic()+5\nwhile True:\n if time.monotonic()>end:raise SystemExit('scratch provider reap barrier expired')\n try:\n  row=json.load(open(p));pid=row['identity']['pid']\n except (FileNotFoundError,json.JSONDecodeError):time.sleep(.001);continue\n if not os.path.exists('/proc/'+str(pid)):break\n time.sleep(.001)\nprint('provider-reaped-before-parent-status')",expectedPath],{encoding:'utf8'});
   assert.equal(barrier.status,0,barrier.stderr);assert.match(barrier.stdout,/provider-reaped-before-parent-status/);reapedBeforeStatusDelivery=true;
   return pending;
  }};
 const supervisor=new DeploymentRepairSupervisor(incidentId,root,services);
 let result:any,error:any;
 try{result=await (supervisor as any).runPersistedAgent({id:incidentId,worktree_path:root},'scratch fast provider',null);}catch(value){error=value;}
 const expected=JSON.parse(readFileSync(expectedPath,'utf8'));
 assert.equal(reapedBeforeStatusDelivery,true);assert.equal(existsSync('/proc/'+expected.identity.pid),false);
 if(baseline){assert.ok(error);assert.equal(childRecords.length,0);assert.match(String(error),/bookkeeping|ENOENT|no such file/i);assert.equal(settlements.length,1);assert.match(settlements[0].parkError,/ENOENT/);}
 else{assert.equal(error,undefined,String(error));assert.equal(result.status,'repair_committed');assert.equal(childRecords.length,1);assert.deepEqual(childRecords[0].identity,expected.identity);assert.notEqual(childRecords[0].identity.pid,expected.guardianPid);assert.equal(bindings.length,1);assert.equal(bindings[0].session,uuid);}
 console.log(JSON.stringify({fixture:'repair-identity-delivery-native',baseline,reapedBeforeStatusDelivery,actualSupervisor:true,actualProducer:true,expected,childRecords,settlements,bindings,result,error:error?String(error):null,
  boundary:'real scratch provider/native exec/reap; actual supervisor with scratch ledger transport; no PID reuse or provider operation'}));
}finally{delete(globalThis as any).__scratchRepairLedger;rmSync(root,{recursive:true,force:true});}
