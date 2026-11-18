import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseRouterSessionsArgs} from './router-sessions';
import {progressRuntimeMaintenance,type RuntimeMaintenanceState,type RuntimeMaintenanceServices} from '../src/codex-runtime-maintenance';
const binding={operationId:`runtime:${'a'.repeat(40)}`,sourceInputId:'input',sourceRunId:'run',actionId:'maintain',requiredCommit:'b'.repeat(40)};
const old={pid:11,startTicks:'111',bootId:'boot'},replacement={pid:12,startTicks:'112',bootId:'boot'};
let live=true,nativeIdle=false,masked=false,starts=0,signals=0,proofs=0;
let state:RuntimeMaintenanceState={binding,phase:'waiting'},durable=structuredClone(state);
const services:RuntimeMaintenanceServices={persist(){durable=structuredClone(state);},snapshot:async()=>live?{identity:old,masked:false,supported:true}:masked?{identity:replacement,masked:true,supported:true}:null,
  alive:identity=>identity.pid===old.pid&&live,nativeIdle:async()=>nativeIdle,
  signal(identity){assert.deepEqual(identity,old);signals++;},start:async()=>{starts++;masked=true;},prove:async identity=>{assert.deepEqual(identity,replacement);proofs++;}};
await progressRuntimeMaintenance(state,services);assert.equal(signals,0);assert.equal(state.phase,'waiting');
nativeIdle=true;await progressRuntimeMaintenance(state,services);assert.equal(state.phase,'draining');assert.equal(signals,1);
// A native turn racing the idle snapshot is drained by the native receiver, never force-stopped.
nativeIdle=false;await progressRuntimeMaintenance(state,services);assert.equal(state.phase,'draining');assert.equal(signals,2);assert.equal(starts,0);
// Restart immediately after durable intent, before its SIGHUP: the same exact safe signal resumes.
state=structuredClone(durable);await progressRuntimeMaintenance(state,services);assert.equal(signals,3);assert.equal(starts,0);
live=false;await progressRuntimeMaintenance(state,services);assert.equal(state.phase,'applied');assert.equal(starts,1);assert.equal(proofs,1);
await progressRuntimeMaintenance(state,services);assert.equal(starts,1);assert.equal(proofs,2);
const applied=structuredClone(state),terminalStarts=starts,terminalSignals=signals;
await assert.rejects(progressRuntimeMaintenance(state,{...services,snapshot:async()=>null}),/replacement/);
assert.deepEqual(state,applied,'failed terminal health observation cannot regress completion');
assert.equal(starts,terminalStarts);assert.equal(signals,terminalSignals);
// Lost successful start response reconciles the existing masked replacement without another start.
masked=false;state={binding,phase:'draining',original:old};
await progressRuntimeMaintenance(state,{...services,start:async()=>{starts++;masked=true;throw new Error('response lost');}});
assert.equal(state.phase,'uncertain');const before=starts;
await progressRuntimeMaintenance(state,services);assert.equal(state.phase,'applied');assert.equal(starts,before);
// A reused PID/start tick mismatch never signals the unrelated replacement.
live=false;masked=false;state={binding,phase:'draining',original:old};const beforeSignals=signals;
await progressRuntimeMaintenance(state,{...services,snapshot:async()=>({identity:{...old,startTicks:'different'},masked:false,supported:true})});
assert.equal(state.phase,'uncertain');assert.equal(signals,beforeSignals);
// Provider proof failure cannot be reported applied.
masked=true;state={binding,phase:'starting',original:old};
await progressRuntimeMaintenance(state,{...services,prove:async()=>{throw new Error('API unavailable');}});assert.equal(state.phase,'uncertain');
const command=['codex-maintenance','--source-input','input','--source-run','run','--action-id','maintain','--required-commit','b'.repeat(40)];
assert.equal(parseRouterSessionsArgs(command).operation,'codex-maintenance');
assert.throws(()=>parseRouterSessionsArgs(command.slice(0,-2)),/full required commit/);

