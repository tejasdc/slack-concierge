import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {createCaptureQueueRequestHandler} from '../src/capture-queue-api';
import {createCaptureRequestHandler,type CaptureIngressConfig} from '../src/capture-ingress';
import {HumanCommandWorker} from '../src/human-command-worker';
import {commandStatus} from '../src/human-command-state';
import {captureDb} from '../src/capture-state';
import type {SessionOwner} from '../src/session-owner';
import {db} from '../src/state';
import {observeSyntheticProvider} from './responsive-provider-observation';

/** Scratch capture owner survives the measured coordinator. The browser runner
 * imports the shipping App and web proxy; this helper provides no alternate proxy. */
export function startBrowserBoundary(owner:Pick<SessionOwner,'handle'>,sessionId:number,thinkering:string,lifecycle?:{
 startLoad:()=>Promise<void>;restartOwner:()=>Promise<unknown>;
},topicId?:string){
 if(process.env.CONCIERGE_TEST_AUTHORIZATION!=='responsive-system-b1eed622'||process.env.CONCIERGE_TEST_MODE!=='1')throw new Error('Isolated acceptance only');
 const publicToken=crypto.randomUUID(),privateToken=crypto.randomUUID();
 const queue=createCaptureQueueRequestHandler({host:'127.0.0.1',port:0,token:privateToken});
 const ingressConfig:CaptureIngressConfig={server:{host:'127.0.0.1',port:0,healthPath:'/health',maxRequestBodyBytes:32*1024*1024},
  queue:{host:'127.0.0.1',port:0,token:privateToken},routes:[{id:'thinkering',path:'/thinkering',label:'Thinkering',adapter:'thinkering',
   maxBodyBytes:32*1024*1024,auth:{header:'Authorization',scheme:'Bearer',token:publicToken},destination:{type:'session'}}]};
 const publicIngress=createCaptureRequestHandler(ingressConfig,{accept:async()=>{throw new Error('Capture intake is outside this fixture.');}});
 let actionId:string|null=null,readyResolve!:()=>void;
 let providerObservation:unknown=null,providerFailure:string|null=null,providerRun:Promise<void>|null=null;
 let mutationGateway:string|null=null;
 let lostAckOnce=true;
 const mutation=async(phase:string,body:unknown)=>{
  if(!mutationGateway)throw new Error('Shipping mutation adapter is not ready');
  const response=await fetch(mutationGateway+'/fixture/'+phase,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  return {status:response.status,value:await response.json()};
 };
 const ready=new Promise<void>(resolve=>{readyResolve=resolve;});
 const worker=new HumanCommandWorker({queueUrl:'http://fixture',queueToken:privateToken,
  fetch:((input:any,init:any)=>queue(new Request(input,init))) as typeof fetch,
  prepare:command=>mutation('prepare',command),
  deliver:async(command,prepared)=>{const response=await mutation('deliver',{command,prepared});
   if(command.body.text==='Browser lost acknowledgement fixture.'&&lostAckOnce){
    lostAckOnce=false;return {status:503,value:{error:'Fixture dropped the owner acknowledgement after acceptance.'}};
   }
   if(response.status<300&&command.body.text==='Browser closure keeps these exact words.'&&!providerRun)
    providerRun=observeSyntheticProvider(command.body.text).then(value=>{providerObservation=value;},error=>{providerFailure=String(error);});
   return response;}});
 const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:60,fetch:async request=>{
  const url=new URL(request.url);
  if(url.pathname==='/fixture/gateway'){
   const body=await request.json() as {port:number};
   if(!Number.isSafeInteger(body.port)||body.port<1||body.port>65535)return new Response('Invalid fixture port',{status:400});
   mutationGateway='http://127.0.0.1:'+body.port;return Response.json({ok:true});
  }
  if(url.pathname==='/fixture/start-load'){await lifecycle?.startLoad();readyResolve();return Response.json({ok:true});}
  if(url.pathname==='/fixture/restart')return Response.json(lifecycle?await lifecycle.restartOwner():{unsupported:true});
  if(url.pathname==='/fixture/release'){worker.start();return Response.json({ok:true});}
  if(url.pathname==='/fixture/state'){
   const row=actionId?commandStatus(actionId):null;
   const inputs=db.query("SELECT id,payload_json FROM session_inputs WHERE session_id=? AND json_extract(payload_json,'$.text')=?").all(sessionId,'Browser closure keeps these exact words.');
   return Response.json({actionId,custody:row?.status??null,sequence:row?.sequence??null,accepted:inputs.length,inputs,providerObservation,providerFailure});
  }
  if(url.pathname==='/fixture/accepted'){
   const actionId=url.searchParams.get('actionId')??'';
   const accepted=db.query("SELECT COUNT(*) AS count FROM session_inputs WHERE action_id=?").get(actionId) as {count:number};
   return Response.json({actionId,accepted:accepted.count,status:commandStatus(actionId)?.status??null});
  }
  if(url.pathname==='/fixture/ingress-boundary'){
   const claim=await publicIngress(new Request('http://fixture/commands/claim',{method:'POST',headers:{authorization:`Bearer ${publicToken}`,'content-type':'application/json'},body:'{}'}));
   const unauthenticatedResume=await publicIngress(new Request('http://fixture/commands/missing/resume',{method:'POST'}));
   const privateWithPublicToken=await queue(new Request('http://fixture/commands/claim',{method:'POST',headers:{authorization:`Bearer ${publicToken}`,'content-type':'application/json'},body:'{}'}));
   return Response.json({publicClaim:claim.status,unauthenticatedResume:unauthenticatedResume.status,privateWithPublicToken:privateWithPublicToken.status});
  }
  if(url.pathname.startsWith('/commands')){
   const command=request.method==='POST'&&url.pathname==='/commands'?await request.clone().json() as any:null;
   if(command)actionId=command.actionId;
   const response=await publicIngress(request);
   if(command?.body?.text==='Browser lost acknowledgement fixture.'&&response.status===202)
    captureDb.query("UPDATE human_commands SET created_at=datetime('now','-3 minutes') WHERE action_id=?").run(command.actionId);
   return response;
  }
  if(url.pathname.startsWith('/sessions/v1/'))return await owner.handle(request)??new Response('Not found',{status:404});
  return new Response('Not found',{status:404});
 }});
 const child=spawn('setpriv',['--pdeathsig','KILL','node',join(import.meta.dir,'responsive-browser-boundary.mjs'),thinkering,String(server.port),String(sessionId),publicToken,topicId??''],{env:process.env,stdio:['ignore','pipe','pipe']});
 let output='',errors='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-6000);});
 const finished=new Promise<any>((resolve,reject)=>{
  const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(`Browser fixture timed out: ${errors}`));},60_000);
  child.once('exit',code=>{clearTimeout(timeout);if(code!==0){reject(new Error(`Browser fixture exited ${code}: ${errors}`));return;}
   const result=output.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}).find(row=>row.kind==='browser-boundary');
   if(!result)reject(new Error(`Missing browser result: ${output}`));else resolve(result);
  });
 }).finally(async()=>{await worker.stop();await providerRun;server.stop(true);});
 return {ready:Promise.race([ready,finished.then(()=>{throw new Error('Browser ended before load started');})]),finished};
}
