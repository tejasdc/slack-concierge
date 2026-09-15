import {afterEach,beforeEach,expect,test} from 'bun:test';
import {randomUUID,createHash} from 'node:crypto';
import {db,claimNextQueuedTurn,getSessionById,createOrGetSession,upsertChannel,acquireSessionTurn} from '../src/state';
import {bindSessionProvider,createNativeSession,getAcceptedSessionInput,nativeRunId,recordSessionEvent,stablePayload} from '../src/session-inputs';
import {SessionOwner,resolveSessionAddress} from '../src/session-owner';
import {SessionExecutionHost} from '../src/session-execution-host';
import {SessionCommunicationCoordinator} from '../src/session-communication';
import {searchRouterThreads} from '../src/router-search';
import {ActiveTurnDispatchRegistry} from '../src/turn-dispatch-seams';
import {acquireDatabaseTestLock} from './db-lock';
import type {AgentProvider} from '../src/providers';

let unlock:()=>void;
let communication:SessionCommunicationCoordinator;
let host:SessionExecutionHost;
let calls:Parameters<AgentProvider['run']>[0][];
let completions:(()=>void)[];
let outputs:string[];
const clear=()=>{
  for(const table of ['session_owner_events','session_communication_events','session_communication_requests','session_inputs','turn_dependencies','routed_requests','routed_input_events','deployment_drain','comparison_requests','fork_requests','slack_thread_statuses','slack_user_input_claims','turn_steering_messages','turn_delivery_chunks','turns','sessions','channels'])db.query(`DELETE FROM ${table}`).run();
};
beforeEach(async()=>{
  unlock=await acquireDatabaseTestLock();clear();calls=[];completions=[];outputs=[];
  const provider:AgentProvider={id:'codex',fork:async()=>{throw new Error('unsupported');},run:async input=>{
    calls.push(input);input.onProviderThreadStarted?.(input.sessionUUID??`native-${calls.length}`);input.onProviderTurnStarted?.(`turn-${calls.length}`);input.onInputAcknowledged?.();
    input.onSteeringReady?.(async message=>{outputs.push(message.text);});
    await new Promise<void>(resolve=>completions.push(resolve));
    input.onProviderTerminal?.();
    return {text:'retained uncorrelated output',sessionUUID:input.sessionUUID??`native-${calls.indexOf(input)+1}`,toolsUsed:[],actualModel:'fixture'};
  }};
  host=new SessionExecutionHost({instanceId:'native-owner',registry:new ActiveTurnDispatchRegistry({onStarted:()=>{},onSettled:()=>{}}),providers:{codex:provider},defaultCwd:'/tmp',wake:()=>{}});
  const forbidden=()=>{throw new Error('Slack adapter must be absent');};
  communication=new SessionCommunicationCoordinator({owner:host.owner,routed:{submit:forbidden,result:forbidden,recoverRequest:forbidden,recoverUnsentReturn:forbidden} as any,isOwnerAlive:()=>true,onError:error=>{throw error;}});
  host.owner.communication=communication;communication.start();await communication.idle();
});
afterEach(async()=>{for(const complete of completions)complete();await communication.stop();clear();unlock();});
const eventually=async(predicate:()=>boolean)=>{for(let i=0;i<200;i++){if(predicate())return;await Bun.sleep(5);}throw new Error('Expected owner transition did not occur');};

test('public import fixture preserves content custody without forwarding surface authority or starting a turn',async()=>{
  const fixtures=await Bun.file(new URL('../../docs/contracts/session-owner-v1/surface.json',import.meta.url)).json();
  const fixture=fixtures.cases.find((value:any)=>value.name==='import-does-not-replay-workspace');
  const body=fixture.request.body, imported:any[]=[];
  host.owner.runtime.sources={search:async()=>({}),context:async()=>({}),import:async value=>{imported.push(value);return {sources:[]};}};
  const request=(value:unknown)=>host.owner.handle(new Request(`http://owner${fixture.request.path}`,{method:'POST',body:JSON.stringify(value)}));
  const response=await request(body);
  expect(response!.status).toBe(200);
  expect(await response!.json()).toEqual({sessions:[],sources:[]});
  expect(imported).toEqual([{name:body.name,content:body.content,scope:body.scope}]);
  expect((await request({...body,clientActionId:undefined}))!.status).toBe(400);
  expect((await request({...body,sourceRunId:'forged'}))!.status).toBe(400);
  expect(imported).toHaveLength(1);
  expect(calls).toHaveLength(0);
  expect(db.query('SELECT count(*) AS n FROM session_inputs').get()).toEqual({n:0});
});

