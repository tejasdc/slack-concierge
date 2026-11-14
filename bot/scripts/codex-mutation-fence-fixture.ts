import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import {
  acquireCodexThreadMutationFence, consumeCodexMutationPermit, getCodexThreadMutationFence,
  grantCodexMutationPermit, initializeCodexMutationFenceSchema, listCodexThreadMutationIntents,
  reconcileCodexMutationIntent, recordCodexMutationResponse, stopCodexThreadMutationFence,
} from '../src/codex-mutation-fence';

const workerArgs=process.argv.slice(2);
if(workerArgs[0]==='--race-acquire') {
  const [,databasePath,barrierDir,lane]=workerArgs;
  const db=new Database(databasePath);
  db.exec('PRAGMA busy_timeout=10000');
  await writeFile(join(barrierDir,`${lane}.ready`),'ready');
  while(true){try{await readFile(join(barrierDir,'go'));break;}catch{await Bun.sleep(5);}}
  const result=acquireCodexThreadMutationFence(db,{threadId:'thread-race',fenceId:`fence-${lane}`,
    acceptedInputId:`input-${lane}`,runId:`run-${lane}`,dispatchAttempt:1,bindingDigest:`binding-${lane}`,nowMs:10});
  console.log(JSON.stringify({lane,result}));
  db.close();
  process.exit(0);
}

const root=await mkdtemp(join(tmpdir(),'codex-mutation-fence-'));
const databasePath=join(root,'ledger.sqlite');
const db1=new Database(databasePath);
db1.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000');
initializeCodexMutationFenceSchema(db1);
const db2=new Database(databasePath);
db2.exec('PRAGMA busy_timeout=10000');
const owner={acceptedInputId:'input-one',runId:'run-one',dispatchAttempt:1,bindingDigest:'binding-one'};
const grant=(permitId:string,threadId='thread-one',purpose:'ordinary'|'fenced_recovery'='ordinary',fenceId?:string,who=owner)=>
  grantCodexMutationPermit(db1,{permitId,threadId,owner:who,method:'turn/start',paramsDigest:`digest:${permitId}`,purpose,fenceId,nowMs:1});
const consume=(permitId:string,intentId:string,database=db1)=>consumeCodexMutationPermit(database,{permitId,intentId,paramsDigest:`digest:${permitId}`,nowMs:2});

