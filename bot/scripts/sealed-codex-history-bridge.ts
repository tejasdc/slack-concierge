import {strict as assert} from 'node:assert';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {Worker} from 'node:worker_threads';
import {TrustedRootReleaseManager} from '../src/deployment-release';
import {checkReleaseApplication} from '../src/deployment-application-check';
import {releaseCodexBridgePath} from '../src/release-worker';

// Build an isolated sealed application from the working source. Never inspect or
// mutate the live ledger, current release link, or shared Codex app-server socket.
const source=resolve(import.meta.dir,'../..'),scratch=mkdtempSync(join(tmpdir(),'sealed-codex-history-'));
function run(command:string[],cwd:string){
 const result=Bun.spawnSync({cmd:command,cwd,stdout:'pipe',stderr:'pipe'});
 assert.equal(result.exitCode,0,result.stderr.toString());return result.stdout.toString().trim();
}
try {
 const repository=join(scratch,'repo');mkdirSync(repository);
 for(const file of run(['git','ls-files','-co','--exclude-standard'],source).split('\n')){
  if(!file||!existsSync(join(source,file)))continue;
  mkdirSync(dirname(join(repository,file)),{recursive:true});copyFileSync(join(source,file),join(repository,file));
 }
 run(['git','init','-q'],repository);run(['git','add','.'],repository);
 run(['git','-c','user.name=Fixture','-c','user.email=fixture@invalid','-c','core.hooksPath=/dev/null','commit','-qm','Isolated bridge candidate'],repository);
 const candidate=run(['git','rev-parse','HEAD'],repository);
 symlinkSync(join(source,'bot/node_modules'),join(repository,'bot/node_modules'),'dir');
 const manager=new TrustedRootReleaseManager({repositoryRoot:repository,releaseRoot:join(scratch,'releases'),
  installRoot:join(scratch,'install'),bunExecutable:process.execPath});
 const prepared=await manager.prepare('sealed-bridge-fixture',candidate);
 manager.verify(prepared.artifactPath);
 const releaseCheck=checkReleaseApplication(prepared.artifactPath,repository,join(scratch,'releases'));
 assert.equal(releaseCheck.status,'passed');
 const worker=join(prepared.artifactPath,'control/application/provider-history-page-worker.js');
 const bridge=join(prepared.artifactPath,'bot/src/codex-app-server-bridge.mjs');
 assert.equal(existsSync(worker),true);
 assert.equal(releaseCodexBridgePath(worker),bridge);
 assert.equal(releaseCodexBridgePath(join(prepared.artifactPath,'bot/src/index.js')),bridge);
 assert.equal(existsSync(bridge),true);
 assert.match(readFileSync(worker,'utf8'),/releaseCodexBridgePath/);
 const state=join(scratch,'state');mkdirSync(state);
 const seed=Bun.spawnSync({cmd:[process.execPath,'-e',
  'import {upsertSession} from "./bot/src/state.ts"; upsertSession("fixture","1","codex","00000000-0000-4000-8000-000000000001");'],
  cwd:repository,env:{...process.env,CONCIERGE_STATE_DIR:state,CONCIERGE_TEST_MODE:'1',
   CONCIERGE_TEST_AUTHORIZATION:'responsive-system-b1eed622'},stdout:'pipe',stderr:'pipe'});
 assert.equal(seed.exitCode,0,seed.stderr.toString());
 const pageWorker=new Worker(worker,{env:{...process.env,CONCIERGE_STATE_DIR:state,CONCIERGE_TEST_MODE:'1',
  CONCIERGE_TEST_AUTHORIZATION:'responsive-system-b1eed622',CONCIERGE_CODEX_APP_SERVER_SOCKET:join(scratch,'missing-app-server.sock')}});
 try {
  const pageReply=await new Promise<{error?:{message:string}}>((resolve,reject)=>{
   const timeout=setTimeout(()=>reject(new Error('Sealed history worker did not answer.')),12_000);
   pageWorker.once('message',value=>{clearTimeout(timeout);resolve(value)});
   pageWorker.once('error',error=>{clearTimeout(timeout);reject(error)});
   pageWorker.postMessage({id:1,operation:'page',sessionId:'concierge:1',cwd:scratch,cursor:null,limit:20,after:null});
  });
  assert.ok(pageReply.error?.message,pageReply);
  assert.match(pageReply.error.message,/connect ENOENT .*missing-app-server\.sock/,pageReply.error.message);
  assert.doesNotMatch(pageReply.error.message,/Cannot find module|MODULE_NOT_FOUND|codex-app-server-bridge\.mjs/);
 } finally {await pageWorker.terminate();}
 const probe=Bun.spawnSync({cmd:['/usr/bin/node',bridge,join(scratch,'missing-app-server.sock')],
  cwd:prepared.artifactPath,stdout:'pipe',stderr:'pipe'});
 assert.equal(probe.exitCode,1,probe.stderr.toString());
 assert.match(probe.stdout.toString(),/"type":"disconnect"/);
 assert.doesNotMatch(probe.stderr.toString(),/MODULE_NOT_FOUND/);
 console.log(JSON.stringify({kind:'sealed-codex-history-bridge',worker:'control/application/provider-history-page-worker.js',
  bridge:'bot/src/codex-app-server-bridge.mjs',resolvedFromWorker:true,workerExecuted:true,bridgeLaunched:true,
  connection:'isolated missing socket',productionStateTouched:false}));
} finally {rmSync(scratch,{recursive:true,force:true});}
