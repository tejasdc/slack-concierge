import {chmodSync,lstatSync,readFileSync,unlinkSync} from 'node:fs';
import {createConnection} from 'node:net';
import {classifyNativeReadRoute,assertNativeReadRouteCoverage} from './native-read-routes';
import type {ProviderAuthEphemera} from './provider-auth-ephemera';
import {logSinkCounters} from './log';
import {log} from './log';
import {observeStorageOperation,type StorageWork} from './storage-observation';
import {exitWithin,exitWithParent,PARENT_GONE_EXIT_MS} from './exit-with-parent';

if(process.env.CONCIERGE_READ_WORKER!=='1')throw new Error('NATIVE_READ_WORKER_REQUIRED');
const socket=process.env.CONCIERGE_READ_SOCKET;
const ownerSocket=process.env.CONCIERGE_OWNER_INTERNAL_SOCKET;
if(!socket||!ownerSocket)throw new Error('NATIVE_READ_SOCKETS_REQUIRED');
assertNativeReadRouteCoverage();

// A stale inode may be removed only after proving no listener owns it. A live socket is never replaced.
async function removeUnboundSocket(path:string){
  let original:ReturnType<typeof lstatSync>;
  try{original=lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  if(!original.isSocket())throw new Error('Read API path is not a socket.');
  if(process.platform==='linux'){
    const bound=readFileSync('/proc/net/unix','utf8').split('\n')
      .map(line=>line.match(/^\S+(?:\s+\S+){6}\s+(.+)$/)?.[1]);
    if(bound.includes(path))throw new Error('Read API already has a live listener.');
  }else{
    const live=await new Promise<boolean>((resolve,reject)=>{
      const connection=createConnection(path);
      connection.once('connect',()=>{connection.destroy();resolve(true);});
      connection.once('error',error=>{
        if(['ECONNREFUSED','ENOENT'].includes((error as NodeJS.ErrnoException).code??''))resolve(false);
        else reject(error);
      });
    });
    if(live)throw new Error('Read API already has a live listener.');
  }
  const current=lstatSync(path);
  if(!current.isSocket()||current.dev!==original.dev||current.ino!==original.ino)
    throw new Error('Read API socket changed during startup.');
  unlinkSync(path);
}

const {createNativeReadComposition}=await import('./native-read-composition');
const {providerAuthRead}=await import('./provider-auth-read');
const {peerSettings}=await import('./session-peers');
const {SessionOwnerError}=await import('./session-owner');
const {WorkspaceFileError,expandHome}=await import('./workspace-files');
const composition=createNativeReadComposition(process.env.CONCIERGE_WORKSPACE_ROOT||'/root/workspace',
  process.env.CONCIERGE_SESSION_CAPABILITY_SOCKET);
const peers=peerSettings();
const self=peers.self??process.env.CONCIERGE_PEER_NAME??'cloud';
const peerCache=new Map<string,{view:Record<string,unknown>;at:number}>();
const peerReads=new Map<string,Promise<Record<string,unknown>>>();
// Keep all request costs as counters; one ordinary completion in 100 is enough
// to retain examples without recreating the per-request journal write load.
const requests={completed:0,failed:0,slow:0,totalDurationMs:0,maxDurationMs:0,logSampledOut:0};

function failure(status:number,code:string,message:string){return Response.json({error:{code,message}},{status});}
async function capped(response:Response,max:number):Promise<Response>{
  if(max<=0)return response;
  const header=Number(response.headers.get('content-length'));
  if(header>max)return failure(503,'READ_BUDGET_EXCEEDED','This page exceeded its declared read size.');
  if(response.headers.has('content-length'))return response;
  const body=await response.arrayBuffer();
  if(body.byteLength>max)return failure(503,'READ_BUDGET_EXCEEDED','This page exceeded its declared read size.');
  const headers=new Headers(response.headers);headers.set('content-length',String(body.byteLength));
  return new Response(body,{status:response.status,statusText:response.statusText,headers});
}
async function ownerEphemera(fresh=false):Promise<ProviderAuthEphemera>{
  let response:Response;
  try{response=await fetch(`http://localhost/internal/${fresh?'auth-refresh':'auth-ephemera'}`,
    {unix:ownerSocket,method:fresh?'POST':'GET',signal:AbortSignal.timeout(fresh?18_000:750)} as RequestInit);}
  catch{throw new SessionOwnerError('Current sign-in state is unavailable; account status cannot be verified.',503,'AUTH_EPHEMERA_UNAVAILABLE');}
  if(!response.ok)throw new SessionOwnerError('Current sign-in state is unavailable; account status cannot be verified.',503,'AUTH_EPHEMERA_UNAVAILABLE');
  const value=await response.json() as ProviderAuthEphemera;
  if(!value||typeof value.observedAtMs!=='number'||typeof value.codexPending!=='boolean'||
    typeof value.claudePending!=='boolean'||typeof value.checking!=='boolean'||
    typeof value.usageRefreshing!=='boolean'||!value.lastSignIn||!value.accountFallback)
    throw new SessionOwnerError('Current sign-in state is invalid.',503,'AUTH_EPHEMERA_INVALID');
  return value;
}
function peerByName(name:string){return peers.peers.find(peer=>peer.name===name)??null;}
function peerForPath(path:string){
  const expanded=expandHome(path);
  return peers.peers.find(peer=>peer.paths.some(root=>expanded.startsWith(root)))?.name??null;
}
async function peerGet(name:string,path:string,timeoutMs:number):Promise<unknown>{
  const peer=peerByName(name);
  if(!peer||!peers.token)throw new SessionOwnerError(`This machine does not know ${name}.`,404,'MACHINE_UNKNOWN');
  let response:Response;
  try{response=await fetch(peer.url+path,{headers:{authorization:`Bearer ${peers.token}`,accept:'application/json'},signal:AbortSignal.timeout(timeoutMs)});}
  catch{throw new SessionOwnerError(`${name} is not answering, so its provider accounts cannot be reached right now.`,424,'MACHINE_UNREACHABLE');}
  const body=await response.json().catch(()=>null) as any;
  if(!response.ok)throw new SessionOwnerError(body?.error?.message??`${name} refused this read.`,response.status,
    body?.error?.code??'PEER_REFUSED');
  return body;
}
function peerAccountView(name:string,fresh:boolean):Promise<Record<string,unknown>>{
  let read=peerReads.get(name);
  if(!read){
    read=(async()=>{
      try{
        const answer=await peerGet(name,'/sessions/v1/auth/providers?'+new URLSearchParams({machine:name,...(fresh?{fresh:'1'}:{})}),fresh?30_000:8_000) as {providers?:unknown};
        const view={name,self:false,reachable:true,note:null,providers:answer?.providers??[]};
        peerCache.set(name,{view,at:Date.now()});
        return view;
      }catch(error){return {name,self:false,reachable:false,
        note:error instanceof SessionOwnerError&&error.code==='MACHINE_UNREACHABLE'
          ?`${name} is not answering right now, so its accounts cannot be read.`
          :error instanceof Error?error.message:`${name} could not be read right now.`,providers:[]};}
    })().finally(()=>peerReads.delete(name));
    peerReads.set(name,read);
  }
  if(fresh)return read;
  const cached=peerCache.get(name);
  if(cached)return Promise.resolve({...cached.view,checking:true});
  return Promise.race([read,new Promise<Record<string,unknown>>(resolve=>setTimeout(()=>
    resolve({name,self:false,reachable:true,note:null,providers:[],checking:true}),1_500))]);
}
async function authProviders(url:URL):Promise<Response>{
  const machine=url.searchParams.get('machine');
  if(machine!==null&&(!/^[a-z][a-z0-9-]{0,31}$/.test(machine)))
    throw new SessionOwnerError('A machine name is required.',400,'MACHINE_INVALID');
  const fresh=url.searchParams.get('fresh')==='1';
  if(machine&&machine!==self){
    const answer=await peerGet(machine,'/sessions/v1/auth/providers?'+new URLSearchParams({machine,...(fresh?{fresh:'1'}:{})}),fresh?30_000:8_000) as {providers?:unknown};
    const providers=answer?.providers??[];
    return Response.json({providers,machines:[{name:machine,self:false,reachable:true,note:null,providers}]});
  }
  const ephemera=await ownerEphemera(fresh);
  const providers=providerAuthRead(ephemera);
  const here={name:self,self:true,reachable:true,note:null,providers};
  if(machine!==null)return Response.json({providers,machines:[here]});
  const remote=await Promise.all(peers.peers.map(peer=>peerAccountView(peer.name,fresh)));
  return Response.json({providers,machines:[here,...remote]});
}
async function remoteFile(url:URL):Promise<Response|null>{
  const path=url.searchParams.get('path');
  if(!path?.trim())return null;
  const machine=url.searchParams.get('machine');
  if(machine!==null&&!/^[a-z][a-z0-9-]{0,31}$/.test(machine))
    throw new SessionOwnerError('A machine name is required.',400,'MACHINE_INVALID');
  const remote=machine&&machine!==self?machine:machine===null?peerForPath(path):null;
  if(!remote)return null;
  const answer=await peerGet(remote,'/sessions/v1/files?'+new URLSearchParams({path,machine:remote}),20_000);
  return Response.json(answer);
}

await removeUnboundSocket(socket);
const server=Bun.serve({unix:socket,idleTimeout:0,async fetch(request){
  const started=performance.now();
  const admissionId=request.headers.get('x-concierge-admission-id');
  const url=new URL(request.url);
  if(request.method==='GET'&&url.pathname==='/internal/ready')return Response.json({ok:true,pid:process.pid,logging:logSinkCounters(),requests});
  if(request.method!=='GET')return failure(405,'METHOD_NOT_ALLOWED','Only GET reads are served here.');
  const route=classifyNativeReadRoute(request.method,url.pathname);
  if(!route||route.domain!=='read-worker')return failure(route?503:404,route?'READ_OWNER_REQUIRED':'READER_CONTRACT_REQUIRED',
    route?'This read belongs to the canonical owner.':'This read has no declared execution owner.');
  let response:Response;
  let work:StorageWork|null=null;
  try{
    response=await observeStorageOperation(route.pattern,async()=>{
      if(route.source==='account')return authProviders(url);
      if(route.pattern==='/files')return await remoteFile(url)??await composition.owner.handleRead(request)??failure(404,'NOT_FOUND','Read unavailable.');
      return await composition.owner.handleRead(request)??failure(404,'NOT_FOUND','Read unavailable.');
    },measured=>{work=measured;});
  }catch(error){
    if(error instanceof SessionOwnerError||error instanceof WorkspaceFileError)
      response=failure(error.status,error.code,error.message);
    else response=failure(503,'READ_WORKER_UNAVAILABLE',error instanceof Error?error.message:'Read unavailable.');
  }
  response=await capped(response,route.maxResponseBytes);
  const durationMs=Math.round(performance.now()-started);
  response.headers.set('x-concierge-read-duration-ms',String(durationMs));
  response.headers.set('x-concierge-read-worker-pid',String(process.pid));
  if(admissionId)response.headers.set('x-concierge-admission-id',admissionId);
  requests.completed++;
  requests.totalDurationMs+=durationMs;
  requests.maxDurationMs=Math.max(requests.maxDurationMs,durationMs);
  if(response.status>=400)requests.failed++;
  if(durationMs>=2000)requests.slow++;
  if(response.status>=400||durationMs>=2000||requests.completed%100===0)
    log(response.status>=400||durationMs>=2000?'warn':'info','native_read_request_completed',{
      admission_id:admissionId,route:route.pattern,status:response.status,duration_ms:durationMs,...(work??{}),
    });
  else requests.logSampledOut++;
  return response;
}});
chmodSync(socket,0o600);
let stopping:Promise<void>|null=null;
function stop(){
  stopping??=(async()=>{await server.stop(true);await composition.close();})();
  return stopping;
}
const stopAndExit=()=>{exitWithin(PARENT_GONE_EXIT_MS);void stop().finally(()=>process.exit(0));};
process.on('disconnect',stopAndExit);
process.on('SIGTERM',stopAndExit);
exitWithParent(stopAndExit);