try {
  // Two independent Bun processes reach the same barrier before taking SQLite's write lock.
  const barrier=join(root,'barrier');
  await Bun.$`mkdir -p ${barrier}`;
  const race=(lane:string)=>Bun.spawn([process.execPath,import.meta.path,'--race-acquire',databasePath,barrier,lane],{stdout:'pipe',stderr:'pipe'});
  const a=race('a'),b=race('b');
  for(const lane of ['a','b']) while(true){try{await readFile(join(barrier,`${lane}.ready`));break;}catch{await Bun.sleep(5);}}
  await writeFile(join(barrier,'go'),'go');
  const [aOut,bOut]=await Promise.all([a.stdout.text(),b.stdout.text()]);
  const [aExit,bExit]=await Promise.all([a.exited,b.exited]);
  assert.equal(aExit,0);assert.equal(bExit,0);
  const results=[JSON.parse(aOut.trim()),JSON.parse(bOut.trim())];
  assert.equal(results.filter(x=>x.result.acquired).length,1,'only one of two independent clients reserves one native thread');
  assert.equal(results.filter(x=>x.result.reason==='already_fenced').length,1);
  const raceFence=getCodexThreadMutationFence(db1,'thread-race')!;
  const winningOwner={acceptedInputId:raceFence.acceptedInputId,runId:raceFence.runId,
    dispatchAttempt:raceFence.dispatchAttempt,bindingDigest:raceFence.bindingDigest};
  stopCodexThreadMutationFence(db1,{fenceId:raceFence.fenceId,stopActionId:'stop-race-fixture',nowMs:1});

  // Ordinary write intent exists before forwarding and fences cannot cross its uncertainty.
  assert.equal(grant('p-ordinary').granted,true);
  assert.equal(consume('p-ordinary','i-ordinary').forward,true);
  assert.equal(consume('p-ordinary','i-ordinary',db2).forward,false,'duplicate consume is retained and never forwards twice');
  assert.equal(consume('p-ordinary','i-other',db2).forward,false,'a consumed permit cannot mint another intent');
  assert.equal(acquireCodexThreadMutationFence(db2,{threadId:'thread-one',fenceId:'blocked-fence',...owner,nowMs:3}).reason,'outstanding_mutation');
  recordCodexMutationResponse(db2,{intentId:'i-ordinary',kind:'rpc_error',responseDigest:'error-digest',nowMs:4});
  assert.equal(acquireCodexThreadMutationFence(db1,{threadId:'thread-one',fenceId:'still-blocked',...owner,nowMs:5}).reason,'outstanding_mutation',
    'RPC errors do not establish that the native method had no effects');
  assert.equal(grantCodexMutationPermit(db1,{permitId:'p-global',threadId:'*',owner,method:'config/write',paramsDigest:'global-digest',
    purpose:'ordinary',nowMs:6}).granted,true,'threadless/global mutations use the explicit wildcard identity');
  assert.equal(consumeCodexMutationPermit(db2,{permitId:'p-global',intentId:'i-global',paramsDigest:'global-digest',nowMs:6}).forward,true);
  assert.equal(acquireCodexThreadMutationFence(db2,{threadId:'thread-unrelated',fenceId:'unrelated-blocked',...owner,nowMs:6}).acquired,false,
    'an outstanding global intent blocks exact-thread fences');
  assert.equal(acquireCodexThreadMutationFence(db2,{threadId:'thread-one',fenceId:'global-blocked',...owner,nowMs:6}).acquired,false,
    'the same global intent blocks a different exact-thread fence');
  reconcileCodexMutationIntent(db1,{intentId:'i-global',outcome:'applied',evidenceDigest:'global-proof',nowMs:7});
  assert.equal(acquireCodexThreadMutationFence(db2,{threadId:'thread-unrelated',fenceId:'unrelated-fence',...owner,nowMs:7}).acquired,true,
    'after global intent reconciliation, unrelated native threads have independent reservations');
  reconcileCodexMutationIntent(db1,{intentId:'i-ordinary',outcome:'applied',evidenceDigest:'terminal-proof',nowMs:7});
  assert.equal(grant('p-before-fence','thread-one').granted,true);
  assert.equal(acquireCodexThreadMutationFence(db2,{threadId:'thread-one',fenceId:'fence-one',...owner,nowMs:8}).acquired,true);
  assert.equal(acquireCodexThreadMutationFence(db2,{threadId:'thread-one',fenceId:'fence-one',...owner,nowMs:8}).acquired,true);
  const fence=getCodexThreadMutationFence(db1,'thread-one')!;
  assert.equal(acquireCodexThreadMutationFence(db2,{threadId:'thread-one',fenceId:'fence-one',...owner,nowMs:8}).duplicate,true,
    'exact fence acquisition retries return the retained reservation');

  // A pre-fence unused permit is revoked; fenced mutation requires the exact fence owner.
  assert.equal(consume('p-before-fence','i-revoked',db2).reason,'revoked','fence acquisition revokes previously granted, unused permits');
  assert.equal(grant('p-blocked','thread-one').granted,false);
  assert.equal(grant('p-recovery','thread-one','fenced_recovery',fence.fenceId,owner).granted,true);
  assert.equal(grantCodexMutationPermit(db2,{permitId:'p-wrong-owner',threadId:'thread-one',owner:winningOwner,
    method:'turn/start',paramsDigest:'digest:p-wrong-owner',purpose:'fenced_recovery',fenceId:fence.fenceId,nowMs:9}).granted,false,
    'reservation identity includes the accepted input, run, dispatch attempt and binding digest');
  const recovered=consume('p-recovery','i-recovery',db2);
  assert.equal(recovered.forward,true);
  assert.equal(recovered.intent?.thread_revision,2,'thread revisions are monotonically assigned at each actual forwarding intent');
  const stopped=stopCodexThreadMutationFence(db1,{fenceId:fence.fenceId,stopActionId:'stop-one',nowMs:10});
  assert.equal(stopped.stopped,true);
  assert.equal(stopCodexThreadMutationFence(db2,{fenceId:fence.fenceId,stopActionId:'stop-one',nowMs:10}).duplicate,true,
    'exact Stop retries return retained terminal state');
  assert.equal(grant('p-ordinary-after-stop','thread-one').granted,false,
    'a stopped fence keeps ordinary writers out while its issued mutation is unresolved');
  assert.equal(acquireCodexThreadMutationFence(db2,{threadId:'thread-one',fenceId:'fence-after-stop',...owner,nowMs:11}).reason,'outstanding_mutation',
    'Stop removes reservation but keeps the issued mutation as an acquisition blocker');
  reconcileCodexMutationIntent(db1,{intentId:'i-recovery',outcome:'not_applied',evidenceDigest:'terminal-not-applied',nowMs:12});
  assert.equal(grant('p-ordinary-after-reconcile','thread-one').granted,true,
    'ordinary writers resume only after exact reconciliation clears the stopped reservation guard');
  assert.equal(acquireCodexThreadMutationFence(db2,{threadId:'thread-one',fenceId:'fence-after-reconcile',...owner,nowMs:13}).acquired,true);

  // Retained identity/status survive closing both handles and a fresh client restart.
  db1.close();db2.close();
  const restarted=new Database(databasePath);
  assert.equal(listCodexThreadMutationIntents(restarted,'thread-one').length,2);
  const retained=listCodexThreadMutationIntents(restarted,'thread-one');
  assert.equal(retained[0].response_kind,'rpc_error');
  assert.equal(retained[0].state,'reconciled_applied');
  assert.equal(retained[1].state,'reconciled_not_applied');
  assert.equal(retained[1].thread_revision,2);
  restarted.close();
  console.log('codex-mutation-fence-fixture: PASS');
} finally {
  try{db1.close();}catch{}
  try{db2.close();}catch{}
  await rm(root,{recursive:true,force:true});
}
