import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {mock,spyOn} from 'bun:test';

const cases=['automatic','historical','pending','mismatch','persistence','compatibility','response-loss'];
if(!process.argv.includes('--case')){
  for(const name of cases){
    const root=fs.mkdtempSync(join(os.tmpdir(),'concierge-runtime-terminal-'));
    try{
      const child=Bun.spawn([process.execPath,import.meta.path,'--case',name,root],{stdout:'pipe',stderr:'pipe'});
      const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
      assert.equal(code,0,`${name}: ${err}`);process.stdout.write(out);
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  }
  process.exit(0);
}
const name=process.argv.at(-2)!,root=process.argv.at(-1)!;
const restarting=name==='restart',privateHome=join(root,'provider-home'),runnerState=join(root,'runner');
fs.mkdirSync(privateHome,{recursive:true});fs.mkdirSync(runnerState,{recursive:true});
process.env.CONCIERGE_STATE_DIR=root;process.env.CONCIERGE_CAPTURE_STATE_DIR=join(root,'capture');
process.env.CONCIERGE_RUNNER_STATE=runnerState;process.env.CONCIERGE_CODEX_RUNNER='fixture-runner';
process.env.CONCIERGE_TEST_MODE='1';
const {CODEX_RUNTIME_MAINTENANCE_TEST_AUTHORIZATION}=await import('../src/test-authorizations');
process.env.CONCIERGE_TEST_AUTHORIZATION=CODEX_RUNTIME_MAINTENANCE_TEST_AUTHORIZATION;
mock.module('node:os',()=>({...os,homedir:()=>privateHome}));

const state=await import('../src/state');
const {db,claimNextQueuedTurn,holdCodexAdmission,codexAdmissionRecoveryHolds}=state;
const {createNativeSession,retainSessionInput,enqueueSessionInput,nativeRunId}=await import('../src/session-inputs');
let session:number,turn:number,source:string,run:string,binding:any,actionInput:string;
if(restarting){({session,turn,source,run,binding,actionInput}=JSON.parse(fs.readFileSync(join(root,'fixture-identity.json'),'utf8')));}
else{
  const worker=createNativeSession('codex',{title:'Owned runtime terminal fixture',outside:true});session=worker.id;
  source=retainSessionInput({id:'fixture-source',sessionId:session,scope:'fixture',actionId:'source',kind:'input',origin:'agent',payload:{text:'Maintain this exact runtime.'}}).input.id;
  enqueueSessionInput(source);turn=claimNextQueuedTurn('terminal-fixture')!.turn_id;run=nativeRunId(turn);
  const actionId='same-maintenance';
  binding={operationId:`runtime:${createHash('sha256').update(source).update('\0').update(run).update('\0').update(actionId).digest('hex').slice(0,40)}`,
    sourceInputId:source,sourceRunId:run,actionId,requiredCommit:'b'.repeat(40)};
  actionInput=retainSessionInput({sessionId:session,scope:`communication:${source}`,actionId,kind:'action',origin:'agent',
    payload:{kind:'codex-runtime-maintenance',runner:'fixture-runner',binding},sourceInputId:source,sourceRunId:run}).input.id;
  db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({phase:'waiting',operationId:binding.operationId}),actionInput);
}
const original={pid:800001,startTicks:'111',bootId:'fixture-boot'},replacement={pid:800002,startTicks:'222',bootId:'fixture-boot'};
const journal=join(runnerState,'codex-activation-state.json');
const pending=name==='automatic'||name==='pending'||name==='response-loss';
if(!restarting)fs.writeFileSync(journal,JSON.stringify([{id:binding.operationId,account:'',status:pending?'starting':'applied',
  runtimeMaintenance:{binding,phase:pending?'waiting':'applied',original,...(pending?{}:{replacement,detail:'Masked replacement and provider API confirmed.'})}}]));