test('explicit source refresh invokes one existing reader pass without accepting session work',async()=>{
  let refreshes=0;
  const refresh={refresh:[{accountScope:'fixture',state:'partial',inventoryComplete:true,discovered:689,saved:207,indexed:207,failed:0,reportedTotal:689,lastAttemptAt:null,lastCompleteAt:null,reason:'Rate limited; remaining history is partial.'}]};
  const owner=new SessionOwner({available:()=>true,wake:()=>{throw new Error('Refresh must not wake execution');},steer:()=>false,stop:async()=>false,
    sources:{search:async()=>({}),context:async()=>({}),import:async()=>({}),refresh:async()=>{refreshes++;return refresh;}}},'/tmp');
  const post=(body:unknown)=>owner.handle(new Request('http://owner/sessions/v1/sources/refresh',{method:'POST',body:JSON.stringify(body)}));
  expect(refreshes).toBe(0);
  const response=await post({provider:'chatgpt'});expect(response!.status).toBe(200);expect(await response!.json()).toEqual(refresh);
  expect((await post({provider:'codex'}))!.status).toBe(400);
  expect((await post({provider:'chatgpt',url:'https://caller.invalid'}))!.status).toBe(400);
  expect(refreshes).toBe(1);
  expect(db.query('SELECT count(*) AS n FROM session_inputs').get()).toEqual({n:0});
  expect(db.query('SELECT count(*) AS n FROM turns').get()).toEqual({n:0});
  const unavailable=await host.owner.handle(new Request('http://owner/sessions/v1/sources/refresh',{method:'POST',body:JSON.stringify({provider:'chatgpt'})}));
  expect(unavailable!.status).toBe(503);
});
function create(text='native original') {return host.owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text}});}
async function start() {const claim=claimNextQueuedTurn('native-owner')!;expect(claim).not.toBeNull();const task=host.run(claim);await eventually(()=>calls.length===completions.length&&!!db.query('SELECT provider_input_acknowledged_at FROM turns WHERE id=?').get(claim.turn_id)?.provider_input_acknowledged_at);return {claim,task,input:getAcceptedSessionInput(claim.accepted_input_id!)!};}

test('surface creation and retries are atomic without Slack, controls preserve exact human delivery intent',async()=>{
  const action=randomUUID(),body={clientActionId:action,provider:'codex',purpose:'chat',firstInput:{text:'native first input'}};
  const first=host.owner.create(body),retry=host.owner.create({...body,firstInput:{text:'native first input'}});
  expect(retry.operation.operationId).toBe(first.operation.operationId);
  expect(retry.session.id).toBe(first.session.id);
  expect(db.query('SELECT count(*) AS n FROM turns').get()).toEqual({n:1});
  expect(db.query('SELECT count(*) AS n FROM slack_user_input_claims').get()).toEqual({n:0});
  expect(getSessionById(Number(first.session.id.slice(10)))).toMatchObject({slack_channel_id:null,slack_thread_ts:null});
  expect(()=>host.owner.create({...body,firstInput:{text:'changed'}})).toThrow('conflict');
  const active=await start();
  const input={clientActionId:randomUUID(),text:'steer exact run',delivery:'steer',expectedRunId:first.operation.runId};
  const steered=host.owner.submit(first.session.id,input);
  await eventually(()=>outputs.some(text=>text.startsWith('steer exact run')));
  completions[0]!();await active.task;
  expect(host.owner.submit(first.session.id,input).operation.operationId).toBe(steered.operation.operationId);
  expect(()=>host.owner.submit(first.session.id,{...input,clientActionId:randomUUID()})).toThrow('changed');
  expect(()=>host.owner.submit(first.session.id,{clientActionId:randomUUID(),text:'bad',expectedRunId:first.operation.runId})).toThrow('requires');
  expect(host.owner.events().filter(event=>event.kind==='run').at(-1)?.payload.run.state).toBe('completed');
});

