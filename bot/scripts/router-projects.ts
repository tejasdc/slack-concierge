#!/usr/bin/env bun
import {requestApiResponse} from './router-request-client';

const usage=`router-actions.sh projects new <name> --purpose "<one sentence>" --consultation <completed organizer request id> --source-input <id> --source-run <id> [--template brainstorm|writing|design] [--here-only]
router-actions.sh projects share <name> --to <machine> [--source-input <id> --source-run <id>]
router-actions.sh projects status <name> [--to <machine>]
router-actions.sh projects cancel <name> --to <machine>`;

async function main(args:string[]){
  if(args.length===1&&['help','--help'].includes(args[0]!)){console.log(usage);return;}
  const [verb,project,...rest]=args;
  if(!verb||!['new','share','status','cancel'].includes(verb)||!project||project.startsWith('--'))throw new Error(usage);
  const flags=new Map<string,string>();
  for(let i=0;i<rest.length;i++){
    const flag=rest[i]!;
    if(flag==='--here-only'){if(flags.has(flag))throw new Error('Repeated --here-only.');flags.set(flag,'true');continue;}
    if(!['--purpose','--consultation','--template','--to','--source-input','--source-run'].includes(flag)||flags.has(flag)||i+1>=rest.length||rest[i+1]!.startsWith('--'))throw new Error(`Invalid project option: ${flag}.\n${usage}`);
    flags.set(flag,rest[++i]!);
  }
  if(!!flags.get('--source-input')!==!!flags.get('--source-run'))throw new Error('Pass both source input and source run, or neither.');
  if(verb==='status'&&(flags.has('--purpose')||flags.has('--here-only')||flags.has('--source-input')))throw new Error(usage);
  if(verb==='new'&&(!flags.get('--purpose')||!flags.get('--consultation')||!sourceFlagsPresent(flags)||flags.has('--to')))throw new Error(usage);
  if(verb!=='new'&&(flags.has('--consultation')||flags.has('--template')))throw new Error(usage);
  if(verb==='share'&&(!flags.get('--to')||flags.has('--purpose')||flags.has('--here-only')))throw new Error(usage);
  if(verb==='cancel'&&(!flags.get('--to')||flags.has('--purpose')||flags.has('--here-only')||flags.has('--source-input')))throw new Error(usage);
  const source=flags.has('--source-input')?{input:flags.get('--source-input'),run:flags.get('--source-run')}:undefined;
  const path=verb==='status'?`/sessions/v1/projects/${encodeURIComponent(project)}/status${flags.get('--to')?`?peer=${encodeURIComponent(flags.get('--to')!)}`:''}`:`/sessions/v1/projects/${verb}`;
  const body=verb==='new'?{name:project,consultation:flags.get('--consultation'),purpose:flags.get('--purpose'),...(flags.has('--template')?{template:flags.get('--template')}:{}),hereOnly:flags.has('--here-only'),...(source?{source}:{})}:verb==='share'?{name:project,to:flags.get('--to'),...(source?{source}:{})}:verb==='cancel'?{name:project,to:flags.get('--to')}:undefined;
  const answer=await requestApiResponse(path,body);
  console.log(JSON.stringify(answer.result));
  if(!answer.ok)process.exitCode=1;
}
function sourceFlagsPresent(flags:Map<string,string>){return !!flags.get('--source-input')&&!!flags.get('--source-run');}
try{await main(process.argv.slice(2));}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=2;}
