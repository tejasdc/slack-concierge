/** Exercises the real provider-page client and worker against the disposable ledger. */
import {strict as assert} from 'node:assert';
import {createHash} from 'node:crypto';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {chmod,mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {Worker} from 'node:worker_threads';
if(process.platform!=='linux'){console.log(JSON.stringify({fixture:'provider-history-page-readonly',status:'not-applicable',platform:process.platform}));process.exit(0);}

const stateDir=process.env.CONCIERGE_STATE_DIR;
if(!stateDir||process.env.CONCIERGE_PRIVATE_CODE_STATE!==stateDir)
  throw new Error('Run through private-code-command; disposable state identity is required.');
if(process.env.CONCIERGE_TEST_MODE==='1')
  process.env.CONCIERGE_TEST_AUTHORIZATION='protected-durability-92ed9a3d';

if(!process.argv.includes('--execute')){
  const compiledRoot=join(stateDir,'compiled-history-fixture');
  const workerOut=join(compiledRoot,'worker');
  const fixtureOut=join(compiledRoot,'fixture');
  await mkdir(workerOut,{recursive:true});await mkdir(fixtureOut,{recursive:true});
  const workerBundle=join(workerOut,'provider-history-page-worker.js');
  const fixtureBundle=join(fixtureOut,'provider-history-page-readonly-fixture.js');
  const replacementCounts={workerDaemon:0,workerStartup:0,fixtureDaemon:0,fixtureReleaseWorker:0};
  const daemonModule=`export const MANAGED_CODEX='/fixture/blocked-codex';
    export function holdCodexDaemonAutoStart(){}
    export function startCodexDaemonInOwnScope(){throw new Error('FIXTURE_CODEX_DAEMON_BLOCKED')}
    export function startCodexDaemonWhenAbsent(){}
    export async function raiseCodexDaemonFileLimit(){}
    export async function moveCodexDaemonToOwnScope(){}
    export function controlSocketListeners(){return []}
    export function codexDaemonPids(){return []}`;
  const buildWorker=async()=>Bun.build({entrypoints:[resolve(import.meta.dir,'../src/provider-history-page-worker.ts')],
    outdir:workerOut,target:'bun',plugins:[{name:'fixture-no-codex-daemon-lifecycle',setup(build){
      build.onResolve({filter:/codex-daemon-file-limit/},()=>({path:'codex-daemon-file-limit',namespace:'fixture-daemon'}));
      build.onLoad({filter:/.*/,namespace:'fixture-daemon'},()=>{replacementCounts.workerDaemon++;return {contents:daemonModule,loader:'js'};});
      build.onLoad({filter:/provider-history-page-worker\.ts$/},async args=>{
        const source=await Bun.file(args.path).text();
        const startup='void sharedCodexAppServerClient().connect().catch(()=>{});';
        if(!source.includes(startup))throw new Error('The worker App Server startup call changed; refresh the fixture replacement.');
        replacementCounts.workerStartup++;
        return {contents:source.replace(startup,'void Promise.resolve();'),loader:'ts'};
      });
    }}]});
  const workerBuild=await buildWorker();
  if(!workerBuild.success)throw new Error(`Compiled page worker failed: ${workerBuild.logs.map(log=>log.message).join('\n')}`);
  const workerDaemonCount=replacementCounts.workerDaemon;
  const fixtureBuild=await Bun.build({entrypoints:[import.meta.path],outdir:fixtureOut,target:'bun',plugins:[
    {name:'fixture-no-codex-daemon-lifecycle',setup(build){
      build.onResolve({filter:/codex-daemon-file-limit/},()=>({path:'codex-daemon-file-limit',namespace:'fixture-daemon'}));
      build.onLoad({filter:/.*/,namespace:'fixture-daemon'},()=>{replacementCounts.fixtureDaemon++;return {contents:daemonModule,loader:'js'};});
    }},
    {name:'fixture-compiled-page-worker',setup(build){
      build.onResolve({filter:/release-worker/},()=>({path:'release-worker',namespace:'fixture-worker'}));
      build.onLoad({filter:/.*/,namespace:'fixture-worker'},()=>{replacementCounts.fixtureReleaseWorker++;return {contents:
        `export function releaseWorkerPath(name){if(name!=='provider-history-page-worker')throw new Error('UNEXPECTED_FIXTURE_WORKER:'+name);return ${JSON.stringify(workerBundle)}}\n`+
        `export function releaseCodexBridgePath(){throw new Error('UNEXPECTED_FIXTURE_CODEX_BRIDGE')}\n`,loader:'js'};});
    }}
  ]});
  if(!fixtureBuild.success)throw new Error(`Compiled fixture failed: ${fixtureBuild.logs.map(log=>log.message).join('\n')}`);
  if(workerDaemonCount===0||replacementCounts.workerStartup!==1||replacementCounts.fixtureDaemon===0||replacementCounts.fixtureReleaseWorker===0)
    throw new Error(`Required build replacements were not applied: ${JSON.stringify(replacementCounts)}`);

  // Run the product modules only after the Codex lifecycle replacement is proved in
  // both bundles and host process-control/data paths are hidden in a child namespace.
  const blockedDir=join(stateDir,'blocked-tools');await mkdir(blockedDir,{recursive:true});
  const deniedPaths=['/usr/bin/systemd-run','/usr/bin/prlimit','/usr/bin/busctl'];
  const markers:string[]=[];
  const binds:string[]=[];
  for(const target of deniedPaths){
    if(!existsSync(target))throw new Error(`Expected host command is absent: ${target}`);
    const marker=join(blockedDir,`${target.slice(target.lastIndexOf('/')+1)}.attempted`);
    const blocker=join(blockedDir,`${target.slice(target.lastIndexOf('/')+1)}.sh`);
    await writeFile(blocker,`#!/bin/sh\n/usr/bin/touch ${marker}\nexit 97\n`,{mode:0o700});
    await chmod(blocker,0o700);markers.push(marker);binds.push('--ro-bind',blocker,target);
  }
  const codexHome=join(homedir(),'.codex');
  if(!existsSync(codexHome))throw new Error('The real Codex data directory is absent; private mount proof cannot run.');
  const blockedCommand=['/usr/bin/bwrap','--die-with-parent','--bind','/','/','--dev','/dev',
    '--tmpfs',codexHome,'--chmod','0700',codexHome,...binds,
    '--',process.execPath,fixtureBundle,'--execute',...process.argv.slice(2).filter(arg=>arg==='--missing-env-control')];
  const child=Bun.spawn(blockedCommand,{env:{...process.env,HISTORY_FIXTURE_NATIVE_BARRIERS:JSON.stringify({codexHome,targets:deniedPaths,blockers:binds.filter((_value,index)=>index%3===1)})},stdin:'ignore',stdout:'pipe',stderr:'pipe'});
  const stdout=await new Response(child.stdout).text();
  const stderr=await new Response(child.stderr).text();
  const exit=await child.exited;
  if(exit!==0)throw new Error(`Private compiled fixture failed (${exit}). stdout=${stdout}\nstderr=${stderr}`);
  if(markers.some(path=>existsSync(path)))throw new Error('A blocked Codex host command was attempted.');
  process.stdout.write(JSON.stringify({fixture:'provider-history-page-readonly-compile',
    workerDaemonReplacement:workerDaemonCount,workerConnectionStartupStubbed:replacementCounts.workerStartup,
    fixtureDaemonReplacement:replacementCounts.fixtureDaemon,
    releaseWorkerReplacement:replacementCounts.fixtureReleaseWorker,nativeBlockers:deniedPaths,
    realCodexHomeHidden:true,childExit:exit})+'\n'+stdout);
  process.stderr.write(stderr);
  process.exit(0);
}

// Validate the child namespace before importing the compiled product graph.
// A replacement counter proves compilation; this independently proves the native boundary.
const barriers=JSON.parse(process.env.HISTORY_FIXTURE_NATIVE_BARRIERS??'null');
assert.ok(barriers&&barriers.codexHome===join(homedir(),'.codex'));
const mounts=await readFile('/proc/self/mountinfo','utf8');
assert.ok(mounts.split('\n').some(line=>line.split(' ')[4]===barriers.codexHome&&line.includes(' - tmpfs ')),'real Codex directory must be covered by a private tmpfs');
assert.deepEqual(await readdir(barriers.codexHome),[],'private Codex directory starts empty');
for(let index=0;index<barriers.targets.length;index++)assert.deepEqual(await readFile(barriers.targets[index]),await readFile(barriers.blockers[index]),'host executable must be replaced before product imports');
console.log(JSON.stringify({fixture:'provider-history-page-native-boundary',privateCodexTmpfs:true,emptyPrivateCodexHome:true,verifiedExecutableReplacements:barriers.targets}));
process.env.CONCIERGE_CODEX_APP_SERVER_SOCKET=join(stateDir,'no-app-server.sock');

await import('../src/state');
// The serving owner imports this schema owner during startup; the read worker is
// deliberately forbidden from creating it on its own.
await import('../src/session-fit');
// The writable owner creates the retry-breaker schema before read workers start.
await import('../src/retry-breaker');
// Include the parent-side Codex connection module in the fixture build so the
// same blocked daemon collaborator covers both parent and worker bundles.
await import('../src/codex-app-server-client');
const [{db},{createNativeSession},{ProviderHistoryPageClient}]=await Promise.all([
  import('../src/state-database'),import('../src/session-inputs'),import('../src/provider-history-page-client'),
]);
const session=createNativeSession('claude-code',{title:'Read-only page fixture',summary:'Read-only history page fixture',cwd:stateDir});
db.query(`INSERT INTO turns(session_id,slack_user_msg_ts,user_text,agent_text,status,ended_at)
  VALUES(?,?,?,?,'completed',CURRENT_TIMESTAMP)`).run(session.id,'fixture-turn-1',
    'retained fixture input','retained fixture answer');

const walPath=join(stateDir,'state.db-wal');
const safeBefore=await readFile(walPath);
assert.ok(safeBefore.byteLength>32,'The fixture must have real WAL activity before the reader starts.');
const {releaseWorkerPath}=await import('../src/release-worker');
if(process.argv.includes('--missing-env-control')){
  const missingEnv={...process.env};delete missingEnv.CONCIERGE_READ_WORKER;
  const worker=new Worker(releaseWorkerPath('provider-history-page-worker'),{env:missingEnv});
  let refusal:string|null=null;
  const ended=new Promise<void>(resolve=>{
    worker.on('error',error=>{refusal=error.message;});
    worker.on('exit',()=>resolve());
  });
  worker.postMessage({id:1,operation:'page',sessionId:`concierge:${session.id}`,cwd:stateDir,cursor:null,limit:20,after:null});
  await ended;
  assert.match(refusal??'',/readonly|read-only/i);
  const afterRefusal=await readFile(walPath);
  assert.deepEqual(afterRefusal,safeBefore,'The candidate native-reader role changed the WAL when its env flag was missing.');
  db.query(`INSERT INTO turns(session_id,slack_user_msg_ts,user_text,status) VALUES(?,?,?,'queued')`)
    .run(session.id,'fixture-after-refusal','owner continued after readonly refusal');
  console.log(JSON.stringify({fixture:'provider-history-page-readonly',missingEnvRefusedBeforePage:true,
    missingEnvRefusal:refusal,missingEnvWALUnchanged:true,ownerContinued:true,walBytes:safeBefore.byteLength}));
  process.exit(0);
}
const client=new ProviderHistoryPageClient();
try{
  const page=await client.request({operation:'page',sessionId:`concierge:${session.id}`,cwd:stateDir,
    cursor:null,limit:20,after:null});
  assert.equal((page as any).messages.length,2);
  assert.deepEqual((page as any).messages.map((message:any)=>message.content),
    ['retained fixture input','retained fixture answer']);
  const providerPosition=Buffer.from(JSON.stringify({v:1,k:'provider',s:0,
    g:session.binding_generation??1,a:null,h:null,n:0})).toString('base64url');
  const delta=await client.request({operation:'delta',sessionId:`concierge:${session.id}`,cwd:stateDir,
    cursor:null,limit:20,after:providerPosition});
  assert.deepEqual(delta,{reset:true});
}finally{
  await client.close();
}
const after=await readFile(walPath);
assert.equal(after.byteLength,safeBefore.byteLength,'Worker shutdown changed the primed WAL length.');
assert.deepEqual(after,safeBefore,'Worker shutdown changed the primed WAL bytes.');
db.query('INSERT INTO turns(session_id,slack_user_msg_ts,user_text,status) VALUES(?,?,?,\'queued\')')
  .run(session.id,'fixture-after-worker','owner continues after worker shutdown');
const continued=await readFile(walPath);
assert.ok(continued.byteLength>=after.byteLength,'The original writer could not continue after worker shutdown.');
const ownExitWrapper=join(stateDir,'provider-history-page-own-exit.ts');
await writeFile(ownExitWrapper,`import {parentPort} from 'node:worker_threads';\n`+
  `const send=parentPort!.postMessage.bind(parentPort);\n`+
  `Object.defineProperty(parentPort,'postMessage',{value:(message:any,...args:any[])=>{send(message,...args);parentPort!.close();}});\n`+
  `await import(${JSON.stringify(releaseWorkerPath('provider-history-page-worker'))});\n`,{mode:0o600});
const ownExit=new Worker(ownExitWrapper,{env:{...process.env,CONCIERGE_READ_WORKER:'1'}});
const ownExitResult=new Promise<any>((resolve,reject)=>{
  ownExit.once('error',reject);
  ownExit.once('message',resolve);
});
const ownExitEnded=new Promise<number>(resolve=>ownExit.once('exit',resolve));
ownExit.postMessage({id:1,operation:'page',sessionId:`concierge:${session.id}`,cwd:stateDir,cursor:null,limit:20,after:null});
assert.equal((await ownExitResult).result.messages.length,3);
assert.equal(await ownExitEnded,0);
const afterOwnExit=await readFile(walPath);
assert.deepEqual(afterOwnExit,continued,'Natural worker exit changed the primed WAL.');
db.query(`INSERT INTO turns(session_id,slack_user_msg_ts,user_text,status) VALUES(?,?,?,'queued')`)
  .run(session.id,'fixture-after-own-exit','owner continued after worker own exit');
const afterOwnExitOwnerWrite=await readFile(walPath);
assert.notDeepEqual(afterOwnExitOwnerWrite,afterOwnExit,'The owner could not append after natural worker exit.');
console.log(JSON.stringify({fixture:'provider-history-page-readonly',pageMessages:2,deltaReset:true,
  workerTerminationAwaited:true,walBytesBefore:safeBefore.byteLength,walBytesAfterWorker:after.byteLength,
  walSha256Before:createHash('sha256').update(safeBefore).digest('hex'),
  walSha256After:createHash('sha256').update(after).digest('hex'),
  ownerContinued:true,compiledWorkerOwnExit:true,ownExitWalUnchanged:true,ownerContinuedAfterOwnExit:true}));
