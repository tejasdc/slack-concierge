import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {CodexAppServerClient,freezeManagedCodexTarget,installCodexCustodyForwardGuard} from '../src/codex-app-server-client';

const scratch=mkdtempSync(join(tmpdir(),'custody-native-cutoff-'));
const eventFile=join(scratch,'events.jsonl');writeFileSync(eventFile,'');
const jsonLinesModule=pathToFileURL(resolve(import.meta.dir,'../src/json-lines.ts')).href;
const bridgeFor=(label:string,releaseFile=join(scratch,`release-${label}`))=>{
 const bridge=join(scratch,`bridge-${label}.mjs`);
 writeFileSync(bridge,`import {onJsonLines} from ${JSON.stringify(jsonLinesModule)};
import {appendFileSync,existsSync} from 'node:fs';
const chains=new Map();
const handlerEffects=new Map();
process.stdout.write(JSON.stringify({type:'ready'})+'\\n');
onJsonLines(process.stdin,line=>{
 const call=JSON.parse(line);if(call.type==='close')process.exit(0);
 if(call.type!=='request')return;
 const threadId=call.params?.threadId??'';
 if(call.method==='thread/read'&&threadId==='timeout-thread')return;
 const key=call.method==='thread/resume'&&call.params.path?'path:'+call.params.path:call.method==='thread/start'?'unkeyed:thread/start':threadId?'thread:'+threadId:'unkeyed:'+call.method;
 if(call.method==='thread/read')appendFileSync(${JSON.stringify(eventFile)},JSON.stringify({event:'read-arrived',threadId,sender:${JSON.stringify(label)}})+'\\n');
 const previous=chains.get(key)||Promise.resolve();
 const task=previous.then(async()=>{
   if(call.method==='thread/read'&&threadId==='rejected-thread'){
     process.stdout.write(JSON.stringify({type:'response',id:call.id,error:{code:-32602,message:'fixture rejected'}})+'\\n');return;
   }
   if(call.method==='thread/read'){
     const effectCount=handlerEffects.get(threadId)||0;
     appendFileSync(${JSON.stringify(eventFile)},JSON.stringify({event:'barrier-read',threadId,effectCount,sender:${JSON.stringify(label)}})+'\\n');
     const returnedId=threadId==='wrong-identity-thread'?'wrong-thread':threadId;
     const turn=call.method==='thread/read'?{type:'response',id:call.id,result:{thread:{id:returnedId,effectCount}}}:null;
     process.stdout.write(JSON.stringify(turn)+'\\n');return;
   }
   const response={type:'response',id:call.id,result:call.method==='thread/resume'?{thread:{id:threadId}}:call.method==='thread/start'?{thread:{id:'started-thread'}}:{turn:{id:'turn-1'}}};
   // Record before replying: the client can observe the reply before a later append lands.
   appendFileSync(${JSON.stringify(eventFile)},JSON.stringify({event:'rpc-response',method:call.method,threadId,sender:${JSON.stringify(label)}})+'\\n');
   process.stdout.write(JSON.stringify(response)+'\\n');
   if(call.method==='turn/start'&&threadId==='predecessor-thread'&&${JSON.stringify(label)}!=='other'){
     while(!existsSync(${JSON.stringify(releaseFile)}))await new Promise(resolve=>setTimeout(resolve,5));
   } else await new Promise(resolve=>setTimeout(resolve,call.method==='turn/start'||call.method==='thread/resume'||call.method==='thread/start'?40:0));
   if(call.method==='turn/start'||call.method==='thread/start'||call.method==='thread/resume'){
     handlerEffects.set(threadId,(handlerEffects.get(threadId)||0)+1);
     appendFileSync(${JSON.stringify(eventFile)},JSON.stringify({event:'handler-complete',method:call.method,threadId,sender:${JSON.stringify(label)}})+'\\n');
   }
 });
 chains.set(key,task);
});`);
 return bridge;
};
const bridgeA=bridgeFor('a'),bridgeB=bridgeFor('b'),bridgeOther=bridgeFor('other');
const make=(bridge=bridgeOther)=>new CodexAppServerClient('/disposable',process.execPath,{bridgePath:bridge,manageDaemon:false,shutdownGraceMs:50});
const a=make(bridgeA),b=make(bridgeB);
let alias:CodexAppServerClient|null=null,completedAlias:CodexAppServerClient|null=null,loss:CodexAppServerClient|null=null,timeout:CodexAppServerClient|null=null,unkeyed:CodexAppServerClient|null=null,keyed:CodexAppServerClient|null=null,wrong:CodexAppServerClient|null=null,rejected:CodexAppServerClient|null=null;
try{
 const seen:any[]=[];installCodexCustodyForwardGuard(scope=>seen.push(scope));
 await Promise.all([a.connect(),b.connect()]);
 const threadId='predecessor-thread';
 const started=Promise.all([a.request('turn/start',{threadId},{custodyOwnerSessionId:8245}),b.request('turn/start',{threadId},{custodyOwnerSessionId:8245})]);
 await started;
 const eventsBeforeRead=()=>readFileSync(eventFile,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
 assert.equal(eventsBeforeRead().filter(event=>event.event==='rpc-response'&&event.method==='turn/start'&&event.threadId===threadId).length,2);
 assert.equal(eventsBeforeRead().filter(event=>event.event==='handler-complete'&&event.threadId===threadId).length,0,
   'the native test handlers remain active after their successful turn/start responses');
 const cutoff=freezeManagedCodexTarget({ownerSessionId:8245,threadId,endpoint:a.nativeEndpoint,timeoutMs:1000});
 const reconciling=cutoff.reconcile();
 for(let i=0;i<100&&eventsBeforeRead().filter(event=>event.event==='read-arrived'&&event.threadId===threadId&&event.sender==='a').length<1;i++)
   await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(eventsBeforeRead().filter(event=>event.event==='read-arrived'&&event.threadId===threadId&&event.sender==='a').length,1,
   'the first retained connection receives its final read while its earlier handler is still active');
 assert.equal(eventsBeforeRead().filter(event=>event.event==='handler-complete'&&event.threadId===threadId&&event.sender==='a').length,0);
 writeFileSync(join(scratch,'release-a'),'release');
 for(let i=0;i<100&&eventsBeforeRead().filter(event=>event.event==='read-arrived'&&event.threadId===threadId&&event.sender==='b').length<1;i++)
   await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(eventsBeforeRead().filter(event=>event.event==='read-arrived'&&event.threadId===threadId&&event.sender==='b').length,1);
 assert.equal(eventsBeforeRead().filter(event=>event.event==='handler-complete'&&event.threadId===threadId&&event.sender==='b').length,0);
 writeFileSync(join(scratch,'release-b'),'release');
 const receipt=await reconciling;
 const allEvents=eventsBeforeRead();
 const effectsAtRead=allEvents.filter(event=>event.event==='barrier-read'&&event.threadId===threadId);
 assert.equal(effectsAtRead.length,2);assert.ok(effectsAtRead.every(event=>event.effectCount===1),
   'the server reports post-response handler completion before each same-key barrier response');
 for(const sender of ['a','b']){
   const responseIndex=allEvents.findIndex(event=>event.event==='rpc-response'&&event.method==='turn/start'&&event.threadId===threadId&&event.sender===sender);
   const completionIndex=allEvents.findIndex(event=>event.event==='handler-complete'&&event.method==='turn/start'&&event.threadId===threadId&&event.sender===sender);
   const readIndex=allEvents.findIndex(event=>event.event==='barrier-read'&&event.threadId===threadId&&event.sender===sender);
   assert.ok(responseIndex<completionIndex&&completionIndex<readIndex,`same-key barrier follows full handler after RPC response (${sender})`);
 }
 assert.equal(receipt.externalCoverage,'not-asserted','managed registry does not claim external sender coverage');
 assert.equal(receipt.captured.length,2,'both active managed sender instances are captured');
 assert.equal(receipt.barriers.length,2,'both generations return a matching correlated read');
 assert.throws(()=>freezeManagedCodexTarget({ownerSessionId:8245,threadId,
   endpoint:{socketPath:'/another-native-endpoint',relayRunner:null}}),/another native endpoint/);
 assert.doesNotThrow(()=>cutoff.assertCurrentHold(),'a refused endpoint replacement cannot weaken the retained cutoff');
 assert.ok(!receipt.unresolved.some(value=>value.includes('unfinished known-thread')),'same-generation thread/read covers the delayed keyed handler');
 assert.ok(receipt.barriers.every(row=>row.threadId===threadId));
 assert.equal(seen.some(scope=>scope.method==='thread/read'),false,'read-only barriers bypass mutating-forward policy');
 await assert.rejects(()=>a.request('turn/steer',{threadId,turnId:'turn-1'},{custodyOwnerSessionId:8245}),/frozen for custody reconciliation/);
 const readsBefore=a.custodyForwardedScopes.length;
 for(const method of ['thread/list','thread/queue/list','thread/goal/get','thread/backgroundTerminals/list'])
   await a.request(method,{threadId});
 assert.equal(a.custodyForwardedScopes.length,readsBefore,'known native observation methods pass through without becoming mutation scopes');
 await assert.rejects(()=>a.request('future/unknownMutation',{threadId}),/frozen for custody reconciliation/,
   'unknown methods are treated as mutations and cannot bypass the target hold');
 assert.equal((await b.request('turn/start',{threadId:'unrelated-9214'})).turn.id,'turn-1','unrelated shared-client work remains available');

 alias=make();await alias.connect();
 const pathResume=alias.request('thread/resume',{path:'/unknown/rollout'},{custodyOwnerSessionId:9003});
 await new Promise(resolve=>setTimeout(resolve,10));
 const aliasCutoff=freezeManagedCodexTarget({ownerSessionId:9003,threadId,endpoint:{socketPath:'/disposable',relayRunner:null},timeoutMs:1000});
 const aliasReceipt=await aliasCutoff.reconcile();
 await pathResume;
 assert.ok(aliasReceipt.unresolved.some(value=>value.includes('thread-path')),'path-keyed writes cannot be certified by predecessor thread/read');
 completedAlias=make();await completedAlias.connect();
 await completedAlias.request('thread/resume',{path:'/completed/rollout'},{custodyOwnerSessionId:9004});
 const completedAliasReceipt=await freezeManagedCodexTarget({ownerSessionId:9004,threadId,endpoint:{socketPath:'/disposable',relayRunner:null}}).reconcile();
 assert.ok(completedAliasReceipt.unresolved.some(value=>value.includes('RPC completed=true')),'a terminal RPC response is not a full path-handler disposition');
 unkeyed=make();await unkeyed.connect();
 const start=unkeyed.request('thread/start',{cwd:'/unkeyed'},{custodyOwnerSessionId:9006});
 await new Promise(resolve=>setTimeout(resolve,10));
 const unkeyedReceipt=await freezeManagedCodexTarget({ownerSessionId:9006,threadId:'not-yet-known',endpoint:{socketPath:'/disposable',relayRunner:null}}).reconcile();
 await start;
 assert.ok(unkeyedReceipt.unresolved.some(value=>value.includes('unkeyed-thread')),'unkeyed start is never covered by a known-thread read');
 loss=make();await loss.connect();
 await loss.request('turn/start',{threadId:'lost-thread'},{custodyOwnerSessionId:9001});
 const lostGeneration=loss.activeGeneration!;
 const lostCutoff=freezeManagedCodexTarget({ownerSessionId:9001,threadId:'lost-thread',endpoint:{socketPath:'/disposable',relayRunner:null}});
 await loss.loseConnectionGeneration(lostGeneration);
 assert.ok((await lostCutoff.reconcile()).unresolved.some(value=>value.includes('lost captured generation')),'lost captured generation cannot be replaced by a new read connection');
 timeout=make();await timeout.connect();
 await timeout.request('turn/start',{threadId:'timeout-thread'},{custodyOwnerSessionId:9002});
 const timedCutoff=freezeManagedCodexTarget({ownerSessionId:9002,threadId:'timeout-thread',endpoint:{socketPath:'/disposable',relayRunner:null},timeoutMs:10});
 assert.ok((await timedCutoff.reconcile()).unresolved.some(value=>value.includes('barrier failed')),'timed out same-generation read remains unresolved');
 wrong=make();await wrong.connect();
 await wrong.request('turn/start',{threadId:'wrong-identity-thread'},{custodyOwnerSessionId:9013});
 const wrongReceipt=await freezeManagedCodexTarget({ownerSessionId:9013,threadId:'wrong-identity-thread',endpoint:{socketPath:'/disposable',relayRunner:null}}).reconcile();
 assert.ok(wrongReceipt.unresolved.some(value=>value.includes('nonmatching thread/read identity')),'a read for a different returned thread ID cannot acknowledge the prefix');
 rejected=make();await rejected.connect();
 await rejected.request('turn/start',{threadId:'rejected-thread'},{custodyOwnerSessionId:9014});
 const rejectedReceipt=await freezeManagedCodexTarget({ownerSessionId:9014,threadId:'rejected-thread',endpoint:{socketPath:'/disposable',relayRunner:null}}).reconcile();
 assert.ok(rejectedReceipt.unresolved.some(value=>value.includes('barrier failed')),'a native rejected read is not an acknowledged barrier');
 const emptyReceipt=await freezeManagedCodexTarget({ownerSessionId:9010,threadId:'empty-capture',endpoint:{socketPath:'/none',relayRunner:null}}).reconcile();
 assert.ok(emptyReceipt.unresolved.some(value=>value.includes('No managed active sender')),'an empty sender capture is not treated as coverage');
 keyed=make();await keyed.connect();
 await keyed.request('turn/start',{threadId:'ended-key-T'},{custodyOwnerSessionId:9011});
 await keyed.request('turn/start',{threadId:'ended-key-U'},{custodyOwnerSessionId:9012});
 const keyTCutoff=freezeManagedCodexTarget({ownerSessionId:9011,threadId:'ended-key-T',endpoint:{socketPath:'/disposable',relayRunner:null}});
 const keyTReceipt=await keyTCutoff.reconcile();assert.equal(keyTReceipt.unresolved.length,0);
 const keyedGeneration=keyed.activeGeneration!;await keyed.loseConnectionGeneration(keyedGeneration);
 const keyUReceipt=await freezeManagedCodexTarget({ownerSessionId:9012,threadId:'ended-key-U',endpoint:{socketPath:'/disposable',relayRunner:null}}).reconcile();
 assert.ok(keyUReceipt.unresolved.some(value=>value.includes('ended generation')),
   'a Thread(T) barrier cannot cover a prior Thread(U) write on the same ended generation');
 console.log('Native custody cutoff fixture passed: two captured clients, handler response before same-generation barriers, target-specific freeze, unrelated traffic, and refusal for path-keyed coverage gap.');
}finally{
 installCodexCustodyForwardGuard(null);
 await Promise.all([a.close({immediate:true}),b.close({immediate:true}),alias?.close({immediate:true}),completedAlias?.close({immediate:true}),loss?.close({immediate:true}),timeout?.close({immediate:true}),unkeyed?.close({immediate:true}),keyed?.close({immediate:true}),wrong?.close({immediate:true}),rejected?.close({immediate:true})]);
 rmSync(scratch,{recursive:true,force:true});
}
