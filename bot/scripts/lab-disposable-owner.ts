/**
 * A disposable Concierge owner for end-to-end Lab group tests in thnkr.ing's isolated agent workspace.
 *
 * It opens a fresh, empty ledger in a new root-only /tmp/concierge-lab-owner-* directory (nothing of
 * Tejas's is copied into it), runs real participants through the ordinary execution host, listens on
 * <dir>/owner.sock for the workspace's Lab relay, and on exit stops only its own turns, its own Codex
 * App Server, and removes the directory (unless --keep). Never runs on import or without --run.
 *
 *   bun bot/scripts/lab-disposable-owner.ts --run \
 *     --capability-socket /tmp/thnkr-agent-capabilities-<port>/session.sock \
 *     --deadline-seconds 1800 [--max-turns 24] [--keep]
 */
import {chmodSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LAB_CONVERSATIONS_TEST_AUTHORIZATION} from '../src/test-authorizations';

const usage='bun bot/scripts/lab-disposable-owner.ts --run --capability-socket /tmp/thnkr-agent-capabilities-<port>/session.sock --deadline-seconds <60-7200> [--max-turns <1-60>] [--keep]';
const args=process.argv.slice(2);
if(args.length===1&&args[0]==='--help'){console.log(usage);process.exit(0);}
const flags=new Map<string,string|true>();
if(args[0]!=='--run')throw new Error(`Explicit opt-in required. ${usage}`);
for(let i=1;i<args.length;i++){
 const name=args[i]!;
 if(name==='--keep'){flags.set(name,true);continue;}
 if(!['--capability-socket','--deadline-seconds','--max-turns'].includes(name)||args[i+1]===undefined||flags.has(name))throw new Error(`Unexpected argument ${name}. ${usage}`);
 flags.set(name,args[++i]!);
}
const capabilitySocket=String(flags.get('--capability-socket')??''),seconds=Number(flags.get('--deadline-seconds')),maxTurns=Number(flags.get('--max-turns')??24),keep=flags.has('--keep');
// Lab bootstrap, context and publication go to the isolated workspace, never to his live thnkr.ing.
if(!/^\/tmp\/thnkr-agent-capabilities-[0-9]+\/session\.sock$/.test(capabilitySocket))throw new Error('Refused: --capability-socket must be an isolated agent workspace socket (/tmp/thnkr-agent-capabilities-<port>/session.sock).');
if(!Number.isSafeInteger(seconds)||seconds<60||seconds>7200)throw new Error('Refused: --deadline-seconds must be 60-7200.');
if(!Number.isSafeInteger(maxTurns)||maxTurns<1||maxTurns>60)throw new Error('Refused: --max-turns must be 1-60.');
if(process.getuid?.()!==0)throw new Error('Refused: run as root so the owner directory is root-private.');

const stateDir=mkdtempSync('/tmp/concierge-lab-owner-');
chmodSync(stateDir,0o700);
const stat=lstatSync(stateDir);
if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(stateDir)!==stateDir||(stat.mode&0o077)!==0)throw new Error('Refused: owner directory is not private.');

