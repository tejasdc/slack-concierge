import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'codex-runner-relay-lifecycle-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION;

const [{db},policy,{RunnerRelay},{beginCodexDaemonLifecycle},{acquireCodexThreadMutationFence,stopCodexThreadMutationFence,
  reconcileCodexMutationIntent}]=await Promise.all([
  import('../src/state'),import('../src/codex-mutation-policy'),import('../src/runner-relay'),
  import('../src/codex-daemon-lifecycle'),import('../src/codex-mutation-fence'),
]);
const relay=new RunnerRelay((input:any)=>Promise.resolve(policy.codexMutationGate(input)));
const waitFor=async(test:()=>boolean,what:string)=>{for(let i=0;i<100;i++){if(test())return;await Bun.sleep(10);}throw new Error(`timed out waiting for ${what}`);};

class SocketStub {
  readyState=1;
  sent:string[]=[];
  closed=false;
  constructor(readonly data:any){}
  send(data:string){this.sent.push(data);return 1;}
  close(){this.closed=true;}
}
function upgradeRunner(path:string,principal='runner:fixture'){
  let socket:SocketStub|undefined;
  const server={upgrade(_request:Request,options:{data:any}){socket=new SocketStub(options.data);return true;}} as any;
  const response=relay.upgradeRunner(new Request(`http://fixture${path}`),server,principal);
  assert.equal(response,undefined);
  if(!socket)throw new Error('runner WebSocket upgrade did not create a socket');
  relay.handlers.open(socket as any);
  return socket;
}
function openLocal(target='runner-machine'){
  let socket:SocketStub|undefined;
  const server={upgrade(_request:Request,options:{data:any}){socket=new SocketStub(options.data);return true;}} as any;
  const response=relay.upgradeLocal(new Request(`http://fixture/runner/v1/relay/connect?runner=fixture&target=${target}`),server);
  assert.equal(response,undefined);
  if(!socket)throw new Error('local WebSocket upgrade did not create a socket');
  relay.handlers.open(socket as any);
  return socket;
}
function accept(local:SocketStub){
  const message=JSON.parse(upstream.sent.at(-1)!);
  const remote=upgradeRunner(`/runner/v1/relay/accept?id=${encodeURIComponent(message.id)}`);
  return remote;
}
const upstream=upgradeRunner('/runner/v1/relay/listen');
function pair(local:SocketStub){return (relay as any).pairs.get(local.data.id);}
async function localRequest(local:SocketStub,frame:any){
  const oldLocal=local.sent.length,oldWaiting=pair(local)?.waiting.length??0,oldRemote=pair(local)?.remote?.sent.length??0;
  relay.handlers.message(local as any,JSON.stringify(frame));
  await waitFor(()=>local.sent.length>oldLocal||(pair(local)?.waiting.length??0)>oldWaiting
    ||(pair(local)?.remote?.sent.length??0)>oldRemote||!pair(local),`owner frame ${frame.method}`);
}
async function remoteRequest(remote:SocketStub,frame:any){
  const old=remote.sent.length;
  relay.handlers.message(remote as any,JSON.stringify(frame));
  await waitFor(()=>remote.sent.length>old,'buffered owner frame');
}
async function remoteResponse(remote:SocketStub,local:SocketStub,frame:any){
  const old=local.sent.length;
  relay.handlers.message(remote as any,JSON.stringify(frame));
  await waitFor(()=>local.sent.length>old,'runner response');
  await Bun.sleep(10); // let the owner policy's asynchronous response reconciliation commit
}

