import {createHash} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

export const MAC_UPDATE_SOURCE_INPUT='request:79fe4481-3587-40e3-aa66-58fc26be5e0b';
export const MAC_UPDATE_SOURCE_RUN='4ca7650c-f951-4c7d-b387-a8dc1b9a1978';
const FIRST_REQUEST='1c9145ce-b0bc-40e6-8b55-6971d4bdd19c';
const PARENT_THREAD='01a1ad10-c8b0-7571-97f6-e2fdfffba3c5';
const HUMAN_MESSAGE='msg_01a1aeea-8d60-7543-a30c-f7c5801a3ccc';
const HUMAN_TEXT_SHA256='dce3b4179d38edd3f1e679adcd41ca5e550c01b4c61600471b335231181515b1';
const REQUEST_COMMAND_SHA256='96e12a3d6905ba4d3ef189837ed00859fd15b4657ff0b87bdd4d5af97cfab791';
const REQUEST_OUTPUT_SHA256='11487385d770b967bce842aa9f7261b47be33a1634937271851b623c22af5dd0';
const REQUEST_ITEM='exec-f6cc3457-04c7-4f72-9d69-7beb36eee572';
const RENEWED_REQUEST_COMMAND_SHA256='b36eff5346fb54bd9dfbfa46b45716c5a88239f6e9044ea5c3e2d766cbaca178';
const RENEWED_REQUEST_OUTPUT_SHA256='159ca7086d29e65843a3827888a7c6d012b52d66ec10fa10e6d016c6f9e601ff';
const RENEWED_REQUEST_ITEM='exec-da4488b8-034f-4977-87e8-1ba4630dac78';
const TRANSCRIPT=join(homedir(),'.codex','sessions','2026','11','05',`rollout-2026-11-05T13-55-20-${PARENT_THREAD}.jsonl`);

/** The Mac's own Codex transcript joins Tejas's direct instruction to this exact outside request. */
export function transcriptProvesMacUpdate(text:string):boolean {
  let humanAt='';
  let requestAt='';
  let renewedRequestAt='';
  let humanCount=0;
  let requestCount=0;
  let renewedRequestCount=0;
  let parentCount=0;
  for(const line of text.split('\n')) {
    if(!line.includes(HUMAN_MESSAGE)&&!line.includes(REQUEST_ITEM)
      &&!line.includes(RENEWED_REQUEST_ITEM)&&!line.includes('"type":"session_meta"'))continue;
    let row:any;
    try {row=JSON.parse(line);} catch {return false;}
    if(row.type==='session_meta') {
      if(row.payload?.id!==PARENT_THREAD||row.payload?.forked_from_id||row.payload?.source?.subagent)return false;
      parentCount++;
    }
    if(row.type==='response_item'&&row.payload?.type==='message'&&row.payload?.role==='user'
      &&row.payload.id===HUMAN_MESSAGE) {
      const words=(row.payload.content??[]).filter((part:any)=>part?.type==='input_text').map((part:any)=>part.text).join('\n');
      if(createHash('sha256').update(words).digest('hex')!==HUMAN_TEXT_SHA256)return false;
      humanAt=row.timestamp;
      humanCount++;
    }
    if(row.type==='event_msg'&&row.payload?.type==='item_completed'
      &&row.payload.thread_id===PARENT_THREAD) {
      const item=row.payload.item;
      const command=Array.isArray(item?.command)?JSON.stringify(item.command):'';
      if(item.id===REQUEST_ITEM
        &&createHash('sha256').update(command).digest('hex')===REQUEST_COMMAND_SHA256
        &&typeof item.aggregated_output==='string'
        &&createHash('sha256').update(item.aggregated_output).digest('hex')===REQUEST_OUTPUT_SHA256
        &&JSON.parse(item.aggregated_output).request_id===FIRST_REQUEST) {
        requestAt=row.timestamp;
        requestCount++;
      }
      if(item.id===RENEWED_REQUEST_ITEM
        &&createHash('sha256').update(command).digest('hex')===RENEWED_REQUEST_COMMAND_SHA256
        &&typeof item.aggregated_output==='string'
        &&createHash('sha256').update(item.aggregated_output).digest('hex')===RENEWED_REQUEST_OUTPUT_SHA256
        &&JSON.parse(item.aggregated_output).request_id===MAC_UPDATE_SOURCE_INPUT.slice('request:'.length)) {
        renewedRequestAt=row.timestamp;
        renewedRequestCount++;
      }
    }
  }
  return parentCount===1&&humanCount===1&&requestCount===1&&renewedRequestCount===1
    &&humanAt<requestAt&&requestAt<renewedRequestAt;
}

export function macUpdateSourceProven():boolean {
  try {
    if(statSync(TRANSCRIPT).size>256*1024*1024)return false;
    return transcriptProvesMacUpdate(readFileSync(TRANSCRIPT,'utf8'));
  } catch {return false;}
}
