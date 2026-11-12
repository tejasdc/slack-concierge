#!/usr/bin/env bun
import {spawn} from 'node:child_process';
import {appendFileSync,existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {escalationReason} from '../src/model-escalation';

const args=process.argv.slice(2);
let model:string|null=null;
for(let index=0;index<args.length;index++){
  const arg=args[index]!;
  if(arg==='-m'||arg==='--model')model=args[index+1]??null;
  else if(arg.startsWith('--model='))model=arg.slice('--model='.length);
  else if(arg==='-c'||arg==='--config'){
    const value=args[index+1]??'';
    if(value.startsWith('model='))model=value.slice(6).replace(/^['"]|['"]$/g,'');
  }
}
const reason=process.env.CODEX_ESCALATION_REASON;
const humanChoice=!!reason&&/\bTejas explicitly (?:chose|requested) Astra\b/i.test(reason);
const refused=escalationReason(model,reason,humanChoice);
if(refused){console.error(refused);process.exit(64);}
const executable=process.env.CONCIERGE_CODEX_EXECUTABLE||join(homedir(),'.codex/packages/standalone/current/bin/codex');
if(!existsSync(executable)){console.error('The Codex command line is unavailable.');process.exit(127);}
if(model==='gpt-6-astra'){
  const state=process.env.CONCIERGE_STATE_DIR;
  if(!state){console.error('Astra starts need Concierge escalation recording. Choose gpt-6.1-sol.');process.exit(64);}
  const attemptId=randomUUID();
  process.env.CODEX_ESCALATION_ATTEMPT_ID=attemptId;
  try{appendFileSync(join(state,'model-escalations.jsonl'),JSON.stringify({at:new Date().toISOString(),model,reason,source:'codex-command-line',attemptId})+'\n',{mode:0o600});}
  catch{console.error('Astra escalation recording failed. Choose gpt-6.1-sol.');process.exit(64);}
}
const child=spawn(executable,args,{stdio:'inherit',env:process.env});
child.on('error',error=>{console.error(error.message);process.exitCode=127;});
child.on('exit',(code,signal)=>{if(signal)process.kill(process.pid,signal);else process.exitCode=code??1;});
