import assert from 'node:assert/strict';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {assessManagedHookInstallerCoverage,beginCodexManagedHookInstall,completeCodexManagedHookInstall,
  registerCurrentManagedHookInstaller} from '../src/codex-managed-hook-config';
import {initializeCodexMutationFenceSchema,grantCodexMutationPermit,consumeCodexMutationPermit,
  acquireCodexThreadMutationFence,stopCodexThreadMutationFence,reconcileCodexMutationIntent} from '../src/codex-mutation-fence';
import {beginCodexDaemonLifecycle} from '../src/codex-daemon-lifecycle';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
if(process.argv[2]==='--contender'){
  const db=new Database(process.argv[3]!);db.exec('PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON');
  const kind=process.argv[4]!;
  process.stdout.write('READY\n');await Bun.stdin.text();
  const result=kind==='config'?beginCodexManagedHookInstall(db,{operationId:'race-config',paramsDigest:digest('race-config'),nowMs:2}):
    acquireCodexThreadMutationFence(db,{acceptedInputId:'race-input',runId:'race-run',dispatchAttempt:1,fenceId:'race-fence',threadId:'race-thread',nowMs:2});
  db.close();process.stdout.write(JSON.stringify(result));process.exit(0);
}
const root=mkdtempSync(join(tmpdir(),'codex-managed-hook-config-'));
const path=join(root,'ledger.sqlite'),first=new Database(path),second=new Database(path);
first.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000');second.exec('PRAGMA busy_timeout=10000');
first.exec('PRAGMA foreign_keys=ON');second.exec('PRAGMA foreign_keys=ON');
initializeCodexMutationFenceSchema(first);
const owner=(id:string)=>({acceptedInputId:`accepted:${id}`,runId:`run:${id}`,dispatchAttempt:1});
const fence=(threadId:string,id:string)=>acquireCodexThreadMutationFence(second,{...owner(id),threadId,fenceId:`fence:${id}`,nowMs:1});
const begin=(id:string)=>beginCodexManagedHookInstall(first,{operationId:id,paramsDigest:digest({config:id}),nowMs:2});
const grant=(threadId:string,id:string)=>grantCodexMutationPermit(second,{permitId:`p:${id}`,threadId,owner:owner(id),method:'turn/start',
  paramsDigest:digest({id}),purpose:'ordinary',nowMs:3});