test('new native and old Slack-born sessions exchange exact partial/final answers both directions without Slack',async()=>{
  upsertChannel({slack_channel_id:'COLD',slack_channel_name:'old',group_name:null,name:'old',vault_path:'/tmp',code_path:'/tmp',provider_default:'codex'});
  const old=createOrGetSession('COLD','1700000000.123456','codex');bindSessionProvider(old.id,'codex','old-native-uuid');
  const created=create(),newRun=await start();
  const source={input_id:created.operation.inputId!,run_id:created.operation.runId!};
  const ask=communication.ask({source,action_id:'question-one',address:host.owner.view(getSessionById(old.id)!).address,text:'first precise question'});
  expect(db.query('SELECT source_input_id,target_input_id,outcome FROM session_communication_requests WHERE request_id=?').get(ask.request_id)).toMatchObject({source_input_id:source.input_id,target_input_id:`request:${ask.request_id}`,outcome:null});
  await communication.idle();
  const oldRun=await start();
  expect(calls[1]!.sessionUUID).toBe('old-native-uuid');
  const oldSource={input_id:oldRun.input.id,run_id:nativeRunId(oldRun.claim.turn_id)};
  communication.reply({source:oldSource,action_id:'partial',request_id:ask.request_id,text:'partial one',final:false});
  communication.reply({source:oldSource,action_id:'final',request_id:ask.request_id,text:'final one',final:true});
  await communication.idle();await eventually(()=>outputs.some(text=>text.includes('final one')));await communication.idle();
  expect(communication.inspect(ask.request_id)).toMatchObject({outcome:'answered'});
  expect(communication.inspect(ask.request_id).events.every(event=>event.status==='received')).toBeTrue();
  const nativeSearch=await host.owner.search({query:'native original'});
  expect(searchRouterThreads(db,{beforeTs:(Date.now()/1000).toFixed(6),concepts:['native original']}).complete).toBeTrue();
  expect(nativeSearch.results.some(result=>result.session.id===created.session.id)).toBeTrue();
  const reverse=communication.ask({source:oldSource,action_id:'reverse',address:created.session.address,text:'reverse precise question'});
  await communication.idle();await eventually(()=>outputs.some(text=>text.includes(reverse.request_id)));
  communication.reply({source,action_id:'reverse-partial',request_id:reverse.request_id,text:'reverse partial',final:false});
  communication.reply({source,action_id:'reverse-final',request_id:reverse.request_id,text:'reverse final',final:true});
  await communication.idle();await eventually(()=>outputs.some(text=>text.includes('reverse final')));
  expect(communication.inspect(reverse.request_id).outcome).toBe('answered');
  expect(db.query('SELECT count(*) AS n FROM routed_requests').get()).toEqual({n:0});
  expect(db.query('SELECT count(*) AS n FROM slack_user_input_claims').get()).toEqual({n:0});
  expect(getSessionById(old.id)).toMatchObject({agent_session_uuid:'old-native-uuid',slack_channel_id:'COLD',slack_thread_ts:'1700000000.123456'});
  completions.forEach(complete=>complete());await Promise.all([newRun.task,oldRun.task]);
});

test('several questions in one run settle independently and ending leaves other questions unconfirmed',async()=>{
  const requester=create('requester'),requesterRun=await start(),target=create('target'),targetRun=await start();
  const source={input_id:requester.operation.inputId!,run_id:requester.operation.runId!};
  const questions=['a','b','c'].map(action_id=>communication.ask({source,action_id,address:target.session.address,text:`question ${action_id}`}));
  await communication.idle();await eventually(()=>outputs.filter(text=>text.includes('Session request')).length===3);
  communication.reply({source:{input_id:target.operation.inputId!,run_id:target.operation.runId!},action_id:'answer-b',request_id:questions[1]!.request_id,text:'only b',final:true});
  await communication.idle();
  expect(questions.map(question=>communication.inspect(question.request_id).outcome)).toEqual([null,'answered',null]);
  completions[1]!();await targetRun.task;await communication.idle();
  expect(questions.map(question=>communication.inspect(question.request_id).outcome)).toEqual(['unanswered','answered','unanswered']);
  expect(communication.inspect(questions[0]!.request_id).result).toMatchObject({text:'The recipient turn ended without a confirmed answer to this request. Its retained output is referenced below.',output:{turn_id:targetRun.claim.turn_id}});
  completions[0]!();await requesterRun.task;
});

