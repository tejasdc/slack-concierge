/** A replay-safe peer checkout placement, executed on the configured project runner. */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { sessionProject } from './session-projects';
import { expectedRunnerProjectOrigin } from './runner-project-setup';
import {runnerGithubGitEnvironment} from './runner-git-auth';

const execFile=promisify(execFileCallback);
const LAB_GROUP='agent-ecology/expertise';
const NAME=/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;
const GROUP=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const within=(root:string,path:string)=>path===root||path.startsWith(root.endsWith(sep)?root:`${root}${sep}`);
const exists=(path:string)=>{try{lstatSync(path);return true;}catch(error:any){if(error?.code==='ENOENT')return false;throw error;}};
const transient=(error:unknown)=>/timed? ?out|econn(?:reset|refused|aborted)|network|temporary|socket|fetch failed|rate limit|could not resolve|remote end hung up|service unavailable|authentication failed|could not read username|credential helper/i.test(String(error));

export type RunnerProjectPlacementInput={orderId:string;project:string;group?:string;targetRunner:string};
export type RunnerProjectPlacementResult={state:'done'|'already_present'|'refused'|'failed';project:string;relativePath:string;commit?:string;reason?:string;failureClass?:'transient'|'permanent'};
export type RunnerProjectPlacementServices={workspaceRoot?:string;run?:(file:string,args:string[],cwd?:string)=>Promise<string>};

function exactKeys(value:unknown,keys:string[]):Record<string,any>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new Error('Invalid project placement job fields.');
  return value as Record<string,any>;
}
function gitEnv(){return runnerGithubGitEnvironment();}
async function defaultRun(file:string,args:string[],cwd?:string){return (await execFile(file,args,{cwd,encoding:'utf8',env:gitEnv(),maxBuffer:16*1024*1024,timeout:120_000})).stdout.trim();}
function validate(value:unknown):RunnerProjectPlacementInput{
  const data=exactKeys(value,['orderId','project','group','targetRunner']);
  if(typeof data.orderId!=='string'||!/^[a-f0-9]{32}$/.test(data.orderId))throw new Error('Project placement order identity is invalid.');
  if(typeof data.project!=='string'||!NAME.test(data.project))throw new Error('Project placement name is invalid.');
  if(typeof data.targetRunner!=='string'||data.targetRunner!==process.env.CONCIERGE_RUNNER_NAME)throw new Error('Project placement job reached the wrong runner.');
  if(data.group!==undefined&&data.group!==null&&(typeof data.group!=='string'||!(GROUP.test(data.group)||data.group===LAB_GROUP)))throw new Error('Project placement group is invalid.');
  return {orderId:data.orderId,project:data.project,...(data.group?{group:data.group}:{}),targetRunner:data.targetRunner};
}
function ensureGroup(root:string,group:string){
  const folder=join(root,group);
  if(!within(root,folder))throw new Error('Project group escaped the runner workspace.');
  if(group===LAB_GROUP){
    const lab=sessionProject(root,'agent-ecology');
    if(lab?.cwd!==join(root,'agent-ecology')||!exists(join(lab.cwd,'.git')))throw new Error('The agent-ecology project must be registered before adding an expertise.');
    const ignore=join(lab.cwd,'.gitignore');
    if(!exists(ignore)||!readFileSync(ignore,'utf8').split(/\r?\n/).includes('/expertise/'))throw new Error('The lab must ignore its expertise repositories before creating one.');
  }
  if(!exists(folder))mkdirSync(folder,{recursive:true});
  if(!lstatSync(folder).isDirectory()||lstatSync(folder).isSymbolicLink()||exists(join(folder,'.git'))||exists(join(folder,'.obsidian')))
    throw new Error('Project placement must be a plain grouping folder.');
}
function addNotesLink(root:string,project:string,destination:string){
  const vault=[join(root,'vault'),join(root,'obsidian-vault','journalmaxx')].find(path=>{try{return lstatSync(path).isDirectory()&&lstatSync(join(path,'.obsidian')).isDirectory();}catch{return false;}});
  if(!vault)return;
  const notes=join(vault,'projects',project,'notes'),link=join(destination,'notes');
  if(exists(link))return;
  mkdirSync(notes,{recursive:true});
  for(const file of ['inbox.md','TODOS.md'])if(!exists(join(notes,file)))writeFileSync(join(notes,file),file==='TODOS.md'?`# ${project} tasks\n`:`# ${project} notes\n`,{flag:'wx',mode:0o600});
  symlinkSync(relative(dirname(link),notes),link);
}
function validProject(path:string,root:string){
  try{return realpathSync(path)===path&&within(root,path)&&lstatSync(path).isDirectory()&&lstatSync(join(path,'.git')).isDirectory()&&lstatSync(join(path,'AGENTS.md')).isFile();}
  catch{return false;}
}

