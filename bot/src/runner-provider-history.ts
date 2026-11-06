import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {link,mkdir,open,readFile,readdir,realpath,stat,unlink,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {dirname} from 'node:path';
import {codexTranscriptTimestamps} from './provider-transcript-metadata';
import {sharedCodexAppServerClient} from './codex-app-server-client';
import {jsonLines} from './json-lines';

const MAX_TRANSCRIPT_CHUNK=256*1024;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Provider='claude-code'|'codex';
type HomeResolver=(provider:Provider,account:string)=>string|null;
type HomeListResolver=(provider:Provider)=>{account:string;home:string}[];
type RestoreRecord={provider:Provider;account:string;nativeId:string;destination:string;staging:string;size:number;sha256:string;state:'writing'|'restored'|'already_present'};

function uuid(value:unknown):string {
  if(typeof value!=='string'||!UUID.test(value))throw new Error('INVALID_PROVIDER_HISTORY_ID');
  return value;
}
function account(value:unknown):string {
  if(typeof value!=='string'||!value.trim()||value.length>320||/[\r\n\0]/.test(value))throw new Error('INVALID_PROVIDER_ACCOUNT');
  return value.trim();
}
function cwd(value:unknown):string {
  if(typeof value!=='string'||!value.startsWith('/')||value.length>4096)throw new Error('INVALID_PROVIDER_HISTORY_CWD');
  const normalized=resolve(value);
  if(normalized!==value.replace(/\/$/,'')&&normalized!==value)throw new Error('INVALID_PROVIDER_HISTORY_CWD');
  return normalized;
}
function provider(value:unknown):Provider {
  if(value!=='claude-code'&&value!=='codex')throw new Error('INVALID_PROVIDER_HISTORY_PROVIDER');
  return value;
}
function sourceIdentity(info:{dev:number|bigint;ino:number|bigint;birthtimeMs:number;ctimeMs:number;mtimeMs:number}):string {
  return createHash('sha256').update(JSON.stringify([String(info.dev),String(info.ino),info.birthtimeMs,info.ctimeMs,info.mtimeMs])).digest('hex');
}
function restoreId(value:unknown):string{
  if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))throw new Error('INVALID_PROVIDER_RESTORE_ID');
  return value;
}
async function restoreRecord(stateDir:string,id:string):Promise<RestoreRecord>{
  try{return JSON.parse(await Bun.file(join(stateDir,'provider-history-restores',`${id}.json`)).text()) as RestoreRecord;}
  catch{throw new Error('PROVIDER_RESTORE_NOT_FOUND');}
}
function sameRestore(record:RestoreRecord,input:{provider:Provider;account:string;nativeId:string;destination:string;size:number;sha256:string}):boolean{
  return record.provider===input.provider&&record.account===input.account&&record.nativeId===input.nativeId
    &&record.destination===input.destination&&record.size===input.size&&record.sha256===input.sha256;
}
async function saveRestoreRecord(stateDir:string,id:string,record:RestoreRecord){
  const path=join(stateDir,'provider-history-restores',`${id}.json`),temporary=`${path}.${process.pid}.tmp`;
  await writeFile(temporary,JSON.stringify(record),{mode:0o600});
  const handle=await open(temporary,'r');try{await handle.sync();}finally{await handle.close();}
  const {rename}=await import('node:fs/promises');await rename(temporary,path);
  const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}
}

async function claudeTranscript(home:string,sessionUuid:string,project:string):Promise<string|null> {
  const projects=join(home,'projects');
  const expected=join(projects,project.replace(/[^a-zA-Z0-9]/g,'-'),`${sessionUuid}.jsonl`);
  const matches:string[]=[];
  try { if((await stat(expected)).isFile())matches.push(expected); } catch {}
  if(!matches.length){
    let directories:string[]=[];
    try{directories=await readdir(projects);}catch{return null;}
    for(const directory of directories){
      const candidate=join(projects,directory,`${sessionUuid}.jsonl`);
      try{if((await stat(candidate)).isFile())matches.push(candidate);}catch{}
    }
  }
  if(matches.length>1)throw new Error('AMBIGUOUS_PROVIDER_TRANSCRIPT');
  return matches[0]??null;
}

