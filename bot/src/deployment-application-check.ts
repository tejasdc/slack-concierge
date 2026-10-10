import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {TrustedRootReleaseManager,failedCheckSummary,type ReleaseManifest} from './deployment-release';
import {releaseCodexBridgePath} from './release-worker';

/** Runs in the candidate's existing preactivation command, including when an older control
 * built it. The Git archive is verified against the seal before executing isolated fixtures. */
export function checkReleaseApplication(artifact:string,repositoryRoot:string,releaseRoot:string){
 const manager=new TrustedRootReleaseManager({repositoryRoot,releaseRoot,installRoot:join(releaseRoot,'unused-install'),bunExecutable:process.execPath});
 const manifest=manager.verify(artifact);
 const archive=Bun.spawnSync({cmd:['/usr/bin/git','-C',repositoryRoot,'archive','--format=tar',manifest.git_commit],stdout:'pipe',stderr:'pipe'});
 if(archive.exitCode!==0)throw new Error('Candidate application archive is unavailable.');
 if(createHash('sha256').update(archive.stdout).digest('hex')!==manifest.source_tree_digest)
  throw new Error('Candidate application archive does not match its sealed source.');
 const scratch=mkdtempSync(join(tmpdir(),'concierge-release-application-'));
 try{
  const extracted=Bun.spawnSync({cmd:['/usr/bin/tar','-xf','-','-C',scratch],stdin:archive.stdout,stdout:'pipe',stderr:'pipe'});
  if(extracted.exitCode!==0)throw new Error('Candidate application archive could not be extracted.');
  // The same frozen candidate dependencies used by preparation must be visible to the
  // candidate source gate here. The extracted archive alone contains no node_modules.
  const dependencies=realpathSync(join(repositoryRoot,'bot/node_modules'));
  symlinkSync(dependencies,join(scratch,'bot/node_modules'),'dir');
  if(manifest.control_git_commit!==manifest.git_commit){
   const controlArchive=Bun.spawnSync({cmd:['/usr/bin/git','-C',repositoryRoot,'archive','--format=tar',manifest.control_git_commit],stdout:'pipe',stderr:'pipe'});
   if(controlArchive.exitCode!==0||createHash('sha256').update(controlArchive.stdout).digest('hex')!==manifest.control_source_tree_digest)
    throw new Error('Candidate control archive does not match its sealed source.');
   const controlRoot=join(scratch,'control-source');
   mkdirSync(controlRoot);
   const controlExtracted=Bun.spawnSync({cmd:['/usr/bin/tar','-xf','-','-C',controlRoot],stdin:controlArchive.stdout,stdout:'pipe',stderr:'pipe'});
   if(controlExtracted.exitCode!==0)throw new Error('Candidate control archive could not be extracted.');
   symlinkSync(dependencies,join(controlRoot,'bot/node_modules'),'dir');
   const check=spawnSync(process.execPath,[join(controlRoot,'bot/scripts/ledger-constructor-check.ts'),join(controlRoot,'bot')],
    {cwd:join(controlRoot,'bot'),encoding:'utf8',timeout:15_000,env:{...process.env,BUN_INSTALL_AUTO:'disable'}});
   if(check.error||check.status!==0)throw new Error(`Candidate control SQLite constructor check failed: ${failedCheckSummary((check.stderr||check.error?.message||'unknown'))}`);
  }
  const declarationPath=join(scratch,'bot/src/deployment-artifact-files.json');
  const declaration=existsSync(declarationPath)?JSON.parse(readFileSync(declarationPath,'utf8')):{};
  verifyApplicationProvenance(manifest,declaration.applicationBundles??[]);
  if(!(declaration.applicationBundles?.length))return {status:'legacy-application',git_commit:manifest.git_commit};
  const historyWorker='control/application/provider-history-page-worker.js';
  if(declaration.applicationBundles.includes(historyWorker)){
   const bridge=join(artifact,'bot/src/codex-app-server-bridge.mjs');
   if(releaseCodexBridgePath(join(artifact,historyWorker))!==bridge)
    throw new Error('Sealed history worker cannot resolve its Codex bridge.');
   const absentSocket=join(scratch,'missing-codex-app-server.sock');
   const bridgeCheck=spawnSync('/usr/bin/node',[bridge,absentSocket],{cwd:artifact,encoding:'utf8',timeout:5_000});
   if(bridgeCheck.error||bridgeCheck.status!==1||!bridgeCheck.stdout.includes('"type":"disconnect"')||
      bridgeCheck.stderr.includes('MODULE_NOT_FOUND'))
    throw new Error(`Sealed Codex bridge cannot execute: ${(bridgeCheck.stderr||bridgeCheck.error?.message||'unknown').slice(0,500)}`);
  }
  const gate=join(scratch,'bot/scripts/presentation-release-check.ts');
  if(!existsSync(gate))throw new Error('Candidate application is missing its presentation release check.');
  const checked=spawnSync(process.execPath,[gate],{cwd:join(scratch,'bot'),encoding:'utf8',timeout:90_000,
   env:{...process.env,BUN_INSTALL_AUTO:'disable',CONCIERGE_TEST_MODE:'1',CONCIERGE_TEST_AUTHORIZATION:'responsive-system-b1eed622',
    CONCIERGE_STATE_DIR:join(scratch,'isolated-owner'),CONCIERGE_CAPTURE_STATE_DIR:join(scratch,'isolated-capture')}});
  if(checked.error||checked.status!==0)throw new Error(`Candidate presentation check failed: ${failedCheckSummary((checked.stderr||checked.error?.message||'unknown'))}`);
  const result=JSON.parse(checked.stdout.trim().split('\n').at(-1)??'null');
  if(result?.check!=='presentation-release'||result.status!=='passed')throw new Error('Candidate presentation check returned no passing receipt.');
  return {...result,git_commit:manifest.git_commit,artifact_digest:manifest.artifact_digest};
 }finally{rmSync(scratch,{recursive:true,force:true});}
}

export function verifyApplicationProvenance(manifest:ReleaseManifest,paths:unknown){
 if(!Array.isArray(paths)||paths.some(path=>typeof path!=='string'||!/^control\/application\/[a-z0-9-]+\.js$/.test(path)))
  throw new Error('Candidate application bundle declaration is invalid.');
 for(const path of paths)if(!manifest.files[path])throw new Error(`Candidate application bundle is missing: ${path}`);
 if(paths.length&&manifest.git_commit!==manifest.control_git_commit&&manifest.application_bundle_source_digest!==manifest.source_tree_digest)
  throw new Error('Hybrid application worker provenance is unproved; the application and control must not be mixed.');
}
