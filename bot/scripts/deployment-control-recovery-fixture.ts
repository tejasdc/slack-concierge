import assert from 'node:assert/strict';
import {mock} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,symlinkSync,copyFileSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {Database} from 'bun:sqlite';
import {ledgerWriteResults} from '../src/ledger-write-results';
const role=process.argv[2],directory=process.argv[3];
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const until=async(check:()=>boolean)=>{const end=Date.now()+15000;while(!check()){assert.ok(Date.now()<end,'bounded fixture readiness');await Bun.sleep(2);}};
if(role==='child'){
 const kind=process.argv[4],old=process.argv[5]==='old';
 const authority=await import('../src/deployment-launch-authority');
 mock.module('../src/deployment-launch-authority',()=>({...authority,deploymentLedgerMode:async()=> 'owner'}));
 mock.module('../src/deployment-worker-wake',()=>({notifyDeploymentWorker:()=>true}));
 if(!old){class CliDatabase extends Database {constructor(path:string,options:any){
  if(kind!=='registry-start'||path!==join(directory,'backup.db')||!options?.readonly)throw Error('CLI_DATABASE_CONSTRUCTOR_REACHED');
  super(path,{readonly:true});
 }}mock.module('bun:sqlite',()=>({Database:CliDatabase}));}
 const {handleControlRecovery}=await import(old?join(directory,'old.ts'):resolve(import.meta.dir,'../src/deployment-control-recovery.ts'));
 const config=JSON.parse(readFileSync(join(directory,'config.json'),'utf8'));
 const command=(args:string[])=>{
  writeFileSync(join(directory,'effects-'+kind),JSON.stringify(args));
  if(args[0]==='git')return args.includes('--porcelain')?'':args.includes('fetch')?'':args.includes('HEAD^{tree}')?'f'.repeat(40):'e'.repeat(40);
  if(args[0]==='systemctl'&&args[1]==='show')return args[2]==='concierge-bot.service'?'MainPID=123\nActiveState=active\nInvocationID=83b075f900ce450998b3aae1a7c5f4c7':'MainPID=0\nActiveState=inactive\nControlGroup=';
  return '';
 };
 const manager:any={environment:{repositoryRoot:directory,releaseRoot:directory,installRoot:directory,bunExecutable:process.execPath},
  verify:()=>config.manifest,prepare:async(runId:string)=>{writeFileSync(join(directory,'prepare-seen'),runId);return {artifactPath:config.artifactPath,manifest:config.manifest};}};
 const options:Record<string,string>={'--run-id':config.runId,'--owner-pid':String(process.ppid),'--error':old?'old child crossed owner admission':'controlled new failure'};
 if(kind==='recovery-start'||kind==='registry-start'){
  delete options['--run-id'];Object.assign(options,{'--source-root':directory,'--control-commit':'e'.repeat(40),'--incident-id':'fixture-incident','--review-evidence':join(directory,'review.json')});
 }
 if(kind==='registry-start')Object.assign(options,{'--incident-id':'84934ba3-a60c-4b08-93d6-7ea4e71eaebe','--operator-exception':join(directory,'exception.json'),'--registry-backup':join(directory,'backup.db')});
 console.log(JSON.stringify(await handleControlRecovery(kind==='registry-start'?'recovery-start':kind,name=>options[name]??null,manager,command)));
 process.exit(0);
}
else {
 const root=mkdtempSync('/tmp/wal79-control-recovery-');
 process.env.CONCIERGE_STATE_DIR=root;process.env.CONCIERGE_SYSTEMD_DIR=root;
 process.env.CONCIERGE_TEST_MODE='1';process.env.CONCIERGE_TEST_AUTHORIZATION='responsive-system-b1eed622';
 const {db}=await import('../src/state');
 const state=await import('../src/deployment-state');
 const {dispatchControlRecoveryCommand}=await import('../src/deployment-control-recovery-commands');
 const admission=await import('../src/ledger-admission');
 const digest='a'.repeat(64),commit='d'.repeat(40),control='e'.repeat(40);
 const unitPath=join(root,'concierge-deployment-repair@.service'),unit='synthetic repair unit';writeFileSync(unitPath,unit);
 const manifest={artifact_digest:digest,git_commit:commit,control_git_commit:control,source_tree_digest:'b'.repeat(64),runtime_digest:'c'.repeat(64),compatibility_digest:'d'.repeat(64),files:{'control/systemd/concierge-deployment-repair@.service':sha(unit)}};
 db.query("INSERT INTO deployment_runs(id,target,unit_name,status,deployed_commit,evidence_json) VALUES('healthy','concierge','healthy-unit','succeeded',?,?)").run(commit,JSON.stringify({release_digest:digest,runtime_sha:commit}));
 state.recordDeploymentReleasePrepared('healthy',root,manifest);db.query("UPDATE deployment_releases SET state='lkg'").run();
 db.query("INSERT INTO deployment_runs(id,target,unit_name,status,repair_state) VALUES('prior','concierge','prior-unit','failed','parked')").run();
 db.query("INSERT INTO deployment_repair_incidents(id,run_id,status,failed_commit,restored_commit,failure_fingerprint,base_commit) VALUES('fixture-incident','prior','parked',?,?,'fixture',?)").run(control,commit,commit);
 const runId='fixture-recovery';state.prepareControlRecovery({runId,incidentId:'fixture-incident',healthyCommit:commit,controlCommit:control,artifactPath:root,artifactDigest:digest,sourceTreeDigest:'f'.repeat(40),reviewDigest:'f'.repeat(64)});
 writeFileSync(join(root,'config.json'),JSON.stringify({runId,artifactPath:root,manifest}));writeFileSync(join(root,'review.json'),JSON.stringify({verdict:'SHIP',reviewed_commit:control}));
 const original=Bun.spawnSync(['/usr/bin/git','-C',resolve(import.meta.dir,'../..'),'show','99e66d2460c0b0ad8c58e5ac5d11fa002129c149:bot/src/deployment-control-recovery.ts'],{stdout:'pipe',stderr:'pipe'});
 assert.equal(original.exitCode,0,original.stderr.toString());
 const baseline=original.stdout.toString();
 const old=baseline.replace(/from (['"])\.\/([^'"]+)\1/g,(_all,q,name)=>`from ${q}${resolve(import.meta.dir,'../src',name)}${q}`);
 writeFileSync(join(root,'old.ts'),old);
 const walFd=openSync(join(root,'state.db-wal'),'r');
 let releaseReceipt:()=>void=()=>{},receipt:Promise<void>=Promise.resolve(),dropFailed=true;
 const bodies:any[]=[],consumed:any[]=[],children:Bun.Subprocess[]=[];
 const server=Bun.serve({unix:join(root,'request-owner.sock'),idleTimeout:30,async fetch(request){
  if(new URL(request.url).pathname==='/live')return Response.json({live:true});
  const input=await request.json();bodies.push(input);
  try{
   const output=await admission.runLedgerSegment(()=>dispatchControlRecoveryCommand(input as any));consumed.push(input);
   if((input as any).operations?.length)await receipt;fsyncSync(walFd);
   if(dropFailed&&(input as any).operations?.some((o:any)=>o.kind==='failed')){
    dropFailed=false;
    return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));setTimeout(()=>controller.error(Error('deliberate body loss after durable consume')),10);}}),{headers:{'content-type':'application/json'}});
   }
   return Response.json(output);
  }catch(error){return Response.json({error:String(error)},{status:409});}
 }});
 const spawn=(kind:string,old=false)=>{const child=Bun.spawn([process.execPath,import.meta.path,'child',root,kind,...(old?['old']:[])],{env:{...process.env},stdout:'pipe',stderr:'pipe'});children.push(child);return child;};
 const finished=new Set<Bun.Subprocess>();
 const finish=async(child:Bun.Subprocess)=>{finished.add(child);const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);assert.equal(code,0,err);return JSON.parse(out);};
 const live=async()=>{assert.equal((await (await fetch('http://localhost/live',{unix:join(root,'request-owner.sock')} as any)).json() as any).live,true);};
 let resume:()=>void=()=>{};
 try {
  admission.enableLedgerAdmission();
  const held=admission.maintainLedger(()=>new Promise<void>(r=>resume=r));await Bun.sleep(0);
  const oldResult=await finish(spawn('recovery-failed',true));assert.equal(oldResult.status,'reserved');
  const independent=new Database(join(root,'state.db'),{readonly:true});
  assert.equal((independent.query("SELECT json_extract(detail_json,'$.error') error FROM deployment_run_events WHERE event='control_recovery_failed' ORDER BY sequence DESC LIMIT 1").get() as any).error,'old child crossed owner admission');independent.close(true);
  const child=spawn('recovery-claim');await until(()=>bodies.length>=1||child.exitCode!==null);if(child.exitCode!==null)await finish(child);await Bun.sleep(30);assert.equal(consumed.length,0);assert.equal(existsSync(join(root,'effects-recovery-claim')),false);await live();
  resume();await held;
  const claimed=await finish(child);assert.equal(claimed.run.id,runId);assert.equal(claimed.run.runner_pid,process.pid);assert.equal(claimed.mask_owned,true);
  const failedBefore=await admission.runLedgerSegment(()=>state.listDeploymentRunEvents('prior').filter(e=>e.event==='control_recovery_failed').length);
  receipt=new Promise<void>(r=>releaseReceipt=r);
  const failed=spawn('recovery-failed');await until(()=>consumed.some(x=>x.operations?.some((o:any)=>o.kind==='failed')));await Bun.sleep(30);assert.equal(failed.exitCode,null);await live();releaseReceipt();receipt=Promise.resolve();
  assert.equal((await finish(failed)).status,'reserved');
  const failureBodies=bodies.filter(x=>x.operations?.some((o:any)=>o.kind==='failed'));assert.equal(failureBodies.length,2);assert.equal(JSON.stringify(failureBodies[0]),JSON.stringify(failureBodies[1]));
  assert.equal(await admission.runLedgerSegment(()=>state.listDeploymentRunEvents('prior').filter(e=>e.event==='control_recovery_failed').length),failedBefore+1);
  // Actual unmask refuses the external file until the proven unit is installed.
  writeFileSync(join(root,'replacement'),unit);const {renameSync}=await import('node:fs');renameSync(join(root,'replacement'),unitPath);
  assert.deepEqual(await finish(spawn('recovery-unmask')),{status:'ready',owned_mask:true});
  const start=await finish(spawn('recovery-start'));assert.equal(start.status,'handoff_accepted');
  assert.ok(readFileSync(join(root,'effects-recovery-start'),'utf8').includes(`CONCIERGE_BUN_BIN=${root}/bun`));
  const observed=await admission.runLedgerSegment(()=>dispatchControlRecoveryCommand({selection:{runId}}));
  await admission.runLedgerSegment(()=>state.recordControlRecoveryEvent(runId,'control_recovery_contained',{changed:true}));
  assert.throws(()=>admission.runSynchronousLedgerSegment(()=>dispatchControlRecoveryCommand({selection:{runId},expected:observed.expected,operations:[{kind:'event',args:[runId,'control_recovery_unmasked',{different:true}]}]})),/observation changed/);
  // The original lost-registry exception reads a real pinned backup and the
  // receiver preserves its exclusive empty-registry import, not a stopped-only rule.
  await admission.runLedgerSegment(()=>db.exec(`VACUUM INTO '${root}/backup.db'`));
  const backup=ledgerWriteResults(new Database(join(root,'backup.db')),5000);
  backup.query('UPDATE deployment_releases SET run_id=?').run('healthy');backup.close(true);
  symlinkSync(root,join(root,'current'));symlinkSync(root,join(root,'control'));
  const exception={kind:'human_authorized_registry_loss_control_recovery',control_commit:control,prior_incident_id:'84934ba3-a60c-4b08-93d6-7ea4e71eaebe',registry_backup_digest:createHash('sha256').update(readFileSync(join(root,'backup.db'))).digest('hex'),human_scope:'fix_the_pipeline_and_native_inbox',no_tests_input:'1789490492.818709',review_policy_superseded_input:'1789490293.092859',previous_review_verdict:'NO_SHIP',lkg_artifact_digest:digest,
   failure:{run_id:'e030ac1e-c4ff-44f3-89cd-39111ffbecda',failed_commit:'b49c8e16d3902aaeccc9b378860070daa98370fd',candidate_runtime_sha:'b49c8e16d3902aaeccc9b378860070daa98370fd',candidate_service_invocation_id:'d39ae89711b34fe7af1040c1fb71f66c',failed_control_stage:'deploy-state.js initializeRouterSearchIndex: view router_search_sources already exists'},rollback:{runtime_sha:commit,service_invocation_id:'83b075f900ce450998b3aae1a7c5f4c7'}};
  writeFileSync(join(root,'exception.json'),JSON.stringify(exception));writeFileSync(join(root,'config.json'),JSON.stringify({runId,artifactPath:root+'/new-control',manifest}));
  // Nonempty registry must reject import before touching its retained records.
  const occupied=spawn('registry-start');const occupiedCode=await occupied.exited;finished.add(occupied);const occupiedError=await new Response(occupied.stderr).text();assert.notEqual(occupiedCode,0);assert.ok(occupiedError.includes('registry is not empty'));
  await admission.runLedgerSegment(()=>{
   for(const table of ['deployment_repair_agent_runs','deployment_repair_incidents','deployment_turn_reactions','deployment_notices','deployment_requests','deployment_drain','deployment_wakes','deployment_run_events','deployment_releases','deployment_runs'])db.exec(`DELETE FROM ${table}`);
   db.query("INSERT INTO deployment_desired_state(target,desired_commit,github_delivery_id) VALUES('concierge',?,'synthetic') ON CONFLICT(target) DO UPDATE SET desired_commit=excluded.desired_commit").run(control);
  });
  // Explicit synthetic schema controls test the existing exclusivity predicate.
  // They make no claim that a historical installation actually had this table.
  await admission.runLedgerSegment(()=>db.exec('CREATE TABLE deployment_control_handoff_projections(synthetic INTEGER); INSERT INTO deployment_control_handoff_projections VALUES(1)'));
  const optional=spawn('registry-start');const optionalCode=await optional.exited;finished.add(optional);assert.notEqual(optionalCode,0);assert.ok((await new Response(optional.stderr).text()).includes('registry is not empty: deployment_control_handoff_projections'));
  const requiredSchema=await admission.runLedgerSegment(()=>{
   db.exec('DROP TABLE deployment_control_handoff_projections');const sql=(db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='deployment_wakes'").get() as any).sql as string;db.exec('DROP TABLE deployment_wakes');return sql;
  });
  const missing=spawn('registry-start');const missingCode=await missing.exited;finished.add(missing);assert.notEqual(missingCode,0);assert.ok((await new Response(missing.stderr).text()).includes('no such table: deployment_wakes'));
  await admission.runLedgerSegment(()=>db.exec(requiredSchema));
  const restored=await finish(spawn('registry-start'));assert.equal(restored.status,'handoff_accepted');
  await admission.runLedgerSegment(()=>{assert.equal(state.getDeploymentRun('healthy')?.status,'succeeded');assert.equal(state.getDeploymentDesiredState()?.desired_commit,control);assert.ok(state.getControlRecoveryIntent(String(restored.run_id))?.operatorAuthorityDigest);});
  console.log(JSON.stringify({pass:true,root,baselineSha:sha(baseline),oldChildCrossedClosedAdmission:true,newActualCommands:['claim','failed','unmask','start','registry-start'],newChildCanonicalDatabaseConstructorsForbidden:true,heldPredicateAndEffect:true,memoryHttpLive:true,originalWalDescriptorReceipt:true,partialReplyReplaySameBody:true,failureEventExactlyOnce:true,staleSnapshotRejected:true,backedUpRegistryReadReal:true,occupiedRegistryImportRefused:true,optionalPresentOccupiedRefused:true,requiredTableMissingRefused:true,optionalAbsentCurrentSchemaImportedWhileOwnerServing:true,limits:'Real scratch SQLite + actual command/client/receiver and lost-registry exception; authority selector and systemd/Git/artifact collaborators controlled. Focused route admission/receipt composition, not full application or live release. Optional-present and required-missing are explicitly synthetic scratch schema controls, not historical-provenance claims.'}));
 } finally {
  writeFileSync(join(root,'trace.json'),JSON.stringify({bodies,consumed}));
  releaseReceipt();for(const child of children){if(child.exitCode===null)child.kill('SIGKILL');await child.exited;if(!finished.has(child))console.error(await new Response(child.stderr).text());}
  resume();await admission.pendingLedgerMaintenance();server.stop(true);closeSync(walFd);await admission.runLedgerSegment(()=>db.close(true));
 }
}