const holder=`codex:runner-runtime-maintenance:fixture-runner:${binding.operationId}`;
if(!restarting)holdCodexAdmission(holder,true,{kind:'runner-runtime-maintenance',runner:'fixture-runner',...binding});
const receipt=()=>JSON.parse((db.query('SELECT receipt_json FROM session_inputs WHERE id=?').get(actionInput) as {receipt_json:string}).receipt_json);
const isHeld=()=>codexAdmissionRecoveryHolds().some(row=>row.holder===holder);
let snapshot:any={identity:pending?original:replacement,masked:!pending,supported:true};
let oldAlive=pending,signals=0,starts=0,mutations=0,observations=0,ownerProofs=0,nativeIdle=false,external=0;
let badObservation:unknown=null,lost=false,changeAtOwnerProof=false,ownerProofFailure=false;
const daemon=await import('../src/codex-daemon-file-limit');
mock.module('../src/codex-daemon-file-limit',()=>({...daemon,
  controlSocketListeners:()=>snapshot?[snapshot.identity.pid]:[],holdCodexDaemonAutoStart:()=>{},
  startCodexDaemonInOwnScope:async()=>{starts++;snapshot={identity:replacement,masked:true,supported:true};return {code:0};},
}));
const identities=await import('../src/runtime-identity');
mock.module('../src/runtime-identity',()=>({...identities,
  processIdentity:(pid:number)=>{assert.equal(pid,snapshot.identity.pid);return {...snapshot.identity};},
  isProcessIdentityAlive:(identity:any)=>identity.pid===original.pid?oldAlive:!!snapshot&&identity.startTicks===snapshot.identity.startTicks,
}));
mock.module('node:fs',()=>({...fs,statSync:(path:any,...args:any[])=>String(path).startsWith('/proc/80000')
  ?{isCharacterDevice:()=>snapshot?.masked,rdev:snapshot?.masked?0:123}:Reflect.apply(fs.statSync,fs,[path,...args])}));
