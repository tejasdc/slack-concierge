import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Database} from 'bun:sqlite';
import {beginCodexDaemonLifecycle} from '../src/codex-daemon-lifecycle';
import {initializeCodexMutationFenceSchema,recordCodexMutationResponse,reconcileCodexMutationIntent,
  acquireCodexThreadMutationFence,stopCodexThreadMutationFence,listCodexThreadMutationIntents} from '../src/codex-mutation-fence';

const root=await mkdtemp(join(tmpdir(),'provider-activation-lifecycle-'));
const databasePath=join(root,'ledger.sqlite'),marker=join(root,'stand-in-native-daemon-state');
const db1=new Database(databasePath),db2=new Database(databasePath);
db1.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000');db2.exec('PRAGMA busy_timeout=10000');
initializeCodexMutationFenceSchema(db1);
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const start=async(operationId:string)=>beginCodexDaemonLifecycle(db1,{operationId,paramsDigest:digest('account activation restart:v1'),nowMs:Date.now()});
const fixtureOwner={acceptedInputId:'fixture-input',runId:'fixture-run',dispatchAttempt:1};

try{
  // A live thread reservation prevents daemon lifecycle forwarding. The stand-in command is not
  // invoked, so this models the guarantee at the precise pre-forward boundary.
  const fenced=acquireCodexThreadMutationFence(db1,{threadId:'thread-held',fenceId:'fence-held',...fixtureOwner,nowMs:1});
  assert.equal(fenced.acquired,true);
  const denied=await start('operation-blocked-by-thread-fence');
  assert.equal(denied.forward,false);
  await Bun.write(marker,'not-invoked');
  assert.equal(await readFile(marker,'utf8'),'not-invoked');
  stopCodexThreadMutationFence(db1,{fenceId:'fence-held',stopActionId:'stop-held',nowMs:1});

  // Successful source-owned operation: begin globally, run a harmless local child as the native
  // command stand-in, retain the response, verify the stand-in result, then reconcile exactly once.
  const admitted=await start('operation-healthy');
  assert.equal(admitted.forward,true);
  const child=Bun.spawn([process.execPath,'-e',
    'require("node:fs").writeFileSync(process.argv[1],"restarted")',marker],{stdout:'ignore',stderr:'ignore'});
  assert.equal(await child.exited,0);
  const responseDigest=digest(`${admitted.intentId}:accepted:0:false`);
  recordCodexMutationResponse(db2,{intentId:admitted.intentId,kind:'accepted',responseDigest,nowMs:2});
  const verifiedHealthy=(await readFile(marker,'utf8'))==='restarted';
  assert.equal(verifiedHealthy,true);
  reconcileCodexMutationIntent(db1,{intentId:admitted.intentId,outcome:'applied',
    evidenceDigest:digest(`${admitted.intentId}:healthy:${responseDigest}`),nowMs:3});
  assert.equal((await start('operation-healthy')).forward,false,'the original operation identity cannot issue a second lifecycle effect');
  assert.equal(acquireCodexThreadMutationFence(db2,{threadId:'thread-free',fenceId:'fence-after-healthy',...fixtureOwner,nowMs:4}).acquired,true,
    'an explicitly verified and reconciled lifecycle operation releases the global mutation gate');
  stopCodexThreadMutationFence(db1,{fenceId:'fence-after-healthy',stopActionId:'stop-free',nowMs:4});

  // A command response with a nonzero status does not establish absence of effects. The unresolved
  // global intent blocks both another daemon lifecycle operation and an exact-thread fence.
  const uncertain=await start('operation-unhealthy');
  assert.equal(uncertain.forward,true);
  const failed=Bun.spawn([process.execPath,'-e','process.exit(7)'],{stdout:'ignore',stderr:'ignore'});
  assert.equal(await failed.exited,7);
  recordCodexMutationResponse(db1,{intentId:uncertain.intentId,kind:'rpc_error',
    responseDigest:digest(`${uncertain.intentId}:rpc_error:7:false`),nowMs:5});
  assert.equal((await start('operation-retry')).forward,false,'an uncertain prior daemon effect cannot be blindly retried');
  assert.equal(acquireCodexThreadMutationFence(db2,{threadId:'thread-blocked',fenceId:'fence-blocked',...fixtureOwner,nowMs:6}).acquired,false,
    'an unresolved global daemon effect blocks recovery fencing on every thread');
  const retained=listCodexThreadMutationIntents(db2,'*');
  assert.equal(retained.some(intent=>intent.intent_id===uncertain.intentId&&intent.state==='response_received'&&intent.response_kind==='rpc_error'),true);

  // Existing read-only thread access and independent already-reconciled state remain available.
  assert.equal(db2.query('SELECT count(*) AS n FROM codex_thread_mutation_fences').get()!.n,2);
  assert.equal(db2.query('SELECT count(*) AS n FROM codex_thread_mutation_fences WHERE thread_id=?').get('thread-free')!.n,1,
    'a read of another native thread remains available while a global effect is unresolved');
  console.log('provider-activation-lifecycle-fixture: PASS');
}finally{
  db1.close();db2.close();await rm(root,{recursive:true,force:true});
}
