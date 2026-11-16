/** Complete actual producer modules with imports removed before evaluation. */
import assert from 'node:assert/strict';
import {AsyncResource} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import ts from 'typescript';
assert.ok(process.env.CONCIERGE_PRIVATE_CODE_STATE,'Use private-code entrance before source evaluation');
const started=performance.now(),root=resolve(import.meta.dir,'../src');
const argument=(name:string,fallback:string)=>{const index=process.argv.indexOf(name);return index<0?fallback:resolve(process.argv[index+1]!);};
const paths={claude:argument('--claude-source',root+'/claude-code.ts'),codex:argument('--codex-source',root+'/codex.ts')};
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
function closedModule(source:string,dependencies:any){
 const tree=ts.createSourceFile('actual.ts',source,ts.ScriptTarget.Latest,true),bindings=new Set<string>();
 const nodes=tree.statements.filter(node=>{
  if(!ts.isImportDeclaration(node))return true;
  const clause=node.importClause;if(clause?.name)bindings.add(clause.name.text);
  const named=clause?.namedBindings;if(named&&ts.isNamedImports(named))for(const binding of named.elements)bindings.add(binding.name.text);
  else if(named&&ts.isNamespaceImport(named))bindings.add(named.name.text);
  return false;
 });
 const text=nodes.map(node=>node.getText(tree)).join('\n');
 const checked=ts.createSourceFile('actual.ts',text,ts.ScriptTarget.Latest,true);
 const visit=(node:ts.Node)=>{assert.ok(!ts.isImportDeclaration(node)&&!ts.isExportDeclaration(node));if(ts.isCallExpression(node))assert.ok(node.expression.kind!==ts.SyntaxKind.ImportKeyword&&!['require','eval'].includes(node.expression.getText(checked)));ts.forEachChild(node,visit);};visit(checked);
 const code=ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 return new Function('dependencies','exports',`const {${[...bindings].join(',')}}=dependencies;const process={env:{},platform:'linux'};\n${code}\nreturn exports;`)(dependencies,{});
}
const ledgerText=readFileSync(root+'/ledger-admission.ts','utf8'),custodyText=readFileSync(root+'/provider-callback-custody.ts','utf8');
const latch=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return{promise,release};};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const sources={claude:readFileSync(paths.claude,'utf8'),codex:readFileSync(paths.codex,'utf8')};
console.error(JSON.stringify({phase:'source-bound',hashes:{claude:sha(sources.claude),codex:sha(sources.codex),admission:sha(ledgerText),custody:sha(custodyText)},productGraphImports:0}));
const reports:any[]=[];
async function run(kind:'claude'|'codex-shared'|'codex-stdio'|'codex-adopted-known'|'claude-transport-error'){
 const claude=kind==='claude'||kind==='claude-transport-error',transportError=kind==='claude-transport-error';
 const shared=kind==='codex-shared'||kind==='codex-adopted-known',adopted=kind==='codex-adopted-known';
 // Every scenario owns its actual module-level lexical gate and callback queues.
 const ledger=closedModule(ledgerText,{AsyncResource});ledger.enableLedgerAdmission();
 const custody=closedModule(custodyText,ledger);
 const timers=new Map<number,{callback:()=>void;ms:number}>();let timer=0;
 const fakeSet=(callback:()=>void,ms:number)=>{const id=++timer;timers.set(id,{callback,ms});return id;};
 const fakeClear=(id:number)=>{timers.delete(id);};
 class Cancelled extends Error{constructor(){super('original Stop');}}
 class DispatchError extends Error{constructor(input:any){super(input.message);Object.assign(this,input);}}
 const forbidden=(name:string)=>(..._args:any[])=>{throw Error('Forbidden unprovided dependency: '+name);};
 let fences=0;
 const dependencies:any=new Proxy({...ledger,...custody,createHash,randomUUID:()=> '10000000-0000-4000-8000-000000000079',
  providerOwnerEnvironment:(env:any)=>env??{},claudeConsultationEnvironment:()=>({}),withoutMachinePaths:(env:any)=>env,
  splitTurnOutcomeMarker:(text:string)=>({text,mark:null}),providerMessageObserver:(callback:any)=>(rows:any[])=>{for(const row of rows)callback?.(row);},
  claudeHistoryMessages:(event:any)=>typeof event.uuid==='string'&&event.message?[{id:event.uuid,role:event.message.role,content:event.message.content}]:[],claudeToolNames:()=>[],codexHistoryMessages:()=>[],
  log:()=>{},errorFields:(error:any)=>({error:String(error)}),ProviderDispatchError:DispatchError,ProviderTurnCancelledError:Cancelled,
  SteeringNotSentError:class extends Error{},WriteOutcomeUnknownError:class extends Error{},CodexAppServerClientError:class extends Error{},CodexAppServerUnansweredError:class extends Error{},ProviderCapabilityUnavailableError:class extends Error{},
  isClaudeUsageExhaustion:()=>false,isContextOverflowRefusal:()=>false,recordClaudeWorkload:()=>{},webActivityDetails:()=>null,macSurfaceActivity:()=>null,isCodeEditTool:()=>false,
  claudeUsageFallbackModels:()=>[],DEFAULT_CLAUDE_SUBAGENT_MODEL:'fixture-model',assertUsageAvailable:()=>{},cachedUsageLimit:()=>null,recordUsageExhaustion:()=>{},recordUsageSuccess:()=>{},resetEpochMilliseconds:()=>null,usageAttempt:()=>({provider:kind,generation:1,revision:1}),usageLimitMessage:()=> 'fixture',codexUsageReset:()=>null,
  assertProviderForkPolicy:()=>{},assertProviderInteractionPolicy:()=>{},claudeConsultationArgs:()=>[],codexConsultationConfig:()=>({}),CONSULTATION_PERMISSION_PROFILE:'fixture',codexRelayRunner:()=>null,
  ledgerDurable:async()=>{fences++;},setTimeout:fakeSet,clearTimeout:fakeClear,setInterval:fakeSet,clearInterval:fakeClear}, {get(target,name:string){return name in target?(target as any)[name]:forbidden(name);}});
 // Timer functions are lexical globals, while all import bindings are supplied.
 const source=(claude?sources.claude:sources.codex).replace(/\bsetTimeout\(/g,'fixtureSetTimeout(').replace(/\bclearTimeout\(/g,'fixtureClearTimeout(').replace(/\bsetInterval\(/g,'fixtureSetTimeout(').replace(/\bclearInterval\(/g,'fixtureClearTimeout(');
 // Only timer identifiers are rebound. Producer declarations and control flow stay exact.
 const module=closedModule('const fixtureSetTimeout=dependencies.setTimeout,fixtureClearTimeout=dependencies.clearTimeout;\n'+source,dependencies);
 const gate=latch(),ready=latch(),finish=latch(),nativeFailure=latch(),historyFeed=latch();let cancel:(()=>Promise<void>)|undefined,steering:any,transportInput:any,notify:((event:any)=>Promise<void>)|undefined,nativeTerminal=false,historyReads=0;
 let settled=false,cancelSettled=false,closeCalls=0,boundaryStarted=false;const writes:any[]=[],events:any[]=[],receivedBeforeBoundary:any[]=[];const requests:any[]=[];
 const threadId='original-thread-79',turnId='original-turn-79',clientId='original-input-79';
 const emit=(event:any)=>{if(claude&&!boundaryStarted)receivedBeforeBoundary.push(event);const operation=shared?notify!(event):transportInput.onStdout(JSON.stringify(event)+'\n',Date.now());void Promise.resolve(operation).catch(()=>{});};
 const response=(method:string)=>method==='initialize'?{}:method==='thread/start'||method==='thread/resume'?{thread:{id:threadId},model:'fixture'}:method==='turn/start'?{turn:{id:turnId}}:{};
 const onStarted=()=>setImmediate(()=>emit({method:'turn/started',params:{threadId,turn:{id:turnId,status:'inProgress'}}}));
 const transport={transcriptWatcher:()=>()=>()=>{},async run(input:any){transportInput=input;console.error(JSON.stringify({phase:'synthetic-transport-entered',kind}));
  input.onStdinReady(async(line:string,meta:any)=>{const message=JSON.parse(line);writes.push({message,meta});if(kind==='codex-stdio'&&message.id){queueMicrotask(()=>emit({id:message.id,result:response(message.method)}));if(message.method==='turn/start')onStarted();}},()=>{closeCalls++;finish.release();});
  if(claude){
   const originalSubmission=JSON.parse(input.stdin);assert.deepEqual(originalSubmission.message.content,[{type:'text',text:'original input'}]);assert.equal(typeof originalSubmission.uuid,'string');
   for(const event of [{type:'system',subtype:'init',session_id:threadId},{type:'user',uuid:originalSubmission.uuid,session_id:threadId,message:{role:'user',content:'original input'}}]){console.error(JSON.stringify({phase:'synthetic-original-input-feed',kind,type:event.type}));await input.onStdout(JSON.stringify(event)+'\n',Date.now());console.error(JSON.stringify({phase:'synthetic-original-input-consumed',kind,type:event.type}));}
  }else{const initial=JSON.parse(input.stdin);queueMicrotask(()=>emit({id:initial.id,result:{}}));}
  await Promise.race([finish.promise,nativeFailure.promise.then(()=>{throw Error('original-native-error');})]);return{code:0,signal:null};}};
 const userItem={id:'original-user-item-79',type:'userMessage',clientId,content:[{type:'inputText',text:'original input'}]};
 const client={connect:async()=>1,onDisconnect:()=>()=>{},onNotification:(callback:any)=>{notify=callback;return()=>{};},async request(method:string,params:any,options:any){requests.push({method,params});
  if(method==='turn/interrupt')nativeTerminal=true;
  if(method==='thread/turns/list'){historyReads++;const result={data:[{id:turnId,status:nativeTerminal?'interrupted':'inProgress',items:[userItem]}],nextCursor:null};if(historyReads===1){ready.release();await historyFeed.promise;}return result;}
  if(method==='thread/items/list')return{data:[{turnId,item:userItem},{turnId,item:{id:'original-output-79',type:'agentMessage',text:'original held output',phase:'final_answer'}}],nextCursor:null};
  const result=response(method);options?.onAccepted?.(result);if(method==='turn/start')onStarted();return result;}};
 const input:any={prompt:'original input',model:'fixture',cwd:'/synthetic/never-opened',additionalDirs:[],sessionUUID:null,clientUserMessageId:clientId,environment:{},
  onCancellationReady:(callback:any)=>{cancel=callback;},onSteeringReady:(sender:any)=>{steering=sender;ready.release();},onProviderTerminal:()=>events.push({terminal:true}),onProgress:(event:any)=>events.push(event),onInputAcknowledged:()=>events.push({acknowledged:clientId}),
  ...(claude?{onProviderMessage:(message:any)=>events.push({providerMessage:message})}:{}),
  ...(shared?{appServerClient:client}:{transport}),...(kind==='codex-stdio'?{executable:'/synthetic/never-executed-codex'}:{}),...(adopted?{adoptTurn:{threadId,turnId},sessionUUID:threadId}:{})};
 const pending=(claude?module.runClaudeCodeTurn(input):module.runCodexTurn(input)).then((value:any)=>{settled=true;return{value,error:null};},(error:any)=>{settled=true;return{value:null,error:error.message};});
 await Promise.race([ready.promise,pending.then(result=>{throw Error('producer ended before registered controls: '+JSON.stringify(result));})]);await tick();assert.ok(cancel);if(!adopted)assert.ok(steering);
 let steeringResult:Promise<{status:string;error?:string}>|undefined,steeringSettled=false,originalSteering:any;
 if(claude){
  steeringResult=steering({text:'original steering accepted before freeze',clientMessageId:'original-steering-input-79'}).then(()=>{steeringSettled=true;return{status:'acknowledged'};},(error:Error)=>{steeringSettled=true;return{status:'rejected',error:error.message};});
  for(let step=0;step<8&&!originalSteering;step++){await tick();originalSteering=writes.find(write=>write.meta?.kind==='steering');}
  assert.ok(originalSteering,'original steering is sent exactly once before freezing');assert.equal(steeringSettled,false);assert.equal(typeof originalSteering.message.uuid,'string');
 }
 const before=events.length,maintenance=ledger.maintainLedger(async()=>{await gate.promise;});
 if(adopted)historyFeed.release();
 else if(claude)emit({type:'assistant',uuid:'original-output-79',session_id:threadId,message:{id:'original-call-79',role:'assistant',content:[{type:'text',text:'original held output'}]}});
 else emit({method:'item/completed',params:{threadId,turnId,item:{id:'original-output-79',type:'agentMessage',text:'original held output',phase:'commentary'}}});
 if(claude)emit({type:'user',uuid:originalSteering.message.uuid,session_id:threadId,message:originalSteering.message.message});
 await tick();assert.equal(events.length,before);assert.equal(settled,false);
 const fencesBeforeStop=fences;
 boundaryStarted=true;
 const cancellation=transportError?(nativeFailure.release(),Promise.resolve()):cancel!().then(()=>{cancelSettled=true;});void cancellation.catch(()=>{});await tick();await tick();
 const controls=claude?writes.filter(write=>write.meta?.kind==='interrupt'):shared?requests.filter(request=>request.method==='turn/interrupt'):writes.filter(write=>write.message.method==='turn/interrupt');
 const steeringSettledWhileHeld=steeringSettled;
 console.error(JSON.stringify({phase:transportError?'native-error-while-held':'registered-stop-while-held',kind,cancelSettled,controls,closeCalls,eventsBefore:before,eventsAfter:events.length,settled,fences,fencesBeforeStop,steeringSettled}));
 assert.equal(controls.length,transportError?0:1,'actual registered Stop must reach native control while observations are held');assert.equal(cancelSettled,!adopted&&!transportError);assert.equal(events.length,before);assert.equal(settled,false);
 if(claude){assert.equal(closeCalls,1);if(!transportError)assert.equal(controls[0].message.request.subtype,'interrupt');}
 else {const params=shared?controls[0].params:controls[0].message.params;assert.deepEqual(params,{threadId,turnId});assert.equal(fences-fencesBeforeStop,adopted?0:1,'Stop preserves its existing durability fence count');}
 if(!claude)emit({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'interrupted',items:[]}}});
 gate.release();await maintenance;
 if(adopted){let retry:[number,{callback:()=>void;ms:number}]|undefined;for(let step=0;step<12&&!retry;step++){await tick();retry=[...timers].find(([,value])=>value.ms===100);}assert.ok(retry,'existing exact-history recovery retry remains authoritative');timers.delete(retry[0]);retry[1].callback();}
 if(claude)finish.release();
 const result=await pending;assert.equal(result.error,transportError?'original-native-error':'original Stop');assert.ok(events.length>before);assert.equal(events.filter(event=>event.terminal).length,transportError?0:1);
 if(claude){
  const receipt=await steeringResult!;
  const assistantIndex=events.findIndex(event=>event.providerMessage?.id==='original-output-79'),terminalIndex=events.findIndex(event=>event.terminal),steeringIndex=events.findIndex(event=>event.providerMessage?.id===originalSteering.message.uuid);
  console.error(JSON.stringify({phase:'claude-retained-output-and-steering-settlement',events,assistantIndex,terminalIndex,steeringIndex,steering:receipt,originalSteering,writes,receivedBeforeBoundary,steeringSettledWhileHeld}));
  assert.equal(steeringSettledWhileHeld,false,'original steering acknowledgement stays pending until its retained echo is consumed');
  assert.deepEqual(receivedBeforeBoundary.map(event=>event.uuid),['original-output-79',originalSteering.message.uuid],'ordering oracle covers original frames received before Stop/native-error boundary only');
  assert.ok(assistantIndex>=0&&(transportError||assistantIndex<terminalIndex),'original retained assistant message must consume before terminal callback');
  assert.deepEqual(events[assistantIndex].providerMessage.content,[{type:'text',text:'original held output'}]);
  assert.equal(receipt.status,'acknowledged','already-sent original steering echo must acknowledge after resume');assert.ok(steeringIndex>=0&&(transportError||steeringIndex<terminalIndex));
  assert.deepEqual(events[steeringIndex].providerMessage.content,originalSteering.message.message.content);
  assert.equal(writes.filter(write=>write.meta?.kind==='steering').length,1,'Stop must not replay the original steering effect');
 }
 assert.equal((shared?requests.map(request=>request.method):writes.map(write=>write.message.method)).filter(method=>method==='turn/steer').length,0);
 if(adopted){assert.equal(historyReads,2);assert.equal(requests.filter(request=>request.method==='turn/start').length,0);assert.equal(requests.filter(request=>request.method==='turn/interrupt').length,1);await cancellation;}
 reports.push({kind,controls,closeCalls,fences,fencesBeforeStop,historyReads,retainedConsumerResumed:true,result,events});
}
const deadline=setTimeout(()=>{console.error('provider Stop fixture deadline');process.exit(2);},5000);
try{const kinds=['claude','codex-shared','codex-stdio','codex-adopted-known','claude-transport-error'] as const;const selected=process.argv.indexOf('--case'),only=selected<0?null:process.argv[selected+1];assert.ok(!only||kinds.includes(only as any));for(const kind of kinds)if(!only||only===kind)await run(kind);console.log(JSON.stringify({fixture:'provider-stop-consumption',elapsedMs:Math.round(performance.now()-started),reports,productGraphImports:0,nativeProviderCalls:0,homeEnvironmentUnchanged:true}));}finally{clearTimeout(deadline);}
