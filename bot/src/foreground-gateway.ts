import {chmod} from 'node:fs/promises';
import {timingSafeEqual,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {removeUnboundSocket} from './private-api-socket';
import {ForegroundReadPool} from './foreground-read-pool';
import {OWNER_COMMAND_RESPONSE_MS,OWNER_READ_RESPONSE_MS} from './owner-transport-policy';
import {forwardPrivateRequest,unavailable} from './foreground-forward';
import {classifyNativeReadRoute} from './native-read-routes';
import {log,errorFields,logSinkCounters} from './log';
import {agentPrincipalHeader,verifyAgentToken} from './agent-token-verify';
import {RunnerRelay} from './runner-relay';

/** No application owner, synchronous filesystem API, or database imports belong here. */
export async function startForegroundGateway(config:{stateDir:string;ownerSocket:string;readWorkerEntry:string;
  peer:{hostname:string;port:number;token:string}|null;onContact?:()=>void;
  agent?:{hostname:string;port:number;keyHex:string}|null}) {
  const pool=new ForegroundReadPool(config.stateDir,config.ownerSocket,config.readWorkerEntry);
  // Live connections to services on runners (the Codex App Server), piped here; nothing stored.
  const relay=new RunnerRelay();
  let local:ReturnType<typeof Bun.serve>|null=null,peer:ReturnType<typeof Bun.serve>|null=null,agent:ReturnType<typeof Bun.serve>|null=null;
  let closing:Promise<void>|null=null;
  const stop=(force=false)=>closing??=(async()=>{
    await Promise.all([local?.stop(force),peer?.stop(force),agent?.stop(force)]);
    await pool.stop();
  })();
  const route=async(request:Request,fromPeer=false,agentPrincipal:string|null=null):Promise<Response>=>{
    const url=new URL(request.url);
    // Only the root-owned local socket reaches this entrance. The live stream stays
    // with the owner, while its retained page projection runs in a read executor.
    if(url.pathname==='/internal/event-stream-page')
      return pool.request(request,'/internal/event-stream-page',randomUUID());
    // These are process control entrances, never authenticated product capabilities.
    if(url.pathname.startsWith('/internal/'))return Response.json({error:'Unknown request API route.'},{status:404});
    const id=randomUUID();
    const headers=new Headers(request.headers);
    headers.delete('x-concierge-verified-peer');
    headers.delete('x-concierge-agent-principal');
    if(fromPeer)headers.set('x-concierge-verified-peer','1');
    // An agent that reached the owner over the network: the owner records which run it was.
    if(agentPrincipal)headers.set('x-concierge-agent-principal',agentPrincipal);
    headers.set('x-concierge-admission-id',id);
    request=new Request(request,{headers});
    const read=classifyNativeReadRoute(request.method,url.pathname);
    if(read?.domain==='read-worker')return pool.request(request,read.pattern,id,read.source==='archive'?'archive':'interactive');
    const nativePath=url.pathname==='/sessions/v1'||url.pathname.startsWith('/sessions/v1/');
    if(request.method==='GET'&&nativePath&&!read)
      return unavailable('UNREGISTERED_READ_ROUTE','This read has no registered execution boundary.');
    if(request.method==='GET'&&!nativePath&&url.pathname!=='/supervisor/ping'&&url.pathname!=='/executions'&&!url.pathname.startsWith('/requests/')&&!url.pathname.startsWith('/runner/v1/jobs/'))
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
    local=Bun.serve({unix:path,idleTimeout:0,websocket:relay.handlers,fetch:(request:Request,server)=>
      new URL(request.url).pathname==='/runner/v1/relay/connect'?relay.upgradeLocal(request,server):route(request)});
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
        return route(request,true);
      }});
    }
    if(config.agent) {
      // The agents' entrance over the network (docs/architecture/RUNNERS.md): the same routes the
      // local socket serves, for a caller that proves an agent run or a runner with a signed token.
      const key=Buffer.from(config.agent.keyHex,'hex');
      agent=Bun.serve({hostname:config.agent.hostname,port:config.agent.port,idleTimeout:0,websocket:relay.handlers,fetch:async(request:Request,server)=>{
        const authorization=request.headers.get('authorization')??'';
        const verified=authorization.startsWith('Bearer ')?verifyAgentToken(key,authorization.slice(7)):null;
        if(!verified)return Response.json({ok:false,error:'AGENT_UNAUTHORIZED',detail:'A valid agent run or runner token is required.'},{status:401});
        // Process-control entrances, including the event-stream page, stay on the local socket.
        const pathname=new URL(request.url).pathname;
        if(pathname.startsWith('/internal/'))return Response.json({error:'Unknown request API route.'},{status:404});
        if(pathname==='/runner/v1/relay/listen'||pathname==='/runner/v1/relay/accept')return relay.upgradeRunner(request,server,agentPrincipalHeader(verified));
        const headers=new Headers(request.headers);headers.delete('authorization');
        return route(new Request(request,{headers}),false,agentPrincipalHeader(verified));
      }});
    }
    return {stop,snapshot:()=>pool.snapshot(),relay:()=>relay.snapshot()};
  } catch(error){await stop(true);throw error;}
}
