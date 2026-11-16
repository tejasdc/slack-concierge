import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {readdir,stat,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {deleteSession,forkSession,getSessionMessages} from '@anthropic-ai/claude-agent-sdk';
import {CodexAppServerClient} from './codex-app-server-client';
import {claudeConfigDir,locateClaudeTranscript} from './claude-transcript-watch';

type Provider='claude-code'|'codex';
type Copy={provider:Provider;source:string;boundary:string;fork:string;retiring?:string[]};
const UUID=/^[0-9a-f-]{36}$/i;

function manifest(home:string,source:string){
  const directory=join(home,'concierge-side-copies');
  mkdirSync(directory,{recursive:true,mode:0o700});
  return join(directory,`${createHash('sha256').update(source).digest('hex')}.json`);
}
function readCopy(path:string):Copy|null{
  try{
    const value=JSON.parse(readFileSync(path,'utf8'));
    return (value.provider==='claude-code'||value.provider==='codex')&&UUID.test(value.source)
      &&typeof value.boundary==='string'&&UUID.test(value.fork)
      &&(value.retiring===undefined||Array.isArray(value.retiring)&&value.retiring.every((id:unknown)=>typeof id==='string'&&UUID.test(id)))?value:null;
  }catch{return null;}
}
function saveCopy(path:string,value:Copy){
  const temporary=`${path}.${process.pid}.tmp`;
  writeFileSync(temporary,JSON.stringify(value),{mode:0o600});
  renameSync(temporary,path);
}
async function codexRollout(home:string,fork:string):Promise<string|null>{
  for(const root of ['sessions','archived_sessions']){
    const base=join(home,root);
    const years=await readdir(base).catch(()=>[]);
    for(const year of years){
      const yearPath=join(base,year);
      if(root==='archived_sessions'){
        if(year.includes(fork))return yearPath;
        continue;
      }
      for(const month of await readdir(yearPath).catch(()=>[]))
        for(const day of await readdir(join(yearPath,month)).catch(()=>[]))
          for(const name of await readdir(join(yearPath,month,day)).catch(()=>[]))
            if(name.endsWith(`${fork}.jsonl`))return join(yearPath,month,day,name);
    }
  }
  return null;
}
async function discard(copy:Copy,home:string,cwd:string){
  if(copy.provider==='claude-code'){
    await deleteSession(copy.fork,{dir:cwd}).catch(async()=>{
      const file=await locateClaudeTranscript(claudeConfigDir(),copy.fork);
      if(file)await unlink(file).catch(()=>{});
    });
    return;
  }
  const existing=await codexRollout(home,copy.fork);
  if(!existing)return;
  if(!existing.includes('/archived_sessions/')){
    const client=new CodexAppServerClient();
    try{await client.request('thread/archive',{threadId:copy.fork},{requestTimeoutMs:20_000});}
    finally{await client.close().catch(()=>{});}
  }
  const file=await codexRollout(home,copy.fork);
  if(file&&existsSync(file)&&(await stat(file)).isFile())await unlink(file);
}
async function finishRetiring(path:string,copy:Copy,home:string,cwd:string){
  for(const fork of copy.retiring??[]){
    await discard({...copy,fork,retiring:undefined},home,cwd);
    copy.retiring=copy.retiring?.filter(id=>id!==fork);
    saveCopy(path,copy);
  }
}

export async function latestClaudeBoundary(source:string,cwd:string):Promise<string>{
  const rows=await getSessionMessages(source,{dir:cwd}) as Array<{type?:string;uuid?:string;message?:{stop_reason?:unknown}}>;
  for(let index=rows.length-1;index>=0;index--){
    const row=rows[index]!;
    if(row.type==='assistant'&&row.message?.stop_reason==='end_turn'&&row.uuid)return row.uuid;
  }
  throw new Error('This conversation has no completed final answer yet.');
}

/** Keep exactly one native copy at the latest completed final response in the provider home. */
export async function sideCopy(input:{provider:Provider;source:string;boundary:string;cwd:string;home:string}):Promise<string>{
  const path=manifest(input.home,input.source);
  const prior=readCopy(path);
  if(prior&&prior.provider===input.provider&&prior.source===input.source&&prior.boundary===input.boundary){
    const file=prior.provider==='claude-code'
      ?await locateClaudeTranscript(input.home,prior.fork):await codexRollout(input.home,prior.fork);
    if(file){await finishRetiring(path,prior,input.home,input.cwd);return prior.fork;}
  }
  let fork:string;
  if(input.provider==='claude-code'){
    fork=(await forkSession(input.source,{dir:input.cwd,upToMessageId:input.boundary,title:'Side question copy'})).sessionId;
  }else{
    const client=new CodexAppServerClient();
    try{
      const result=await client.request('thread/fork',{
        threadId:input.source,cwd:input.cwd,runtimeWorkspaceRoots:[input.cwd],approvalPolicy:'never',
        sandbox:'danger-full-access',deferGoalContinuation:true,excludeTurns:true,lastTurnId:input.boundary,
        threadSource:`concierge-side-question:${input.source}`,
      },{untilDisconnect:true});
      fork=result?.thread?.id;
    }finally{await client.close().catch(()=>{});}
    if(!UUID.test(fork!)||fork===input.source)throw new Error('Codex did not return a distinct side question copy.');
  }
  const copy:Copy={provider:input.provider,source:input.source,boundary:input.boundary,fork,
    retiring:[...(prior?.retiring??[]),...(prior&&prior.fork!==fork?[prior.fork]:[])]};
  saveCopy(path,copy);
  await finishRetiring(path,copy,input.home,input.cwd);
  return fork;
}
