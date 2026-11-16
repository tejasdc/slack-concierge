import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Database} from 'bun:sqlite';

type Deferred<T=void>={promise:Promise<T>;resolve:(value:T|PromiseLike<T>)=>void;reject:(error:unknown)=>void};
function deferred<T=void>():Deferred<T>{let resolve!:(value:T|PromiseLike<T>)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
async function until(test:()=>boolean,label:string):Promise<void>{const deadline=Date.now()+4_000;while(!test()){assert.ok(Date.now()<deadline,`timed out waiting for ${label}`);await new Promise<void>(resolve=>setImmediate(resolve));}}
function errorText(error:unknown):string{return error instanceof Error?`${error.name}: ${error.message}`:String(error);}

const scratch=mkdtempSync(join(tmpdir(),'wal9747-runner-gateway-'));
const oldHostPath=join(scratch,'runner-host-access-unadapted.ts');
const oldRoutePath=join(scratch,'runner-routes-unadapted.ts');
const hostSnapshot=join(import.meta.dir,'runner-host-access-held-2026-11-15.source.txt');
const routeSnapshot=join(import.meta.dir,'runner-routes-held-2026-11-15.source.txt');
if(process.env.CONCIERGE_PRIVATE_CODE_BOUNDARY_VERIFIED!=='1')throw Error('Use the verified private-code entrance before product imports.');
let raw:Database|undefined;
let databaseCleanup:(()=>Promise<void>)|undefined;
const activeResumes=new Set<()=>void>();
const maintenancePromises:Promise<void>[]=[];
const sqlSeen:string[]=[];
const violations:string[]=[];

try{
 const [{initializeRunnerSchema,RunnerLeases},{useRunnerLedger},{assertLedgerSql,enableLedgerAdmission,ledgerAdmissionSnapshot,maintainLedger,runLedgerSegment},{installLedgerBarrier},{observedDatabase},{ledgerWriteResults}]=await Promise.all([
  import('../src/runner-leases'),import('../src/runner-ledger'),import('../src/ledger-admission'),
  import('../src/ledger-durability-barrier'),import('../src/storage-observation'),import('../src/ledger-write-results'),
 ]);
 raw=ledgerWriteResults(new Database(join(scratch,'state.db')));
 raw.exec('PRAGMA journal_mode=WAL');
 initializeRunnerSchema(raw);
 raw.exec(`CREATE TABLE turns(id TEXT PRIMARY KEY,status TEXT NOT NULL,owner_instance_id TEXT NOT NULL,dispatch_attempt INTEGER NOT NULL);
   CREATE TABLE executions(execution_id TEXT PRIMARY KEY,turn_id TEXT NOT NULL,dispatch_attempt INTEGER NOT NULL,
     supervisor TEXT NOT NULL,state TEXT NOT NULL,coordinator_instance_id TEXT NOT NULL);`);
 const database=observedDatabase(raw,sql=>{
  sqlSeen.push(sql);
  try{assertLedgerSql(sql);}catch(error){violations.push(`${sql}: ${errorText(error)}`);throw error;}
 });
 let clock=1_800_000_000_000;
 const leases=new RunnerLeases(database,()=>clock++);
 useRunnerLedger(leases);
 const segment=<T>(operation:()=>T)=>runLedgerSegment(()=>operation());
 databaseCleanup=async()=>{await segment(()=>database.close());};
 const launchJob='turn:gateway-launch';
 const heldCustodyJob='turn:gateway-custody';
 const probeJob='route-claim-job';
 const resultJob='route-command-result-job';
 const finishJob='route-finish-job';
 // All schema and fixture preconditions exist before the gate is enabled.
 leases.enqueue({jobId:heldCustodyJob,kind:'turn',payload:{executionId:'gateway-custody',targetRunner:'runner-b'},replaySafe:false});
 leases.enqueue({jobId:'turn:legacy-command',kind:'turn',payload:{executionId:'legacy-command',targetRunner:'runner-b'},replaySafe:false});
 leases.enqueue({jobId:probeJob,kind:'probe',payload:{fixture:true},replaySafe:true});
 leases.enqueue({jobId:resultJob,kind:'command-fixture',payload:{fixture:true},replaySafe:true});
 const resultLease=leases.claim('runner-a',['command-fixture'])!;
 leases.command(resultJob,{commandId:'result-target',kind:'status',body:{op:'status',id:'result-target'}});
 leases.enqueue({jobId:finishJob,kind:'finish-fixture',payload:{fixture:true},replaySafe:true});
 const finishLease=leases.claim('runner-a',['finish-fixture'])!;
 let heldEpochs=0;
 const initialWriteCount=sqlSeen.filter(sql=>!/^\s*SELECT\b/i.test(sql)).length;

 // Exact unadapted bodies use the current real collaborators. Only import paths
 // are relocated; temporary modules live in scratch, never in the source tree.
 const hostBytes=readFileSync(hostSnapshot),routeBytes=readFileSync(routeSnapshot);
 const hostSnapshotSha=createHash('sha256').update(hostBytes).digest('hex');
 const routeSnapshotSha=createHash('sha256').update(routeBytes).digest('hex');
 assert.equal(hostSnapshotSha,'7e848c915655568285efce3401c51566cf360fcee7062f2bb0a2abdf333c92db');
 assert.equal(routeSnapshotSha,'3948ae072cda593ab81d696820c199e2b6ebeb3e26fa658bb19b54461299419a');
 assert.ok(!hostBytes.toString().includes('runLedgerSteps'));
 assert.ok(!routeBytes.toString().includes('runLedgerSteps'));
 const relocate=(bytes:Buffer)=>bytes.toString().replace(/from\s*(["'])(\.[^"']+)\1/g,
   (_match,quote,path)=>'from '+quote+resolve(import.meta.dir,'../src',path)+quote);
 writeFileSync(oldHostPath,relocate(hostBytes));writeFileSync(oldRoutePath,relocate(routeBytes));
 const oldHost=await import(oldHostPath);
 const oldRoutes=await import(oldRoutePath);
 const {RunnerHostAccess}=await import('../src/runner-host-access');
 const {runnerRoutes}=await import('../src/runner-routes');
 const {HOST_PROTOCOL_VERSION}=await import('../src/execution-host-client');
 const {initializeRunnerSchema:unusedSchema}=await import('../src/runner-leases');
 void unusedSchema;
 enableLedgerAdmission();
 assert.equal(ledgerAdmissionSnapshot().phase,'serving');

 const closeAdmission=async()=>{
  heldEpochs++;
  const entered=deferred<()=>void>();
  const held=maintainLedger(()=>new Promise<void>(resolve=>entered.resolve(resolve)));
  maintenancePromises.push(held);
  const release=await entered.promise;
  const resume=()=>{release();activeResumes.delete(resume);};
  activeResumes.add(resume);
  return{resume,held};
 };
 const waitQueued=async(label:string)=>until(()=>ledgerAdmissionSnapshot().pending>0,label);

 // Old RunnerHostAccess launch performs enqueue immediately after ledgerDurable resumes. The
 // same held schedule must fail at the real SQL admission boundary, before creating a row.
 const oldLaunchAccess=new oldHost.RunnerHostAccess('unadapted-launch');
 const oldLaunchReached=deferred(),oldLaunchContinue=deferred();
 const removeOldLaunchBarrier=installLedgerBarrier(async()=>{oldLaunchReached.resolve();await oldLaunchContinue.promise;});
 let oldLaunchError:unknown;
 const writesBeforeOldLaunch=sqlSeen.filter(sql=>!/^\s*SELECT\b/i.test(sql)).length;
 const oldLaunch=oldLaunchAccess.launch({executable:'/bin/true',args:[],cwd:'/tmp',environment:{},inheritEnvironment:false,initialInput:'fixture'})
  .catch(error=>{oldLaunchError=error;});
 await oldLaunchReached.promise;
 const oldLaunchHold=await closeAdmission();
 oldLaunchContinue.resolve();
 await until(()=>oldLaunchError!==undefined||leases.job('turn:unadapted-launch')!==null,'unadapted launch SQL refusal or bypass');
 assert.ok(oldLaunchError!==undefined,`unadapted launch bypassed the facade: job=${JSON.stringify(leases.job('turn:unadapted-launch'))}; gate=${JSON.stringify(ledgerAdmissionSnapshot())}; writes=${JSON.stringify(sqlSeen.slice(-12))}`);
 assert.match(errorText(oldLaunchError),/LEDGER_OPERATION_NOT_ADMITTED/);
 assert.equal(leases.job('turn:unadapted-launch'),null);
 assert.equal(sqlSeen.filter(sql=>!/^\s*SELECT\b/i.test(sql)).length,writesBeforeOldLaunch+1,
  'the facade records the refused BEGIN attempt before SQLite can mutate');
 assert.ok(violations.at(-1)?.includes('LEDGER_OPERATION_NOT_ADMITTED'),JSON.stringify(violations));
 oldLaunchHold.resume();await oldLaunchHold.held;removeOldLaunchBarrier();await oldLaunch;

 // Adapted launch yields its original durability result, then its complete enqueue decision waits.
 const launchReached=deferred(),allowLaunchDurability=deferred();
 const removeLaunchBarrier=installLedgerBarrier(async()=>{launchReached.resolve();await allowLaunchDurability.promise;});
 const launchAccess=new RunnerHostAccess('gateway-launch',undefined,'runner-a');
 let launchSettled=false;
 const launchPromise=launchAccess.launch({executable:'/bin/true',args:[],cwd:'/tmp',environment:{},inheritEnvironment:false,initialInput:'fixture'})
  .then(value=>{launchSettled=true;return value;});
 await launchReached.promise;
 const launchHold=await closeAdmission();
 const writesBeforeLaunchResume=sqlSeen.filter(sql=>!/^\s*SELECT\b/i.test(sql)).length;
 allowLaunchDurability.resolve();
 await waitQueued('launch enqueue continuation');
 assert.equal(launchSettled,false);
 assert.equal(leases.job(launchJob),null);
 const writesBeforeLaunchHold=sqlSeen.filter(sql=>!/^\s*SELECT\b/i.test(sql)).length;
 assert.equal(writesBeforeLaunchHold,writesBeforeLaunchResume);
 launchHold.resume();await launchHold.held;removeLaunchBarrier();
 await until(()=>leases.job(launchJob)?.state==='queued','admitted launch enqueue');
 const claimedLaunch=await segment(()=>leases.claim('runner-a',['turn']))!;
 assert.equal(claimedLaunch.jobId,launchJob);
 await segment(()=>leases.appendEvents('runner-a',claimedLaunch.attemptId,claimedLaunch.epoch,[{seq:1,frame:{k:'attached',protocol:HOST_PROTOCOL_VERSION,hostPid:10,providerPid:11,h:0}}]));
 const launchReceipt=await launchPromise;
 assert.equal(launchReceipt.executionId,'gateway-launch');

 // Old runnerCommand uses a bare await after the durability barrier and leaks its write.
 const oldCommandAccess=new oldHost.RunnerHostAccess('legacy-command');
 const oldCommandLink=await oldCommandAccess.connect();
 const oldCommandReached=deferred(),allowOldCommand=deferred();
 const removeOldCommandBarrier=installLedgerBarrier(async()=>{oldCommandReached.resolve();await allowOldCommand.promise;});
 let oldCommandError:unknown;
 const writesBeforeOldCommand=sqlSeen.filter(sql=>!/^\s*SELECT\b/i.test(sql)).length;
 const oldCommandPromise=oldCommandLink.command({op:'status',id:'unadapted-command'}).catch(error=>{oldCommandError=error;});
 await oldCommandReached.promise;
 const oldCommandHold=await closeAdmission();
 allowOldCommand.resolve();
 await until(()=>oldCommandError!==undefined,'unadapted command SQL refusal');
 assert.match(errorText(oldCommandError),/LEDGER_OPERATION_NOT_ADMITTED/);
 assert.equal(leases.commandResult('turn:legacy-command:unadapted-command'),undefined);
 assert.equal(sqlSeen.filter(sql=>!/^\s*SELECT\b/i.test(sql)).length,writesBeforeOldCommand+1,
  'the facade records the refused command INSERT attempt before SQLite can mutate');
 assert.ok(violations.some(violation=>violation.includes('LEDGER_OPERATION_NOT_ADMITTED')));
 oldCommandHold.resume();await oldCommandHold.held;removeOldCommandBarrier();await oldCommandPromise;

 // Actual runner routes: each waits after request.json before the mutation. On resume, each
 // operation is run through the real RunnerLeases instance over the observed SQL facade.
 const routeCase=async(label:string,path:string,body:unknown,before:()=>Promise<void>,after:(payload:any)=>Promise<void>)=>{
  const bodyReady=deferred<unknown>(),jsonEntered=deferred<void>();
  const request=new Request(`http://owner/runner/v1/${path}`,{method:'POST',headers:{'x-concierge-agent-principal':'runner:runner-a','content-type':'application/json'},body:'{}'});
  Object.defineProperty(request,'json',{value:()=>{jsonEntered.resolve();return bodyReady.promise;}});
  let settled=false,response:Response|undefined,failure:unknown;
  const routePromise=runnerRoutes(request,new URL(request.url)).then(value=>{settled=true;response=value;},error=>{settled=true;failure=error;});
  await jsonEntered.promise;
  const hold=await closeAdmission();
  bodyReady.resolve(body);
  await waitQueued(`${label} route continuation`);
  assert.equal(settled,false,`${label} response must wait while the business operation is held`);
  const writes=sqlSeen.filter(sql=>!/^\s*SELECT\b/i.test(sql)).length;
  await before();
  assert.equal(sqlSeen.filter(sql=>!/^\s*SELECT\b/i.test(sql)).length,writes,`${label} did not cross the canonical write facade`);
  hold.resume();await hold.held;
  await routePromise;
  if(failure)throw failure;
  assert.ok(response,`${label} returned a response`);
  assert.equal(response.status,200,`${label} succeeded: ${await response.clone().text()}`);
  await after(await response.json());
 };
 let claimResult:any;
 await routeCase('claim','claim',{kinds:['probe']},async()=>{
  const job=leases.job(probeJob);assert.equal(job?.state,'queued');assert.equal(job?.attempts.length,0);
 },async payload=>{claimResult=payload.job;assert.equal(claimResult.jobId,probeJob);assert.equal(claimResult.epoch,1);});
 await routeCase('events','events',{attemptId:claimResult.attemptId,epoch:claimResult.epoch,events:[{seq:1,frame:{k:'host',f:{s:1,k:'output',t:1}}}]},async()=>{
  const job=leases.job(probeJob);assert.equal(job?.attempts[0]?.acked_seq,0);assert.equal(job?.events.length,0);
 },async payload=>{assert.equal(payload.ackedSeq,1);});
 await routeCase('command-results','command-results',{attemptId:resultLease.attemptId,epoch:resultLease.epoch,results:[{commandId:'result-target',result:{status:'reported'}}]},async()=>{
  assert.equal(leases.commandResult('result-target'),undefined);
 },async payload=>{assert.equal(payload.recorded,1);assert.deepEqual(await segment(()=>leases.commandResult('result-target')),{result:{status:'reported'}});});
 await routeCase('finish','finish',{attemptId:finishLease.attemptId,epoch:finishLease.epoch,operationId:'finish-operation-1',result:{done:true}},async()=>{
  assert.equal(leases.job(finishJob)?.state,'leased');
 },async payload=>{assert.equal(payload.finished,true);assert.equal((await segment(()=>leases.job(finishJob)))?.state,'finished');});

 // The original command identity survives the barrier, then its exact result continuation is
 // admitted after a result is recorded through the same real lease engine.
 const currentCommandAccess=new RunnerHostAccess('gateway-command');
 const commandJob='turn:gateway-command';
 await segment(()=>leases.enqueue({jobId:commandJob,kind:'turn',payload:{fixture:true,targetRunner:'runner-a'},replaySafe:false}));
 const commandLease=await segment(()=>leases.claim('runner-a',['turn']))!;
 assert.equal(commandLease.jobId,commandJob);
 const currentLink=await currentCommandAccess.connect();
 const currentCommandId=`${commandJob}:accepted-status-command`;
 const currentCommandReached=deferred(),allowCurrentCommand=deferred();
 const removeCurrentCommandBarrier=installLedgerBarrier(async()=>{currentCommandReached.resolve();await allowCurrentCommand.promise;});
 let commandSettled=false,commandAnswer:any,commandFailure:unknown;
 const currentCommand=currentLink.command({op:'status',id:'accepted-status-command'})
  .then(value=>{commandSettled=true;commandAnswer=value;},error=>{commandSettled=true;commandFailure=error;});
 await currentCommandReached.promise;
 const commandHold=await closeAdmission();
 allowCurrentCommand.resolve();
 await waitQueued('runner command after durability barrier');
 assert.equal(commandSettled,false);
 const writesBeforeCommandResume=sqlSeen.filter(sql=>!/^\s*SELECT\b/i.test(sql)).length;
 assert.equal(leases.commandResult(currentCommandId),undefined);
 assert.equal(sqlSeen.filter(sql=>!/^\s*SELECT\b/i.test(sql)).length,writesBeforeCommandResume);
 commandHold.resume();await commandHold.held;removeCurrentCommandBarrier();
 await until(()=>sqlSeen.some(sql=>/INSERT INTO runner_commands/i.test(sql)),'canonical runner command insertion');
 const storedCommand=await segment(()=>database.query('SELECT command_id,kind,body_json FROM runner_commands WHERE command_id=?').get(currentCommandId) as any);
 assert.equal(storedCommand.command_id,currentCommandId);
 assert.equal(JSON.parse(storedCommand.body_json).id,'accepted-status-command');
 assert.equal(commandSettled,false,'the accepted command still waits for its runner result');
 await segment(()=>leases.commandResults('runner-a',commandLease.attemptId,commandLease.epoch,[{commandId:currentCommandId,result:{status:'exact-result'}}]));
 await currentCommand;
 if(commandFailure)throw commandFailure;
 assert.deepEqual(commandAnswer,{status:'exact-result'});

 // Custody owns the full queued-job read/withdraw decision. It waits while frozen, then
 // withdraws only after admission resumes and leaves the next ordinary write available.
 const custodyAccess=new RunnerHostAccess('gateway-custody');
 const writesBeforeCustody=sqlSeen.filter(sql=>!/^\s*SELECT\b/i.test(sql)).length;
 const custodyHold=await closeAdmission();
 let custodySettled=false,custodyResult:string|undefined;
 const custodyPromise=custodyAccess.custody().then(value=>{custodySettled=true;custodyResult=value;});
 await waitQueued('custody read/withdraw sequence');
 assert.equal(custodySettled,false);
 assert.equal(leases.job(heldCustodyJob)?.state,'queued');
 assert.equal(writesBeforeCustody,sqlSeen.filter(sql=>!/^\s*SELECT\b/i.test(sql)).length);
 custodyHold.resume();await custodyHold.held;await custodyPromise;
 assert.equal(custodyResult,'dead');
 assert.equal((await segment(()=>leases.job(heldCustodyJob)))?.state,'finished');
 const nextJob=await segment(()=>leases.enqueue({jobId:'after-custody-resume',kind:'probe',payload:{after:true},replaySafe:true}));
 assert.equal(nextJob.created,true);

 // Actual unadapted runner route reaches request.json, resumes without a segment, and is refused
 // by the same observed canonical SQL boundary before the queued probe can change.
 const oldBody=deferred<unknown>(),oldJsonEntered=deferred<void>();
 const oldRequest=new Request('http://owner/runner/v1/claim',{method:'POST',headers:{'x-concierge-agent-principal':'runner:runner-a','content-type':'application/json'},body:'{}'});
 Object.defineProperty(oldRequest,'json',{value:()=>{oldJsonEntered.resolve();return oldBody.promise;}});
 let oldRouteFailure:unknown;
 const oldRoutePromise=oldRoutes.runnerRoutes(oldRequest,new URL(oldRequest.url)).catch((error:unknown)=>{oldRouteFailure=error;});
 await oldJsonEntered.promise;
 const oldRouteHold=await closeAdmission();oldBody.resolve({kinds:['probe']});
 await until(()=>oldRouteFailure!==undefined,'unadapted route SQL refusal');
 assert.match(errorText(oldRouteFailure),/LEDGER_OPERATION_NOT_ADMITTED/);
 assert.ok(violations.some(violation=>violation.includes('LEDGER_OPERATION_NOT_ADMITTED')));
 assert.equal(leases.job('after-custody-resume')?.state,'queued');
 oldRouteHold.resume();await oldRouteHold.held;await oldRoutePromise;

 const afterWrites=sqlSeen.filter(sql=>!/^\s*SELECT\b/i.test(sql)).length;
 const result={
  actualRunnerLeaseEngine:true,actualObservedDatabaseFacade:true,
  launchWaitedAfterOriginalDurability:true,launchCreatedAfterResume:true,
  routeJsonResumeWaitedForAdmission:['claim','events','command-results','finish'],
  commandStayedPendingAfterAcceptedIntent:true,exactCommandId:currentCommandId,exactResultContinuation:true,
  custodyWaitedThenWithdrew:true,nextOperationAfterResume:true,
  unadaptedLaunchRefused:true,unadaptedCommandRefused:true,unadaptedRouteRefused:true,
  facadeSqlCalls:sqlSeen.length,facadeNonSelectSqlAttempts:afterWrites,heldEpochs,
  sourceSnapshots:{runnerHostAccessSha256:hostSnapshotSha,runnerRoutesSha256:routeSnapshotSha},
  scratch,
 };
 console.log(JSON.stringify(result));
}finally{
 try{
  for(const resume of activeResumes)resume();
  await Promise.all(maintenancePromises.map(held=>held.catch(()=>{})));
  if(databaseCleanup)await databaseCleanup();else raw?.close();
 }finally{
  rmSync(oldHostPath,{force:true});rmSync(oldRoutePath,{force:true});
  rmSync(scratch,{recursive:true,force:true});
 }
}
