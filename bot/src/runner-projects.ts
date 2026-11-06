/**
 * Closed project operations served on the runner machine-call channel. Callers name a registered
 * project and a path inside it; this module never accepts a workspace root or arbitrary absolute
 * path from the owner.
 */
import { existsSync, lstatSync, opendirSync, realpathSync, readFileSync, statSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { sessionProject, sessionProjects } from './session-projects';
import { isSensitiveWorkspacePath, readWorkspaceFile } from './workspace-files';

const workspaceRoot=()=>process.env.CONCIERGE_WORKSPACE_ROOT?.trim()||join(homedir(),'workspace');
const within=(root:string,path:string)=>path===root||path.startsWith(root.endsWith(sep)?root:root+sep);
const execFile=promisify(execFileCallback);

function projectFolder(id:unknown) {
  if(typeof id!=='string'||!id.trim()||id.length>512||id.includes('\\')||id.includes('\0')||isAbsolute(id))
    throw new Error('A registered project name is required.');
  let root:string;
  try { root=realpathSync(workspaceRoot()); }
  catch { throw new Error('This runner has no readable workspace.'); }
  const project=sessionProject(root,id,{inside:true});
  if(!project)throw new Error('The requested project is not registered on this runner.');
  return {root,project};
}

function safeRelativePath(value:unknown) {
  if(value===undefined||value===null)return '';
  if(typeof value!=='string'||value.length>4096||value.includes('\0')||value.includes('\\')||isAbsolute(value)
    ||value.split('/').some(part=>part==='..')||isSensitiveWorkspacePath(value))
    throw new Error('Choose a path inside the registered project.');
  return value.split('/').filter(part=>part&&part!=='.').join('/');
}

function exactFolder(projectPath:string,path:string) {
  const requested=join(projectPath,...(path?path.split('/'):[]));
  let real:string;
  try { real=realpathSync(requested); }
  catch { throw new Error('That project path is unavailable.'); }
  if(!within(projectPath,real)||isSensitiveWorkspacePath(relative(projectPath,requested)))
    throw new Error('Choose a path inside the registered project.');
  return {requested,real};
}

/**
 * Answer only the project vocabulary used by the owner. Each operation has a fixed filesystem
 * action and an authority rooted in this runner's own registered checkout.
 */
export type RunnerProjectServices={findProviderSessionHome?:(provider:'codex'|'claude-code',account:string|null,nativeId:string)=>{account:string;home:string;transcript:string}|null};
export async function serveProjectCall(method:string,params:Record<string,unknown>,services:RunnerProjectServices={}):Promise<unknown> {
  if(method==='projects.default') {
    const root=realpathSync(workspaceRoot());
    return {cwd:root,project:null};
  }
  if(method==='projects.list') {
    const root=realpathSync(workspaceRoot());
    return {projects:sessionProjects(root).map(project=>({name:project.name,path:relative(root,project.cwd)}))};
  }
  if(method==='projects.resolve') {
    const {project}=projectFolder(params.project);
    const path=safeRelativePath(params.path);
    const {real}=exactFolder(project.cwd,path);
    if(!lstatSync(real).isDirectory())throw new Error('Choose a project folder.');
    return {project:project.name,path,cwd:real};
  }
  if(method==='projects.files') {
    const {project}=projectFolder(params.project),path=safeRelativePath(params.path);
    const {real}=exactFolder(project.cwd,path);
    if(!lstatSync(real).isDirectory())throw new Error('Choose a project folder.');
    const entries:Array<{name:string;path:string;kind:'directory'|'file'}>=[];
    let truncated=false;const directory=opendirSync(real);
    try {for(;;){const entry=directory.readSync();if(!entry)break;
      if(entry.isSymbolicLink()||isSensitiveWorkspacePath(entry.name)||!entry.isDirectory()&&!entry.isFile())continue;
      if(entries.length===400){truncated=true;break;}
      entries.push({name:entry.name,path:path?`${path}/${entry.name}`:entry.name,kind:entry.isDirectory()?'directory':'file'});
    }} finally {directory.closeSync();}
    entries.sort((a,b)=>a.kind===b.kind?a.name.localeCompare(b.name):a.kind==='directory'?-1:1);
    return {project:{name:project.name,cwd:project.cwd},path,entries,truncated};
  }
  if(method==='projects.instructions') {
    const {project}=projectFolder(params.project),path=join(project.cwd,'AGENTS.md');
    if(!existsSync(path))throw new Error('Canonical project instructions are unavailable.');
    const real=realpathSync(path);
    if(!within(project.cwd,real)||!lstatSync(real).isFile())throw new Error('Canonical project instructions are unavailable.');
    return {project:project.name,path:'AGENTS.md',content:readFileSync(path,'utf8')};
  }
  if(method==='projects.file') {
    const {root,project}=projectFolder(params.project),path=safeRelativePath(params.path);
    if(!path)throw new Error('A project file path is required.');
    const {requested}=exactFolder(project.cwd,path);
    return {file:readWorkspaceFile({machine:process.env.CONCIERGE_RUNNER_NAME||'runner',workspaceRoot:root,path:requested})};
  }
  if(method==='projects.todos') {
    const {root,project}=projectFolder(params.project),path=join(project.cwd,'notes','TODOS.md');
    if(!existsSync(path))throw new Error('Canonical project TODOs are unavailable.');
    const real=realpathSync(path);
    if(!within(root,real)||isSensitiveWorkspacePath(relative(root,real)))throw new Error('Canonical project TODOs are unavailable.');
    const content=readFileSync(path,'utf8');
    return {project:project.name,content,sha256:createHash('sha256').update(content).digest('hex')};
  }
  if(method==='projects.todos.update') {
    const {root,project}=projectFolder(params.project),path=join(project.cwd,'notes','TODOS.md');
    if(typeof params.content!=='string'||params.content.length>1024*1024||!params.content.endsWith('\n')
      ||typeof params.sha256!=='string'||!existsSync(path))throw new Error('TODO update requires complete content, its observed hash, and an existing canonical TODO file.');
    const real=realpathSync(path);
    if(!within(root,real)||!within(project.cwd,real)||isSensitiveWorkspacePath(relative(root,real))||!lstatSync(path).isFile())
      throw new Error('Canonical project TODOs are unavailable.');
    const before=readFileSync(path,'utf8');
    if(createHash('sha256').update(before).digest('hex')!==params.sha256)throw new Error('Canonical TODOs changed. Reload before saving.');
    const temporary=join(project.cwd,'notes',`.TODOS.${randomUUID()}.tmp`);
    try {writeFileSync(temporary,params.content,{encoding:'utf8',flag:'wx',mode:0o600});renameSync(temporary,path);}
    catch(error){try{if(existsSync(temporary))unlinkSync(temporary);}catch{}throw error;}
    return {project:project.name,content:params.content,sha256:createHash('sha256').update(params.content).digest('hex')};
  }
  if(method==='projects.worktrees') {
    const {project}=projectFolder(params.project);
    if(!['codex','claude-code'].includes(String(params.provider))
      ||typeof params.sessionUUID!=='string'||! /^[a-f0-9-]{20,64}$/i.test(params.sessionUUID)
      ||(params.account!==undefined&&params.account!==null&&(typeof params.account!=='string'||params.account.length>200)))
      throw new Error('An exact provider session and optional account are required.');
    const findSessionHome=services.findProviderSessionHome;
    if(!findSessionHome)throw new Error('Runner provider transcript lookup is unavailable.');
    const sessionHome=findSessionHome(params.provider as 'codex'|'claude-code',
      typeof params.account==='string'?params.account:null,params.sessionUUID);
    if(!sessionHome)throw new Error('The exact provider transcript is unavailable or ambiguous on this runner.');
    const safeEnv={PATH:process.env.PATH??'/usr/local/bin:/usr/bin:/bin',HOME:homedir(),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0'};
    const {stdout}=await execFile('git',['-c','core.fsmonitor=false','-C',project.cwd,'worktree','list','--porcelain'],
      {timeout:5000,maxBuffer:1024*1024,env:safeEnv});
    const transcriptStat=statSync(sessionHome.transcript);
    if(!transcriptStat.isFile()||transcriptStat.size>64*1024*1024)
      throw new Error('The exact provider transcript is too large to inspect for worktree references.');
    const transcript=readFileSync(sessionHome.transcript,'utf8');
    const paths=[...stdout.matchAll(/^worktree (.+)$/gm)].map(match=>match[1]!).filter(path=>
      new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?=[\\s"',}]|$)`).test(transcript));
    const items=[];
    for(const path of paths) {
      let real:string;
      try{real=realpathSync(path);}catch{continue;}
      if(real!==path)continue;
      try {
        const git=async(...args:string[])=>execFile('git',['-c','core.fsmonitor=false','-C',path,...args],
          {timeout:5000,maxBuffer:1024*1024,env:safeEnv});
        const [{stdout:branch},{stdout:head},{stdout:status}]=await Promise.all([
          git('branch','--show-current'),git('rev-parse','HEAD'),git('status','--porcelain')]);
        items.push({path,branch:branch.trim(),head:head.trim(),uncommittedFiles:status.trim()?status.trimEnd().split('\n').length:0});
      }catch{/* A stale or unreadable path stays absent from this bounded read. */}
    }
    return {project:project.name,items,transcriptAvailable:true};
  }
  throw new Error(`Unknown runner project operation: ${method}`);
}