export async function runProjectPlacementJob(value:unknown,services:RunnerProjectPlacementServices={}):Promise<RunnerProjectPlacementResult>{
  const input=validate(value),root=realpathSync(services.workspaceRoot??process.env.CONCIERGE_WORKSPACE_ROOT?.trim()??join(homedir(),'workspace'));
  const destination=input.group?join(root,input.group,input.project):join(root,input.project),relativePath=relative(root,destination);
  if(!within(root,destination))throw new Error('Project placement destination escaped runner workspace.');
  const prior=sessionProject(root,input.project);
  if(prior&&prior.cwd!==destination)return {state:'refused',project:input.project,relativePath,reason:'This project is already registered at a different location.'};
  const expected=expectedRunnerProjectOrigin(input.project,input.group),run=services.run??defaultRun;
  const verifyRemote=async()=>{
    const repository=JSON.parse(await run('gh',['repo','view',expected.replace('https://github.com/',''),'--json','visibility,url']));
    if(repository.visibility!=='PRIVATE'||repository.url!==expected)throw new Error('The source repository is not the expected private GitHub project.');
  };
  const verifyCheckout=async(path:string)=>{
    if(!validProject(path,root))return null;
    const origin=await run('git',['-c','protocol.file.allow=never','-C',path,'remote','get-url','origin']).catch(()=>null);
    if(String(origin).replace(/\.git$/,'')!==expected)return null;
    const commit=await run('git',['-c','protocol.file.allow=never','-C',path,'rev-parse','HEAD']);
    const remoteHead=(await run('git',['-c','protocol.file.allow=never','-C',path,'ls-remote','--exit-code','origin','HEAD'])).split(/\s+/)[0];
    return remoteHead===commit?commit:null;
  };
  if(exists(destination)){
    try{await verifyRemote();}catch(error){const reason=error instanceof Error?error.message:String(error);return transient(error)?{state:'failed',failureClass:'transient',project:input.project,relativePath,reason}:{state:'refused',project:input.project,relativePath,reason};}
    const commit=await verifyCheckout(destination);
    if(!commit)return {state:'refused',project:input.project,relativePath,reason:'The existing project is not the verified private repository at its current remote head.'};
    addNotesLink(root,input.project,destination);
    return {state:'already_present',project:input.project,relativePath,commit};
  }
  const stagingRoot=join(root,'.project-placement'),stagingParent=join(stagingRoot,input.orderId),staging=join(stagingParent,input.project);
  for(const path of [stagingRoot,stagingParent])if(exists(path)&&(!lstatSync(path).isDirectory()||lstatSync(path).isSymbolicLink()))throw new Error('Project placement staging path is not a plain directory.');
  mkdirSync(stagingParent,{recursive:true,mode:0o700});
  try{
    await verifyRemote();
    if(exists(staging)){
      if(!validProject(staging,root)||String(await run('git',['-c','protocol.file.allow=never','-C',staging,'remote','get-url','origin'])).replace(/\.git$/,'')!==expected)
        return {state:'refused',project:input.project,relativePath,reason:'The retained project placement staging folder has different contents.'};
    }else await run('gh',['repo','clone',expected.replace('https://github.com/',''),staging]);
    const commit=await verifyCheckout(staging);
    if(!commit)return {state:'refused',project:input.project,relativePath,reason:'The staged checkout does not match the verified private repository head.'};
    if(input.group)ensureGroup(root,input.group);
    if(exists(destination))return {state:'refused',project:input.project,relativePath,reason:'The project destination appeared during placement.'};
    renameSync(staging,destination);addNotesLink(root,input.project,destination);
    return {state:'done',project:input.project,relativePath,commit};
  }catch(error){
    const reason=(error instanceof Error?error.message:String(error)).replace(/[\r\n]/g,' ').slice(0,400);
    return transient(error)?{state:'failed',failureClass:'transient',project:input.project,relativePath,reason}:{state:'refused',project:input.project,relativePath,reason};
  }
}
