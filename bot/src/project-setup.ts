import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync,lstatSync,mkdirSync,readFileSync,readlinkSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join,relative,dirname} from 'node:path';
import {db,getSessionById} from './state';
import {canonicalAgentsTemplate,canonicalDocsIndexTemplate} from './project-scaffold';
import {projectTemplate,templateAgentsSection,templateFiles,type ProjectTemplate} from './project-templates';
import {containingProject,sessionProject} from './session-projects';
import {standingAgentSession} from './standing-agents';
import {getAcceptedSessionInput,nativeRunId,recordSessionEvent,sessionInputProvenance} from './session-inputs';
import {inboxSession} from './session-inbox';
import {publishProviderFreeNotice} from './provider-free-notice';
import {fileServiceNotices} from './session-topics';
import type {SessionOwner} from './session-owner';
import type {PeerClient} from './session-peers';
import {PeerError} from './session-peers';
import {log,errorFields} from './log';
import {awaitingOutside} from './storage-observation';

const NAME=/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;
const VAGUE=new Set(['commands','tools','scripts','utils','misc','stuff','test','project','new','temp','app','helpers','things','notes']);
const TERMINAL=new Set(['done','already_present','refused','failed','cancelled']);
const CLONE_OPTIONS=['-c','core.hooksPath=/dev/null','-c','protocol.file.allow=never','-c','protocol.ssh.allow=never','-c','protocol.git.allow=never','-c','protocol.ext.allow=never','-c','submodule.recurse=false','-c','filter.lfs.smudge=','-c','core.fsmonitor=false'];
type Origin={peer:string;session:string;input:string;run:string;originatingHuman:unknown}|{terminal:true};
type Order={orderId:string;kind:'project.setup';origin:Origin;project:string;folder?:string};
// A peer that predates placement decisions must not silently create a grouped project at root.
export const PROJECT_FOLDERS_OPERATION='project.setup.placement.v1';
export const PROJECT_NESTED_EXPERTISE_OPERATION='project.setup.expertise.v1';
const GROUP=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const LAB_EXPERTISE_GROUP='agent-ecology/expertise';
type CanvasEnsureRow={board_id:string;client_action_id:string;project:string;inside:string|null;title:string;title_clock:number;purpose:string;template:string;state:'awaiting_policy'|'creating'|'ready'|'failed';policy_revision_id:string|null;created_project:number;error:string|null;created_at_ms:number;updated_at_ms:number};
type CanvasPolicyRow={revision_id:string;group_name:string;template:string;consultation_request_id:string;source_session_id:number;source_input_id:string;source_run_id:string;created_at_ms:number};
const canvasBoard=(value:unknown)=>{
  if(typeof value!=='string'||!value.trim()||value.length>200||/[\r\n\0]/.test(value))throw new Error('Canvas identity is invalid.');
  return value;
};
const canvasTitle=(value:unknown)=>{
  if(typeof value!=='string'||value.length>300||/[\r\n\0]/.test(value))throw new Error('Canvas title is invalid.');
  return value.trim();
};
function canvasSlug(title:string){
  const words=title.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').split('-').filter(Boolean);
  if(!words.length)return '';
  if(words.length<2)words.push('canvas');
  return words.slice(0,8).join('-').slice(0,80).replace(/-$/,'');
}
const canvasAction=(value:unknown)=>{
  if(typeof value!=='string'||!/^canvas-project:[a-f0-9]{24}$/.test(value))throw new Error('Canvas project action identity is invalid.');
  return value;
};
function canvasInside(value:unknown){
  if(value===undefined||value===null||value==='')return null;
  if(typeof value!=='string'||value.startsWith('/')||value.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.')))throw new Error('Choose a folder inside the registered project.');
  return value;
}
function canvasPurpose(title:string){
  const subject=title.replace(/[.!?]+/g,' ').replace(/\s+/g,' ').trim()||'Canvas';
  return `Develop the ${subject} Canvas as an exploratory writing project.`;
}
function projectFolder(workspace:string,project:string,folder?:string){return folder?join(workspace,folder,project):join(workspace,project);}
function projectGroup(value:unknown):string|undefined {
  if(value===null||value===undefined)return undefined;
  if(typeof value!=='string'||value.length>100||!(GROUP.test(value)||value===LAB_EXPERTISE_GROUP))
    throw new Error('Placement must be at the workspace root, in one plain grouping folder, or in the lab expertise folder.');
  return value;
}
function ensureGroupFolder(workspace:string,group:string){
  const folder=join(workspace,group);
  if(group===LAB_EXPERTISE_GROUP){
    const lab=sessionProject(workspace,'agent-ecology');
    if(lab?.cwd!==join(workspace,'agent-ecology')||!pathExists(join(lab.cwd,'.git')))
      throw new Error('The agent-ecology project must be registered before adding an expertise.');
    const ignore=join(lab.cwd,'.gitignore');
    if(!pathExists(ignore)||!readFileSync(ignore,'utf8').split(/\r?\n/).includes('/expertise/'))
      throw new Error('The lab must ignore its expertise repositories before creating one.');
  }
  if(!pathExists(folder))mkdirSync(folder);
  if(!lstatSync(folder).isDirectory()||pathExists(join(folder,'.git'))||pathExists(join(folder,'.obsidian')))
    throw new Error(`${folder} must be a plain grouping folder, not a link, repository or vault.`);
}
function placementDecision(workspace:string,requestId:unknown,project:string,purpose:string,sourceSession:number,template?:ProjectTemplate){
  if(typeof requestId!=='string'||!/^[a-f0-9-]{36}$/.test(requestId))throw new Error('A completed workspace-organizer consultation request is required.');
  const organizer=standingAgentSession(workspace,'workspace-organizer');
  if(!organizer)throw new Error('The workspace organizer must be bound before creating a project.');
  const row=db.query(`SELECT request.source_session_id,request.target_session_id,request.outcome,answer.payload_json,answer.created_at_ms
    FROM session_communication_requests request
    JOIN session_communication_events answer ON answer.request_id=request.request_id AND answer.kind='final'
      AND answer.superseded_by_event_id IS NULL AND answer.action_key IS NOT NULL
    WHERE request.request_id=?`).get(requestId) as
    {source_session_id:number;target_session_id:number;outcome:string|null;payload_json:string;created_at_ms:number}|null;
  if(!row||row.target_session_id!==organizer.id||row.outcome!=='answered'||row.source_session_id!==sourceSession)
    throw new Error('The consultation must be a completed answer from the bound workspace organizer to this creating session.');
  const result=JSON.parse(row.payload_json) as {replyBody?:unknown;workDisposition?:unknown};
  // Completed replies also carry display text with a completion footer. The original body
  // is retained separately and is the only field that can be an exact JSON decision.
  if(result.workDisposition!=='completed'||typeof result.replyBody!=='string')throw new Error('The organizer has not accepted a placement.');
  let decision:Record<string,unknown>;
  try{decision=exactKeys(JSON.parse(result.replyBody),['project','purpose','template','group']);}
  catch{throw new Error('The organizer answer must be one JSON placement decision.');}
  if(!Object.hasOwn(decision,'group')||decision.project!==project||decision.purpose!==purpose||decision.template!==template)
    throw new Error('The organizer decision does not match this project, purpose and template.');
  const group=projectGroup(decision.group);
  const prior=db.query('SELECT project,purpose,template,group_name FROM project_placement_receipts WHERE request_id=?').get(requestId) as
    {project:string;purpose:string;template:string|null;group_name:string|null}|null;
  if(prior){
    if(prior.project!==project||prior.purpose!==purpose||prior.template!==(template??null)||prior.group_name!==(group??null))
      throw new Error('This organizer receipt belongs to a different creation attempt.');
    if(db.query('SELECT 1 FROM project_creations WHERE project=?').get(project))throw new Error('This organizer receipt was already used to create the project.');
  }else{
    if(Date.now()-row.created_at_ms>24*60*60_000||row.created_at_ms>Date.now()+60_000)
      throw new Error('This organizer decision is stale; ask for a current placement.');
    db.query('INSERT INTO project_placement_receipts(request_id,project,purpose,template,group_name,reserved_at_ms) VALUES(?,?,?,?,?,?)')
      .run(requestId,project,purpose,template??null,group??null,Date.now());
  }
  return group;
}
type Outcome={state:'done'|'already_present'|'refused'|'failed'|'cancelled';reason?:string;failureClass?:'transient'|'permanent';commit?:string};
type Outgoing={order_id:string;peer:string;project:string;body_json:string;state:string;result_json:string|null;created_at_ms:number;last_attempt_at_ms:number|null;notice_kind:string|null;notice_text:string|null;source_session_id:number|null;source_input_id:string|null;source_run_id:string|null;return_input_id:string|null};
const gitEnv=()=>({...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never',GIT_LFS_SKIP_SMUDGE:'1',GIT_ALLOW_PROTOCOL:'https'});
// GitHub and Git may wait on the network. The operation owns the result; the event loop does not.
// That wait is recorded as outside time, not owner time: four 8 s `projects new` calls with no
// loop blocking opened a slow-reads incident on 2026-10-29 (work-flow supervisor 9e80e9c2).
const run=async(file:string,args:string[],cwd?:string)=>(await awaitingOutside(()=>promisify(execFile)(file,args,{cwd,encoding:'utf8',env:gitEnv(),maxBuffer:16*1024*1024}))).stdout.trim();
function git(cwd:string,...args:string[]){return run('git',args,cwd);}
// A new project's name must say what it is (the naming rule); an existing project keeps the name
// it already has, so share, status and the receiving side only check that it is a safe folder name.
const FOLDER=/^[a-z0-9][a-z0-9-]{0,99}$/;
function existingName(value:unknown):string {
  if(typeof value!=='string'||!FOLDER.test(value))throw new Error('Name an existing project folder: lowercase letters, digits and dashes.');
  return value;
}
function newName(value:unknown):string {
  if(typeof value!=='string'||!NAME.test(value)||value.split('-').every(word=>VAGUE.has(word)))throw new Error('Choose a descriptive project name with at least two lowercase words joined by dashes, such as command-line-tools.');
  return value;
}
function exactKeys(value:unknown,keys:string[]):Record<string,any> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new Error('Unknown or invalid project setup fields.');
  return value as Record<string,any>;
}
// One live order per project and machine; a fresh attempt after a final failure gets a new identity,
// because the receiver keeps a permanent failure as that order's answer.
function orderId(peer:string,project:string,attempt:number){return createHash('sha256').update(`project.setup:${peer}:${project}:${attempt}`).digest('hex').slice(0,32);}
function pathExists(path:string){try{lstatSync(path);return true;}catch(error:any){if(error?.code==='ENOENT')return false;throw error;}}
async function originOf(path:string){try{return (await git(path,'remote','get-url','origin')).replace(/\.git$/,'').replace(/^git@github\.com:/,'https://github.com/');}catch{return null;}}
function repositoryName(project:string,folder?:string){return folder===LAB_EXPERTISE_GROUP?`expertise-${project}`:project;}
function expectedOrigin(project:string,folder?:string){return `https://github.com/tejasdc/${repositoryName(project,folder)}`;}
function head(path:string){return git(path,'rev-parse','HEAD');}
function projectPredicate(path:string){try{return lstatSync(join(path,'.git')).isDirectory()&&lstatSync(join(path,'AGENTS.md')).isFile();}catch{return false;}}
async function createScaffold(path:string,project:string,purpose:string,workspace:string,template?:ProjectTemplate){
  const intent=join(path,'tmp','project-setup-intent.json');
  mkdirSync(join(path,'tmp'),{recursive:true});
  const intended=JSON.stringify({project,purpose,...(template?{template}:{})});
  if(pathExists(intent)){
    if(readFileSync(intent,'utf8')!==intended)throw new Error('This folder has a different unfinished project setup.');
  }else writeFileSync(intent,intended,{flag:'wx'});
  const file=(name:string,content:string)=>{const target=join(path,name);if(pathExists(target)){if(readFileSync(target,'utf8')!==content)throw new Error(`Existing ${name} differs from the project scaffold.`);}else writeFileSync(target,content,{flag:'wx'});};
  mkdirSync(join(path,'docs'),{recursive:true});
  file('AGENTS.md',canonicalAgentsTemplate(project,path).replace(`Working directory: \`${path}\``,`${purpose}\n\nWorking directory: \`${path}\``)+(template?templateAgentsSection(template):''));
  if(template)for(const [name,content] of Object.entries(templateFiles(template,project,purpose))){mkdirSync(dirname(join(path,name)),{recursive:true});file(name,content);}
  const claude=join(path,'CLAUDE.md');
  if(pathExists(claude)){if(!lstatSync(claude).isSymbolicLink()||readlinkSync(claude)!=='AGENTS.md')throw new Error('Existing CLAUDE.md is not the canonical link.');}
  else symlinkSync('AGENTS.md',claude);
  file('docs/README.md',canonicalDocsIndexTemplate(project));// notes/ links into this machine's vault, which lives at a different path on each machine;
  // it must never be committed, or the other machine clones a link that points nowhere.
  file('.gitignore','tmp/\nnotes\n');
  notesLink(workspace,project,path);
  if(!pathExists(join(path,'.git')))await git(path,'init');
  try{await head(path);}catch{await git(path,'add','--all');await git(path,'commit','-m',`Create ${project} project`);}
}
function vaultRoot(workspace:string){const candidates=[join(workspace,'vault'),join(workspace,'obsidian-vault','journalmaxx')];return candidates.find(path=>{try{return lstatSync(path).isDirectory()&&lstatSync(join(path,'.obsidian')).isDirectory();}catch{return false;}})??(existsSync(join(workspace,'vault','projects'))?join(workspace,'vault'):null);}
function notesLink(workspace:string,project:string,destination:string,createNotes=true){
  const vault=vaultRoot(workspace);if(!vault)return;
  const notes=join(vault,'projects',project,'notes');const link=join(destination,'notes');
  if(pathExists(link))return;
  // Only the creating machine writes the vault notes; the other machine links to the folder
  // Obsidian Sync delivers, because writing the same files on both would make sync conflicts.
  if(createNotes){mkdirSync(notes,{recursive:true});
  for(const file of ['inbox.md','TODOS.md'])if(!pathExists(join(notes,file)))writeFileSync(join(notes,file),file==='TODOS.md'?`# ${project} tasks\n`:`# ${project} notes\n`);}
  symlinkSync(relative(dirname(link),notes),link);
}
// Notices are read by Tejas: plain words, no commands or codes.
const machineName=(peer:string)=>peer==='mac'?'your Mac':peer==='cloud'?'the server':peer;
const REASONS:Record<string,string>={unknown_kind:'that machine does not know this kind of setup',invalid_name:'the project name is not a valid project name',invalid_repository:'the request did not name one of your repositories',unknown_field:'the request carried something a setup request cannot carry',destination_conflict:'a different folder with that name is already there, and it was left untouched'};
const needsUpdateText=(row:{project:string;peer:string})=>`Concierge on ${machineName(row.peer)} needs updating before project ${row.project} can be set up there. It will finish on its own once that update is installed.`;
function classify(error:unknown):'transient'|'permanent'{
  const text=String(error).toLowerCase();
  return /timed? ?out|econn(?:reset|refused|aborted)|network|temporary|socket|fetch failed|rate limit|could not resolve|remote end hung up|service unavailable/.test(text)?'transient':'permanent';
}
function message(error:unknown){return error instanceof Error?error.message:String(error);}

export class ProjectSetup {
  private running=false;
  private readonly localOperations=new Map<string,Promise<unknown>>();
  private readonly canvasLocalReadiness=new Map<string,Promise<void>>();
  private readonly sending=new Set<string>();
  private readonly receiving=new Set<string>();
  constructor(private readonly workspace:string,private readonly self:string,private readonly clients:Map<string,PeerClient>,private readonly owner:()=>SessionOwner,private readonly onRecorded?:()=>void){}
  hasPending(){return this.localOperations.size>0||!!db.query("SELECT 1 FROM project_setup_orders WHERE state NOT IN ('done','already_present','refused','failed','cancelled') OR notice_kind LIKE 'pending:%' OR (source_session_id IS NOT NULL AND state IN ('done','already_present','refused','failed','cancelled') AND return_input_id IS NULL) LIMIT 1").get();}
  private source(value:unknown):{session:number;input:string;run:string;originatingHuman:unknown}|null {
    if(value===undefined||value===null)return null;
    const source=exactKeys(value,['input','run']);
    if(typeof source.input!=='string'||typeof source.run!=='string')throw new Error('Both source input and run are required.');
    const accepted=getAcceptedSessionInput(source.input);
    if(!accepted?.turn_id||nativeRunId(accepted.turn_id)!==source.run)throw new Error('Source input and run do not identify the same accepted turn.');
    const session=getSessionById(accepted.session_id);
    if(!session)throw new Error('Source session is unavailable.');
    return {session:session.id,input:source.input,run:source.run,originatingHuman:sessionInputProvenance(accepted)};
  }
  private peer(value:unknown){if(typeof value!=='string'||!this.clients.has(value)||value===this.self)throw new Error('Choose a configured peer machine.');return value;}
  private record(project:string,peer:string,source:ReturnType<ProjectSetup['source']>,folder?:string){
    const prior=db.query('SELECT state FROM project_setup_orders WHERE peer=? AND project=? ORDER BY created_at_ms DESC,rowid DESC').all(peer,project) as {state:string}[];
    if(prior.length&&!['refused','failed','cancelled'].includes(prior[0]!.state))return this.status(project,peer);
    const id=orderId(peer,project,prior.length+1);
    const origin:Origin=source?{peer:this.self,session:`concierge:${source.session}`,input:source.input,run:source.run,originatingHuman:source.originatingHuman}:{terminal:true};
    const body:Order={orderId:id,kind:'project.setup',origin,project,...(folder?{folder}:{})};
    db.query(`INSERT OR IGNORE INTO project_setup_orders(order_id,peer,project,body_json,state,created_at_ms,source_session_id,source_input_id,source_run_id)
      VALUES(?,?,?,?,'recorded',?,?,?,?)`).run(id,peer,project,JSON.stringify(body),Date.now(),source?.session??null,source?.input??null,source?.run??null);
    log('info','project_setup_order_recorded',{order_id:id,peer,project});
    this.wake();this.onRecorded?.();return this.status(project,peer);
  }
  async new(input:unknown){
    const data=exactKeys(input,['name','purpose','hereOnly','source','consultation','template']);const project=newName(data.name);projectTemplate(data.template);
    return this.serialProject(project,()=>this.createLocal(data,project));
  }
  private async serialProject<T>(project:string,operation:()=>Promise<T>):Promise<T>{
    const prior=this.localOperations.get(project);
    const current=prior?prior.catch(()=>{}).then(operation):operation();
    this.localOperations.set(project,current);
    try{return await current;}finally{if(this.localOperations.get(project)===current)this.localOperations.delete(project);}
  }
  private async createLocal(data:Record<string,any>,project:string,placed?:{group:string|undefined;receipt:string},onLocalReady?:()=>void){
    if(this.self==='mac')throw new Error('New projects start on the server, where the workspace organizer holds the consultation. Run project new on the server.');
    if(typeof data.purpose!=='string'||!data.purpose.trim()||/[\r\n]/.test(data.purpose))throw new Error('A one-sentence --purpose is required.');
    if(/[.!?]\s+\S/.test(data.purpose.trim()))throw new Error('--purpose must be one sentence.');
    if(data.hereOnly!==undefined&&typeof data.hereOnly!=='boolean')throw new Error('hereOnly must be true or false.');
    if(!data.hereOnly&&!this.clients.size)throw new Error('No peer is configured; use --here-only for a local project.');
    const source=placed?null:this.source(data.source);
    if(!placed&&!source)throw new Error('Project creation needs the current session input and run so its organizer consultation can be bound to this creator.');
    const template=projectTemplate(data.template);
    const folder=placed?.group??placementDecision(this.workspace,data.consultation,project,data.purpose.trim(),source!.session,template);
    const destination=projectFolder(this.workspace,project,folder);
    const intent=join(destination,'tmp','project-setup-intent.json');
    const elsewhere=sessionProject(this.workspace,project);
    if(elsewhere&&elsewhere.cwd!==destination)throw new Error(`${elsewhere.cwd} already uses this name; one name is one project, wherever it sits.`);
    if(pathExists(destination)&&!pathExists(intent))throw new Error('A local folder already uses this name; use projects share for an existing project.');
    if(folder)ensureGroupFolder(this.workspace,folder);
    if(pathExists(intent)&&await originOf(destination)&&await originOf(destination)!==expectedOrigin(project,folder))throw new Error('The unfinished project has a different GitHub origin.');
    if(!pathExists(destination))mkdirSync(destination);
    if(pathExists(intent))await createScaffold(destination,project,data.purpose.trim(),this.workspace,template);
    else if(!projectPredicate(destination))await createScaffold(destination,project,data.purpose.trim(),this.workspace,template);
    const current=await git(destination,'status','--porcelain');if(current)throw new Error('The existing project has unpushed or uncommitted files; finish and push it first.');
    onLocalReady?.();
    if(await originOf(destination)!==expectedOrigin(project,folder)){
      if(await originOf(destination))throw new Error('This folder has a different GitHub origin.');
      try{await run('gh',['repo','create',`tejasdc/${repositoryName(project,folder)}`,'--private','--description',data.purpose.trim(),'--source',destination,'--push']);}
      catch(error){
        const repository=JSON.parse(await run('gh',['repo','view',`tejasdc/${repositoryName(project,folder)}`,'--json','visibility,url']));
        if(repository.visibility!=='PRIVATE'||repository.url!==expectedOrigin(project,folder))throw error;
        const remoteHead=(await run('git',['ls-remote',`${expectedOrigin(project,folder)}.git`,'HEAD'])).split(/\s+/)[0];
        if(remoteHead&&remoteHead!==await head(destination))throw new Error('A GitHub repository with this name already exists; choose another descriptive name.');
        if(!await originOf(destination))await git(destination,'remote','add','origin',`${expectedOrigin(project,folder)}.git`);
      }
    }
    const repository=JSON.parse(await run('gh',['repo','view',`tejasdc/${repositoryName(project,folder)}`,'--json','visibility,url']));
    if(repository.visibility!=='PRIVATE'||repository.url!==expectedOrigin(project,folder))throw new Error('The GitHub repository is not the expected private tejasdc repository.');
    if(await originOf(destination)!==expectedOrigin(project,folder))throw new Error('The local Git origin does not name the created repository.');
    if(await git(destination,'remote','get-url','origin')!==`${expectedOrigin(project,folder)}.git`)await git(destination,'remote','set-url','origin',`${expectedOrigin(project,folder)}.git`);
    const branch=await git(destination,'branch','--show-current');
    if(!branch)throw new Error('The project has no branch to push.');
    await git(destination,'push','-u','origin',branch);
    const remote=await git(destination,'ls-remote','--exit-code','origin','HEAD');
    if(!remote.startsWith(await head(destination)))throw new Error('The project was not pushed to its private GitHub repository; setup order was not recorded.');
    const commit=await head(destination);
    const orders=db.transaction(()=>{
      const prior=db.query('SELECT purpose FROM project_creations WHERE project=?').get(project) as {purpose:string}|null;
      if(prior&&prior.purpose!==data.purpose.trim())throw new Error('This project was created with a different purpose.');
      db.query('INSERT OR IGNORE INTO project_creations(project,purpose,commit_sha,here_only,created_at_ms) VALUES(?,?,?,?,?)').run(project,data.purpose.trim(),commit,data.hereOnly?1:0,Date.now());
      return data.hereOnly?[]:[...this.clients.keys()].map(peer=>this.record(project,peer,source,folder));
    })();
    log('info','project_created',{project,commit,here_only:!!data.hereOnly,folder:folder??null});
    return {project,local:'done',path:destination,commit,orders};
  }
  private canvasRow(board:string){return db.query('SELECT * FROM canvas_project_ensures WHERE board_id=?').get(board) as CanvasEnsureRow|null;}
  private publishCanvasState(row:CanvasEnsureRow,state:'pending'|'ready'|'failed'){
    // A Canvas may not have a project session yet. The Inbox anchors this global
    // event, while the board ID remains the identity the browser reconciles.
    const inbox=inboxSession();
    if(!inbox)throw new Error('No session anchors Canvas project events.');
    recordSessionEvent({eventId:`canvas-project:${row.board_id}:${state}`,sessionId:inbox.id,
      kind:'canvas_project',payload:{boardId:row.board_id,project:row.project,state}});
  }
  private canvasState(row:CanvasEnsureRow){
    const sessionName=row.inside?`${row.project}/${row.inside}`:row.project;
    const local=sessionProject(this.workspace,sessionName,{inside:true});
    return {local,state:local?'ready':row.state==='failed'?'failed':'pending'} as const;
  }
  canvasProjectTitles(){
    return new Map((db.query("SELECT project,title FROM canvas_project_ensures WHERE policy_revision_id IS NOT NULL AND inside IS NULL AND state='ready' AND created_project=1").all() as Array<{project:string;title:string}>).map(row=>[row.project,row.title]));
  }
  private canvasPolicy(){return db.query('SELECT * FROM canvas_project_policies ORDER BY created_at_ms DESC,rowid DESC LIMIT 1').get() as CanvasPolicyRow|null;}
  private canvasName(title:string,board:string){
    const placeholder=/^canvas(?:\s+\d+)?$/i.test(title)||/^(?:new|untitled)\s+canvas$/i.test(title);
    const digest=createHash('sha256').update(board).digest('hex');
    const slug=canvasSlug(title),fallback=`canvas-${digest.slice(0,12)}`;
    const base=newName(placeholder||!slug?fallback:slug);
    const available=(candidate:string)=>!sessionProject(this.workspace,candidate)&&!db.query('SELECT 1 FROM canvas_project_ensures WHERE project=? AND inside IS NULL AND board_id<>?').get(candidate,board);
    if(available(base))return base;
    for(let length=16;length<=digest.length;length+=4){
      const candidate=newName(`${base}-${digest.slice(0,length)}`.slice(0,100).replace(/-$/,''));
      if(available(candidate))return candidate;
    }
    throw new Error('No unique project name is available for this Canvas identity.');
  }
  private async peerProjectPath(peer:string,project:string,inside:string|null){
    const client=this.clients.get(peer);if(!client)return null;
    try{
      const root=(await client.request<{projects?:Array<{name:string;cwd:string}>}>('GET','/sessions/v1/projects',undefined,5000)).projects?.find(item=>item.name===project);
      if(!root)return null;
      if(!inside)return root.cwd;
      await client.request('GET',`/sessions/v1/projects/${encodeURIComponent(project)}/files?path=${encodeURIComponent(inside)}`,undefined,5000);
      return join(root.cwd,inside);
    }
    catch{return null;}
  }
  private async canvasView(row:CanvasEnsureRow){
    const sessionName=row.inside?`${row.project}/${row.inside}`:row.project;
    const {local,state}=this.canvasState(row);
    const order=(db.query("SELECT state FROM project_setup_orders WHERE project=? AND peer='mac' ORDER BY created_at_ms DESC,rowid DESC LIMIT 1").get(row.project) as {state:string}|null)?.state??null;
    const explicit=row.policy_revision_id===null&&!row.created_project;
    const macPath=explicit||order==='done'||order==='already_present'?await this.peerProjectPath('mac',row.project,row.inside):null;
    const macState=macPath?'ready':order&&TERMINAL.has(order)?'unavailable':order||row.state==='creating'&&!!local?'pending':'unavailable';
    const created=!!row.created_project||!!row.policy_revision_id&&!!local;
    return {state,boardId:row.board_id,title:row.title,project:{name:row.project,inside:row.inside,sessionProject:sessionName,ownerId:this.self,
      serverPath:local?.cwd??null,macPath,macState,
      template:row.template,created},retryAfterMs:state==='pending'||row.state==='creating'||macState==='pending'?1000:null,policyRevisionId:row.policy_revision_id,error:row.error};
  }
  async canvas(boardValue:unknown){const board=canvasBoard(boardValue),row=this.canvasRow(board);return row?this.canvasView(row):null;}
  private async advanceCanvas(row:CanvasEnsureRow){
    if(row.state==='ready'||row.state==='failed'||row.inside)return;
    const policy=row.policy_revision_id?db.query('SELECT * FROM canvas_project_policies WHERE revision_id=?').get(row.policy_revision_id) as CanvasPolicyRow|null:this.canvasPolicy();
    if(!policy)return;
    if(!row.policy_revision_id){db.query("UPDATE canvas_project_ensures SET state='creating',policy_revision_id=?,template=?,error=NULL,updated_at_ms=? WHERE board_id=? AND policy_revision_id IS NULL")
      .run(policy.revision_id,policy.template,Date.now(),row.board_id);row=this.canvasRow(row.board_id)!;}
    db.query("UPDATE canvas_project_ensures SET state='creating',error=NULL,updated_at_ms=? WHERE board_id=?").run(Date.now(),row.board_id);
    const underway=this.canvasLocalReadiness.get(row.board_id);if(underway){await underway;return;}
    let releaseLocal!:()=>void;
    const localReady=new Promise<void>(resolve=>{releaseLocal=resolve;});
    this.canvasLocalReadiness.set(row.board_id,localReady);
    const operation=this.serialProject(row.project,()=>this.createLocal(
      {purpose:row.purpose,template:policy.template,hereOnly:false},row.project,
      {group:projectGroup(policy.group_name),receipt:policy.revision_id},()=>{
        this.publishCanvasState(row,'ready');releaseLocal();
      }));
    void operation.then(()=>{
      db.transaction(()=>{
        db.query("UPDATE canvas_project_ensures SET state='ready',created_project=?,error=NULL,updated_at_ms=? WHERE board_id=?")
          .run(1,Date.now(),row.board_id);
        this.publishCanvasState(row,'ready');
      })();
    },error=>{
      db.transaction(()=>{
        db.query("UPDATE canvas_project_ensures SET state=?,error=?,updated_at_ms=? WHERE board_id=?")
          .run(classify(error)==='permanent'?'failed':'creating',message(error).slice(0,1000),Date.now(),row.board_id);
        const current=this.canvasRow(row.board_id)!;
        this.publishCanvasState(current,this.canvasState(current).state);
      })();
    }).finally(()=>{releaseLocal();if(this.canvasLocalReadiness.get(row.board_id)===localReady)this.canvasLocalReadiness.delete(row.board_id);this.wake();});
    await localReady;
  }
  async ensureCanvas(input:unknown){
    const data=exactKeys(input,['clientActionId','boardId','boardTitle','boardClock','existingProject']);const actionId=canvasAction(data.clientActionId),board=canvasBoard(data.boardId),title=canvasTitle(data.boardTitle);
    const titleClock=data.boardClock===undefined?0:data.boardClock;
    if(!Number.isSafeInteger(titleClock)||titleClock<0)throw new Error('Canvas title revision is invalid.');
    const requestedExisting=data.existingProject===undefined?null:(()=>{const existing=exactKeys(data.existingProject,['name','inside']);return {name:existingName(existing.name),inside:canvasInside(existing.inside)};})();
    const actionBoard=db.query('SELECT board_id FROM canvas_project_ensures WHERE client_action_id=?').get(actionId) as {board_id:string}|null;
    if(actionBoard&&actionBoard.board_id!==board)throw new Error('Canvas project action identity already belongs to another Canvas.');
    let row=this.canvasRow(board);
    if(row){
      const explicit=row.state==='ready'&&row.policy_revision_id===null&&!row.created_project;
      // The stored action identifies folder creation. A newer title is its own command,
      // while the board ID and any explicit binding still freeze the project choice.
      if(!explicit&&!!requestedExisting||requestedExisting&&(row.project!==requestedExisting.name||row.inside!==requestedExisting.inside))
        throw new Error('Canvas project choice already has different immutable inputs.');
      if(titleClock>row.title_clock){
        db.query('UPDATE canvas_project_ensures SET title=?,title_clock=?,updated_at_ms=? WHERE board_id=? AND title_clock<?')
          .run(title,titleClock,Date.now(),board,titleClock);
        row=this.canvasRow(board)!;
      }
    }
    if(!row){
      let project:string,inside:string|null=null,state:'ready'|'awaiting_policy'='awaiting_policy',created=0;
      if(requestedExisting){
        const name=requestedExisting.name;inside=requestedExisting.inside;
        const requested=inside?`${name}/${inside}`:name,resolved=sessionProject(this.workspace,requested,{inside:true}),registered=resolved&&containingProject(this.workspace,resolved.cwd);
        if(!resolved||!registered||registered.name!==name)throw new Error('The existing Canvas project is not registered at that folder.');
        project=name;state='ready';
      }else project=this.canvasName(title,board);
      const purpose=canvasPurpose(title),now=Date.now(),policy=state==='ready'?null:this.canvasPolicy();
      db.transaction(()=>{
        db.query(`INSERT INTO canvas_project_ensures(board_id,client_action_id,project,inside,title,title_clock,purpose,template,state,policy_revision_id,created_project,created_at_ms,updated_at_ms)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(board,actionId,project,inside,title,titleClock,purpose,policy?.template??'writing',state==='ready'?'ready':policy?'creating':'awaiting_policy',policy?.revision_id??null,created,now,now);
        row=this.canvasRow(board)!;
        this.publishCanvasState(row!,state==='ready'?'ready':'pending');
      })();
    }
    if(row.state==='ready'||row.state==='failed'){
      this.publishCanvasState(row,this.canvasState(row).state);
      return this.canvasView(row);
    }
    await this.advanceCanvas(row);
    return this.canvasView(this.canvasRow(board)!);
  }
  setCanvasPolicy(input:unknown){
    const data=exactKeys(input,['consultation']);
    if(typeof data.consultation!=='string'||!/^[a-f0-9-]{36}$/.test(data.consultation))throw new Error('Canvas policy needs one completed workspace-organizer consultation.');
    const organizer=standingAgentSession(this.workspace,'workspace-organizer');
    if(!organizer)throw new Error('The workspace organizer must be bound before setting Canvas placement.');
    const row=db.query(`SELECT request.target_session_id,request.outcome,answer.payload_json
      FROM session_communication_requests request
      JOIN session_communication_events answer ON answer.request_id=request.request_id AND answer.kind='final'
        AND answer.superseded_by_event_id IS NULL AND answer.action_key IS NOT NULL
      WHERE request.request_id=?`).get(data.consultation) as {target_session_id:number;outcome:string|null;payload_json:string}|null;
    if(!row||row.target_session_id!==organizer.id||row.outcome!=='answered')throw new Error('Canvas policy needs a completed answer from the bound workspace organizer.');
    const answer=JSON.parse(row.payload_json) as {replyBody?:unknown;workDisposition?:unknown;responding_session_id?:unknown;source?:{input_id?:unknown;run_id?:unknown}};
    if(answer.workDisposition!=='completed'||answer.responding_session_id!==`concierge:${organizer.id}`||typeof answer.replyBody!=='string'||typeof answer.source?.input_id!=='string'||typeof answer.source.run_id!=='string')
      throw new Error('The workspace organizer answer lacks exact reply custody.');
    const accepted=getAcceptedSessionInput(answer.source.input_id);
    if(!accepted?.turn_id||accepted.session_id!==organizer.id||nativeRunId(accepted.turn_id)!==answer.source.run_id)
      throw new Error('The workspace organizer answer source is invalid.');
    let decision:Record<string,unknown>;
    try{decision=exactKeys(JSON.parse(answer.replyBody),['group','template']);}catch{throw new Error('The workspace organizer answer must be one exact Canvas policy JSON object.');}
    const group=projectGroup(decision.group),template=projectTemplate(decision.template);
    if(!group||!template)throw new Error('Canvas project policy needs one grouping folder and one project template.');
    const revision=createHash('sha256').update(JSON.stringify([data.consultation,answer.source.input_id,answer.source.run_id,group,template])).digest('hex').slice(0,32);
    const prior=db.query('SELECT * FROM canvas_project_policies WHERE consultation_request_id=?').get(data.consultation) as CanvasPolicyRow|null;
    if(prior&&prior.revision_id!==revision)throw new Error('This organizer consultation already recorded a different Canvas policy.');
    db.query(`INSERT OR IGNORE INTO canvas_project_policies(revision_id,group_name,template,consultation_request_id,source_session_id,source_input_id,source_run_id,created_at_ms)
      VALUES(?,?,?,?,?,?,?,?)`).run(revision,group,template,data.consultation,organizer.id,answer.source.input_id,answer.source.run_id,Date.now());
    this.wake();return {revisionId:revision,group,template,consultation:data.consultation,sourceSession:`concierge:${organizer.id}`,sourceInputId:answer.source.input_id,sourceRunId:answer.source.run_id};
  }
  async share(input:unknown){const data=exactKeys(input,['name','to','source']);const project=existingName(data.name),peer=this.peer(data.to),source=this.source(data.source);
    return this.serialProject(project,async()=>{
    const registered=sessionProject(this.workspace,project);
    const destination=registered?.cwd??join(this.workspace,project);
    const folder=dirname(destination)===this.workspace?undefined:relative(this.workspace,dirname(destination));
    if(folder)projectGroup(folder);
    if(!projectPredicate(destination)||!registered)throw new Error('The local project must be a registered Git project with AGENTS.md.');
    if(await originOf(destination)!==expectedOrigin(project,folder))throw new Error('This project is not from the expected private tejasdc repository.');
    const branch=await git(destination,'branch','--show-current');if(!branch)throw new Error('Push the project branch before sharing.');
    const local=await head(destination),remote=(await git(destination,'ls-remote','--heads','origin',branch)).split(/\s+/)[0];
    if(local!==remote)throw new Error('The local branch is ahead of its origin; push first.');
    return this.record(project,peer,source,folder);
    });
  }
  status(projectValue:unknown,peerValue?:unknown){const project=existingName(projectValue);const peer=peerValue===undefined?null:this.peer(peerValue);
    const rows=db.query(`SELECT * FROM project_setup_orders WHERE project=? AND (? IS NULL OR peer=?) ORDER BY created_at_ms`).all(project,peer,peer) as Outgoing[];
    return {project,orders:rows.map(row=>({orderId:row.order_id,peer:row.peer,state:row.state,message:['recorded','delivered'].includes(row.state)?`waiting for ${row.peer}`:null,result:row.result_json?JSON.parse(row.result_json):null,createdAt:new Date(row.created_at_ms).toISOString()}))};
  }
  cancel(input:unknown){const data=exactKeys(input,['name','to']);const project=existingName(data.name),peer=this.peer(data.to);
    const row=db.query('SELECT * FROM project_setup_orders WHERE project=? AND peer=? ORDER BY created_at_ms DESC,rowid DESC').get(project,peer) as Outgoing|null;
    if(!row)throw new Error('No project setup order exists for this peer.');
    if(row.state!=='recorded'||row.last_attempt_at_ms!==null||this.sending.has(row.order_id))throw new Error('Only an order never attempted for delivery can be cancelled.');
    db.query("UPDATE project_setup_orders SET state='cancelled',result_json=? WHERE order_id=? AND state='recorded'").run(JSON.stringify({state:'cancelled',reason:'Cancelled locally before delivery.'}),row.order_id);
    this.attemptReturn(row.order_id);this.onRecorded?.();
    return this.status(project,peer);
  }
  private notice(row:Outgoing,kind:string,text:string){
    const current=db.query('SELECT notice_kind FROM project_setup_orders WHERE order_id=?').get(row.order_id) as {notice_kind:string|null}|null;
    if(current?.notice_kind)return;
    db.query('UPDATE project_setup_orders SET notice_kind=?,notice_text=? WHERE order_id=? AND notice_kind IS NULL').run(`pending:${kind}`,text,row.order_id);
    void this.sendNotice(row.order_id);this.onRecorded?.();
  }
  private async sendNotice(id:string){
    const row=db.query('SELECT * FROM project_setup_orders WHERE order_id=?').get(id) as Outgoing|null;
    if(!row?.notice_kind?.startsWith('pending:')||!row.notice_text)return;
    const kind=row.notice_kind.slice('pending:'.length);
    try{
      const inbox=db.query("SELECT 1 FROM sessions WHERE json_extract(native_metadata_json,'$.inbox')=1 LIMIT 1").get();
      if(inbox){const recorded=publishProviderFreeNotice(db,{key:`project-setup:${id}:${kind}`,kind:'project_setup_notice',text:row.notice_text});if(recorded)fileServiceNotices();}
      else{
        const cloud=this.clients.get('cloud');if(!cloud)throw new Error('Cloud Inbox peer is unavailable for this machine.');
        await cloud.request('POST','/sessions/v1/peers/project-notices',{orderId:id,sourcePeer:this.self,kind,text:row.notice_text});
      }
      db.query('UPDATE project_setup_orders SET notice_kind=? WHERE order_id=? AND notice_kind=?').run(kind,id,row.notice_kind);
    }catch(error){log('warn','project_setup_notice_waiting',{order_id:id,...errorFields(error)});}
  }
  acceptNotice(value:unknown){
    const data=exactKeys(value,['orderId','sourcePeer','kind','text']);
    if(!/^[a-f0-9]{32}$/.test(data.orderId)||!this.clients.has(data.sourcePeer)||!['refused','failed','needs_update','waiting'].includes(data.kind)||typeof data.text!=='string'||data.text.length>2000)throw new Error('Invalid peer project notice.');
    const recorded=publishProviderFreeNotice(db,{key:`project-setup:${data.orderId}:${data.kind}`,kind:'project_setup_notice',text:data.text});
    if(recorded)fileServiceNotices();return {recorded};
  }
  private complete(row:Outgoing,outcome:Outcome){
    const current=db.query('SELECT state FROM project_setup_orders WHERE order_id=?').get(row.order_id) as {state:string}|null;
    if(current&&TERMINAL.has(current.state))return;
    db.query('UPDATE project_setup_orders SET state=?,result_json=? WHERE order_id=?').run(outcome.state,JSON.stringify(outcome),row.order_id);
    log('info','project_setup_order_settled',{order_id:row.order_id,peer:row.peer,project:row.project,state:outcome.state,failure_class:outcome.failureClass??null,commit:outcome.commit??null});
    this.attemptReturn(row.order_id);
    if(outcome.state==='refused'||outcome.state==='failed'&&outcome.failureClass==='permanent')this.notice(row,outcome.state,`Project ${row.project} could not be set up on ${machineName(row.peer)}: ${REASONS[outcome.reason??'']??outcome.reason??outcome.state}.`);
    this.onRecorded?.();
  }
  private attemptReturn(id:string){
    const row=db.query('SELECT * FROM project_setup_orders WHERE order_id=?').get(id) as Outgoing|null;
    if(!row?.source_session_id||!row.source_input_id||!row.source_run_id||row.return_input_id||!row.result_json)return;
    const source=getSessionById(row.source_session_id);if(!source)return;
    const outcome=JSON.parse(row.result_json) as Outcome,inputId=`return:project-setup:${id}`;
    try{this.owner().admit({sessionId:source.id,inputId,origin:'service',sourceInputId:row.source_input_id,sourceRunId:row.source_run_id,requestId:id,
      text:`Project setup on ${row.peer} for ${row.project}: ${outcome.state}. ${outcome.reason??''} ${outcome.commit??''}. This is a result, not a new human request.`});
      db.query('UPDATE project_setup_orders SET return_input_id=? WHERE order_id=?').run(inputId,id);
    }catch(error){log('warn','project_setup_return_waiting',{order_id:id,...errorFields(error)});}
  }
  private async send(row:Outgoing){
    const client=this.clients.get(row.peer);if(!client)return;
    db.query('UPDATE project_setup_orders SET last_attempt_at_ms=? WHERE order_id=?').run(Date.now(),row.order_id);
    this.sending.add(row.order_id);
    try{
      const status=await client.request<{operations?:string[]}>('GET','/sessions/v1/status',undefined,5000);
      const folder=(JSON.parse(row.body_json) as Order).folder;
      if(!status.operations?.includes('project.setup')||!status.operations.includes(PROJECT_FOLDERS_OPERATION)
        ||folder===LAB_EXPERTISE_GROUP&&!status.operations.includes(PROJECT_NESTED_EXPERTISE_OPERATION)){
        db.query("UPDATE project_setup_orders SET state='needs_update' WHERE order_id=?").run(row.order_id);
        this.notice(row,'needs_update',needsUpdateText(row));return;
      }
      const response=await client.request<{state:string;outcome?:Outcome}>('POST','/sessions/v1/peers/operations',JSON.parse(row.body_json),120000);
      if(response.outcome&&!(response.outcome.state==='failed'&&response.outcome.failureClass==='transient'))this.complete(row,response.outcome);
      else db.query("UPDATE project_setup_orders SET state='delivered' WHERE order_id=?").run(row.order_id);
      const pulled=await client.request<{outcome?:Outcome}>('GET',`/sessions/v1/peers/operations/${row.order_id}`,undefined,5000);
      if(pulled.outcome&&!(pulled.outcome.state==='failed'&&pulled.outcome.failureClass==='transient'))this.complete(row,pulled.outcome);
    }catch(error){
      if(error instanceof PeerError&&error.status===404){db.query("UPDATE project_setup_orders SET state='needs_update' WHERE order_id=?").run(row.order_id);this.notice(row,'needs_update',needsUpdateText(row));}
      else {
        try{const pulled=await client.request<{outcome?:Outcome}>('GET',`/sessions/v1/peers/operations/${row.order_id}`,undefined,5000);
          if(pulled.outcome&&!(pulled.outcome.state==='failed'&&pulled.outcome.failureClass==='transient'))this.complete(row,pulled.outcome);
        }catch{}
        log('warn','project_setup_delivery_waiting',{order_id:row.order_id,peer:row.peer,...errorFields(error)});
      }
    }finally{this.sending.delete(row.order_id);}
  }
  wake(){if(this.running)return;this.running=true;queueMicrotask(async()=>{try{
    for(const row of db.query("SELECT * FROM canvas_project_ensures WHERE state='awaiting_policy' OR (state='creating' AND updated_at_ms<=?) ORDER BY created_at_ms").all(Date.now()-30_000) as CanvasEnsureRow[])await this.advanceCanvas(row);
    for(const notice of db.query("SELECT order_id FROM project_setup_orders WHERE notice_kind LIKE 'pending:%'").all() as {order_id:string}[])await this.sendNotice(notice.order_id);
    for(const pending of db.query("SELECT order_id FROM project_setup_orders WHERE source_session_id IS NOT NULL AND state IN ('done','already_present','refused','failed','cancelled') AND return_input_id IS NULL").all() as {order_id:string}[])this.attemptReturn(pending.order_id);
    for(const row of db.query("SELECT * FROM project_setup_orders WHERE state NOT IN ('done','already_present','refused','failed','cancelled') ORDER BY created_at_ms").all() as Outgoing[]){
    if(Date.now()-row.created_at_ms>=24*60*60_000&&!row.notice_kind)this.notice(row,'waiting',`Project ${row.project} has been waiting a day to be set up on ${machineName(row.peer)}, which has not answered. It will finish on its own when that machine is back.`);
    await this.send(row);
  }}catch(error){log('error','project_setup_wake_failed',errorFields(error));}finally{this.running=false;
    const pending=db.query("SELECT 1 FROM canvas_project_ensures WHERE state='creating' ORDER BY created_at_ms LIMIT 1").get();
    if(pending)setTimeout(()=>this.wake(),30_000).unref();
  }});}
  async receive(value:unknown){let raw:Record<string,any>;
    try{raw=exactKeys(value,['orderId','kind','origin','project','folder']);}
    catch{const id=(value as any)?.orderId;if(typeof id==='string'&&/^[a-f0-9]{32}$/.test(id))return {state:'refused',outcome:{state:'refused',reason:'unknown_field'}};throw new Error('Invalid project setup order.');}
    if(typeof raw.orderId!=='string'||!/^[a-f0-9]{32}$/.test(raw.orderId))throw new Error('Invalid setup order ID.');
    const existing=db.query('SELECT * FROM project_setup_receipts WHERE order_id=?').get(raw.orderId) as {body_json:string;result_json:string|null}|null;
    if(existing&&existing.body_json!==JSON.stringify(raw))throw new Error('Setup order identity conflicts with its retained body.');
    if(existing?.result_json){const result=JSON.parse(existing.result_json) as Outcome;if(result.state!=='failed'||result.failureClass==='permanent')return {state:result.state,outcome:result};}
    const fail=(outcome:Outcome)=>{
      db.query('INSERT INTO project_setup_receipts(order_id,body_json,result_json) VALUES(?,?,?) ON CONFLICT(order_id) DO UPDATE SET result_json=excluded.result_json').run(raw.orderId,JSON.stringify(raw),JSON.stringify(outcome));
      log(outcome.state==='done'||outcome.state==='already_present'?'info':'warn','project_setup_received',{order_id:raw.orderId,state:outcome.state,failure_class:outcome.failureClass??null,commit:outcome.commit??null});
      if(outcome.state!=='failed'||outcome.failureClass==='permanent'){
        const peer=typeof raw.origin?.peer==='string'?this.clients.get(raw.origin.peer):null;
        if(peer)void peer.request('POST',`/sessions/v1/peers/operations/${raw.orderId}/outcome`,{outcome}).catch(error=>log('warn','project_setup_outcome_push_waiting',{order_id:raw.orderId,...errorFields(error)}));
      }
      return {state:outcome.state,outcome};
    };
    if(raw.kind!=='project.setup')return fail({state:'refused',reason:'unknown_kind'});
    let project:string;try{project=existingName(raw.project);}catch{return fail({state:'refused',reason:'invalid_name'});}
    let folder:string|undefined;
    try{folder=projectGroup(raw.folder);}catch{return fail({state:'refused',reason:'unknown_field'});}
    if(!raw.origin||typeof raw.origin!=='object'||Array.isArray(raw.origin)||Object.keys(raw.origin).some(key=>!['peer','session','input','run','originatingHuman','terminal'].includes(key)))return fail({state:'refused',reason:'invalid_repository'});
    if(raw.origin.terminal!==true&&(!this.clients.has(raw.origin.peer)||typeof raw.origin.session!=='string'||typeof raw.origin.input!=='string'||typeof raw.origin.run!=='string'))return fail({state:'refused',reason:'invalid_repository'});
    return this.serialProject(project,async()=>{
    const latest=db.query('SELECT result_json FROM project_setup_receipts WHERE order_id=?').get(raw.orderId) as {result_json:string|null}|null;
    if(latest?.result_json){const outcome=JSON.parse(latest.result_json) as Outcome;
      if(outcome.state!=='failed'||outcome.failureClass==='permanent')return {state:outcome.state,outcome};}
    const destination=projectFolder(this.workspace,project,folder);
    // A project this machine already holds under the other placement stays where it is: moving a
    // folder would strand the sessions and transcripts recorded against its path.
    const previouslyRegistered=sessionProject(this.workspace,project);
    for(const existing of new Set([destination,...(previouslyRegistered?[previouslyRegistered.cwd]:[])]))if(pathExists(existing)){
      if(await originOf(existing)===expectedOrigin(project,folder)&&projectPredicate(existing)){notesLink(this.workspace,project,existing,false);return fail({state:'already_present',commit:await head(existing)});}
      return fail({state:'refused',reason:'destination_conflict'});
    }
    const temporary=join(this.workspace,'.project-setup',raw.orderId,project);
    if(this.receiving.has(raw.orderId))return {state:'running'};
    this.receiving.add(raw.orderId);
    try{
      for(const parent of [join(this.workspace,'.project-setup'),dirname(temporary)])if(pathExists(parent)&&!lstatSync(parent).isDirectory())return fail({state:'refused',reason:'destination_conflict'});
      mkdirSync(dirname(temporary),{recursive:true});
      if(pathExists(temporary)&&!lstatSync(temporary).isDirectory())return fail({state:'refused',reason:'destination_conflict'});
      if(!pathExists(temporary))await run('git',[...CLONE_OPTIONS,'clone','--no-checkout','--no-recurse-submodules',`${expectedOrigin(project,folder)}.git`,temporary]);
      await run('git',[...CLONE_OPTIONS,'checkout','--force','HEAD'],temporary);
      if(await originOf(temporary)!==expectedOrigin(project,folder))return fail({state:'refused',reason:'invalid_repository'});
      if(!projectPredicate(temporary))return fail({state:'failed',failureClass:'permanent',reason:'The GitHub repository is not a project on this machine.'});
      if(pathExists(destination))return fail({state:'refused',reason:'destination_conflict'});
      if(folder)ensureGroupFolder(this.workspace,folder);
      renameSync(temporary,destination);try{rmSync(dirname(temporary),{recursive:true,force:true});}catch{}
      notesLink(this.workspace,project,destination,false);
      if(!projectPredicate(destination))return fail({state:'failed',failureClass:'permanent',reason:'project predicate failed'});
      return fail({state:'done',commit:await head(destination)});
    }catch(error){
      // The temporary clone is this handler's own; a failed attempt leaves nothing behind.
      try{rmSync(dirname(temporary),{recursive:true,force:true});}catch{}
      return fail({state:'failed',failureClass:classify(error),reason:message(error).slice(0,400)});
    }
    finally{this.receiving.delete(raw.orderId);}
    });
  }
  receipt(id:string){if(!/^[a-f0-9]{32}$/.test(id))throw new Error('Invalid setup order ID.');const row=db.query('SELECT result_json FROM project_setup_receipts WHERE order_id=?').get(id) as {result_json:string|null}|null;if(!row)throw new Error('Unknown setup order.');return {outcome:row.result_json?JSON.parse(row.result_json):null};}
  pushed(id:string,value:unknown){const row=db.query('SELECT * FROM project_setup_orders WHERE order_id=?').get(id) as Outgoing|null;if(!row)throw new Error('Unknown setup order.');const data=exactKeys(value,['outcome']);const outcome=data.outcome as Outcome;if(!outcome||!['done','already_present','refused','failed'].includes(outcome.state))throw new Error('Invalid setup outcome.');this.complete(row,outcome);return this.status(row.project,row.peer);}
}