test('trusted workspace revision text reaches initial and steered prompts while receipts retain the human message',async()=>{
  const selection=[{objectId:'note-a',revision:'revision-1'}],text='The exact selected note contents.';
  const context=[{kind:'selection',reference:selection[0],text,sha256:createHash('sha256').update(text).digest('hex')}];
  const body={clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text:'Review my note',selection,context}};
  expect(()=>host.owner.create({...body,firstInput:{text:'Review my note',selection}})).toThrow('context text');
  expect(()=>host.owner.create({...body,firstInput:{...body.firstInput,context:[{...context[0],text:'changed'}]}})).toThrow('hash');
  const created=host.owner.create(body),active=await start();
  expect(created.operation.text).toBe('Review my note');
  expect(calls[0]!.prompt).toContain(text);
  expect(()=>host.owner.create({...body,firstInput:{...body.firstInput,text:'Different human question'}})).toThrow('conflict');
  const steered=host.owner.submit(created.session.id,{clientActionId:randomUUID(),text:'Use this same revision',selection,context,delivery:'steer',expectedRunId:created.operation.runId});
  await eventually(()=>outputs.some(prompt=>prompt.includes('Use this same revision')&&prompt.includes(text)));
  expect(steered.operation.text).toBe('Use this same revision');
  completions[0]!();await active.task;
});

test('explicit ChatGPT bind retains human intent before verification and adopts one exact binding without sending',async()=>{
  const source={id:'archive:chatgpt',version:'a'.repeat(64),branch:'original-leaf'},native=createNativeSession('chatgpt',{origin:'imported',source});
  const reference={accountScope:'verified-browser-account',sessionId:'native-conversation',anchor:{sourceId:source.id,sourceVersion:source.version,branch:source.branch,messageId:'native-message',textHash:'b'.repeat(64)}};
  let checks=0;
  const owner=new SessionOwner({available:()=>true,wake:()=>{},steer:()=>false,stop:async()=>false,bind:async(session,operation,binding)=>{
    checks++;
    expect(owner.receipt(getAcceptedSessionInput(operation.id)!)).toMatchObject({kind:'bind',origin:'human',state:'running',admission:{bindingGeneration:1,reference}});
    expect(owner.get(`concierge:${session.id}`).session).toMatchObject({nativeBinding:null,capabilities:{send:false}});
    return {binding};
  }},'/tmp');
  const id=`concierge:${native.id}`,before=owner.get(id).session.address,body={clientActionId:randomUUID(),reference};
  expect(owner.get(id).session.capabilities.send).toBeFalse();
  const bound=await owner.bind(id,body);
  expect(bound.session.policyLabel).toBeNull();
  expect(bound).toMatchObject({session:{id,origin:'imported',bindingGeneration:2,nativeBinding:reference,interactionPolicy:'standard',capabilities:{send:true}},operation:{kind:'bind',state:'completed'}});
  expect(()=>resolveSessionAddress(before)).toThrow('changed');
  expect((await owner.bind(id,body)).operation.operationId).toBe(bound.operation.operationId);
  expect(checks).toBe(1);
  await expect(owner.bind(id,{...body,reference:{...reference,sessionId:'other'}})).rejects.toThrow('conflict');
  expect(db.query('SELECT count(*) AS n FROM turns').get()).toEqual({n:0});
});

test('mismatched ChatGPT verification fails visibly without enabling Send or repeating the bind',async()=>{
  const source={id:'source',version:'c'.repeat(64),branch:'leaf'},native=createNativeSession('chatgpt',{origin:'imported',source});
  const reference={accountScope:'account',sessionId:'original',anchor:{sourceId:source.id,sourceVersion:source.version,branch:source.branch,messageId:'message',textHash:'d'.repeat(64)}};
  let checks=0;
  const owner=new SessionOwner({available:()=>true,wake:()=>{},steer:()=>false,stop:async()=>false,bind:async()=>{checks++;return {binding:{...reference,sessionId:'wrong'}};}},'/tmp');
  const body={clientActionId:randomUUID(),reference},id=`concierge:${native.id}`;
  expect(await owner.bind(id,body)).toMatchObject({session:{nativeBinding:null,bindingGeneration:1,capabilities:{send:false}},operation:{state:'failed',error:{code:'BINDING_CHANGED'}}});
  await owner.bind(id,body);expect(checks).toBe(1);
});

