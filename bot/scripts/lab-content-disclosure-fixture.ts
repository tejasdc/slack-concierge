import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runFixtureChild} from './fixture-child';
import {LAB_CONVERSATIONS_TEST_AUTHORIZATION} from '../src/test-authorizations';

async function child(){
 const [{db,claimNextQueuedTurn,markTurnProviderAdmissionIntended,acknowledgeTurnProviderInput,finishTurn},inputs,{SessionOwner},{LabConversations},{SessionCommunicationCoordinator}]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/session-owner'),import('../src/lab-conversations'),import('../src/session-communication')]);
 const {createNativeSession,getAcceptedSessionInput,retainSessionInput,enqueueSessionInput,nativeRunId,sessionInputProvenance,updateSessionMetadata}=inputs;
 const make=(provider:'codex'|'chatgpt',label:string)=>createNativeSession(provider,{summary:undefined,title:label,purpose:'chat',model:provider==='codex'?'gpt-6-luna':'his:pro',reasoningEffort:provider==='codex'?'low':undefined,cwd:process.env.CONCIERGE_STATE_DIR,origin:'native'});
 const coordinator=make('codex','coordinator'),first=make('codex','existing coding participant'),second=make('chatgpt','tool-free ChatGPT');
 const owner=new SessionOwner({available:()=>true,wake(){},stop:async()=>false,steer:()=>false},process.env.CONCIERGE_STATE_DIR!);
 const opening={id:'opening',revision:'opening-v1',author:{session:'tejas'},text:'The same common question.'};
 const records=new Map<string,any>();let failPublication=true,blockSession:string|null=null,releaseBlock:()=>void=()=>{};let stoppedDispatches=0;
 const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
 let lab:any;
 const ports:any={
  bootstrap:async()=>({version:1,state:{owner:`concierge:${coordinator.id}`},entries:[opening]}),
  prepare:async(choice:any)=>choice.sessionId?{choice,sessionId:Number(choice.sessionId.slice(10))}:{choice,provider:'codex',metadata:{summary:undefined,title:choice.label,purpose:'chat',model:choice.model,reasoningEffort:choice.reasoningEffort,cwd:process.env.CONCIERGE_STATE_DIR!,project:process.env.CONCIERGE_STATE_DIR!,origin:'native'}},
  sources:async(refs:any[])=>refs.map(reference=>({reference,text:'Actual selected source material.',sha256:hash('Actual selected source material.')})),
  bind:async(thread:string,membershipRevision:number)=>({version:1,thread,membershipRevision,bound:true}),
  context:async({thread,entryId,sessionId,requestId,independent,signal}:any)=>{
   assert.equal(lab.requestFacts(thread,requestId).sessionId,sessionId,'descriptor exists before context crosses the service boundary');
   if(sessionId===blockSession)await new Promise<void>((resolve,reject)=>{releaseBlock=resolve;signal.addEventListener('abort',()=>reject(new Error('stopped')),{once:true});});
   return {version:1,thread,entryId,sessionId,membershipRevision:lab.requestFacts(thread,requestId).membershipRevision,responseTargets:lab.requestFacts(thread,requestId).responseTargets,
    entries:independent?[opening]:[...(thread==='roster'?[opening,{id:'intervening-shared-entry',text:'An intervening shared discussion before the newcomer.'}]:[]),{id:`sealed-${sessionId}`,text:`Only ${sessionId} can see this sealed contribution.`},{id:entryId,text:'The exact selected follow-up.'}]};
  },
  publish:async({thread,requestId,eventId}:any)=>{
   const facts=lab.answerFacts(thread,requestId,eventId),key=`${requestId}:${eventId}`;
   if(!records.has(key))records.set(key,{id:randomUUID(),address:`lab:${thread}/${records.size+1}`,duplicate:false,facts});
   if(failPublication){failPublication=false;throw new Error('Response lost after journal commit.');}
   const record=records.get(key);return {id:record.id,address:record.address,duplicate:true};
  },
  dispatch:(input:any)=>{stoppedDispatches++;owner.dispatch(input);},wake(){},
 };
 lab=new LabConversations(ports);(owner as any).labCoordinator=lab;
 const instructions='Use only the selected material.\nKeep the second line exactly as written.';
 const create={clientActionId:'create-comparison',thread:'comparison',questionEntryId:'opening',participants:[{key:'coding',label:'Coding voice',sessionId:`concierge:${first.id}`,instructions},{key:'chatgpt',label:'ChatGPT voice',sessionId:`concierge:${second.id}`} ]};
 await lab.create(create);await lab.create(create);
 assert.equal(db.query("SELECT count(*) AS n FROM session_inputs WHERE kind='lab-conversation'").get()?.n,1);
 await assert.rejects(()=>lab.create({...create,clientActionId:'changed'}),/conflict/i);
 assert.equal(lab.view('comparison').coordinatorSessionId,`concierge:${coordinator.id}`);
 await lab.reconcile();
 let views=lab.view('comparison'),invocations=views.activations[0].invocations;
 assert.equal(invocations.length,2);assert.equal(db.query("SELECT count(*) AS n FROM turns").get()?.n,2);
 assert.equal(db.query('SELECT count(*) AS n FROM turns WHERE session_id=?').get(coordinator.id)?.n,0,'coordinator is idle until explicitly selected');
 for(const invocation of invocations){
  const accepted=getAcceptedSessionInput(invocation.inputId)!;assert.equal(accepted.origin,'service');
  const prompt=JSON.parse(accepted.payload_json).text;assert.ok(prompt.includes(opening.text));assert.ok(!prompt.includes('Only concierge:'));
  if(accepted.session_id===first.id){assert.ok(prompt.includes(`Selected participant instructions, verbatim:\n${instructions}`));assert.ok(prompt.indexOf(instructions)<prompt.indexOf('Visible Lab discussion:'));}
  assert.equal(sessionInputProvenance(accepted)?.originatingHuman?.inputId,accepted.source_input_id,'the real human action has no fictional run');
 }
 const firstClaim=claimNextQueuedTurn('lab-fixture')!;
 assert.equal(firstClaim.session_id,first.id);markTurnProviderAdmissionIntended(firstClaim.turn_id,'lab-fixture',firstClaim.dispatch_attempt);acknowledgeTurnProviderInput(firstClaim.turn_id,'lab-fixture',firstClaim.dispatch_attempt,[]);
 const codingInvocation=invocations.find((value:any)=>value.sessionId===`concierge:${first.id}`),codingFacts=lab.requestFacts('comparison',codingInvocation.requestId);
 db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({admission:{provider:'codex',model:'gpt-6-luna',bindingGeneration:1,inputId:firstClaim.accepted_input_id,runId:nativeRunId(firstClaim.turn_id)}}),firstClaim.accepted_input_id);
 inputs.recordSessionEvent({eventId:`fixture-coding-binding:${firstClaim.turn_id}`,sessionId:first.id,inputId:firstClaim.accepted_input_id,turnId:firstClaim.turn_id,kind:'lab_binding_verified',payload:Object.fromEntries(['provider','model','reasoningEffort','project','projectPath','generation'].map(key=>[key,codingFacts.participant[key]]))});
 finishTurn(firstClaim.turn_id,'done','Original coding answer, preserved exactly.');
 updateSessionMetadata(first.id,{model:'gpt-6.1-sol'});
 await lab.reconcile();assert.equal(records.size,1,'one original answer published even though its receipt was lost');
 const turnCount=db.query('SELECT count(*) AS n FROM turns').get()?.n;
 lab=new LabConversations(ports);(owner as any).labCoordinator=lab;await lab.reconcile();
 assert.equal(records.size,1);assert.equal(db.query('SELECT count(*) AS n FROM turns').get()?.n,turnCount,'restart and publication retry never replay provider execution');
 updateSessionMetadata(first.id,{model:'gpt-6-luna'});
 assert.throws(()=>lab.answerFacts('another-thread',invocations[0].requestId,invocations[0].eventId??'wrong'),/thread|conversation/i);
 assert.throws(()=>lab.answerFacts('comparison',invocations[0].requestId,'wrong-event'),/match|retained/i);


 // Start the real ChatGPT host path with only its external transport held pending.
 const {SessionExecutionHost}=await import('../src/session-execution-host'),{ActiveTurnDispatchRegistry}=await import('../src/turn-dispatch-seams');
 const {SessionCapabilityClient}=await import('../src/session-capability-client');
 let releaseProvider!:()=>void,enteredProvider!:()=>void;
 const providerEntered=new Promise<void>(resolve=>{enteredProvider=resolve;});
 const providerHeld=new Promise<void>(resolve=>{releaseProvider=resolve;});
 const client=new SessionCapabilityClient({socketPath:join(process.env.CONCIERGE_STATE_DIR!,'unused.sock')});
 (client as any).start=async(run:any)=>{
  enteredProvider();await providerHeld;
  const binding={accountScope:'fixture-account',sessionId:'fixture-chatgpt-conversation'};
  return {runId:run.runId,state:'completed',acknowledgedAt:new Date().toISOString(),nativeBinding:binding,error:null,
   result:{state:'completed',text:'B original after probe.',sessionId:binding.sessionId,turnId:'fixture-native-turn',nativeBinding:binding,error:null}};
 };
 const host=new SessionExecutionHost({instanceId:'lab-fixture',registry:new ActiveTurnDispatchRegistry({onStarted(){},onSettled(){}}),providers:{},defaultCwd:process.env.CONCIERGE_STATE_DIR!,wake(){},capabilityClient:client,thesaurusContext:async()=>''});
 const bClaim=claimNextQueuedTurn('lab-fixture')!;assert.equal(bClaim.session_id,second.id);
 const bExecution=host.run(bClaim);await providerEntered;
 const bInput=getAcceptedSessionInput(bClaim.accepted_input_id)!,bRun=nativeRunId(bClaim.turn_id);
 const bBefore=db.query('SELECT id,session_id,status,agent_text FROM turns WHERE id=?').get(bClaim.turn_id) as any;
 assert.equal(bBefore.status,'running');assert.equal(bBefore.agent_text,null);
 const bInvocation=invocations.find((value:any)=>value.sessionId===`concierge:${second.id}`);
 assert.equal(lab.requestFacts('comparison',bInvocation.requestId).independent,true);
 const aOriginal=[...records.values()].find(record=>record.facts.requestId===codingInvocation.requestId).facts;
 assert.equal(records.size,1,'only A has published; B actual transport is pending');
 const {startForegroundGateway}=await import('../src/foreground-gateway'),{agentTokenKey,mintAgentToken}=await import('../src/agent-run-tokens');
 const root=process.env.CONCIERGE_STATE_DIR!,ownerSocket=join(root,'pending-b-owner.sock');
 const privateOwner=Bun.serve({unix:ownerSocket,idleTimeout:0,fetch:async request=>(await owner.handle(request))??new Response(null,{status:404})});
 const portProbe=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('probe')});const port=portProbe.port!;await portProbe.stop(true);
 const key=agentTokenKey(root),bToken=mintAgentToken(key,{kind:'run',sessionId:second.id,turnId:bClaim.turn_id});
 const gateway=await startForegroundGateway({stateDir:root,ownerSocket,readWorkerEntry:join(import.meta.dir,'../src/native-read-worker.ts'),peer:null,agent:{hostname:'127.0.0.1',port,keyHex:key.toString('hex')}});
 const evidence:any[]=[];
 const runnerToken=mintAgentToken(key,{kind:'runner',runner:'fixture-runner'});
 const read=async(label:string,path:string,body?:unknown,token=bToken,source?:string)=>{
  const response=await fetch(`http://127.0.0.1:${port}/sessions/v1${path}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...(source?{'x-concierge-agent-source':source}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await response.text();const row={label,status:response.status,containsOriginal:text.includes(aOriginal.text),bytes:text.length};evidence.push(row);return {...row,text};
 };
 const trusted=async(path:string)=>{const response=await owner.handle(new Request(`http://localhost/sessions/v1${path}`));const text=await response!.text();return {status:response!.status,containsOriginal:text.includes(aOriginal.text)};};
 try{
  const address=(await import('../src/session-address')).sessionAddress(first);
  const paths:[string,string,unknown?][]=[['view','/lab/conversations/comparison'],['operation',`/operations/${encodeURIComponent(aOriginal.author.sourceInput)}`],['context','/context',{address}],
   ['history',`/sessions/concierge:${first.id}/history`],['events',`/events?sessionId=concierge:${first.id}&limit=1000`],['run',`/runs/${encodeURIComponent(aOriginal.author.sourceRun)}`],
   ['publication-verifier',`/lab/conversations/comparison/responses/${encodeURIComponent(aOriginal.requestId)}/${encodeURIComponent(aOriginal.eventId)}`]];
  for(const [label,path,body] of paths){
   const asRun=await read(label,path,body);assert.equal(asRun.containsOriginal,false,`independent B must not read A's answer through ${label}`);
   const asSourced=await read(label+':runner-with-B-source',path,body,runnerToken,`${bInput.id} ${bRun}`);assert.equal(asSourced.containsOriginal,false,`B's declared source must not read A through ${label}`);
   const asRunner=await read(label+':runner-without-source',path,body,runnerToken);assert.equal(asRunner.containsOriginal,false,`an unidentified agent must not read A through ${label}`);
  }
  for(const label of ['operation','run','publication-verifier'])assert.equal(evidence.find(row=>row.label===label).status,403,`${label} is refused as a whole entity`);
  const own=await read('own-operation',`/operations/${encodeURIComponent(bInput.id)}`);assert.equal(own.status,200,'B can read its own operation');
  const human=await trusted(`/operations/${encodeURIComponent(aOriginal.author.sourceInput)}`);assert.equal(human.status,200);assert.equal(human.containsOriginal,true,'a trusted human read keeps the exact original answer');
  const disclosure=await import('../src/lab-content-disclosure');
  let background:Promise<string>|null=null,insideDelivery:string|null=null;
  const scopedRequest=new Request('http://localhost/x',{headers:{'x-concierge-agent-principal':`run:${second.id}:${bClaim.turn_id}`}});
  const during=await disclosure.withContentReader(scopedRequest,async()=>{
   background=new Promise<string>(resolve=>setTimeout(()=>resolve(disclosure.contentReader().kind),50));
   disclosure.outsideContentReader(()=>{insideDelivery=disclosure.contentReader().kind;});
   return disclosure.contentReader().kind;});
  assert.equal(during,'actor','the request itself reads as B');
  assert.equal(insideDelivery,'trusted','a shared loop entered from the request never runs as B');
  assert.equal(await background,'trusted','work outliving the request no longer reads as B');
  // Nov 17 2026: the reply walk ran an unLIMITed .all(), so every budgeted agent read reaching it
  // (receipts at limit=40) answered 503 READ_BUDGET_EXCEEDED unbounded_collection.
  const {withStorageReadBudget}=await import('../src/storage-observation');
  const aInput=getAcceptedSessionInput(aOriginal.author.sourceInput)!;assert.ok(aInput.request_id,'the Lab answer carries its request');
  const unknownReader=new Request('http://localhost/x',{headers:{'x-concierge-agent-origin':'unknown'}});
  const budgeted=<T>(work:()=>T)=>disclosure.withContentReader(unknownReader,()=>withStorageReadBudget({maxCalls:500,maxRows:5000,maxResultBytes:8_000_000},work));
  assert.equal(budgeted(()=>disclosure.inputContentVisible(aInput)),false,'a budgeted unknown agent read is admitted and still withholds Lab content');
  try{budgeted(()=>disclosure.assertCommunicationContent(aInput.request_id!));}catch(error){assert.ok(error instanceof disclosure.LabDisclosureError,`communication check is admitted by the read budget: ${error}`);}
  // Overflow: an ordinary input (no Lab provenance of its own) whose request has more replies than the bound.
  const fakeRequest=`fixture-overflow-${randomUUID()}`,plainId=`fixture-plain-${randomUUID()}`;
  const columns=(db.query('PRAGMA table_info(session_inputs)').all() as {name:string}[]).map(column=>column.name);
  const clone=(id:string,kind:string)=>{const overrides:Record<string,string>={id:'?',action_id:'?1',kind:`'${kind}'`,scope:"'fixture'",source_input_id:'NULL',request_id:'?',payload_json:"'{}'"};
   db.query(`INSERT INTO session_inputs(${columns.join(',')}) SELECT ${columns.map(name=>overrides[name]??name).join(',')} FROM session_inputs WHERE id=?`).run(id,fakeRequest,aInput.id);};
  clone(plainId,'message');
  assert.equal(budgeted(()=>disclosure.inputContentVisible(getAcceptedSessionInput(plainId)!)),true,'an input with no Lab provenance stays visible');
  for(let index=0;index<=disclosure.DISCLOSURE_FANOUT_LIMIT;index++)clone(`fixture-overflow-reply-${index}`,'reply');
  assert.equal(budgeted(()=>disclosure.inputContentVisible(getAcceptedSessionInput(plainId)!)),false,'a reply set past the bound is treated as protected');
  assert.equal(disclosure.inputContentVisible(getAcceptedSessionInput(plainId)!),true,'a trusted reader is unaffected by the bound');
  db.query('DELETE FROM session_inputs WHERE request_id=?').run(fakeRequest);
  const bDuring=db.query('SELECT id,session_id,status,agent_text FROM turns WHERE id=?').get(bClaim.turn_id) as any;
  assert.deepEqual(bDuring,bBefore,'B remains in the same real active invocation throughout all reads');
  console.log(JSON.stringify({fixture:'lab-content-disclosure',independentReaderRestricted:true,wholeEntityRefusal:true,runnerSourceRestricted:true,unknownAgentRestricted:true,ownOperationReadable:true,humanOriginalReadable:true,readerScopeEndsWithRequest:true,budgetedDisclosureWalkAdmitted:true,replyOverflowProtected:true,activeInvocationUnchanged:true}));
 }finally{await gateway.stop(true);await privateOwner.stop(true);releaseProvider();await bExecution;}
}

if(process.argv.includes('--child')){await child();process.exit(0);}
else{const scratch=await mkdtemp(join(tmpdir(),'concierge-lab-conversations-'));try{console.log(JSON.stringify(await runFixtureChild({command:process.execPath,args:[import.meta.path,'--child'],env:{...process.env,CONCIERGE_STATE_DIR:scratch,CONCIERGE_CAPTURE_STATE_DIR:join(scratch,'capture'),CONCIERGE_TEST_MODE:'1',CONCIERGE_TEST_AUTHORIZATION:LAB_CONVERSATIONS_TEST_AUTHORIZATION,CONCIERGE_EXECUTION_HOSTS:'0',THINKERING_SESSION_CAPABILITY_SOCKET:join(scratch,'absent.sock'),CONCIERGE_THINKERING_CAPABILITY_URL:'',CONCIERGE_THINKERING_TOKEN_FILE:''},deadlineMs:60_000,fixture:'lab-content-disclosure'})));}finally{await rm(scratch,{recursive:true,force:true});}}
