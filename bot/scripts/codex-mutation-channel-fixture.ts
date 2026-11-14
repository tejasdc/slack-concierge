import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import {CodexMutationChannel,codexMutationDescriptor} from '../src/codex-mutation-channel.mjs';
import {
  acquireCodexThreadMutationFence,consumeCodexMutationPermit,getCodexThreadMutationFence,
  grantCodexMutationPermit,initializeCodexMutationFenceSchema,listCodexThreadMutationIntents,
  reconcileCodexMutationIntent,recordCodexMutationResponse,stopCodexThreadMutationFence,
} from '../src/codex-mutation-fence';

const root=await mkdtemp(join(tmpdir(),'codex-mutation-channel-'));
const path=join(root,'ledger.sqlite');
const dbA=new Database(path);dbA.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000');initializeCodexMutationFenceSchema(dbA);
const dbB=new Database(path);dbB.exec('PRAGMA busy_timeout=10000');
const owner={acceptedInputId:'accepted-main',runId:'run-main',dispatchAttempt:1,bindingDigest:'bound-model-effort-runner'};
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
const sentA:any[]=[],sentB:any[]=[],refused:any[]=[];
let waitConsume:ReturnType<typeof deferred>|null=null,consumeReached:ReturnType<typeof deferred>|null=null;
let waitResponse:ReturnType<typeof deferred>|null=null,responseReached:ReturnType<typeof deferred>|null=null;
const gates=(db:Database,who=owner,policy:{purpose:'ordinary'|'fenced_recovery';fenceId?:string}={purpose:'ordinary'})=>async(body:any)=>{
  const {phase,permitId,intentId,threadId,method,paramsDigest,responseDigest,nativeError,providerTurnId}=body;
  if(phase==='prepare'){
    const result=grantCodexMutationPermit(db,{permitId,threadId:threadId??'*',owner:who,method,paramsDigest,
      purpose:policy.purpose,fenceId:policy.fenceId,nowMs:1});
    return {allowed:result.granted,reason:result.reason};
  }
  if(phase==='consume'){
    if(consumeReached&&waitConsume){consumeReached.resolve();await waitConsume.promise;}
    return consumeCodexMutationPermit(db,{permitId,intentId,paramsDigest,nowMs:2});
  }
  if(phase==='response'){
    if(responseReached&&waitResponse){responseReached.resolve();await waitResponse.promise;}
    return recordCodexMutationResponse(db,{intentId,kind:nativeError?'rpc_error':'accepted',responseDigest,providerTurnId,nowMs:3});
  }
  throw new Error(`unexpected gate phase ${phase}`);
};
const channel=(db:Database,storage:Database,sent:any[],connectionId:string,who=owner,policy:{purpose:'ordinary'|'fenced_recovery';fenceId?:string}={purpose:'ordinary'})=>{
  let mutationSequence=0;
  return new CodexMutationChannel({connectionId,gate:gates(db,who,policy),send:(frame:any)=>{
    if(frame.method!=='thread/read'){
      const sequence=++mutationSequence;
      const item=listCodexThreadMutationIntents(storage,codexMutationDescriptor(frame)?.threadId??'*').find(row=>row.intent_id===`${connectionId}:${sequence}`);
      assert.ok(item,`intent for ${frame.method} is durable before native send`);
      assert.equal(item.state,'forwarding');
    }
    sent.push(frame);
  },reject:(frame:any,reason:string,ambiguous:boolean)=>{if(frame?.method!=='thread/read')mutationSequence++;refused.push({frame,reason,ambiguous});}});
};

