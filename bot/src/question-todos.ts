import {spawn} from 'node:child_process';
import {thinkeringRequest} from './thinkering-capability-target';
import {log} from './log';
import {awaitingOutside} from './storage-observation';

/**
 * A question that asks Tejas to do a step names the to-do that step is on his list as, so his own
 * tick on that to-do settles it. On 2026-11-04 the Diwali agent asked him at 2:58 PM to make a Spotify
 * invite he had marked done at 10:20 PM the night before; nothing linked the question to the to-do.
 * The to-dos live in thnkr.ing; this reads them over its local capability socket (over SSH from the
 * Mac, as the thesaurus does). Matching is by exact to-do id, never by wording.
 */
export type TodoState={id:string;text:string;status:string;completedAt:string|null};
/** Steps he must take himself: these asks name their to-do (or say there is none). */
export const STEP_ASKS=new Set(['sign-in','secret','device']);

const SOCKET=process.env.THINKERING_SESSION_CAPABILITY_SOCKET||'/run/thinkering/session-capabilities.sock';
const LOCAL_MS=3_000,MAC_MS=8_000,LIMIT=8_388_608,PAGE=200;

function overSocket(path:string):Promise<string>{
  return new Promise((resolve,reject)=>{
    const request=thinkeringRequest(path,{method:'GET',timeout:LOCAL_MS},response=>{
      const chunks:Buffer[]=[];let size=0;
      response.on('data',chunk=>{const part=Buffer.from(chunk as Uint8Array);size+=part.length;if(size>LIMIT)response.destroy(new Error('too large'));else chunks.push(part);});
      response.once('error',reject);
      response.once('end',()=>response.statusCode===200?resolve(Buffer.concat(chunks).toString('utf8')):reject(new Error(`status ${response.statusCode}`)));
    });
    request.once('timeout',()=>request.destroy(new Error('timeout')));
    request.once('error',reject);
    request.end();
  });
}
function overSsh(path:string):Promise<string>{
  return new Promise((resolve,reject)=>{
    const child=spawn('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=4','remote-box',
      `curl -sf --max-time 5 --unix-socket ${SOCKET} 'http://x${path}'`],{stdio:['ignore','pipe','ignore']});
    const chunks:Buffer[]=[];let size=0;
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('timeout'));},MAC_MS);
    child.stdout.on('data',chunk=>{const part=Buffer.from(chunk as Uint8Array);size+=part.length;if(size<=LIMIT)chunks.push(part);});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',code=>{clearTimeout(timer);code===0?resolve(Buffer.concat(chunks).toString('utf8')):reject(new Error(`exit ${code}`));});
  });
}

/** Every to-do of his, in every state; throws when thnkr.ing cannot be read. */
export async function readTodos():Promise<TodoState[]>{
  const all:TodoState[]=[];
  let after:number|null=null,afterId:string|null=null;
  for(let pages=0;pages<50;pages++){
    const query=new URLSearchParams({limit:String(PAGE),statuses:'candidate,open,done,dropped'});
    if(after!==null&&afterId){query.set('after',String(after));query.set('afterId',afterId);}
    const path=`/todos/tasks?${query}`;
    // thnkr.ing answers in its own process: waiting on it is outside time, never owner time.
    const answer=JSON.parse(await awaitingOutside(()=>process.platform==='darwin'?overSsh(path):overSocket(path))) as {items?:any[]};
    const items=Array.isArray(answer.items)?answer.items:[];
    for(const item of items)if(typeof item?.id==='string')
      all.push({id:item.id,text:String(item.text??''),status:String(item.status??''),completedAt:typeof item.completedAt==='string'?item.completedAt:null});
    if(items.length<PAGE)return all;
    const last=items.at(-1);
    if(typeof last?.position!=='number'||typeof last?.id!=='string')return all;
    after=last.position;afterId=last.id;
  }
  return all;
}

/**
 * The to-do a question names, read now: the found to-do, null when he has no such to-do, or
 * 'unavailable' when thnkr.ing cannot be read (the question is then accepted, never lost, and the
 * closing check settles it later).
 */
export async function namedTodo(id:string):Promise<TodoState|null|'unavailable'>{
  try{return (await readTodos()).find(todo=>todo.id===id)??null;}
  catch(error){log('warn','question_todo_unavailable',{todo:id,reason:error instanceof Error?error.message.slice(0,80):'failed'});return 'unavailable';}
}

/** Why a question about this to-do must not reach him, or null when it may. */
export function finishedTodoRefusal(todo:TodoState):string|null{
  if(todo.status==='done')return `He already did this: he marked his to-do "${todo.text}" done${todo.completedAt?` at ${todo.completedAt}`:''}. Do not ask him; continue from there (check the result yourself if you must).`;
  if(todo.status==='dropped')return `He dropped his to-do "${todo.text}". Do not ask him to do it.`;
  return null;
}
