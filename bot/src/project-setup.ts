import {createHash} from 'node:crypto';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync,lstatSync,mkdirSync,readFileSync,readlinkSync,renameSync,symlinkSync,writeFileSync} from 'node:fs';
import {join,relative,dirname} from 'node:path';
import {db,getSessionById} from './state';
import {canonicalAgentsTemplate,canonicalDocsIndexTemplate} from './project-scaffold';
import {sessionProject} from './session-projects';
import {getAcceptedSessionInput,nativeRunId,sessionInputProvenance} from './session-inputs';
import {publishProviderFreeNotice} from './provider-free-notice';
import {fileServiceNotices} from './session-topics';
import type {SessionOwner} from './session-owner';
import type {PeerClient} from './session-peers';
import {PeerError} from './session-peers';
import {log,errorFields} from './log';

const NAME=/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;
const VAGUE=new Set(['commands','tools','scripts','utils','misc','stuff','test','project','new','temp','app','helpers','things','notes']);
const TERMINAL=new Set(['done','already_present','refused','failed','cancelled']);
const CLONE_OPTIONS=['-c','core.hooksPath=/dev/null','-c','protocol.file.allow=never','-c','protocol.ssh.allow=never','-c','protocol.git.allow=never','-c','protocol.ext.allow=never','-c','submodule.recurse=false','-c','filter.lfs.smudge=','-c','core.fsmonitor=false'];
type Origin={peer:string;session:string;input:string;run:string;originatingHuman:unknown}|{terminal:true};
type Order={orderId:string;kind:'project.setup';origin:Origin;project:string};
type Outcome={state:'done'|'already_present'|'refused'|'failed'|'cancelled';reason?:string;failureClass?:'transient'|'permanent';commit?:string};
type Outgoing={order_id:string;peer:string;project:string;body_json:string;state:string;result_json:string|null;created_at_ms:number;last_attempt_at_ms:number|null;notice_kind:string|null;notice_text:string|null;source_session_id:number|null;source_input_id:string|null;source_run_id:string|null;return_input_id:string|null};
const gitEnv=()=>({...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never',GIT_LFS_SKIP_SMUDGE:'1',GIT_ALLOW_PROTOCOL:'https'});
const run=(file:string,args:string[],cwd?:string)=>execFileSync(file,args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:gitEnv()}).trim();
// A clone can take minutes; it must not hold the owner's event loop (speech, sessions, peers).
const runAsync=async(file:string,args:string[],cwd?:string)=>(await promisify(execFile)(file,args,{cwd,encoding:'utf8',env:gitEnv(),maxBuffer:16*1024*1024})).stdout.trim();
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
function originOf(path:string){try{return git(path,'remote','get-url','origin').replace(/\.git$/,'').replace(/^git@github\.com:/,'https://github.com/');}catch{return null;}}
function expectedOrigin(project:string){return `https://github.com/tejasdc/${project}`;}
function head(path:string){return git(path,'rev-parse','HEAD');}
function projectPredicate(path:string){try{return lstatSync(join(path,'.git')).isDirectory()&&lstatSync(join(path,'AGENTS.md')).isFile();}catch{return false;}}
function createScaffold(path:string,project:string,purpose:string,workspace:string){
  const intent=join(path,'tmp','project-setup-intent.json');
  mkdirSync(join(path,'tmp'),{recursive:true});
  if(pathExists(intent)){
    if(readFileSync(intent,'utf8')!==JSON.stringify({project,purpose}))throw new Error('This folder has a different unfinished project setup.');
  }else writeFileSync(intent,JSON.stringify({project,purpose}),{flag:'wx'});
  const file=(name:string,content:string)=>{const target=join(path,name);if(pathExists(target)){if(readFileSync(target,'utf8')!==content)throw new Error(`Existing ${name} differs from the project scaffold.`);}else writeFileSync(target,content,{flag:'wx'});};
  mkdirSync(join(path,'docs'),{recursive:true});
  file('AGENTS.md',canonicalAgentsTemplate(project,path).replace(`Working directory: \`${path}\``,`${purpose}\n\nWorking directory: \`${path}\``));
  const claude=join(path,'CLAUDE.md');
  if(pathExists(claude)){if(!lstatSync(claude).isSymbolicLink()||readlinkSync(claude)!=='AGENTS.md')throw new Error('Existing CLAUDE.md is not the canonical link.');}
  else symlinkSync('AGENTS.md',claude);
  file('docs/README.md',canonicalDocsIndexTemplate(project));file('.gitignore','tmp/\n');
  notesLink(workspace,project,path);
  if(!pathExists(join(path,'.git')))git(path,'init');
  try{head(path);}catch{git(path,'add','--all');git(path,'commit','-m',`Create ${project} project`);}
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
const REASONS:Record<string,string>={unknown_kind:'that machine does not know this kind of setup',invalid_name:'the project name is not a valid project name',invalid_repository:'the request did not name one of your repositories',destination_conflict:'a different folder with that name is already there, and it was left untouched'};
const needsUpdateText=(row:{project:string;peer:string})=>`Concierge on ${machineName(row.peer)} needs updating before project ${row.project} can be set up there. It will finish on its own once that update is installed.`;
function classify(error:unknown):'transient'|'permanent'{const text=String(error).toLowerCase();return /authentication|permission denied|repository not found|not found|could not read username|project predicate|invalid repository|unknown revision|reference is not a tree|does not have any commits/.test(text)?'permanent':'transient';}
function message(error:unknown){return error instanceof Error?error.message:String(error);}

export class ProjectSetup {
  private running=false;
  private readonly sending=new Set<string>();
  private readonly receiving=new Set<string>();
  constructor(private readonly workspace:string,private readonly self:string,private readonly clients:Map<string,PeerClient>,private readonly owner:()=>SessionOwner,private readonly onRecorded?:()=>void){}
  hasPending(){return !!db.query("SELECT 1 FROM project_setup_orders WHERE state NOT IN ('done','already_present','refused','failed','cancelled') OR notice_kind LIKE 'pending:%' OR (source_session_id IS NOT NULL AND state IN ('done','already_present','refused','failed','cancelled') AND return_input_id IS NULL) LIMIT 1").get();}
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
  private record(project:string,peer:string,source:ReturnType<ProjectSetup['source']>){
    const prior=db.query('SELECT state FROM project_setup_orders WHERE peer=? AND project=? ORDER BY created_at_ms DESC,rowid DESC').all(peer,project) as {state:string}[];
    if(prior.length&&!['refused','failed','cancelled'].includes(prior[0]!.state))return this.status(project,peer);
    const id=orderId(peer,project,prior.length+1);
    const origin:Origin=source?{peer:this.self,session:`concierge:${source.session}`,input:source.input,run:source.run,originatingHuman:source.originatingHuman}:{terminal:true};
    const body:Order={orderId:id,kind:'project.setup',origin,project};
    db.query(`INSERT OR IGNORE INTO project_setup_orders(order_id,peer,project,body_json,state,created_at_ms,source_session_id,source_input_id,source_run_id)
      VALUES(?,?,?,?,'recorded',?,?,?,?)`).run(id,peer,project,JSON.stringify(body),Date.now(),source?.session??null,source?.input??null,source?.run??null);
    log('info','project_setup_order_recorded',{order_id:id,peer,project});
    this.wake();this.onRecorded?.();return this.status(project,peer);
  }
  new(input:unknown){
    const data=exactKeys(input,['name','purpose','hereOnly','source']);const project=newName(data.name);
    if(typeof data.purpose!=='string'||!data.purpose.trim()||/[\r\n]/.test(data.purpose))throw new Error('A one-sentence --purpose is required.');
    if(/[.!?]\s+\S/.test(data.purpose.trim()))throw new Error('--purpose must be one sentence.');
    if(data.hereOnly!==undefined&&typeof data.hereOnly!=='boolean')throw new Error('hereOnly must be true or false.');
    if(!data.hereOnly&&!this.clients.size)throw new Error('No peer is configured; use --here-only for a local project.');
    const source=this.source(data.source);const destination=join(this.workspace,project);
    const intent=join(destination,'tmp','project-setup-intent.json');
    if(pathExists(destination)&&!pathExists(intent))throw new Error('A local folder already uses this name; use projects share for an existing project.');
    if(pathExists(intent)&&originOf(destination)&&originOf(destination)!==expectedOrigin(project))throw new Error('The unfinished project has a different GitHub origin.');
    if(!pathExists(destination))mkdirSync(destination);
    if(pathExists(intent))createScaffold(destination,project,data.purpose.trim(),this.workspace);
    else if(!projectPredicate(destination))createScaffold(destination,project,data.purpose.trim(),this.workspace);
    const current=git(destination,'status','--porcelain');if(current)throw new Error('The existing project has unpushed or uncommitted files; finish and push it first.');
    if(originOf(destination)!==expectedOrigin(project)){
      if(originOf(destination))throw new Error('This folder has a different GitHub origin.');
      try{run('gh',['repo','create',`tejasdc/${project}`,'--private','--description',data.purpose.trim(),'--source',destination,'--push']);}
      catch(error){
        const repository=JSON.parse(run('gh',['repo','view',`tejasdc/${project}`,'--json','visibility,url']));
        if(repository.visibility!=='PRIVATE'||repository.url!==expectedOrigin(project))throw error;
        const remoteHead=run('git',['ls-remote',`${expectedOrigin(project)}.git`,'HEAD']).split(/\s+/)[0];
        if(remoteHead&&remoteHead!==head(destination))throw new Error('A GitHub repository with this name already exists; choose another descriptive name.');
        if(!originOf(destination))git(destination,'remote','add','origin',`${expectedOrigin(project)}.git`);
      }
    }
    const repository=JSON.parse(run('gh',['repo','view',`tejasdc/${project}`,'--json','visibility,url']));
    if(repository.visibility!=='PRIVATE'||repository.url!==expectedOrigin(project))throw new Error('The GitHub repository is not the expected private tejasdc repository.');
    if(originOf(destination)!==expectedOrigin(project))throw new Error('The local Git origin does not name the created repository.');
    if(git(destination,'remote','get-url','origin')!==`${expectedOrigin(project)}.git`)git(destination,'remote','set-url','origin',`${expectedOrigin(project)}.git`);
    const branch=git(destination,'branch','--show-current');
    if(!branch)throw new Error('The project has no branch to push.');
    git(destination,'push','-u','origin',branch);
    const remote=git(destination,'ls-remote','--exit-code','origin','HEAD');
    if(!remote.startsWith(head(destination)))throw new Error('The project was not pushed to its private GitHub repository; setup order was not recorded.');
    const commit=head(destination);
    const orders=db.transaction(()=>{
      const prior=db.query('SELECT purpose FROM project_creations WHERE project=?').get(project) as {purpose:string}|null;
      if(prior&&prior.purpose!==data.purpose.trim())throw new Error('This project was created with a different purpose.');
      db.query('INSERT OR IGNORE INTO project_creations(project,purpose,commit_sha,here_only,created_at_ms) VALUES(?,?,?,?,?)').run(project,data.purpose.trim(),commit,data.hereOnly?1:0,Date.now());
      return data.hereOnly?[]:[...this.clients.keys()].map(peer=>this.record(project,peer,source));
    })();
    log('info','project_created',{project,commit,here_only:!!data.hereOnly});
    return {project,local:'done',commit,orders};
  }
  share(input:unknown){const data=exactKeys(input,['name','to','source']);const project=existingName(data.name),peer=this.peer(data.to),source=this.source(data.source);
    const destination=join(this.workspace,project);
    if(!projectPredicate(destination)||!sessionProject(this.workspace,project))throw new Error('The local project must be a registered Git project with AGENTS.md.');
    if(originOf(destination)!==expectedOrigin(project))throw new Error('This project is not from github.com/tejasdc under the same name.');
    const branch=git(destination,'branch','--show-current');if(!branch)throw new Error('Push the project branch before sharing.');
    const local=head(destination),remote=git(destination,'ls-remote','--heads','origin',branch).split(/\s+/)[0];
    if(local!==remote)throw new Error('The local branch is ahead of its origin; push first.');
    return this.record(project,peer,source);
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
      if(!status.operations?.includes('project.setup')){
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
    for(const notice of db.query("SELECT order_id FROM project_setup_orders WHERE notice_kind LIKE 'pending:%'").all() as {order_id:string}[])await this.sendNotice(notice.order_id);
    for(const pending of db.query("SELECT order_id FROM project_setup_orders WHERE source_session_id IS NOT NULL AND state IN ('done','already_present','refused','failed','cancelled') AND return_input_id IS NULL").all() as {order_id:string}[])this.attemptReturn(pending.order_id);
    for(const row of db.query("SELECT * FROM project_setup_orders WHERE state NOT IN ('done','already_present','refused','failed','cancelled') ORDER BY created_at_ms").all() as Outgoing[]){
    if(Date.now()-row.created_at_ms>=24*60*60_000&&!row.notice_kind)this.notice(row,'waiting',`Project ${row.project} has been waiting a day to be set up on ${machineName(row.peer)}, which has not answered. It will finish on its own when that machine is back.`);
    await this.send(row);
  }}catch(error){log('error','project_setup_wake_failed',errorFields(error));}finally{this.running=false;}});}
  async receive(value:unknown){let raw:Record<string,any>;
    try{raw=exactKeys(value,['orderId','kind','origin','project']);}
    catch{const id=(value as any)?.orderId;if(typeof id==='string'&&/^[a-f0-9]{32}$/.test(id))return {state:'refused',outcome:{state:'refused',reason:'invalid_repository'}};throw new Error('Invalid project setup order.');}
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
    if(!raw.origin||typeof raw.origin!=='object'||Array.isArray(raw.origin)||Object.keys(raw.origin).some(key=>!['peer','session','input','run','originatingHuman','terminal'].includes(key)))return fail({state:'refused',reason:'invalid_repository'});
    if(raw.origin.terminal!==true&&(!this.clients.has(raw.origin.peer)||typeof raw.origin.session!=='string'||typeof raw.origin.input!=='string'||typeof raw.origin.run!=='string'))return fail({state:'refused',reason:'invalid_repository'});
    const destination=join(this.workspace,project);
    if(pathExists(destination)){
      if(originOf(destination)===expectedOrigin(project)&&projectPredicate(destination)){notesLink(this.workspace,project,destination,false);return fail({state:'already_present',commit:head(destination)});}
      return fail({state:'refused',reason:'destination_conflict'});
    }
    const temporary=join(this.workspace,'.project-setup',raw.orderId,project);
    if(this.receiving.has(raw.orderId))return {state:'running'};
    this.receiving.add(raw.orderId);
    try{
      for(const parent of [join(this.workspace,'.project-setup'),dirname(temporary)])if(pathExists(parent)&&!lstatSync(parent).isDirectory())return fail({state:'refused',reason:'destination_conflict'});
      mkdirSync(dirname(temporary),{recursive:true});
      if(pathExists(temporary)&&!lstatSync(temporary).isDirectory())return fail({state:'refused',reason:'destination_conflict'});
      if(!pathExists(temporary))await runAsync('git',[...CLONE_OPTIONS,'clone','--no-checkout','--no-recurse-submodules',`${expectedOrigin(project)}.git`,temporary]);
      await runAsync('git',[...CLONE_OPTIONS,'checkout','--force','HEAD'],temporary);
      if(originOf(temporary)!==expectedOrigin(project))return fail({state:'refused',reason:'invalid_repository'});
      if(!projectPredicate(temporary))return fail({state:'failed',failureClass:'permanent',reason:'The GitHub repository is not a project on this machine.'});
      if(pathExists(destination))return fail({state:'refused',reason:'destination_conflict'});
      renameSync(temporary,destination);notesLink(this.workspace,project,destination,false);
      if(!projectPredicate(destination))return fail({state:'failed',failureClass:'permanent',reason:'project predicate failed'});
      return fail({state:'done',commit:head(destination)});
    }catch(error){return fail({state:'failed',failureClass:classify(error),reason:message(error).slice(0,400)});}
    finally{this.receiving.delete(raw.orderId);}
  }
  receipt(id:string){if(!/^[a-f0-9]{32}$/.test(id))throw new Error('Invalid setup order ID.');const row=db.query('SELECT result_json FROM project_setup_receipts WHERE order_id=?').get(id) as {result_json:string|null}|null;if(!row)throw new Error('Unknown setup order.');return {outcome:row.result_json?JSON.parse(row.result_json):null};}
  pushed(id:string,value:unknown){const row=db.query('SELECT * FROM project_setup_orders WHERE order_id=?').get(id) as Outgoing|null;if(!row)throw new Error('Unknown setup order.');const data=exactKeys(value,['outcome']);const outcome=data.outcome as Outcome;if(!outcome||!['done','already_present','refused','failed'].includes(outcome.state))throw new Error('Invalid setup outcome.');this.complete(row,outcome);return this.status(row.project,row.peer);}
}
