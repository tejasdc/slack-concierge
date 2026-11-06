/**
 * One closed, replay-safe project creation operation. The owner validates and records the
 * workspace-organizer decision; this runner writes its own checkout and uses its own GitHub login.
 */
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { canonicalAgentsTemplate, canonicalDocsIndexTemplate } from './project-scaffold';
import { projectTemplate, templateAgentsSection, templateFiles, type ProjectTemplate } from './project-templates';
import { sessionProject } from './session-projects';
import {runnerGithubGitEnvironment} from './runner-git-auth';

const execFile = promisify(execFileCallback);
const NAME=/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;
const FOLDER=/^[a-z0-9][a-z0-9-]{0,99}$/;
const GROUP=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const LAB_GROUP='agent-ecology/expertise';
const PRIVATE_GIT_OPTIONS=['-c','core.hooksPath=/dev/null','-c','protocol.file.allow=never','-c','protocol.ssh.allow=never','-c','protocol.git.allow=never','-c','protocol.ext.allow=never','-c','submodule.recurse=false','-c','filter.lfs.smudge=','-c','core.fsmonitor=false'];

export type RunnerProjectSetupInput={orderId:string;project:string;purpose:string;group?:string;template?:ProjectTemplate};
export type RunnerProjectSetupResult={state:'done'|'already_present'|'refused'|'failed';project:string;relativePath:string;commit?:string;reason?:string;failureClass?:'transient'|'permanent'};
export type ProjectSetupRunnerServices={run?:(file:string,args:string[],cwd?:string)=>Promise<string>;workspaceRoot?:string;signal?:AbortSignal};

