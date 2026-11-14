import type {Database} from 'bun:sqlite';
import {readFileSync,readlinkSync,readdirSync,realpathSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {processIdentity} from './runtime-identity';
import {CODEX_MANAGED_HOOK_CONFIG_METHOD,grantCodexMutationPermit,consumeCodexMutationPermit,
  recordCodexMutationResponse,reconcileCodexMutationIntent} from './codex-mutation-fence';

export {CODEX_MANAGED_HOOK_CONFIG_METHOD} from './codex-mutation-fence';

/** A machine-owned source operation, not a human input. Retries must retain operationId. */
export function beginCodexManagedHookInstall(db:Database,input:{operationId:string;paramsDigest:string;nowMs:number}){
  if(!input.operationId||input.operationId.length>256||!/^[a-f0-9]{64}$/.test(input.paramsDigest))
    throw new Error('Managed hook install requires a stable operation ID and exact parameter digest.');
  const permitId=`managed-hook-config:${input.operationId}`,intentId=permitId;
  return db.transaction(()=>{
    const prior=db.query('SELECT * FROM codex_mutation_intents WHERE intent_id=?').get(intentId) as any;
    if(prior){
      if(prior.permit_id!==permitId||prior.params_digest!==input.paramsDigest||prior.method!==CODEX_MANAGED_HOOK_CONFIG_METHOD||
        prior.thread_id!=='*'||prior.accepted_input_id!==`managed-hook-config:${input.operationId}`||
        prior.run_id!==input.operationId||prior.dispatch_attempt!==1)
        throw new Error('Managed hook install operation ID conflicts with retained issued work.');
      return {forward:false as const,permitId,intentId,reason:'already_issued' as const,duplicate:true as const,state:prior.state};
    }
    const grant=grantCodexMutationPermit(db,{permitId,threadId:'*',
      owner:{acceptedInputId:`managed-hook-config:${input.operationId}`,runId:input.operationId,dispatchAttempt:1},
      method:CODEX_MANAGED_HOOK_CONFIG_METHOD,paramsDigest:input.paramsDigest,purpose:'ordinary',nowMs:input.nowMs});
    if(!grant.granted)return {forward:false as const,permitId,intentId,reason:'reason' in grant?grant.reason:'permit_not_granted',duplicate:false as const};
    const consumed=consumeCodexMutationPermit(db,{permitId,intentId,paramsDigest:input.paramsDigest,nowMs:input.nowMs});
    if(!consumed.forward)return {forward:false as const,permitId,intentId,reason:'reason' in consumed?consumed.reason:'already_issued',duplicate:false as const};
    return {forward:true as const,permitId,intentId,duplicate:false as const};
  }).immediate();
}

/** Only the installer supervisor calls this after observing its exact child exit successfully. */
export function completeCodexManagedHookInstall(db:Database,input:{intentId:string;responseDigest:string;evidenceDigest:string;nowMs:number}){
  if(!/^[a-f0-9]{64}$/.test(input.responseDigest)||!/^[a-f0-9]{64}$/.test(input.evidenceDigest))
    throw new Error('Managed hook install completion requires digest-only evidence.');
  const intent=db.query('SELECT * FROM codex_mutation_intents WHERE intent_id=?').get(input.intentId) as any;
  if(!intent||intent.method!==CODEX_MANAGED_HOOK_CONFIG_METHOD||intent.thread_id!=='*'||
    intent.accepted_input_id!==`managed-hook-config:${intent.run_id}`||intent.intent_id!==`managed-hook-config:${intent.run_id}`||
    intent.permit_id!==intent.intent_id||intent.dispatch_attempt!==1)
    throw new Error('Managed hook install completion does not match a retained global config intent.');
  recordCodexMutationResponse(db,{intentId:input.intentId,kind:'accepted',responseDigest:input.responseDigest,nowMs:input.nowMs});
  return reconcileCodexMutationIntent(db,{intentId:input.intentId,outcome:'applied',evidenceDigest:input.evidenceDigest,nowMs:input.nowMs});
}

export function codexManagedHookConfigStatus(db:Database){
  const unresolved=db.query(`SELECT intent_id,state,params_digest,created_at_ms FROM codex_mutation_intents
    WHERE thread_id='*' AND method=? AND state IN ('forwarding','response_received','ambiguous') ORDER BY thread_revision`)
    .all(CODEX_MANAGED_HOOK_CONFIG_METHOD) as Array<{intent_id:string;state:string;params_digest:string;created_at_ms:number}>;
  return {blocked:unresolved.length>0,intents:unresolved};
}

type HookInstallerProcessSource={listPids():number[];identity(pid:number):{pid:number;bootId:string;startTicks:string;executablePath:string}|null;
  parentPid(pid:number):number|null;commandLine(pid:number):string[]|null};
const defaultProcessSource:HookInstallerProcessSource={
  listPids(){
    if(process.platform==='linux')return readdirSync('/proc',{withFileTypes:true}).filter(x=>x.isDirectory()&&/^\d+$/.test(x.name)).map(x=>Number(x.name));
    const output=spawnSync('/bin/ps',['-axo','pid='],{encoding:'utf8'});
    if(output.status!==0)throw new Error('process enumeration failed');
    return output.stdout.trim().split(/\s+/).filter(x=>/^\d+$/.test(x)).map(Number);
  },
  identity(pid){
    try{
      if(process.platform==='linux'){
        const stat=readFileSync(`/proc/${pid}/stat`,'utf8'),close=stat.lastIndexOf(')');
        const startTicks=stat.slice(close+1).trim().split(/\s+/)[19],executablePath=readlinkSync(`/proc/${pid}/exe`);
        if(close<0||!/^\d+$/.test(startTicks??'')||!executablePath.startsWith('/'))throw new Error('identity incomplete');
        return {pid,bootId:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),startTicks,executablePath};
      }
      const current=processIdentity(pid),command=spawnSync('/bin/ps',['-ww','-o','command=','-p',String(pid)],{encoding:'utf8'});
      if(command.status!==0||!command.stdout.trim())return null;
      const commandText=command.stdout.trim(),first=commandText.match(/^"([^"]+)"|^(\S+)/);
      const executablePath=first?.[1]??first?.[2]??'';
      if(!executablePath.startsWith('/'))throw new Error('process executable path is not absolute');
      return {pid,bootId:current.bootId,startTicks:current.startTicks,executablePath};
    }catch(error){if(['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??''))return null;throw error;}
  },
  parentPid(pid){
    try{
      if(process.platform==='linux'){
        const stat=readFileSync(`/proc/${pid}/stat`,'utf8'),close=stat.lastIndexOf(')');
        const ppid=Number(stat.slice(close+1).trim().split(/\s+/)[1]);return Number.isSafeInteger(ppid)&&ppid>0?ppid:null;
      }
      const output=spawnSync('/bin/ps',['-o','ppid=','-p',String(pid)],{encoding:'utf8'});
      const ppid=Number(output.stdout.trim());return output.status===0&&Number.isSafeInteger(ppid)&&ppid>0?ppid:null;
    }catch{return null;}
  },
  commandLine(pid){
    try{
      if(process.platform==='linux'){
        const args=readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0');if(args.at(-1)==='')args.pop();return args.length?args:null;
      }
      const output=spawnSync('/bin/ps',['-ww','-o','command=','-p',String(pid)],{encoding:'utf8'});
      return output.status===0&&output.stdout.trim()?[output.stdout.trim()]:null;
    }catch{return null;}
  }
};
const sha256=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
function isSupportedHookInstaller(argv:string[]){
  const patterns=[/(?:^|[\s/])install-codex-stop-hook\.sh(?:$|\s)/,/(?:^|[\s/])install-codex-stop-hook-body\.sh(?:$|\s)/,
    /(?:^|[\s/])codex-managed-hook-install\.(?:ts|js)(?:$|\s)/,/(?:^|[\s/])bot\/scripts\/deploy\.sh(?:$|\s)/,
    /(?:^|[\s/])control\/deploy\.sh(?:$|\s)/,/(?:^|[\s/])remote-box\/scripts\/deploy\.sh(?:$|\s)/,
    /(?:^|[\s/])bootstrap-deploy\.sh(?:$|\s)/,/(?:^|[\s/])deployment-control-launcher\.sh(?:$|\s)/,
    /(?:^|[\s/])deployment-repair-cutover\.sh(?:$|\s)/,/(?:^|[\s/])project-scaffold-cutover\.sh(?:$|\s)/,
    /(?:^|[\s/])install-mac\.sh(?:$|\s)/,/(?:^|[\s/])update-mac\.sh(?:$|\s)/];
  return argv.some(value=>patterns.some(pattern=>pattern.test(value)));
}

/** Register this actual helper process before it spawns any configuration-writing child. */
export function registerCurrentManagedHookInstaller(db:Database,input:{intentId:string;nowMs:number;proc?:HookInstallerProcessSource}){
  const source=input.proc??defaultProcessSource,pid=process.pid,parentPid=process.ppid;
  const own=source.identity(pid),parent=source.identity(parentPid),parentArgv=source.commandLine(parentPid);
  const helperPath=realpathSync(fileURLToPath(import.meta.url)),helperDigest=sha256(readFileSync(helperPath));
  if(!own||own.pid!==pid||!own.bootId||!/^\d+$/.test(own.startTicks)||!own.executablePath.startsWith('/')||
    !parent||parent.pid!==parentPid||!parentArgv||!isSupportedHookInstaller(parentArgv)||
    !parentArgv.some(value=>/(?:^|[\s/])install-codex-stop-hook\.sh(?:$|\s)/.test(value)))
    throw new Error('Managed hook installer process identity is unreadable.');
  const lineageDigest=sha256(JSON.stringify({pid,bootId:own.bootId,startTicks:own.startTicks,executablePath:own.executablePath,
    parentPid,parentBootId:parent.bootId,parentStartTicks:parent.startTicks,parentExecutablePath:parent.executablePath,
    parentArgvDigest:sha256(JSON.stringify(parentArgv)),helperDigest,ownArgvDigest:sha256(JSON.stringify(process.argv))}));
  return db.transaction(()=>{
    const intent=db.query('SELECT * FROM codex_mutation_intents WHERE intent_id=?').get(input.intentId) as any;
    if(!intent||intent.method!==CODEX_MANAGED_HOOK_CONFIG_METHOD||intent.thread_id!=='*'||intent.state!=='forwarding')
      throw new Error('Managed hook installer has no matching issued global config intent.');
    const prior=db.query('SELECT * FROM codex_managed_hook_install_processes WHERE intent_id=?').get(input.intentId) as any;
    if(prior){
      if(prior.pid!==pid||prior.boot_id!==own.bootId||prior.start_ticks!==own.startTicks||prior.executable_path!==own.executablePath||
        prior.parent_pid!==parentPid||prior.parent_boot_id!==parent.bootId||prior.parent_start_ticks!==parent.startTicks||
        prior.helper_digest!==helperDigest||prior.lineage_digest!==lineageDigest)
        throw new Error('Managed hook installer process registration conflicts with retained identity.');
      return {registered:prior.state==='active',duplicate:true,state:prior.state,pid,bootId:own.bootId,startTicks:own.startTicks};
    }
    db.query(`INSERT INTO codex_managed_hook_install_processes
      (intent_id,pid,boot_id,start_ticks,executable_path,parent_pid,parent_boot_id,parent_start_ticks,helper_digest,lineage_digest,state,registered_at_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,'active',?)`).run(input.intentId,pid,own.bootId,own.startTicks,own.executablePath,
        parentPid,parent.bootId,parent.startTicks,helperDigest,lineageDigest,input.nowMs);
    return {registered:true,duplicate:false,state:'active' as const,pid,bootId:own.bootId,startTicks:own.startTicks};
  }).immediate();
}

export function assessManagedHookInstallerCoverage(input:{db:Database;processes?:HookInstallerProcessSource}){
  const source=input.processes??defaultProcessSource;
  const blockers:Array<{code:'UNMANAGED_HOOK_CONFIG_INSTALLER'|'HOOK_INSTALL_PROCESS_SCOPE_UNKNOWN';pid?:number;detail:string}> = [];
  const installers:Array<{pid:number;bootId:string;startTicks:string;registered:boolean;intentId:string|null}> = [];
  let pids:number[];
  try{pids=source.listPids();}catch{return {covered:false,blockers:[{code:'HOOK_INSTALL_PROCESS_SCOPE_UNKNOWN' as const,detail:'Could not enumerate local installer processes.'}],installers};}
  for(const pid of pids){
    let argv:string[]|null;
    try{argv=source.commandLine(pid);}catch{blockers.push({code:'HOOK_INSTALL_PROCESS_SCOPE_UNKNOWN',pid,detail:'Could not inspect candidate installer argv.'});continue;}
    if(!argv){
      try{const identity=source.identity(pid);if(identity&&['bash','sh','bun'].includes(basename(identity.executablePath.replace(/ \(deleted\)$/,''))))
        blockers.push({code:'HOOK_INSTALL_PROCESS_SCOPE_UNKNOWN',pid,detail:'Shell or Bun process arguments are unreadable; installer scope is unknown.'});}
      catch{blockers.push({code:'HOOK_INSTALL_PROCESS_SCOPE_UNKNOWN',pid,detail:'Unreadable process may own a managed installer.'});}
      continue;
    }
    if(!isSupportedHookInstaller(argv))continue;
    let identity;
    try{identity=source.identity(pid);}catch{identity=null;}
    if(!identity||identity.pid!==pid){blockers.push({code:'HOOK_INSTALL_PROCESS_SCOPE_UNKNOWN',pid,detail:'Candidate installer identity is unreadable.'});continue;}
    let row=input.db.query(`SELECT p.intent_id,p.state,i.state AS intent_state,i.method,i.thread_id
      FROM codex_managed_hook_install_processes p JOIN codex_mutation_intents i ON i.intent_id=p.intent_id
      WHERE p.pid=? AND p.boot_id=? AND p.start_ticks=? AND p.executable_path=?`).get(pid,identity.bootId,identity.startTicks,identity.executablePath) as any;
    if(!row&&argv.some(value=>/(?:^|\/)install-codex-stop-hook-body\.sh$/.test(value))){
      const parentPid=source.parentPid(pid),parent=parentPid?source.identity(parentPid):null;
      if(parent&&parentPid){
        row=input.db.query(`SELECT p.intent_id,p.state,i.state AS intent_state,i.method,i.thread_id
          FROM codex_managed_hook_install_processes p JOIN codex_mutation_intents i ON i.intent_id=p.intent_id
          WHERE p.pid=? AND p.boot_id=? AND p.start_ticks=? AND p.executable_path=? AND p.state='active'`)
          .get(parentPid,parent.bootId,parent.startTicks,parent.executablePath) as any;
      }
    }
    const bodyProcess=argv.some(value=>/(?:^|\/)install-codex-stop-hook-body\.sh$/.test(value));
    if(!row||row.method!==CODEX_MANAGED_HOOK_CONFIG_METHOD||row.thread_id!=='*'||row.state!=='active'||
      bodyProcess&&!['forwarding','response_received','ambiguous'].includes(row.intent_state)){
      blockers.push({code:'UNMANAGED_HOOK_CONFIG_INSTALLER',pid,detail:'Supported hook installer process lacks an exact active managed registration.'});
      installers.push({pid,bootId:identity.bootId,startTicks:identity.startTicks,registered:false,intentId:null});continue;
    }
    installers.push({pid,bootId:identity.bootId,startTicks:identity.startTicks,registered:true,intentId:row.intent_id});
  }
  return {covered:blockers.length===0,blockers,installers};
}
