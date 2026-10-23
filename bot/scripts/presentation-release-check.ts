import {existsSync,readFileSync} from 'node:fs';
import {dirname,join,resolve,relative} from 'node:path';
import {PRESENTATION_READERS} from '../src/presentation-reader-contracts';
import {checkReaderRefusals} from './presentation-contract-fixture';
import {checkTopicProjectionLifecycle,checkNativeOwnerProjectionLifecycle} from './topic-projection-fixture';
import {checkDispatchClaim} from './dispatch-claim-fixture';
import {checkLedgerConstructors} from './ledger-constructor-check';
import {checkSessionLocationComposition} from './session-location-contract';
import {checkProviderContract} from './provider-contract-check';
import {runFixtureChild} from './fixture-child';
// Older installed builders already execute this candidate-owned entrance.
// A package-only check would not protect the first activation of these workers.
import './foreground-boundary-check';

const root=resolve(import.meta.dir,'..');
// The installed controller retains stderr but discards stdout and exit status on a timed-out
// candidate. Keep the last completed step visible without expanding its 90-second boundary.
const phase=(name:string)=>process.stderr.write(`presentation-check: ${name}\n`);
phase('started');
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
const runningGuard=Bun.spawnSync([process.execPath,join(import.meta.dir,'live-store-copy-guard-fixture.ts')],{cwd:root,stdout:'pipe',stderr:'pipe',timeout:10_000});
if(runningGuard.exitCode!==0)throw new Error(`Running agent copy guard failed: ${runningGuard.stderr.toString().slice(-3000)}`);
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
// Each lifecycle owns a distinct scratch directory and child process group.
// Run their independent waits alongside growth checks, within the existing
// 90-second release envelope rather than extending the deployment deadline.
const lifecycleChecks=Promise.allSettled([
  checkTopicProjectionLifecycle(),checkNativeOwnerProjectionLifecycle(),
  runFixtureChild({command:process.execPath,args:[join(import.meta.dir,'foreground-composed-fixture.ts')],
    env:{...process.env},deadlineMs:80_000,fixture:'foreground-composed'}),
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
const [topicProjection,nativeOwnerProjection,foreground]=lifecycleResults.map(result=>(result as PromiseFulfilledResult<unknown>).value);
console.log(JSON.stringify({check:'presentation-release',status:'passed',workerModules:visited.size,ledgerConstructors,sessionLocation,providerContract,topicProjection,nativeOwnerProjection,dispatchClaim,foreground,readers:results}));
