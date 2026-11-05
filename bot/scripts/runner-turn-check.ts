/**
 * Proof of "Turns on a runner" (docs/architecture/RUNNERS.md) with real parts: a scratch owner
 * ledger, the owner's runner routes behind runner-token checks, the real runner daemon in its own
 * process, and real execution hosts started by that daemon under systemd. A scripted provider stands
 * in for Claude. The owner side is the unchanged HostedClaudeCodeTransport over RunnerHostAccess.
 *
 * It checks: a turn's output, a follow-up write and its receipt, close and exit; the provider's
 * environment is the runner's (not the owner's) and carries the run's token and owner address;
 * attachment bytes travel in the job; release only after settlement finishes the job; a coordinator
 * taking the run back replays its record; a killed and restarted runner reacquires the turn at a new
 * epoch and the turn continues with no frame lost or repeated; an unclaimed turn is withdrawn
 * unstarted; a provider the runner cannot find is the runner's definite refusal.
 *
 * Run: bun scripts/runner-turn-check.ts (needs systemd-run; uses a scratch folder in the checkout,
 * because units started under systemd do not see a sandbox's private /tmp).
 */
import {strict as assert} from 'node:assert';
import {Database} from 'bun:sqlite';
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn,spawnSync,type ChildProcess} from 'node:child_process';

const scratchParent=resolve(import.meta.dir,'../../tmp');
mkdirSync(scratchParent,{recursive:true});
const root=mkdtempSync(join(scratchParent,'runner-turn-check-'));
const ownerState=join(root,'owner'),runnerState=join(root,'runner');
mkdirSync(ownerState,{recursive:true,mode:0o700});
process.env.CONCIERGE_STATE_DIR=ownerState;
process.env.CONCIERGE_RUNNER_CLAIM_MS='20000';
// A value only the owner's process holds: it must never reach a runner's provider.
process.env.OWNER_ONLY_SENTINEL='owner-environment-leaked';

const db=new Database(':memory:');
const {initializeRunnerSchema,RunnerLeases}=await import('../src/runner-leases');
initializeRunnerSchema(db);
(await import('../src/runner-ledger')).useRunnerLedger(new RunnerLeases(db));
const {agentTokenKey,mintAgentToken,verifyAgentToken}=await import('../src/agent-run-tokens');
const {runnerRoutes}=await import('../src/runner-routes');
const {RunnerHostAccess,turnJobId}=await import('../src/runner-host-access');
const {HostedClaudeCodeTransport,HostNotStartedError,newExecutionId}=await import('../src/execution-host-client');

const key=agentTokenKey(ownerState);
// A rollback stand-in: an older owner had runner routes but no sync, and answered NOT_FOUND.
let olderOwner=false;
const server=Bun.serve({port:0,hostname:'127.0.0.1',idleTimeout:0,fetch:async request=>{
  if(olderOwner&&new URL(request.url).pathname.endsWith('/sync'))return Response.json({ok:false,error:'NOT_FOUND'},{status:404});
  // The gateway's rule: a verified token names the principal; nothing else may.
  const token=request.headers.get('authorization')?.replace(/^Bearer /,'')??'';
  const verified=verifyAgentToken(key,token);
  if(!verified)return Response.json({ok:false},{status:401});
  const headers=new Headers(request.headers);
  headers.set('x-concierge-agent-principal',verified.kind==='runner'?`runner:${verified.runner}`:`run:${verified.sessionId}:${verified.turnId}`);
  const forwarded=new Request(request.url,{method:request.method,headers,body:request.method==='GET'?undefined:await request.text()});
  return runnerRoutes(forwarded,new URL(request.url));
}});
const ownerUrl=`http://127.0.0.1:${server.port}`;
const tokenFile=join(root,'runner.token');
writeFileSync(tokenFile,mintAgentToken(key,{kind:'runner',runner:'check'}),{mode:0o600});

// The scripted provider: reports its environment, then answers each input line until stdin ends.
const provider=join(root,'scripted-provider.sh');
writeFileSync(provider,`#!/bin/sh
printf 'env state=%s owner=%s token=%s sentinel=%s run=%s\\n' "$CONCIERGE_STATE_DIR" "$CONCIERGE_OWNER_URL" "\${CONCIERGE_AGENT_TOKEN:+yes}" "\${OWNER_ONLY_SENTINEL:-absent}" "$RUN_MARK"
while IFS= read -r line; do
  case "$line" in
    attachment:*) printf 'attachment %s\\n' "$(cat "\${line#attachment:}")" ;;
    *) printf 'out:%s\\n' "$line" ;;
  esac
done
exit 0
`);
chmodSync(provider,0o755);