const client=await import('../src/codex-app-server-client');
mock.module('../src/codex-app-server-client',()=>({...client,
  CodexAppServerClient:class{
    async request(method:string){
      if(method==='model/list')return {data:[{id:'fixture'}]};
      if(method==='thread/loaded/list')return {data:nativeIdle?[]:['fixture-thread']};
      if(method==='thread/read')return {thread:{status:{type:'active'}}};
      throw new Error(`Unexpected runner provider read ${method}`);
    }
    async close(){}
  },
  sharedCodexAppServerClient:()=>({request:async(method:string)=>{assert.equal(method,'model/list');ownerProofs++;
    if(ownerProofFailure)throw new Error('owner API proof refused');
    if(changeAtOwnerProof)snapshot={...snapshot,identity:{...replacement,startTicks:'changed'}};
    return {data:[{id:'fixture'}]};}}),
}));
const activation=await import('../src/provider-activation');
mock.module('../src/provider-activation',()=>({...activation,externallyRunningCodexTurns:()=>external}));
mock.module('../src/codex-updater-settings',()=>({codexUpdaterDisabled:()=>true}));
let serve:any;
mock.module('../src/runner-machine-calls',()=>({
  RunnerUnreachableError:class extends Error{},RunnerCallNotSentError:class extends Error{},RunnerMachineCallError:class extends Error{},
  runnerMachineCall:async(runner:string,method:string,params:any)=>{
    assert.equal(runner,'fixture-runner');
    if(method.endsWith('.observe')){observations++;if(badObservation==='unsupported')throw new Error('this runner does not answer terminal observation');
      if(badObservation!==null)return badObservation;}
    else{assert.equal(method,'accounts.codex.runtimeMaintenance');mutations++;}
    const answer=await serve(method,params,{activeTurns:0,botDir:join(root,'release','control','bot')});
    if(lost&&!method.endsWith('.observe')&&answer.phase==='applied'){lost=false;throw new Error('response lost after runner applied');}
    return answer;
  },
}));
const spawn=spyOn(Bun,'spawn').mockImplementation(((command:any)=>{
  assert(Array.isArray(command));
  assert(command[0]==='/usr/bin/git'||/^\/proc\/80000[12]\/exe$/.test(command[0]),`Unexpected process launch ${command[0]}`);
  return {stdout:new Blob([command[0]==='/usr/bin/git'?'':'codex-cli 0.166.0\n']).stream(),stderr:new Blob([]).stream(),exited:Promise.resolve(0),kill(){throw new Error('Unexpected kill');}};
}) as any);
const kill=spyOn(process,'kill').mockImplementation(((pid:number,signal:string)=>{assert.equal(pid,original.pid);assert.equal(signal,'SIGHUP');signals++;oldAlive=false;snapshot=null;return true;}) as any);
fs.mkdirSync(join(root,'release'),{recursive:true});fs.writeFileSync(join(root,'release','manifest.json'),JSON.stringify({control_git_commit:'b'.repeat(40)}));
try{
  ({serveRunnerAccountCall:serve}=await import('../src/runner-provider-accounts'));
  const owner=await import('../src/runner-provider-account-owner');
  const {SessionCommunicationCoordinator}=await import('../src/session-communication');
  const coordinator=Object.create(SessionCommunicationCoordinator.prototype) as any;
  coordinator.stopped=false;coordinator.actor=()=>({turn,session,inputId:source});coordinator.fenced=(actor:any)=>actor;coordinator.authority=(actor:any)=>({actor,scope:'work'});
  const input={source:{input_id:source,run_id:run},action_id:binding.actionId,required_commit:binding.requiredCommit};
  const progress=()=>coordinator.codexMaintenance(input);
  const activeWork=()=>{const shared=createNativeSession('codex',{title:'Later shared work'});db.query("INSERT INTO turns(session_id,slack_user_msg_ts,user_text,status) VALUES(?,?,?,'running')").run(shared.id,'later','Later shared work');};
  if(name==='automatic'){
    const staleWaiting=receipt();
    holdCodexAdmission('other-account',true,{kind:'runner-activation',runner:'other-runner',account:'fixture',operationId:'other'});
    holdCodexAdmission('other-rehome',true,{kind:'runner-rehome',runner:'other-runner'});
    const otherBinding={...binding,operationId:`runtime:${'c'.repeat(40)}`};
    holdCodexAdmission('other-maintenance',true,{kind:'runner-runtime-maintenance',runner:'other-runner',...otherBinding});
    nativeIdle=true;
    await owner.resumeRunnerCodexRuntimeMaintenance();await owner.resumeRunnerCodexRuntimeMaintenance();
    // Await the exact in-flight boundary as well: the historical recovery API returned void.
    // This makes the same source regression deterministic even against that older signature.
    await owner.progressRunnerCodexRuntimeMaintenance('fixture-runner',binding);
    await owner.progressRunnerCodexRuntimeMaintenance('fixture-runner',binding);
    assert.equal(receipt().phase,'applied','automatic completion must persist the original terminal receipt before reopening');
    assert.equal(isHeld(),false);assert(codexAdmissionRecoveryHolds().some(row=>row.holder==='other-account'));
    assert(codexAdmissionRecoveryHolds().some(row=>row.holder==='other-rehome'));
    assert(codexAdmissionRecoveryHolds().some(row=>row.holder==='other-maintenance'));
    assert.equal(signals,1);assert.equal(starts,1);assert.deepEqual(receipt().replacement,replacement);
    activeWork();const before=[mutations,observations,ownerProofs,signals,starts];
    assert.equal((await progress()).phase,'applied');assert.deepEqual([mutations,observations,ownerProofs,signals,starts],before);
    assert.equal(state.recordCodexRuntimeMaintenanceProgress('fixture-runner',binding,staleWaiting).phase,'applied');
    assert.equal(receipt().phase,'applied','stale waiting must not replace terminal completion');
    fs.writeFileSync(join(root,'fixture-identity.json'),JSON.stringify({session,turn,source,run,binding,actionInput}));
    db.close();spawn.mockRestore();kill.mockRestore();
    const child=Bun.spawn([process.execPath,import.meta.path,'--case','restart',root],{stdout:'pipe',stderr:'pipe'});
    const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);assert.equal(code,0,err);process.stdout.write(out);
  }else if(name==='restart'){
    assert.equal((await progress()).phase,'applied');assert.equal(mutations+observations+signals+starts,0);assert.equal(isHeld(),false);
  }else if(name==='pending'){
    activeWork();assert.equal((await progress()).phase,'waiting');assert.equal(mutations+signals+starts,0);assert(isHeld());
    external=-1;db.query("UPDATE turns SET status='done' WHERE id<>?").run(turn);
    assert.equal((await progress()).phase,'waiting');assert.equal(mutations+signals+starts,0);
  }else if(name==='compatibility'){
    activeWork();
    for(const malformed of ['unsupported',undefined,{}, {verified:true,applied:null}]){
      badObservation=malformed;assert.equal((await progress()).phase,'uncertain');assert(isHeld());assert.equal(mutations+signals+starts,0);
    }
  }else if(name==='mismatch'){
    activeWork();const retainedJournal=fs.readFileSync(journal,'utf8');
    for(const changed of [null,{identity:{...replacement,startTicks:'changed'},masked:true,supported:true},{identity:replacement,masked:false,supported:true}]){
      snapshot=changed;const result=await progress();assert.equal(result.phase,'uncertain');assert.equal(result.applied.phase,'applied');assert(isHeld());
      assert.equal(fs.readFileSync(journal,'utf8'),retainedJournal);assert.equal(mutations+signals+starts,0);
      await assert.rejects(()=>serve('accounts.codex.runtimeMaintenance',{binding}),/replacement/);
      assert.equal(fs.readFileSync(journal,'utf8'),retainedJournal);assert.equal(signals+starts,0);
    }
    snapshot={identity:replacement,masked:true,supported:true};ownerProofFailure=true;
    assert.equal((await progress()).phase,'uncertain');assert(isHeld());assert.equal(mutations+signals+starts,0);
    ownerProofFailure=false;changeAtOwnerProof=true;
    assert.equal((await progress()).phase,'uncertain');assert(isHeld());assert.equal(mutations+signals+starts,0);
  }else if(name==='persistence'){
    activeWork();
    db.exec("CREATE TRIGGER refuse_terminal_fixture BEFORE UPDATE OF receipt_json ON session_inputs WHEN json_extract(NEW.receipt_json,'$.phase')='applied' BEGIN SELECT RAISE(ABORT,'fixture persistence refused'); END");
    await assert.rejects(progress(),/fixture persistence refused/);assert(isHeld());assert.equal(receipt().phase,'waiting');
    db.exec('DROP TRIGGER refuse_terminal_fixture');
    db.exec("CREATE TRIGGER refuse_release_fixture BEFORE DELETE ON codex_admission_holds BEGIN SELECT RAISE(ABORT,'fixture hold release refused'); END");
    await assert.rejects(progress(),/fixture hold release refused/);assert(isHeld());assert.equal(receipt().phase,'waiting','failed exact hold deletion rolls back the receipt too');
    const queued=createNativeSession('codex',{title:'Queue remains conservatively held'});
    const input=retainSessionInput({sessionId:queued.id,scope:'fixture',actionId:'queued',kind:'input',origin:'agent',payload:{text:'Wait.'}}).input;
    enqueueSessionInput(input.id);assert.equal(claimNextQueuedTurn('conservative-holder'),null,'failed commit leaves the in-memory admission projection held');
    db.exec('DROP TRIGGER refuse_release_fixture');
    db.exec("CREATE TRIGGER terminal_before_release_fixture BEFORE DELETE ON codex_admission_holds WHEN (SELECT json_extract(receipt_json,'$.phase') FROM session_inputs WHERE id='"+actionInput+"')<>'applied' BEGIN SELECT RAISE(ABORT,'terminal receipt missing at release'); END");
    assert.equal((await progress()).phase,'applied');assert.equal(isHeld(),false);assert.equal(mutations+signals+starts,0);
    assert.equal(claimNextQueuedTurn('released-holder')?.session_id,queued.id);
  }else if(name==='response-loss'){
    // A lost answer after durable runner completion must reconcile even after later owned work.
    nativeIdle=true;assert.equal((await progress()).phase,'draining');lost=true;
    assert.equal((await progress()).phase,'uncertain');assert(isHeld());
    assert.equal(JSON.parse(fs.readFileSync(journal,'utf8'))[0].runtimeMaintenance.phase,'applied');
    const mutationsBefore=[mutations,signals,starts];activeWork();
    assert.equal((await progress()).phase,'applied');assert.deepEqual([mutations,signals,starts],mutationsBefore);assert.equal(isHeld(),false);
  }else{
    holdCodexAdmission(holder,false);activeWork();const observedJournal=fs.readFileSync(journal,'utf8');
    assert.equal((await progress()).phase,'applied');assert.equal(signals+starts+mutations,0);assert.equal(isHeld(),false);
    assert.equal(fs.readFileSync(journal,'utf8'),observedJournal,'terminal-only runner observation must not write the journal');
    for(const key of ['sourceInputId','sourceRunId','actionId','requiredCommit']){
      await assert.rejects(()=>serve('accounts.codex.runtimeMaintenance.observe',{binding:{...binding,[key]:key==='requiredCommit'?'c'.repeat(40):'changed'}}),/cannot change/);
    }
    await assert.rejects(coordinator.codexMaintenance({...input,required_commit:'c'.repeat(40)}),/Idempotency conflict/);
    process.env.CONCIERGE_CODEX_RUNNER='changed-runner';await assert.rejects(progress(),/Idempotency conflict/);process.env.CONCIERGE_CODEX_RUNNER='fixture-runner';
    assert.throws(()=>state.codexRuntimeMaintenanceReceipt('changed-runner',binding),/cannot change/);
    for(const key of ['operationId','sourceInputId','sourceRunId','actionId','requiredCommit']){
      assert.throws(()=>owner.progressRunnerCodexRuntimeMaintenance('fixture-runner',{...binding,[key]:key==='requiredCommit'?'c'.repeat(40):key==='operationId'?`runtime:${'c'.repeat(40)}`:'changed'}),/cannot change/);
    }
    const resumed=(db.query("INSERT INTO turns(session_id,slack_user_msg_ts,user_text,status) VALUES(?,?,?,'running') RETURNING id").get(session,'resume','Resume original operation') as {id:number}).id;
    coordinator.actor=()=>({turn:resumed,session,inputId:'new-live-source'});
    assert.equal((await coordinator.codexMaintenance({...input,action_id:'resume',resume_operation:binding.operationId})).phase,'applied');
    coordinator.actor=()=>({turn:resumed,session:session+1,inputId:'other-worker'});
    await assert.rejects(coordinator.codexMaintenance({...input,action_id:'resume',resume_operation:binding.operationId}),/no such retained/);
  }
  console.log(`PASS runtime terminal ${name}: retained action, runner journal and exact hold boundaries`);
}finally{spawn.mockRestore();kill.mockRestore();try{db.close();}catch{}}
