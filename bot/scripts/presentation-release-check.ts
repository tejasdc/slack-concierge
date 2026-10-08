import {existsSync,readFileSync} from 'node:fs';
import {dirname,join,resolve,relative} from 'node:path';
import {PRESENTATION_READERS} from '../src/presentation-reader-contracts';
import {checkReaderRefusals} from './presentation-contract-fixture';
import {checkTopicProjectionLifecycle,checkNativeOwnerProjectionLifecycle} from './topic-projection-fixture';

const root=resolve(import.meta.dir,'..');
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
const topicProjection=await checkTopicProjectionLifecycle();
const nativeOwnerProjection=await checkNativeOwnerProjectionLifecycle();
for(const [name,contract] of Object.entries(PRESENTATION_READERS)){
  if(!contract.sourceTables.length||!contract.growth||!contract.maxRows||!contract.maxResponseBytes)
    throw new Error(`Incomplete presentation contract: ${name}`);
  const fixture=fixtures[contract.fixture];
  if(!fixture)throw new Error(`Reader ${name} has no executable growth fixture: ${contract.fixture}`);
  const started=performance.now();
  await fixture();
  results.push({reader:name,fixture:contract.fixture,durationMs:Math.round(performance.now()-started)});
}
console.log(JSON.stringify({check:'presentation-release',status:'passed',workerModules:visited.size,topicProjection,nativeOwnerProjection,readers:results}));
