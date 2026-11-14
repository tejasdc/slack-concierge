import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createConnection} from 'node:net';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {Database} from 'bun:sqlite';
import WebSocket,{WebSocketServer} from 'ws-node';
import {
  acquireCodexThreadMutationFence,initializeCodexMutationFenceSchema,
  grantCodexMutationPermit,consumeCodexMutationPermit,recordCodexMutationResponse,
  reconcileCodexMutationIntent,listCodexThreadMutationIntents,stopCodexThreadMutationFence,
} from '../src/codex-mutation-fence';
import {initializeManagedCodexProcessRegistrySchema,registerManagedCodexChild,observeManagedCodexChildExit} from '../src/codex-managed-process-registry';
import {mutationDigest} from '../src/codex-mutation-channel.mjs';
import {managedCodexInvocation} from './codex-managed-launch';

if(process.argv.includes('--native-child')){
  const args=process.argv.slice(process.argv.indexOf('--native-child')+1);
  const startedMarker=process.env.CODEX_FIXTURE_STARTED_MARKER;
  if(startedMarker)writeFileSync(startedMarker,JSON.stringify({pid:process.pid,args}));
  if(process.env.CODEX_FIXTURE_WAIT_REGISTER==='1'){
    const registeredMarker=process.env.CODEX_FIXTURE_REGISTERED_MARKER;
    if(!registeredMarker)throw new Error('fixture registration marker is required');
    for(let i=0;i<1000&&!existsSync(registeredMarker);i++)await Bun.sleep(2);
    if(!existsSync(registeredMarker))throw new Error('fixture child was never registered');
  }
  if(args.includes('--help')||args.includes('--version'))process.exit(0);
  const marker=process.env.CODEX_FIXTURE_MARKER;
  if(args.includes('app-server')&&args.includes('proxy')){
    const sockAt=args.indexOf('--sock');const socket=args[sockAt+1];
    if(!socket)throw new Error('fixture native proxy did not receive --sock');
    const peer=new WebSocket('ws://localhost/',{createConnection:()=>createConnection(socket),perMessageDeflate:false});
    await new Promise<void>((resolve,reject)=>{peer.once('open',resolve);peer.once('error',reject);});
    const transcript:any[]=[];
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error(`proxy transcript timed out: ${JSON.stringify(transcript)}`)),3000);
      peer.on('message',data=>{
        const frame=JSON.parse(data.toString());transcript.push(frame);
        if(frame.id==='proxy-fragmented'&&frame.result){
          peer.send(JSON.stringify({id:'proxy-server-request',method:'test/server-request',params:{}}));
        }else if(frame.method==='server/ask'){
          peer.send(JSON.stringify({id:frame.id,result:{answer:'yes'}}));
        }else if(frame.id==='proxy-server-request-ack'){
          clearTimeout(timer);resolve();
        }
      });
      peer.send('{"id":"proxy-fragmented","method":"test/request","params":{"marker":', {fin:false});
      peer.send('"fragmented"}}', {fin:true});
    });
    peer.close();
    if(marker)writeFileSync(marker,JSON.stringify({args,pid:process.pid,socket,transcript}));
    process.exit(0);
  }
  if(marker)writeFileSync(marker,JSON.stringify({args,pid:process.pid}));
  if(process.env.CODEX_FIXTURE_HOLD==='1')await new Promise(()=>{});
  process.exit(0);
}

