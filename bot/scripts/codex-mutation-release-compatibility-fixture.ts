import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Database} from 'bun:sqlite';
import {IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION} from '../src/test-authorizations';
import {TrustedRootReleaseManager,releaseFileSetDigest} from '../src/deployment-release';
import {initializeCodexMutationFenceSchema} from '../src/codex-mutation-fence';
import {assertCodexMutationApplicationStartup} from '../src/codex-mutation-application-startup';
import {CODEX_MUTATION_APPLICATION_CAPABILITY_PATH as APP,CODEX_MUTATION_CONTROL_CAPABILITY_PATH as CONTROL,
  codexMutationFirstProtectionReadiness,codexMutationReleaseRequirement,publishCodexMutationReleaseRequirement,
  requireCodexMutationReleaseProtection} from '../src/codex-mutation-release-compatibility';

const root=mkdtempSync(join(tmpdir(),'codex-release-compatibility-')),state=join(root,'state'),releaseRoot=join(root,'releases-root'),install=join(root,'install');
mkdirSync(state);mkdirSync(join(releaseRoot,'releases'),{recursive:true});mkdirSync(install);symlinkSync(process.execPath,join(install,'bun'));
const source=resolve(import.meta.dir,'..'),repo=resolve(source,'..'),hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const db=new Database(join(state,'state.db'));initializeCodexMutationFenceSchema(db);
const checker=join(root,'checker.js');
const built=await Bun.build({entrypoints:[join(import.meta.dir,'codex-mutation-release-check.ts')],target:'bun',outdir:root,naming:'checker.js'});
assert.equal(built.success,true);
let serial=0;
function seal(application:boolean,control:boolean){
  const stage=join(releaseRoot,'releases',`.fixture-${++serial}`);mkdirSync(join(stage,'control'),{recursive:true});mkdirSync(join(stage,'bot/src'),{recursive:true});
  const paths:Record<string,string|Uint8Array>={
    'bot/src/index.js':"import {writeFileSync} from 'node:fs';writeFileSync(process.env.FIXTURE_APP_EFFECT,'started');",
    'control/deploy.sh':'#!/bin/bash\nexit 0\n','control/deployment-repair.js':'// fixture','control/release-manager.js':'// fixture',
    'control/deployment-launcher.sh':readFileSync(join(import.meta.dir,'deployment-launcher.sh')),
    'control/deployment-control-launcher.sh':readFileSync(join(import.meta.dir,'deployment-control-launcher.sh')),
    'control/codex-mutation-release-check.js':readFileSync(checker),
  };
  if(application)paths[APP]=readFileSync(join(source,'src/codex-mutation-release-format.json'));
  if(control)paths[CONTROL]=readFileSync(join(source,'src/codex-mutation-release-format.json'));
  const files:Record<string,string>={};for(const [path,bytes] of Object.entries(paths)){mkdirSync(dirname(join(stage,path)),{recursive:true});writeFileSync(join(stage,path),bytes,{mode:0o444});files[path]=hash(bytes);}
  const unsigned={format:2 as const,git_commit:(application?'a':'b').repeat(40),control_git_commit:(control?'c':'d').repeat(40),
    source_tree_digest:hash(`source:${serial}`),control_source_tree_digest:hash('control'),runtime_digest:releaseFileSetDigest(stage,Object.keys(files)),
    compatibility_digest:hash('compatibility'),files};
  const artifact_digest=hash(JSON.stringify(unsigned)),path=join(releaseRoot,'releases',artifact_digest);
  writeFileSync(join(stage,'manifest.json'),JSON.stringify({...unsigned,artifact_digest}),{mode:0o444});
  for(const dir of [join(stage,'bot/src'),join(stage,'bot'),join(stage,'control'),stage])chmodSync(dir,0o555);
  renameSync(stage,path);return path;
}
const manager=new TrustedRootReleaseManager({repositoryRoot:repo,releaseRoot,installRoot:install,bunExecutable:process.execPath,historyCacheStateDirectory:state});
const legacy=seal(false,false),modern=seal(true,true),oldAppNewControl=seal(false,true),newAppOldControl=seal(true,false);
const effect=join(root,'app-started'),env={...process.env,CONCIERGE_STATE_DIR:state,CONCIERGE_DEPLOYMENT_RELEASE_ROOT:releaseRoot,
  CONCIERGE_DEPLOYMENT_RUNTIME_DIR:install,FIXTURE_APP_EFFECT:effect};
