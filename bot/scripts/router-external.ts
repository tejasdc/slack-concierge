#!/usr/bin/env bun
import {randomUUID} from 'node:crypto';
import {basename} from 'node:path';
import {readFileSync} from 'node:fs';
import {requestApiResponse} from './router-request-client';

const usage='router-actions.sh external <name> capture [--id <stable-id>] [--file <path> ...] -- <text>\nrouter-actions.sh external <name> ask <session-address> --action-id <id> [--requested-effect work|informational] [--text-file <path> | -- <text>]\nrouter-actions.sh external <name> get <request-id>\nrouter-actions.sh external <name> withdraw <request-id> --ask-action-id <original-ask-id> --action-id <stable-withdraw-id>';
function invalid(reason:string):never {console.error(`${reason}\n${usage}`);process.exit(2);}
const [name,verb,...rest]=process.argv.slice(2);
if(!/^[a-z][a-z0-9-]{2,40}$/.test(name??''))invalid('Name an outside agent with 3–41 lower-case letters, digits or hyphens.');
if(!['capture','ask','get','withdraw'].includes(verb??''))invalid('Choose capture, ask, get or withdraw.');
const separator=rest.indexOf('--'),tokens=separator<0?rest:rest.slice(0,separator);
const trailing=separator<0?[]:rest.slice(separator+1);
let target:string|undefined;
if(verb!=='capture')target=tokens.shift();
if(verb!=='capture'&&!target)invalid('Give the exact session address or request ID.');
const flags=new Map<string,string>();const paths:string[]=[];
for(let i=0;i<tokens.length;i+=2){
  const flag=tokens[i],value=tokens[i+1];
  if(!flag?.startsWith('--')||!value)invalid(`Invalid option ${flag??''}.`);
  if(flag==='--file'&&verb==='capture')paths.push(value);
  else if(flag==='--id'&&verb==='capture'&&!flags.has(flag))flags.set(flag,value);
  else if(['--action-id','--requested-effect','--text-file'].includes(flag)&&verb==='ask'&&!flags.has(flag))flags.set(flag,value);
  else if(['--action-id','--ask-action-id'].includes(flag)&&verb==='withdraw'&&!flags.has(flag))flags.set(flag,value);
  else invalid(`Invalid option ${flag}.`);
}
if(verb==='get'&&(tokens.length||separator>=0))invalid('Get takes only a request ID.');
if(verb==='ask'&&!flags.get('--action-id'))invalid('Ask requires --action-id.');
if(verb==='withdraw'&&(!flags.get('--ask-action-id')||!flags.get('--action-id')))invalid('Withdraw requires --ask-action-id and --action-id.');
if(verb==='capture'&&flags.has('--id')&&!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(flags.get('--id')!))invalid('Capture --id must be 1–200 letters, digits, dots, underscores, colons or hyphens.');
if(verb==='ask'&&!/^session:[A-Za-z0-9_-]+$/.test(target!))invalid('Ask requires an exact discovered session address.');
if((verb==='get'||verb==='withdraw')&&!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(target!))invalid('Give the exact request ID.');
const effect=flags.get('--requested-effect')??'informational';
if(!['informational','work'].includes(effect))invalid('Invalid requested effect.');
if(flags.has('--text-file')&&separator>=0)invalid('Choose a text file or text after --.');
const message=flags.has('--text-file')?readFileSync(flags.get('--text-file')!,'utf8'):trailing.join(' ');
if((verb==='capture'||verb==='ask')&&!message.trim())invalid('Give a nonempty message.');
if(verb==='withdraw'&&separator>=0)invalid('Withdraw takes no message.');
const files=paths.map(path=>({name:basename(path),contentType:Bun.file(path).type||'application/octet-stream',base64:readFileSync(path).toString('base64')}));
const body=verb==='capture'?{name,id:flags.get('--id')??randomUUID(),recordedAt:new Date().toISOString(),text:message,files}
  :verb==='ask'?{name,address:target,action_id:flags.get('--action-id'),requestedEffect:effect,text:message}
  :verb==='withdraw'?{name,request_id:target,ask_action_id:flags.get('--ask-action-id'),action_id:flags.get('--action-id')}
  :{name,request_id:target};
try {
  const answer=await requestApiResponse(`/external/${verb}`,body);
  console.log(JSON.stringify(answer.result));
  if(!answer.ok)process.exitCode=1;
} catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