// This runs only against a fresh /tmp ledger, a Unix owner socket, and disposable
// native stand-ins. The bridge, launcher, classifier, channel, and SQLite fence
// implementation under test are the production modules.
const root=mkdtempSync(join(tmpdir(),'codex-managed-launch-fixture-'));
const state=join(root,'state');
mkdirSync(state);
const db=new Database(join(state,'state.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000');
initializeCodexMutationFenceSchema(db);
initializeManagedCodexProcessRegistrySchema(db);
const owner={acceptedInputId:'fixture-input',runId:'fixture-run',dispatchAttempt:1,bindingDigest:'fixture-binding'};
const nativeSeen:any[]=[];
const gateSeen:any[]=[];
let receiptObserved!:()=>void,releaseReceipt!:()=>void;
const receiptAtOwner=new Promise<void>(resolve=>{receiptObserved=resolve;});
const receiptMayComplete=new Promise<void>(resolve=>{releaseReceipt=resolve;});
const startedMarkers:string[]=[];
const launchInputs=new Map<string,string[]>();
const helperBytes=Buffer.from('sealed managed launcher fixture');
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const releaseRoot=join(root,'release');
const unsigned={format:2,files:{'control/codex-managed-launch.js':sha(helperBytes)}};
const artifactDigest=sha(JSON.stringify(unsigned));
const artifact=join(releaseRoot,'releases',artifactDigest);
mkdirSync(join(artifact,'control'),{recursive:true});
writeFileSync(join(artifact,'control','codex-managed-launch.js'),helperBytes);
writeFileSync(join(artifact,'manifest.json'),JSON.stringify({...unsigned,artifact_digest:artifactDigest}));
const helperPath=join(artifact,'control','codex-managed-launch.js');
function actualStartTicks(pid:number){
  try{const stat=readFileSync(`/proc/${pid}/stat`,'utf8'),close=stat.lastIndexOf(')');
    return close<0?null:stat.slice(close+1).trim().split(/\s+/)[19]??null;
  }catch{return null;}
}
const syntheticProc={
  listPids:()=>startedMarkers.flatMap(path=>{try{return [JSON.parse(readFileSync(path,'utf8')).pid];}catch{return [];}}),
  identity(pid:number){
    const started=startedMarkers.some(path=>{try{return JSON.parse(readFileSync(path,'utf8')).pid===pid;}catch{return false;}});
    if(!started&&startedMarkers.some(path=>{try{return JSON.parse(readFileSync(path,'utf8')).pid+100000===pid;}catch{return false;}}))
      return {pid,startTicks:String(pid),executablePath:'/usr/bin/bun'};
    const startTicks=actualStartTicks(pid);
    if(!started||!startTicks)return null;
    return {pid,startTicks,executablePath:nativeExecutable};
  },
  parentPid(pid:number){return pid+100000;},
  commandLine(pid:number){
    const childMarker=startedMarkers.find(path=>{try{return JSON.parse(readFileSync(path,'utf8')).pid===pid;}catch{return false;}});
    if(!childMarker){return ['/usr/bin/bun',helperPath,'--native',nativeExecutable,'--',...(launchInputs.get([...launchInputs.keys()].find(path=>{
      try{return JSON.parse(readFileSync(path,'utf8')).pid+100000===pid;}catch{return false;}
    })??'')??[])];
    }
    const payload=JSON.parse(readFileSync(childMarker,'utf8'));
    return [nativeExecutable,...payload.args];
  },
  ownsUnixListener(_pid:number,socketPath:string){return socketPath.startsWith('/tmp/concierge-codex-proxy-')&&socketPath.endsWith('/proxy.sock');},
  socketListeners:()=>[],
};
let sequence=0;
let barrierCount=0,releaseBarrier!:()=>void;
const barrierReleased=new Promise<void>(resolve=>releaseBarrier=resolve);
const gate=async(body:any)=>{
  gateSeen.push(body);
  if(body.phase==='register-process'){
    if(mutationDigest(body.params??{})!==body.paramsDigest)return {registered:false,reason:'fixture_process_digest_conflict'};
    for(let i=0;i<100&&!startedMarkers.some(path=>{try{return JSON.parse(readFileSync(path,'utf8')).pid===body.pid;}catch{return false;}});i++)await Bun.sleep(5);
    if(!syntheticProc.identity(body.pid))return {registered:false,reason:'fixture_child_identity_unavailable'};
    const registration=body.method==='managed/proxy-process'
      ?{connectionId:body.connectionId,permitId:body.permitId,kind:'rawproxy' as const,threadScope:'*',mediated:true,
          evidenceIds:[body.connectionId,body.permitId]}
      :{connectionId:body.connectionId,permitId:body.permitId,intentId:body.intentId,kind:'cli' as const,
          threadScope:body.threadId??'*',mediated:false,lifetimeIntentConsumed:true,
          evidenceIds:[body.connectionId,body.permitId,body.intentId]};
    const result=registerManagedCodexChild({db,registration,pid:body.pid,nowMs:Date.now(),proc:syntheticProc,releaseRoot});
    if(result.registered){
      const marker=startedMarkers.find(path=>{try{return JSON.parse(readFileSync(path,'utf8')).pid===body.pid;}catch{return false;}});
      if(marker)writeFileSync(`${marker}.registered`,'owner registration committed');
    }
    return result;
  }
  if(body.phase==='observed-exit'){
    if(body.responseDigest!==body.exitEvidenceDigest||mutationDigest({pid:body.pid,startTicks:body.startTicks,
      exitCode:body.exitCode,observedExit:true})!==body.exitEvidenceDigest)return {observed:false,reason:'fixture_exit_digest_conflict'};
    const current=syntheticProc.identity(body.pid);
    if(current?.startTicks===body.startTicks)return {observed:false,reason:'fixture_child_still_live'};
    const result=observeManagedCodexChildExit({db,connectionId:body.connectionId,permitId:body.permitId,pid:body.pid,
      startTicks:body.startTicks,exitCode:body.exitCode,exitEvidenceDigest:body.exitEvidenceDigest,nowMs:Date.now()});
    const registration=db.query(`SELECT process_kind,intent_id FROM codex_managed_process_registrations
      WHERE connection_id=? AND permit_id=?`).get(body.connectionId,body.permitId) as any;
    if(registration.process_kind==='cli')reconcileCodexMutationIntent(db,{intentId:registration.intent_id,outcome:'applied',
      evidenceDigest:body.exitEvidenceDigest,nowMs:Date.now()});
    return {observed:result.observed,duplicate:result.duplicate,state:result.state};
  }
  if(body.phase==='prepare'){
    if((body.method==='thread/compact'&&body.threadId==='thread-protected')
      ||(body.method==='thread/archive'&&body.threadId==='thread-unrelated')){
      barrierCount++;if(barrierCount===2)releaseBarrier();await barrierReleased;
    }
    const result=grantCodexMutationPermit(db,{permitId:body.permitId,threadId:body.threadId??'*',owner,
      method:body.method,paramsDigest:body.paramsDigest,purpose:'ordinary',nowMs:Date.now()});
    return {allowed:result.granted,reason:result.reason};
  }
  if(body.phase==='consume')return consumeCodexMutationPermit(db,{permitId:body.permitId,intentId:body.intentId,
    paramsDigest:body.paramsDigest,nowMs:Date.now()});
  if(body.phase==='response'){
    if(body.method==='thread/name/set'){receiptObserved();await receiptMayComplete;}
    return recordCodexMutationResponse(db,{intentId:body.intentId,
      kind:body.nativeError?'rpc_error':'accepted',responseDigest:body.responseDigest,providerTurnId:body.providerTurnId,nowMs:Date.now()});
  }
  return {allowed:false,forward:false,reason:'unknown_phase'};
};

const ownerSocket=join(state,'requests.sock');
const ownerServer=createServer((request,response)=>{
  let bytes='';request.setEncoding('utf8');request.on('data',chunk=>bytes+=chunk);
  request.on('end',async()=>{
    try{const result=await gate(JSON.parse(bytes));response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(result));}
    catch{response.writeHead(500);response.end('{}');}
  });
}).listen(ownerSocket);
await new Promise<void>(resolve=>ownerServer.once('listening',()=>resolve()));
chmodSync(ownerSocket,0o600);