let runner:ChildProcess|null=null;
const runnerLog:string[]=[];
function startRunner() {
  runner=spawn(process.execPath,[join(import.meta.dir,'runner.ts')],{
    env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:process.env.HOME??'/root',CONCIERGE_OWNER_URL:ownerUrl,
      CONCIERGE_RUNNER_TOKEN_FILE:tokenFile,CONCIERGE_RUNNER_STATE:runnerState,CONCIERGE_RUNNER_KINDS:'turn',CONCIERGE_RUNNER_NAME:'check'},
    stdio:['ignore','pipe','pipe']});
  runner.stdout!.on('data',chunk=>runnerLog.push(String(chunk)));
  runner.stderr!.on('data',chunk=>runnerLog.push(String(chunk)));
}
async function stopRunner(signal:NodeJS.Signals='SIGKILL'){
  const child=runner;runner=null;
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  const exited=new Promise(done=>child.once('exit',done));
  child.kill(signal);
  await exited;
}
const until=async(test:()=>boolean,what:string,ms=30_000)=>{
  const deadline=Date.now()+ms;
  while(!test()){if(Date.now()>deadline)throw new Error(`timed out waiting for ${what}\n${runnerLog.join('')}`);await Bun.sleep(50);}
};
const executionIds:string[]=[];

type Run={lines:string[];write:((value:string,meta?:any)=>Promise<void>)|null;close:(()=>void)|null;result:Promise<{code:number|null;signal:NodeJS.Signals|null}>;replayed:number};
function runTurn(executionId:string,mode:'launch'|'adopt',options:{executable?:string;files?:{path:string;base64:string}[];stdin?:string}={}):Run {
  const run:Run={lines:[],write:null,close:null,result:null as any,replayed:0};
  const transport=new HostedClaudeCodeTransport({mode,executionId,stateDir:ownerState,access:new RunnerHostAccess(executionId),
    executable:mode==='launch'?options.executable??provider:undefined},{inactivityMs:null},options.files??[]);
  run.result=transport.run({args:[],cwd:root,environment:{RUN_MARK:'from-job',CONCIERGE_AGENT_TOKEN:'run-token-for-check',
      CONCIERGE_STATE_DIR:ownerState,CONCIERGE_ROUTER_BOT_DIR:'/owner/only/bot',PATH:'/owner/only/bot/scripts:/usr/bin:/bin'},
    stdin:`${options.stdin??'hello'}\n`,
    onStdout:(chunk,at)=>{run.lines.push(chunk.trim());if(at!==undefined)run.replayed++;},onStderr:()=>{},
    onStdinReady:(write,close)=>{run.write=write;run.close=close;}});
  return run;
}