test('discovery finds retained assistant dialogue using exact latest message evidence and explicit tool inclusion',async()=>{
  const created=create('unrelated opening'),operation=getAcceptedSessionInput(created.operation.operationId)!;
  const retain=(eventId:string,message:any)=>recordSessionEvent({eventId,sessionId:operation.session_id,inputId:operation.id,turnId:operation.turn_id,kind:'message',payload:{message}});
  const message={id:'exact-assistant-message',role:'assistant',content:'obsolete proposal',tool:null,phase:'commentary'};
  retain('old-message-version',message);
  retain('new-message-version',{...message,content:'Use immutable apple receipts.'});
  retain('tool-message',{id:'exact-tool-message',role:'tool',content:'orange tool details',tool:'shell',phase:null,detailKey:'exact-tool-message'});
  const found=await host.owner.search({query:'immutable apple'});
  expect(found.results).toHaveLength(1);
  expect(found.results[0]).toMatchObject({session:{id:created.session.id},evidence:[{sourceId:`native:${operation.session_id}`,eventId:message.id,role:'assistant',text:'Use immutable apple receipts.'}]});
  expect(found.results[0]!.evidence[0].textHash).toBe(createHash('sha256').update('Use immutable apple receipts.').digest('hex'));
  expect((await host.owner.search({query:'obsolete proposal'})).results).toHaveLength(0);
  expect((await host.owner.search({query:'orange tool'})).results).toHaveLength(0);
  expect((await host.owner.search({query:'orange tool',includeTools:true})).results[0]).toMatchObject({session:{id:created.session.id},evidence:[{eventId:'exact-tool-message',role:'tool',detailKey:'exact-tool-message'}]});
});

test('exact context resolves accepted create and follow-up input evidence without treating operation IDs as native message IDs',async()=>{
  const created=create('Opening exact café\nsecond line'),followup=host.owner.submit(created.session.id,{clientActionId:randomUUID(),text:'Later exact accepted dialogue'});
  let reads=0;host.owner.runtime.history=async()=>{reads++;throw new Error('Accepted input context must use retained input bytes');};
  for(const [query,operation] of [['Opening exact café',created.operation],['Later exact accepted',followup.operation]] as const) {
    const found=await host.owner.search({query}),reference=found.results[0]!.evidence[0];
    expect(reference).toMatchObject({sourceId:`input:${operation.operationId}`,eventId:operation.operationId,role:'user',text:operation.text});
    const context=await host.owner.context({address:created.session.address,sourceId:reference.sourceId,sourceVersion:reference.sourceVersion,eventId:reference.eventId});
    expect(context.evidence).toContainEqual(reference);
    expect(context.hasMore).toBe(false);
    await expect(host.owner.context({address:created.session.address,sourceId:reference.sourceId,sourceVersion:'0'.repeat(64),eventId:reference.eventId})).rejects.toMatchObject({status:409});
    await expect(host.owner.context({address:created.session.address,sourceId:reference.sourceId,eventId:'another-operation'})).rejects.toMatchObject({status:409});
    const other=create('unrelated session');
    await expect(host.owner.context({address:other.session.address,sourceId:reference.sourceId,eventId:reference.eventId})).rejects.toMatchObject({status:409});
  }
  expect(reads).toBe(0);expect(calls).toHaveLength(0);
});

test('exact context preserves retained native message revisions and source identity without a provider history dependency',async()=>{
  const created=create('unrelated initial input'),operation=getAcceptedSessionInput(created.operation.operationId)!;
  let reads=0;host.owner.runtime.history=async()=>{reads++;throw new Error('The retained message remains available without native history');};
  const message={id:'native-answer',role:'assistant',content:'Exact remembered decision',tool:null,phase:'commentary'};
  recordSessionEvent({eventId:'answer-v1',sessionId:operation.session_id,inputId:operation.id,turnId:operation.turn_id,kind:'message',payload:{message}});
  const found=await host.owner.search({query:'remembered decision'}),reference=found.results[0]!.evidence[0];
  recordSessionEvent({eventId:'answer-v2',sessionId:operation.session_id,inputId:operation.id,turnId:operation.turn_id,kind:'message',payload:{message:{...message,content:'Corrected native decision'}}});
  const context=await host.owner.context({address:created.session.address,sourceId:reference.sourceId,sourceVersion:reference.sourceVersion,eventId:reference.eventId});
  expect(context.evidence).toContainEqual(reference);
  const current=await host.owner.context({address:created.session.address,sourceId:reference.sourceId,eventId:reference.eventId});
  expect(current.evidence.find((item:any)=>item.eventId===message.id)?.text).toBe('Corrected native decision');
  await expect(host.owner.context({address:created.session.address,sourceId:reference.sourceId,sourceVersion:'0'.repeat(64),eventId:reference.eventId})).rejects.toMatchObject({status:409});
  await expect(host.owner.context({address:created.session.address,sourceId:'native:999999',eventId:reference.eventId})).rejects.toMatchObject({status:409});
  expect(reads).toBe(0);expect(calls).toHaveLength(0);
});

