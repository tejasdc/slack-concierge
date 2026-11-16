import {strict as assert} from 'node:assert';
import {copyFileSync,cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {TrustedRootReleaseManager} from '../src/deployment-release';
import {checkReleaseApplication,verifyApplicationProvenance} from '../src/deployment-application-check';
import {releaseWorkerPath} from '../src/release-worker';
import {Database} from 'bun:sqlite';
import {CUSTODY_APPLICATION_CAPABILITY_PATH,CUSTODY_CONTROL_CAPABILITY_PATH,requireCustodyReader} from '../src/codex-custody-compatibility';
import {requireOfflineReleaseServiceStopped} from '../src/ledger-access-policy';
import {releasePublicationAcceptance} from './release-publication-acceptance';
import {IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION} from '../src/test-authorizations';

// Disposable ledgers/receiver sockets only; systemd/health effects are substituted.
const source=resolve(import.meta.dir,'../..'),scratch=mkdtempSync(join(tmpdir(),'release-compatibility-'));
function run(cmd:string[],cwd=source){const result=Bun.spawnSync({cmd,cwd,stdout:'pipe',stderr:'pipe'});if(result.exitCode!==0)throw new Error(result.stderr.toString());return result.stdout;}
const repo=join(scratch,'repo'),releases=join(scratch,'deploy');
try{
 const stopped='LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlPID=0\nJob=\n';
 assert.doesNotThrow(()=>requireOfflineReleaseServiceStopped('fixture.service',()=>({status:0,stdout:stopped})),
  'the existing offline release path accepts only positively observed stopped service state');
 for(const state of [stopped.replace('MainPID=0','MainPID=42'),stopped.replace('Job=\n','Job=start/running\n'),''])
  assert.throws(()=>requireOfflineReleaseServiceStopped('fixture.service',()=>({status:0,stdout:state})),/fully stopped/,
   'an environment flag alone cannot authorize direct pointer publication');
 mkdirSync(repo);
 // Preserve the actual last pre-custody builder/receiver. A moving merge-base eventually
 // includes the behavior this fixture must prove an OLD receiver cannot provide.
 const baseCommit='4f59051ea30711ceaa9ac97c5c663cfe1eff1ead';
 const archive=Bun.spawnSync({cmd:['git','archive','--format=tar',baseCommit],cwd:source,stdout:'pipe',stderr:'pipe'});
 if(archive.exitCode!==0)throw new Error(archive.stderr.toString());
 const extracted=Bun.spawnSync({cmd:['tar','-xf','-','-C',repo],stdin:archive.stdout,stdout:'pipe',stderr:'pipe'});
 if(extracted.exitCode!==0)throw new Error(extracted.stderr.toString());
 run(['git','init','-q'],repo);run(['git','add','-A'],repo);
 run(['git','-c','user.name=Fixture','-c','user.email=fixture@invalid','-c','core.hooksPath=/dev/null','commit','-qm','Preserved base source'],repo);
 const baseApplication=run(['git','rev-parse','HEAD'],repo).toString().trim();
 // Replace the archive with the exact current candidate tree while preserving the base
 // commit as an independently selectable application source in this disposable repository.
 for(const entry of readdirSync(repo))if(entry!=='.git')rmSync(join(repo,entry),{recursive:true,force:true});
 for(const file of run(['git','ls-files','-co','--exclude-standard']).toString().trim().split('\n')){
  if(!file||!existsSync(join(source,file)))continue;
  mkdirSync(dirname(join(repo,file)),{recursive:true});copyFileSync(join(source,file),join(repo,file));
 }
 run(['git','init','-q'],repo);run(['git','add','.'],repo);
 run(['git','add','-f','bot/src/codex-custody-format.json','bot/src/codex-custody-control-format.json'],repo);
 run(['git','-c','user.name=Fixture','-c','user.email=fixture@invalid','-c','core.hooksPath=/dev/null','commit','-qm','Isolated candidate'],repo);
 const candidate=run(['git','rev-parse','HEAD'],repo).toString().trim();
 symlinkSync(join(source,'bot/node_modules'),join(repo,'bot/node_modules'),'dir');
 // Load the exact preserved base builder and its source dependencies, never the release-manager
 // CLI that composes the mutable deployment ledger at module load.
 const legacy=join(scratch,'legacy');mkdirSync(legacy);
 for(const name of ['deployment-release.ts','deployment-artifact-files.json','private-database-command.ts','live-store-locations.ts',
  'provider-history-cache-compatibility.ts','provider-history-cache-format.json'])
  writeFileSync(join(legacy,name),run(['git','show',`${baseCommit}:bot/src/${name}`]));
 const OldManager=(await import(join(legacy,'deployment-release.ts'))).TrustedRootReleaseManager;
 const environment={repositoryRoot:repo,releaseRoot:releases,installRoot:join(scratch,'install'),bunExecutable:process.execPath};
 const old=new OldManager(environment),modern=new TrustedRootReleaseManager(environment);
 // This fixture isolates source ownership and artifact assembly. The full release gate runs
 // presentation checks separately, so avoid repeating that long candidate suite per hybrid.
 for(const manager of [old,modern]){
  const spawn=manager.services.spawn.bind(manager.services);
  manager.services.spawn=(command,options)=>command.some(part=>part.endsWith('/bot/scripts/presentation-release-check.ts'))
   ?{exitCode:0,stdout:new Uint8Array(),stderr:new Uint8Array()}:spawn(command,options);
 }
 const baseArtifact=await old.prepare('preserved-base-artifact-fixture',baseApplication);
 const prepared=await old.prepare('old-control-fixture',candidate);
 modern.verify(prepared.artifactPath);
 if(process.env.CUSTODY_RELEASE_FIXTURE_SKIP_PRESENTATION!=='1'){
  const application=checkReleaseApplication(prepared.artifactPath,repo,releases);
  assert.equal(application.status,'passed');
 }
 const paths=JSON.parse(readFileSync(join(repo,'bot/src/deployment-artifact-files.json'),'utf8')).applicationBundles as string[];
 for(const path of paths){
  const name=path.split('/').at(-1)!.replace(/\.js$/,'') as Parameters<typeof releaseWorkerPath>[0];
  assert.equal(releaseWorkerPath(name,join(prepared.artifactPath,'bot/src/index.js')),join(prepared.artifactPath,path));
 }
 const workerState=join(scratch,'worker-state');mkdirSync(workerState);
 const presentation=new Database(join(workerState,'presentation.db'));
 presentation.exec('CREATE TABLE presentation_message_meta(singleton INTEGER,generation INTEGER,event_watermark INTEGER,source_head INTEGER,ready INTEGER); INSERT INTO presentation_message_meta VALUES(1,0,0,0,0)');presentation.close();
 const canonical=new Database(join(workerState,'state.db'));canonical.exec('CREATE TABLE presentation_change_log(sequence INTEGER)');canonical.close();
 const search=Bun.spawnSync({cmd:[process.execPath,join(prepared.artifactPath,'control/application/presentation-search-read.js')],
  stdin:Buffer.from(JSON.stringify({query:'fixture',limit:20})),env:{...process.env,CONCIERGE_STATE_DIR:workerState,CONCIERGE_TEST_MODE:'1'},stdout:'pipe',stderr:'pipe'});
 assert.equal(search.exitCode,0,search.stderr.toString());assert.equal(JSON.parse(search.stdout.toString()).coverage.complete,false);
 // Invoke the actual old-runner extension point from the sealed candidate (no ledger needed
 // for the explicit application-check command), with production-like state env replaced.
 if(process.env.CUSTODY_RELEASE_FIXTURE_SKIP_PRESENTATION!=='1'){
  const checked=Bun.spawnSync({cmd:[process.execPath,join(prepared.artifactPath,'control/drain-status.js'),'application-check'],
   env:{...process.env,CONCIERGE_REPO:repo,CONCIERGE_STATE_DIR:join(scratch,'never-opened-state')},stdout:'pipe',stderr:'pipe'});
  assert.equal(checked.exitCode,0,checked.stderr.toString()+checked.stdout.toString());
  assert.equal(existsSync(join(scratch,'never-opened-state')),false);
 }
 if(process.env.CUSTODY_RELEASE_FIXTURE_SKIP_PRESENTATION!=='1'){
  const adopted=Bun.spawnSync({cmd:[process.execPath,join(prepared.artifactPath,'control/drain-status.js'),'adoptable-check',
   '--running',baseArtifact.artifactPath,'--rollback',baseArtifact.artifactPath],env:{...process.env,CONCIERGE_REPO:repo,CONCIERGE_STATE_DIR:workerState},stdout:'pipe',stderr:'pipe'});
  assert.equal(adopted.exitCode,0,adopted.stderr.toString()+adopted.stdout.toString());
  assert.equal(JSON.parse(adopted.stdout.toString()).status,'compatible');
  assert.match(adopted.stderr.toString(),/candidate_application_checked/);
 }
 // A missing sealed worker is refused by integrity verification; a hybrid without explicit
 // application-source provenance is refused even if every file exists.
 const missing={...prepared.manifest,files:{...prepared.manifest.files}};delete missing.files[paths[0]!];
 assert.throws(()=>verifyApplicationProvenance(missing,paths),/missing/);
 assert.throws(()=>verifyApplicationProvenance({...prepared.manifest,control_git_commit:'a'.repeat(40),
  application_bundle_source_digest:'0'.repeat(64)},paths),/provenance/);
 assert.doesNotThrow(()=>verifyApplicationProvenance({...prepared.manifest,control_git_commit:'a'.repeat(40),
  application_bundle_source_digest:prepared.manifest.source_tree_digest},paths));
 // New builder verifies older sealed artifacts and emits application provenance itself.
 const next=await modern.prepare('modern-control-fixture',candidate);
 old.verify(next.artifactPath);assert.equal(next.manifest.application_bundle_source_digest,next.manifest.source_tree_digest);
 const actualLegacyHybrid=await modern.prepare('actual-legacy-app-current-control-fixture',baseApplication,candidate);
 await releasePublicationAcceptance({source,scratch,repo,baseCommit,manager:modern,
  oldArtifact:baseArtifact.artifactPath,modernArtifact:next.artifactPath,
  modernRollback:prepared.artifactPath,hybridArtifact:actualLegacyHybrid.artifactPath});
 // A control-only upgrade keeps worker bytes from the application commit. Older installed
 // builders may or may not already emit the exact application-source proof.
 const speechSource=join(repo,'bot/src/speech-job-worker.ts');
 writeFileSync(speechSource,readFileSync(speechSource,'utf8')+'\nexport const fixtureControlOnly="CONTROL_WORKER_MUST_NOT_REPLACE_APPLICATION";\n');
 run(['git','add','.'],repo);run(['git','-c','user.name=Fixture','-c','user.email=fixture@invalid','-c','core.hooksPath=/dev/null','commit','-qm','Isolated control change'],repo);
 const control=run(['git','rev-parse','HEAD'],repo).toString().trim();
 // Synthesize the prior application/controller generation: its own declaration does not
 // advertise custody-reader support, while its independent controller capability remains.
 // Give its application capability path distinguishable bytes so a hybrid copy from the
 // control source cannot accidentally pass by finding the same file at both roots.
 const artifactDeclarationPath=join(repo,'bot/src/deployment-artifact-files.json');
 const oldGeneration=JSON.parse(readFileSync(artifactDeclarationPath,'utf8'));
 const oldApplicationCapabilitySource=oldGeneration.controlFiles[CUSTODY_APPLICATION_CAPABILITY_PATH] as string;
 const newApplicationCapability=JSON.parse(readFileSync(join(repo,oldApplicationCapabilitySource),'utf8'));
 const oldControllerCapabilitySource=oldGeneration.controlFiles[CUSTODY_CONTROL_CAPABILITY_PATH] as string;
 const selectedOldControllerCapability=JSON.parse(readFileSync(join(repo,oldControllerCapabilitySource),'utf8'));
 delete oldGeneration.controlFiles[CUSTODY_APPLICATION_CAPABILITY_PATH];
 writeFileSync(artifactDeclarationPath,JSON.stringify(oldGeneration,null,2)+'\n');
 writeFileSync(join(repo,oldApplicationCapabilitySource),'{"schema":1,"successorCustody":0}\n');
 run(['git','add','.'],repo);run(['git','-c','user.name=Fixture','-c','user.email=fixture@invalid','-c','core.hooksPath=/dev/null','commit','-qm','Prior custody capability generation'],repo);
 const oldCapabilityGeneration=run(['git','rev-parse','HEAD'],repo).toString().trim();
 const oldApplicationNewControl=await modern.prepare('old-application-new-control-fixture',oldCapabilityGeneration,control);
 modern.verify(oldApplicationNewControl.artifactPath);
 assert.equal(oldApplicationNewControl.manifest.files[CUSTODY_APPLICATION_CAPABILITY_PATH],undefined,
  'an old application cannot inherit the newer controller application capability');
 assert.equal(oldApplicationNewControl.manifest.files[CUSTODY_CONTROL_CAPABILITY_PATH]!==undefined,true,
  'the newer controller keeps its separate controller capability');
 const newApplicationOldControl=await modern.prepare('new-application-old-control-fixture',control,oldCapabilityGeneration);
 modern.verify(newApplicationOldControl.artifactPath);
 assert.deepEqual(JSON.parse(readFileSync(join(newApplicationOldControl.artifactPath,CUSTODY_APPLICATION_CAPABILITY_PATH),'utf8')),
  newApplicationCapability,
  'the application capability bytes come from the new application commit');
 assert.deepEqual(JSON.parse(readFileSync(join(newApplicationOldControl.artifactPath,CUSTODY_CONTROL_CAPABILITY_PATH),'utf8')),
  selectedOldControllerCapability,
  'the independent controller capability bytes come from the selected old controller commit');
 assert.equal(newApplicationOldControl.manifest.custody_application_provenance?.applicationSourceTreeDigest,
  newApplicationOldControl.manifest.source_tree_digest,'new hybrid binds custody capability provenance to its application source tree');
 assert.equal(newApplicationOldControl.manifest.custody_application_provenance?.applicationCapabilityDigest,
  newApplicationOldControl.manifest.files[CUSTODY_APPLICATION_CAPABILITY_PATH],'new hybrid binds provenance to the exact app capability bytes');
 const custodyState=join(scratch,'custody-state');mkdirSync(custodyState);
 const activationManager=new TrustedRootReleaseManager({...environment,custodyStateDirectory:custodyState});
 activationManager.activateControl(newApplicationOldControl.artifactPath);
 requireCustodyReader(custodyState,releases);
 const falseOldBaseHybrid=await old.prepare('old-builder-old-app-new-control-fixture',baseApplication,candidate);
 modern.verify(falseOldBaseHybrid.artifactPath);
 assert.equal(falseOldBaseHybrid.manifest.application_bundle_source_digest,falseOldBaseHybrid.manifest.source_tree_digest,
  'the base builder emits the existing generic app digest that did not bind the custody capability');
 assert.equal(falseOldBaseHybrid.manifest.custody_application_provenance,undefined,
  'the preserved base builder cannot emit the new custody-specific provenance record');
 assert.throws(()=>activationManager.activate(falseOldBaseHybrid.artifactPath),/CODEX_CUSTODY_APPLICATION_PROVENANCE_NOT_PROVEN/,
  'current activation gate refuses exact base-builder x base-app x new-controller false certification');
 assert.throws(()=>activationManager.activateControl(falseOldBaseHybrid.artifactPath),/CODEX_CUSTODY_APPLICATION_PROVENANCE_NOT_PROVEN/,
  'promote/set-control control activation refuses the same false application capability');
 assert.throws(()=>activationManager.restore(falseOldBaseHybrid.artifactPath),/CODEX_CUSTODY_APPLICATION_PROVENANCE_NOT_PROVEN/,
  'full LKG restoration refuses the same false application capability before either pointer changes');
 const sameCommitOldBuilder=await old.prepare('same-commit-old-builder-normal-rollout-fixture',candidate,candidate);
 assert.equal(sameCommitOldBuilder.manifest.git_commit,sameCommitOldBuilder.manifest.control_git_commit);
 assert.equal(sameCommitOldBuilder.manifest.custody_application_provenance,undefined);
 assert.doesNotThrow(()=>activationManager.activate(sameCommitOldBuilder.artifactPath),
  'same-commit normal rollout remains accepted through the sealed capability');
 assert.doesNotThrow(()=>activationManager.activateControl(sameCommitOldBuilder.artifactPath),
  'same-commit promote/set-control remains accepted through the sealed controller capability');
 assert.doesNotThrow(()=>activationManager.activate(newApplicationOldControl.artifactPath),
  'new hybrid with app-specific provenance activates under retained custody');
 // Race both serialized owner orderings against real disposable release pointers. An old
 // controller selected first prevents requirement publication; a requirement published first
 // prevents that controller from becoming selected afterward.
 const previousEnv={repo:process.env.CONCIERGE_REPO,state:process.env.CONCIERGE_STATE_DIR,release:process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT,
  runtime:process.env.CONCIERGE_DEPLOYMENT_RUNTIME_DIR,bun:process.env.CONCIERGE_BUN_BIN};
 process.env.CONCIERGE_REPO=repo;
 process.env.CONCIERGE_TEST_AUTHORIZATION=IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION;
 process.env.CONCIERGE_DEPLOYMENT_RUNTIME_DIR=join(scratch,'runtime');process.env.CONCIERGE_BUN_BIN=process.execPath;
 const requirementsFirstState=join(scratch,'requirements-first-state');mkdirSync(requirementsFirstState);
 const requirementsFirstRoot=join(scratch,'requirements-first-release');
 process.env.CONCIERGE_STATE_DIR=requirementsFirstState;process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT=requirementsFirstRoot;
 const {localOwnerRequestApiHandler,requestApiHandler}=await import('../src/routed-request-api');
 const releaseOwner=localOwnerRequestApiHandler(requestApiHandler(null,undefined,undefined,{handle:async()=>null} as any),
  undefined,{handle:async()=>null} as any);
 const publishThroughOwner=async(operation:string,artifactPath:string)=>releaseOwner(new Request('http://owner/internal/deployment-release',{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation,artifactPath,runId:'00000000-0000-4000-8000-000000000001'})}));
 const requirementsFirstReleases=join(requirementsFirstRoot,'releases');mkdirSync(requirementsFirstReleases,{recursive:true});
 const requirementsFirstSupported=join(requirementsFirstReleases,newApplicationOldControl.manifest.artifact_digest);
 cpSync(newApplicationOldControl.artifactPath,requirementsFirstSupported,{recursive:true});
 const requirementsFirstOld=join(requirementsFirstReleases,baseArtifact.manifest.artifact_digest);
 cpSync(baseArtifact.artifactPath,requirementsFirstOld,{recursive:true});
 const requirementsFirstManager=new TrustedRootReleaseManager({...environment,releaseRoot:requirementsFirstRoot,
  custodyStateDirectory:requirementsFirstState});
 const supportedControllerResponse=await publishThroughOwner('activate-control-files',requirementsFirstSupported);
 assert.equal(supportedControllerResponse.ok,true,JSON.stringify(await supportedControllerResponse.json()),
  'the actual serving-owner route publishes a supported controller before the requirement');
 requireCustodyReader(requirementsFirstState,requirementsFirstRoot);
 assert.equal((await publishThroughOwner('activate-control-files',requirementsFirstOld)).ok,false,
  'control-first after requirement publication is refused');
 const requirementsFirstUnproven=join(requirementsFirstReleases,falseOldBaseHybrid.manifest.artifact_digest);
 cpSync(falseOldBaseHybrid.artifactPath,requirementsFirstUnproven,{recursive:true});
 const rejectedPromotion=await releaseOwner(new Request('http://owner/internal/deployment-release',{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation:'promote-and-activate-control',
   artifactPath:requirementsFirstUnproven,artifactDigest:falseOldBaseHybrid.manifest.artifact_digest,
   runId:'00000000-0000-4000-8000-000000000001'})}));
 assert.equal(rejectedPromotion.ok,false,'combined promote/control publication refuses before a false promotion');
 assert.match((await rejectedPromotion.json() as {error:string}).error,/CODEX_CUSTODY_APPLICATION_PROVENANCE_NOT_PROVEN/);
 assert.equal(requirementsFirstManager.controlArtifactPath(),requirementsFirstSupported,
  'the capable controller pointer survives the refused stale publication');
 const controlFirstState=join(scratch,'control-first-state');mkdirSync(controlFirstState);
 const controlFirstRoot=join(scratch,'control-first-release');
 const controlFirstReleases=join(controlFirstRoot,'releases');mkdirSync(controlFirstReleases,{recursive:true});
 const controlFirstOld=join(controlFirstReleases,baseArtifact.manifest.artifact_digest);
 cpSync(baseArtifact.artifactPath,controlFirstOld,{recursive:true});
 process.env.CONCIERGE_STATE_DIR=controlFirstState;process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT=controlFirstRoot;
 const controlFirstManager=new TrustedRootReleaseManager({...environment,releaseRoot:controlFirstRoot,
  custodyStateDirectory:controlFirstState});
 assert.equal((await publishThroughOwner('activate-control-files',controlFirstOld)).ok,true,
  'the actual serving-owner route may publish an old controller before any custody requirement');
 assert.throws(()=>requireCustodyReader(controlFirstState,controlFirstRoot),/CODEX_CUSTODY_READER_NOT_PROVEN/,
  'an older controller selected first prevents requirement publication');
 assert.equal(existsSync(join(controlFirstState,'codex-custody-successors','required-readers','successor-custody-v1.json')),false,
  'failed control-first ordering leaves no misleading custody requirement');
 if(previousEnv.repo===undefined)delete process.env.CONCIERGE_REPO;else process.env.CONCIERGE_REPO=previousEnv.repo;
 if(previousEnv.state===undefined)delete process.env.CONCIERGE_STATE_DIR;else process.env.CONCIERGE_STATE_DIR=previousEnv.state;
 if(previousEnv.release===undefined)delete process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT;else process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT=previousEnv.release;
 if(previousEnv.runtime===undefined)delete process.env.CONCIERGE_DEPLOYMENT_RUNTIME_DIR;else process.env.CONCIERGE_DEPLOYMENT_RUNTIME_DIR=previousEnv.runtime;
 if(previousEnv.bun===undefined)delete process.env.CONCIERGE_BUN_BIN;else process.env.CONCIERGE_BUN_BIN=previousEnv.bun;
 const hybrid=await modern.prepare('hybrid-fixture',candidate,control);
 assert.equal(readFileSync(join(hybrid.artifactPath,'control/application/speech-job-worker.js'),'utf8').includes('CONTROL_WORKER_MUST_NOT_REPLACE_APPLICATION'),false);
 if(process.env.CUSTODY_RELEASE_FIXTURE_SKIP_PRESENTATION!=='1')
  assert.equal(checkReleaseApplication(hybrid.artifactPath,repo,releases).status,'passed');
 const oldHybrid=await old.prepare('old-hybrid-fixture',candidate,control);
 assert.equal(oldHybrid.manifest.custody_application_provenance,undefined);
 assert.throws(()=>activationManager.activate(oldHybrid.artifactPath),/CODEX_CUSTODY_APPLICATION_PROVENANCE_NOT_PROVEN/,
  'an old builder cannot promote a hybrid custody capability using only the generic application digest');
 if(process.env.CUSTODY_RELEASE_FIXTURE_SKIP_PRESENTATION==='1'){
  // This debug acceptance mode keeps the custody release path but omits the separate full app suite.
 } else if(oldHybrid.manifest.application_bundle_source_digest===oldHybrid.manifest.source_tree_digest)
  assert.equal(checkReleaseApplication(oldHybrid.artifactPath,repo,releases).status,'passed');
 else assert.throws(()=>checkReleaseApplication(oldHybrid.artifactPath,repo,releases),/provenance/);
 // A missing gate must be refused before activation, whether the installed builder already
 // refuses preparation or only the candidate's preactivation check knows that boundary.
 rmSync(join(repo,'bot/scripts/presentation-release-check.ts'));
 run(['git','add','.'],repo);run(['git','-c','user.name=Fixture','-c','user.email=fixture@invalid','-c','core.hooksPath=/dev/null','commit','-qm','Isolated missing gate'],repo);
 const missingGateCommit=run(['git','rev-parse','HEAD'],repo).toString().trim();
 let missingGate:Awaited<ReturnType<typeof old.prepare>>|undefined;
 let missingGateRefusedAt='preactivation';
 try{missingGate=await old.prepare('missing-gate-fixture',missingGateCommit);}
 catch(error){assert.match(String(error),/missing its presentation release check/);missingGateRefusedAt='preparation';}
 if(missingGate)assert.throws(()=>checkReleaseApplication(missingGate.artifactPath,repo,releases),/missing its presentation release check/);
 console.log(JSON.stringify({check:'release-application-compatibility',status:'passed',oldControl:baseCommit,
  workers:paths.length,oldToNewPreactivation:true,newToOldVerification:true,isolatedState:true,
  hybridApplicationPinned:true,oldBuilderGenericApplicationDigestMatches:oldHybrid.manifest.application_bundle_source_digest===oldHybrid.manifest.source_tree_digest,
  custodyApplicationProvenanceBound:newApplicationOldControl.manifest.custody_application_provenance?.applicationCapabilityDigest
    ===newApplicationOldControl.manifest.files[CUSTODY_APPLICATION_CAPABILITY_PATH],
  baseBuilderOldApplicationNewControllerRefused:true,sameCommitRolloutAccepted:true,provenHybridAccepted:true,
  firstRequirementPublicationSerialized:true,ownerReleaseRouteExercised:true,
  oldBuilderHybridActivationRefused:true,missingGateRefused:true,missingGateRefusedAt}));
}finally{rmSync(scratch,{recursive:true,force:true});}
