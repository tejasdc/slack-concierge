/** Actual producer declarations, closed synthetic dependencies, no product imports.
 * Run through scripts/private-code-command.ts; HOME remains the caller's value. */
import assert from 'node:assert/strict';
import {AsyncResource} from 'node:async_hooks';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import ts from 'typescript';

assert.ok(process.env.CONCIERGE_PRIVATE_CODE_STATE,'Run this fixture through the supported private-code entrance before any source evaluation.');
const started=performance.now();
const sourceArg=process.argv.indexOf('--producer-source');
const sourcePath=sourceArg<0?resolve(import.meta.dir,'../src/codex-reset-credit.ts'):resolve(process.argv[sourceArg+1]!);
const admissionPath=resolve(import.meta.dir,'../src/ledger-admission.ts');
const producerSource=readFileSync(sourcePath,'utf8'),admissionSource=readFileSync(admissionPath,'utf8');
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
console.error(JSON.stringify({phase:'source-bound',sourcePath,producerSha256:hash(producerSource),admissionSha256:hash(admissionSource),productModuleImports:0}));

function declarations(source:string,path:string,names:string[]){
 const tree=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const found=new Map<string,string>();
 for(const statement of tree.statements){
  if((ts.isFunctionDeclaration(statement)||ts.isClassDeclaration(statement))&&statement.name&&names.includes(statement.name.text))found.set(statement.name.text,statement.getText(tree));
  if(ts.isVariableStatement(statement))for(const declaration of statement.declarationList.declarations)
   if(ts.isIdentifier(declaration.name)&&names.includes(declaration.name.text))found.set(declaration.name.text,`const ${declaration.getText(tree)};`);
 }
 assert.deepEqual([...found.keys()].sort(),[...names].sort(),'every evaluated declaration must be an exact named source node');
 const text=names.map(name=>found.get(name)!).join('\n').replace(/\bexport\s+/g,'');
 const checked=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const visit=(node:ts.Node)=>{assert.ok(!ts.isImportDeclaration(node)&&!ts.isExportDeclaration(node),'No source module graph may be evaluated');if(ts.isCallExpression(node))assert.ok(node.expression.kind!==ts.SyntaxKind.ImportKeyword&&!['require','eval'].includes(node.expression.getText(checked)),'No dynamic graph evaluation');ts.forEachChild(node,visit);};visit(checked);
 return ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
}
const actualAdmission=declarations(admissionSource,admissionPath,['LedgerAdmission']);
const Admission=new Function('AsyncResource',`${actualAdmission}\nreturn LedgerAdmission;`)(AsyncResource);
const actualProducer=declarations(producerSource,sourcePath,['WEEKLY_WINDOW_MINUTES','FIVE_HOUR_WINDOW_MINUTES','AUTOMATIC_EVIDENCE_MAX_AGE_MS','exactWindow','automaticTargetValidUntil','useCodexResetCredit']);
const makeProducer=new Function('dependencies',`const {homesByAccount,automaticResetPreflight,callAppServer,withAppServer,log,Date,WEEKLY_ALMOST_EXHAUSTED_PERCENT,runLedgerSegment,randomUUID}=dependencies;\n${actualProducer}\nreturn useCodexResetCredit;`);
const latch=<T=void>()=>{let release!:(value:T)=>void;const promise=new Promise<T>(resolve=>{release=resolve;});return{promise,release};};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
type Scenario='valid'|'expired-held'|'reservation-deadline'|'repeated-episode'|'manual';
const reports:unknown[]=[];
async function run(scenario:Scenario){
 const admission=new Admission();admission.enable();
 let now=1_700_000_000_000,settled=false,readCount=0,reservationCalls=0;
 const gate=latch(),fresh=latch(),enqueued=latch(),reply=latch<unknown>();
 let maintenance:Promise<void>|undefined;
 const reservations:string[]=[],requests:unknown[]=[],events:string[]=[];
 const reservedEpisodes=new Set<string>();
 const account='fixture@example.invalid',accountId='account-original-79',key='original-reset-attempt-79',creditId='original-credit-79';
 const limits=()=>({accountId,ordinaryUsageAllowed:false,rateLimitsByLimitId:{codex:{primary:{windowDurationMins:10080,usedPercent:100,resetsAt:1_700_003_600},secondary:{windowDurationMins:300,usedPercent:100,resetsAt:1_700_003_600}}},rateLimitResetCredits:{availableCount:1,credits:[{id:creditId,status:'available',resetType:'codexRateLimits'}]}});
 class Clock extends Date{static now(){return now;}}
 const freeze=()=>{assert.equal(maintenance,undefined);maintenance=admission.maintain(async()=>{await gate.promise;});fresh.release();};
 const consume=(params:unknown)=>{admission.assertSegment();events.push('enqueue');requests.push(params);enqueued.release();return reply.promise;};
 // Target-only saved homes yield Infinity: the target's source read must supply
 // its own finite evidence lifetime, independently of alternate-account evidence.
 const use=makeProducer({homesByAccount:()=>new Map([[account,{home:'/synthetic/never-opened-home',accountId}]]),automaticResetPreflight:async()=>({reason:null,validUntilMs:Infinity}),
  callAppServer:(_home:string,method:string,params:unknown)=>{assert.equal(_home,'/synthetic/never-opened-home');if(method==='account/rateLimitResetCredit/consume')return consume(params);assert.equal(method,'account/rateLimits/read');readCount++;return Promise.resolve(readCount%2===0?{accountId,ordinaryUsageAllowed:true,rateLimitResetCredits:{availableCount:0,credits:[]}}:limits());},
  withAppServer:async(_home:string,action:(...args:any[])=>Promise<unknown>)=>{assert.equal(_home,'/synthetic/never-opened-home');return action((method:string,params:unknown)=>{if(method==='account/rateLimits/read'){events.push('fresh-read');const value=limits();if(!maintenance)freeze();return Promise.resolve(value);}assert.equal(method,'account/rateLimitResetCredit/consume');return consume(params);},()=>true);},
  log:()=>{},Date:Clock,WEEKLY_ALMOST_EXHAUSTED_PERCENT:90,runLedgerSegment:(operation:()=>unknown)=>admission.run(operation),randomUUID:()=>{throw Error('Original supplied idempotency key must be preserved');}});
 const reserve=()=>{admission.assertSegment();reservationCalls++;events.push('reserve');if(reservedEpisodes.has('original-episode-79'))throw Error('ORIGINAL_EPISODE_ALREADY_RESERVED');reservedEpisodes.add('original-episode-79');reservations.push(key);if(scenario==='reservation-deadline')now+=60_001;};
 if(scenario==='manual')freeze();
 const pending=use(account,key,scenario!=='manual',reserve).then((result:unknown)=>{settled=true;return result;});
 await fresh.promise;await tick();
 assert.equal(admission.snapshot().pending,1,`${scenario}: complete final operation must wait for admission after read`);
 assert.deepEqual(reservations,[],`${scenario}: no episode marker while held`);assert.deepEqual(requests,[],`${scenario}: no RPC while held`);assert.equal(settled,false);
 if(scenario==='expired-held')now+=60_001;
 gate.release();await maintenance;
 if(scenario==='valid'||scenario==='manual'||scenario==='repeated-episode'){
  await enqueued.promise;assert.equal(settled,false,'result must await existing RPC reply');assert.equal(admission.snapshot().insideSegment,false,'RPC reply must be awaited outside lexical admission');
  assert.deepEqual(reservations,[key]);assert.deepEqual(requests,[{creditId,idempotencyKey:key}]);assert.deepEqual(events.slice(-2),['reserve','enqueue']);
  reply.release({outcome:'reset'});
 }
 let result:any=await pending;
 if(scenario==='repeated-episode'){
  assert.equal(result.status,'used');result=await use(account,key,true,reserve);assert.equal(result.status,'failed');assert.equal(reservationCalls,2);assert.deepEqual(reservations,[key]);assert.deepEqual(requests,[{creditId,idempotencyKey:key}]);assert.equal(readCount,3);
 }
 else if(scenario==='valid'||scenario==='manual'){assert.equal(result.status,'used');assert.equal(reservationCalls,1);assert.equal(readCount,2);}
 else {assert.equal(result.status,'failed');assert.deepEqual(requests,[]);if(scenario==='expired-held'){assert.equal(reservationCalls,0);assert.deepEqual(reservations,[]);}if(scenario==='reservation-deadline'){assert.equal(reservationCalls,1);assert.deepEqual(reservations,[key]);}}
 reports.push({scenario,status:result.status,reservationCalls,reservations,requests,events,alternateEvidenceValidUntil:'Infinity',heldClockAdvanceMs:scenario==='expired-held'?60_001:0,replyAwaitedOutsideSegment:true});
}
// Preserve the real wrapper's pending RPCs, timeout and terminal handlers. Only
// its native child/stdio and timer are synthetic; no child can be spawned here.
const actualWrapper=declarations(producerSource,sourcePath,['CALL_TIMEOUT_MS','withAppServer']);
const makeWrapper=new Function('dependencies',`const {spawn,jsonLine,onJsonLines,CODEX_CLI,setTimeout,clearTimeout,process}=dependencies;\n${actualWrapper}\nreturn withAppServer;`);
async function runLifetime(mode:'healthy'|'timeout'|'close'){
 const admission=new Admission();admission.enable();
 let now=1_700_000_000_000,settled=false,reservations=0,spawns=0,kills=0;
 const gate=latch(),fresh=latch(),consumeEntered=latch(),consumeReply=latch();
 let maintenance:Promise<void>|undefined,timer:{callback:()=>void;ms:number;cleared:boolean}|undefined;
 const requests:any[]=[],wire:any[]=[];
 const child:any=new EventEmitter();child.exitCode=null;child.signalCode=null;child.stdout=new EventEmitter();child.stderr=new EventEmitter();
 const accountId='account-original-79',creditId='original-credit-79',key='original-reset-attempt-79';
 const limits=()=>({accountId,ordinaryUsageAllowed:false,rateLimitsByLimitId:{codex:{primary:{windowDurationMins:10080,usedPercent:100,resetsAt:1_700_003_600}}},rateLimitResetCredits:{availableCount:1,credits:[{id:creditId,status:'available',resetType:'codexRateLimits'}]}});
 const close=()=>{if(child.exitCode!==null)return;child.exitCode=0;child.stdin.destroyed=true;child.stdin.writableEnded=true;child.emit('close',0);};
 child.stdin={destroyed:false,writableEnded:false,write:(line:string,callback?:(error?:Error|null)=>void)=>{
  const request=JSON.parse(line);wire.push(request);
  if(request.method==='account/rateLimitResetCredit/consume'){admission.assertSegment();requests.push({...request.params,insideSegment:admission.snapshot().insideSegment});consumeEntered.release();}
  if(child.exitCode!==null){queueMicrotask(()=>callback?.(new Error('SYNTHETIC_CLOSED_PIPE')));return false;}
  callback?.(null);
  if(request.method==='initialized')return true;
  let result:unknown;
  if(request.method==='initialize')result={};
  else if(request.method==='account/rateLimits/read'){
   result=limits();maintenance=admission.maintain(async()=>{await gate.promise;});fresh.release();
  }else if(request.method==='account/rateLimitResetCredit/consume'){
   void consumeReply.promise.then(()=>child.stdout.emit('line',JSON.stringify({id:request.id,result:{outcome:'reset'}})));return true;
  }else throw Error('Unexpected synthetic stdio method '+request.method);
  queueMicrotask(()=>child.stdout.emit('line',JSON.stringify({id:request.id,result})));return true;
 }};
 child.kill=()=>{kills++;close();return true;};
 const withAppServer=makeWrapper({spawn:(cli:string,args:string[],options:any)=>{spawns++;assert.equal(cli,'/synthetic/codex-never-executed');assert.deepEqual(args,['app-server','--stdio']);assert.equal(options.env.CODEX_HOME,'/synthetic/never-opened-home');return child;},
  jsonLine:(value:unknown)=>JSON.stringify(value)+'\n',onJsonLines:(stream:EventEmitter,receive:(line:string)=>void)=>{stream.on('line',receive);},CODEX_CLI:'/synthetic/codex-never-executed',
  setTimeout:(callback:()=>void,ms:number)=>{assert.equal(timer,undefined);timer={callback,ms,cleared:false};return timer;},clearTimeout:(value:any)=>{assert.equal(value,timer);value.cleared=true;},process:{env:{FIXTURE_ONLY:'1'}}});
 class Clock extends Date{static now(){return now;}}
 const use=makeProducer({homesByAccount:()=>new Map([['fixture@example.invalid',{home:'/synthetic/never-opened-home',accountId}]]),automaticResetPreflight:async()=>({reason:null,validUntilMs:Infinity}),
  callAppServer:async(_home:string,method:string)=>{assert.equal(_home,'/synthetic/never-opened-home');assert.equal(method,'account/rateLimits/read');return requests.length?{accountId,ordinaryUsageAllowed:true,rateLimitResetCredits:{availableCount:0,credits:[]}}:limits();},
  withAppServer,log:()=>{},Date:Clock,WEEKLY_ALMOST_EXHAUSTED_PERCENT:90,runLedgerSegment:(operation:()=>unknown)=>admission.run(operation),randomUUID:()=>{throw Error('Original ID required');}});
 const pending=use('fixture@example.invalid',key,true,()=>{admission.assertSegment();reservations++;}).then((result:any)=>{settled=true;return result;});
 await fresh.promise;await tick();assert.equal(admission.snapshot().pending,1);assert.equal(reservations,0);assert.deepEqual(requests,[]);assert.equal(settled,false);assert.equal(timer?.ms,25000);
 if(mode==='timeout'){now+=25001;timer!.callback();assert.equal(kills,1);}
 if(mode==='close'){now+=1000;close();}
 gate.release();await maintenance;
 if(mode==='healthy'){
  await consumeEntered.promise;assert.equal(settled,false);assert.equal(admission.snapshot().insideSegment,false);assert.equal(reservations,1);assert.deepEqual(requests,[{creditId,idempotencyKey:key,insideSegment:true}]);consumeReply.release();
 }
 const result=await pending;
 const receipt={scenario:'actual-child-'+mode,status:result.status,reservations,requests,syntheticSpawns:spawns,kills,timeoutMs:timer!.ms,heldClockAdvanceMs:mode==='timeout'?25001:mode==='close'?1000:0,evidenceStillFresh:true,timerCleared:timer!.cleared,wireMethods:wire.map(message=>message.method)};
 console.error(JSON.stringify({phase:'actual-child-lifetime-result',...receipt}));
 assert.equal(result.status,mode==='healthy'?'used':'failed');assert.equal(spawns,1);assert.equal(timer!.cleared,true);
 if(mode!=='healthy'){assert.equal(reservations,0,'ended initialized child must be rejected before episode reservation');assert.deepEqual(requests,[],'ended initialized child must not receive a consume write');}
 reports.push(receipt);
}
const deadline=setTimeout(()=>{console.error('reset-credit fixture deadline');process.exit(2);},5000);
try{for(const scenario of ['valid','expired-held','reservation-deadline','repeated-episode','manual'] as const)await run(scenario);
 for(const mode of ['healthy','timeout','close'] as const)await runLifetime(mode);
 console.log(JSON.stringify({fixture:'codex-reset-credit-admission',elapsedMs:Math.round(performance.now()-started),producerSha256:hash(producerSource),admissionSha256:hash(admissionSource),reports,productModuleImports:0,realHomes:0,realProviderCalls:0,spawnedChildren:0,homeEnvironmentUnchanged:true}));
}finally{clearTimeout(deadline);}