test('native historical context follows opaque cursors only until the exact versioned event is found',async()=>{
  const created=create('not indexed historical context');
  const message={id:'old-native-event',role:'assistant',content:'Older decision beyond the first page',tool:null,phase:null};
  const version=createHash('sha256').update(stablePayload(message)).digest('hex');
  const cursors:Array<string|null>=[];
  host.owner.runtime.history=async(session,cursor,limit)=>{
    expect(session.id).toBe(Number(created.session.id.slice(10)));expect(limit).toBe(100);cursors.push(cursor);
    if(cursor===null)return {messages:[{...message,id:'new-event',content:'Recent unrelated text'}],nextCursor:'opaque/provider cursor?page=2'};
    if(cursor==='opaque/provider cursor?page=2')return {messages:[message],nextCursor:'older/unneeded-page'};
    throw new Error('Exact context must stop reading after its matching page');
  };
  const context=await host.owner.context({address:created.session.address,sourceId:`native:${created.session.id.slice(10)}`,sourceVersion:version,eventId:message.id});
  expect(cursors).toEqual([null,'opaque/provider cursor?page=2']);
  expect(context.evidence).toContainEqual({sessionId:created.session.id,sourceId:`native:${created.session.id.slice(10)}`,sourceVersion:version,eventId:message.id,ordinal:1,role:'assistant',locator:message.id,textHash:createHash('sha256').update(message.content).digest('hex'),text:message.content});
  expect(context.hasMore).toBe(true);expect(calls).toHaveLength(0);
  await expect(host.owner.context({address:created.session.address,sourceId:`native:${created.session.id.slice(10)}`,sourceVersion:'0'.repeat(64),eventId:message.id})).rejects.toMatchObject({status:409});
});

test('historical context reports missing events and non-advancing cursors instead of substituting a page or looping',async()=>{
  const created=create();let reads=0;
  host.owner.runtime.history=async()=>{reads++;return {messages:[],nextCursor:null};};
  await expect(host.owner.context({address:created.session.address,eventId:'missing-native-event'})).rejects.toMatchObject({status:404});
  expect(reads).toBe(1);reads=0;
  host.owner.runtime.history=async()=>{reads++;return {messages:[],nextCursor:'repeated'};};
  await expect(host.owner.context({address:created.session.address,eventId:'missing-native-event'})).rejects.toMatchObject({status:502});
  expect(reads).toBe(2);expect(calls).toHaveLength(0);
});

test('reconstructed child context distinguishes its accepted/native dialogue from its retained archive source',async()=>{
  const source={id:'archive-parent',version:'a'.repeat(64),branch:'exact-parent-branch'};
  const child=createNativeSession('codex',{origin:'reconstructed',source,interactionPolicy:'consultation-only'});
  const address=host.owner.view(child).address;
  const accepted=host.owner.submit(`concierge:${child.id}`,{clientActionId:randomUUID(),text:'Current reconstructed child dialogue'});
  const message={id:'child-answer',role:'assistant',content:'Current child reasoning',tool:null,phase:null};
  recordSessionEvent({eventId:'child-answer-event',sessionId:child.id,inputId:accepted.operation.inputId,turnId:Number(db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(accepted.operation.inputId)?.turn_id),kind:'message',payload:{message}});
  let sourceReads=0;host.owner.runtime.sources={search:async()=>({sources:[],matches:[],complete:true}),import:async()=>({}),context:async pin=>{sourceReads++;expect(pin).toMatchObject({sourceId:source.id,sourceVersion:source.version,branch:source.branch,eventId:'parent-event'});return {evidence:[{sourceId:source.id,sourceVersion:source.version,eventId:'parent-event',role:'user',text:'Original source'}],hasMore:false};}};
  for(const query of ['reconstructed child dialogue','Current child reasoning']) {
    const found=await host.owner.search({query}),reference=found.results[0]!.evidence[0];
    const context=await host.owner.context({address,sourceId:reference.sourceId,sourceVersion:reference.sourceVersion,eventId:reference.eventId});
    expect(context.evidence).toContainEqual(reference);
  }
  expect(sourceReads).toBe(0);
  expect((await host.owner.context({address,sourceId:source.id,sourceVersion:source.version,eventId:'parent-event'})).evidence[0]).toMatchObject({sourceId:source.id,sessionId:`concierge:${child.id}`});
  expect(sourceReads).toBe(1);expect(calls).toHaveLength(0);
});