// Exercise the actual mutation entrance's authority ordering with its established actor resolver
// substituted; an informational helper must not create even an admission hold.
const root=mkdtempSync(join(tmpdir(),'concierge-runtime-authority-'));
process.env.CONCIERGE_STATE_DIR=root;process.env.CONCIERGE_TEST_MODE='1';
const {CODEX_RUNTIME_MAINTENANCE_TEST_AUTHORIZATION}=await import('../src/test-authorizations');
process.env.CONCIERGE_TEST_AUTHORIZATION=CODEX_RUNTIME_MAINTENANCE_TEST_AUTHORIZATION;
try{
  const {SessionCommunicationCoordinator}=await import('../src/session-communication');
  const {db,claimNextQueuedTurn}=await import('../src/state');
  const {createNativeSession,retainSessionInput,enqueueSessionInput}=await import('../src/session-inputs');
  const coordinator=Object.create(SessionCommunicationCoordinator.prototype) as any;
  coordinator.stopped=false;coordinator.actor=()=>({turn:1,session:1,inputId:'input'});coordinator.fenced=(actor:unknown)=>actor;
  coordinator.authority=(actor:unknown)=>({actor,scope:'informational'});
  await assert.rejects(coordinator.codexMaintenance({source:{input_id:'input',run_id:'run'},action_id:'maintain',required_commit:'b'.repeat(40)}),/work authority/);
  assert.equal((db.query('SELECT COUNT(*) AS count FROM codex_admission_holds').get() as {count:number}).count,0);
  const session=createNativeSession('codex',{title:'Owned maintenance fixture source'});
  const accepted=retainSessionInput({sessionId:session.id,scope:'runtime-fixture',actionId:'source',kind:'input',origin:'human',payload:{text:'Exercise runtime maintenance.'}}).input;
  enqueueSessionInput(accepted.id);const claim=claimNextQueuedTurn('runtime-fixture');assert(claim);
  coordinator.actor=()=>({turn:claim.turn_id,session:session.id,inputId:accepted.id});
  coordinator.authority=(actor:unknown)=>({actor,scope:'work'});
  process.env.CONCIERGE_CODEX_RUNNER='owned-runner';
  const input={source:{input_id:accepted.id,run_id:'owned-run'},action_id:'stable-maintenance',required_commit:'b'.repeat(40)};
  const unconfirmed=await coordinator.codexMaintenance(input);assert.equal(unconfirmed.phase,'uncertain');
  assert.equal((db.query('SELECT COUNT(*) AS count FROM codex_admission_holds').get() as {count:number}).count,0,
    'an unavailable terminal observer cannot authorize progress or recreate a hold for an effect that may already be applied');
  await assert.rejects(coordinator.codexMaintenance({...input,required_commit:'c'.repeat(40)}),/Idempotency conflict/);
  // A terminal receipt retains the same payload identity even after its admission holder is gone.
  db.query('UPDATE session_inputs SET receipt_json=? WHERE scope=? AND action_id=?').run(JSON.stringify({phase:'applied'}),`communication:${accepted.id}`,input.action_id);
  db.query('DELETE FROM codex_admission_holds').run();
  await assert.rejects(coordinator.codexMaintenance({...input,required_commit:'c'.repeat(40)}),/Idempotency conflict/);
  process.env.CONCIERGE_CODEX_RUNNER='another-runner';
  await assert.rejects(coordinator.codexMaintenance(input),/Idempotency conflict/);
  // A fresh live run in the same worker session reads/progresses the retained effect identity.
  const resumedTurn=(db.query("INSERT INTO turns(session_id,slack_user_msg_ts,user_text,status) VALUES(?,?,?,'running') RETURNING id").get(session.id,'resumed','Resume exact retained effect') as {id:number}).id;
  coordinator.actor=()=>({turn:resumedTurn,session:session.id,inputId:'resumed-worker-input'});
  const resumedInput={...input,action_id:'read-retained',resume_operation:unconfirmed.operationId};
  const resumed=await coordinator.codexMaintenance(resumedInput);
  assert.equal(resumed.phase,'applied');assert.equal(resumed.operationId,unconfirmed.operationId);assert.equal(resumed.duplicate,true);
  await assert.rejects(coordinator.codexMaintenance({...resumedInput,required_commit:'c'.repeat(40)}),/Idempotency conflict/);
  coordinator.actor=()=>({turn:resumedTurn,session:session.id+1,inputId:'other-worker-input'});
  await assert.rejects(coordinator.codexMaintenance(resumedInput),/no such retained/);
  coordinator.actor=()=>({turn:claim.turn_id,session:session.id,inputId:accepted.id});
  assert.equal((db.query('SELECT COUNT(*) AS count FROM codex_admission_holds').get() as {count:number}).count,0);
  // The actual dispatch constructor uses this retained outside placement to run an independent
  // CLI host. Such a requester must reach runner maintenance rather than wait on itself.
  db.query('UPDATE sessions SET native_metadata_json=? WHERE id=?').run(JSON.stringify({outside:true}),session.id);
  const independent=await coordinator.codexMaintenance({...input,action_id:'outside-maintenance'});
  assert.equal(independent.phase,'uncertain','the absent fixture runner is reached; the outside requester does not self-block as shared work');
  db.close();
}finally{rmSync(root,{recursive:true,force:true});}
const runner=readFileSync(join(import.meta.dir,'../src/runner-provider-accounts.ts'),'utf8');
assert(runner.indexOf('runtimeMaintenanceReserved=true;')<runner.indexOf("const ancestry=await runCommand"));
assert(runner.includes('if(runtimeMaintenancePending())holdCodexDaemonAutoStart(true);'));
console.log('PASS: deferred active work, graceful-only generation recovery, lost-response reconciliation, provider proof, source parsing and informational refusal without admission hold');
