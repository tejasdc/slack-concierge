import {createHash} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

export const MAC_FOCUS_SOURCE_INPUT='request:775cda97-8177-4202-8545-b451f74ef3bd';
export const MAC_FOCUS_SOURCE_RUN='e41da8b5-2d17-4483-add1-57e2b8d21203';
const PARENT_THREAD='01a1ad10-c8b0-7571-97f6-e2fdfffba3c5';
const HUMAN_MESSAGE='msg_01a1aeea-8d60-7543-a30c-f7c5801a3ccc';
const HUMAN_TEXT_SHA256='dce3b4179d38edd3f1e679adcd41ca5e550c01b4c61600471b335231181515b1';
const REQUESTS=[
  {item:'exec-a48f9fdc-9df8-4441-a232-66a549bba912',request:'5caf7de1-0937-46fe-9fc3-e72b48f119fc',command:'e22a766565eac0414ffbd2d75747b343d7a0167544e6f9e9882cf990123aa367',output:'536ddb94826d2072b3f82b6f1669d72804fcd4fdc12bc69ea3ff54653e82121f'},
  {item:'exec-6875316c-bd7c-4ca5-a46a-a6ffecde0b3d',request:'775cda97-8177-4202-8545-b451f74ef3bd',command:'b3c3dadde1f34eb4e905a98e24ff95d78e3fcaa69ba9e7f3e9502e40a8dac9b3',output:'fb7afe6e5bb5a6cbf8c8dfad4a301a472583795efca1c228bafb5557b683bda2'},
] as const;
const TRANSCRIPT=join(homedir(),'.codex','sessions','2026','11','05',`rollout-2026-11-05T13-55-20-${PARENT_THREAD}.jsonl`);
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');

/** Authenticate the native human turn and both exact outside Focus requests on the Mac. */
export function transcriptProvesMacFocus(text:string):boolean {
  let parentCount=0;
  const humanTimes:string[]=[];
  const requestTimes=new Map<string,string[]>();
  for(const line of text.split('\n')) {
    if(!line.includes(HUMAN_MESSAGE)&&!REQUESTS.some(request=>line.includes(request.item))&&!line.includes('"type":"session_meta"'))continue;
    let row:any;
    try {row=JSON.parse(line);} catch {return false;}
    if(row.type==='session_meta') {
      if(row.payload?.id!==PARENT_THREAD||row.payload?.forked_from_id||row.payload?.source?.subagent)return false;
      parentCount++;
    }
    if(row.type==='response_item'&&row.payload?.type==='message'&&row.payload?.role==='user'&&row.payload.id===HUMAN_MESSAGE) {
      const words=(row.payload.content??[]).filter((part:any)=>part?.type==='input_text').map((part:any)=>part.text).join('\n');
      if(hash(words)!==HUMAN_TEXT_SHA256)return false;
      humanTimes.push(row.timestamp);
    }
    if(row.type==='event_msg'&&row.payload?.type==='item_completed'&&row.payload.thread_id===PARENT_THREAD) {
      const item=row.payload.item;
      const request=REQUESTS.find(request=>request.item===item?.id);
      if(!request)continue;
      if(!Array.isArray(item.command)||hash(JSON.stringify(item.command))!==request.command
        ||typeof item.aggregated_output!=='string'||hash(item.aggregated_output)!==request.output)return false;
      let receipt:any;
      try {receipt=JSON.parse(item.aggregated_output);} catch {return false;}
      if(receipt.request_id!==request.request||item.status!=='completed')return false;
      requestTimes.set(request.item,[...(requestTimes.get(request.item)??[]),row.timestamp]);
    }
  }
  return parentCount===1&&humanTimes.length===1&&REQUESTS.every(request=>requestTimes.get(request.item)?.length===1)
    &&humanTimes[0]!<requestTimes.get(REQUESTS[0].item)![0]!
    &&requestTimes.get(REQUESTS[0].item)![0]!<requestTimes.get(REQUESTS[1].item)![0]!;
}

export function macFocusSourceProven():boolean {
  try {
    if(statSync(TRANSCRIPT).size>256*1024*1024)return false;
    return transcriptProvesMacFocus(readFileSync(TRANSCRIPT,'utf8'));
  } catch {return false;}
}
