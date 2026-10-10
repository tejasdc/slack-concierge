import {chmod} from 'node:fs/promises';
import {timingSafeEqual,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {removeUnboundSocket} from './private-api-socket';
import {ForegroundReadPool} from './foreground-read-pool';
import {OWNER_COMMAND_RESPONSE_MS,OWNER_READ_RESPONSE_MS} from './owner-transport-policy';
import {forwardPrivateRequest,unavailable} from './foreground-forward';
import {classifyNativeReadRoute} from './native-read-routes';
import {log,errorFields,logSinkCounters} from './log';

/** No application owner, synchronous filesystem API, or database imports belong here. */
export async function startForegroundGateway(config:{stateDir:string;ownerSocket:string;readWorkerEntry:string;
  peer:{hostname:string;port:number;token:string}|null;onContact?:()=>void}) {
  const pool=new ForegroundReadPool(config.stateDir,config.ownerSocket,config.readWorkerEntry);
  let local:ReturnType<typeof Bun.serve>|null=null,peer:ReturnType<typeof Bun.serve>|null=null;
  let closing:Promise<void>|null=null;
  const stop=(force=false)=>closing??=(async()=>{
    await Promise.all([local?.stop(force),peer?.stop(force)]);
    await pool.stop();
  })();
  const route=async(request:Request):Promise<Response>=>{
    const url=new URL(request.url);
    // These are process control entrances, never authenticated product capabilities.
    if(url.pathname.startsWith('/internal/'))return Response.json({error:'Unknown request API route.'},{status:404});
    const id=randomUUID();
    const headers=new Headers(request.headers);headers.set('x-concierge-admission-id',id);
    request=new Request(request,{headers});
    const read=classifyNativeReadRoute(request.method,url.pathname);
    if(read?.domain==='read-worker')return pool.request(request,read.pattern,id);
    const nativePath=url.pathname==='/sessions/v1'||url.pathname.startsWith('/sessions/v1/');
    if(request.method==='GET'&&nativePath&&!read)
      return unavailable('UNREGISTERED_READ_ROUTE','This read has no registered execution boundary.');
    if(request.method==='GET'&&!nativePath&&url.pathname!=='/supervisor/ping'&&url.pathname!=='/executions'&&!url.pathname.startsWith('/requests/'))
      return Response.json({error:'Unknown request API route.'},{status:404});
    const began=performance.now();
    const mutation=request.method!=='GET'&&request.method!=='HEAD';
    // A stream is intentionally long lived; the caller owns its cancellation.
    // The outside supervisor owns the ping deadline. An answering gateway must
    // not turn a frozen canonical owner into an answered (but non-OK) ping.
    const signal=read?.domain==='stream-owner'||url.pathname==='/supervisor/ping'?request.signal:AbortSignal.any([
      request.signal,AbortSignal.timeout(mutation?OWNER_COMMAND_RESPONSE_MS:OWNER_READ_RESPONSE_MS),
    ]);
    try {
      const response=await forwardPrivateRequest(request,config.ownerSocket,signal);
      if(url.pathname==='/supervisor/ping'&&response.ok) {
        const capacity=pool.snapshot();
        if(capacity.ready===0){await response.body?.cancel();return unavailable('READ_CAPACITY_UNAVAILABLE','The read executors are unavailable.');}
        const readerHealth=await pool.health();
        const responding=readerHealth.some(reader=>reader.responding);
        return Response.json({...await response.json() as object,readCapacity:capacity,
          gatewayLogging:logSinkCounters(),readerHealth}, {status:responding?200:503});
      }
      if(performance.now()-began>=2000)log('warn','foreground_owner_dependency_delayed',{
        request_id:id,route:read?.pattern??(mutation?'canonical-command':'canonical-control'),
        domain:read?.domain??'canonical-owner',headers_ms:Math.round(performance.now()-began),read_capacity:pool.snapshot(),
      });
      return response;
    } catch(error) {
      log('warn','foreground_owner_dependency_unavailable',{request_id:id,route:read?.pattern??(mutation?'canonical-command':'canonical-control'),
        elapsed_ms:Math.round(performance.now()-began),...errorFields(error)});
      // Forwarding a mutation may have committed. Never call that a refusal or
      // resubmit it here; existing operation identities/intake reconcile it.
      return unavailable(mutation?'COMMAND_OUTCOME_UNCONFIRMED':'OWNER_DEPENDENCY_UNAVAILABLE',mutation
        ?'The owner response is unavailable. The command may have been accepted; inspect its existing receipt before retrying.'
        :'The live owner dependency is unavailable. Independent reads remain available.');
    }
  };
  try {
    await pool.start();
    const path=join(config.stateDir,'requests.sock');
    await removeUnboundSocket(path);
    local=Bun.serve({unix:path,idleTimeout:0,fetch:route});
    await chmod(path,0o600);
    if(config.peer) {
      const expected=Buffer.from(config.peer.token);
      peer=Bun.serve({hostname:config.peer.hostname,port:config.peer.port,idleTimeout:0,fetch:async(request:Request)=>{
        const authorization=request.headers.get('authorization')??'';
        const presented=Buffer.from(authorization.startsWith('Bearer ')?authorization.slice(7):'');
        if(presented.length!==expected.length||!timingSafeEqual(presented,expected))
          return Response.json({error:{code:'PEER_UNAUTHORIZED',message:'A valid peer token is required.'}},{status:401});
        const path=new URL(request.url).pathname;
        if(path!=='/sessions/v1'&&!path.startsWith('/sessions/v1/'))
          return Response.json({error:{code:'NOT_FOUND',message:'Only the session owner API is served to peers.'}},{status:404});
        config.onContact?.();
        return route(request);
      }});
    }
    return {stop,snapshot:()=>pool.snapshot()};
  } catch(error){await stop(true);throw error;}
}
