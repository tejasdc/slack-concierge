import CHECK_POLICY from './release-check-policy.json';
import {existsSync,readFileSync} from 'node:fs';
import {dirname,join,resolve,relative} from 'node:path';
import {privateCodeCommand} from '../src/private-database-command';
import {runFixtureChild} from './fixture-child';
import {currentProcessIdentity,processNativeLifetimeEnded} from '../src/runtime-identity';
// Older installed builders already execute this candidate-owned entrance.
// A package-only check would not protect the first activation of these workers.

async function checkPresentation(){
const {liveLedgerPresent}=await import('./run-release-checks');
// The native inventory models this Linux server's isolation; a Mac peer has no such gate.
const hostGate=process.platform==='linux'&&liveLedgerPresent();
// Isolation protects the live ledger; only a machine without one may run this unisolated.
if(process.env.CONCIERGE_PRIVATE_CODE_BOUNDARY_VERIFIED!=='1'&&hostGate)throw Error('Candidate checks require the verified private-code entrance.');
const {PRESENTATION_READERS}=await import('../src/presentation-reader-contracts');
const {checkReaderRefusals}=await import('./presentation-contract-fixture');
const {checkTopicProjectionLifecycle,checkNativeOwnerProjectionLifecycle}=await import('./topic-projection-fixture');
const {checkDispatchClaim}=await import('./dispatch-claim-fixture');
const {checkLedgerConstructors}=await import('./ledger-constructor-check');
const {checkSessionLocationComposition}=await import('./session-location-contract');
const {checkProviderContract}=await import('./provider-contract-check');
await import('./foreground-boundary-check');
const root=resolve(import.meta.dir,'..');
// The installed controller retains stderr but discards stdout and exit status on a timed-out
// candidate. Keep the last completed step visible within the shared release-check budget.
const phase=(name:string)=>process.stderr.write(`presentation-check: ${name}\n`);
phase('started');
// Every controller, including older installed ones, runs this candidate-owned check before it
// seals a release, so the host-only inventory runs here against the exact candidate source.
// On a host with a live ledger it is mandatory: a failure, timeout or missing result refuses
// the release. Inside the release-check suite the same group runs as its own declared group.
let nativeChecks:unknown='not-host';
if(hostGate&&process.env.CONCIERGE_RELEASE_CHECK_GROUP===undefined){
 phase('native-release-checks');
 // First, while this private boundary is still unused (its hidden Codex home empty), and
 // inside this check's process group so the controller's deadline and cleanup cover it.
 const deadlineAt=Math.floor(performance.timeOrigin)+CHECK_POLICY.deadlineMs-2*CHECK_POLICY.cleanupMs;
 const output:string[]=[];
 const native={command:[process.execPath,join(import.meta.dir,'run-release-checks.ts'),'--suite-child','--group','native'],
  environment:{...process.env,CONCIERGE_CHECK_DEADLINE_AT:String(deadlineAt)},cleanup:()=>{}};
 try{await runFixtureChild({command:native.command[0]!,args:native.command.slice(1),env:native.environment,
  deadlineMs:Math.max(1,deadlineAt-Date.now()),fixture:'native-release-checks',requireCheckpoint:false,requireOwnedGroup:false,
  onOutput:(stream,chunk)=>{if(stream==='stdout')output.push(String(chunk));else process.stderr.write(chunk);}});
 }finally{native.cleanup();}
 nativeChecks=JSON.parse(output.join('').trim().split('\n').at(-1)!);
 if((nativeChecks as {status?:string;group?:string}).status!=='passed'||(nativeChecks as {group?:string}).group!=='native')
  throw Error(`Native release checks did not report a pass: ${JSON.stringify(nativeChecks)}`);
}
if(process.platform==='linux'){
 if(await processNativeLifetimeEnded(currentProcessIdentity()))throw Error('The current native process was incorrectly reported exited.');
 phase('native-process-lifetime');
}
const sessionLocation=checkSessionLocationComposition(root);
phase('session-location-contract');
const providerContract=checkProviderContract(root);
phase('provider-contract');
// The deployment runner executes this candidate-owned check before sealing a release.
const loggingGuard=Bun.spawnSync(['/usr/bin/python3',join(import.meta.dir,'bounded-logging-acceptance.py'),'--source-guard'],
  {cwd:root});
if(loggingGuard.exitCode!==0)throw new Error(`Logging source guard failed: ${loggingGuard.stderr.toString().slice(0,2000)}`);
phase('logging-source-guard');
const ledgerConstructors=checkLedgerConstructors(root);
const safety=Bun.spawnSync([process.execPath,join(import.meta.dir,'database-safety-fixture.ts')],{cwd:root,stdout:'pipe',stderr:'pipe',timeout:30_000});
if(safety.exitCode!==0)throw new Error(`Database safety check failed: ${safety.stderr.toString().slice(-3000)}`);
phase('database-safety');
// Each guard operation owns its hang bound; the controller owns the whole gate deadline.
// Inherit progress so even an outer timeout retains the last operation reached.
const runningGuard=Bun.spawnSync([process.execPath,join(import.meta.dir,'live-store-copy-guard-fixture.ts')],{cwd:root,stdout:'pipe',stderr:'inherit'});
if(runningGuard.exitCode!==0)throw new Error(`Running agent copy guard failed: exit=${runningGuard.exitCode} signal=${runningGuard.signalCode}`);
phase('live-store-copy-guard');
const acceptance=Bun.spawnSync([process.execPath,join(import.meta.dir,'accepted-input-admission-fixture.ts')],{cwd:root,stdout:'pipe',stderr:'pipe',timeout:30_000});
if(acceptance.exitCode!==0)throw new Error(`Accepted input check failed: ${acceptance.stderr.toString().slice(-3000)}`);
phase('accepted-input-admission');
const focusCaptures=Bun.spawnSync([process.execPath,join(import.meta.dir,'focus-capture-admission-fixture.ts')],{cwd:root,stdout:'pipe',stderr:'pipe',timeout:30_000});
if(focusCaptures.exitCode!==0)throw new Error(`Focus capture admission check failed: ${focusCaptures.stderr.toString().slice(-3000)}`);
phase('focus-capture-admission');
const scanner=new Bun.Transpiler({loader:'ts'});
const visited=new Set<string>();
function readOnlyDependency(file:string){
  file=resolve(file);if(visited.has(file))return;visited.add(file);
  const name=relative(join(root,'src'),file);
  if(/^(state(?:[-.]|\/)|session-owner\.|config\.)/.test(name))
    throw new Error(`Presentation worker imports an application writer/lifecycle module: ${name}`);
  const code=readFileSync(file,'utf8');
  for(const imported of scanner.scan(code).imports){
    if(!imported.path.startsWith('.'))continue;
    const base=resolve(dirname(file),imported.path);
    const resolved=[base,base+'.ts',base.replace(/\.js$/,'.ts'),join(base,'index.ts')]
      .find(candidate=>existsSync(candidate)&&/\.(?:ts|js)$/.test(candidate));
    if(resolved)readOnlyDependency(resolved);
  }
}
for(const entry of ['presentation-message-worker.ts','presentation-search-read.ts'])
  readOnlyDependency(join(root,'src',entry));
phase('readonly-import-graph');

const fixtures:Record<string,()=>Promise<unknown>|unknown>={};
for(const module of ['presentation-growth-fixtures.ts','session-card-growth-fixtures.ts','topic-growth-fixtures.ts','owner-collection-growth-fixtures.ts','lab-growth-fixtures.ts']){
  const path=join(import.meta.dir,module);
  if(!existsSync(path))throw new Error(`Presentation release gate is incomplete: missing ${module}`);
  const exported=(await import(path)).READ_GROWTH_FIXTURES;
  if(!exported||typeof exported!=='object')throw new Error(`${module} must export READ_GROWTH_FIXTURES`);
  for(const [name,fixture] of Object.entries(exported)){
    if(fixtures[name]||typeof fixture!=='function')throw new Error(`Invalid or duplicate growth fixture: ${name}`);
    fixtures[name]=fixture as ()=>unknown;
  }
}
phase('growth-fixtures-loaded');
const results=[];
checkReaderRefusals();
phase('reader-refusals');
// Prove the one authoritative dispatch claim before this check starts its
// independent worker fixtures. Their simultaneous module loads can starve
// the short child startup boundary on a busy production host.
const dispatchClaim=await checkDispatchClaim();
phase('dispatch-claim');
const questionExpiry=await runFixtureChild({command:process.execPath,args:[join(import.meta.dir,'question-expiry-scope-fixture.ts')],
  env:{...process.env},deadlineMs:30_000,fixture:'question-expiry-scope'});
phase('question-expiry-scope');
// Each lifecycle owns a distinct scratch directory and child process group.
// Run their independent waits alongside growth checks, within the existing
// 90-second release envelope rather than extending the deployment deadline.
const lifecycleChecks=Promise.allSettled([
  checkTopicProjectionLifecycle(),checkNativeOwnerProjectionLifecycle(),
  runFixtureChild({command:process.execPath,args:[join(import.meta.dir,'foreground-composed-fixture.ts')],
    env:{...process.env},deadlineMs:80_000,fixture:'foreground-composed'}),
  runFixtureChild({command:process.execPath,args:[join(import.meta.dir,'inbox-prepared-lineage-fixture.ts')],
    env:{...process.env},deadlineMs:45_000,fixture:'inbox-prepared-lineage'}),
  runFixtureChild({command:process.execPath,args:[join(import.meta.dir,'asked-answer-fixture.ts')],
    env:{...process.env},deadlineMs:30_000,fixture:'asked-answer'}),
]);
try {for(const [name,contract] of Object.entries(PRESENTATION_READERS)){
  if(!contract.sourceTables.length||!contract.growth||!contract.maxRows||!contract.maxResponseBytes)
    throw new Error(`Incomplete presentation contract: ${name}`);
  const fixture=fixtures[contract.fixture];
  if(!fixture)throw new Error(`Reader ${name} has no executable growth fixture: ${contract.fixture}`);
  phase(`reader-start ${name}`);
  const started=performance.now();
  await fixture();
  results.push({reader:name,fixture:contract.fixture,durationMs:Math.round(performance.now()-started)});
  phase(`reader-done ${name}`);
}} catch(error) {await lifecycleChecks;throw error;}
phase('lifecycle-wait');
const lifecycleResults=await lifecycleChecks;
const failures=lifecycleResults.filter(result=>result.status==='rejected');
// Name each failure on its own line first: an uncaught AggregateError's printout is not
// guaranteed to include its inner messages, and the controller keeps only a bounded tail.
for(const failure of failures)process.stderr.write(`presentation-check: lifecycle failure: ${String((failure.reason as Error)?.message??failure.reason).slice(0,4000)}\n`);
if(failures.length)throw new AggregateError(failures.map(result=>result.reason),'Candidate lifecycle checks failed.');
phase('passed');
const [topicProjection,nativeOwnerProjection,foreground,inboxLineage,askedAnswer]=lifecycleResults.map(result=>(result as PromiseFulfilledResult<unknown>).value);
console.log(JSON.stringify({check:'presentation-release',status:'passed',nativeChecks,workerModules:visited.size,ledgerConstructors,sessionLocation,providerContract,topicProjection,nativeOwnerProjection,dispatchClaim,foreground,inboxLineage,askedAnswer,readers:results}));

}
if(process.argv.includes('--bounded-child'))await checkPresentation();
else {
 const isolated=privateCodeCommand([process.execPath,import.meta.path,'--bounded-child'],process.env);
 try{await runFixtureChild({command:isolated.command[0]!,args:isolated.command.slice(1),env:isolated.environment,
  deadlineMs:CHECK_POLICY.deadlineMs-CHECK_POLICY.cleanupMs,fixture:'presentation-release',requireCheckpoint:false,requireOwnedGroup:true,
  onOutput:(stream,chunk)=>process[stream].write(chunk)});
 }finally{isolated.cleanup();}
}
