import {strict as assert} from 'node:assert';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createCustodyRelayFixture} from './fixtures/custody-relay-harness';
import {RunnerRelay} from '../src/runner-relay';
import {CodexAppServerClient,freezeManagedCodexTarget} from '../src/codex-app-server-client';
import {loadedRunnerIdentity,serveCodexRelayPair} from '../src/runner-codex-relay';
import {rewriteRelayedCodexRequest} from '../src/runner-machine';

const root=mkdtempSync(join(tmpdir(),'protected-relay-negative-'));
mkdirSync(join(root,'home'));mkdirSync(join(root,'codex'));
process.env.HOME=join(root,'home');process.env.CODEX_HOME=join(root,'codex');process.env.CONCIERGE_STATE_DIR=root;
const socketPath=join(root,'native-substitute.sock');process.env.CONCIERGE_CODEX_APP_SERVER_SOCKET=socketPath;
const methods:string[]=[];
const heldHandlers=new Map<string,{release:Promise<void>;finish:()=>void;read:Promise<void>;readArrived:()=>void}>();
const chains=new WeakMap<object,Map<string,Promise<void>>>();
function heldHandler(threadId:string){
  let finish!:()=>void,readArrived!:()=>void;
  const held={release:new Promise<void>(resolve=>{finish=resolve;}),finish:()=>finish(),read:new Promise<void>(resolve=>{readArrived=resolve;}),readArrived:()=>readArrived()};
  heldHandlers.set(threadId,held);return held;
}
const native=Bun.serve({unix:socketPath,fetch:(request,server)=>server.upgrade(request)?undefined:new Response('ws only'),websocket:{message(socket,data){
  const frame=JSON.parse(String(data));methods.push(frame.method);
  if(frame.method==='initialize')socket.send(JSON.stringify({id:frame.id,result:{userAgent:'explicit-native-substitute'}}));
  else if(frame.id){
    const threadId=frame.params?.threadId??'',held=heldHandlers.get(threadId);
    const key=frame.params?.path?`path:${frame.params.path}`:frame.method==='thread/start'?'unkeyed:thread/start':`thread:${threadId}`;
    const keyed=chains.get(socket)??new Map<string,Promise<void>>();chains.set(socket,keyed);
    if(frame.method==='thread/read')held?.readArrived();
    const task=(keyed.get(key)??Promise.resolve()).then(async()=>{
      socket.send(JSON.stringify({id:frame.id,result:{received:frame.params,thread:{id:threadId||'native-substitute-created'}}}));
      // Explicit substitute for stock same-literal-key handler completion AFTER its RPC response.
      if(frame.method==='thread/resume'&&!frame.params.path&&held)await held.release;
    });keyed.set(key,task);
  }
}}});
let harness:Awaited<ReturnType<typeof createCustodyRelayFixture>>|undefined;
try {
  harness=await createCustodyRelayFixture(root,socketPath);
  const client=harness.client();await client.connect();
  const machine=client.nativeEndpoint.relayAssociation!.preparation.machine;
  const params={cwd:root,config:{shell_environment_policy:{inherit:'all',set:{EXACT:'retained',PATH:'/usr/bin'}}}};
  const message=JSON.stringify({id:9,method:'thread/start',params});
  const effective=rewriteRelayedCodexRequest(message,machine).text;
  assert.equal(rewriteRelayedCodexRequest(effective,machine).text,effective,'assessed effective runner mapping is idempotent');
  const actual=await client.request('thread/start',JSON.parse(effective).params,{custodyOwnerSessionId:900});
  assert.deepEqual(actual.received,JSON.parse(effective).params,'native receives assessed effective configuration');

  // The substitute native serializer is deliberate; all forwarding hops and capture/barrier code
  // are real. In particular, an RPC response must NOT stand in for handler completion.
  const predecessor=harness.client();const delayed=heldHandler('relay-barrier-delayed');
  await predecessor.request('thread/resume',{threadId:'relay-barrier-delayed'},{custodyOwnerSessionId:901});
  const cutoff=freezeManagedCodexTarget({ownerSessionId:901,threadId:'relay-barrier-delayed',endpoint:client.nativeEndpoint,timeoutMs:2000});
  const reconciling=cutoff.reconcile();await delayed.read;
  assert.equal(cutoff.barriers.length,0,'the actual relayed barrier cannot precede the earlier native handler');
  delayed.finish();const receipt=await reconciling;
  assert.equal(receipt.barriers.length,1);assert.deepEqual(receipt.unresolved,[]);
  assert.equal(receipt.captured[0]?.generation,predecessor.activeGeneration);

  const lost=harness.client();const lostHandler=heldHandler('relay-close-before-barrier');
  await lost.request('thread/resume',{threadId:'relay-close-before-barrier'},{custodyOwnerSessionId:902});
  const lostCutoff=freezeManagedCodexTarget({ownerSessionId:902,threadId:'relay-close-before-barrier',endpoint:client.nativeEndpoint,timeoutMs:2000});
  await lost.close();const lostReceipt=await lostCutoff.reconcile();lostHandler.finish();
  assert.equal(lostReceipt.barriers.length,0);assert.ok(lostReceipt.unresolved.some(reason=>reason.includes('lost captured generation')));

  for(const [ownerSessionId,method,params,classification] of [
    [903,'thread/resume',{threadId:'relay-path-remainder',path:join(root,'retained-rollout')},'thread-path'],
    [904,'thread/start',{cwd:root},'unkeyed-thread'],
  ] as const){
    const remainder=harness.client();await remainder.request(method,params,{custodyOwnerSessionId:ownerSessionId});
    const remainderReceipt=await freezeManagedCodexTarget({ownerSessionId,threadId:ownerSessionId===903?'relay-path-remainder':'relay-unkeyed-remainder',endpoint:client.nativeEndpoint,timeoutMs:2000}).reconcile();
    assert.ok(remainderReceipt.unresolved.some(reason=>reason.includes(classification)),'a thread barrier cannot dispose another serialization key');
    await remainder.close();
  }
  const ordinary=harness.client(false);
  await ordinary.request('thread/resume',{threadId:'ordinary-unassociated'},{custodyOwnerSessionId:905});
  assert.equal(ordinary.nativeEndpoint.relayAssociation,undefined,'ordinary relay must not construct an association');
  const ordinaryHold=await freezeManagedCodexTarget({ownerSessionId:905,threadId:'ordinary-unassociated',endpoint:client.nativeEndpoint,timeoutMs:2000}).reconcile();
  assert.equal(ordinaryHold.barriers.length,0);
  assert.ok(ordinaryHold.unresolved.some(reason=>reason.includes('association')),'unassociated ordinary predecessor must keep custody held');
  await ordinary.close();
  // A required pin cannot be created when the pin directory is a regular file.
  writeFileSync(join(harness.runnerState,'hook-pins'),'cannot create codex directory');
  const before=methods.length;
  await assert.rejects(client.request('turn/start',{threadId:'fixture-pin-failure',input:[]},{requestTimeoutMs:2000}));
  assert.equal(methods.slice(before).includes('turn/start'),false,'protected pin failure must prevent native turn/start');

  // The protected-only adapter exposes no daemon-management callbacks. An absent native
  // endpoint must close this exact pair rather than starting or replacing native.
  const machineForAbsent={...machine,stateDir:join(root,'absent-state')};
  let closed!:()=>void;const didClose=new Promise<void>(resolve=>{closed=resolve;});
  const remote={readyState:1,binaryType:'',send(){},close(){closed();}} as unknown as WebSocket;
  const pair=serveCodexRelayPair({id:'absent',challenge:'absent-challenge',protected:true,remote,socketPath:join(root,'absent.sock'),
    machine:machineForAbsent,identity:loadedRunnerIdentity(machineForAbsent),nodeExecutable:process.env.CONCIERGE_NODE_BIN||'/usr/bin/node',
    pinThread(){throw new Error('not expected');}});
  await didClose;await pair.exited;

  // An old runner recognizes only op=open. The gateway sends a distinct protected command,
  // so its managing native-open code cannot run even before an acknowledgement is available.
  const relay=new RunnerRelay();
  const legacySocket=join(root,'legacy-gateway.sock');
  const gateway=Bun.serve({unix:legacySocket,fetch(request,server){return new URL(request.url).pathname.endsWith('/listen')
    ?relay.upgradeRunner(request,server,'runner:legacy'):relay.upgradeLocal(request,server);},websocket:relay.handlers});
  let received!:(value:any)=>void;const command=new Promise<any>(resolve=>{received=resolve;});let managingOpens=0;
  const legacy=new WebSocket(`ws+unix://${legacySocket}:/runner/v1/relay/listen`);
  await new Promise<void>((resolve,reject)=>{legacy.onopen=()=>resolve();legacy.onerror=reject;});
  legacy.onmessage=event=>{const frame=JSON.parse(String(event.data));if(frame.op==='open')managingOpens++;received(frame);};
  const legacyClient=new CodexAppServerClient(legacySocket,process.env.CONCIERGE_NODE_BIN||'/usr/bin/node',{
    relayRunner:'legacy',protectedRelay:true,manageDaemon:false,bridgePath:resolve(import.meta.dir,'../src/codex-app-server-bridge.mjs')});
  const connecting=legacyClient.connect();const rejected=assert.rejects(connecting);
  assert.equal((await command).op,'protected-open-v1');assert.equal(managingOpens,0);
  await legacyClient.close();await rejected;legacy.close();relay.closeAll();gateway.stop(true);
  console.log(JSON.stringify({ok:true,kind:'native-effect-substitutes',assertions:['effective configuration reaches native substitute unchanged after idempotent rewrite',
    'same-generation relayed barrier waits for delayed literal-key handler after RPC response','relay close before barrier remains unresolved','path and unkeyed effects remain unresolved after target barrier',
    'ordinary unassociated predecessor remains held','required hook pin failure withholds protected turn/start','absent native endpoint refuses through protected-only adapter','old runner never receives ordinary open for protected request'],
    substitutes:'native RPC responses; actual client/bridge/gateway/runner forwarding, actual FD peer credentials'}));
}finally{await harness?.close();native.stop(true);rmSync(root,{recursive:true,force:true});}
