/** Actual hosted transport/callback custody/admission, closed synthetic host only. */
import assert from 'node:assert/strict';
import {AsyncResource} from 'node:async_hooks';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import ts from 'typescript';
assert.ok(process.env.CONCIERGE_PRIVATE_CODE_STATE,'Use the supported private-code entrance before evaluating source.');
const started=performance.now(),sourceArg=process.argv.indexOf('--transport-source');
const sourcePath=sourceArg<0?resolve(import.meta.dir,'../src/execution-host-client.ts'):resolve(process.argv[sourceArg+1]!);
const source=readFileSync(sourcePath,'utf8'),custodySource=readFileSync(resolve(import.meta.dir,'../src/provider-callback-custody.ts'),'utf8'),admissionSource=readFileSync(resolve(import.meta.dir,'../src/ledger-admission.ts'),'utf8');
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const sourceHashes={transport:sha(source),custody:sha(custodySource),admission:sha(admissionSource)};
console.error(JSON.stringify({phase:'source-bound',sourcePath,sourceHashes,productModuleImports:0}));
function extract(text:string,names:string[]){
 const tree=ts.createSourceFile('selected.ts',text,ts.ScriptTarget.Latest,true),selected=new Map<string,string>();
 for(const node of tree.statements){
  if((ts.isClassDeclaration(node)||ts.isFunctionDeclaration(node))&&node.name&&names.includes(node.name.text))selected.set(node.name.text,node.getText(tree));
  if(ts.isVariableStatement(node))for(const declaration of node.declarationList.declarations)if(ts.isIdentifier(declaration.name)&&names.includes(declaration.name.text))selected.set(declaration.name.text,'const '+declaration.getText(tree)+';');
 }
 assert.deepEqual([...selected.keys()].sort(),[...names].sort());
 const code=names.map(name=>selected.get(name)!).join('\n').replace(/\bexport\s+/g,'');
 const checked=ts.createSourceFile('selected.ts',code,ts.ScriptTarget.Latest,true);
 const visit=(node:ts.Node)=>{assert.ok(!ts.isImportDeclaration(node)&&!ts.isExportDeclaration(node));if(ts.isCallExpression(node))assert.ok(node.expression.kind!==ts.SyntaxKind.ImportKeyword&&!['require','eval'].includes(node.expression.getText(checked)));ts.forEachChild(node,visit);};visit(checked);
 return ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
}
const Admission=new Function('AsyncResource',extract(admissionSource,['LedgerAdmission'])+'\nreturn LedgerAdmission;')(AsyncResource);
const custodyCode=extract(custodySource,['ProviderCallbackCustody','consumeProviderObservation','withProviderCallbackCustody','providerObservationCallbacks','transportObservationCallbacks','executionObservationCallbacks']);
const transportCode=extract(source,['HostUnavailableError','HostNotStartedError','HostLostError','HostWriteRefusedError','WriteOutcomeUnknownError','HostedClaudeCodeTransport']);
const factory=new Function('dependencies',`const {runLedgerSegment,setTimeout,clearTimeout,randomUUID,log,LocalHostAccess,ProviderDispatchError}=dependencies;let activeAdoptedRuns=0;\n${custodyCode}\n${transportCode}\nreturn HostedClaudeCodeTransport;`);
const latch=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return{promise,release};};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const reports:unknown[]=[];
async function run(mode:'inactivity'|'interrupt'|'graceful'|'graceful-rejected'){
 const admission=new Admission();admission.enable();
 let serial=0,statusCalls=0,readerClosed=0,readerSequence=0,settled=false,frameDispatch:((frame:any)=>void)|undefined;
 let interrupt:(()=>Promise<void>)|undefined,closeInput:(()=>void)|undefined;
 const ready=latch(),gate=latch(),terminalEntered=latch(),terminalRelease=latch();
 const frames:any[]=[],consumed:any[]=[],commands:any[]=[],reads:number[]=[];
 const timers=new Map<number,{callback:()=>void;ms:number}>();
 const status=()=>({protocol:3,executionId:'original-execution-79',hostPid:500,providerPid:501,lastSeq:frames.length,exit:null,journalError:null});
 const link:any={protocol:3,fenced:false,replayWriteOutcomes:new Map(),
  attach:async(from:number,onFrame:(frame:any)=>void)=>{assert.equal(from,1);frameDispatch=onFrame;return{...status(),until:0,streamingReplay:true};},
  command:(command:any)=>{assert.equal(admission.snapshot().phase,'maintenance','control must execute while business admission is held');commands.push({...command,retainedJournalCount:frames.length});return mode==='graceful-rejected'?Promise.reject(new Error('synthetic control reply rejection')):Promise.resolve({ok:true});},
  status:async()=>{statusCalls++;return status();},onClosed:()=>{},close:()=>{throw Error('No link replacement or native host shutdown is part of this fixture');}};
 const access:any={place:'runner',connect:async()=>link,
  custody:()=>{throw Error('No reconnect/resubmit allowed');},launch:()=>{throw Error('No launch allowed');},
  journal:async function*(){yield* frames;},journalReader:()=>({read:async function*(through:number){reads.push(through);while(readerSequence<through)yield frames[readerSequence++];},close:async()=>{readerClosed++;}})};
 const Transport=factory({runLedgerSegment:(operation:()=>unknown)=>admission.run(operation),setTimeout:(callback:()=>void,ms:number)=>{const id=++serial;timers.set(id,{callback,ms});return id;},clearTimeout:(id:number)=>timers.delete(id),randomUUID:()=>`original-control-${++serial}`,log:()=>{},
  LocalHostAccess:class{constructor(){throw Error('LocalHostAccess forbidden before any product access');}},ProviderDispatchError:class extends Error{}});
 const transport=new Transport({mode:'adopt',executionId:'original-execution-79',stateDir:'/synthetic/never-opened',access,onExited:async(exit:any)=>{consumed.push({terminal:exit});terminalEntered.release();await terminalRelease.promise;}},{inactivityMs:73,shutdownGraceMs:11});
 const pending=transport.run({args:[],cwd:'/synthetic/never-opened',stdin:'original-initial-input',onStdout:(text:string,time:number|undefined)=>{consumed.push({text,time});},onStderr:()=>{},
  onInterruptReady:(callback:()=>Promise<void>)=>{interrupt=callback;},onStdinReady:(_write:unknown,close:()=>void)=>{closeInput=close;},onReplayEnd:()=>ready.release()}).then((exit:any)=>{settled=true;return{exit,error:null};},(error:Error)=>{settled=true;return{exit:null,error:error.message};});
 await ready.promise;await tick();await tick();assert.ok(interrupt&&closeInput);assert.equal(consumed.length,0);
 const maintenance=admission.maintain(async()=>{await gate.promise;});
 const stdout={s:1,t:1_700_000_000_001,k:'o',d:'original stdout — retained bytes, original execution 79'};frames.push(stdout);frameDispatch!(stdout);await tick();
 assert.equal(admission.snapshot().pending,1,'stdout observation must be held by actual admission');assert.equal(consumed.length,0);assert.equal(settled,false);
 const fire=async(ms:number)=>{const entry=[...timers].find(([,timer])=>timer.ms===ms);assert.ok(entry,`existing ${ms}ms timer registered`);timers.delete(entry[0]);entry[1].callback();await tick();await tick();};
 if(mode==='inactivity'){await fire(73);assert.equal(statusCalls,1);}
 else if(mode==='interrupt'){await interrupt!();await fire(5000);}
 else{closeInput!();await fire(11);}
 await fire(11);
 const expected=mode==='inactivity'?['close','SIGTERM','SIGKILL']:mode==='interrupt'?['SIGINT','SIGTERM','SIGKILL']:['close','SIGTERM','SIGKILL'];
 const observed=commands.map(command=>command.signal??command.op);
 console.error(JSON.stringify({phase:'control-while-held',mode,observed,expected,statusCalls,consumed,settled,retainedFrames:frames}));
 assert.deepEqual(observed,expected,'termination control must not queue behind held stdout');assert.equal(settled,false);assert.deepEqual(consumed,[]);
 if(mode==='interrupt')assert.match(commands[0].id,/^interrupt-/);else assert.equal(commands[0].id,'close-original-execution-79');
 const terminal={s:2,t:1_700_000_000_002,k:'x',d:{code:0,signal:null}};frames.push(terminal);frameDispatch!(terminal);await tick();assert.equal(settled,false);assert.deepEqual(consumed,[]);assert.equal(readerSequence,1,'terminal remains retained behind original stdout consumer');
 gate.release();await maintenance;await terminalEntered.promise;
 assert.deepEqual(consumed,[{text:stdout.d+'\n',time:undefined},{terminal:{code:0,signal:null}}]);assert.equal(settled,false,'final result must await asynchronous terminal consumer');
 terminalRelease.release();const result=await pending;
 if(mode==='inactivity')assert.match(result.error!,/no provider activity/);else assert.deepEqual(result,{exit:{code:0,signal:null},error:null});
 assert.equal(readerClosed,1);assert.equal(readerSequence,2);assert.equal(timers.size,0);
 reports.push({mode,commands:observed,statusCalls,consumed,result,readerClosed,reads,retainedIdentityPreserved:true,terminalResultAwaited:true});
}
const deadline=setTimeout(()=>{console.error('hosted control fixture deadline');process.exit(2);},5000);
try{for(const mode of ['inactivity','interrupt','graceful','graceful-rejected'] as const)await run(mode);
 console.log(JSON.stringify({fixture:'hosted-claude-control-consumption',elapsedMs:Math.round(performance.now()-started),sourceHashes,reports,productModuleImports:0,nativeHostCalls:0,providerCalls:0,homeEnvironmentUnchanged:true}));
}finally{clearTimeout(deadline);}
