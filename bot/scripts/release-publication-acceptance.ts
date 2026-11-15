import {strict as assert} from 'node:assert';
import {chmodSync,existsSync,mkdirSync,readFileSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {TrustedRootReleaseManager} from '../src/deployment-release';
import {releasePublicationMode} from '../src/deployment-release-publication';
import {requireCustodyReader} from '../src/codex-custody-compatibility';
import {IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION} from '../src/test-authorizations';

/** Real retained receiver and release CLI, with only systemd/health/repair effects substituted.
 * All artifacts, sockets and ledgers belong to the caller's disposable directory. */
export async function releasePublicationAcceptance(input:{source:string;scratch:string;repo:string;baseCommit:string;
  manager:TrustedRootReleaseManager;oldArtifact:string;modernArtifact:string;modernRollback:string;hybridArtifact:string}) {
  const {source,scratch,repo,manager}=input;
  const root=join(scratch,'publication-acceptance');mkdirSync(root);
  const state=join(root,'state');mkdirSync(state);
  const fixtureHome=join(root,'home');mkdirSync(fixtureHome);
  const receiverHome=join(root,'receiver-home');mkdirSync(receiverHome);
  // Give the CLI the real live-command policy in a disposable home. Its canonical state
  // entry resolves to this fixture's outside-home ledger, never the host's live store.
  mkdirSync(join(fixtureHome,'.local/state'),{recursive:true});
  symlinkSync(state,join(fixtureHome,'.local/state/concierge'),'dir');
  const env={...process.env,HOME:fixtureHome,CODEX_HOME:join(fixtureHome,'.codex'),CONCIERGE_REPO:repo,CONCIERGE_STATE_DIR:state,CONCIERGE_STATE_DB:join(state,'state.db'),
    CONCIERGE_CAPTURE_STATE_DIR:join(root,'capture'),CONCIERGE_DEPLOYMENT_RELEASE_ROOT:manager.environment.releaseRoot,
    CONCIERGE_DEPLOYMENT_RUNTIME_DIR:manager.environment.installRoot,CONCIERGE_SERVICE:'fixture.service',
    CONCIERGE_RELEASE_OFFLINE:'0',CONCIERGE_RUNTIME_GIT_SHA:manager.verify(input.oldArtifact).git_commit,
    CONCIERGE_RELEASE_MANIFEST:join(input.oldArtifact,'manifest.json'),CONCIERGE_TEST_MODE:'1',
    CONCIERGE_TEST_AUTHORIZATION:IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION};
  const run=(cmd:string[],extra:Record<string,string>={})=>{
    const result=Bun.spawnSync({cmd,env:{...env,...extra},stdout:'pipe',stderr:'pipe'});
    assert.equal(result.exitCode,0,result.stderr.toString()+result.stdout.toString());return result.stdout.toString().trim();
  };
  // Extract the complete, unchanged prior source and import its actual receiver and dependencies.
  const oldSource=join(root,'old-source');mkdirSync(oldSource);
  const archive=Bun.spawnSync({cmd:['git','archive',input.baseCommit],cwd:source,stdout:'pipe',stderr:'pipe'});
  assert.equal(archive.exitCode,0,archive.stderr.toString());
  const extracted=Bun.spawnSync({cmd:['tar','-xf','-','-C',oldSource],stdin:archive.stdout,stdout:'pipe',stderr:'pipe'});
  assert.equal(extracted.exitCode,0,extracted.stderr.toString());
  symlinkSync(join(source,'bot/node_modules'),join(oldSource,'bot/node_modules'),'dir');
  const oldReceiver=join(oldSource,'bot/src/fixture-retained-receiver.ts');
  // The old wrapper was private. Expose it without changing any retained receiver body.
  writeFileSync(oldReceiver,readFileSync(join(oldSource,'bot/src/routed-request-api.ts'),'utf8')
    +'\nexport {localOwnerRequestApiHandler};\n');
  const seed=join(root,'seed.ts');
  writeFileSync(seed,[
    `const state=await import(${JSON.stringify(join(source,'bot/src/deployment-state.ts'))});`,
    'const artifact=process.argv[2];const manifest=await Bun.file(artifact+"/manifest.json").json();',
    'const {run}=state.requestOperatorDeployment();',
    'state.recordDeploymentReleasePrepared(run.id,artifact,manifest);',
    'state.recordDeploymentReleaseActivationIntent(run.id,manifest.artifact_digest);',
    'state.recordDeploymentReleaseActivated(run.id,manifest.artifact_digest);',
    'state.promoteDeploymentRelease(run.id,manifest.artifact_digest);',
    'console.log(JSON.stringify({runId:run.id}));',
  ].join('\n'));
  const seedRelease=(artifact:string)=>JSON.parse(run([process.execPath,seed,artifact],{HOME:receiverHome}).split('\n').at(-1)!);
  const {runId}=seedRelease(input.oldArtifact);
  manager.activate(input.oldArtifact);manager.activateControl(input.hybridArtifact);
  const receiver=join(root,'receiver.ts');
  const receiverTrace=join(root,'receiver-trace');
  writeFileSync(receiver,[
    'import {appendFileSync} from "node:fs";',
    'const mod=await import(process.argv[2]);',
    'const owner={handle:async()=>null};',
    'const shared=mod.requestApiHandler(null,undefined,undefined,owner);',
    'const fetch=mod.localOwnerRequestApiHandler(shared,undefined,owner);',
    'Bun.serve({unix:process.env.CONCIERGE_STATE_DIR+"/request-owner.sock",fetch:async request=>{const operation=request.method==="POST"?(await request.clone().json()).operation:null;appendFileSync(process.env.FIXTURE_RECEIVER_TRACE,JSON.stringify({path:new URL(request.url).pathname,operation})+"\\n");return fetch(request);}});',
    'console.log("receiver-ready");',
  ].join('\n'));
  const start=async(module:string,artifact:string)=>{
    if(existsSync(join(state,'request-owner.sock')))unlinkSync(join(state,'request-owner.sock'));
    writeFileSync(receiverTrace,'');
    const process=Bun.spawn({cmd:[Bun.which('bun')!,receiver,module],env:{...env,HOME:receiverHome,FIXTURE_RECEIVER_TRACE:receiverTrace,
      CONCIERGE_RUNTIME_GIT_SHA:manager.verify(artifact).git_commit,CONCIERGE_RELEASE_MANIFEST:join(artifact,'manifest.json')},stdout:'pipe',stderr:'pipe'});
    const reader=process.stdout.getReader();let output='';
    while(!output.includes('receiver-ready')){const part=await reader.read();
      if(part.done)throw new Error(`Receiver failed: ${await new Response(process.stderr).text()}`);
      output+=new TextDecoder().decode(part.value);
    }
    reader.releaseLock();return process;
  };
  const get=(path:string,init:RequestInit)=>fetch('http://owner'+path,{...init,unix:join(state,'request-owner.sock')} as RequestInit);
  const cli=join(source,'bot/scripts/release-manager.ts');
  const asyncCli=async(args:string[])=>{
    const child=Bun.spawn({cmd:[process.execPath,cli,...args],env,stdout:'pipe',stderr:'pipe'});
    const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    return {stdout,stderr,code};
  };
  let serving=await start(oldReceiver,input.oldArtifact);
  try {
    assert.equal(await releasePublicationMode(manager,get),'stopped');
    const unsupported=await get('/internal/deployment-release',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({operation:'promote-and-activate-control',runId,artifactPath:input.hybridArtifact,
        artifactDigest:manager.verify(input.hybridArtifact).artifact_digest})});
    assert.equal(unsupported.ok,false);assert.match(JSON.stringify(await unsupported.json()),/Unknown deployment release operation/);
    const result=await asyncCli(['publication-mode']);
    assert.equal(result.code,0,result.stderr+result.stdout);assert.equal(JSON.parse(result.stdout).mode,'stopped');
    // An arbitrary error is not a legacy capability response and cannot select offline.
    for(const response of [Response.json({error:'temporary failure'},{status:503}),
      Response.json({error:'other missing resource'},{status:404})])
      await assert.rejects(()=>releasePublicationMode(manager,(path,init)=>path.includes('capabilities')
        ?Promise.resolve(response):get(path,init)),/capability is unproven/);

    const bin=join(root,'bin');mkdirSync(bin);
    const serviceState=join(root,'service-state'),calls=join(root,'calls');
    const systemctl=join(bin,'systemctl');
    writeFileSync(systemctl,[
      '#!/usr/bin/env bash','set -eu','printf "systemctl:%s\\n" "$*" >> "$FIXTURE_CALLS"',
      'case "$1" in',
      'show) if [[ "$*" == *RefuseManualStop* ]]; then echo no; else cat "$FIXTURE_SERVICE_STATE"; fi ;;',
      'stop) printf "LoadState=loaded\\nActiveState=inactive\\nSubState=dead\\nMainPID=0\\nControlPID=0\\nJob=\\n" > "$FIXTURE_SERVICE_STATE" ;;',
      'start|restart) printf "LoadState=loaded\\nActiveState=active\\nSubState=running\\nMainPID=42\\nControlPID=0\\nJob=\\n" > "$FIXTURE_SERVICE_STATE" ;;',
      'reset-failed) ;;','*) exit 1 ;;','esac',
    ].join('\n'));chmodSync(systemctl,0o755);
    const shell=(operation:string,extra:Record<string,string>={})=>{
      writeFileSync(serviceState,'LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=42\nControlPID=0\nJob=\n');
      writeFileSync(calls,'');
      const script=[
        'source "$1"',
        'mark() { printf "%s\\n" "$*" >> "$FIXTURE_CALLS"; }',
        'fixture_bun() { mark "bun:offline=${CONCIERGE_RELEASE_OFFLINE:-0}:$*"; case "$*" in *" repair-begin "*) return 2 ;; *" recovery-claim "*) printf "%s\\n" "$FIXTURE_RECEIPT"; return 0 ;; *" recovery-unmask "*|*" recovery-failed "*) return 0 ;; *" --backup-only"*) jq -cn --arg path "$CONCIERGE_STATE_DIR/state.db" \'{backup_path:$path}\'; return 0 ;; *" --schema-only "*) return 0 ;; esac; command "$FIXTURE_BUN" "$@"; }',
        'BUN_BIN=fixture_bun',
        'record_deployment_phase() { mark "phase:$1:offline=${CONCIERGE_RELEASE_OFFLINE:-0}"; }',
        'release_deployment_gate() { mark release; }',
        'record_deployment_ambiguity() { mark ambiguity; return 1; }',
        'probe_service() { mark "probe:offline=${CONCIERGE_RELEASE_OFFLINE:-0}"; test "${CONCIERGE_RELEASE_OFFLINE:-0}" = 0 || return 1; if [ "${FIXTURE_FAIL_HEALTH:-0}" = 1 ] && [ ! -e "$FIXTURE_FAILURE_FILE" ]; then touch "$FIXTURE_FAILURE_FILE"; return 1; fi; grep -q ActiveState=active "$FIXTURE_SERVICE_STATE" || return 1; RELEASE_OWNER_HEALTH_PENDING=0; }',
        operation,
      ].join('\n');
      const result=Bun.spawn({cmd:['bash','-c',script,'fixture',join(source,'bot/scripts/deploy.sh')],env:{...env,
        CONCIERGE_DEPLOYMENT_CONTROL_ROOT:join(source,'bot/scripts'),FIXTURE_BUN:process.execPath,
        FIXTURE_CALLS:calls,FIXTURE_SERVICE_STATE:serviceState,PATH:bin+':'+process.env.PATH,...extra},stdout:'pipe',stderr:'pipe'});
      return result;
    };
    const complete=async(child:ReturnType<typeof shell>,expected=0)=>{
      const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
      assert.equal(code,expected,stderr+stdout);return readFileSync(calls,'utf8');
    };
    const ordinary=await complete(shell('DEPLOYED_COMMIT='+manager.verify(input.modernArtifact).git_commit+'; require_last_known_good_release'));
    assert.ok(ordinary.indexOf('publication-mode')<ordinary.indexOf('systemctl:stop'));
    assert.ok(ordinary.indexOf('require-stopped')<ordinary.indexOf('restore-lkg'));
    assert.ok(ordinary.indexOf('restore-lkg')<ordinary.indexOf('systemctl:start'));
    assert.match(ordinary,/probe:offline=0/);assert.equal(manager.currentArtifactPath(),input.oldArtifact);
    // Promotion of a controller-only hybrid still runs while the actual old application serves.
    const hybridRun=seedRelease(input.hybridArtifact).runId;
    const promoted=await complete(shell('DEPLOY_RUN_ID="$FIXTURE_RUN"; CANDIDATE_ARTIFACT_PATH="$FIXTURE_ARTIFACT"; CANDIDATE_ARTIFACT_DIGEST="$FIXTURE_DIGEST"; promote_candidate_release',{
      FIXTURE_RUN:hybridRun,FIXTURE_ARTIFACT:input.hybridArtifact,FIXTURE_DIGEST:manager.verify(input.hybridArtifact).artifact_digest}));
    assert.ok(promoted.indexOf('require-stopped')<promoted.indexOf(' promote '));
    assert.match(promoted,/probe:offline=0/);assert.equal(manager.controlArtifactPath(),input.hybridArtifact);
    console.log(JSON.stringify({case:'legacy-predeployment-and-hybrid',ordinary:ordinary.trim().split('\n'),promotion:promoted.trim().split('\n')}));
    for(const mode of ['success','failed-health','interrupted']){
      const receipt={healthyCommit:manager.verify(input.hybridArtifact).git_commit,artifactPath:input.hybridArtifact,
        artifactDigest:manager.verify(input.hybridArtifact).artifact_digest,mask_owned:true,
        run:{activation_state:mode==='interrupted'?'intended':null}};
      const recovery=[
        'verify_git_origin() { mark origin; }',
        'control_recovery_app_server_identity() { echo fixture-app-server; }',
        'recover_abandoned_gates() { mark recover-gates; }',
        'claim_deployment_gate() { mark claim-turn-gate; }',
        'claim_capture_gate() { mark claim-capture-gate; }',
        'hold_capture_gate() { mark hold-capture-gate; }',
        'install_deployment_runtime() { mark install-runtime; }',
        'install_systemd_units() { mark install-units; }',
        'install_router_actions() { mark install-actions; }',
        'confirm_service_proof_is_current() { mark exact-proof; }',
        'record_deployment_success() { mark success; }',
        'recover_control',
      ].join('\n');
      const trace=await complete(shell(recovery,{CONCIERGE_CONTROL_RECOVERY_RUN_ID:hybridRun,
        FIXTURE_RECEIPT:JSON.stringify(receipt),FIXTURE_FAIL_HEALTH:mode==='failed-health'?'1':'0',
        FIXTURE_FAILURE_FILE:join(root,'failed-health-'+mode)}),mode==='failed-health'?1:0);
      assert.ok(trace.indexOf('systemctl:stop')<trace.indexOf(' activate '));
      if(mode==='failed-health'){
        const restoration=trace.indexOf('restore-lkg');assert.ok(restoration>=0);
        assert.ok(trace.indexOf('require-stopped',trace.indexOf(' activate '))<restoration);
        assert.match(trace,/recovery-failed/);assert.ok(!trace.includes('\nsuccess\n'));
      }else{
        assert.match(trace,/publication-mode/);assert.match(trace,/bun:offline=1:.* promote /);
        assert.match(trace,/probe:offline=0/);assert.match(trace,/\nsuccess\n$/);
        if(mode==='interrupted')assert.ok(trace.indexOf('restore-lkg')<trace.indexOf(' activate '));
      }
      console.log(JSON.stringify({case:'control-recovery-'+mode,trace:trace.trim().split('\n')}));
    }
    // Actual shell rollback starts from a live, functionally unhealthy candidate. The real CLI
    // and manager restore a distinct compatible LKG only after the strict stopped-state check.
    seedRelease(input.modernRollback);manager.activate(input.modernArtifact);
    requireCustodyReader(state,manager.environment.releaseRoot);
    const rolledBack=await complete(shell('DEPLOY_RUN_ID="$FIXTURE_RUN"; DEPLOYED_COMMIT="$FIXTURE_COMMIT"; restore_last_known_good_and_start_repair unhealthy functional',{
      FIXTURE_RUN:hybridRun,FIXTURE_COMMIT:manager.verify(input.modernArtifact).git_commit}));
    assert.ok(rolledBack.indexOf('systemctl:stop')<rolledBack.indexOf('require-stopped'));
    assert.ok(rolledBack.indexOf('require-stopped')<rolledBack.indexOf('restore-lkg'));
    assert.ok(rolledBack.indexOf('restore-lkg')<rolledBack.indexOf('systemctl:restart'));
    assert.ok(rolledBack.indexOf('probe:offline=0')<rolledBack.indexOf('\nrelease\n'));
    assert.equal(manager.currentArtifactPath(),input.modernRollback);
    console.log(JSON.stringify({case:'active-unhealthy-rollback',trace:rolledBack.trim().split('\n')}));
  } finally {serving.kill();await serving.exited;}
  manager.activate(input.modernArtifact);
  serving=await start(join(source,'bot/src/routed-request-api.ts'),input.modernArtifact);
  try {
    assert.equal(await releasePublicationMode(manager,get),'serialized');
    // The CLI's real live-command policy must send publication to the current receiver.
    const restored=await asyncCli(['restore-lkg','--keep-control']);
    assert.equal(restored.code,0,restored.stderr+restored.stdout);
    assert.equal(manager.currentArtifactPath(),input.modernRollback);
    const currentRun=seedRelease(input.modernArtifact).runId;
    const promoted=await asyncCli(['promote','--run-id',currentRun,'--artifact',input.modernArtifact,
      '--artifact-digest',manager.verify(input.modernArtifact).artifact_digest]);
    assert.equal(promoted.code,0,promoted.stderr+promoted.stdout);
    assert.equal(manager.controlArtifactPath(),input.modernArtifact);
    const trace=readFileSync(receiverTrace,'utf8');
    assert.match(trace,/"operation":"activate-files"/);
    assert.match(trace,/"operation":"promote-and-activate-control"/);
    console.log(JSON.stringify({case:'capable-owner-cli-publication',trace:trace.trim().split('\n').map(line=>JSON.parse(line))}));
  }finally{serving.kill();await serving.exited;}
  console.log(JSON.stringify({check:'release-publication-acceptance',status:'passed',actualPreservedOldReceiver:true,
    ordinaryPredeploymentRestore:true,hybridPromotion:true,activeUnhealthyRollback:true,strictStoppedGuard:true,
    capableOwnerSerializedPublication:true,controlRecoveryModes:['success','failed-health','interrupted'],
    arbitraryRpcFailureRefused:true,systemd:'substituted',state:'disposable'}));
}
