import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Request=(method:string,params:Record<string,unknown>)=>Promise<any>;
type Timestamps=Map<string,string|null>;
// Only metadata is retained. Weak request ownership isolates provider connections/tests.
const paths=new WeakMap<Request,Map<string,Promise<string|null>>>();
/**
 * A Codex rollout only grows while its conversation runs, so each file is read once and then
 * only from where the last read stopped. Every history page used to re-read the whole file
 * whenever it had changed, which for a running conversation was every page: a 161 MB rollout
 * made each page cost seconds and one session open 4.5–8 s (nightly review, 2026-10-30).
 * `offset` counts only bytes of complete lines; a line still being written is read next time.
 */
type FileState={identity:string;offset:number;timestamps:Timestamps;reading:Promise<void>};
const files=new Map<string,FileState>();
const NEWLINE=0x0a;

function record(timestamps:Timestamps,line:string,thread:string) {
  let row:any;try{row=JSON.parse(line);}catch{return;}
  const event=row.type==='event_msg'?row.payload:null;
  if(event?.type!=='item_completed'||event.thread_id!==thread||typeof event.turn_id!=='string'||typeof event.item?.id!=='string')return;
  const time=event.started_at_ms??event.completed_at_ms;
  if(typeof time!=='number'||!Number.isFinite(time)||!Number.isFinite(new Date(time).getTime()))return;
  const key=JSON.stringify([event.turn_id,event.item.id]),value=new Date(time).toISOString();
  if(timestamps.has(key)&&timestamps.get(key)!==value)timestamps.set(key,null);
  else if(!timestamps.has(key))timestamps.set(key,value);
}

/** Reads complete lines in [state.offset, end); a newline byte never occurs inside a UTF-8 sequence. */
async function readFrom(path:string,thread:string,state:FileState,end:number) {
  if(end<=state.offset)return;
  const decoder=new TextDecoder();
  let pending:Buffer[]=[],pendingBytes=0;
  for await(const chunk of createReadStream(path,{start:state.offset,end:end-1}) as AsyncIterable<Buffer>) {
    let start=0,newline:number;
    while((newline=chunk.indexOf(NEWLINE,start))!==-1) {
      const piece=chunk.subarray(start,newline);
      const bytes=pendingBytes?Buffer.concat([...pending,piece]):piece;
      const line=decoder.decode(bytes);
      record(state.timestamps,line.endsWith('\r')?line.slice(0,-1):line,thread);
      state.offset+=bytes.length+1;
      pending=[];pendingBytes=0;start=newline+1;
    }
    if(start<chunk.length){pending.push(chunk.subarray(start));pendingBytes+=chunk.length-start;}
  }
}

export type CodexTranscriptMark={path:string;identity:string;offset:number};

/**
 * Timestamps recorded after `from`, for a caller that keeps its own earlier ones (the stored
 * history window): a top-up after a restart reads only what Codex wrote since, never the whole
 * rollout again. A replaced or shortened rollout, or no mark, reads it from its first byte.
 */
export async function codexTranscriptTimestampsAfter(thread:string,request:Request,from:CodexTranscriptMark|null)
  :Promise<{timestamps:Timestamps;mark:CodexTranscriptMark}|null> {
  const path=from?.path??await codexRolloutPath(thread,request);
  if(!path)return null;
  try {
    const info=await stat(path),identity=JSON.stringify([info.dev,info.ino]);
    const resume=from&&from.identity===identity&&info.size>=from.offset;
    const state:FileState={identity,offset:resume?from.offset:0,timestamps:new Map(),reading:Promise.resolve()};
    await readFrom(path,thread,state,info.size);
    return {timestamps:state.timestamps,mark:{path,identity,offset:state.offset}};
  } catch {return null;}
}

const THREAD_READ_WAIT_MS=2000;
/**
 * Where a Codex conversation's rollout file is. Codex names it after the conversation id under
 * sessions/<local date>/, and the id (a UUIDv7) carries its creation instant, so the file is found
 * in that day's folder (or a neighbour, for a time-zone edge) without asking the App Server. The
 * App Server's thread/read is the last resort, bounded: for two long conversations it went
 * unanswered for 30 s on every call, and every history open waited on it (2026-10-30).
 */
async function codexRolloutPath(thread:string,request:Request):Promise<string|null>{
  const home=process.env.CODEX_HOME||join(homedir(),'.codex');
  const created=/^[0-9a-f]{8}-[0-9a-f]{4}-7/i.test(thread)?parseInt(thread.replace(/-/g,'').slice(0,12),16):NaN;
  if(Number.isFinite(created)){
    for(const offset of [0,-1,1]){
      const day=new Date(created+offset*86_400_000);
      const folder=join(home,'sessions',String(day.getFullYear()),String(day.getMonth()+1).padStart(2,'0'),String(day.getDate()).padStart(2,'0'));
      const name=(await readdir(folder).catch(()=>[] as string[])).find(entry=>entry.endsWith(`-${thread}.jsonl`));
      if(name)return join(folder,name);
    }
  }
  let timer:ReturnType<typeof setTimeout>|undefined;
  const answered=await Promise.race([
    request('thread/read',{threadId:thread,includeTurns:false}).then(result=>
      result?.thread?.id===thread&&typeof result.thread.path==='string'?result.thread.path as string:null).catch(()=>null),
    new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),THREAD_READ_WAIT_MS);}),
  ]);
  clearTimeout(timer);
  return answered;
}

/** Exact thread/turn/item evidence; unavailable or conflicting metadata never invents a date. */
export async function codexTranscriptTimestamps(thread:string,request:Request):Promise<Timestamps> {
  let owned=paths.get(request);if(!owned){owned=new Map();paths.set(request,owned);}
  let pending=owned.get(thread);
  if(!pending){pending=codexRolloutPath(thread,request);
    owned.set(thread,pending);}
  const path=await pending;if(!path){owned.delete(thread);return new Map();}
  const key=JSON.stringify([thread,path]);
  try {
    const info=await stat(path),identity=JSON.stringify([info.dev,info.ino]);
    let state=files.get(key);
    // A replaced or shortened file is a different record: start it again from its first byte.
    if(!state||state.identity!==identity||info.size<state.offset){
      state={identity,offset:0,timestamps:new Map(),reading:Promise.resolve()};files.set(key,state);}
    const current=state;
    current.reading=current.reading.then(()=>readFrom(path,thread,current,info.size));
    await current.reading;
    return current.timestamps;
  } catch {owned.delete(thread);files.delete(key);return new Map();}
}