// Mirror the normal client's scanner without printing argv. Its guards remain enabled.
function guardInventory(){
 const result:Array<{pid:number;cgroup:string;soft:number;hard:number;proxy:boolean}>=[];
 for(const id of readdirSync('/proc')){if(!/^\d+$/.test(id))continue;try{
  const argv=readFileSync(`/proc/${id}/cmdline`,'utf8').split('\0').filter(Boolean);
  if(!/(^|\/)codex$/.test(argv[0]??'')||!argv.includes('app-server')||argv.includes('--stdio'))continue;
  const cgroup=readFileSync(`/proc/${id}/cgroup`,'utf8').trim().replace(/^0::/,'');
  const line=readFileSync(`/proc/${id}/limits`,'utf8').split('\n').find(x=>x.startsWith('Max open files'));
  const limits=line?.match(/(\d+|unlimited)\s+(\d+|unlimited)/);if(!limits)throw new Error('unreadable limit');
  const n=(s:string)=>s==='unlimited'?Infinity:Number(s);result.push({pid:Number(id),cgroup,soft:n(limits[1]!),hard:n(limits[2]!),proxy:argv.includes('proxy')});
 }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
 return result;
}
function requireGuardNoop(){
 if(guardInventory().some(x=>(!x.proxy&&!/^\/agents\.slice\/codex-app-server(-\d+)?\.scope$/.test(x.cgroup))||x.soft<x.hard))
  throw new Error('Refused: normal Codex guards would change an observed process.');
}
requireGuardNoop();

// Clear inherited routing before importing modules that capture process configuration.
for(const key of ['CONCIERGE_CODEX_RUNNER','CONCIERGE_TURN_RUNNERS','CONCIERGE_TURN_RUNNER','CONCIERGE_RUNNER_STATE','CONCIERGE_RUNNER_TOKEN_FILE','CONCIERGE_OWNER_URL','CONCIERGE_AGENT_TOKEN','CONCIERGE_THINKERING_CAPABILITY_URL','CONCIERGE_THINKERING_TOKEN_FILE','CONCIERGE_AGENT_API_URL'])delete process.env[key];
Object.assign(process.env,{CONCIERGE_STATE_DIR:stateDir,CONCIERGE_CAPTURE_STATE_DIR:join(stateDir,'capture'),CONCIERGE_TEST_MODE:'1',
 CONCIERGE_TEST_AUTHORIZATION:LAB_CONVERSATIONS_TEST_AUTHORIZATION,CONCIERGE_EXECUTION_HOSTS:'0',THINKERING_SESSION_CAPABILITY_SOCKET:capabilitySocket,
 CONCIERGE_SESSION_CAPABILITY_SOCKET:capabilitySocket,CONCIERGE_CODEX_APP_SERVER_SOCKET:join(stateDir,'codex.sock')});
mkdirSync(join(stateDir,'capture'),{mode:0o700});
const [{agentTokenKey,mintAgentToken,verifyAgentToken,agentPrincipalHeader},{writeRunnerConnection},{SessionExecutionHost},{ActiveTurnDispatchRegistry},{providers},{claimNextQueuedTurn,registerProcessInstance,db},{currentProcessIdentity},{holdCodexDaemonAutoStart},{closeSharedCodexAppServerClient},{SessionCommunicationCoordinator},{requestApiHandler}]=await Promise.all([
 import('../src/agent-run-tokens'),import('../src/runner-machine'),import('../src/session-execution-host'),import('../src/turn-dispatch-seams'),import('../src/providers'),import('../src/state'),import('../src/runtime-identity'),import('../src/codex-daemon-file-limit'),import('../src/codex-app-server-client'),import('../src/session-communication'),import('../src/routed-request-api')]);
// A missing disposable socket must never trigger the ordinary production daemon recovery.
holdCodexDaemonAutoStart(true);
const key=agentTokenKey(stateDir),tokenFile=join(stateDir,'runner.token');
await Bun.write(tokenFile,mintAgentToken(key,{kind:'runner',runner:'lab-disposable-owner'}));chmodSync(tokenFile,0o600);
const instanceId=randomUUID(),identity=currentProcessIdentity();registerProcessInstance(instanceId,identity.pid,identity.bootId,identity.startTicks);
let stopping=false,active=0,starts=0,refusedOverBudget=0;
const claimed=new Set<number>(),running=new Map<number,number>();
const registry=new ActiveTurnDispatchRegistry({onStarted(){},onSettled(){}});
const host=new SessionExecutionHost({instanceId,registry,providers,defaultCwd:'/root/workspace',capabilitySocket,wake(){},thesaurusContext:async()=>''});
// Account switching is host-wide upkeep and must not run in this disposable owner.
(host as any).stopCodexMoves();
const owner=host.owner;
const communication=new SessionCommunicationCoordinator({owner,isOwnerAlive:id=>id===instanceId,onError:error=>{console.error('Communication reconciliation failed:',String(error));}});
owner.communication=communication;
const routed=requestApiHandler(null,undefined,communication,owner);

const bad=(status:number,code:string,message:string)=>Response.json({error:{code,message}},{status});
// The isolated workspace offers no ChatGPT run capability (its chatgpt slot is null), so a ChatGPT
// voice would be admitted and then fail; refuse it up front with the reason.
function refusedChoice(choice:any):string|null {
 if(choice?.provider==='chatgpt')return 'ChatGPT voices cannot run here: the isolated agent workspace has no ChatGPT run capability.';
 if(choice?.sessionId&&!ownedSession(choice.sessionId))return 'Only sessions created in this disposable owner can join.';
 return null;
}
function ownedSession(address:string){const match=/^concierge:([1-9][0-9]*)$/.exec(address);return !!match&&!!db.query('SELECT 1 FROM sessions WHERE id=?').get(Number(match[1]));}
const HOOKS=['/session-communication/owed','/session-communication/model-start-gate','/session-communication/outcome','/session-communication/obligations'];
function hookTurn(body:any){
 const select=`SELECT turn.id,turn.native_run_id FROM turns turn JOIN sessions session ON session.id=turn.session_id`;
 if(typeof body?.source?.input_id==='string'&&typeof body?.source?.run_id==='string')
  return db.query(`${select} WHERE turn.accepted_input_id=? AND turn.native_run_id=?`).get(body.source.input_id,body.source.run_id) as {id:number}|null;
 const providerSession=body?.provider_session_id??body?.providerSessionId;
 if(typeof providerSession==='string'&&providerSession)
  return db.query(`${select} WHERE session.agent_session_uuid=? ORDER BY turn.id DESC LIMIT 1`).get(providerSession) as {id:number}|null;
 if(Number.isSafeInteger(body?.ownerTurnId)&&typeof body?.sourceRunId==='string')
  return db.query(`${select} WHERE turn.id=? AND turn.native_run_id=?`).get(body.ownerTurnId,body.sourceRunId) as {id:number}|null;
 return null;
}
/** Every read serves this fresh ledger only; writes are limited to Lab commands and participants' own hooks. */
async function guarded(request:Request){
 const url=new URL(request.url),path=url.pathname;
 if(path==='/disposable/status'&&request.method==='GET')return Response.json({stateDir,starts,active,maxTurns,refusedOverBudget,deadlineMs});
 if(request.method==='POST'&&HOOKS.includes(path)){
  const turn=hookTurn(await request.clone().json().catch(()=>null));
  if(!turn||!claimed.has(turn.id))return bad(400,'NOT_AN_OWNED_TURN','The hook does not identify a turn of this disposable owner.');
  return routed(request);
 }
 if(path.startsWith('/sessions/v1/lab/conversations')&&request.method==='POST'){
  if(stopping)return bad(503,'DISPOSABLE_OWNER_STOPPING','This disposable owner is stopping.');
  const body:any=await request.clone().json().catch(()=>null);
  for(const choice of [...(Array.isArray(body?.participants)?body.participants:[]),...(Array.isArray(body?.add)?body.add:[])]){
   const refusal=refusedChoice(choice);if(refusal)return bad(409,'LAB_PARTICIPANT_UNAVAILABLE',refusal);
  }
  return await owner.handle(request)??new Response(null,{status:404});
 }
 if(request.method==='GET'&&(path==='/sessions/v1'||path.startsWith('/sessions/v1/')))return await owner.handle(request)??new Response(null,{status:404});
 return bad(404,'NOT_IN_DISPOSABLE_SCOPE','This disposable owner serves Lab commands, participant hooks and reads of its own ledger.');
}
const deadlineMs=Date.now()+seconds*1000;
let local:any=null,gateway:any=null,server:any=null,timer:ReturnType<typeof setInterval>|null=null;
const requestStop=()=>{stopping=true;};process.once('SIGINT',requestStop);process.once('SIGTERM',requestStop);
let exitCode=0;
try {
 local=Bun.serve({unix:join(stateDir,'owner.sock'),idleTimeout:0,fetch:guarded});chmodSync(join(stateDir,'owner.sock'),0o600);
 // Participants' own commands (router-actions) reach this owner through an authenticated loopback entrance.
 gateway=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,fetch:async (request:Request)=>{
  const auth=request.headers.get('authorization')??'',principal=auth.startsWith('Bearer ')?verifyAgentToken(key,auth.slice(7)):null;
  if(!principal)return Response.json({error:'AGENT_UNAUTHORIZED'},{status:401});
  const headers=new Headers(request.headers);headers.delete('authorization');headers.set('x-concierge-agent-principal',agentPrincipalHeader(principal));
  return guarded(new Request(request,{headers}));
 }});
 host.markOwnerServing();
 const origin=`http://127.0.0.1:${gateway.port}`;
 writeRunnerConnection(stateDir,{ownerUrl:origin,tokenFile,thinkeringUrl:null});
 process.env.CONCIERGE_RUNNER_STATE=stateDir;process.env.CONCIERGE_AGENT_API_URL=origin;
 if((await fetch(`${origin}/disposable/status`)).status!==401)throw new Error('Unauthenticated loopback entrance did not refuse.');
 const codex=process.env.CONCIERGE_CODEX_EXECUTABLE?.trim()||'/root/.codex/packages/standalone/current/codex';
 if(existsSync(codex)){
  server=Bun.spawn(['systemd-run','--scope',`--unit=codex-app-server-${process.pid}`,'--slice=agents.slice','--collect','--quiet',codex,'app-server','--listen',`unix://${join(stateDir,'codex.sock')}`],{env:process.env,stdout:'ignore',stderr:'inherit'});
  for(let i=0;i<200&&!existsSync(join(stateDir,'codex.sock'));i++){if(server.exitCode!==null)break;await Bun.sleep(100);}
  if(!existsSync(join(stateDir,'codex.sock')))console.error('Disposable Codex App Server did not listen; Codex voices will fail.');
  requireGuardNoop();
 }
 communication.start();
 let observing=false;
 async function tick(){if(observing||stopping)return;observing=true;try{
  await owner.labConversations.reconcile();
  for(;;){
   if(starts>=maxTurns){if(claimNextQueuedTurnPeek())refusedOverBudget++;break;}
   const claim=claimNextQueuedTurn(instanceId,Date.now(),registry.activeSessions);if(!claim)break;
   if(claimed.has(claim.turn_id))throw new Error('Refused to resubmit a previously claimed invocation.');
   claimed.add(claim.turn_id);running.set(claim.turn_id,claim.session_id);starts++;active++;
   void host.run(claim).catch(error=>{host.settleSetupFailure(claim,error);console.error('Provider turn failed:',String(error));}).finally(()=>{active--;running.delete(claim.turn_id);});
  }
 }catch(error){console.error('Observation failed:',String(error));}finally{observing=false;}}
 function claimNextQueuedTurnPeek(){return !!db.query("SELECT 1 FROM turns WHERE status='queued' LIMIT 1").get();}
 timer=setInterval(()=>void tick(),500);
 console.log(JSON.stringify({ready:true,ownerSocket:join(stateDir,'owner.sock'),stateDir,deadline:new Date(deadlineMs).toISOString(),maxTurns,
  providers:{'claude-code':'runs','codex':existsSync(join(stateDir,'codex.sock'))?'runs if the Codex account has allowance':'unavailable','chatgpt':'refused: isolated workspace has no ChatGPT capability'}}));
 while(Date.now()<deadlineMs&&!stopping)await Bun.sleep(250);
} catch(error){exitCode=1;console.error(String(error));
} finally {
 stopping=true;if(timer)clearInterval(timer);await Promise.race([communication.stop(),Bun.sleep(5000)]);owner.labConversations.stop();
 // Stop only this owner's exact turns; preserve uncertainty if no terminal receipt arrives.
 const stops=[...running].map(([turn,session])=>{
  const row=db.query('SELECT native_run_id AS runId FROM turns WHERE id=? AND session_id=?').get(turn,session) as {runId:string|null}|null;
  return row?.runId?owner.stop(`concierge:${session}`,{clientActionId:`disposable-deadline-stop-${turn}`,runId:row.runId}):null;
 });
 await Promise.race([Promise.allSettled(stops.flatMap(s=>s?[s]:[])),Bun.sleep(15000)]);
 const waitUntil=Date.now()+15000;while(active&&Date.now()<waitUntil)await Bun.sleep(200);
 const unconfirmed=[...running.keys()];
 await Promise.race([host.stop(),Bun.sleep(5000)]);await Promise.race([closeSharedCodexAppServerClient(),Bun.sleep(5000)]);
 await local?.stop(true);await gateway?.stop(true);
 if(server){const stop=Bun.spawn(['systemctl','stop',`codex-app-server-${process.pid}.scope`],{stdout:'ignore',stderr:'inherit'});await Promise.race([stop.exited,Bun.sleep(5000)]);await Promise.race([server.exited,Bun.sleep(5000)]);}
 db.close();
 // The directory holds only this disposable ledger and sockets; it is removed unless kept for inspection.
 if(!keep&&resolve(stateDir).startsWith('/tmp/concierge-lab-owner-'))rmSync(stateDir,{recursive:true,force:true});
 console.log(JSON.stringify({stopped:true,starts,refusedOverBudget,unconfirmed,stateDir,removed:!keep}));
}
process.exit(exitCode);