try {
  // Two independent channel/database pairs meet at a test barrier before forwarding writes.
  const firstReady=deferred(),secondReady=deferred(),release=deferred();
  let arrivals=0;
  const barrierGate=(db:Database,ready:ReturnType<typeof deferred>)=>async(body:any)=>{
    if(body.phase==='prepare'){
      arrivals++;ready.resolve();
      if(arrivals<=2)await release.promise;
    }
    return gates(db)(body);
  };
  const c1=channel(dbA,dbA,sentA,'chan-a');
  const c2=channel(dbB,dbA,sentB,'chan-b');
  (c1 as any).gate=barrierGate(dbA,firstReady);
  (c2 as any).gate=barrierGate(dbB,secondReady);
  const initial=[
    c1.forward({id:1,method:'thread/start',params:{threadId:'thread-a',model:'gpt-6-sol',effort:'medium'}}),
    c2.forward({id:2,method:'config/value/write',params:{key:'model',value:'gpt-6-sol'}}),
  ];
  await Promise.all([firstReady.promise,secondReady.promise]);release.resolve();await Promise.all(initial);
  await Promise.all([
    c1.forward({id:3,method:'thread/archive',params:{threadId:'thread-a'}}),
    c1.forward({id:4,method:'thread/compact',params:{threadId:'thread-a'}}),
    c2.forward({method:'future/unknownNotification',params:{threadId:'thread-a',value:'opaque'}}),
  ]);
  assert.equal(sentA.length,3);assert.equal(sentB.length,2);
  assert.equal(listCodexThreadMutationIntents(dbA,'thread-a').length,2);
  assert.equal(listCodexThreadMutationIntents(dbA,'*').length,3,'creation, settings and unknown methods have wildcard identity despite caller threadId');
  await c1.response({id:1,result:{ok:true,turn:{id:'native-turn-start'}}});
  await c2.response({id:2,error:{code:-1,message:'native returned error after possible partial effects'}});
  assert.equal(listCodexThreadMutationIntents(dbA,'*')[0].state,'response_received');
  assert.equal(listCodexThreadMutationIntents(dbA,'*')[0].provider_turn_id,'native-turn-start',
    'native response-to-turn identity is retained for exact later reconciliation');
  assert.equal(listCodexThreadMutationIntents(dbA,'*')[0].state,'response_received');
  assert.equal(acquireCodexThreadMutationFence(dbA,{threadId:'thread-a',fenceId:'blocked-by-writes',...owner,nowMs:4}).acquired,false,
    'accepted response and native RPC error remain outstanding');

  // The delayed response observer leaves the first intent unresolved; it cannot authorize a second fenced send.
  for(const intent of [...listCodexThreadMutationIntents(dbA,'thread-a'),...listCodexThreadMutationIntents(dbA,'*')])
    reconcileCodexMutationIntent(dbA,{intentId:intent.intent_id,outcome:'applied',evidenceDigest:`proof:${intent.intent_id}`,nowMs:5});
  const fenceOwner={acceptedInputId:'recovery-input',runId:'recovery-run',dispatchAttempt:2,bindingDigest:'recovery-binding'};
  assert.equal(acquireCodexThreadMutationFence(dbA,{threadId:'thread-a',fenceId:'fence-delay',...fenceOwner,nowMs:6}).acquired,true);
  const fence=getCodexThreadMutationFence(dbB,'thread-a')!;
  responseReached=deferred();waitResponse=deferred();
  const recovery=new CodexMutationChannel({connectionId:'recovery',gate:gates(dbA,fenceOwner,{purpose:'fenced_recovery',fenceId:fence.fenceId}),
    send:(frame:any)=>{assert.ok(listCodexThreadMutationIntents(dbA,'thread-a').some(row=>row.intent_id==='recovery:1'&&row.state==='forwarding'));
      sentA.push(frame);},reject:(frame:any,reason:string,ambiguous:boolean)=>refused.push({frame,reason,ambiguous})});
  await recovery.forward({id:11,method:'thread/resume',params:{threadId:'thread-a',input:[]}});
  assert.equal(sentA.length,4);
  const delayedResponse=recovery.response({id:11,result:{prepared:true}});
  await responseReached.promise;
  await recovery.forward({id:12,method:'turn/start',params:{threadId:'thread-a',model:'gpt-6-sol',effort:'medium'}});
  assert.equal(sentA.length,4,'response-observer delay does not authorize another fenced mutation');
  assert.ok(refused.some(item=>item.frame.id===12));
  waitResponse.resolve();await delayedResponse;
  assert.equal(acquireCodexThreadMutationFence(dbB,{threadId:'thread-a',fenceId:'still-blocked',...owner,nowMs:7}).acquired,false);
  const unresolved=listCodexThreadMutationIntents(dbA,'thread-a').find(row=>row.intent_id==='recovery:1')!;
  reconcileCodexMutationIntent(dbA,{intentId:unresolved.intent_id,outcome:'applied',evidenceDigest:'prepared-terminal-evidence',nowMs:8});

  // Unrelated reads and writes remain usable while thread-a is fenced.
  const other=channel(dbB,dbA,sentB,'other-thread');
  await other.forward({id:21,method:'thread/read',params:{threadId:'thread-b'}});
  await other.forward({id:22,method:'thread/archive',params:{threadId:'thread-b'}});
  assert.ok(sentB.some(frame=>frame.id===21));
  assert.ok(sentB.some(frame=>frame.id===22));

  // A permit granted before Stop but held before consume is invalidated by Stop.
  consumeReached=deferred();waitConsume=deferred();
  const stalePromise=recovery.forward({id:13,method:'turn/start',params:{threadId:'thread-a',model:'gpt-6-sol',effort:'medium'}});
  await consumeReached.promise;
  assert.equal(stopCodexThreadMutationFence(dbB,{fenceId:fence.fenceId,stopActionId:'stop-recovery',nowMs:9}).stopped,true);
  waitConsume.resolve();await stalePromise;
  assert.equal(sentA.length,4,'a cached grant cannot cross Stop');
  assert.ok(refused.some(item=>item.frame.id===13));

  // Stop keeps ordinary writers blocked while an issued effect is unresolved, then exact terminal evidence releases it.
  assert.equal(acquireCodexThreadMutationFence(dbA,{threadId:'thread-a',fenceId:'fence-stop-uncertain',...fenceOwner,nowMs:10}).acquired,true);
  const afterStopFence=getCodexThreadMutationFence(dbB,'thread-a')!;
  const uncertain=new CodexMutationChannel({connectionId:'uncertain',gate:gates(dbA,fenceOwner,{purpose:'fenced_recovery',fenceId:afterStopFence.fenceId}),
    send:(frame:any)=>{assert.ok(listCodexThreadMutationIntents(dbA,'thread-a').some(row=>row.intent_id==='uncertain:1'&&row.state==='forwarding'));
      sentA.push(frame);},reject:(frame:any,reason:string,ambiguous:boolean)=>refused.push({frame,reason,ambiguous})});
  await uncertain.forward({id:31,method:'thread/resume',params:{threadId:'thread-a',input:[]}});
  assert.equal(sentA.length,5);
  stopCodexThreadMutationFence(dbB,{fenceId:afterStopFence.fenceId,stopActionId:'stop-with-outstanding-intent',nowMs:11});
  await other.forward({id:32,method:'thread/read',params:{threadId:'thread-a'}});
  await other.forward({id:33,method:'thread/archive',params:{threadId:'thread-a'}});
  assert.equal(sentB.filter(frame=>frame.id===32).length,1,'thread reads remain available while a stopped fence has uncertainty');
  assert.equal(sentB.filter(frame=>frame.id===33).length,0,'ordinary writes remain refused after Stop while the issued effect is unresolved');
  assert.ok(refused.some(item=>item.frame.id===33));
  reconcileCodexMutationIntent(dbA,{intentId:'uncertain:1',outcome:'applied',evidenceDigest:'stop-terminal-proof',nowMs:12});
  await other.forward({id:34,method:'thread/archive',params:{threadId:'thread-a'}});
  assert.equal(sentB.filter(frame=>frame.id===34).length,1,'ordinary writes resume only after exact terminal reconciliation');

  // Connection loss after an issued notification keeps its intent unresolved across a fresh DB client.
  const notification=new CodexMutationChannel({connectionId:'orphan',gate:gates(dbA),send:(f:any)=>sentA.push(f),reject:(f:any,r:string,a:boolean)=>refused.push({f,r,a})});
  await notification.forward({method:'future/unknownNotification',params:{threadId:'thread-a'}});
  recordCodexMutationResponse(dbB,{intentId:'orphan:1',kind:'transport_ambiguous',responseDigest:'connection-loss-evidence',nowMs:13});
  notification.close();
  const restart=new Database(path);restart.exec('PRAGMA busy_timeout=10000');
  assert.ok(listCodexThreadMutationIntents(restart,'*').some(row=>row.state==='ambiguous'),
    'an ambiguous issued notification remains durable/outstanding across restart');
  restart.close();c1.close();c2.close();recovery.close();other.close();uncertain.close();
  console.log('codex-mutation-channel-fixture: PASS');
} finally {try{dbA.close();}catch{}try{dbB.close();}catch{}await rm(root,{recursive:true,force:true});}