try{
  const {codexMutationDescriptor,mutationDigest}=await import('../src/codex-mutation-channel.mjs');
  const protectedThread='fixture-protected-thread';
  const fixtureOwner={acceptedInputId:'fixture-source',runId:'fixture-run',dispatchAttempt:1,bindingDigest:'fixture-binding'};
  assert.equal(acquireCodexThreadMutationFence(db,{...fixtureOwner,threadId:protectedThread,fenceId:'fixture-thread-fence',nowMs:1}).acquired,true);

  // Before a runner accepts the relay, a lifecycle call is refused by the actual
  // owner gate and never enters the relay's pre-accept buffer. Ordinary machine
  // calls are not Codex writes and remain pass-through while that exact fence lives.
  const blockedLocal=openLocal();
  await localRequest(blockedLocal,{id:1,method:'accounts.codex.activate',params:{operationId:'fenced-activation',account:'fixture'}});
  assert.equal(pair(blockedLocal).waiting.length,0,'fenced lifecycle was stopped before buffering for the runner');
  assert.equal(pair(blockedLocal).remote,null);
  assert.equal(db.query("SELECT COUNT(*) AS n FROM codex_mutation_intents WHERE method='managed/daemon-lifecycle'").get()!.n,0);
  const blockedReply=JSON.parse(blockedLocal.sent.at(-1)!);
  assert.equal(blockedReply.id,1);assert.match(blockedReply.error,/thread_fenced|outstanding_mutation/);
  const machineCall={id:2,method:'watch.observe',params:{path:join(scratch,'watched-file')}};
  await localRequest(blockedLocal,machineCall);
  assert.equal(pair(blockedLocal).waiting.length,1);
  assert.deepEqual(JSON.parse(upstream.sent.at(-1)!),{op:'open',id:blockedLocal.data.id,target:'runner-machine'});
  const blockedRemote=accept(blockedLocal);
  assert.deepEqual(JSON.parse(blockedRemote.sent[0]!),machineCall,'unrelated machine call traverses the real relay unchanged');
  await remoteResponse(blockedRemote,blockedLocal,{id:2,result:{mode:'content-hash'}});
  assert.deepEqual(JSON.parse(blockedLocal.sent.at(-1)!),{id:2,result:{mode:'content-hash'}});

  assert.equal(stopCodexThreadMutationFence(db,{fenceId:'fixture-thread-fence',stopActionId:'fixture-stop',nowMs:2}).stopped,true);

  // With no remote accepted yet, lifecycle permission is consumed before the
  // request is buffered. The real relay then forwards the unchanged frame.
  const admittedLocal=openLocal();
  const activation={id:3,method:'accounts.codex.activate',params:{operationId:'activation-applied',account:'fixture'}};
  await localRequest(admittedLocal,activation);
  const issued=db.query("SELECT * FROM codex_mutation_intents WHERE method='managed/daemon-lifecycle'").get() as any;
  assert.ok(issued);assert.equal(issued.state,'forwarding');assert.equal(issued.thread_id,'*');
  assert.equal(pair(admittedLocal).waiting.length,1);
  assert.equal(pair(admittedLocal).remote,null);
  const admittedRemote=accept(admittedLocal);
  assert.deepEqual(JSON.parse(admittedRemote.sent[0]!),activation,'activation reaches the stand-in only after global permit consumption');
  await remoteResponse(admittedRemote,admittedLocal,{id:3,result:{status:'applied',account:'fixture'}});
  assert.equal((db.query('SELECT state,response_kind FROM codex_mutation_intents WHERE intent_id=?').get(issued.intent_id) as any).state,
    'reconciled_applied','a supported terminal status is reconciled by the actual owner policy');
  assert.equal((db.query('SELECT response_kind FROM codex_mutation_intents WHERE intent_id=?').get(issued.intent_id) as any).response_kind,'accepted');

  // The second lifecycle RPC returns an error. Its exact response is retained, but
  // no lifecycle outcome is inferred; global uncertainty holds later writes and recovery.
  const repair={id:4,method:'accounts.codex.repairUnmanaged',params:{operationId:'repair-error'}};
  await localRequest(admittedLocal,repair);
  const repairIntent=db.query("SELECT * FROM codex_mutation_intents WHERE method='managed/daemon-lifecycle' AND intent_id<>? ORDER BY created_at_ms DESC LIMIT 1")
    .get(issued.intent_id) as any;
  assert.ok(repairIntent);assert.equal(repairIntent.state,'forwarding');
  assert.deepEqual(JSON.parse(admittedRemote.sent.at(-1)!),repair);
  await remoteResponse(admittedRemote,admittedLocal,{id:4,error:'fixture runner error'});
  const errored=db.query('SELECT state,response_kind FROM codex_mutation_intents WHERE intent_id=?').get(repairIntent.intent_id) as any;
  assert.equal(errored.state,'response_received');assert.equal(errored.response_kind,'rpc_error');

  const nativeFrame={id:5,method:'turn/start',params:{threadId:'thread-after-uncertain-lifecycle',input:[]}};
  const nativeDescriptor=codexMutationDescriptor(nativeFrame);
  const nativeGate=policy.codexMutationGate({phase:'prepare',connectionId:'native-probe',permitId:'native-probe:1',intentId:'native-probe:1',
    ...nativeDescriptor,params:nativeFrame.params});
  assert.equal(nativeGate.allowed,false,'uncertain runner lifecycle blocks new native Codex writes');
  const recovery=beginCodexDaemonLifecycle(db,{operationId:'recovery-after-error',paramsDigest:mutationDigest({recover:true}),nowMs:20});
  assert.equal(recovery.forward,false,'uncertain runner lifecycle blocks daemon recovery');
  assert.equal(acquireCodexThreadMutationFence(db,{...fixtureOwner,threadId:'thread-recovery-after-error',fenceId:'recovery-after-error',nowMs:21}).acquired,false,
    'uncertain global lifecycle blocks thread recovery fences');

  // Machine calls keep working through the same relay while lifecycle custody is uncertain.
  const laterMachineCall={id:6,method:'watch.isDirectory',params:{path:scratch}};
  await localRequest(admittedLocal,laterMachineCall);
  assert.deepEqual(JSON.parse(admittedRemote.sent.at(-1)!),laterMachineCall);
  await remoteResponse(admittedRemote,admittedLocal,{id:6,result:true});
  assert.deepEqual(JSON.parse(admittedLocal.sent.at(-1)!),{id:6,result:true});

  console.log('codex runner relay lifecycle fixture: actual RunnerRelay gates activate/repair before buffering or native forwarding, passes unrelated machine calls, and retains ambiguous lifecycle custody: PASS');
}finally{
  relay.closeAll('fixture complete');
  db.close();
  rmSync(scratch,{recursive:true,force:true});
}