test('explicit standard policy retains its normal label and fork capability',()=>{
  const session=createNativeSession('codex',{});bindSessionProvider(session.id,'codex','standard-native-session');
  const owner=new SessionOwner({available:()=>true,wake:()=>{},steer:()=>false,stop:async()=>false,fork:()=>{},capabilities:()=>({fork:true})},'/tmp');
  db.query('UPDATE sessions SET native_metadata_json=? WHERE id=?').run(JSON.stringify({interactionPolicy:'standard'}),session.id);
  expect(owner.view(getSessionById(session.id)!)).toMatchObject({interactionPolicy:'standard',policyLabel:null,capabilities:{fork:true,reason:null}});
  db.query('UPDATE sessions SET native_metadata_json=? WHERE id=?').run(JSON.stringify({interactionPolicy:'consultation-only'}),session.id);
  expect(owner.view(getSessionById(session.id)!)).toMatchObject({interactionPolicy:'consultation-only',policyLabel:'Consultation only — information, no actions',capabilities:{fork:false}});
});

test('an archive-only import cannot relabel its historical records as native context',async()=>{
  const source={id:'source-only-archive',version:'a'.repeat(64),branch:'original-branch'};
  const session=createNativeSession('codex',{origin:'imported',source,interactionPolicy:'consultation-only'});
  let historyReads=0;
  host.owner.runtime.sources={search:async()=>({sources:[],matches:[],complete:true}),import:async()=>({}),context:async()=>({evidence:[],hasMore:false}),history:async()=>{historyReads++;return {messages:[],nextCursor:null};}};
  await expect(host.owner.context({address:host.owner.view(session).address,sourceId:`native:${session.id}`,eventId:'archive-event'})).rejects.toMatchObject({status:409,code:'CAPABILITY_UNAVAILABLE'});
  expect(historyReads).toBe(0);expect(calls).toHaveLength(0);
});

test('routing search evidence resolves only through its exact current Slack thread binding',async()=>{
  upsertChannel({slack_channel_id:'CCONTEXT',slack_channel_name:'context',group_name:null,name:'context',vault_path:'/tmp',code_path:'/tmp',provider_default:'codex'});
  const session=createOrGetSession('CCONTEXT','1700000000.123456','codex');
  acquireSessionTurn(session.id,'1700000000.123456','Exact routing historical evidence',null,undefined,'1700000000.123456');
  host.owner.runtime.history=async()=>{throw new Error('Routing evidence must not become native history');};
  const found=await host.owner.search({query:'Exact routing historical'}),reference=found.results[0]!.evidence.find((item:any)=>item.corpus==='routing_evidence');
  expect(reference).toMatchObject({role:'user'});
  const address=host.owner.view(getSessionById(session.id)!).address;
  const context=await host.owner.context({address,sourceId:reference.sourceId,eventId:reference.eventId,sourceVersion:reference.sourceVersion});
  expect(context.evidence[0]).toMatchObject({sourceId:reference.sourceId,sourceVersion:null,eventId:'1700000000.123456',role:'user',text:'Exact routing historical evidence',corpus:'routing_evidence'});
  await expect(host.owner.context({address,sourceId:reference.sourceId,eventId:reference.eventId,sourceVersion:'a'.repeat(64)})).rejects.toMatchObject({status:409});
  const other=create('different session');
  await expect(host.owner.context({address:other.session.address,sourceId:reference.sourceId,eventId:reference.eventId})).rejects.toMatchObject({status:409});
  expect(calls).toHaveLength(0);
});
