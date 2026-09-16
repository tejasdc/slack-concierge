import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';

type Request=(method:string,params:Record<string,unknown>)=>Promise<any>;
type Timestamps=Map<string,string|null>;
// Only metadata is retained. Weak request ownership isolates provider connections/tests.
const paths=new WeakMap<Request,Map<string,Promise<string|null>>>();
const files=new Map<string,{version:string;pending:Promise<Timestamps>}>();

async function read(path:string,thread:string):Promise<Timestamps> {
  const timestamps:Timestamps=new Map();
  const lines=createInterface({input:createReadStream(path),crlfDelay:Infinity});
  for await(const line of lines) {
    let row:any;try{row=JSON.parse(line);}catch{continue;}
    const event=row.type==='event_msg'?row.payload:null;
    if(event?.type!=='item_completed'||event.thread_id!==thread||typeof event.turn_id!=='string'||typeof event.item?.id!=='string')continue;
    const time=event.started_at_ms??event.completed_at_ms;
    if(typeof time!=='number'||!Number.isFinite(time)||!Number.isFinite(new Date(time).getTime()))continue;
    const key=JSON.stringify([event.turn_id,event.item.id]),value=new Date(time).toISOString();
    if(timestamps.has(key)&&timestamps.get(key)!==value)timestamps.set(key,null);
    else if(!timestamps.has(key))timestamps.set(key,value);
  }
  return timestamps;
}

/** Exact thread/turn/item evidence; unavailable or conflicting metadata never invents a date. */
export async function codexTranscriptTimestamps(thread:string,request:Request):Promise<Timestamps> {
  let owned=paths.get(request);if(!owned){owned=new Map();paths.set(request,owned);}
  let pending=owned.get(thread);
  if(!pending){pending=request('thread/read',{threadId:thread,includeTurns:false}).then(result=>
    result?.thread?.id===thread&&typeof result.thread.path==='string'?result.thread.path:null).catch(()=>null);
    owned.set(thread,pending);}
  const path=await pending;if(!path){owned.delete(thread);return new Map();}
  try {
    const info=await stat(path),key=JSON.stringify([thread,path]);
    const version=JSON.stringify([info.dev,info.ino,info.size,info.mtimeMs,info.ctimeMs]);
    let cached=files.get(key);
    if(!cached||cached.version!==version){cached={version,pending:read(path,thread)};files.set(key,cached);}
    return await cached.pending;
  } catch {owned.delete(thread);files.delete(JSON.stringify([thread,path]));return new Map();}
}