const nativeSocket=join(root,'native.sock');
const nativeHttp=createServer();
const nativeWs=new WebSocketServer({noServer:true});
const bridgeChildren:any[]=[];
const ownedChildPids:number[]=[];
nativeHttp.on('upgrade',(request,socket,head)=>nativeWs.handleUpgrade(request,socket,head,peer=>nativeWs.emit('connection',peer,request)));
nativeWs.on('connection',(peer:WebSocket)=>peer.on('message',data=>{
  const frame=JSON.parse(data.toString());nativeSeen.push(frame);
  if(Object.hasOwn(frame,'id')&&frame.method==='initialize')peer.send(JSON.stringify({id:frame.id,result:{ready:true}}));
  else if(Object.hasOwn(frame,'id')&&frame.method==='thread/name/set')peer.send(JSON.stringify({id:frame.id,result:{}}));
  else if(Object.hasOwn(frame,'id')&&frame.method==='test/request')peer.send(JSON.stringify({id:frame.id,result:{echo:frame.params}}));
  else if(Object.hasOwn(frame,'id')&&frame.method==='test/server-request')peer.send(JSON.stringify({id:'server-question',method:'server/ask',params:{question:'native?'}}));
  else if(Object.hasOwn(frame,'id')&&frame.method==='test/server-response')peer.send(JSON.stringify({id:frame.id,result:{ok:true}}));
  else if(frame.id==='server-question'&&'result'in frame)peer.send(JSON.stringify({id:'proxy-server-request-ack',result:{seen:true}}));
}));
nativeHttp.listen(nativeSocket);
await new Promise<void>(resolve=>nativeHttp.once('listening',()=>resolve()));

