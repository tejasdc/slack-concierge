import {readFileSync} from "node:fs";
import {chmod} from "node:fs/promises";
import {removeUnboundSocket} from "./private-api-socket";
import {startForegroundGatewayProcess,type ForegroundPeer} from "./foreground-gateway-supervisor";
import { join } from "node:path";
import { lookupExecutions, readRoutedRequest, RETIRED_SLACK_ROUTING, type RoutedRequestCoordinator } from "./routed-requests";
import type { SessionCommunicationCoordinator } from './session-communication';
import type {SessionOwner} from './session-owner';
import {usageBreakdown} from './usage-breakdown';
import {startPresentationWorker} from './presentation-worker-supervisor';
import {log,logSinkCounters} from './log';

/** Routes shared by the root-only owner socket and the authenticated peer listener. */
const startedAt=new Date().toISOString();
const release=(()=>{
  const supplied=process.env.CONCIERGE_RUNTIME_GIT_SHA;
  if(/^[0-9a-f]{40}$/.test(supplied??''))return supplied!;
  try {const commit=JSON.parse(readFileSync(process.env.CONCIERGE_RELEASE_MANIFEST??'', 'utf8')).git_commit;
    return /^[0-9a-f]{40}$/.test(commit)?commit:null;} catch{return null;}
})();
export function requestApiHandler(_coordinator: RoutedRequestCoordinator | null, workspaceUrl?: string | null, sessions?:SessionCommunicationCoordinator,owner?:SessionOwner) {
  return async function fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const native=await owner?.handle(request);
      if(native)return native;
      if (request.method === 'POST' && url.pathname.startsWith('/session-communication/') && sessions) {
        const operation = url.pathname.slice('/session-communication/'.length);
        const input = await request.json();
        if (operation === 'search') return Response.json(await sessions.search(input));
        if (operation === 'projects') return Response.json(await sessions.projects(input));
        if (operation === 'peers') return Response.json(await sessions.peerInventory(input));
        if (operation === 'usage') {
          const current=sessions.usage(input);
          return Response.json(input.by_session
            ? await usageBreakdown(input.period==='week'?'week':'today') : current);
        }
        if (operation === 'saved') return Response.json(sessions.saved(input));
        if (operation === 'watch') return Response.json(sessions.watch(input));
        if (operation === 'board') return Response.json(await sessions.board(input));
        if (operation === 'owed') return Response.json(sessions.owed(input));
        if (operation === 'note') return Response.json(await sessions.note(input));
        if (operation === 'title') return Response.json(sessions.title(input));
        if (operation === 'move') return Response.json(sessions.move(input));
        if (operation === 'post') return Response.json(sessions.post(input));
        if (operation === 'outcome') return Response.json(sessions.outcome(input));
        if (operation === 'thread') return Response.json(sessions.thread(input));
        if (operation === 'topics') return Response.json(sessions.topics(input));
        if (operation === 'context') return Response.json(await sessions.context(input));
        if (operation === 'ask') return Response.json(await sessions.ask(input), {status:202});
        if (operation === 'reply') return Response.json(await sessions.reply(input));
        if (operation === 'get') return Response.json(sessions.get(input));
        if (operation === 'cancel') return Response.json(sessions.cancel(input));
      }
      if (request.method === 'POST' && (url.pathname === '/requests' || /^\/requests\/[0-9a-f-]+\/recover$/.test(url.pathname)))
        return Response.json({error:RETIRED_SLACK_ROUTING,code:'slack_routing_retired'},{status:410});
      if (request.method === 'GET' && url.pathname.startsWith('/requests/')) {
        return Response.json(readRoutedRequest(url.pathname.slice('/requests/'.length)));
      }
      if (request.method === 'GET' && url.pathname === '/executions') {
        const parameters = url.searchParams;
        return Response.json(lookupExecutions({ channel: parameters.get('channel') || '', beforeTs: parameters.get('before_ts') || '',
          rootTs: parameters.get('root_ts') || undefined,
          sessionId: parameters.has('session_id') ? Number(parameters.get('session_id')) : undefined,
          turnId: parameters.has('turn_id') ? Number(parameters.get('turn_id')) : undefined }, workspaceUrl));
      }
      return Response.json({ error: 'Unknown request API route.' }, { status: 404 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Request API failed.' }, { status: 400 });
    }
  };
}

