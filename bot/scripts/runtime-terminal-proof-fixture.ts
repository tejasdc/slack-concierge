import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mock} from 'bun:test';
import {createHash} from 'node:crypto';

const root=mkdtempSync(join(tmpdir(),'concierge-runtime-proof-'));
const nodeExecutable=process.env.CONCIERGE_NODE_BIN?.trim()||Bun.which('node');
assert(nodeExecutable,'The runtime proof fixture requires Node through CONCIERGE_NODE_BIN or PATH.');
process.env.CONCIERGE_NODE_BIN=nodeExecutable;
console.log(JSON.stringify({fixture:'runtime-terminal-proof-node',nodeExecutable,staticNodePathExists:existsSync('/usr/bin/node'),bun:Bun.version}));
const daemon=await import('../src/codex-daemon-file-limit');
let tune=0,move=0,start=0;
mock.module('../src/codex-daemon-file-limit',()=>({...daemon,
  raiseCodexDaemonFileLimit:async()=>{tune++;},moveCodexDaemonToOwnScope:async()=>{move++;},startCodexDaemonWhenAbsent:()=>{start++;},
}));
const {CodexAppServerClient,sharedCodexAppServerClient,closeSharedCodexAppServerClient}=await import('../src/codex-app-server-client');
const {sameRuntime}=await import('../src/codex-runtime-maintenance');
const effects=()=>[tune,move,start];
const missing=join(root,'absent.sock'),bridge=join(root,'disconnect.mjs');
writeFileSync(bridge,"process.stdout.write(JSON.stringify({type:'disconnect',error:'connect ENOENT /fixture-absent'})+'\\n');setInterval(()=>{},1000);");
class PrivateProofClient extends CodexAppServerClient{
  constructor(_socket?:string,_node?:string,options:any={}){super(missing,nodeExecutable,{...options,bridgePath:bridge,shutdownGraceMs:25});}
}
let server:ReturnType<typeof Bun.serve>|undefined;
try{
  // Positive control: the unmodified ordinary client keeps its lifecycle recovery behavior.
  const ordinary=new PrivateProofClient();
  await assert.rejects(ordinary.request('model/list',{}, {requestTimeoutMs:1000}),{message:'connect ENOENT /fixture-absent'});await ordinary.close();
  assert.deepEqual(effects(),[1,1,1]);console.log('PASS actual ordinary direct client retains tune/move/start recovery control');
  tune=move=start=0;
  // Execute the complete shipping runner proof function with the actual client and a private
  // failing bridge. Only its socket/bridge and daemon-effect boundaries are substituted.
  const source=readFileSync(join(import.meta.dir,'../src/runner-provider-accounts.ts'),'utf8');
  const begin=source.indexOf('async function proveRuntimeMaintenanceReplacement('),end=source.indexOf('async function runnerRuntimeMaintenance(',begin);
  assert(begin>=0&&end>begin);
  const body=new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(begin,end));
  const prove=new Function('CodexAppServerClient','runtimeMaintenanceSnapshot','sameRuntime',body+'\nreturn proveRuntimeMaintenanceReplacement;')
    (PrivateProofClient,async()=>null,sameRuntime);
  await assert.rejects(prove({pid:42,bootId:'fixture',startTicks:'1'}),{message:'connect ENOENT /fixture-absent'});
  assert.deepEqual(effects(),[0,0,0],'runner terminal proof cannot tune/move/start on listener loss');
  console.log('PASS actual runner proof + actual client: disappearing listener causes zero daemon effects');

  process.env.CONCIERGE_STATE_DIR=root;process.env.CONCIERGE_CODEX_RUNNER='fixture-runner';
  const connections:{target:string;socket:any}[]=[];
  let held:{socket:any;id:any}|undefined,arrived!:()=>void,failProtected=false;
  const pendingRead=new Promise<void>(resolve=>{arrived=resolve;});
  server=Bun.serve<{target:string;challenge:string}>({unix:join(root,'requests.sock'),
    fetch(request,server){const url=new URL(request.url);return server.upgrade(request,{data:{target:url.searchParams.get('target')??'',challenge:url.searchParams.get('challenge')??''}})?undefined:new Response('websocket required');},
    websocket:{open(socket){connections.push({target:socket.data.target,socket});
      if(socket.data.target==='codex-app-server-protected-v1'){
        if(failProtected){socket.close(1011,'fixture listener disappeared');return;}
        socket.send(JSON.stringify({conciergeRelay:'association-v1',association:{version:1,pairId:'fixture-pair',challenge:socket.data.challenge,runner:'fixture-runner',protected:true}}));
      }
    },message(socket,data){const frame=JSON.parse(String(data));
      if(frame.method==='initialize')socket.send(JSON.stringify({id:frame.id,result:{userAgent:'private-native-substitute'}}));
      if(frame.method==='model/list')socket.send(JSON.stringify({id:frame.id,result:{data:[{id:'fixture-model'}]}}));
      if(frame.method==='thread/read'){held={socket,id:frame.id};arrived();}
    }},
  });
  const shared=sharedCodexAppServerClient();
  const live=shared.request('thread/read',{threadId:'accepted-live-rpc'}, {requestTimeoutMs:5000});
  await pendingRead;const ordinaryGeneration=shared.activeGeneration;
  assert.equal(connections[0]?.target,'codex-app-server','ordinary requests retain their ordinary receiver');
  const before=effects();assert.equal((await shared.observeModels({requestTimeoutMs:1000})).data[0].id,'fixture-model');
  const proof=(shared as any).modelObservationClient;
  assert.equal(sharedCodexAppServerClient(),shared);assert.equal(proof.nativeEndpoint.socketPath,shared.nativeEndpoint.socketPath);
  assert.equal(proof.nativeEndpoint.relayRunner,shared.nativeEndpoint.relayRunner);assert.equal(proof.nativeEndpoint.relayAssociation.protected,true);
  await shared.observeModels({requestTimeoutMs:1000});
  assert.equal((shared as any).modelObservationClient,proof);assert.equal(connections.filter(row=>row.target==='codex-app-server-protected-v1').length,1);
  assert.equal(shared.activeGeneration,ordinaryGeneration,'proof cannot replace the active ordinary generation');

  const disconnected=new Promise<void>(resolve=>proof.onDisconnect(()=>resolve()));
  connections.find(row=>row.target==='codex-app-server-protected-v1')!.socket.close(1011,'fixture generation disappeared');await disconnected;
  failProtected=true;await assert.rejects(shared.observeModels({requestTimeoutMs:1000}));
  assert.deepEqual(effects(),before,'failed protected reconnect cannot tune/move/start');
  assert.equal(shared.activeGeneration,ordinaryGeneration);
  failProtected=false;assert.equal((await shared.observeModels({requestTimeoutMs:1000})).data.length,1);
  assert.equal((shared as any).modelObservationClient,proof,'the same retained proof lane reconnects');
  held!.socket.send(JSON.stringify({id:held!.id,result:{thread:{id:'accepted-live-rpc'}}}));
  assert.equal((await live).thread.id,'accepted-live-rpc','ordinary accepted RPC survives proof success, failure and reconnect');
  await closeSharedCodexAppServerClient();
  assert.equal(shared.activeGeneration,null);assert.equal(proof.activeGeneration,null);
  await assert.rejects(shared.observeModels(),/closed/);await assert.rejects(proof.request('model/list',{}),/closed/);
  console.log('PASS actual persistent owner client + Unix bridge: retained protected lane, exact endpoint, reconnect, RPC/error isolation and paired close');

  // Execute the complete actual receiver function, including its ordinary lifecycle effects.
  // Explicit socket substitutes make absence deterministic; no real runner/daemon is touched.
  const runner=readFileSync(join(import.meta.dir,'runner.ts'),'utf8');
  const relayBegin=runner.indexOf('function relayCodexAppServer('),relayEnd=runner.indexOf('/**',relayBegin);
  const sockets:any[]=[];let starts=0,supervised=0,pairs=0;
  class Socket{static OPEN=1;static CONNECTING=0;readyState=0;onopen:any;onerror:any;constructor(..._args:any[]){sockets.push(this);}close(){}}
  const relayBody=new Bun.Transpiler({loader:'ts'}).transformSync(runner.slice(relayBegin,relayEnd));
  const relay=new Function('WebSocket','relayBase','token','relayIdentity','machine','managedAppServer','serveCodexRelayPair',
    'codexAppServerSocketPath','superviseCodexAppServer','fromOwner','pinCodexThread','say','existsSync','controlSocketListeners','startCodexDaemonWhenAbsent',relayBody+'\nreturn relayCodexAppServer;')
    (Socket,'ws://fixture','fixture',{}, {},true,()=>{pairs++;},()=>missing,()=>{supervised++;},(x:any)=>x,()=>{},()=>{},()=>false,()=>[],()=>{starts++;});
  relay('ordinary','challenge',false,'ticket');sockets.at(-1).onopen();sockets.at(-1).onerror();assert.equal(starts,1);assert.equal(supervised,1);
  relay('protected','challenge',true,'ticket');assert.equal(pairs,1);assert.equal(starts,1);assert.equal(supervised,1);
  assert.deepEqual(effects(),before);
  console.log('PASS actual receiver: protected pair has zero supervision/start effects; ordinary control retains both');

  // Exact d08 receiver source is committed as data so a shallow release checkout exercises
  // actual old-handler behavior without relying on its git object or an invented capability mock.
  const oldSource=readFileSync(join(import.meta.dir,'fixtures/runtime-maintenance-d08-receiver.txt'),'utf8');
  assert.equal(createHash('sha256').update(oldSource).digest('hex'),'348d5423b1ed443d81bfcbe463df8f530e151cf00e662518b5a64c2ae2d623e0');
  const oldBody=new Bun.Transpiler({loader:'ts'}).transformSync(oldSource.replace('export async function serveRunnerAccountCall','async function serveRunnerAccountCall'));
  const {progressRuntimeMaintenance,sameRuntimeMaintenanceBinding}=await import('../src/codex-runtime-maintenance');
  const binding={operationId:`runtime:${'a'.repeat(40)}`,sourceInputId:'fixture-source',sourceRunId:'fixture-run',actionId:'fixture-action',requiredCommit:'b'.repeat(40)};
  const operations=new Map([[binding.operationId,{id:binding.operationId,account:'',status:'starting',runtimeMaintenance:{binding,phase:'waiting'}}]]);
  let oldStarts=0;
  const oldReceiver=new Function('activationOperations','codexActivationFlight','unmanagedRepair','runtimeMaintenanceReserved',
    'runtimeMaintenancePending','writeActivationState','holdCodexDaemonAutoStart','readJson','join','runCommand','controlSocketListeners',
    'codexAppServerSocketPath','processIdentity','isProcessIdentityAlive','statSync','LEDGER_IMAGE_PATH','CodexAppServerClient',
    'progressRuntimeMaintenance','codexUpdaterDisabled','startCodexDaemonInOwnScope','sameRuntime','sameRuntimeMaintenanceBinding',oldBody+'\nreturn serveRunnerAccountCall;')
    (operations,null,null,false,()=>true,()=>{},()=>{},()=>({control_git_commit:'b'.repeat(40)}),join,async()=>({code:0}),
      ()=>[],()=>missing,()=>{throw new Error('unexpected old process identity read');},()=>false,()=>{},'/fixture-image',PrivateProofClient,
      progressRuntimeMaintenance,()=>true,async()=>{oldStarts++;return {code:0};},sameRuntime,sameRuntimeMaintenanceBinding);
  await assert.rejects(oldReceiver('accounts.codex.runtimeMaintenance.publish',{binding},{activeTurns:1,botDir:'/fixture/control/bot'}),/does not answer/);
  assert.equal(oldStarts,0,'publication-only intent remains inert after reconnecting to an old pending receiver');
  await oldReceiver('accounts.codex.runtimeMaintenance',{binding,persistOnly:true},{activeTurns:1,botDir:'/fixture/control/bot'});
  assert.equal(oldStarts,1,'positive control: the actual old handler ignores the option and can start before the owner idle guard');
  console.log('PASS exact old receiver/pending-state control: distinct publication method refuses with zero effects; ignored-option control starts once');
}finally{await closeSharedCodexAppServerClient().catch(()=>{});server?.stop(true);rmSync(root,{recursive:true,force:true});}
