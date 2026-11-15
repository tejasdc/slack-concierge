import {strict as assert} from 'node:assert';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {TrustedRootReleaseManager} from '../src/deployment-release';
import {checkReleaseApplication,verifyApplicationProvenance} from '../src/deployment-application-check';
import {releaseWorkerPath} from '../src/release-worker';
import {Database} from 'bun:sqlite';
import {CUSTODY_APPLICATION_CAPABILITY_PATH,CUSTODY_CONTROL_CAPABILITY_PATH} from '../src/codex-custody-compatibility';

// No canonical ledger imports, supervisor calls, credential access, or live pointer changes.
const source=resolve(import.meta.dir,'../..'),scratch=mkdtempSync(join(tmpdir(),'release-compatibility-'));
function run(cmd:string[],cwd=source){const result=Bun.spawnSync({cmd,cwd,stdout:'pipe',stderr:'pipe'});if(result.exitCode!==0)throw new Error(result.stderr.toString());return result.stdout;}
const repo=join(scratch,'repo'),releases=join(scratch,'deploy');
try{
 mkdirSync(repo);
 for(const file of run(['git','ls-files','-co','--exclude-standard']).toString().trim().split('\n')){
  if(!file||!existsSync(join(source,file)))continue;
  mkdirSync(dirname(join(repo,file)),{recursive:true});copyFileSync(join(source,file),join(repo,file));
 }
 run(['git','init','-q'],repo);run(['git','add','.'],repo);
 run(['git','add','-f','bot/src/codex-custody-format.json','bot/src/codex-custody-control-format.json'],repo);
 run(['git','-c','user.name=Fixture','-c','user.email=fixture@invalid','-c','core.hooksPath=/dev/null','commit','-qm','Isolated candidate'],repo);
 const candidate=run(['git','rev-parse','HEAD'],repo).toString().trim();
 symlinkSync(join(source,'bot/node_modules'),join(repo,'bot/node_modules'),'dir');
 // This exact installed builder is pure artifact code; do not import its release-manager CLI,
 // which composes the mutable deployment ledger at module load.
 const legacy=join(scratch,'legacy');mkdirSync(legacy);
 const installedArtifact=realpathSync('/var/lib/slack-concierge-deployment/current');
 const installed=JSON.parse(readFileSync(join(installedArtifact,'manifest.json'),'utf8'));
 for(const name of ['deployment-release.ts','deployment-artifact-files.json','private-database-command.ts','live-store-locations.ts',
  'provider-history-cache-compatibility.ts','provider-history-cache-format.json'])
  writeFileSync(join(legacy,name),run(['git','show',`${installed.control_git_commit}:bot/src/${name}`]));
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
 const prepared=await old.prepare('old-control-fixture',candidate);
 modern.verify(prepared.artifactPath);
 const application=checkReleaseApplication(prepared.artifactPath,repo,releases);
 assert.equal(application.status,'passed');
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
 const checked=Bun.spawnSync({cmd:[process.execPath,join(prepared.artifactPath,'control/drain-status.js'),'application-check'],
  env:{...process.env,CONCIERGE_REPO:repo,CONCIERGE_STATE_DIR:join(scratch,'never-opened-state')},stdout:'pipe',stderr:'pipe'});
 assert.equal(checked.exitCode,0,checked.stderr.toString()+checked.stdout.toString());
 assert.equal(existsSync(join(scratch,'never-opened-state')),false);
 const adopted=Bun.spawnSync({cmd:[process.execPath,join(prepared.artifactPath,'control/drain-status.js'),'adoptable-check',
  '--running',installedArtifact,'--rollback',installedArtifact],env:{...process.env,CONCIERGE_REPO:repo,CONCIERGE_STATE_DIR:workerState},stdout:'pipe',stderr:'pipe'});
 assert.equal(adopted.exitCode,0,adopted.stderr.toString()+adopted.stdout.toString());
 assert.equal(JSON.parse(adopted.stdout.toString()).status,'compatible');
 assert.match(adopted.stderr.toString(),/candidate_application_checked/);
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
 const hybrid=await modern.prepare('hybrid-fixture',candidate,control);
 assert.equal(readFileSync(join(hybrid.artifactPath,'control/application/speech-job-worker.js'),'utf8').includes('CONTROL_WORKER_MUST_NOT_REPLACE_APPLICATION'),false);
 assert.equal(checkReleaseApplication(hybrid.artifactPath,repo,releases).status,'passed');
 const oldHybrid=await old.prepare('old-hybrid-fixture',candidate,control);
 if(oldHybrid.manifest.application_bundle_source_digest===oldHybrid.manifest.source_tree_digest)
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
 console.log(JSON.stringify({check:'release-application-compatibility',status:'passed',oldControl:installed.control_git_commit,
  workers:paths.length,oldToNewPreactivation:true,newToOldVerification:true,isolatedState:true,
  hybridApplicationPinned:true,installedHybridHasProvenance:oldHybrid.manifest.application_bundle_source_digest===oldHybrid.manifest.source_tree_digest,
  unprovenHybridRefused:oldHybrid.manifest.application_bundle_source_digest!==oldHybrid.manifest.source_tree_digest,missingGateRefused:true,missingGateRefusedAt}));
}finally{rmSync(scratch,{recursive:true,force:true});}