/** Capabilities installed only on the root-private Unix socket, never on the peer listener. */
function localOwnerRequestApiHandler(shared:(request:Request)=>Promise<Response>,sessions?:SessionCommunicationCoordinator,owner?:SessionOwner) {
  return async function fetch(request:Request):Promise<Response> {
    try {
      const url=new URL(request.url);
      if(request.method==='GET'&&url.pathname==='/internal/auth-ephemera'&&owner)
        return Response.json(owner.authEphemera());
      if(request.method==='POST'&&url.pathname==='/internal/auth-refresh'&&owner)
        return Response.json(await owner.refreshAuthEphemera());
      if(request.method==='GET'&&url.pathname==='/supervisor/ping')
        return Response.json({ok:true,pid:process.pid,startedAt,release,logging:logSinkCounters()});
      if(request.method==='POST'&&url.pathname==='/external/capture'&&owner) {
        const input=await request.json() as any;
        if(!/^[a-z][a-z0-9-]{2,40}$/.test(input?.name))throw new Error('Invalid outside agent name.');
        return Response.json(owner.acceptInboxCapture({source:{kind:'outside-agent',id:input.id,recordedAt:input.recordedAt,
          title:`Outside agent · ${input.name}`,metadata:{outsideAgent:input.name}},text:input.text,files:input.files}),{status:202});
      }
      if(request.method==='POST'&&url.pathname==='/external/ask'&&sessions)
        return Response.json(sessions.externalAsk(await request.json()),{status:202});
      if(request.method==='POST'&&url.pathname==='/external/get'&&sessions){
        const input=await request.json() as {name:string;request_id:string};
        return Response.json(sessions.externalGet(input.name,input.request_id));
      }
      return shared(request);
    } catch(error) {
      return Response.json({error:error instanceof Error?error.message:'Request API failed.'},{status:400});
    }
  };
}

export async function startRoutedRequestApi(stateDir: string, coordinator: RoutedRequestCoordinator | null, workspaceUrl?: string | null, sessions?:SessionCommunicationCoordinator,owner?:SessionOwner,peer?:ForegroundPeer|null) {
  const path = join(stateDir, "request-owner.sock");
  // A killed listener leaves its filesystem entry behind; normal close removes it.
  await removeUnboundSocket(path);
  const server = Bun.serve({
    unix: path,
    idleTimeout: 0,
    fetch: localOwnerRequestApiHandler(requestApiHandler(coordinator,workspaceUrl,sessions,owner),sessions,owner),
  });
  let stopPresentation:ReturnType<typeof startPresentationWorker>|undefined;
  let stopGateway:((force?:boolean)=>Promise<void>)|undefined;
  try {
    await chmod(path, 0o600);
    // First-run creation belongs to the canonical writer, never to a GET reader.
    try {owner?.inbox();}
    catch(error) {
      // A machine without the Inbox project can still serve its other sessions.
      // It retains the same explicit unavailable capability as the old Inbox GET.
      if((error as {code?:string}).code!=='PROJECT_UNAVAILABLE')throw error;
      log('info','inbox_project_unavailable_at_startup');
    }
    // Every accepting canonical owner serves prepared reads, regardless of its adapters.
    // Start only after the exclusive socket bind, so a refused second owner spawns nothing.
    if(owner)stopPresentation=startPresentationWorker();
    stopGateway=await startForegroundGatewayProcess(stateDir,path,peer);
  } catch(error) {
    await server.stop(true);
    await stopPresentation?.();
    throw error;
  }
  let stopping:Promise<void>|null=null;
  return {stop:(closeActiveConnections=false)=>stopping??=(async()=>{
    try {await stopGateway?.(closeActiveConnections);await server.stop(closeActiveConnections);}
    finally {await stopPresentation?.();}
  })()};
}
