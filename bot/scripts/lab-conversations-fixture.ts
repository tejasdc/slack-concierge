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
  prepare:async(choice:any)=>{
   const base=choice.sessionId?{choice,sessionId:Number(choice.sessionId.slice(10))}:{choice,provider:'codex',metadata:{summary:undefined,title:choice.label,purpose:'chat',model:choice.model,reasoningEffort:choice.reasoningEffort,cwd:process.env.CONCIERGE_STATE_DIR!,project:process.env.CONCIERGE_STATE_DIR!,origin:'native'}};
   return choice.materials?.length?{...base,materials:owner.materializeLabMaterials(choice.materials)}:base;
  },
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
 // The real admission step, not a recorded stand-in: a Codex voice carries an effort, and the run input
 // names it reasoning_effort. On 2026-11-17 the check read a field that does not exist and refused
 // every Codex voice with an effort (concierge:9996).
 {const {SessionExecutionHost}=await import('../src/session-execution-host'),{ActiveTurnDispatchRegistry}=await import('../src/turn-dispatch-seams');
  const admitting=new SessionExecutionHost({instanceId:'lab-fixture',registry:new ActiveTurnDispatchRegistry({onStarted(){},onSettled(){}}),providers:{},defaultCwd:process.env.CONCIERGE_STATE_DIR!,wake(){},thesaurusContext:async()=>''});
  const row=db.query('SELECT * FROM sessions WHERE id=?').get(first.id) as any,accepted=getAcceptedSessionInput(firstClaim.accepted_input_id)!;
  assert.equal(codingFacts.participant.reasoningEffort,'low','the Codex voice carries an explicit effort');
  (admitting as any).retainAdmission(firstClaim,accepted,row,{prompt:'admission check',cwd:process.env.CONCIERGE_STATE_DIR,additionalDirs:[],
   model:codingFacts.participant.model,reasoning_effort:codingFacts.participant.reasoningEffort},[]);
  const verified=db.query("SELECT payload_json FROM session_owner_events WHERE turn_id=? AND kind='lab_binding_verified'").get(firstClaim.turn_id) as {payload_json:string};
  assert.equal(JSON.parse(verified.payload_json).reasoningEffort,'low','the verified binding records the effort the run actually used');}
 finishTurn(firstClaim.turn_id,'done','Original coding answer, preserved exactly.');
 updateSessionMetadata(first.id,{model:'gpt-6.1-sol'});
 await lab.reconcile();assert.equal(records.size,1,'one original answer published even though its receipt was lost');
 const turnCount=db.query('SELECT count(*) AS n FROM turns').get()?.n;
 lab=new LabConversations(ports);(owner as any).labCoordinator=lab;await lab.reconcile();
 assert.equal(records.size,1);assert.equal(db.query('SELECT count(*) AS n FROM turns').get()?.n,turnCount,'restart and publication retry never replay provider execution');
 updateSessionMetadata(first.id,{model:'gpt-6-luna'});
 assert.throws(()=>lab.answerFacts('another-thread',invocations[0].requestId,invocations[0].eventId??'wrong'),/thread|conversation/i);
 assert.throws(()=>lab.answerFacts('comparison',invocations[0].requestId,'wrong-event'),/match|retained/i);

 // Exercise the actual queue, execution host and ChatGPT capability adapter. Only the
 // external provider transport is a local deterministic stand-in; no turn row is fabricated.
 const {SessionExecutionHost}=await import('../src/session-execution-host'),{ActiveTurnDispatchRegistry}=await import('../src/turn-dispatch-seams');
 const {SessionCapabilityClient}=await import('../src/session-capability-client');
 let providerStarts=0;
 const client=new SessionCapabilityClient({socketPath:join(process.env.CONCIERGE_STATE_DIR!,'unused.sock')});
 (client as any).start=async(run:any)=>{providerStarts++;const binding={accountScope:'fixture-account',sessionId:'fixture-chatgpt-conversation'};
  return {runId:run.runId,state:'completed',acknowledgedAt:new Date().toISOString(),nativeBinding:binding,error:null,
   result:{state:'completed',text:'Original tool-free ChatGPT answer.\nExact second line.',sessionId:binding.sessionId,turnId:'fixture-native-turn',nativeBinding:binding,error:null}};};
 const host=new SessionExecutionHost({instanceId:'lab-fixture',registry:new ActiveTurnDispatchRegistry({onStarted(){},onSettled(){}}),providers:{},defaultCwd:process.env.CONCIERGE_STATE_DIR!,wake(){},capabilityClient:client,thesaurusContext:async()=>''});
 const chatClaim=claimNextQueuedTurn('lab-fixture')!;assert.equal(chatClaim.session_id,second.id);
 await host.run(chatClaim);
 const actual=db.query('SELECT status,agent_text,provider_input_acknowledged_at FROM turns WHERE id=?').get(chatClaim.turn_id) as any;
 assert.equal(actual.status,'done',JSON.stringify(actual));assert.ok(actual.provider_input_acknowledged_at);assert.equal(actual.agent_text,'Original tool-free ChatGPT answer.\nExact second line.');
 await lab.reconcile();assert.equal(records.size,2);assert.equal(providerStarts,1);
 assert.equal([...records.values()].find(record=>record.facts.participant.sessionId===`concierge:${second.id}`).facts.text,actual.agent_text);

 const beforePassive=db.query('SELECT count(*) AS n FROM turns').get()?.n;
 lab.respond('comparison',{clientActionId:'passive',entryId:'passive-entry',targets:[]});await lab.reconcile();assert.equal(db.query('SELECT count(*) AS n FROM turns').get()?.n,beforePassive);
 const response={clientActionId:'follow-up',entryId:'follow-up-entry',targets:[`concierge:${first.id}`,`concierge:${second.id}`]};
 lab.respond('comparison',response);lab.respond('comparison',response);await lab.reconcile();
 const follow=lab.view('comparison').activations.find((value:any)=>value.actionId==='follow-up');
 for(const invocation of follow.invocations){const prompt=JSON.parse(getAcceptedSessionInput(invocation.inputId)!.payload_json).text;
  assert.ok(prompt.includes(`Only ${invocation.sessionId} can see`));const other=invocation.sessionId===`concierge:${first.id}`?second.id:first.id;assert.ok(!prompt.includes(`Only concierge:${other} can see`),'each reader keeps its own sealed context');}
 assert.equal(db.query('SELECT count(*) AS n FROM turns WHERE session_id=?').get(coordinator.id)?.n,0);
 // A changed bound model is refused before a selected activation can reach it.
 updateSessionMetadata(first.id,{model:'gpt-6.1-sol'});
 lab.respond('comparison',{clientActionId:'drift',entryId:'drift-entry',targets:[`concierge:${first.id}`]});await lab.reconcile();
 assert.equal(lab.view('comparison').activations.find((value:any)=>value.actionId==='drift').invocations[0].state,'refused');
 updateSessionMetadata(first.id,{model:'gpt-6-luna'});
 // Completion without acknowledgement or bytes is visibly unconfirmed, and is never replayed.
 lab.respond('comparison',{clientActionId:'empty-output',entryId:'empty-entry',targets:[`concierge:${second.id}`]});await lab.reconcile();
 const emptyInvocation=lab.view('comparison').activations.find((value:any)=>value.actionId==='empty-output').invocations[0],emptyInput=getAcceptedSessionInput(emptyInvocation.inputId)!;
 finishTurn(emptyInput.turn_id!,'done','');await lab.reconcile();
 assert.equal(lab.view('comparison').activations.find((value:any)=>value.actionId==='empty-output').invocations[0].state,'failed');
 assert.equal(inputs.queueTurnContinuation(emptyInput.turn_id!,{kind:'interrupted',detail:'fixture terminal interruption'}),null,'terminal Lab failure cannot create an unbound continuation after the invocation ends');
 // A source label, wrong reference or wrong digest cannot stand in for loaded evidence.
 const originalSources=ports.sources,ref={sourceId:'fixture:source',sourceVersion:'a'.repeat(64),branch:'main',eventId:'source-event'};
 ports.sources=async()=>[{reference:{...ref,eventId:'another-event'},text:'Wrong evidence',sha256:hash('Wrong evidence')}];
 await lab.create({...create,clientActionId:'wrong-source-create',thread:'wrong-source',participants:[{key:'source',label:'Source voice',sessionId:`concierge:${first.id}`,sources:[ref]}]});await lab.reconcile();
 assert.equal(lab.view('wrong-source').activations[0].invocations[0].state,'refused');ports.sources=originalSources;

 // Marker custody is tested through the real HTTP owner handler, including body-only
 // sources, exact header matches, mismatches and incomplete source pairs.
 const source=retainSessionInput({sessionId:coordinator.id,scope:'fixture',actionId:'agent-marker',kind:'input',origin:'human',payload:{text:'Fixture original human task'}}).input;
 const queued=enqueueSessionInput(source.id);db.query("UPDATE turns SET status='running',provider_admission_intended_at=CURRENT_TIMESTAMP WHERE id=?").run(queued.turn_id);
 const runId=nativeRunId(queued.turn_id!),agentSource={inputId:source.id,runId};
 const post=(body:any,header?:string)=>owner.handle(new Request('http://owner/sessions/v1/lab/conversations/comparison/respond',{method:'POST',headers:{'content-type':'application/json',...(header?{'x-concierge-verified-agent-source':header}:{})},body:JSON.stringify(body)}));
 assert.equal((await post({clientActionId:'body-marker',entryId:'marker',targets:[],agentSource}))?.status,202);
 assert.equal(db.query("SELECT origin FROM session_inputs WHERE scope='lab:activation:comparison' AND action_id='body-marker'").get()?.origin,'agent');
 assert.equal((await post({clientActionId:'header-marker',entryId:'marker',targets:[],agentSource},`${source.id} ${runId}`))?.status,202);
 assert.equal((await post({clientActionId:'mismatch-marker',entryId:'marker',targets:[],agentSource},`${source.id} wrong`))?.status,403);
 assert.equal((await post({clientActionId:'incomplete-marker',entryId:'marker',targets:[],agentSource:{inputId:source.id}}))?.status,403);
 assert.equal((await post({clientActionId:'signed-human',entryId:'marker',targets:[]}))?.status,202);
 assert.equal(db.query("SELECT origin FROM session_inputs WHERE scope='lab:activation:comparison' AND action_id='signed-human'").get()?.origin,'human');
 // Exercise the actual authenticated gateway and canonical read worker, not just
 // caller-supplied optional source headers on the owner handler.
 const {startForegroundGateway}=await import('../src/foreground-gateway'),{agentTokenKey,mintAgentToken}=await import('../src/agent-run-tokens');
 const root=process.env.CONCIERGE_STATE_DIR!,ownerSocket=join(root,'lab-fixture-gateway-owner.sock');
 const privateOwner=Bun.serve({unix:ownerSocket,idleTimeout:0,fetch:async request=>(await owner.handle(request))??new Response(null,{status:404})});
 const probe=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('fixture')});const port=probe.port!;await probe.stop(true);
 const key=agentTokenKey(root),runToken=mintAgentToken(key,{kind:'run',sessionId:coordinator.id,turnId:queued.turn_id!}),runnerToken=mintAgentToken(key,{kind:'runner',runner:'mac'});
 const gateway=await startForegroundGateway({stateDir:root,ownerSocket,readWorkerEntry:join(import.meta.dir,'../src/native-read-worker.ts'),peer:null,agent:{hostname:'127.0.0.1',port,keyHex:key.toString('hex')}});
 const network=(path:string,token:string,body?:unknown)=>fetch(`http://127.0.0.1:${port}/sessions/v1${path}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 try{
  for(const token of [runToken,runnerToken]){
   assert.equal((await network('/lab/conversations',token,{clientActionId:'missing-source-create'})).status,403);
   assert.equal((await network('/lab/conversations/comparison/respond',token,{clientActionId:'missing-source-response',entryId:'marker',targets:[]})).status,403);
   assert.equal((await network('/lab/conversations/comparison/participants',token,{clientActionId:'missing-source-roster',expectedRevision:1,add:[],remove:[]})).status,403);
  }
  const wrongRun=mintAgentToken(key,{kind:'run',sessionId:coordinator.id,turnId:queued.turn_id!+1000});
  assert.equal((await network('/lab/conversations/comparison/respond',wrongRun,{clientActionId:'wrong-token-run',entryId:'marker',targets:[],agentSource})).status,403);
  assert.equal((await network('/lab/conversations/comparison/respond',runToken,{clientActionId:'exact-token-run',entryId:'marker',targets:[],agentSource})).status,202);
  assert.equal(db.query("SELECT origin FROM session_inputs WHERE scope='lab:activation:comparison' AND action_id='exact-token-run'").get()?.origin,'agent');
  const original=[...records.values()].find(record=>record.facts.requestId===codingInvocation.requestId).facts;
  const outputPath=`/lab/conversations/comparison/responses/${encodeURIComponent(original.requestId)}/${encodeURIComponent(original.eventId)}`;
  assert.equal((await owner.handle(new Request(`http://owner/sessions/v1${outputPath}`)))?.status,200,'trusted publication service still obtains the exact original answer');
  for(const token of [runToken,runnerToken]){
   assert.equal((await network('/lab/conversations/comparison',token)).status,200,'the ordinary view can disclose public identities without granting answer bytes');
   assert.equal((await network(outputPath,token)).status,403,'an authenticated agent cannot use publication verification to bypass independent Lab visibility');
  }
  const markedRead=await owner.handle(new Request(`http://owner/sessions/v1${outputPath}`,{headers:{'x-concierge-verified-agent-source':`${source.id} ${runId}`}}));assert.equal(markedRead?.status,403);
  const catalogue=await (await network('/models',runToken)).json() as any;
  const aliases=await import('../src/aliases');
  assert.deepEqual(catalogue.chatgptThinkingLevels,aliases.CHATGPT_THINKING_LEVELS);
  assert.equal(catalogue.chatgptProvider.provider,'chatgpt');assert.equal(catalogue.chatgptProvider.model,aliases.chatgptSessionModel(undefined));assert.equal(catalogue.chatgptProvider.label,aliases.providerDisplayName('chatgpt'));
  for(const selector of catalogue.selectors){
   const parsed=aliases.parseProviderSelector(selector.key);assert.ok(parsed,`Every project-default option remains a valid alias: ${selector.key}`);
   const resolved=aliases.resolveProviderSelector(parsed);assert.equal(resolved.provider,selector.provider);assert.equal(resolved.model,selector.model);
  }
  assert.ok(!catalogue.selectors.some((selector:any)=>selector.provider==='chatgpt'),'Lab capability metadata cannot add unsupported choices to project defaults');
 }finally{await gateway.stop(true);await privateOwner.stop(true);}
 const oldLocate=(owner as any).locateProject;(owner as any).locateProject=async()=>({name:'fixture',path:'.',cwd:process.env.CONCIERGE_STATE_DIR!,runner:null});
 const topChoice={key:'astra',label:'Explicit human top model',provider:'codex',model:'gpt-6.2-astra',reasoningEffort:'medium',project:'fixture'};
 assert.equal((await (owner as any).prepareLabParticipant(topChoice)).metadata.model,'gpt-6.2-astra');
 await assert.rejects(()=>(owner as any).prepareLabParticipant(topChoice,{inputId:source.id,runId,sessionId:coordinator.id}),/escalation-reason/i);
 (owner as any).locateProject=oldLocate;
 const {parseRouterSessionsArgs}=await import('./router-sessions');
 const parsed=parseRouterSessionsArgs(['board','post','--thread','comparison','--response-target',`concierge:${second.id}`,'--source-input',source.id,'--source-run',runId,'--action-id','coordinator-routing','--','Coordinator attributed follow-up']) as any;
 assert.deepEqual(parsed.body.responseTargets,[`concierge:${second.id}`]);
 const coordinatorCommand=new SessionCommunicationCoordinator({owner,isOwnerAlive:()=>true,onError:error=>{throw error;},peers:{self:'mac',client:()=>({request:async(_method:string,_path:string,body:any)=>{assert.deepEqual(body.body.responseTargets,[`concierge:${second.id}`]);return {id:'coordinator-post-entry',address:'lab:comparison/99',duplicate:false,notify:[]};}})} as any});
 (coordinatorCommand as any).stopped=false;
 await coordinatorCommand.board(parsed.body);
 assert.ok(lab.view('comparison').activations.some((value:any)=>value.entryId==='coordinator-post-entry'),'the real coordinator command admits selected responses to its attributed question');

 // Roster changes retain immutable conditions for accepted work, while provisioning
 // a new voice alone never asks that model to run.
 const rosterA=make('codex','Original roster voice'),rosterB=make('codex','Other roster voice');
 const rosterCreate={clientActionId:'create-roster',thread:'roster',questionEntryId:'opening',participants:[{key:'original',label:'Original conditions',sessionId:`concierge:${rosterA.id}`,instructions},{key:'other',label:'Other conditions',sessionId:`concierge:${rosterB.id}`} ]};
 await lab.create(rosterCreate);await lab.reconcile();
 const originalInvocation=lab.view('roster').activations[0].invocations.find((value:any)=>value.sessionId===`concierge:${rosterA.id}`);
 const excluded=(db.query('SELECT id FROM sessions WHERE id<>?').all(rosterA.id) as {id:number}[]).map(row=>row.id);
 const originalClaim=claimNextQueuedTurn('lab-fixture',Date.now(),excluded)!;assert.equal(originalClaim.session_id,rosterA.id);
 markTurnProviderAdmissionIntended(originalClaim.turn_id,'lab-fixture',originalClaim.dispatch_attempt);acknowledgeTurnProviderInput(originalClaim.turn_id,'lab-fixture',originalClaim.dispatch_attempt,[]);
 const originalMember=lab.requestFacts('roster',originalInvocation.requestId).participant;
 db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({admission:{provider:'codex',model:originalMember.model,bindingGeneration:originalMember.generation,inputId:originalClaim.accepted_input_id,runId:nativeRunId(originalClaim.turn_id)}}),originalClaim.accepted_input_id);
 inputs.recordSessionEvent({eventId:`fixture-roster-binding:${originalClaim.turn_id}`,sessionId:rosterA.id,inputId:originalClaim.accepted_input_id,turnId:originalClaim.turn_id,kind:'lab_binding_verified',payload:Object.fromEntries(['provider','model','reasoningEffort','project','projectPath','generation'].map(key=>[key,originalMember[key]]))});
 const oldResponse={clientActionId:'old-roster-selection',entryId:'old-selected-entry',targets:[`concierge:${rosterA.id}`]};lab.respond('roster',oldResponse);
 const rosterChange={clientActionId:'replace-roster-voice',expectedRevision:1,add:[{key:'newcomer',label:'Newcomer with sources',provider:'codex',model:'gpt-6-luna',reasoningEffort:'low',project:'fixture',instructions:'Read the exact selected source.\nKeep this condition verbatim.',sources:[ref]}],remove:[`concierge:${rosterA.id}`]};
 const beforeRosterTurns=db.query('SELECT count(*) AS n FROM turns').get()?.n,beforeRosterSessions=db.query('SELECT count(*) AS n FROM sessions').get()?.n;
 const [changed,repeated]=await Promise.all([lab.participants('roster',rosterChange),lab.participants('roster',rosterChange)]);
 assert.equal(changed.membershipRevision,2);assert.equal(changed.change.revision,2);assert.equal(changed.coordinatorSessionId,`concierge:${coordinator.id}`);
 assert.equal(db.query('SELECT count(*) AS n FROM turns').get()?.n,beforeRosterTurns,'adding a voice starts no provider turn');
 assert.equal(db.query('SELECT count(*) AS n FROM sessions').get()?.n,Number(beforeRosterSessions)+1);
 assert.equal(repeated.change.inputId,changed.change.inputId);assert.equal(repeated.change.duplicate,true);
 assert.equal(db.query('SELECT count(*) AS n FROM sessions').get()?.n,Number(beforeRosterSessions)+1,'duplicate roster update never provisions twice');
 await assert.rejects(()=>lab.participants('roster',{...rosterChange,clientActionId:'stale-update'}),/membership changed/i);
 assert.throws(()=>lab.respond('roster',{clientActionId:'removed-future-selection',entryId:'new-entry',targets:[`concierge:${rosterA.id}`]}),/bound|participant/i);
 lab.respond('roster',oldResponse);
 assert.equal(lab.requestFacts('roster',originalInvocation.requestId).membershipRevision,1,'accepted work keeps its old roster after removal');
 assert.equal(lab.requestFacts('roster',originalInvocation.requestId).participant.instructions,instructions);
 finishTurn(originalClaim.turn_id,'done','Full original answer from the removed running voice.\nIts second line is preserved.');await lab.reconcile();
 const originalRecord=[...records.values()].find(record=>record.facts.requestId===originalInvocation.requestId);assert.ok(originalRecord,JSON.stringify(lab.view('roster').activations));
 assert.equal(originalRecord.facts.membershipRevision,1);assert.equal(originalRecord.facts.participant.label,'Original conditions');assert.ok(originalRecord.facts.text.endsWith('Its second line is preserved.'));
 assert.ok(lab.membership('roster',1).participants.some((member:any)=>member.sessionId===`concierge:${rosterA.id}`));
 assert.ok(!lab.membership('roster',2).participants.some((member:any)=>member.sessionId===`concierge:${rosterA.id}`));
 const newcomer=changed.change.add[0],newcomerNumber=Number(newcomer.slice(10));
 assert.equal(db.query('SELECT count(*) AS n FROM turns WHERE session_id=?').get(newcomerNumber)?.n,0,'journal membership acknowledgement remains passive');
 lab.respond('roster',{clientActionId:'ask-newcomer',entryId:'newcomer-entry',targets:[newcomer]});await lab.reconcile();
 const newcomerActivation=lab.view('roster').activations.find((value:any)=>value.actionId==='ask-newcomer');assert.equal(newcomerActivation.independent,false);assert.equal(newcomerActivation.membershipRevision,2);
 const newcomerInput=getAcceptedSessionInput(newcomerActivation.invocations[0].inputId)!,newcomerPrompt=JSON.parse(newcomerInput.payload_json).text;
 assert.ok(newcomerPrompt.includes('An intervening shared discussion before the newcomer.'));assert.ok(newcomerPrompt.includes(rosterChange.add[0].instructions));assert.ok(newcomerPrompt.includes('Actual selected source material.'));
 assert.ok(newcomerPrompt.includes('roughly 60 to 120 words'));assert.ok(newcomerPrompt.includes('Go longer only when Tejas asks for depth'));
 updateSessionMetadata(newcomerNumber,{model:'gpt-6.1-sol'});
 lab.respond('roster',{clientActionId:'newcomer-drift',entryId:'newcomer-drift-entry',targets:[newcomer]});await lab.reconcile();
 assert.equal(lab.view('roster').activations.find((value:any)=>value.actionId==='newcomer-drift').invocations[0].state,'refused');
 assert.equal(db.query('SELECT status FROM turns WHERE id=?').get(newcomerInput.turn_id)?.status,'cancelled','a refused queued invocation cannot run invisibly after its model is restored');
 updateSessionMetadata(newcomerNumber,{model:'gpt-6-luna'});
 const readded=await lab.participants('roster',{clientActionId:'readd-original',expectedRevision:2,add:[{key:'original',label:'Changed future conditions',sessionId:`concierge:${rosterA.id}`,instructions:'Future condition only.'}],remove:[]});
 assert.equal(readded.membershipRevision,3);assert.equal(lab.requestFacts('roster',originalInvocation.requestId).participant.instructions,instructions,'re-adding a session never rewrites its accepted prior conditions');
 const oldUpdateRetry=await lab.participants('roster',rosterChange);assert.equal(oldUpdateRetry.membershipRevision,3);assert.equal(oldUpdateRetry.change.revision,2,'duplicate action returns its original applied revision before checking a stale precondition');
 await assert.rejects(()=>lab.participants('roster',{clientActionId:'remove-coordinator',expectedRevision:3,add:[],remove:[`concierge:${coordinator.id}`]}),/coordinator remains stable/i);

 // Materials: exact file bytes frozen into each participant's binding at selection.
 {
  const {mkdirSync,writeFileSync,rmSync,symlinkSync}=await import('node:fs');
  const stateDir=process.env.CONCIERGE_STATE_DIR!,project=join(stateDir,'materials-project');
  mkdirSync(join(project,'.git'),{recursive:true});writeFileSync(join(project,'AGENTS.md'),'fixture project');
  const skillText='# Skill\nExact bytes ✓ kept verbatim.\n',refText='Reference line one\nline two\n';
  const skillPath=join(project,'SKILL.md'),refPath=join(project,'reference.md');writeFileSync(skillPath,skillText);writeFileSync(refPath,refText);
  const matSkill={path:skillPath,sha256:hash(skillText)},matRef={path:refPath,sha256:hash(refText)};
  const matCoding=make('codex','material coding voice'),matChat=make('chatgpt','material tool-free ChatGPT voice');
  const codingId=`concierge:${matCoding.id}`,chatId=`concierge:${matChat.id}`;
  const matCreate={clientActionId:'create-materials',thread:'materials',questionEntryId:'opening',participants:[{key:'coding',label:'Coding voice',sessionId:codingId,materials:[matSkill,matRef]},{key:'chat',label:'ChatGPT voice',sessionId:chatId,materials:[matSkill]}]};
  const refusal=async(participants:any[],code:string,status:number,action:string)=>{
   const before=db.query("SELECT count(*) AS n FROM session_inputs WHERE scope LIKE 'lab:%'").get()?.n;
   await assert.rejects(()=>lab.create({...matCreate,clientActionId:action,thread:action,participants}),(error:any)=>error.code===code&&error.status===status,action);
   assert.equal(db.query("SELECT count(*) AS n FROM session_inputs WHERE scope LIKE 'lab:%'").get()?.n,before,`${action}: nothing retained`);
  };
  const member={key:'coding',label:'Coding voice',sessionId:codingId};
  await refusal([{...member,materials:[{path:skillPath,sha256:'0'.repeat(64)}]}],'LAB_MATERIAL_MISMATCH',409,'bad-hash');
  const outside=join(stateDir,'outside-project.md');writeFileSync(outside,'private');
  await refusal([{...member,materials:[{path:outside,sha256:hash('private')}]}],'LAB_MATERIAL_UNAVAILABLE',409,'outside-project');
  symlinkSync(outside,join(project,'escape.md'));
  await refusal([{...member,materials:[{path:join(project,'escape.md'),sha256:hash('private')}]}],'LAB_MATERIAL_UNAVAILABLE',409,'symlink-escape');
  await refusal([{...member,materials:[{path:join(project,'missing.md'),sha256:'1'.repeat(64)}]}],'LAB_MATERIAL_UNAVAILABLE',409,'missing-file');
  const big=Buffer.alloc(1_048_577,97);writeFileSync(join(project,'big.md'),big);
  await refusal([{...member,materials:[{path:join(project,'big.md'),sha256:createHash('sha256').update(big).digest('hex')}]}],'LAB_MATERIAL_UNAVAILABLE',409,'too-large');
  const binary=Buffer.from([0xff,0xfe,0x00]);writeFileSync(join(project,'binary.bin'),binary);
  await refusal([{...member,materials:[{path:join(project,'binary.bin'),sha256:createHash('sha256').update(binary).digest('hex')}]}],'LAB_MATERIAL_UNAVAILABLE',409,'not-utf8');
  await refusal([{...member,materials:[{path:'relative.md',sha256:matSkill.sha256}]}],'LAB_MATERIAL_UNAVAILABLE',400,'relative-path');
  await refusal([{...member,materials:[{...matSkill,extra:true}]}],'LAB_CONVERSATION_REFUSED',400,'extra-field');
  await refusal([member,{...member,label:'Second voice'}],'LAB_PARTICIPANT_KEY_REPEATED',400,'repeated-key');
  await refusal([{...member,materials:Array.from({length:33},(_,index)=>({path:join(project,`n${index}.md`),sha256:matSkill.sha256}))}],'LAB_CONVERSATION_REFUSED',400,'too-many');
  assert.equal((await (owner as any).prepareLabParticipant({key:'wired',label:'Wired',sessionId:codingId,materials:[matSkill]})).materials[0].text,skillText,'the owner preparation path freezes the exact text');
  const offerSnapshots=process.env.CONCIERGE_LAB_OFFER_SNAPSHOTS!,offerFile=join(offerSnapshots,'offer-1','SKILL.md'),candidateFile=join(offerSnapshots,'..','candidates','offer-2.md');
  mkdirSync(join(offerSnapshots,'offer-1'),{recursive:true});mkdirSync(join(offerSnapshots,'..','candidates'),{recursive:true});
  writeFileSync(offerFile,'Offer snapshot skill.'+String.fromCharCode(10));writeFileSync(candidateFile,'Unselected candidate.');
  assert.equal((await (owner as any).prepareLabParticipant({key:'offer',label:'Offer',sessionId:codingId,materials:[{path:offerFile,sha256:hash('Offer snapshot skill.'+String.fromCharCode(10))}]})).materials[0].text,'Offer snapshot skill.'+String.fromCharCode(10),'an expertise offer snapshot outside every project is frozen exactly');
  await refusal([{...member,materials:[{path:candidateFile,sha256:hash('Unselected candidate.')}]}],'LAB_MATERIAL_UNAVAILABLE',409,'offer-candidate-outside-snapshots');

  await lab.create(matCreate);await lab.create(matCreate);
  assert.equal(db.query("SELECT count(*) AS n FROM session_inputs WHERE kind='lab-conversation' AND action_id='materials'").get()?.n,1,'same materials retry is a duplicate');
  await assert.rejects(()=>lab.create({...matCreate,participants:[{...matCreate.participants[0],materials:[{path:skillPath,sha256:hash('another version')},matRef]},matCreate.participants[1]]}),/conflict/i);
  assert.ok(!JSON.stringify(lab.view('materials')).includes('kept verbatim'),'the public view carries paths and digests, never the bytes');
  await lab.reconcile();
  const promptOf=(thread:string,actionId:string,sessionId:string)=>{
   const invocation=lab.view(thread).activations.find((value:any)=>value.actionId===actionId).invocations.find((value:any)=>value.sessionId===sessionId);
   return JSON.parse(getAcceptedSessionInput(invocation.inputId)!.payload_json).text as string;
  };
  const firstActivation=lab.view('materials').activations[0].actionId;
  for(const [sessionId,texts] of [[codingId,[skillText,refText]],[chatId,[skillText]]] as const){
   const prompt=promptOf('materials',firstActivation,sessionId);
   for(const text of texts)assert.ok(prompt.includes(`sha256 ${hash(text)}), verbatim:\n${text}`),'exact bytes and hash in the invocation prompt');
   assert.ok(prompt.indexOf(skillText)<prompt.indexOf('Visible Lab discussion:'));
  }
  assert.ok(!promptOf('materials',firstActivation,chatId).includes(refText),'a participant receives only its own materials');

  writeFileSync(skillPath,'Overwritten after selection.');rmSync(refPath);
  lab.respond('materials',{clientActionId:'materials-follow-up',entryId:'materials-follow-up-entry',targets:[codingId,chatId]});await lab.reconcile();
  for(const [sessionId,texts] of [[codingId,[skillText,refText]],[chatId,[skillText]]] as const){
   const prompt=promptOf('materials','materials-follow-up',sessionId);
   for(const text of texts)assert.ok(prompt.includes(`verbatim:\n${text}`),'a later invocation still carries the frozen bytes');
   assert.ok(!prompt.includes('Overwritten after selection.'));
  }

  const lateText='Added later, frozen when added.\n',latePath=join(project,'late.md');writeFileSync(latePath,lateText);
  const lateRequest={path:latePath,sha256:hash(lateText)};
  const add=(clientActionId:string,materials:any[])=>({clientActionId,expectedRevision:1,add:[{key:'late',label:'Late voice',provider:'codex',model:'gpt-6-luna',reasoningEffort:'low',project:'fixture',materials}],remove:[]});
  await assert.rejects(()=>lab.participants('materials',add('late-bad',[{path:latePath,sha256:'2'.repeat(64)}])),(error:any)=>error.code==='LAB_MATERIAL_MISMATCH');
  const lateAdd=add('late-add',[lateRequest]);
  const added=await lab.participants('materials',lateAdd);
  assert.equal((await lab.participants('materials',lateAdd)).change.duplicate,true);
  await assert.rejects(()=>lab.participants('materials',add('late-add',[{path:latePath,sha256:hash('different')}])),/conflict/i);
  writeFileSync(latePath,'Changed after the voice was added.');
  lab.respond('materials',{clientActionId:'late-ask',entryId:'late-ask-entry',targets:[added.change.add[0]]});await lab.reconcile();
  const latePrompt=promptOf('materials','late-ask',added.change.add[0]);
  assert.ok(latePrompt.includes(`verbatim:\n${lateText}`)&&!latePrompt.includes('Changed after the voice was added.'),'a roster add freezes at add time');
 }

 // An unresolved context for one voice cannot hold its ready sibling or the ordinary
 // communication loop. Stop aborts observation and never starts the blocked voice.
 blockSession=`concierge:${first.id}`;lab.respond('comparison',{clientActionId:'blocked-context',entryId:'blocked-entry',targets:[`concierge:${first.id}`,`concierge:${second.id}`]});
 const communication=new SessionCommunicationCoordinator({owner,isOwnerAlive:()=>true,onError:error=>{throw error;}});owner.communication=communication;
 communication.start();await new Promise(resolve=>setTimeout(resolve,40));
 const blocked=lab.view('comparison').activations.find((value:any)=>value.actionId==='blocked-context');
 assert.equal(blocked.invocations.find((value:any)=>value.sessionId===`concierge:${second.id}`).state,'accepted','ready sibling progresses while another context waits');
 const ordinary=make('codex','ordinary recipient');const ordinaryInput=retainSessionInput({sessionId:ordinary.id,scope:'fixture',actionId:'ordinary',kind:'input',origin:'human',payload:{text:'An ordinary input'}}).input;owner.dispatch(ordinaryInput);
 communication.wake();await new Promise(resolve=>setTimeout(resolve,20));assert.ok(getAcceptedSessionInput(ordinaryInput.id)!.turn_id);
 const beforeStop=stoppedDispatches;await communication.stop();releaseBlock();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(stoppedDispatches,beforeStop,'no new dispatch happens after stop');
 for(let index=0;index<70;index++)lab.respond('comparison',{clientActionId:`descriptor-${index}`,entryId:`entry-${index}`,targets:[`concierge:${second.id}`]});
 const last=lab.view('comparison').activations[0].invocations[0];assert.equal(lab.requestFacts('comparison',last.requestId).requestId,last.requestId,'an exact descriptor beyond 64 pending activations remains addressable');
 const plan=db.query("EXPLAIN QUERY PLAN SELECT rowid FROM session_inputs INDEXED BY session_inputs_lab_history WHERE kind='lab-activation' AND scope=? AND rowid<? ORDER BY rowid DESC LIMIT 21").all('lab:activation:comparison',Number.MAX_SAFE_INTEGER) as any[];
 assert.ok(plan.some(row=>row.detail.includes('session_inputs_lab_history')));assert.ok(!plan.some(row=>row.detail.includes('TEMP B-TREE')));
 console.log(JSON.stringify({fixture:'lab-conversations',idempotentCreate:true,sourceCorrectMarkers:true,authenticatedGatewayActorCustody:true,agentOutputVerifierRefused:true,providerRestartNoReplay:true,exactOriginalOutput:true,realChatGptHostAdapter:true,perReaderContext:true,passiveNoWake:true,bindingDriftRefused:true,noUnboundTerminalContinuation:true,nonblockingAndStop:true,revisionedRoster:true,removeRunningRetainsOriginal:true,addVoicePassiveUntilSelected:true,newVoiceSharedContext:true,frozenMaterials:true}));
}

if(process.argv.includes('--child')){await child();process.exit(0);}
else{const scratch=await mkdtemp(join(tmpdir(),'concierge-lab-conversations-'));try{console.log(JSON.stringify(await runFixtureChild({command:process.execPath,args:[import.meta.path,'--child'],env:{...process.env,CONCIERGE_STATE_DIR:scratch,CONCIERGE_CAPTURE_STATE_DIR:join(scratch,'capture'),CONCIERGE_TEST_MODE:'1',CONCIERGE_TEST_AUTHORIZATION:LAB_CONVERSATIONS_TEST_AUTHORIZATION,CONCIERGE_LAB_OFFER_SNAPSHOTS:join(scratch,'offer-material','snapshots'),CONCIERGE_EXECUTION_HOSTS:'0',THINKERING_SESSION_CAPABILITY_SOCKET:join(scratch,'absent.sock'),CONCIERGE_THINKERING_CAPABILITY_URL:'',CONCIERGE_THINKERING_TOKEN_FILE:''},deadlineMs:60_000,fixture:'lab-conversations'})));}finally{await rm(scratch,{recursive:true,force:true});}}
