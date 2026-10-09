import {existsSync,readFileSync} from 'node:fs';
import {dirname,join,resolve,relative} from 'node:path';
import {PRESENTATION_READERS} from '../src/presentation-reader-contracts';
import {checkReaderRefusals} from './presentation-contract-fixture';
import {checkTopicProjectionLifecycle,checkNativeOwnerProjectionLifecycle} from './topic-projection-fixture';
import {checkDispatchClaim} from './dispatch-claim-fixture';
import {checkLedgerConstructors} from './ledger-constructor-check';
import {runFixtureChild} from './fixture-child';
// Older installed builders already execute this candidate-owned entrance.
// A package-only check would not protect the first activation of these workers.
import './foreground-boundary-check';

const root=resolve(import.meta.dir,'..');
// The deployment runner executes this candidate-owned check before sealing a release.
const loggingGuard=Bun.spawnSync(['/usr/bin/python3',join(import.meta.dir,'bounded-logging-acceptance.py'),'--source-guard'],
  {cwd:root});
if(loggingGuard.exitCode!==0)throw new Error(`Logging source guard failed: ${loggingGuard.stderr.toString().slice(0,2000)}`);
const ledgerConstructors=checkLedgerConstructors(root);
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
const results=[];
checkReaderRefusals();
// Each lifecycle owns a distinct scratch directory and child process group.
// Run their independent waits alongside growth checks, within the existing
// 90-second release envelope rather than extending the deployment deadline.
const lifecycleChecks=Promise.allSettled([
  checkTopicProjectionLifecycle(),checkNativeOwnerProjectionLifecycle(),checkDispatchClaim(),
  runFixtureChild({command:process.execPath,args:[join(import.meta.dir,'foreground-composed-fixture.ts')],
    env:{...process.env},deadlineMs:80_000,fixture:'foreground-composed'}),
]);
try {for(const [name,contract] of Object.entries(PRESENTATION_READERS)){
  if(!contract.sourceTables.length||!contract.growth||!contract.maxRows||!contract.maxResponseBytes)
    throw new Error(`Incomplete presentation contract: ${name}`);
  const fixture=fixtures[contract.fixture];
  if(!fixture)throw new Error(`Reader ${name} has no executable growth fixture: ${contract.fixture}`);
  const started=performance.now();
  await fixture();
  results.push({reader:name,fixture:contract.fixture,durationMs:Math.round(performance.now()-started)});
}} catch(error) {await lifecycleChecks;throw error;}
const lifecycleResults=await lifecycleChecks;
const failures=lifecycleResults.filter(result=>result.status==='rejected');
if(failures.length)throw new AggregateError(failures.map(result=>result.reason),'Candidate lifecycle checks failed.');
const [topicProjection,nativeOwnerProjection,dispatchClaim,foreground]=lifecycleResults.map(result=>(result as PromiseFulfilledResult<unknown>).value);
console.log(JSON.stringify({check:'presentation-release',status:'passed',workerModules:visited.size,ledgerConstructors,topicProjection,nativeOwnerProjection,dispatchClaim,foreground,readers:results}));