async function exactTranscriptInHome(kind:Provider,home:string,nativeId:string):Promise<string[]> {
  if(kind==='claude-code'){
    let projects:string[]=[];try{projects=await readdir(join(home,'projects'));}catch{return [];}
    const found:string[]=[];
    for(const project of projects){const path=join(home,'projects',project,`${nativeId}.jsonl`);try{if((await stat(path)).isFile())found.push(path);}catch{}}
    return found;
  }
  const root=join(home,'sessions'),found:string[]=[];
  let years:string[]=[];try{years=await readdir(root);}catch{return [];}
  for(const year of years){
    let months:string[]=[];try{months=await readdir(join(root,year));}catch{continue;}
    for(const month of months){
      let days:string[]=[];try{days=await readdir(join(root,year,month));}catch{continue;}
      for(const day of days){
        const folder=join(root,year,month,day);let names:string[]=[];try{names=await readdir(folder);}catch{continue;}
        for(const name of names)if(name.endsWith(`-${nativeId}.jsonl`))found.push(join(folder,name));
      }
    }
  }
  return found;
}

async function authoredTimestamp(path:string,kind:Provider,threadId:string,subject:string,beforeMs:number):Promise<string|null>{
  const needle=subject.split(/["\\]/).sort((a,b)=>b.length-a.length)[0]??'';
  if(needle.length<12)return null;
  const search=JSON.stringify(subject).slice(1,-1);
  const lines=jsonLines(createReadStream(path,{encoding:'utf8'}));
  let best:number|null=null;
  for await(const line of lines){
    if(line.length>32*1024*1024||!line.includes(needle))continue;
    let row:any;try{row=JSON.parse(line);}catch{continue;}
    const own=kind==='claude-code'?row.type==='assistant'
      :row.type==='response_item'&&['function_call','custom_tool_call','local_shell_call'].includes(row.payload?.type);
    const at=Date.parse(row.timestamp);
    if(!own||!Number.isFinite(at)||at>beforeMs||!JSON.stringify(row.message??row.payload).includes(search))continue;
    if(best===null||at>best)best=at;
  }
  return best===null?null:new Date(best).toISOString();
}

/** Exact provider-home operations used over the runner machine relay; no filesystem path leaves this process. */
export async function serveProviderHistoryCall(method:string,params:any,resolveHome:HomeResolver,stateDir=process.env.CONCIERGE_RUNNER_STATE||join(homedir(),'.local/state/concierge-runner/state'),resolveHomes?:HomeListResolver):Promise<unknown>{
  if(method==='provider-history.claude.transcript.stat'){
    const accountLabel=account(params.account),sessionUuid=uuid(params.sessionUuid),project=cwd(params.cwd);
    const home=resolveHome('claude-code',accountLabel);
    if(!home)throw new Error('PROVIDER_ACCOUNT_HOME_UNAVAILABLE');
    const path=await claudeTranscript(home,sessionUuid,project);
    if(!path)return {sourceIdentity:null,size:null,mtimeMs:null};
    const info=await stat(path);
    return {sourceIdentity:sourceIdentity(info),size:info.size,mtimeMs:info.mtimeMs};
  }
  if(method==='provider-history.claude.transcript.read'){
    const accountLabel=account(params.account),sessionUuid=uuid(params.sessionUuid),project=cwd(params.cwd);
    const offset=params.offset,limit=params.maxBytes;
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>MAX_TRANSCRIPT_CHUNK)
      throw new Error('INVALID_PROVIDER_TRANSCRIPT_RANGE');
    const home=resolveHome('claude-code',accountLabel);
    if(!home)throw new Error('PROVIDER_ACCOUNT_HOME_UNAVAILABLE');
    const path=await claudeTranscript(home,sessionUuid,project);
    if(!path) return {sourceIdentity:null,snapshotSize:null,bytes:'',eof:true};
    const handle=await open(path,'r');
    try{
      const before=await handle.stat();
      const identity=sourceIdentity(before);
      const expected=params.sourceIdentity;
      if(expected!==undefined&&expected!==identity)throw new Error('PROVIDER_TRANSCRIPT_CHANGED');
      const snapshotSize=params.snapshotSize===undefined?before.size:params.snapshotSize;
      if(!Number.isSafeInteger(snapshotSize)||snapshotSize<0||before.size<snapshotSize||offset>snapshotSize)
        throw new Error('PROVIDER_TRANSCRIPT_CHANGED');
      const size=Math.min(limit,snapshotSize-offset),buffer=Buffer.alloc(size);
      if(size)await handle.read(buffer,0,size,offset);
      if(sourceIdentity(await handle.stat())!==identity)throw new Error('PROVIDER_TRANSCRIPT_CHANGED');
      return {sourceIdentity:identity,snapshotSize,bytes:buffer.toString('base64'),eof:offset+size>=snapshotSize};
    }finally{await handle.close();}
  }
  if(method==='provider-history.codex.timestamps'){
    const accountLabel=account(params.account),threadId=uuid(params.threadId);
    const identities=params.identities;
    if(!Array.isArray(identities)||identities.length>2_000||identities.some((value:any)=>!value||typeof value.turnId!=='string'||value.turnId.length>512||typeof value.itemId!=='string'||value.itemId.length>512))throw new Error('INVALID_PROVIDER_HISTORY_IDENTITIES');
    const home=resolveHome('codex',accountLabel);
    if(!home)throw new Error('PROVIDER_ACCOUNT_HOME_UNAVAILABLE');
    const request=(name:string,args:Record<string,unknown>)=>sharedCodexAppServerClient().request(name,args);
    const timestamps=await codexTranscriptTimestamps(threadId,request,home);
    return {threadId,timestamps:identities.flatMap(({turnId,itemId}:any)=>{
      const key=JSON.stringify([turnId,itemId]);
      return timestamps.has(key)?[{identity:[turnId,itemId],timestamp:timestamps.get(key)}]:[];
    })};
  }
  if(method==='provider-history.authoredSubject'){
    const kind=provider(params.provider),nativeId=uuid(params.sessionUuid),subject=params.subject,beforeMs=params.beforeMs;
    if(typeof subject!=='string'||!subject.trim()||subject.length>20_000||!Number.isSafeInteger(beforeMs)||beforeMs<0)throw new Error('INVALID_AUTHORED_SUBJECT_REQUEST');
    let homes:{account:string;home:string}[];
    if(params.account===null){homes=resolveHomes?.(kind)??[];}
    else {const label=account(params.account),home=resolveHome(kind,label);homes=home?[{account:label,home}]:[];}
    const found=(await Promise.all(homes.map(async entry=>({account:entry.account,paths:await exactTranscriptInHome(kind,entry.home,nativeId)}))))
      .flatMap(entry=>entry.paths.map(path=>({account:entry.account,path})));
    if(params.account===null){
      const physical=new Map<string,{account:string;path:string}>();
      for(const entry of found){let key=entry.path;try{key=await realpath(entry.path);}catch{}
        // This endpoint only returns content-derived attribution. Shared account symlinks
        // to the same physical transcript are one file here; account resolution remains
        // ambiguous in accounts.transcript and exact-history endpoints stay account-scoped.
        if(!physical.has(key))physical.set(key,entry);
      }
      found.splice(0,found.length,...physical.values());
    }
    if(found.length!==1)return {timestamp:null,resolution:found.length?'ambiguous':'missing'};
    return {timestamp:await authoredTimestamp(found[0]!.path,kind,nativeId,subject,beforeMs),resolution:params.account===null?'unique':'named'};
  }
  if(method==='provider-history.restore.begin'){
    const id=restoreId(params.restoreId),kind=provider(params.provider),accountLabel=account(params.account),nativeId=uuid(params.nativeId);
    const size=params.size,sha256=params.sha256;
    if(!Number.isSafeInteger(size)||size<1||size>64*1024*1024||typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256))throw new Error('INVALID_PROVIDER_RESTORE');
    const project=cwd(params.cwd),name=params.name;
    if(typeof name!=='string'||name.length>240||name.includes('/')||name.includes('\\'))throw new Error('INVALID_PROVIDER_RESTORE');
    const home=resolveHome(kind,accountLabel);
    if(!home)throw new Error('PROVIDER_ACCOUNT_HOME_UNAVAILABLE');
    let destination:string;
    if(kind==='claude-code'){
      if(name!==`${nativeId}.jsonl`)throw new Error('INVALID_PROVIDER_RESTORE_NAME');
      destination=join(home,'projects',project.replace(/[^a-zA-Z0-9]/g,'-'),name);
    }else{
      const dated=name.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T[^/]*\.jsonl$/);
      if(!dated||!name.includes(nativeId))throw new Error('INVALID_PROVIDER_RESTORE_NAME');
      destination=join(home,'sessions',dated[1]!,dated[2]!,dated[3]!,name);
    }
    try{
      const existing=await open(destination,'r');
      try{const info=await existing.stat();
        if(info.size!==size)throw new Error('PROVIDER_RESTORE_DESTINATION_CONFLICT');
        const existingBytes=await readFile(destination);
        if(createHash('sha256').update(existingBytes).digest('hex')!==sha256
          ||!existingBytes.subarray(0,262_144).toString('utf8').includes(nativeId))throw new Error('PROVIDER_RESTORE_DESTINATION_CONFLICT');
        return {state:'already_present'};
      }finally{await existing.close();}
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const directory=join(stateDir,'provider-history-restores');
    await mkdir(directory,{recursive:true,mode:0o700});
    const staging=join(dirname(destination),`.concierge-restore-${id}.part`),recordPath=join(directory,`${id}.json`);
    const input={provider:kind,account:accountLabel,nativeId,destination,size,sha256};
    await mkdir(dirname(destination),{recursive:true,mode:0o700});
    const record:RestoreRecord={...input,staging,state:'writing'};
    try{await writeFile(recordPath,JSON.stringify(record),{flag:'wx',mode:0o600});
      const recordFile=await open(recordPath,'r');try{await recordFile.sync();}finally{await recordFile.close();}
      const recordDirectory=await open(directory,'r');try{await recordDirectory.sync();}finally{await recordDirectory.close();}}
    catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    const prior=await restoreRecord(stateDir,id);
    if(!sameRestore(prior,input))throw new Error('PROVIDER_RESTORE_ID_CONFLICT');
    if(prior.state!=='writing')return {state:prior.state};
    await writeFile(prior.staging,new Uint8Array(),{flag:'wx',mode:0o600}).catch(error=>{
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    });
    const info=await stat(prior.staging);
    if(info.size>prior.size)throw new Error('PROVIDER_RESTORE_STATE_INVALID');
    return {state:'ready',nextOffset:0};
  }
  if(method==='provider-history.restore.chunk'){
    const id=restoreId(params.restoreId),record=await restoreRecord(stateDir,id),offset=params.offset,encoded=params.base64;
    if(!Number.isSafeInteger(offset)||offset<0||typeof encoded!=='string'||encoded.length>400_000)throw new Error('INVALID_PROVIDER_RESTORE_CHUNK');
    const bytes=Buffer.from(encoded,'base64');
    if(!bytes.length||bytes.length>MAX_TRANSCRIPT_CHUNK||bytes.toString('base64')!==encoded)throw new Error('INVALID_PROVIDER_RESTORE_CHUNK');
    const handle=await open(record.staging,'r+');
    try{
      const info=await handle.stat();
      if(offset>info.size||offset+bytes.length>record.size)throw new Error('PROVIDER_RESTORE_OFFSET_MISMATCH');
      if(offset<info.size){
        if(offset+bytes.length>info.size)throw new Error('PROVIDER_RESTORE_OFFSET_MISMATCH');
        const prior=Buffer.alloc(bytes.length);await handle.read(prior,0,prior.length,offset);
        if(!prior.equals(bytes))throw new Error('PROVIDER_RESTORE_REPLAY_CONFLICT');
        return {nextOffset:info.size};
      }
      let written=0;
      while(written<bytes.length){const result=await handle.write(bytes,written,bytes.length-written,offset+written);if(!result.bytesWritten)throw new Error('PROVIDER_RESTORE_WRITE_INCOMPLETE');written+=result.bytesWritten;}
      await handle.sync();return {nextOffset:offset+bytes.length};
    }
    finally{await handle.close();}
  }
  if(method==='provider-history.restore.finish'){
    const id=restoreId(params.restoreId),record=await restoreRecord(stateDir,id);
    if(record.state!=='writing')return {state:record.state};
    const bytes=await Bun.file(record.staging).bytes();
    if(bytes.length!==record.size||createHash('sha256').update(bytes).digest('hex')!==record.sha256
      ||!Buffer.from(bytes.subarray(0,262_144)).toString('utf8').includes(record.nativeId))throw new Error('PROVIDER_RESTORE_CONTENT_MISMATCH');
    await mkdir(dirname(record.destination),{recursive:true,mode:0o700});
    let state:'restored'|'already_present'='restored';
    try{await link(record.staging,record.destination);
      const destinationDirectory=await open(dirname(record.destination),'r');try{await destinationDirectory.sync();}finally{await destinationDirectory.close();}}
    catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;state='already_present';}
    await unlink(record.staging).catch(()=>{});
    await saveRestoreRecord(stateDir,id,{...record,state});
    return {state};
  }
  throw new Error(`unknown provider history call ${method}`);
}

export const PROVIDER_HISTORY_MAX_CHUNK=MAX_TRANSCRIPT_CHUNK;
