import {db} from './state';
import {agentTokenKey,mintAgentToken} from './agent-run-tokens';
import {RunnerLeases,RunnerProtocolError} from './runner-leases';

/**
 * The owner's runner protocol routes (docs/architecture/RUNNERS.md). A runner reaches them only
 * through the agents' network entrance, which names it in `x-concierge-agent-principal` after
 * checking its signed runner token; the header is stripped from every other caller. Two routes
 * serve the owner's own machine instead: minting a runner's token (local socket only) and the
 * marked probe job any agent may queue to check the runner path end to end.
 */
let leases:RunnerLeases|null=null;
const engine=()=>leases??=new RunnerLeases(db);
const RUNNER=/^runner:([a-z][a-z0-9-]{1,40})$/;
const PROBE_KINDS=['probe'];

function fail(error:unknown):Response {
  if(error instanceof RunnerProtocolError)
    return Response.json({ok:false,error:error.code,detail:error.message},{status:error.code==='STALE_EPOCH'||error.code==='CONFLICT'?409:error.code==='INVALID'?400:404});
  throw error;
}

export async function runnerRoutes(request:Request,url:URL):Promise<Response> {
  const principal=request.headers.get('x-concierge-agent-principal');
  const path=url.pathname.slice('/runner/v1/'.length);
  try {
    if(request.method==='POST'&&path==='token') {
      // Only the owner's own machine (its root-private socket) may create a runner's credential.
      if(principal)return Response.json({ok:false,error:'LOCAL_ONLY'},{status:403});
      const input=await request.json() as {runner?:unknown};
      if(typeof input.runner!=='string'||!/^[a-z][a-z0-9-]{1,40}$/.test(input.runner))
        return Response.json({ok:false,error:'INVALID',detail:'Name the runner with lowercase letters, digits and dashes.'},{status:400});
      const directory=process.env.CONCIERGE_STATE_DIR;
      if(!directory)return Response.json({ok:false,error:'UNAVAILABLE'},{status:503});
      return Response.json({ok:true,runner:input.runner,token:mintAgentToken(agentTokenKey(directory),{kind:'runner',runner:input.runner})});
    }
    if(request.method==='POST'&&path==='probes') {
      // A marked probe: a runner that claims it echoes it back, proving claim, heartbeat, events and finish.
      const input=await request.json() as {probeId?:unknown;text?:unknown};
      if(typeof input.probeId!=='string'||!/^[A-Za-z0-9_-]{8,80}$/.test(input.probeId))
        return Response.json({ok:false,error:'INVALID',detail:'A probe needs a stable probeId.'},{status:400});
      const queued=engine().enqueue({jobId:`probe:${input.probeId}`,kind:'probe',replaySafe:true,
        payload:{text:typeof input.text==='string'?input.text.slice(0,500):'runner probe',requestedBy:principal??'local'}});
      return Response.json({ok:true,...queued},{status:queued.created?201:200});
    }
    if(request.method==='GET'&&path.startsWith('jobs/')) {
      const job=engine().job(decodeURIComponent(path.slice('jobs/'.length)),Number(url.searchParams.get('after')??0)||0);
      return job?Response.json({ok:true,job}):Response.json({ok:false,error:'UNKNOWN_JOB'},{status:404});
    }
    const runner=RUNNER.exec(principal??'')?.[1];
    if(!runner)return Response.json({ok:false,error:'RUNNER_ONLY',detail:'Runner routes need a runner token.'},{status:403});
    if(request.method!=='POST')return Response.json({ok:false,error:'NOT_FOUND'},{status:404});
    const input=await request.json() as any;
    if(path==='claim'){
      const kinds=Array.isArray(input.kinds)?input.kinds.filter((kind:unknown)=>typeof kind==='string'):PROBE_KINDS;
      return Response.json({ok:true,job:engine().claim(runner,kinds)});
    }
    if(path==='reacquire')return Response.json({ok:true,attempts:engine().reacquire(runner,Array.isArray(input.attemptIds)?input.attemptIds.map(String):[])});
    const attemptId=String(input.attemptId??''),epoch=Number(input.epoch);
    if(path==='heartbeat')return Response.json({ok:true,...engine().heartbeat(runner,attemptId,epoch)});
    if(path==='events')return Response.json({ok:true,...engine().appendEvents(runner,attemptId,epoch,Array.isArray(input.events)?input.events:[])});
    if(path==='command-results')return Response.json({ok:true,...engine().commandResults(runner,attemptId,epoch,Array.isArray(input.results)?input.results:[])});
    if(path==='finish'){
      if(typeof input.operationId!=='string'||!input.operationId)throw new RunnerProtocolError('INVALID','A finish needs its operation id.');
      return Response.json({ok:true,...engine().finish(runner,attemptId,epoch,input.operationId,input.result??null)});
    }
    return Response.json({ok:false,error:'NOT_FOUND'},{status:404});
  } catch(error){return fail(error);}
}