function exactKeys(value:unknown,keys:string[]):Record<string,any>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new Error('Invalid project setup job fields.');
  return value as Record<string,any>;
}
function safeName(value:unknown){if(typeof value!=='string'||!NAME.test(value)||value.split('-').every(word=>['commands','tools','scripts','utils','misc','stuff','test','project','new','temp','app','helpers','things','notes'].includes(word)))throw new Error('Invalid project name.');return value;}
function safePurpose(value:unknown){if(typeof value!=='string'||!value.trim()||value.length>1000||/[\r\n]/.test(value)||/[.!?]\s+\S/.test(value.trim()))throw new Error('Invalid one-sentence project purpose.');return value.trim();}
function safeGroup(value:unknown):string|undefined{
  if(value===undefined||value===null)return undefined;
  if(typeof value!=='string'||value.length>100||!(GROUP.test(value)||value===LAB_GROUP))throw new Error('Invalid project placement.');
  return value;
}
function safeOrderId(value:unknown){if(typeof value!=='string'||!/^[a-f0-9]{32}$/.test(value))throw new Error('Invalid project setup identity.');return value;}
function within(root:string,path:string){return path===root||path.startsWith(root.endsWith(sep)?root:`${root}${sep}`);}
function pathExists(path:string){try{lstatSync(path);return true;}catch(error:any){if(error?.code==='ENOENT')return false;throw error;}}
function repositoryName(project:string,group?:string){return group===LAB_GROUP?`expertise-${project}`:project;}
export function expectedRunnerProjectOrigin(project:string,group?:string){return `https://github.com/tejasdc/${repositoryName(project,group)}`;}
function destinationFor(root:string,project:string,group?:string){return group?join(root,group,project):join(root,project);}
function classify(error:unknown):'transient'|'permanent'{
  return /timed? ?out|econn(?:reset|refused|aborted)|network|temporary|socket|fetch failed|rate limit|could not resolve|remote end hung up|service unavailable|authentication failed|could not read username|credential helper/i.test(String(error))?'transient':'permanent';
}
function message(error:unknown){return (error instanceof Error?error.message:String(error)).replace(/[\r\n]/g,' ').slice(0,400);}
function projectPredicate(path:string){try{return lstatSync(join(path,'.git')).isDirectory()&&lstatSync(join(path,'AGENTS.md')).isFile();}catch{return false;}}
function verifyDirectory(path:string,root:string){
  try{const real=realpathSync(path);if(real!==path||!within(root,real)||!lstatSync(real).isDirectory())throw new Error('Project setup path is not a plain workspace directory.');}
  catch(error){if((error as any)?.code==='ENOENT')return false;throw error;}
  return true;
}
function gitEnv(){return {...runnerGithubGitEnvironment(),GIT_ALLOW_PROTOCOL:'https'};}
async function defaultRun(file:string,args:string[],cwd?:string,signal?:AbortSignal){return (await execFile(file,args,{cwd,encoding:'utf8',env:gitEnv(),maxBuffer:16*1024*1024,timeout:120_000,signal})).stdout.trim();}
function createScaffold(path:string,project:string,purpose:string,template?:ProjectTemplate,canonicalPath=path){
  const intent=join(path,'tmp','project-setup-intent.json');mkdirSync(dirname(intent),{recursive:true});
  const intended=JSON.stringify({project,purpose,...(template?{template}:{})});
  if(pathExists(intent)){if(readFileSync(intent,'utf8')!==intended)throw new Error('This folder has a different unfinished project setup.');}
  else writeFileSync(intent,intended,{flag:'wx',mode:0o600});
  const file=(name:string,content:string)=>{const target=join(path,name);if(pathExists(target)){if(readFileSync(target,'utf8')!==content)throw new Error(`Existing ${name} differs from the project scaffold.`);}else writeFileSync(target,content,{flag:'wx',mode:0o600});};
  mkdirSync(join(path,'docs'),{recursive:true});
  file('AGENTS.md',canonicalAgentsTemplate(project,canonicalPath).replace(`Working directory: \`${canonicalPath}\``,`${purpose}\n\nWorking directory: \`${canonicalPath}\``)+(template?templateAgentsSection(template):''));
  if(template)for(const [name,content] of Object.entries(templateFiles(template,project,purpose))){mkdirSync(dirname(join(path,name)),{recursive:true});file(name,content);}
  const claude=join(path,'CLAUDE.md');
  if(pathExists(claude)){if(!lstatSync(claude).isSymbolicLink()||readlinkSync(claude)!=='AGENTS.md')throw new Error('Existing CLAUDE.md is not the canonical link.');}
  else symlinkSync('AGENTS.md',claude);
  file('docs/README.md',canonicalDocsIndexTemplate(project));
  file('.gitignore','tmp/\nnotes\n');
}
function ensureGroup(root:string,group:string){
  const folder=join(root,group);
  if(group===LAB_GROUP){
    const lab=sessionProject(root,'agent-ecology');
    if(lab?.cwd!==join(root,'agent-ecology')||!pathExists(join(lab.cwd,'.git')))throw new Error('The agent-ecology project must be registered before adding an expertise.');
    const ignore=join(lab.cwd,'.gitignore');if(!pathExists(ignore)||!readFileSync(ignore,'utf8').split(/\r?\n/).includes('/expertise/'))throw new Error('The lab must ignore its expertise repositories before creating one.');
  }
  if(!pathExists(folder))mkdirSync(folder);
  if(!lstatSync(folder).isDirectory()||lstatSync(folder).isSymbolicLink()||pathExists(join(folder,'.git'))||pathExists(join(folder,'.obsidian')))throw new Error('Project placement must be a plain grouping folder.');
}
function vaultRoot(root:string){for(const path of [join(root,'vault'),join(root,'obsidian-vault','journalmaxx')])try{if(lstatSync(path).isDirectory()&&lstatSync(join(path,'.obsidian')).isDirectory())return path;}catch{}return null;}
function addNotesLink(root:string,project:string,destination:string){
  const vault=vaultRoot(root);if(!vault)return;
  const notes=join(vault,'projects',project,'notes'),link=join(destination,'notes');if(pathExists(link))return;
  mkdirSync(notes,{recursive:true});for(const file of ['inbox.md','TODOS.md'])if(!pathExists(join(notes,file)))writeFileSync(join(notes,file),file==='TODOS.md'?`# ${project} tasks\n`:`# ${project} notes\n`,{flag:'wx',mode:0o600});
  symlinkSync(relative(dirname(link),notes),link);
}

