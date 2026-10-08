import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {createCaptureQueueRequestHandler} from '../src/capture-queue-api';
import {HumanCommandWorker} from '../src/human-command-worker';
import {commandStatus} from '../src/human-command-state';
import type {SessionOwner} from '../src/session-owner';
import {db} from '../src/state';

/** A fixture gateway around the real custody handler, transfer worker and owner. The
 * production browser adapter/outbox/composer are imported by the browser runner. */
export function startBrowserBoundary(owner:SessionOwner,sessionId:number,thinkering:string){
 if(process.env.CONCIERGE_TEST_AUTHORIZATION!=='responsive-system-b1eed622'||process.env.CONCIERGE_TEST_MODE!=='1')throw new Error('Isolated acceptance only');
 const token=crypto.randomUUID(),queue=createCaptureQueueRequestHandler({host:'127.0.0.1',port:0,token});
 let actionId:string|null=null,readyResolve!:()=>void;
 const ready=new Promise<void>(resolve=>{readyResolve=resolve;});
 const commandFetch=async(path:string,body?:unknown)=>queue(new Request('http://fixture'+path,{method:body===undefined?'GET':'POST',
  headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));
 const worker=new HumanCommandWorker({queueUrl:'http://fixture',queueToken:token,
  fetch:((input:any,init:any)=>queue(new Request(input,init))) as typeof fetch,
  prepare:async command=>({status:200,value:{path:command.path,body:command.body}}),
  deliver:async(command,prepared:any)=>{const response=await owner.handle(new Request('http://fixture'+prepared.path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(prepared.body)}));
   return {status:response?.status??503,value:await response?.json()};}});
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async request=>{
  const url=new URL(request.url);
  if(url.pathname==='/fixture/start-load'){readyResolve();return Response.json({ok:true});}
  if(url.pathname==='/fixture/release'){worker.start();return Response.json({ok:true});}
  if(url.pathname==='/fixture/state'){
   const row=actionId?commandStatus(actionId):null;
   const inputs=db.query("SELECT id,payload_json FROM session_inputs WHERE session_id=? AND json_extract(payload_json,'$.text')=?").all(sessionId,'Browser closure keeps these exact words.');
   return Response.json({actionId,custody:row?.status??null,sequence:row?.sequence??null,accepted:inputs.length,inputs});
  }
  if(!url.pathname.startsWith('/api/session-owner/'))return new Response('Not found',{status:404});
  const path=url.pathname.slice('/api/session-owner'.length)+url.search;
  if(path.startsWith('/commands/'))return commandFetch(path);
  if(request.method==='POST'){
   const body=await request.json() as any;actionId=body.clientActionId;
   return commandFetch('/commands',{version:1,clientId:request.headers.get('x-thinkering-command-client'),sessionId:`concierge:${sessionId}`,
    sequence:Number(request.headers.get('x-thinkering-command-sequence')),actionId,door:'web',method:'POST',path:'/sessions/v1'+path,body});
  }
  return await owner.handle(new Request('http://fixture/sessions/v1'+path))??new Response('Not found',{status:404});
 }});
 const child=spawn('setpriv',['--pdeathsig','KILL','node',join(import.meta.dir,'responsive-browser-boundary.mjs'),thinkering,String(server.port),String(sessionId)],{env:process.env,stdio:['ignore','pipe','pipe']});
 let output='',errors='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-6000);});
 const finished=new Promise<any>((resolve,reject)=>{
  const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(`Browser fixture timed out: ${errors}`));},60_000);
  child.once('exit',code=>{clearTimeout(timeout);if(code!==0){reject(new Error(`Browser fixture exited ${code}: ${errors}`));return;}
   const result=output.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}).find(row=>row.kind==='browser-boundary');
   if(!result)reject(new Error(`Missing browser result: ${output}`));else resolve(result);
  });
 }).finally(async()=>{await worker.stop();server.stop(true);});
 return {ready:Promise.race([ready,finished.then(()=>{throw new Error('Browser ended before load started');})]),finished};
}