try {
  startRunner();

  // 1. A whole turn on the runner: output, a follow-up with its receipt, attachment bytes, close, exit.
  const first=newExecutionId();executionIds.push(first);
  const attachmentPath=join(root,'attachments-'+first,'note.txt');
  const one=runTurn(first,'launch',{files:[{path:attachmentPath,base64:Buffer.from('bytes from the owner').toString('base64')}]});
  await until(()=>one.lines.includes('out:hello'),'the opening input to be answered');
  // A live runner keeps its owner contact fresh (every host reads it as its deadline).
  await Bun.sleep(1_500);
  const contact=Number(readFileSync(join(runnerState,'owner-contact'),'utf8'));
  assert.ok(Date.now()-contact<10_000,`The runner records its owner contact while it syncs (${Date.now()-contact} ms old).`);
  const env=one.lines.find(line=>line.startsWith('env '))!;
  assert.match(env,new RegExp(`state=${runnerState} `),"The provider's state folder is the runner's.");
  assert.match(env,new RegExp(`owner=${ownerUrl.replace(/[.]/g,'\\.')} `),'The runner supplies its owner address.');
  assert.match(env,/token=yes /,"The run's token travels in the job.");
  assert.match(env,/sentinel=absent /,"The owner's own environment never reaches the provider.");
  assert.match(env,/run=from-job$/,"The run's own variables come from the job.");
  await one.write!('second\n',{commandId:'steer-check-1'});
  await one.write!(`attachment:${attachmentPath}\n`,{commandId:'steer-check-2'});
  await until(()=>one.lines.includes('attachment bytes from the owner'),'the attachment to be read on the runner');
  one.close!();
  assert.deepEqual(await one.result,{code:0,signal:null});
  assert.deepEqual(one.lines.filter(line=>line.startsWith('out:')),['out:hello','out:second']);
  const settledAccess=new RunnerHostAccess(first);
  assert.equal(await settledAccess.custody(),'answering','The host waits for release after its exit.');
  assert.equal(await settledAccess.release(),true,'Release is sent after settlement and accepted.');
  await until(()=>(db.query('SELECT state FROM runner_jobs WHERE job_id=?').get(turnJobId(first)) as any)?.state==='finished','the job to finish after release');
  assert.equal(JSON.parse((db.query('SELECT result_json FROM runner_jobs WHERE job_id=?').get(turnJobId(first)) as any).result_json).released,true);
  assert.equal(await settledAccess.custody(),'settle-from-record','A finished job keeps the provider exit as its record.');

  // 2. A coordinator restart: a new coordinator takes the run back and its record is replayed.
  const second=newExecutionId();executionIds.push(second);
  const before=runTurn(second,'launch',{stdin:'before-restart'});
  await until(()=>before.lines.includes('out:before-restart'),'the second turn to answer');
  const after=runTurn(second,'adopt');
  await until(()=>!!after.write&&after.lines.includes('out:before-restart'),'the adopted run to replay its record');
  assert.ok(after.replayed>=2,'Replayed frames carry their original times.');

  // 3. The runner dies and restarts: it reacquires at a new epoch and the turn goes on.
  const epochBefore=(db.query('SELECT epoch FROM runner_attempts WHERE job_id=?').get(turnJobId(second)) as any).epoch;
  await stopRunner('SIGKILL');
  startRunner();
  await until(()=>(db.query('SELECT epoch FROM runner_attempts WHERE job_id=?').get(turnJobId(second)) as any).epoch>epochBefore,'the restarted runner to reacquire');
  await after.write!('after-runner-restart\n',{commandId:'steer-check-3'});
  await until(()=>after.lines.includes('out:after-runner-restart'),'the turn to continue after the runner restart');
  after.close!();
  assert.deepEqual(await after.result,{code:0,signal:null});
  const seqs=(db.query(`SELECT e.frame_json FROM runner_events e JOIN runner_attempts a ON a.attempt_id=e.attempt_id WHERE a.job_id=? ORDER BY e.seq`).all(turnJobId(second)) as any[])
    .map(row=>JSON.parse(row.frame_json)).filter(frame=>frame.k==='host').map(frame=>frame.f.s);
  assert.deepEqual(seqs,seqs.map((_,index)=>index+1),'Every host frame is stored once, in order, across the runner restart.');
  assert.equal(await new RunnerHostAccess(second).release(),true);

  // 3a. A turn claimed longer ago than the fencing time, which the owner has heard from on every
  // sync, survives a runner restart: the restart fences on the last sync, not on the claim.
  const veteran=newExecutionId();executionIds.push(veteran);
  const old=runTurn(veteran,'launch',{stdin:'long-running'});
  await until(()=>old.lines.includes('out:long-running'),'the long-running turn to answer');
  const veteranEpoch=(db.query('SELECT epoch FROM runner_attempts WHERE job_id=?').get(turnJobId(veteran)) as any).epoch;
  await Bun.sleep(1_500);
  await stopRunner('SIGKILL');
  const heldFile=join(runnerState,'attempts.json');
  const heldState=JSON.parse(readFileSync(heldFile,'utf8'));
  const veteranAttempt=Object.keys(heldState).find(id=>heldState[id].executionId===veteran)!;
  heldState[veteranAttempt].lastContactAtMs=Date.now()-(await import('../src/runner-leases')).RUNNER_FENCE_MS-60_000;
  writeFileSync(heldFile,JSON.stringify(heldState),{mode:0o600});
  const logBefore=runnerLog.length;
  startRunner();
  await until(()=>(db.query('SELECT epoch FROM runner_attempts WHERE job_id=?').get(turnJobId(veteran)) as any).epoch>veteranEpoch,'the restarted runner to reacquire the long-running turn');
  assert.ok(!runnerLog.slice(logBefore).join('').includes('runner_turn_fenced'),`A turn the owner heard from is not fenced on restart:\n${runnerLog.slice(logBefore).join('')}`);
  await old.write!('still-here\n',{commandId:'steer-check-veteran'});
  await until(()=>old.lines.includes('out:still-here'),'the long-running turn to continue after the runner restart');
  old.close!();
  assert.deepEqual(await old.result,{code:0,signal:null});
  assert.equal(await new RunnerHostAccess(veteran).release(),true);

  // 3b. The runner dies and stays down: once its last contact with the owner is older than the
  // fencing time, the host stops its agent by itself (no runner is left to do it).
  const orphaned=newExecutionId();executionIds.push(orphaned);
  const lonely=runTurn(orphaned,'launch',{stdin:'alone'});
  await until(()=>lonely.lines.includes('out:alone'),'the third turn to answer');
  await stopRunner('SIGKILL');
  const {RUNNER_FENCE_MS}=await import('../src/runner-leases');
  const {streamJournal,executionDirectory}=await import('../src/execution-host-client');
  writeFileSync(join(runnerState,'owner-contact'),String(Date.now()-RUNNER_FENCE_MS-1_000));
  let fencedExit:any=null;
  for(let tries=0;tries<40&&!fencedExit;tries++){
    for await(const frame of streamJournal(executionDirectory(runnerState,orphaned)))if(frame.k==='x')fencedExit=frame.d;
    if(!fencedExit)await Bun.sleep(1_000);
  }
  assert.equal(fencedExit?.signal,'SIGTERM',`The host stopped its provider at the deadline: ${JSON.stringify(fencedExit)}`);
  startRunner();

  // 3c. A rollback to an owner without the sync route: the runner stops its agents at once.
  const rolledBack=newExecutionId();executionIds.push(rolledBack);
  const doomed=runTurn(rolledBack,'launch',{stdin:'before-rollback'});
  await until(()=>doomed.lines.includes('out:before-rollback'),'the rollback turn to answer');
  olderOwner=true;
  const rollbackAt=Date.now();
  await until(()=>spawnSync('systemctl',['is-active',`concierge-exec-${rolledBack}.service`]).stdout.toString().trim()!=='active',
    'the runner to stop its agent when the owner lost the sync route',20_000);
  assert.ok(Date.now()-rollbackAt<20_000);
  olderOwner=false;

  // 4. A provider the runner cannot find: its definite refusal, nothing started.
  const missing=newExecutionId();
  const refused=runTurn(missing,'launch',{executable:'no-such-provider-for-check'});
  await assert.rejects(refused.result,(error:unknown)=>error instanceof HostNotStartedError&&/cannot find/.test(String(error)));

  // 5. No runner: the turn is withdrawn unstarted at its deadline.
  await stopRunner('SIGTERM');
  process.env.CONCIERGE_RUNNER_CLAIM_MS='1500';
  const unclaimed=newExecutionId();
  const waiting=runTurn(unclaimed,'launch');
  await assert.rejects(waiting.result,(error:unknown)=>error instanceof HostNotStartedError&&/no runner claimed/.test(String(error)));
  assert.equal(JSON.parse((db.query('SELECT result_json FROM runner_jobs WHERE job_id=?').get(turnJobId(unclaimed)) as any).result_json).withdrawn!=null,true);

  // 6. A later owner's custody: a job no runner claimed is withdrawn (never left to start on a stale
  // prompt); a claimed job whose runner has not reported its host is held, not taken for live.
  const leases=new RunnerLeases(db);
  const orphan=newExecutionId();
  leases.enqueue({jobId:turnJobId(orphan),kind:'turn',payload:{}});
  assert.equal(await new RunnerHostAccess(orphan).custody(),'dead');
  assert.equal(JSON.parse((db.query('SELECT result_json FROM runner_jobs WHERE job_id=?').get(turnJobId(orphan)) as any).result_json).withdrawn!=null,true);
  const starting=newExecutionId();
  leases.enqueue({jobId:turnJobId(starting),kind:'turn',payload:{}});
  assert.ok(leases.claim('elsewhere',['turn']));
  assert.equal(await new RunnerHostAccess(starting).custody(),'held');

  console.log('runner turns: output, follow-ups, attachments, runner-built environment, release after settlement, coordinator takeover, runner restart and unstarted refusals and later-owner custody hold');
} catch(error) {
  console.error(runnerLog.join(''));
  console.error((db.query('SELECT job_id,state,result_json FROM runner_jobs').all() as any[]).map(row=>JSON.stringify(row)).join('\n'));
  console.error((db.query('SELECT job_id,state,epoch,lease_expires_at_ms-? AS left FROM runner_attempts').all(Date.now()) as any[]).map(row=>JSON.stringify(row)).join('\n'));
  throw error;
} finally {
  await stopRunner('SIGKILL');
  for(const id of executionIds)spawnSync('systemctl',['stop',`concierge-exec-${id}.service`],{timeout:10_000});
  server.stop(true);
  rmSync(root,{recursive:true,force:true});
}
process.exit(0);
