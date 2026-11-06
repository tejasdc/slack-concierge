#!/usr/bin/env bun
/** One private side question on the runner that holds the provider transcript. */
import {spawn} from 'node:child_process';
import {constants,copyFileSync,mkdirSync,mkdtempSync,readFileSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {forkSession,getSessionMessages} from '@anthropic-ai/claude-agent-sdk';
import {claudeConfigDir,locateClaudeTranscript} from '../src/claude-transcript-watch';
import {MANAGED_CODEX} from '../src/codex-daemon-file-limit';

type Input={provider:'claude-code'|'codex';sessionUuid:string;cwd:string;model:string|null;running:boolean;prompt:string};
const TIMEOUT_MS=180_000;
function run(command:string,args:string[],cwd:string,environment:NodeJS.ProcessEnv=process.env):Promise<{code:number|null;stdout:string;stderr:string}>{
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,env:environment,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    const timeout=setTimeout(()=>{child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),5000).unref();
      reject(new Error('The side question timed out.'));},TIMEOUT_MS);
    child.stdout.setEncoding('utf8').on('data',(chunk:string)=>{stdout+=chunk;});
    child.stderr.setEncoding('utf8').on('data',(chunk:string)=>{stderr=(stderr+chunk).slice(-4000);});
    child.on('error',error=>{clearTimeout(timeout);reject(error);});
    child.on('close',code=>{clearTimeout(timeout);resolve({code,stdout,stderr});});
  });
}
async function lastFinished(uuid:string,cwd:string):Promise<string|null>{
  const rows=await getSessionMessages(uuid,{dir:cwd}) as Array<{type?:string;uuid?:string;message?:{stop_reason?:unknown}}>;
  for(let index=rows.length-1;index>=0;index--){const row=rows[index]!;
    if(row.type==='assistant'&&row.message?.stop_reason==='end_turn'&&row.uuid)return row.uuid;}
  return null;
}
async function answer(input:Input){
  const started=Date.now();
  if(input.provider==='claude-code'){
    const boundary=input.running?await lastFinished(input.sessionUuid,input.cwd).catch(()=>null):null;
    // Always fork the source transcript. If another account has room, only this temporary copy
    // crosses between the runner's verified provider homes; the original stays with its account.
    const fork=(await forkSession(input.sessionUuid,{dir:input.cwd,...(boundary?{upToMessageId:boundary}:{}),title:'Side question copy'})).sessionId;
    const source=await locateClaudeTranscript(claudeConfigDir(),fork);
    if(!source)throw new Error('The side question copy was not found in its source account.');
    const spendHome=process.env.CONCIERGE_ASIDE_SPEND_HOME||claudeConfigDir();
    let copied:string|null=null;
    try{
      if(spendHome!==claudeConfigDir()){
        const slug=input.cwd.replace(/[\\/.]/g,'-'),directory=join(spendHome,'projects',slug);
        mkdirSync(directory,{recursive:true,mode:0o700});copied=join(directory,`${fork}.jsonl`);
        copyFileSync(source,copied,constants.COPYFILE_EXCL);
      }
      const args=['-p','--resume',fork,'--fork-session','--no-session-persistence',
        '--tools','','--strict-mcp-config','--output-format','json',...(input.model?['--model',input.model]:[]),input.prompt];
      const result=await run(process.env.CONCIERGE_CLAUDE_CODE_EXECUTABLE||'claude',args,input.cwd,
        {...process.env,CLAUDE_CONFIG_DIR:spendHome});
      let parsed:any=null;
      try{const json=JSON.parse(result.stdout.slice(result.stdout.search(/[\[{]/)));
        parsed=Array.isArray(json)?json.findLast((event:any)=>event?.type==='result')??null:json;}catch{}
      if(!parsed||parsed.is_error||typeof parsed.result!=='string')throw new Error('Claude could not answer the side question.');
      return {answer:parsed.result.trim(),model:Object.keys(parsed.modelUsage??{})[0]??input.model,durationMs:Date.now()-started};
    }finally{if(copied)await unlink(copied).catch(()=>{});await unlink(source).catch(()=>{});}
  }
  const directory=mkdtempSync(join(tmpdir(),'concierge-aside-')),out=join(directory,'answer.txt');
  try{
    const result=await run(MANAGED_CODEX,['exec','--ephemeral','-s','read-only','--skip-git-repo-check','-o',out,
      'fork',input.sessionUuid,input.prompt],input.cwd);
    let text='';try{text=readFileSync(out,'utf8').trim();}catch{}
    if(!text)throw new Error(`Codex could not answer the side question (${result.code??'unknown'}).`);
    return {answer:text,model:null,durationMs:Date.now()-started};
  }finally{await rm(directory,{recursive:true,force:true});}
}
try{
  const input=JSON.parse(await Bun.stdin.text()) as Input;
  if(!input||!['claude-code','codex'].includes(input.provider)||typeof input.sessionUuid!=='string'
    ||typeof input.cwd!=='string'||!input.cwd.startsWith('/')||typeof input.prompt!=='string'
    ||input.prompt.length>100_000)throw new Error('Invalid side question.');
  process.stdout.write(JSON.stringify(await answer(input)));
}catch(error){process.stderr.write(String(error instanceof Error?error.message:error));process.exitCode=1;}