/** Execute only the single repository-creation operation; retries with one order id converge. */
export async function runProjectSetupJob(value:unknown,services:ProjectSetupRunnerServices={}):Promise<RunnerProjectSetupResult>{
  const data=exactKeys(value,['orderId','project','purpose','group','template','targetRunner']);
  const orderId=safeOrderId(data.orderId),project=safeName(data.project),purpose=safePurpose(data.purpose),group=safeGroup(data.group);
  if(typeof data.targetRunner!=='string'||data.targetRunner!==process.env.CONCIERGE_RUNNER_NAME)throw new Error('Project setup job reached the wrong runner.');
  const template=projectTemplate(data.template);
  const root=realpathSync(services.workspaceRoot??process.env.CONCIERGE_WORKSPACE_ROOT?.trim()??join(homedir(),'workspace'));
  const destination=destinationFor(root,project,group),relativePath=relative(root,destination);
  if(relativePath.startsWith('..')||relativePath.includes(`..${sep}`))throw new Error('Project setup destination escaped runner workspace.');
  const previouslyRegistered=sessionProject(root,project);
  if(previouslyRegistered&&previouslyRegistered.cwd!==destination)return {state:'refused',project,relativePath,reason:'This project name is already registered at a different location.'};
  if(pathExists(destination)){
    if(!verifyDirectory(destination,root)||!projectPredicate(destination))return {state:'refused',project,relativePath,reason:'A different folder already uses this project name.'};
    const origin=await (services.run??defaultRun)('git',['-c','core.hooksPath=/dev/null','-C',destination,'remote','get-url','origin']).catch(()=>null);
    if(String(origin).replace(/\.git$/,'')!==expectedRunnerProjectOrigin(project,group))return {state:'refused',project,relativePath,reason:'The existing project has a different GitHub origin.'};
    const repository=JSON.parse(await (services.run??defaultRun)('gh',['repo','view',`tejasdc/${repositoryName(project,group)}`,'--json','visibility,url']));
    if(repository.visibility!=='PRIVATE'||repository.url!==expectedRunnerProjectOrigin(project,group))return {state:'refused',project,relativePath,reason:'The existing GitHub repository is not the expected private repository.'};
    const commit=await (services.run??defaultRun)('git',[...PRIVATE_GIT_OPTIONS,'-C',destination,'rev-parse','HEAD']);
    const remoteHead=(await (services.run??defaultRun)('git',[...PRIVATE_GIT_OPTIONS,'-C',destination,'ls-remote','--exit-code','origin','HEAD'])).split(/\s+/)[0];
    if(remoteHead!==commit)return {state:'refused',project,relativePath,reason:'The existing project and private GitHub repository do not have the same commit.'};
    addNotesLink(root,project,destination);
    return {state:'already_present',project,relativePath,commit};
  }
  if(group)ensureGroup(root,group);
  const temporaryRoot=join(root,'.project-setup');
  if(pathExists(temporaryRoot)&&(!lstatSync(temporaryRoot).isDirectory()||lstatSync(temporaryRoot).isSymbolicLink()))throw new Error('Project setup staging folder is not a plain directory.');
  mkdirSync(temporaryRoot,{recursive:true,mode:0o700});
  const stagingParent=join(temporaryRoot,orderId),staging=join(stagingParent,project);
  if(pathExists(stagingParent)&&(!lstatSync(stagingParent).isDirectory()||lstatSync(stagingParent).isSymbolicLink()))throw new Error('Project setup order folder is not a plain directory.');
  if(pathExists(staging)&&(!lstatSync(staging).isDirectory()||lstatSync(staging).isSymbolicLink()))throw new Error('Project setup staging destination is occupied.');
  mkdirSync(stagingParent,{recursive:true,mode:0o700});mkdirSync(staging,{recursive:true,mode:0o700});
  const run=services.run??((file:string,args:string[],cwd?:string)=>defaultRun(file,args,cwd,services.signal));
  try{
    createScaffold(staging,project,purpose,template,destination);
    if(!pathExists(join(staging,'.git')))await run('git',[...PRIVATE_GIT_OPTIONS,'-C',staging,'init']);
    let commit:string;
    try{commit=await run('git',[...PRIVATE_GIT_OPTIONS,'-C',staging,'rev-parse','HEAD']);}
    catch{await run('git',[...PRIVATE_GIT_OPTIONS,'-C',staging,'add','--all']);await run('git',[...PRIVATE_GIT_OPTIONS,'-C',staging,'-c','user.name=Concierge project setup','-c','user.email=concierge-project-setup@users.noreply.github.com','commit','-m',`Create ${project} project`]);commit=await run('git',[...PRIVATE_GIT_OPTIONS,'-C',staging,'rev-parse','HEAD']);}
    const status=await run('git',[...PRIVATE_GIT_OPTIONS,'-C',staging,'status','--porcelain']);if(status)throw new Error('The project scaffold has uncommitted files.');
    const expected=expectedRunnerProjectOrigin(project,group);
    const origin=await run('git',[...PRIVATE_GIT_OPTIONS,'-C',staging,'remote','get-url','origin']).catch(()=>null);
    if(origin&&String(origin).replace(/\.git$/,'')!==expected)throw new Error('The staged project has a different GitHub origin.');
    if(!origin){
      try{await run('gh',['repo','create',`tejasdc/${repositoryName(project,group)}`,'--private','--description',purpose,'--source',staging,'--push']);}
      catch(createError){
        const repository=JSON.parse(await run('gh',['repo','view',`tejasdc/${repositoryName(project,group)}`,'--json','visibility,url']));
        if(repository.visibility!=='PRIVATE'||repository.url!==expected)throw createError;
        const remoteHead=(await run('git',[...PRIVATE_GIT_OPTIONS,'ls-remote',`${expected}.git`,'HEAD'])).split(/\s+/)[0];
        if(remoteHead&&remoteHead!==commit)throw new Error('A GitHub repository with this name already contains different project history.');
        // `gh repo create --source --push` can create the private repo and add origin before
        // its push fails. Reconcile that exact partial success instead of treating the existing
        // remote as a permanent error; never replace a different staged origin.
        const stagedOrigin=await run('git',[...PRIVATE_GIT_OPTIONS,'-C',staging,'remote','get-url','origin']).catch(()=>null);
        if(stagedOrigin&&String(stagedOrigin).replace(/\.git$/,'')!==expected)
          throw new Error('The staged project has a different GitHub origin.');
        if(!stagedOrigin)await run('git',[...PRIVATE_GIT_OPTIONS,'-C',staging,'remote','add','origin',`${expected}.git`]);
      }
    }
    const repository=JSON.parse(await run('gh',['repo','view',`tejasdc/${repositoryName(project,group)}`,'--json','visibility,url']));
    if(repository.visibility!=='PRIVATE'||repository.url!==expected)throw new Error('GitHub did not confirm the expected private project repository.');
    const verifiedOrigin=await run('git',[...PRIVATE_GIT_OPTIONS,'-C',staging,'remote','get-url','origin']);
    if(String(verifiedOrigin).replace(/\.git$/,'')!==expected)throw new Error('The staged project origin does not name the expected repository.');
    if(verifiedOrigin!==`${expected}.git`)await run('git',[...PRIVATE_GIT_OPTIONS,'-C',staging,'remote','set-url','origin',`${expected}.git`]);
    const branch=await run('git',[...PRIVATE_GIT_OPTIONS,'-C',staging,'branch','--show-current']);if(!branch)throw new Error('The project has no branch to push.');
    await run('git',[...PRIVATE_GIT_OPTIONS,'-C',staging,'push','-u','origin',branch]);
    const remote=await run('git',[...PRIVATE_GIT_OPTIONS,'-C',staging,'ls-remote','--exit-code','origin','HEAD']);
    if(!remote.startsWith(commit))throw new Error('GitHub did not confirm the project commit.');
    if(pathExists(destination))throw new Error('The final project folder appeared during setup; the staged project was left intact.');
    renameSync(staging,destination);addNotesLink(root,project,destination);
    return {state:'done',project,relativePath,commit};
  }catch(error){
    // Retain this order's staging directory: a retry can prove and finish the same partial action.
    return {state:'failed',project,relativePath,failureClass:classify(error),reason:message(error)};
  }
}

export function projectSetupJobId(orderId:string){return `project-setup:${createHash('sha256').update(orderId).digest('hex').slice(0,32)}`;}
