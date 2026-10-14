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
import {ledgerDurable} from './ledger-durability-barrier';
import {ledgerDurabilityCounters,startLedgerDurability} from './ledger-durability';
import {isTransientDatabaseError} from './database-retry';
import {getAcceptedSessionInput} from './session-inputs';
import {supersededBy,supersededAddress,withdrawnSuccessor} from './session-handoff';
import {recordDeploymentReleasePrepared,recordDeploymentReleaseActivationIntent,
  recordDeploymentReleaseActivated,registerDeploymentTurnReactionTargets,
  recordDeploymentTurnReactionDiscoveryFailure,claimDeploymentRun,recordDeploymentRunPhase} from './deployment-state';

function requestFailure(request:Request,error:unknown):Response {
  const transient=isTransientDatabaseError(error);
  const code=String((error as {code?:unknown})?.code??'');
  if(transient||/^SQLITE_[A-Z_]+$/.test(code)) {
    const path=new URL(request.url).pathname;
    const operation=/^\/(?:session-communication|external)\/([a-z-]+)$/.exec(path)?.[1]??'other';
    const stack=error instanceof Error?error.stack?.split('\n').filter(line=>/^\s+at /.test(line)).slice(0,5).map(line=>line.trim().slice(0,300)):undefined;
    log('error','native_command_database_failed',{operation,code:/^SQLITE_[A-Z_]+$/.test(code)?code:'SQLITE_BUSY',transient,stack});
  }
  return Response.json({error:error instanceof Error?error.message:'Request API failed.'},{status:transient?503:400});
}

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
        const sourceInput=typeof input?.source?.input_id==='string'?getAcceptedSessionInput(input.source.input_id):null;
        const successor=sourceInput?supersededBy(sourceInput.session_id):null;
        const withdrawn=sourceInput?withdrawnSuccessor(sourceInput.session_id):false;
        const readOnly=operation==='search'||operation==='projects'||operation==='peers'||operation==='usage'
          ||operation==='get'||operation==='context'||operation==='obligations'
          ||operation==='board'&&input.verb==='read'||operation==='watch'&&input.verb==='list'
          ||operation==='saved'&&input.verb==='list'||operation==='topics'&&['read','list','questions'].includes(input.verb);
        if(successor&&operation!=='outcome'&&!readOnly)
          return Response.json({error:`This session is superseded by ${successor}; use ${supersededAddress(sourceInput!.session_id)} for owner writes.`,successor,successorAddress:supersededAddress(sourceInput!.session_id),code:'SESSION_SUPERSEDED'},{status:409});
        if(withdrawn&&operation!=='outcome'&&!readOnly)
          return Response.json({error:'This proposed handoff was withdrawn; this successor cannot write.',code:'HANDOFF_WITHDRAWN'},{status:409});
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
        if (operation === 'handoff') return Response.json(await sessions.handoff(input));
        if (operation === 'obligations') return Response.json(await sessions.obligations(input));
        if (operation === 'open') return Response.json(await sessions.openLink(input));
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
      return requestFailure(request,error);
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
        return Response.json({ok:true,pid:process.pid,startedAt,release,logging:logSinkCounters(),ledgerDurability:ledgerDurabilityCounters()});
      if(request.method==='POST'&&url.pathname==='/internal/deployment-release'&&owner){
        const input=await request.json() as any;
        if(!/^[0-9a-f-]{36}$/.test(input?.runId??''))throw new Error('Invalid deployment run.');
        if(input.operation==='prepared')return Response.json(recordDeploymentReleasePrepared(input.runId,input.artifactPath,input.manifest));
        if(input.operation==='activation-intent')return Response.json(recordDeploymentReleaseActivationIntent(input.runId,input.artifactDigest,input.allowSupersede===true));
        if(input.operation==='reaction-targets')return Response.json(registerDeploymentTurnReactionTargets(input.runId,input.targets,'deploying'));
        if(input.operation==='reaction-discovery-failed'){
          recordDeploymentTurnReactionDiscoveryFailure(input.runId,input.message);
          return Response.json({ok:true});
        }
        if(input.operation==='activated'){
          recordDeploymentReleaseActivated(input.runId,input.artifactDigest);
          return Response.json({ok:true});
        }
        throw new Error('Unknown deployment release operation.');
      }
      if(request.method==='POST'&&url.pathname==='/internal/deployment-run'&&owner){
        const input=await request.json() as any;
        if(!/^[0-9a-f-]{36}$/.test(input?.runId??''))throw new Error('Invalid deployment run.');
        if(input.operation==='claim'){
          if(!Number.isSafeInteger(input.pid)||input.pid<=1||typeof input.bootId!=='string'||typeof input.startTicks!=='string')
            throw new Error('Invalid deployment runner identity.');
          return Response.json(claimDeploymentRun({runId:input.runId,pid:input.pid,bootId:input.bootId,startTicks:input.startTicks}));
        }
        if(input.operation==='phase'){
          if(!['updating','restarting','verifying','releasing'].includes(input.phase)
            ||!input.detail||typeof input.detail!=='object'||Array.isArray(input.detail))
            throw new Error('Invalid deployment phase.');
          return Response.json(recordDeploymentRunPhase(input.runId,input.phase,input.detail));
        }
        throw new Error('Unknown deployment run operation.');
      }
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
      return requestFailure(request,error);
    }
  };
}

export async function startRoutedRequestApi(stateDir: string, coordinator: RoutedRequestCoordinator | null, workspaceUrl?: string | null, sessions?:SessionCommunicationCoordinator,owner?:SessionOwner,peer?:ForegroundPeer|null) {
  const path = join(stateDir, "request-owner.sock");
  // A killed listener leaves its filesystem entry behind; normal close removes it.
  await removeUnboundSocket(path);
  const handle=localOwnerRequestApiHandler(requestApiHandler(coordinator,workspaceUrl,sessions,owner),sessions,owner);
  const server = Bun.serve({
    unix: path,
    idleTimeout: 0,
    // A command's answer is its receipt, so it leaves only once the rows it reports are on disk.
    // Reads answer at once: the supervisor's liveness ping must never wait for the disk.
    fetch: async request=>{
      try {
        const response=await handle(request);
        if(request.method!=='GET')await ledgerDurable();
        return response;
      } catch(error) {return requestFailure(request,error);}
    },
  });
  if(owner)startLedgerDurability(stateDir);
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
