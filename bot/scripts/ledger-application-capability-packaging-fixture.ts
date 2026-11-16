import assert from 'node:assert/strict';
import {mock} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,existsSync,symlinkSync,realpathSync} from 'node:fs';
import {resolve,join,dirname,basename} from 'node:path';
import {createHash} from 'node:crypto';
import ts from 'typescript';
const workspace=resolve(import.meta.dir,'../..'),root=mkdtempSync('/tmp/wal79-capability-packaging-'),repository=join(root,'repository'),oldRoot=join(root,'old-builder');
const BASE='99e66d2460c0b0ad8c58e5ac5d11fa002129c149';
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
function run(cmd:string[],cwd?:string,input?:Uint8Array){const result=Bun.spawnSync({cmd,cwd,stdin:input,stdout:'pipe',stderr:'pipe'});assert.equal(result.exitCode,0,result.stderr.toString());return result.stdout;}
function git(...args:string[]){return run(['/usr/bin/git','-C',repository,...args]).toString().trim();}
mkdirSync(repository);mkdirSync(oldRoot);
run(['/usr/bin/git','init','--quiet',repository]);
const common=run(['/usr/bin/git','rev-parse','--git-common-dir'],workspace).toString().trim();
mkdirSync(join(repository,'.git/objects/info'),{recursive:true});writeFileSync(join(repository,'.git/objects/info/alternates'),resolve(workspace,common,'objects')+'\n');
git('read-tree',BASE);git('checkout-index','-a');
const archive=run(['/usr/bin/git','-C',repository,'archive','--format=tar',BASE]);
run(['/usr/bin/tar','-xf','-','-C',oldRoot],undefined,archive);
const paths=(...args:string[])=>run(['/usr/bin/git','-C',workspace,'ls-files','-z',...args]).toString().split('\0').filter(Boolean);
const tracked=paths().filter(path=>!path.startsWith('tmp/')),untracked=paths('--others','--exclude-standard').filter(path=>/^(?:bot\/(?:src|scripts)\/|docs\/|systemd\/|scripts\/|\.github\/|AGENTS\.md$)/.test(path));
// Git owns source modes and symlinks. A disposable index/object store reads the
// current prospective source without touching its real index, refs or commits.
const sourcePaths=[...new Set([...tracked,...untracked])];
run(['/usr/bin/git','--git-dir',join(repository,'.git'),'--work-tree',workspace,'add','--all','--pathspec-from-file=-','--pathspec-file-nul'],workspace,Buffer.from(sourcePaths.join('\0')+'\0'));
const candidateTree=git('write-tree');git('checkout-index','-a','-f');assert.match(candidateTree,/^[a-f0-9]{40}$/);
assert.equal(run(['/usr/bin/git','-C',repository,'cat-file','-t',candidateTree]).toString().trim(),'tree');
// No new commit is created. prepare's actual git archive accepts this bound tree
// object as its source identifier; release commit provenance is outside this test.
symlinkSync(realpathSync(join(workspace,'bot/node_modules')),join(repository,'bot/node_modules'),'dir');
symlinkSync(realpathSync(join(workspace,'bot/node_modules')),join(oldRoot,'bot/node_modules'),'dir');
const oldBuilderPath=join(oldRoot,'bot/src/deployment-release.ts'),oldBuilderBytes=readFileSync(oldBuilderPath);
assert.equal(sha(oldBuilderBytes),sha(run(['/usr/bin/git','-C',repository,'show',BASE+':bot/src/deployment-release.ts'])));
mock.module(join(oldRoot,'bot/src/private-database-command.ts'),()=>({privateDatabaseCommand:(cmd:string[])=>cmd}));
const {TrustedRootReleaseManager}=await import(oldBuilderPath);
const oldAst=ts.createSourceFile(oldBuilderPath,oldBuilderBytes.toString(),ts.ScriptTarget.Latest,true);
const defaultServicesNode=oldAst.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='defaultServices');assert.ok(defaultServicesNode);
const defaultServicesSource=defaultServicesNode.getText(oldAst);
// Execute the old builder's exact private main build collaborator too. In
// particular, do not assume that forcing ESM in this fixture matches its default.
const oldDefaultServices=new Function('dirname','basename',ts.transpileModule(defaultServicesSource,{compilerOptions:{target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.None}}).outputText+'return defaultServices();')(dirname,basename);
const {commandCapability,authorityCapability,LEDGER_COMMAND_EXPORT}=await import('../src/deployment-launch-authority');
const oldDeclaration=JSON.parse(readFileSync(join(oldRoot,'bot/src/deployment-artifact-files.json'),'utf8'));
const newDeclaration=JSON.parse(readFileSync(join(repository,'bot/src/deployment-artifact-files.json'),'utf8'));
const unknownApplicationPaths=newDeclaration.applicationBundles.filter((p:string)=>!oldDeclaration.applicationBundles.includes(p));assert.ok(unknownApplicationPaths.length);
const builds:any[]=[],checks:any[]=[],compiled=new Map<string,{bytes:Uint8Array;exports:string[];sha256:string}>();let current:{application:string;control:string;name:string};
const tripwire=join(root,'UNSAFE_APPLICATION_EXECUTED');
const services={spawn(cmd:string[],options:any={}){
 if(cmd[0]==='/usr/bin/git'||cmd[0]==='/usr/bin/tar')return Bun.spawnSync({cmd,stdin:options.stdin,cwd:options.cwd,stdout:'pipe',stderr:'pipe'});
 assert.ok(cmd.some(part=>part.endsWith('/bot/scripts/presentation-release-check.ts')),JSON.stringify(cmd));checks.push({case:current.name,cmd,controlled:true});return {exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};
},async build(entry:string,output:string,target='bun'){
 const control=entry.includes('/control-source/'),owner=control?current.control:current.application;
 const marker=control?'/control-source/':'/source/',sourcePath=entry.slice(entry.indexOf(marker)+marker.length),sourceSha=sha(readFileSync(entry));
 const destination=output.slice(output.indexOf('/release/')+'/release/'.length);mkdirSync(dirname(output),{recursive:true});
 if(destination==='bot/src/index.js'){
  let cached=compiled.get(owner);if(!cached){await oldDefaultServices.build(entry,output,target);const bytes=new Uint8Array(readFileSync(output));cached={bytes,exports:new Bun.Transpiler({loader:'js'}).scan(Buffer.from(bytes).toString()).exports,sha256:sha(bytes)};compiled.set(owner,cached);}
  // Instrumented sealed main: executing any application byte is a test failure.
  // Its unmodified compiled export list is recorded separately and must match.
  const banner=`import {writeFileSync as __fixtureTripwire} from 'node:fs';__fixtureTripwire(${JSON.stringify(tripwire)},'UNSAFE');throw Error('APPLICATION_STARTUP_FORBIDDEN');\n`;
  writeFileSync(output,Buffer.concat([Buffer.from(banner),cached.bytes]));
 }else writeFileSync(output,`// Disposable non-main build witness; no helper is executed.\nexport const fixtureSource=${JSON.stringify({owner,sourcePath,sourceSha,target})};\n`);
 builds.push({case:current.name,destination,entry,sourcePath,sourceSha,owner,controlSource:control,outputSha:sha(readFileSync(output)),actualMainBuild:destination==='bot/src/index.js'});
}};
const releaseRoot=join(root,'releases-root');
const manager=new TrustedRootReleaseManager({repositoryRoot:repository,releaseRoot,installRoot:join(root,'install'),bunExecutable:process.execPath},services);
const matrix:any[]=[];
for(const [name,application,control,expectedApplication,expectedAuthority] of [
 ['old-app-new-control',BASE,candidateTree,false,true],['new-app-old-control',candidateTree,BASE,true,false],
] as const){
 current={name,application,control};const prepared=await manager.prepare('fixture-'+name,application,control);
 const manifest=manager.verify(prepared.artifactPath),main=join(prepared.artifactPath,'bot/src/index.js'),exports=new Bun.Transpiler({loader:'js'}).scan(readFileSync(main,'utf8')).exports;
 assert.equal(commandCapability(prepared.artifactPath),expectedApplication);assert.equal(authorityCapability(prepared.artifactPath),expectedAuthority);
 assert.equal(exports.includes(LEDGER_COMMAND_EXPORT),expectedApplication);assert.equal(compiled.get(application)!.exports.includes(LEDGER_COMMAND_EXPORT),expectedApplication);
 assert.equal(existsSync(tripwire),false,'static capability scan must not execute the sealed throwing main');
 const helper=unknownApplicationPaths.find((p:string)=>p==='control/application/deploy-state.js')??unknownApplicationPaths[0];
 assert.ok(manifest.files[helper],helper);const build=builds.find(item=>item.case===name&&item.destination===helper)!;
 // The unchanged old builder uses the application's applicationPaths set to
 // choose source ownership; a new control's unknown paths come from control.
 assert.equal(build.owner,candidateTree);assert.equal(build.controlSource,!expectedApplication);
 assert.equal(sha(readFileSync(join(prepared.artifactPath,helper))),build.outputSha);
 const metadata='control/deployment-command-authority.json';
 assert.equal(Boolean(manifest.files[metadata]),expectedAuthority);
 if(expectedAuthority)assert.equal(sha(readFileSync(join(prepared.artifactPath,metadata))),sha(readFileSync(join(repository,newDeclaration.controlFiles[metadata]))));
 matrix.push({name,applicationSource:application,controlSource:control,artifactPath:prepared.artifactPath,manifest,applicationCapability:commandCapability(prepared.artifactPath),controllerAuthorityCapability:authorityCapability(prepared.artifactPath),compiledMainSha256:compiled.get(application)!.sha256,testedMainSha256:sha(readFileSync(main)),compiledExports:compiled.get(application)!.exports,testedExports:exports,unknownApplicationHelper:helper,helperOwner:build.owner,helperFromControl:build.controlSource,controllerJsonPresent:existsSync(join(prepared.artifactPath,metadata)),noApplicationExecution:!existsSync(tripwire)});
}
assert.equal(matrix[0].controllerJsonPresent,true);assert.equal(matrix[0].applicationCapability,false);assert.equal(matrix[0].helperFromControl,true);
assert.equal(matrix[1].controllerJsonPresent,false);assert.equal(matrix[1].applicationCapability,true);assert.equal(matrix[1].helperFromControl,false);
writeFileSync(join(root,'builds.json'),JSON.stringify(builds,null,2));writeFileSync(join(root,'checks.json'),JSON.stringify(checks,null,2));
const report={pass:true,root,baseCommit:BASE,candidateSourceTree:candidateTree,candidateIsGitTreeNotCommit:true,noCommitCreated:true,unchangedOldBuilderSha256:sha(oldBuilderBytes),unchangedOldMainBuildCollaboratorSha256:sha(defaultServicesSource),oldDeclarationSha256:sha(readFileSync(join(oldRoot,'bot/src/deployment-artifact-files.json'))),newDeclarationSha256:sha(readFileSync(join(repository,'bot/src/deployment-artifact-files.json'))),capabilitySourceSha256:sha(readFileSync(join(workspace,'bot/src/deployment-launch-authority.ts'))),entrySourceSha256:sha(readFileSync(join(repository,'bot/src/index.ts'))),unknownApplicationPaths,matrix,buildCalls:builds.length,controlledPresentationChecks:checks.length,noApplicationExecution:!existsSync(tripwire),limits:'Actual unchanged99e66 prepare/verify/declaration assembly and exact private defaultServices main-build body, real Git archive/tar, actual old/new main Bun bundles. Candidate is bound Git tree without new commit. Non-main build collaborators write source-hash witnesses, presentation check is controlled and privateDatabaseCommand is identity-mocked; no application/helper startup, production inspection, full release gate, commit provenance, or installed launch proof.'};
writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