const launcher=resolve(import.meta.dir,'codex-managed-launch.ts');
const bridge=resolve(import.meta.dir,'../src/codex-app-server-bridge.mjs');
let launchSequence=0;
const run=(args:string[],env:Record<string,string>={})=>{
  const startedMarker=join(root,`started-${++launchSequence}.json`);startedMarkers.push(startedMarker);
  launchInputs.set(startedMarker,args);
  return Bun.spawn([process.execPath,'run',launcher,'--native',nativeExecutable,'--',...args],{
    stdin:'pipe',stdout:'pipe',stderr:'pipe',env:{...process.env,CONCIERGE_STATE_DIR:state,CONCIERGE_STATE_DB:join(state,'state.db'),
      CODEX_FIXTURE_STARTED_MARKER:startedMarker,CODEX_FIXTURE_REGISTERED_MARKER:`${startedMarker}.registered`,...env}});
};
const nativeExecutable=join(root,'codex');
writeFileSync(nativeExecutable,`#!/bin/sh\nexec ${process.execPath} run ${JSON.stringify(import.meta.path)} --native-child "$@"\n`,{mode:0o700});

function protocol(kind:string,params:any={}) { return {id:`fixture-${++sequence}`,method:kind,params}; }
async function readLine(reader:ReadableStreamDefaultReader<Uint8Array>,pending:{text:string}) {
  while(!pending.text.includes('\n')){const {value,done}=await reader.read();if(done)throw new Error('bridge ended before its next protocol line');pending.text+=new TextDecoder().decode(value);}
  const end=pending.text.indexOf('\n'),line=pending.text.slice(0,end);pending.text=pending.text.slice(end+1);return JSON.parse(line);
}
async function bridgeClient(){
  const child=Bun.spawn([process.execPath,'run',bridge,nativeSocket,'/'],{stdin:'pipe',stdout:'pipe',stderr:'pipe',env:{...process.env,
    CONCIERGE_STATE_DIR:state,CONCIERGE_STATE_DB:join(state,'state.db')}});
  bridgeChildren.push(child);
  const reader=child.stdout.getReader(),pending={text:''};
  for(let i=0;i<3;i++){const line=await readLine(reader,pending);if(line.type==='ready')return {child,reader,pending};}
  throw new Error('bridge did not announce ready');
}

