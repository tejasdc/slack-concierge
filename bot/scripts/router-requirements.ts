#!/usr/bin/env bun
import {readFileSync} from 'node:fs';
import {requestApiResponse,refusalText} from './router-request-client';

const usage=`router-actions.sh requirements new <name> [--project <registered-project>] [--topic <Inbox thread id> ...] <source-flags> --action-id A
router-actions.sh requirements find [<words> | --topic <Inbox thread id>] <source-flags>
router-actions.sh requirements show <record id or name> [--source <kept source id>] <source-flags>   # --source prints that kept capture whole
router-actions.sh requirements keep <record> --from <capture id or input id> [--source-at <ISO time>] <source-flags> --action-id A   # keeps the exact retained words, never a paraphrase
router-actions.sh requirements file <record> [--source <capture or input id>] (--words "<his exact words>" [--reading "<your reading>"] ... | --json-file <items.json>) <source-flags> --action-id A
router-actions.sh requirements reconcile --source <kept source id> [--note "<what you checked>"] <source-flags> --action-id A
router-actions.sh requirements judge --item <requirement id> --state delivered|not-delivered|open [--checked "<what you ran on the real system and saw>"] [--why "<what is missing>"] [--request <request id>] <source-flags> --action-id A
router-actions.sh requirements link <record> --topic <Inbox thread id> <source-flags> --action-id A
One requirement is one independently checkable outcome in his exact words; conditions and exceptions stay with their requirement; a repeated point is one item.`;

function fail(message:string):never{console.error(`${message}\n\n${usage}`);process.exit(2);}

const [verb,...rest]=process.argv.slice(2);
if(!verb||verb==='--help'||verb==='help'){console.log(usage);process.exit(verb?0:2);}

const flags=new Map<string,string>();
const topics:string[]=[];
const items:{words:string;reading?:string;source?:string}[]=[];
const positional:string[]=[];
const SINGLE=['--source-input','--source-run','--action-id','--project','--source','--source-at','--from','--note','--item','--state','--checked','--why','--request','--topic','--json-file'];
for(let i=0;i<rest.length;i++){
  const flag=rest[i]!;
  if(!flag.startsWith('--')){positional.push(flag);continue;}
  const value=rest[++i];
  if(!value?.trim()||value.startsWith('--'))fail(`${flag} requires a value.`);
  if(flag==='--words')items.push({words:value});
  else if(flag==='--reading'){const last=items.at(-1);if(!last)fail('--reading follows the --words it reads.');if(last.reading)fail('One --reading per --words.');last.reading=value;}
  else if(flag==='--topic'&&verb==='new')topics.push(value);
  else if(SINGLE.includes(flag)){if(flags.has(flag))fail(`Repeated ${flag}.`);flags.set(flag,value);}
  else fail(`Unexpected option ${flag}.`);
}
const inputId=flags.get('--source-input'),runId=flags.get('--source-run');
if(!inputId||!runId)fail("Provide this input's exact --source-input and --source-run.");
const source={input_id:inputId,run_id:runId};
const need=(value:string|undefined,what:string)=>value?value:fail(`${verb} needs ${what}.`);
const actionId=flags.get('--action-id');
const writes=['new','keep','file','reconcile','judge','link'];
if(writes.includes(verb)&&!actionId)fail(`${verb} needs --action-id.`);

let body:Record<string,unknown>={source,verb,...(actionId?{action_id:actionId}:{})};
switch(verb){
  case 'new':body={...body,name:need(positional.join(' ')||undefined,'a record name'),...(flags.has('--project')?{project:flags.get('--project')}:{}),...(topics.length?{topics}:{})};break;
  case 'find':body={...body,...(flags.has('--topic')?{topic:flags.get('--topic')}:{q:positional.join(' ')})};break;
  case 'show':body={...body,record:need(positional[0],'a record id or name')};break;
  case 'keep':body={...body,record:need(positional[0],'a record id or name'),from:need(flags.get('--from'),'--from <capture or input id>'),...(flags.has('--source-at')?{source_at:flags.get('--source-at')}:{})};break;
  case 'file':{
    let list=items.map(item=>({...item,...(flags.has('--source')?{source:flags.get('--source')}:{})}));
    if(flags.has('--json-file')){
      if(list.length)fail('Give --words items or --json-file, not both.');
      const parsed=JSON.parse(readFileSync(flags.get('--json-file')!,'utf8'));
      if(!Array.isArray(parsed))fail('--json-file holds a JSON array of {words, source?, sourceAt?, reading?}.');
      list=parsed;
    }
    if(!list.length)fail('file needs --words "<his exact words>" or --json-file.');
    body={...body,record:need(positional[0],'a record id or name'),items:list};break;
  }
  case 'reconcile':body={...body,source_id:need(flags.get('--source'),'--source <kept source id>'),...(flags.has('--note')?{note:flags.get('--note')}:{})};break;
  case 'judge':{
    const state=need(flags.get('--state'),'--state delivered|not-delivered|open');
    if(state==='delivered'&&!flags.has('--checked'))fail('Delivered needs --checked "<what you ran on the real system and saw>".');
    if(state==='not-delivered'&&!flags.has('--why'))fail('Not delivered needs --why "<what is missing>".');
    body={...body,item:need(flags.get('--item'),'--item <requirement id>'),state,...(flags.has('--checked')?{checked:flags.get('--checked')}:{}),...(flags.has('--why')?{why:flags.get('--why')}:{}),...(flags.has('--request')?{request:flags.get('--request')}:{})};break;
  }
  case 'link':body={...body,record:need(positional[0],'a record id or name'),topic:need(flags.get('--topic'),'--topic <Inbox thread id>')};break;
  default:fail(`Unknown requirements verb ${verb}.`);
}

const answer=await requestApiResponse('/session-communication/requirements',body);
if(!answer.ok){console.error(refusalText(answer.result,answer.status));process.exit(1);}
if(verb==='show'&&flags.has('--source')){
  const wanted=flags.get('--source')!;
  const kept=(answer.result as any)?.sources?.find((item:any)=>item.id===wanted||item.source===wanted);
  if(!kept){console.error(`That record keeps no capture "${wanted}". Its kept captures: ${((answer.result as any)?.sources??[]).map((item:any)=>item.id).join(', ')||'none'}.`);process.exit(1);}
  console.log(kept.text);
}else console.log(JSON.stringify(answer.result,null,2));
