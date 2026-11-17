import {requirementCall,type AgentIdentity} from './requirement-records';
import {ledgerUtcAsIso} from './agent-local-time';
import {getAcceptedSessionInput} from './session-inputs';
import type {SessionOwner} from './session-owner';

/**
 * `router-actions.sh requirements ...` as the owner runs it: thin commands over thnkr.ing's
 * requirement routes, carrying the calling agent's session (the accepted input and run) so a write
 * is recorded as that agent. A kept capture is fetched here from the retained Inbox copy, never
 * taken from the caller, so what is kept is Tejas's exact text and cannot be a paraphrase.
 */
const HEX=/^[a-f0-9]{64}$/;

/** The one name a capture or input has as a requirement source, the same one `keep` and `file` use. */
export function sourceRef(id:string):string{
  const bare=id.replace(/^capture:/,'');
  return HEX.test(bare)?`capture:${bare}`:id;
}

function retainedWords(id:string,owner?:SessionOwner):{text:string;at:string|null}{
  const bare=id.replace(/^capture:/,'');
  if(HEX.test(bare)){
    if(!owner)throw new Error('The retained Inbox capture cannot be read here.');
    const capture=owner.inboxCapture(bare);
    return {text:capture.text,at:getAcceptedSessionInput(`capture:${bare}`)?.created_at??null};
  }
  const input=getAcceptedSessionInput(id);
  if(!input)throw new Error(`"${id}" is neither a retained Inbox capture nor an accepted input. Give a capture id (64 hex characters) or an exact input id.`);
  const body=JSON.parse(input.payload_json) as {text?:unknown};
  if(typeof body.text!=='string'||!body.text)throw new Error(`Input ${id} carries no text to keep.`);
  return {text:body.text,at:input.created_at};
}

type Command={source?:{input_id?:string;run_id?:string};verb?:string;[key:string]:unknown};
const str=(value:unknown,name:string):string=>{
  if(typeof value!=='string'||!value.trim())throw new Error(`requirements needs ${name}.`);
  return value.trim();
};

export async function runRequirementCommand(input:Command,owner?:SessionOwner):Promise<{status:number;body:unknown}>{
  const agent:AgentIdentity=input.source?.input_id&&input.source.run_id?{inputId:input.source.input_id,runId:input.source.run_id}:null;
  const call=(method:'GET'|'POST',path:string,body?:unknown)=>requirementCall(method,path,body,agent);
  switch(input.verb){
    case 'new':
      return call('POST','/requirements',{name:str(input.name,'a record name'),...(input.project?{project:input.project}:{}),...(Array.isArray(input.topics)?{topics:input.topics}:{})});
    case 'find':{
      const query=new URLSearchParams();
      if(typeof input.topic==='string'&&input.topic)query.set('topic',input.topic);
      else query.set('q',typeof input.q==='string'?input.q:'');
      return call('GET',`/requirements?${query}`);
    }
    case 'show':return call('GET',`/requirements/${encodeURIComponent(str(input.record,'a record id or name'))}`);
    case 'keep':{
      const from=str(input.from,'--from <capture or input id>');
      const kept=retainedWords(from,owner);
      return call('POST','/requirements/sources',{record:str(input.record,'a record id or name'),source:sourceRef(from),
        // The ledger writes UTC without a zone; thnkr.ing refuses a zone-less time rather than reading it as New York time.
        ...(typeof input.source_at==='string'&&input.source_at?{sourceAt:ledgerUtcAsIso(input.source_at)}:kept.at?{sourceAt:ledgerUtcAsIso(kept.at)}:{}),text:kept.text});
    }
    case 'file':{
      if(!Array.isArray(input.items)||!input.items.length)throw new Error('requirements file needs at least one requirement (--words "<his exact words>").');
      const items=input.items.map((item:any)=>({words:str(item?.words,'the requirement words'),
        ...(item?.source?{source:sourceRef(String(item.source))}:{}),...(item?.sourceAt?{sourceAt:ledgerUtcAsIso(String(item.sourceAt))}:{}),...(item?.reading?{reading:item.reading}:{})}));
      return call('POST','/requirements/file',{record:str(input.record,'a record id or name'),items});
    }
    case 'reconcile':
      return call('POST','/requirements/reconcile',{source:str(input.source_id,'--source <kept source id>'),...(input.note?{note:input.note}:{})});
    case 'judge':
      return call('POST','/requirements/judge',{item:str(input.item,'--item <requirement id>'),state:str(input.state,'--state delivered|not-delivered|open'),
        ...(input.checked?{checked:input.checked}:{}),...(input.why?{why:input.why}:{}),...(input.request?{request:input.request}:{})});
    case 'link':
      return call('POST','/requirements/topic',{record:str(input.record,'a record id or name'),topic:str(input.topic,'--topic <Inbox thread id>')});
    default:throw new Error('requirements verbs: new, find, show, keep, file, reconcile, judge, link.');
  }
}
