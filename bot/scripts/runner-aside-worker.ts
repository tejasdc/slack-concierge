#!/usr/bin/env bun
/** One private side question on the runner that holds the provider transcript. */
import {spawn} from 'node:child_process';
import {constants,copyFileSync,mkdirSync,mkdtempSync,readFileSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {claudeConfigDir,locateClaudeTranscript} from '../src/claude-transcript-watch';
import {latestClaudeBoundary,sideCopy} from '../src/aside-copy';
import {MANAGED_CODEX} from '../src/codex-daemon-file-limit';
import {samePhysicalFile} from '../src/runner-asides';
import {CODEX_INVESTIGATOR_MODEL} from '../src/aliases';

type Input={provider:'claude-code'|'codex';sessionUuid:string;cwd:string;model:string|null;boundary:string|null;prompt:string};
const TIMEOUT_MS=180_000;
let activeChild:ReturnType<typeof spawn>|null=null;
process.on('SIGTERM',()=>{activeChild?.kill('SIGTERM');setTimeout(()=>activeChild?.kill('SIGKILL'),5_000).unref();process.exitCode=143;});
function run(command:string,args:string[],cwd:string,environment:NodeJS.ProcessEnv=process.env):Promise<{code:number|null;stdout:string;stderr:string}>{
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,env:environment,stdio:['ignore','pipe','pipe']});
    activeChild=child;
    let stdout='',stderr='';
    const timeout=setTimeout(()=>{child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),5000).unref();
      reject(new Error('The side question timed out.'));},TIMEOUT_MS);
    child.stdout.setEncoding('utf8').on('data',(chunk:string)=>{stdout+=chunk;});
    child.stderr.setEncoding('utf8').on('data',(chunk:string)=>{stderr=(stderr+chunk).slice(-4000);});
    child.on('error',error=>{clearTimeout(timeout);if(activeChild===child)activeChild=null;reject(error);});
    child.on('close',code=>{clearTimeout(timeout);if(activeChild===child)activeChild=null;resolve({code,stdout,stderr});});
  });
}
async function answer(input:Input){
  const started=Date.now();
  if(input.provider==='claude-code'){
    const boundary=await latestClaudeBoundary(input.sessionUuid,input.cwd);
    const fork=await sideCopy({provider:'claude-code',source:input.sessionUuid,boundary,
      cwd:input.cwd,home:claudeConfigDir()});
    const source=await locateClaudeTranscript(claudeConfigDir(),fork);
    if(typeof source!=='string')throw new Error('The side question copy was not found in its source account.');
    const spendHome=process.env.CONCIERGE_ASIDE_SPEND_HOME||claudeConfigDir();
    let copied:string|null=null;
    try{
      if(spendHome!==claudeConfigDir()){
        const slug=input.cwd.replace(/[\\/.]/g,'-'),directory=join(spendHome,'projects',slug);
        mkdirSync(directory,{recursive:true,mode:0o700});copied=join(directory,`${fork}.jsonl`);
        if(!samePhysicalFile(source,copied))copyFileSync(source,copied,constants.COPYFILE_EXCL);
      }
      const args=['-p','--resume',fork,'--no-session-persistence',
        '--tools','','--strict-mcp-config','--output-format','json',...(input.model?['--model',input.model]:[]),input.prompt];
      const result=await run(process.env.CONCIERGE_CLAUDE_CODE_EXECUTABLE||'claude',args,input.cwd,
        {...process.env,CLAUDE_CONFIG_DIR:spendHome});
      let parsed:any=null;
      try{const json=JSON.parse(result.stdout.slice(result.stdout.search(/[\[{]/)));
        parsed=Array.isArray(json)?json.findLast((event:any)=>event?.type==='result')??null:json;}catch{}
      if(!parsed||parsed.is_error||typeof parsed.result!=='string')throw new Error('Claude could not answer the side question.');
      return {answer:parsed.result.trim(),model:Object.keys(parsed.modelUsage??{})[0]??input.model,durationMs:Date.now()-started};
    }finally{if(copied)await unlink(copied).catch(()=>{});}
  }
  if(!input.boundary)throw new Error('This conversation has no completed final answer yet.');
  const fork=await sideCopy({provider:'codex',source:input.sessionUuid,boundary:input.boundary,
    cwd:input.cwd,home:process.env.CODEX_HOME||join(process.env.HOME||'', '.codex')});
  const directory=mkdtempSync(join(tmpdir(),'concierge-aside-')),out=join(directory,'answer.txt');
  try{
    const result=await run(MANAGED_CODEX,['exec','--ephemeral','-s','read-only','--skip-git-repo-check','-o',out,
      '-m',input.model??CODEX_INVESTIGATOR_MODEL,
      'fork',fork,input.prompt],input.cwd);
    let text='';try{text=readFileSync(out,'utf8').trim();}catch{}
    if(!text)throw new Error(`Codex could not answer the side question (${result.code??'unknown'}).`);
    return {answer:text,model:input.model??CODEX_INVESTIGATOR_MODEL,durationMs:Date.now()-started};
  }finally{await rm(directory,{recursive:true,force:true});}
}
try{
  const input=JSON.parse(await Bun.stdin.text()) as Input;
  if(!input||!['claude-code','codex'].includes(input.provider)||typeof input.sessionUuid!=='string'
    ||typeof input.cwd!=='string'||!input.cwd.startsWith('/')||typeof input.prompt!=='string'
    ||input.prompt.length>100_000)throw new Error('Invalid side question.');
  process.stdout.write(JSON.stringify(await answer(input)));
}catch(error){process.stderr.write(String(error instanceof Error?error.message:error));process.exitCode=1;}
