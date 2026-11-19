#!/usr/bin/env bun
import {agentJson} from "../src/agent-local-time";
import {basename} from 'node:path';
import {readFileSync} from 'node:fs';
import {requestApiResponse} from './router-request-client';

const usage='router-actions.sh report --source-input <id> --source-run <id> --action-id <stable id> --title "<issue>" [--certain "<why it is certainly his work>"] [--file <path> ...] [--text-file <path> | -- <observation, expected behavior, impact>]';
function invalid(message:string):never {console.error(`${message}\n${usage}`);process.exit(2);}
const args=process.argv.slice(2),separator=args.indexOf('--');
if(args.length===1&&args[0]==='--help'){
  console.log(`${usage}\nReports an issue or work you noticed outside your task. Without --certain it is a proposal: it waits in his thnkr.ing To-dos for Accept or Dismiss, nothing is dispatched until he accepts, and its receipt lists your earlier proposals he decided (learn from them). At most 3 of your proposals may wait at once. With --certain "<why>" (only when you are sure it is his: his own system, his own words, his explicit standing instruction) the receipt names its Inbox thread and open request. Read how agents' proposals fare with: router-actions.sh reports proposals [days]. Retry an uncertain submission with the same action ID and unchanged text/files. Exit 0: retained; 1: refused or unconfirmed; 2: invalid command.`);
  process.exit(0);
}
const options=separator<0?args:args.slice(0,separator),words=separator<0?[]:args.slice(separator+1);
const flags=new Map<string,string>(),paths:string[]=[];
for(let i=0;i<options.length;i+=2){
  const flag=options[i],value=options[i+1];
  if(!flag?.startsWith('--')||!value)invalid(`Invalid option ${flag??''}.`);
  if(flag==='--file')paths.push(value);
  else if(['--source-input','--source-run','--action-id','--title','--text-file','--certain'].includes(flag)&&!flags.has(flag))flags.set(flag,value);
  else invalid(`Invalid or repeated option ${flag}.`);
}
const sourceInput=flags.get('--source-input'),sourceRun=flags.get('--source-run');
const actionId=flags.get('--action-id'),title=flags.get('--title')?.trim();
if(!sourceInput||!sourceRun||!actionId||!title||title.length>200)invalid('Source input, run, stable action ID and a title of at most 200 characters are required.');
if(flags.has('--text-file')&&separator>=0)invalid('Choose --text-file or text after --.');
const message=flags.has('--text-file')?readFileSync(flags.get('--text-file')!,'utf8'):words.join(' ');
if(!message.trim())invalid('Describe what happened, what was expected, and why it is concerning.');
const files=paths.map(path=>({name:basename(path),contentType:Bun.file(path).type||'application/octet-stream',base64:readFileSync(path).toString('base64')}));
const response=await requestApiResponse('/sessions/v1/agent-report',{source:{inputId:sourceInput,runId:sourceRun},
  actionId,title,text:message,files,...(flags.has('--certain')?{certain:flags.get('--certain')}:{})});
if(response.ok)console.log(agentJson(response.result));
else {console.error(agentJson(response.result));process.exitCode=1;}