try{
  const racePath=join(root,'race.sqlite'),raceDb=new Database(racePath);initializeCodexMutationFenceSchema(raceDb);raceDb.close();
  const contenders=['config','fence'].map(kind=>Bun.spawn([process.execPath,import.meta.path,'--contender',racePath,kind],
    {stdin:'pipe',stdout:'pipe',stderr:'pipe'}));
  const readers=contenders.map(child=>child.stdout.getReader());
  await Promise.all(readers.map(async reader=>{const ready=await reader.read();assert.equal(new TextDecoder().decode(ready.value),'READY\n');}));
  for(const child of contenders)child.stdin.end();
  const raceResults=await Promise.all(readers.map(async(reader,index)=>{
    let output='';for(;;){const next=await reader.read();if(next.done)break;output+=new TextDecoder().decode(next.value);}
    const child=contenders[index]!;const [stderr,status]=await Promise.all([new Response(child.stderr).text(),child.exited]);
    assert.equal(status,0,stderr);return JSON.parse(output);
  }));
  assert.equal(raceResults.filter(result=>result.forward===true||result.acquired===true).length,1,
    'two independent SQLite clients cannot concurrently admit config installation and a recovery fence');

  // Exact-thread active and stopped-with-unresolved fences both refuse a config update.
  assert.equal(fence('thread-held','active').acquired,true);
  assert.equal(begin('denied-active-fence').forward,false);
  const recovery=grantCodexMutationPermit(second,{permitId:'p:issued-before-stop',threadId:'thread-held',owner:owner('active'),
    method:'turn/start',paramsDigest:digest({id:'issued-before-stop'}),purpose:'fenced_recovery',fenceId:'fence:active',nowMs:3});
  assert.equal(recovery.granted,true);
  const consumed=consumeCodexMutationPermit(second,{permitId:'p:issued-before-stop',intentId:'p:issued-before-stop',paramsDigest:digest({id:'issued-before-stop'}),nowMs:4});
  assert.equal(consumed.forward,true);
  stopCodexThreadMutationFence(first,{fenceId:'fence:active',stopActionId:'stop:active',nowMs:5});
  assert.equal(begin('denied-stopped-uncertain').forward,false);
  reconcileCodexMutationIntent(first,{intentId:'p:issued-before-stop',outcome:'applied',evidenceDigest:digest('exact-terminal'),nowMs:6});

  // A granted-but-not-issued native send loses to the config intent; a global permit is durable
  // before the installer can spawn its child and blocks later native sends and recovery fences.
  const pending=grant('thread-free','pending-native-send');assert.equal(pending.granted,true);
  const continuingGrant=grant('thread-continuing','turn-started-before-gate');assert.equal(continuingGrant.granted,true);
  const continuing=consumeCodexMutationPermit(second,{permitId:'p:turn-started-before-gate',intentId:'p:turn-started-before-gate',
    paramsDigest:digest({id:'turn-started-before-gate'}),nowMs:4});
  assert.equal(continuing.forward,true);
  const install=begin('config-install');assert.equal(install.forward,true);
  const helperIdentity={pid:process.pid,bootId:'fixture-boot',startTicks:'100',executablePath:'/fixture/bun'};
  const parentIdentity={pid:process.ppid,bootId:'fixture-boot',startTicks:'50',executablePath:'/fixture/bash'};
  registerCurrentManagedHookInstaller(first,{intentId:install.intentId,nowMs:7,proc:{
    listPids:()=>[process.pid,98765],identity:pid=>pid===process.pid?helperIdentity:pid===98765?
      {pid,bootId:'fixture-boot',startTicks:'900',executablePath:'/fixture/bash'}:pid===process.ppid?parentIdentity:null,
    parentPid:pid=>pid===process.pid?process.ppid:null,
    commandLine:pid=>pid===process.pid?['/fixture/bun','/sealed/bot/scripts/codex-managed-hook-install.js']:
      pid===98765?['/bin/bash','/old/install-codex-stop-hook.sh']:pid===process.ppid?['/bin/bash','/repo/scripts/install-codex-stop-hook.sh']:null}});
  const oldProcess=assessManagedHookInstallerCoverage({db:second,processes:{
    listPids:()=>[process.pid,98765],identity:pid=>pid===process.pid?helperIdentity:pid===98765?
      {pid,bootId:'fixture-boot',startTicks:'900',executablePath:'/fixture/bash'}:null,
    parentPid:pid=>pid===process.pid?process.ppid:null,
    commandLine:pid=>pid===process.pid?['/fixture/bun','/sealed/bot/scripts/codex-managed-hook-install.js']:
      pid===98765?['/bin/bash','/old/install-codex-stop-hook.sh']:null}});
  assert.equal(oldProcess.covered,false,'a supported pre-gate installer with no retained enrollment blocks coverage');
  assert.equal(oldProcess.blockers[0]?.code,'UNMANAGED_HOOK_CONFIG_INSTALLER');
  const enrolled=assessManagedHookInstallerCoverage({db:second,processes:{
    listPids:()=>[process.pid],identity:()=>helperIdentity,parentPid:()=>null,
    commandLine:()=>['/fixture/bun','/sealed/bot/scripts/codex-managed-hook-install.js']}});
  assert.equal(enrolled.covered,true,'the exact registered helper is covered');
  assert.equal(consumeCodexMutationPermit(second,{permitId:'p:pending-native-send',intentId:'p:pending-native-send',
    paramsDigest:digest({id:'pending-native-send'}),nowMs:7}).forward,false);
  assert.equal(grant('thread-other','native-during-install').granted,false);
  assert.equal(fence('thread-other','fence-during-install').acquired,false);
  assert.equal(grant('*','unknown-global-during-install').granted,false);
  assert.equal(begin('config-second-writer').forward,false);
  // An already-forwarded unrelated turn may continue across the config acquisition; the gate
  // excludes new forwards without demanding that every ordinary turn terminate first.
  assert.equal(first.query("SELECT state FROM codex_mutation_intents WHERE intent_id='p:turn-started-before-gate'").get()!.state,'forwarding');
  assert.equal(first.query("SELECT state FROM codex_mutation_intents WHERE intent_id=?").get(install.intentId)!.state,'forwarding');
  assert.equal(beginCodexDaemonLifecycle(first,{operationId:'lifecycle-during-config',paramsDigest:digest('lifecycle'),nowMs:7}).forward,false);

  // Explicit response + exact completion reconciles once. Restarted clients retain the result.
  const child=Bun.spawn([process.execPath,'-e','process.exit(0)'],{stdout:'ignore',stderr:'ignore'});
  const childExit=await child.exited;assert.equal(childExit,0);
  completeCodexManagedHookInstall(second,{intentId:install.intentId,responseDigest:digest({childExit}),
    evidenceDigest:digest({verifiedChildExit:childExit}),nowMs:9});
  assert.equal(begin('config-install').forward,false,'same operation cannot be issued twice');
  assert.equal(fence('thread-reopened','after-config').acquired,true);
  stopCodexThreadMutationFence(first,{fenceId:'fence:after-config',stopActionId:'stop:after-config',nowMs:10});
  console.log('codex-managed-hook-config-fixture: PASS');
}finally{first.close();second.close();rmSync(root,{recursive:true,force:true});}
