import assert from 'node:assert/strict';
import {mock} from 'bun:test';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import ts from 'typescript';
import {runPrivatePresentationCheck} from '../src/private-presentation-check';

assert.equal(process.env.CONCIERGE_PRIVATE_CODE_BOUNDARY_VERIFIED,'1');
const root=mkdtempSync('/tmp/private-presentation-check-'),repository=join(root,'repository'),artifact=join(root,'artifact');
const release=join(root,'release'),started=join(root,'started');
const env={...process.env,CONCIERGE_PRIVATE_CODE_STATE:join(root,'state'),CONCIERGE_STATE_DIR:join(root,'state'),CONCIERGE_STATE_DB:join(root,'state/state.db')};
const sha=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
function git(args:string[],input?:Uint8Array){
 const result=Bun.spawnSync({cmd:['/usr/bin/git','-C',repository,...args],stdin:input,env:{...process.env,
  GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@invalid'},stdout:'pipe',stderr:'pipe'});
 assert.equal(result.exitCode,0,result.stderr.toString());return result.stdout;
}
try{
 mkdirSync(repository);mkdirSync(artifact);mkdirSync(join(root,'state'));
 mkdirSync(join(repository,'bot/scripts'),{recursive:true});mkdirSync(join(repository,'bot/src'));
 writeFileSync(join(repository,'bot/src/deployment-artifact-files.json'),JSON.stringify({applicationBundles:['control/application/fixture.js']}));
 writeFileSync(join(repository,'bot/scripts/presentation-release-check.ts'),`import{existsSync,writeFileSync}from'node:fs';
 if(process.env.CONCIERGE_PRIVATE_CODE_BOUNDARY_VERIFIED!=='1')throw Error('private graph boundary absent');
 if(!process.argv.includes('--bounded-child'))throw Error('bounded graph role absent');
 writeFileSync(${JSON.stringify(started)},'1');while(!existsSync(${JSON.stringify(release)}))await Bun.sleep(2);
 console.log(JSON.stringify({check:'presentation-release',status:'passed',controlledGraph:true}));`);
 git(['init','--quiet']);git(['add','.']);const tree=git(['write-tree']).toString().trim();
 const commit=git(['commit-tree',tree],Buffer.from('Owned async application check\n')).toString().trim();
 symlinkSync(resolve(import.meta.dir,'../node_modules'),join(repository,'bot/node_modules'),'dir');
 const archive=git(['archive','--format=tar',commit]);
 const manifest={git_commit:commit,control_git_commit:commit,source_tree_digest:sha(archive),artifact_digest:'fixture-seal',files:{'control/application/fixture.js':'fixture'}};
 mock.module('../src/deployment-release',()=>({TrustedRootReleaseManager:class{verify(){return manifest;}},failedCandidateCheck:(value:unknown)=>JSON.stringify(value),CANDIDATE_PRESENTATION_TIMEOUT_SECONDS:120}));
 const {checkReleaseApplication}=await import('../src/deployment-application-check');
 let settled=false;const result=checkReleaseApplication(artifact,repository,root).finally(()=>{settled=true;});
 const deadline=performance.now()+5000;while(!existsSync(started)){assert.ok(performance.now()<deadline);await Bun.sleep(2);}
 assert.equal(settled,false,'application result cannot overtake the original graph');
 writeFileSync(release,'1');assert.equal((await result).status,'passed');
 const failed=await runPrivatePresentationCheck([process.execPath,'-e','throw Error("owned gate refusal")'],root,env);
 assert.equal(failed.exitCode,1);assert.match(failed.stderr.toString(),/owned gate refusal/);
 // Audit all actual references, including scripts outside the recurring suite.
 const callers=['drain-status.ts','sealed-codex-history-bridge.ts','release-application-compatibility.ts'];
 let awaited=0;
 for(const name of callers){
  const path=join(import.meta.dir,name),source=ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true);
  const visit=(node:ts.Node)=>{
   if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='checkReleaseApplication'){
    let parent=node.parent;
    if(ts.isArrowFunction(parent)){assert.ok(parent.parent&&ts.isCallExpression(parent.parent)&&parent.parent.expression.getText(source)==='assert.rejects');parent=parent.parent.parent;}
    assert.ok(ts.isAwaitExpression(parent),`${name} must await its application check`);awaited++;
   }ts.forEachChild(node,visit);
  };visit(source);
 }
 assert.equal(awaited,7);
 const control=join(artifact,'control');mkdirSync(control);writeFileSync(join(artifact,'manifest.json'),'{}');
 const replacements:Record<string,number>={};
 const built=await Bun.build({entrypoints:[join(import.meta.dir,'drain-status.ts')],target:'bun',outdir:control,naming:'drain-status.js',plugins:[{
  name:'closed-application-check-cli-collaborators',setup(build){
   build.onResolve({filter:/^bun:sqlite$/},()=>({path:'sqlite-denied',namespace:'application-cli'}));
   build.onLoad({filter:/.*/,namespace:'application-cli'},()=>({contents:'export class Database{constructor(){throw Error("CLI_SQLITE_CONSTRUCTOR_REACHED")}}',loader:'js'}));
   build.onLoad({filter:/deployment-application-check\.ts$/},args=>{
    replacements.application=(replacements.application??0)+1;
    return{contents:'export async function checkReleaseApplication(){await Bun.sleep(20);return{status:"passed",settledBeforeCliReply:true}}',loader:'ts'};
   });
   build.onLoad({filter:/execution-host-client\.ts$/},()=>{
    replacements.host=(replacements.host??0)+1;return{contents:'export const HOST_PROTOCOL_VERSION=1;export const ADOPTABLE_HOST_PROTOCOLS=[1];',loader:'ts'};
   });
  },
 }]});
 assert.equal(built.success,true,built.logs.map(String).join('\n'));assert.deepEqual(replacements,{application:1,host:1});
 const cli=await runPrivatePresentationCheck([process.execPath,join(control,'drain-status.js'),'application-check'],root,env);
 assert.equal(cli.exitCode,0,cli.stderr.toString());
 const reply=JSON.parse(cli.stdout.toString().trim());assert.equal(reply.status,'passed');assert.equal(reply.settledBeforeCliReply,true);
 console.log(JSON.stringify({fixture:'private-presentation-check',status:'passed',actualApplicationArchive:true,controlledSeal:true,controlledGraphHeld:true,resultWaited:true,failureRetained:true,awaitedCallSites:awaited,actualDrainStatusReplyAwaited:true,cliControlledCheck:true,cliDatabaseConstructorDenied:true}));
}finally{rmSync(root,{recursive:true,force:true});}