try {
  // Classification: global -c does not hide the command; --sock is preserved as
  // a value option; unresolved selectors and aliases never acquire thread authority.
  assert.deepEqual(managedCodexInvocation(['--help','-c','model="gpt-6.1-sol"']),{kind:'read'});
  assert.deepEqual(managedCodexInvocation(['-c','model="gpt-6.1-sol"','app-server','proxy','--sock','/tmp/backend.sock']),
    {kind:'proxy',proxyIndex:3});
  assert.equal(managedCodexInvocation(['--version']).kind,'read');
  assert.equal(managedCodexInvocation(['resume','latest']).threadId,null);
  assert.equal(managedCodexInvocation(['resume','picker']).threadId,null);
  assert.equal(managedCodexInvocation(['-c','model="gpt-6.1-sol"','resume','00000000-0000-0000-0000-000000000001']).threadId,null);
  assert.equal(managedCodexInvocation(['fork','00000000-0000-0000-0000-000000000001']).threadId,null);
  assert.equal(managedCodexInvocation(['exec','fork','00000000-0000-0000-0000-000000000001']).threadId,null);
  assert.equal(managedCodexInvocation(['archive','00000000-0000-0000-0000-000000000001']).threadId,null);
  assert.equal(managedCodexInvocation(['exec','resume','00000000-0000-0000-0000-000000000001']).threadId,
    '00000000-0000-0000-0000-000000000001');

  const startFence=acquireCodexThreadMutationFence(db,{threadId:'thread-protected',fenceId:'fence-fixture',...owner,nowMs:1});
  assert.equal(startFence.acquired,true);
  const interactiveMarker=join(root,'interactive-child.json');
  const interactive=run(['resume','00000000-0000-0000-0000-000000000099'],{CODEX_FIXTURE_MARKER:interactiveMarker});
  assert.notEqual(await interactive.exited,0,'interactive resume conflicts even when its initial UUID is unrelated');
  assert.equal(existsSync(interactiveMarker),false,'thread-switching TUI is refused before native child creation');
  const first=await bridgeClient(),second=await bridgeClient();
  const ask=(client:any,frame:any)=>client.child.stdin.write(JSON.stringify({type:'request',id:frame.id,method:frame.method,params:frame.params})+'\n');
  const read=(client:any,method:string,params:any)=>ask(client,protocol(method,params));
  const firstBlocked=protocol('thread/start',{threadId:'thread-protected'});
  const settingsBlocked=protocol('config/value/write',{threadId:'thread-protected',key:'model',value:'other'});
  const historyBlocked=protocol('thread/compact',{threadId:'thread-protected'});
  const notification={method:'future/unknownNotification',params:{threadId:'thread-protected',payload:'opaque'}};
  ask(first,firstBlocked);ask(first,settingsBlocked);ask(first,historyBlocked);
  first.child.stdin.write(JSON.stringify({type:'notification',...notification})+'\n');
  const allowedRead=protocol('thread/read',{threadId:'thread-protected'});
  const unrelatedWrite=protocol('thread/archive',{threadId:'thread-unrelated'});
  ask(second,allowedRead);ask(second,unrelatedWrite);
  await Bun.sleep(750);
  assert.ok(!nativeSeen.some(frame=>[firstBlocked.method,settingsBlocked.method,historyBlocked.method,notification.method].includes(frame.method)),
    'the native stand-in must never observe protected starts, settings/history writes, or unknown notifications');
  assert.ok(nativeSeen.some(frame=>frame.method==='thread/read'&&frame.params.threadId==='thread-protected'),JSON.stringify(nativeSeen));
  assert.ok(nativeSeen.some(frame=>frame.method==='thread/archive'&&frame.params.threadId==='thread-unrelated'),JSON.stringify({nativeSeen,gateSeen}));
  assert.equal(barrierCount,2,'two independent bridge clients reached the owner gate before either decision proceeded');
  const receiptClient=await bridgeClient(),receiptRequest=protocol('thread/name/set',{threadId:'receipt-thread',name:'fixture-only'});
  ask(receiptClient,receiptRequest);
  await receiptAtOwner;
  let delivered=false;
  const retainedReply=readLine(receiptClient.reader,receiptClient.pending).then(reply=>{delivered=true;return reply;});
  await Bun.sleep(25);
  assert.equal(delivered,false,'native success cannot reach its client before the owned receipt audit completes');
  releaseReceipt();
  assert.equal((await retainedReply).id,receiptRequest.id);
  receiptClient.child.stdin.write(JSON.stringify({type:'close'})+'\n');receiptClient.child.kill();
  for(const method of ['thread/start','config/value/write','thread/compact','future/unknownNotification'])
    assert.ok(gateSeen.some(entry=>entry.phase==='prepare'&&entry.method===method&&
      (entry.threadId==='thread-protected'||entry.params?.threadId==='thread-protected')),
      `protected ${method} reached the durable gate and was refused before the native stand-in`);
  for(const client of [first,second]){client.child.stdin.write(JSON.stringify({type:'close'})+'\n');client.child.kill();}
  const blockedIntents=listCodexThreadMutationIntents(db,'thread-protected');
  assert.equal(blockedIntents.length,0,'refused writes do not create forwarding intents');
  assert.equal(listCodexThreadMutationIntents(db,'thread-unrelated').length,1);
  assert.equal(stopCodexThreadMutationFence(db,{fenceId:'fence-fixture',stopActionId:'fixture-stop',nowMs:2}).stopped,true);

  // Read-only native CLI requests bypass the owner entirely.
  for(const option of ['--help','--version']){
    const before=Number((db.query('SELECT count(*) AS n FROM codex_mutation_intents').get() as any).n);
    const gateCalls=gateSeen.length;
    const child=run([option]);
    assert.equal(await child.exited,0,`${option} should execute natively`);
    assert.equal(Number((db.query('SELECT count(*) AS n FROM codex_mutation_intents').get() as any).n),before,
      `${option} creates no mutation intent`);
    assert.equal(gateSeen.length,gateCalls,`${option} never calls mutation authority`);
  }

  // A usable proxy is the full local WS server over a disposable Unix socket. The
  // simulated native client speaks masked, fragmented WS frames; it also answers
  // a request initiated by the native server, so both directions cross the proxy.
  const proxyMarker=join(root,'proxy-result.json');
  const proxy=run(['-c','model="gpt-6.1-sol"','app-server','proxy','--sock',nativeSocket],{CODEX_FIXTURE_MARKER:proxyMarker});
  assert.equal(await proxy.exited,0,`proxy stand-in failed: ${await proxy.stderr.text()}`);
  const proxyResult=JSON.parse(await Bun.file(proxyMarker).text());
  assert.deepEqual(proxyResult.args.slice(0,4),['-c','model="gpt-6.1-sol"','app-server','proxy'],
    'global config argv remains in original order');
  assert.ok(proxyResult.args.includes('--sock')&&proxyResult.args.includes(proxyResult.socket),
    'launcher supplies its listening socket to native proxy after preserving command argv');
  assert.equal(proxyResult.args.filter((arg:string)=>arg==='--sock').length,1);
  assert.ok(!proxyResult.args.includes(nativeSocket),'original backend socket is consumed by the launcher');
  assert.ok(nativeSeen.some(frame=>frame.method==='test/request'&&frame.params.marker==='fragmented'),
    'fragmented masked request is decoded and reaches native server intact');
  assert.ok(nativeSeen.some(frame=>frame.id==='server-question'&&frame.result?.answer==='yes'),
    'native server request and client response cross the proxy');
  const proxyRegistration=db.query(`SELECT * FROM codex_managed_process_registrations WHERE process_kind='rawproxy'`).get() as any;
  assert.equal(proxyRegistration.state,'observed_exit','the owned native proxy exit is retained');
  assert.equal(proxyRegistration.mediated,1);assert.equal(proxyRegistration.thread_scope,'*');
  const proxyRegisterIndex=gateSeen.findIndex(entry=>entry.phase==='register-process'&&entry.method==='managed/proxy-process');
  const proxyFirstMutationIndex=gateSeen.findIndex(entry=>entry.method==='test/request'&&entry.phase==='prepare');
  assert(proxyRegisterIndex>=0&&proxyFirstMutationIndex>proxyRegisterIndex,
    'the owner registration barrier precedes the first native proxy mutation');

  // Direct CLI lifetime intent precedes child execution. Observed exit reconciles;
  // killing the launcher while its child remains alive leaves durable uncertainty.
  const completedMarker=join(root,'completed-child.json');
  const completed=run(['exec','resume','00000000-0000-0000-0000-000000000099'],{CODEX_FIXTURE_MARKER:completedMarker,CODEX_FIXTURE_WAIT_REGISTER:'1'});
  assert.equal(await completed.exited,0,await completed.stderr.text());
  const completedData=JSON.parse(await Bun.file(completedMarker).text());
  ownedChildPids.push(completedData.pid);
  const completedRegistration=db.query(`SELECT * FROM codex_managed_process_registrations WHERE process_kind='cli' AND thread_scope=?`)
    .get('00000000-0000-0000-0000-000000000099') as any;
  assert.equal(completedRegistration.state,'observed_exit');
  assert.equal(completedRegistration.intent_id,completedRegistration.permit_id);
  const completedConsumeIndex=gateSeen.findIndex(entry=>entry.phase==='consume'&&entry.method==='managed/cli-lifetime'
    &&entry.threadId==='00000000-0000-0000-0000-000000000099');
  const completedRegisterIndex=gateSeen.findIndex(entry=>entry.phase==='register-process'&&entry.method==='managed/cli-lifetime'
    &&entry.threadId==='00000000-0000-0000-0000-000000000099');
  assert(completedConsumeIndex>=0&&completedRegisterIndex>completedConsumeIndex,
    'the exact CLI lifetime intent is consumed before spawning/registering its child');
  const completedRows=listCodexThreadMutationIntents(db,'00000000-0000-0000-0000-000000000099');
  assert.equal(completedRows.length,1);
  assert.equal(completedRows[0].state,'reconciled_applied','only observed owned-child exit resolves lifetime');
  const heldMarker=join(root,'held-child.json');
  const held=run(['exec','resume','00000000-0000-0000-0000-000000000098'],{CODEX_FIXTURE_MARKER:heldMarker,CODEX_FIXTURE_HOLD:'1',CODEX_FIXTURE_WAIT_REGISTER:'1'});
  for(let i=0;i<200&&!existsSync(heldMarker);i++)await Bun.sleep(10);
  assert.ok(existsSync(heldMarker),'owned native child started');
  const heldData=JSON.parse(await Bun.file(heldMarker).text());
  ownedChildPids.push(heldData.pid);
  const heldRows=listCodexThreadMutationIntents(db,'00000000-0000-0000-0000-000000000098');
  assert.equal(heldRows.length,1);assert.equal(heldRows[0].state,'forwarding','intent is durable before native child starts');
  held.kill(9);await held.exited;
  process.kill(heldData.pid,'SIGTERM');
  assert.equal(listCodexThreadMutationIntents(db,'00000000-0000-0000-0000-000000000098')[0].state,'forwarding',
    'launcher crash does not release or resolve its intent');
  const heldRegistration=db.query(`SELECT * FROM codex_managed_process_registrations WHERE process_kind='cli' AND thread_scope=?`)
    .get('00000000-0000-0000-0000-000000000098') as any;
  assert.equal(heldRegistration.state,'active','launcher disappearance does not pretend to observe process exit');
  console.log('codex-managed-launch-fixture: pre-forward proxy registration, owned CLI process identity/exit, durable lifetime uncertainty, real bridge fence boundary, and no-owner help/version: PASS');
} finally {
  for(const child of bridgeChildren)try{child.kill();}catch{}
  for(const pid of ownedChildPids)try{process.kill(pid,'SIGTERM');}catch{}
  nativeWs.close();nativeHttp.close();ownerServer.close();db.close();rmSync(root,{recursive:true,force:true});
}