const launch=()=>Bun.spawnSync(['/bin/bash',join(modern,'control/deployment-launcher.sh')],{env,stdout:'pipe',stderr:'pipe'});
const count=()=>['codex_thread_mutation_fences','codex_mutation_permits','codex_mutation_intents'].map(table=>(db.query(`SELECT count(*) AS n FROM ${table}`).get() as any).n);
try{
  // Empty protection state retains ordinary older application/controller rollback.
  manager.activate(legacy);manager.activateControl(legacy);manager.restore(legacy);
  manager.activateControl(modern);
  assert.equal(launch().exitCode,0);assert.equal(existsSync(effect),true);rmSync(effect);

  // Actual operational first protection cannot create protected state or a marker.
  // It cannot certify a still-running old helper by inspecting a cold conversation.
  const helperReady=join(root,'old-helper-ready');
  const helper=Bun.spawn([process.execPath,'-e',"require('node:fs').writeFileSync(process.argv[1],'ready'); await new Response(Bun.stdin.stream()).text();",helperReady],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});
  try{
    for(let i=0;i<100&&!existsSync(helperReady);i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(existsSync(helperReady),true);process.kill(helper.pid,0);
    const before=count();
    assert.throws(()=>requireCodexMutationReleaseProtection(db,{stateDirectory:state}),/FIRST_PROTECTION_WRITER_EXCLUSION_UNPROVEN/);
    assert.deepEqual(count(),before);assert.equal(existsSync(codexMutationReleaseRequirement(state)),false);
    manager.activate(legacy); // Selection racing a refused creation stays safe: no protected authority exists.
    assert.equal(manager.currentArtifactPath(),legacy);process.kill(helper.pid,0);
  }finally{await helper.stdin.end();await helper.exited;}
  assert.deepEqual(codexMutationFirstProtectionReadiness(),{eligible:false,reason:'FIRST_PROTECTION_WRITER_EXCLUSION_UNPROVEN'});

  // Actual deploy entrance refuses before claims, drain, pointer changes or service effects.
  const serviceEffect=join(root,'service-effect');
  const deploy=Bun.spawnSync(['/bin/bash','-c','source "$FIXTURE_DEPLOY"; claim_run_and_enable_recovery(){ touch "$FIXTURE_SERVICE_EFFECT"; }; claim_deployment_gate(){ touch "$FIXTURE_SERVICE_EFFECT"; }; stop_unit(){ touch "$FIXTURE_SERVICE_EFFECT"; }; deploy'],
    {env:{...env,CONCIERGE_BUN_BIN:process.execPath,CONCIERGE_DEPLOYMENT_CONTROL_ROOT:import.meta.dir,FIXTURE_DEPLOY:join(import.meta.dir,'deploy.sh'),
      FIXTURE_SERVICE_EFFECT:serviceEffect,CONCIERGE_DEPLOY_RUN_ID:'fixture-run'},stdout:'pipe',stderr:'pipe'});
  assert.equal(deploy.exitCode,75,deploy.stderr.toString());assert.match(deploy.stdout.toString(),/FIRST_PROTECTION_WRITER_EXCLUSION_UNPROVEN/);
  assert.equal(existsSync(serviceEffect),false);assert.equal(manager.currentArtifactPath(),legacy);
  assert.equal(existsSync(codexMutationReleaseRequirement(state)),false);

  // Real wrapper preflight is before SQLite import or installer child effects.
  const body=join(root,'installer-body.sh'),childEffect=join(root,'installer-effect'),wrapperState=join(root,'wrapper-state');mkdirSync(wrapperState);
  writeFileSync(body,'#!/bin/bash\ntouch "$FIXTURE_CHILD_EFFECT"\n');
  const wrapper=Bun.spawnSync([process.execPath,join(import.meta.dir,'codex-managed-hook-install.ts'),'--body',body,'--','fixture'],
    {env:{...env,CONCIERGE_STATE_DIR:wrapperState,FIXTURE_CHILD_EFFECT:childEffect},stdout:'pipe',stderr:'pipe'});
  assert.equal(wrapper.exitCode,75,wrapper.stderr.toString());assert.match(wrapper.stderr.toString(),/FIRST_PROTECTION_WRITER_EXCLUSION_UNPROVEN/);
  assert.equal(existsSync(childEffect),false);assert.equal(existsSync(join(wrapperState,'state.db')),false);
  assert.equal(existsSync(codexMutationReleaseRequirement(wrapperState)),false);

  // Publication/crash retention is tested separately below first-host activation.
  // A marker is NOT first-protection proof and cannot authorize a DB mutation.
  publishCodexMutationReleaseRequirement(state);const retained=readFileSync(codexMutationReleaseRequirement(state));
  publishCodexMutationReleaseRequirement(state);assert.deepEqual(readFileSync(codexMutationReleaseRequirement(state)),retained);
  assert.throws(()=>requireCodexMutationReleaseProtection(db,{stateDirectory:state}),/FIRST_PROTECTION_WRITER_EXCLUSION_UNPROVEN/);
  assert.deepEqual(count(),[0,0,0]);
  assert.throws(()=>manager.activate(oldAppNewControl),/CODEX_MUTATION_APPLICATION_PROTOCOL_NOT_PROVEN/);
  assert.throws(()=>manager.activate(legacy),/CODEX_MUTATION_APPLICATION_PROTOCOL_NOT_PROVEN/);
  assert.throws(()=>manager.restore(newAppOldControl),/CODEX_MUTATION_CONTROL_PROTOCOL_NOT_PROVEN/);
  assert.throws(()=>manager.restore(oldAppNewControl),/CODEX_MUTATION_APPLICATION_PROTOCOL_NOT_PROVEN/);
  assert.throws(()=>manager.activateControl(legacy),/CODEX_MUTATION_CONTROL_PROTOCOL_NOT_PROVEN/);
  assert.equal(manager.currentArtifactPath(),legacy,'full restore preflight precedes both pointer changes');
  assert.equal(manager.controlArtifactPath(),modern,'compatible recovery controller remains selectable with an ineligible old app');
  manager.installSelectedRuntimeLaunchers();
  db.exec("CREATE TABLE deployment_releases(artifact_digest TEXT PRIMARY KEY,state TEXT); INSERT INTO deployment_releases VALUES('preserved-lkg','lkg')");
  const priorLkg=db.query('SELECT * FROM deployment_releases').all();
  const promote=Bun.spawnSync([process.execPath,join(import.meta.dir,'release-manager.ts'),'promote','--run-id','fixture-run',
    '--artifact-digest',manager.verify(newAppOldControl).artifact_digest,'--artifact',newAppOldControl],
    {env:{...env,CONCIERGE_REPO:repo,CONCIERGE_TEST_MODE:'1',CONCIERGE_TEST_AUTHORIZATION:IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION},stdout:'pipe',stderr:'pipe'});
  assert.equal(promote.exitCode,1,promote.stderr.toString());assert.match(promote.stdout.toString(),/CODEX_MUTATION_CONTROL_PROTOCOL_NOT_PROVEN/);
  assert.deepEqual(db.query('SELECT * FROM deployment_releases').all(),priorLkg,'incompatible promotion cannot persist a bad LKG before guarded control selection');

  // A selection completed before publication cannot bypass the actual cold startup check.
  assert.notEqual(launch().exitCode,0);assert.equal(existsSync(effect),false);
  const recover=Bun.spawnSync(['/bin/bash',join(modern,'control/deployment-control-launcher.sh'),'recover'],{env,stdout:'pipe',stderr:'pipe'});
  // The fixture has no recovery program; reaching that missing program proves the
  // compatible controller gate did not reject merely because the selected app is old.
  assert.doesNotMatch(recover.stderr.toString(),/CODEX_MUTATION_APPLICATION_PROTOCOL_NOT_PROVEN/);
  manager.restore(modern);assert.equal(manager.currentArtifactPath(),modern);assert.equal(manager.controlArtifactPath(),modern);
  assert.equal(launch().exitCode,0);assert.equal(existsSync(effect),true);
  assert.doesNotThrow(()=>assertCodexMutationApplicationStartup({stateDirectory:state,mainPath:join(modern,'bot/src/index.js'),
    manifestPath:join(modern,'manifest.json'),releaseRoot}));
  assert.throws(()=>assertCodexMutationApplicationStartup({stateDirectory:state,mainPath:join(source,'src/index.ts')}),/CODEX_MUTATION_UNSEALED_APPLICATION_STARTUP_UNPROVEN/);
  assert.throws(()=>assertCodexMutationApplicationStartup({stateDirectory:state,mainPath:join(source,'src/index.ts'),
    manifestPath:join(modern,'manifest.json'),releaseRoot}),/CODEX_MUTATION_UNSEALED_APPLICATION_STARTUP_UNPROVEN/);
  assert.deepEqual(readFileSync(codexMutationReleaseRequirement(state)),retained,'reconciliation/start cannot remove the retained requirement');

  // Real hybrid builder provenance, using two isolated Git source objects rather
  // than a caller asserting which half of a manifest understands the protocol.
  const hybridSource=join(root,'hybrid-source');mkdirSync(join(hybridSource,'bot/src'),{recursive:true});mkdirSync(join(hybridSource,'bot/scripts'),{recursive:true});
  mkdirSync(join(hybridSource,'bot/node_modules'));
  for(const path of ['bot/src/index.ts','bot/src/state.ts','bot/src/capture-state.ts','bot/src/deployment-state.ts',
    'bot/src/codex-app-server-bridge.mjs','bot/scripts/rename-exchange.py','bot/scripts/deployment-repair.ts',
    'bot/scripts/release-manager.ts','bot/scripts/deploy.sh'])writeFileSync(join(hybridSource,path),`fixture ${path}`);
  const declaration={format:1,controlBundles:{'control/deployment-repair.js':'bot/scripts/deployment-repair.ts',
    'control/release-manager.js':'bot/scripts/release-manager.ts'},controlFiles:{'control/deploy.sh':'bot/scripts/deploy.sh'} as Record<string,string>,applicationBundles:[]};
  const declare=()=>writeFileSync(join(hybridSource,'bot/src/deployment-artifact-files.json'),JSON.stringify(declaration));declare();
  const git=(...args:string[])=>{const result=Bun.spawnSync(['git','-c','core.hooksPath=/dev/null','-C',hybridSource,...args],{stdout:'pipe',stderr:'pipe'});
    assert.equal(result.exitCode,0,result.stderr.toString());return result.stdout.toString().trim();};
  git('init','-q');git('config','user.name','Disposable Fixture');git('config','user.email','fixture@example.invalid');git('add','.');git('commit','-qm','Disposable older source');
  const oldCommit=git('rev-parse','HEAD');
  writeFileSync(join(hybridSource,'bot/src/codex-mutation-release-format.json'),readFileSync(join(source,'src/codex-mutation-release-format.json')));
  declaration.controlFiles[APP]='bot/src/codex-mutation-release-format.json';declaration.controlFiles[CONTROL]='bot/src/codex-mutation-release-format.json';declare();
  git('add','.');git('commit','-qm','Disposable protocol source');const modernCommit=git('rev-parse','HEAD');
  const hybridManager=new TrustedRootReleaseManager({repositoryRoot:hybridSource,releaseRoot:join(root,'hybrid-releases'),
    installRoot:join(root,'hybrid-install'),bunExecutable:process.execPath,historyCacheStateDirectory:state},{
    spawn:(command,options={})=>Bun.spawnSync(command,{cwd:options.cwd,stdin:options.stdin,stdout:'pipe',stderr:'pipe'}),
    build:async(entry,output)=>{mkdirSync(dirname(output),{recursive:true});writeFileSync(output,readFileSync(entry));}});
  const oldApplication=await hybridManager.prepare('hybrid-old-app',oldCommit,modernCommit);
  assert.equal(existsSync(join(oldApplication.artifactPath,APP)),false);assert.equal(existsSync(join(oldApplication.artifactPath,CONTROL)),true);
  assert.equal(oldApplication.manifest.git_commit,oldCommit);assert.equal(oldApplication.manifest.control_git_commit,modernCommit);
  assert.throws(()=>hybridManager.activate(oldApplication.artifactPath),/CODEX_MUTATION_APPLICATION_PROTOCOL_NOT_PROVEN/);
  const oldController=await hybridManager.prepare('hybrid-old-controller',modernCommit,oldCommit);
  assert.equal(existsSync(join(oldController.artifactPath,APP)),true);assert.equal(existsSync(join(oldController.artifactPath,CONTROL)),false);
  hybridManager.activate(oldController.artifactPath);
  const preparedModern=await hybridManager.prepare('hybrid-protocol-source',modernCommit,modernCommit);
  hybridManager.activate(preparedModern.artifactPath);assert.equal(hybridManager.currentArtifactPath(),preparedModern.artifactPath);
  console.log('Codex release compatibility: actual sealed app/control selection, rollback and startup; read-only first-protection/deploy/wrapper refusal; retained publication; old helper and source checkout refusals: PASS');
}finally{db.close();rmSync(root,{recursive:true,force:true});}
