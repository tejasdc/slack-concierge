import {afterEach,beforeEach,expect,test} from 'bun:test';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {db,claimNextQueuedTurn,getSessionById,registerProcessInstance,markTurnDelivering,markTurnProviderAdmissionIntended,interruptOrphanedTurn,finishTurn,createOrGetSession,upsertChannel} from '../src/state';
import {bindSessionProvider,createNativeSession,getAcceptedSessionInput,nativeRunId,updateSessionMetadata} from '../src/session-inputs';
import {SessionOwner} from '../src/session-owner';
import {SessionExecutionHost} from '../src/session-execution-host';
import {SessionCapabilityClient} from '../src/session-capability-client';
import {ActiveTurnDispatchRegistry} from '../src/turn-dispatch-seams';
import {currentProcessIdentity} from '../src/runtime-identity';
import {acquireDatabaseTestLock} from './db-lock';
import type {AgentProvider} from '../src/providers';

let unlock:()=>void,host:SessionExecutionHost,provider:AgentProvider;
let runs:Parameters<AgentProvider['run']>[0][],forks:Parameters<AgentProvider['fork']>[0][];
const clear=()=>{for(const table of ['session_owner_events','session_communication_events','session_communication_requests','session_inputs','session_attachments','turn_dependencies','routed_requests','routed_input_events','deployment_drain','comparison_requests','fork_requests','slack_thread_statuses','slack_user_input_claims','turn_steering_messages','turn_delivery_chunks','turns','sessions','channels','process_instances'])db.query(`DELETE FROM ${table}`).run();};
const registry=()=>new ActiveTurnDispatchRegistry({onStarted:()=>{},onSettled:()=>{}});
const capability=()=>new SessionCapabilityClient({socketPath:'/tmp/never-open-native-capability.sock'});
beforeEach(async()=>{
  unlock=await acquireDatabaseTestLock();clear();runs=[];forks=[];
  provider={id:'codex',capabilities:{send:true,stop:true,steer:true,consultation:true,history:true,fork:true,forkBoundary:'turn',consultationFork:false,reason:null},
    history:async()=>({messages:[{id:'message-before',role:'assistant',content:'native history',tool:null,phase:null,turnId:'cutoff'}],nextCursor:null}),
    fork:async input=>{forks.push(input);return {text:'native child',sessionUUID:'distinct-child',toolsUsed:[]};},
    run:async input=>{runs.push(input);input.onProviderThreadStarted?.(input.sessionUUID??'native-thread');input.onProviderTurnStarted?.('native-turn');input.onInputAcknowledged?.();input.onProviderTerminal?.();return {text:'',sessionUUID:input.sessionUUID??'native-thread',providerTurnId:'native-turn',toolsUsed:[]};}};
  host=new SessionExecutionHost({instanceId:'owner',registry:registry(),providers:{codex:provider},defaultCwd:'/tmp',wake:()=>{}});
});
afterEach(()=>{clear();unlock();});
async function request(owner:SessionOwner,path:string,body?:unknown){const response=await owner.handle(new Request(`http://owner/sessions/v1/${path}`,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));expect(response).not.toBeNull();return {status:response!.status,body:await response!.json()};}
function bound(){const session=createNativeSession('codex',{title:'Original',cwd:'/tmp',project:'original-project'});bindSessionProvider(session.id,'codex','original-thread');return getSessionById(session.id)!;}
async function execute(){const claim=claimNextQueuedTurn('owner')!;expect(claim).not.toBeNull();await host.run(claim);return claim;}
function uncertainChat(client:SessionCapabilityClient){
  host=new SessionExecutionHost({instanceId:'owner',registry:registry(),providers:{},capabilityClient:client,defaultCwd:'/tmp',wake:()=>{}});
  const created=host.owner.create({clientActionId:randomUUID(),provider:'chatgpt',purpose:'chat',firstInput:{text:'only once'}});
  registerProcessInstance('dead',4321,'previous-boot','5678');
  const claim=claimNextQueuedTurn('dead')!,operation=getAcceptedSessionInput(claim.accepted_input_id!)!;
  const admission={provider:'chatgpt',purpose:'chat',inputId:operation.id,runId:nativeRunId(claim.turn_id),bindingGeneration:1,admittedAt:'2026-09-15T00:00:00.000Z',promptHash:createHash('sha256').update('only once').digest('hex'),model:null,attachments:[],policy:'standard',nativeBinding:null};
  db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({admission}),operation.id);
  markTurnProviderAdmissionIntended(claim.turn_id,'dead',claim.dispatch_attempt);
  interruptOrphanedTurn(claim.turn_id,'dead','effect uncertain');
  return {created,claim,operation,admission};
}

test('real HTTP wrappers preserve first acceptance, duplicate receipt identity and exact input metadata',async()=>{
  const evidence={sourceId:'archive-source',sourceVersion:'a'.repeat(64),eventId:'message-one'};
  const body={clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text:'human text',evidence}};
  const first=await request(host.owner,'sessions',body),duplicate=await request(host.owner,'sessions',body);
  expect(first.status).toBe(202);expect(duplicate.status).toBe(200);expect(duplicate.body).toEqual(first.body);
  expect(first.body.operation.request.firstInput.evidence).toEqual(evidence);
  expect((await request(host.owner,'sessions',{...body,firstInput:{text:'changed',evidence}})).status).toBe(409);
  const id=first.body.session.id;
  expect((await request(host.owner,`sessions/${id}/inputs`,{clientActionId:randomUUID(),text:'bad',evidence:[evidence]})).status).toBe(400);
  expect((await request(host.owner,'sessions',{...body,clientActionId:randomUUID(),firstInput:{text:'bad',evidence:[evidence]}})).status).toBe(400);
  expect(getSessionById(Number(id.slice(10)))?.agent_session_uuid).toBeNull();
  const claim=await execute();
  expect((await request(host.owner,`operations/${first.body.operation.operationId}`)).body).toMatchObject({state:'completed',text:'human text',result:''});
  expect((await request(host.owner,`runs/${first.body.operation.runId}`)).body.run).toMatchObject({id:first.body.operation.runId,state:'completed',turnId:'native-turn'});
  expect(db.query('SELECT slack_user_msg_ts,slack_reply_thread_ts FROM turns WHERE id=?').get(claim.turn_id)).toEqual({slack_user_msg_ts:null,slack_reply_thread_ts:null});
  expect(db.query('SELECT count(*) AS n FROM slack_user_input_claims').get()).toEqual({n:0});
});

test('attachment custody downloads exact bytes and initial plus steering attachments reach the same provider',async()=>{
  const bytes=Buffer.from('Exact attachment bytes\n\u0000'),upload=await request(host.owner,'attachments',{clientActionId:randomUUID(),name:'notes.txt',contentType:'text/plain',base64:bytes.toString('base64')});
  expect(upload.status).toBe(200);
  expect((await request(host.owner,`attachments/${upload.body.attachment.id}`)).body).toEqual({name:'notes.txt',contentType:'text/plain',base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')});
  let ready!:()=>void,finish!:()=>void;const started=new Promise<void>(resolve=>ready=resolve),completed=new Promise<void>(resolve=>finish=resolve);
  const sent:string[]=[];
  provider.run=async input=>{runs.push(input);input.onProviderThreadStarted?.('native-thread');input.onInputAcknowledged?.();input.onSteeringReady?.(async message=>{sent.push(message.text);const path=JSON.parse(message.text).content.split(': ').at(-1)!;expect(await readFile(path)).toEqual(bytes);finish();});
    expect(await readFile(JSON.parse(input.prompt).content.split(': ').at(-1)!)).toEqual(bytes);ready();await completed;input.onProviderTerminal?.();return {text:'',sessionUUID:'native-thread',toolsUsed:[]};};
  const created=host.owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text:'Inspect initial',attachments:[upload.body.attachment.id]}}),claim=claimNextQueuedTurn('owner')!,task=host.run(claim);
  await started;
  host.owner.submit(created.session.id,{clientActionId:randomUUID(),text:'Inspect steering',attachments:[upload.body.attachment.id],delivery:'steer',expectedRunId:created.operation.runId});
  await task;
  expect(sent).toHaveLength(1);expect(sent[0]).toContain('Inspect steering');
  expect(db.query('SELECT unreplayable_attachment_count,status FROM turn_steering_messages WHERE turn_id=?').get(claim.turn_id)).toMatchObject({unreplayable_attachment_count:1,status:'sent'});
  db.query('UPDATE session_attachments SET bytes=? WHERE id=?').run(Buffer.from('changed'),upload.body.attachment.id);
  expect((await request(host.owner,`attachments/${upload.body.attachment.id}`)).status).toBe(409);
});

test('exact native fork uses the parent FIFO and creates one distinct child without a model input or parent rebind',async()=>{
  const parent=bound(),id=`concierge:${parent.id}`,body={clientActionId:randomUUID(),boundary:'cutoff',provider:'codex'};
  const first=await request(host.owner,`sessions/${id}/forks`,body);
  expect(first.status).toBe(202);expect(first.body.operation).toMatchObject({kind:'fork',state:'queued',inputId:null,runId:null,text:null,request:null,admission:null,childSessionId:null});
  const queued=host.owner.submit(id,{clientActionId:randomUUID(),text:'after fork',delivery:'queue'});
  const claim=await execute();
  expect(runs).toHaveLength(0);expect(forks).toHaveLength(1);
  expect(forks[0]).toMatchObject({sessionUUID:'original-thread',lastTurnId:'cutoff',interactionPolicy:'standard',threadSource:`concierge-native-fork:${first.body.operation.operationId}`});
  const duplicate=await request(host.owner,`sessions/${id}/forks`,body);
  expect(duplicate.status).toBe(200);expect(duplicate.body.operation).toMatchObject({state:'completed',request:null,result:null});
  const child=host.owner.get(duplicate.body.operation.childSessionId).session;
  expect(child).toMatchObject({runtimeThreadId:'distinct-child',project:'original-project',lineage:{parentId:id,kind:'forked_from',boundary:'cutoff'}});
  expect(getSessionById(parent.id)).toMatchObject({agent_session_uuid:'original-thread',binding_generation:1});
  expect(db.query('SELECT status,delivery_status FROM turns WHERE id=?').get(claim.turn_id)).toEqual({status:'done',delivery_status:'delivered'});
  expect(nativeRunId(claimNextQueuedTurn('owner')!.turn_id)).toBe(queued.operation.runId);
  expect(forks).toHaveLength(1);
});

test('fork refuses unsupported, cross-provider, restricted and absent exact boundaries before any native copy',async()=>{
  const parent=bound(),id=`concierge:${parent.id}`;
  expect((await request(host.owner,`sessions/${id}/forks`,{clientActionId:randomUUID(),boundary:'cutoff',provider:'claude-code'})).status).toBe(409);
  updateSessionMetadata(parent.id,{interactionPolicy:'consultation-only'});
  expect((await request(host.owner,`sessions/${id}/forks`,{clientActionId:randomUUID(),boundary:'cutoff'})).status).toBe(409);
  expect(host.owner.get(id).session.capabilities).toMatchObject({fork:false,attachments:[]});
  const unrestricted=bound();
  host.owner.fork(`concierge:${unrestricted.id}`,{clientActionId:randomUUID(),boundary:'missing-cutoff'});
  await execute();
  expect(forks).toHaveLength(0);expect(runs).toHaveLength(0);
  expect(host.owner.get(`concierge:${unrestricted.id}`).operations[0]).toMatchObject({state:'failed'});
});

test('uncertain fork is never copied again; exact retained provenance can reconcile one child idempotently',async()=>{
  const parent=bound(),id=`concierge:${parent.id}`;
  provider.fork=async input=>{forks.push(input);throw new Error('connection lost after copy');};
  host.options.findForks=async pin=>{expect(pin).toMatchObject({parentSessionUUID:'original-thread',boundary:'cutoff',bindingGeneration:1});return ['proven-child'];};
  const accepted=host.owner.fork(id,{clientActionId:randomUUID(),boundary:'cutoff'}),claim=await execute();
  expect(host.owner.get(id).operations[0].state).toBe('uncertain');
  expect(claimNextQueuedTurn('owner')).toBeNull();
  const body={clientActionId:randomUUID(),operationId:accepted.operation.operationId};
  expect((await request(host.owner,`sessions/${id}/reconcile`,body)).status).toBe(202);
  expect((await request(host.owner,`sessions/${id}/reconcile`,body)).status).toBe(200);
  expect(host.owner.get(id).operations[0]).toMatchObject({state:'completed',childSessionId:expect.any(String)});
  expect(getSessionById(parent.id)?.agent_session_uuid).toBe('original-thread');
  expect(db.query('SELECT status FROM turns WHERE id=?').get(claim.turn_id)).toEqual({status:'done'});
  expect(forks).toHaveLength(1);expect(runs).toHaveLength(0);
});

test.each([[],['child-a','child-b']])('fork reconciliation preserves uncertainty when provenance yields %j',async matches=>{
  const parent=bound(),id=`concierge:${parent.id}`;
  provider.fork=async()=>{throw new Error('unknown copy');};host.options.findForks=async()=>matches;
  const accepted=host.owner.fork(id,{clientActionId:randomUUID(),boundary:'cutoff'});await execute();
  await host.owner.reconcile(id,{clientActionId:randomUUID(),operationId:accepted.operation.operationId});
  expect(host.owner.receipt(getAcceptedSessionInput(accepted.operation.operationId)!)).toMatchObject({state:'uncertain',childSessionId:null});
  expect(db.query('SELECT count(*) AS n FROM sessions').get()).toEqual({n:1});
});

test('queued cancellation wins only its own unadmitted input and duplicate controls cannot cancel siblings',async()=>{
  const parent=bound(),id=`concierge:${parent.id}`,one=host.owner.submit(id,{clientActionId:randomUUID(),text:'cancel me'}),two=host.owner.submit(id,{clientActionId:randomUUID(),text:'keep me'});
  const body={clientActionId:randomUUID()},path=`operations/${one.operation.operationId}/cancel`;
  expect((await request(host.owner,path,body))).toMatchObject({status:202,body:{operation:{operationId:one.operation.operationId,state:'canceled'}}});
  expect((await request(host.owner,path,body)).status).toBe(200);
  const claim=claimNextQueuedTurn('owner')!;expect(nativeRunId(claim.turn_id)).toBe(two.operation.runId);
  expect((await request(host.owner,`operations/${two.operation.operationId}/cancel`,{clientActionId:randomUUID()}))).toMatchObject({status:409,body:{error:{code:'OPERATION_NOT_CANCELABLE'}}});
  expect(db.query('SELECT status FROM turns WHERE id=?').get(claim.turn_id)).toEqual({status:'running'});
});

test('Stop records exact intent once and completion requires native turn cancellation, not interrupt acknowledgement',async()=>{
  const parent=bound(),id=`concierge:${parent.id}`,accepted=host.owner.submit(id,{clientActionId:randomUUID(),text:'working'}),claim=claimNextQueuedTurn('owner')!;
  let stops=0;
  const owner=new SessionOwner({wake:()=>{},available:()=>true,steer:()=>false,stop:async(sessionId,turnId)=>{stops++;expect([sessionId,turnId]).toEqual([parent.id,claim.turn_id]);expect(db.query('SELECT stop_requested_at FROM turns WHERE id=?').get(turnId)?.stop_requested_at).not.toBeNull();return true;}},'/tmp');
  const body={clientActionId:randomUUID(),runId:accepted.operation.runId},first=await request(owner,`sessions/${id}/stop`,body);
  expect(first).toMatchObject({status:202,body:{operation:{kind:'stop',state:'running',runId:accepted.operation.runId,request:null}}});
  expect((await request(owner,`sessions/${id}/stop`,body)).status).toBe(200);expect(stops).toBe(1);
  finishTurn(claim.turn_id,'cancelled','Stopped');
  expect((await request(owner,`operations/${first.body.operation.operationId}`)).body.state).toBe('completed');
  expect(stops).toBe(1);
});

test.each(['completed','failed','canceled'] as const)('ChatGPT reconcile settles proven %s with empty output, exact old admission and no repeated start',async state=>{
  const client=capability(),fixture=uncertainChat(client);let inspections=0;
  client.reconcile=async run=>{inspections++;expect(run.runId).toBe(fixture.admission.runId);return {runId:run.runId,state,acknowledgedAt:'2026-09-15T00:01:00.000Z',nativeBinding:{accountScope:'account',sessionId:'proven-native'},result:{state,sessionId:'proven-native',turnId:'exact-native-turn',text:'',error:state==='failed'?'native failure':null,nativeBinding:{accountScope:'account',sessionId:'proven-native'}},error:null};};
  client.createChatGptProvider=()=>{throw new Error('Reconciliation must never start or run a provider.');};
  db.query("UPDATE sessions SET status='archived' WHERE id=?").run(fixture.claim.session_id);
  const body={clientActionId:randomUUID(),operationId:fixture.operation.id};
  expect((await request(host.owner,`sessions/${fixture.created.session.id}/reconcile`,body)).body.operation.state).toBe('completed');
  const receipt=host.owner.receipt(getAcceptedSessionInput(fixture.operation.id)!);
  expect(receipt).toMatchObject({state,result:'',admission:fixture.admission});
  expect(getSessionById(fixture.claim.session_id)).toMatchObject({status:'archived',agent_session_uuid:'proven-native',binding_generation:1});
  expect(host.owner.events().filter(event=>event.kind==='result')).toHaveLength(1);
  expect((await request(host.owner,`sessions/${fixture.created.session.id}/reconcile`,body)).status).toBe(200);expect(inspections).toBe(1);
});

test('live ownership and changed generation prevent adoption of a reconciled native result',async()=>{
  const client=capability(),fixture=uncertainChat(client),identity=currentProcessIdentity();
  registerProcessInstance('live',identity.pid,identity.bootId,identity.startTicks);
  db.query("UPDATE turns SET owner_instance_id='live' WHERE id=?").run(fixture.claim.turn_id);
  client.reconcile=async()=>{throw new Error('A live owner cannot be reconciled.');};
  await host.owner.reconcile(fixture.created.session.id,{clientActionId:randomUUID(),operationId:fixture.operation.id});
  expect(host.owner.receipt(getAcceptedSessionInput(fixture.operation.id)!).state).toBe('uncertain');
  db.query('UPDATE turns SET owner_instance_id=NULL WHERE id=?').run(fixture.claim.turn_id);
  client.reconcile=async run=>{db.query('UPDATE sessions SET binding_generation=binding_generation+1 WHERE id=?').run(fixture.claim.session_id);return {runId:run.runId,state:'completed',acknowledgedAt:null,nativeBinding:{accountScope:'account',sessionId:'old-result'},result:{state:'completed',sessionId:'old-result',turnId:'native-turn',text:'old output',nativeBinding:null,error:null},error:null};};
  const response=await host.owner.reconcile(fixture.created.session.id,{clientActionId:randomUUID(),operationId:fixture.operation.id});
  expect(response.operation).toMatchObject({state:'failed',error:{code:'RECONCILE_FAILED'}});
  expect(getSessionById(fixture.claim.session_id)?.agent_session_uuid).toBeNull();expect(host.owner.events().filter(event=>event.kind==='result')).toHaveLength(0);
});

test('Slack-born native reconciliation delivers retained empty output without needing Slack presentation',async()=>{
  upsertChannel({slack_channel_id:'COLD',slack_channel_name:'old',group_name:null,name:'old',vault_path:'/tmp',code_path:'/tmp',provider_default:'codex'});
  const session=createOrGetSession('COLD','1700000000.123456','codex');bindSessionProvider(session.id,'codex','original-thread');
  const accepted=host.owner.submit(`concierge:${session.id}`,{clientActionId:randomUUID(),text:'resume old session'}),claim=claimNextQueuedTurn('owner')!;
  const result={text:'',sessionUUID:'original-thread',toolsUsed:[]};
  markTurnDelivering(claim.turn_id,'',JSON.stringify({version:1,result}),0);
  db.query("UPDATE turns SET status='delivery_parked',owner_instance_id=NULL WHERE id=?").run(claim.turn_id);
  await host.owner.reconcile(`concierge:${session.id}`,{clientActionId:randomUUID(),operationId:accepted.operation.operationId});
  expect(host.owner.receipt(getAcceptedSessionInput(accepted.operation.operationId)!)).toMatchObject({state:'completed',result:''});
  expect(runs).toHaveLength(0);expect(forks).toHaveLength(0);
  expect(db.query('SELECT slack_user_msg_ts,slack_bot_msg_ts,delivery_status FROM turns WHERE id=?').get(claim.turn_id)).toEqual({slack_user_msg_ts:null,slack_bot_msg_ts:null,delivery_status:'delivered'});
});

test('ChatGPT admission pins the shared executor final prompt including interrupted context before any capability effect',async()=>{
  upsertChannel({slack_channel_id:'COLD',slack_channel_name:'old',group_name:null,name:'old',vault_path:'/tmp',code_path:'/tmp',provider_default:'chatgpt'});
  const session=createOrGetSession('COLD','1700000000.123456','chatgpt');bindSessionProvider(session.id,'chatgpt','original-browser');
  updateSessionMetadata(session.id,{nativeBinding:{accountScope:'account',sessionId:'original-browser'}});
  db.query("INSERT INTO turns(session_id,turn_kind,user_text,replay_text,slack_user_msg_ts,status) VALUES(?,'slack_user','earlier retained request','earlier retained request','1700000000.123456','error')").run(session.id);
  const client=capability();let effects=0;
  client.createChatGptProvider=options=>({id:'chatgpt',fork:async()=>{throw new Error('unsupported');},run:async actual=>{
    effects++;
    expect(actual.prompt).toContain('earlier retained request');expect(actual.prompt).toContain('current request');
    const stored=JSON.parse(getAcceptedSessionInput(options.run.operationId)!.receipt_json!);
    expect(options.admission.promptHash).toBe(createHash('sha256').update(actual.prompt).digest('hex'));
    expect(stored.admission).toEqual(options.admission);
    expect(host.owner.receipt(getAcceptedSessionInput(options.run.operationId)!)).toMatchObject({state:'running',text:'current request',admission:options.admission});
    actual.onProviderThreadStarted?.('original-browser');actual.onProviderTurnStarted?.('browser-turn');actual.onInputAcknowledged?.();actual.onProviderTerminal?.();
    return {text:'',sessionUUID:'original-browser',providerTurnId:'browser-turn',toolsUsed:[]};
  }});
  host=new SessionExecutionHost({instanceId:'owner',registry:registry(),providers:{},capabilityClient:client,defaultCwd:'/tmp',wake:()=>{}});
  const accepted=host.owner.submit(`concierge:${session.id}`,{clientActionId:randomUUID(),text:'current request'});await execute();
  expect(effects).toBe(1);expect(host.owner.receipt(getAcceptedSessionInput(accepted.operation.operationId)!)).toMatchObject({state:'completed',result:''});
});

test('consultation creates a distinct pinned child and same-child follow-up preserves enforced policy and source evidence',async()=>{
  const sourceId='archive-mac',sourceVersion='a'.repeat(64),boundary='last-assistant';
  const messages=[{eventId:'old-human',role:'user',text:'historical human question'},{eventId:boundary,role:'assistant',text:'historical assistant proposal'},{eventId:'old-tool',role:'tool',text:'historical tool command must not replay'}].map((entry,ordinal)=>({...entry,ordinal,sourceId,sourceVersion,locator:`archive:${ordinal}`,textHash:createHash('sha256').update(entry.text).digest('hex')}));
  const source={id:sourceId,provider:'codex',version:sourceVersion,branch:'branch-one',title:'Mac archive',consultation:{sourceId,sourceVersion,boundary,packetVersion:'dialogue-v1'},messages};
  const parent=createNativeSession('codex',{origin:'imported',title:source.title,source,interactionPolicy:'consultation-only'}),snapshot=getSessionById(parent.id)!.native_metadata_json;
  host.owner.runtime.sources={search:async()=>{throw new Error('unused');},import:async()=>{throw new Error('unused');},context:async()=>({source,evidence:messages,hasMore:false})};
  const body={clientActionId:randomUUID(),address:host.owner.view(parent).address,sourceId,sourceVersion,boundary,text:'Explain the old decision'};
  const accepted=await request(host.owner,'consultations',body);expect(accepted.status).toBe(202);
  const childId=accepted.body.operation.childSessionId,child=host.owner.get(childId).session;
  expect(child).toMatchObject({origin:'reconstructed',interactionPolicy:'consultation-only',lineage:{parentId:`concierge:${parent.id}`,kind:'reconstructed_from',boundary,sourceVersion},capabilities:{send:true,fork:false,attachments:[]}});
  await execute();
  expect(runs[0]).toMatchObject({sessionUUID:null,interactionPolicy:'consultation-only'});
  expect(runs[0]!.prompt).toContain('historical human question');expect(runs[0]!.prompt).toContain('historical assistant proposal');expect(runs[0]!.prompt).not.toContain('historical tool command must not replay');
  const followup=host.owner.submit(childId,{clientActionId:randomUUID(),text:'One more detail'});await execute();
  expect(runs[1]).toMatchObject({sessionUUID:'native-thread',interactionPolicy:'consultation-only'});
  expect(host.owner.receipt(getAcceptedSessionInput(followup.operation.operationId)!).state).toBe('completed');
  expect((await request(host.owner,'consultations',body))).toMatchObject({status:200,body:{operation:{childSessionId:childId}}});
  expect(getSessionById(parent.id)!.native_metadata_json).toBe(snapshot);expect(getSessionById(parent.id)!.agent_session_uuid).toBeNull();
  expect((await request(host.owner,`sessions/${childId}/forks`,{clientActionId:randomUUID(),boundary})).status).toBe(409);
  expect(db.query('SELECT count(*) AS n FROM sessions').get()).toEqual({n:2});
});

test('uncertain native receipt is inspectable and never creates a replacement provider effect',async()=>{
  const client=capability(),fixture=uncertainChat(client);let inspected=0;
  client.reconcile=async run=>{inspected++;return {runId:run.runId,state:'uncertain',acknowledgedAt:null,nativeBinding:null,result:null,error:{code:'UNKNOWN_EFFECT',message:'Native send remains unknown.'}};};
  client.createChatGptProvider=()=>{throw new Error('No replay is permitted.');};
  await host.owner.reconcile(fixture.created.session.id,{clientActionId:randomUUID(),operationId:fixture.operation.id});
  expect(inspected).toBe(1);expect(host.owner.receipt(getAcceptedSessionInput(fixture.operation.id)!).state).toBe('uncertain');
  expect(db.query('SELECT count(*) AS n FROM turns').get()).toEqual({n:1});expect(host.owner.events().filter(event=>event.kind==='result')).toHaveLength(0);
});

test.each(['failed','canceled'] as const)('reconcile settles explicit native %s without output or inventing a provider binding',async state=>{
  const client=capability(),fixture=uncertainChat(client);
  client.reconcile=async run=>({runId:run.runId,state,acknowledgedAt:null,nativeBinding:null,result:null,error:{code:'NATIVE_TERMINAL',message:'Exact native terminal proof.'}});
  client.createChatGptProvider=()=>{throw new Error('No new effect.');};
  await host.owner.reconcile(fixture.created.session.id,{clientActionId:randomUUID(),operationId:fixture.operation.id});
  expect(host.owner.receipt(getAcceptedSessionInput(fixture.operation.id)!)).toMatchObject({state,result:null,error:{code:'NATIVE_TERMINAL'}});
  expect(getSessionById(fixture.claim.session_id)?.agent_session_uuid).toBeNull();
  expect(db.query('SELECT agent_text,outbound_text,owner_instance_id,delivery_status FROM turns WHERE id=?').get(fixture.claim.turn_id)).toEqual({agent_text:null,outbound_text:null,owner_instance_id:null,delivery_status:'delivered'});
  expect(host.owner.events().filter(event=>event.kind==='result')).toHaveLength(0);
});

test('Claude fork uses the exact native message boundary rather than a turn alias',async()=>{
  provider.id='claude-code';provider.capabilities!.forkBoundary='message';
  host=new SessionExecutionHost({instanceId:'owner',registry:registry(),providers:{'claude-code':provider},defaultCwd:'/tmp',wake:()=>{}});
  const session=createNativeSession('claude-code',{cwd:'/tmp'});bindSessionProvider(session.id,'claude-code','original-claude');
  const rejected=host.owner.fork(`concierge:${session.id}`,{clientActionId:randomUUID(),boundary:'cutoff'});await execute();
  expect(host.owner.receipt(getAcceptedSessionInput(rejected.operation.operationId)!).state).toBe('failed');expect(forks).toHaveLength(0);
  const accepted=host.owner.fork(`concierge:${session.id}`,{clientActionId:randomUUID(),boundary:'message-before'});await execute();
  expect(forks).toHaveLength(1);expect(forks[0]).toMatchObject({sessionUUID:'original-claude',lastTurnId:'message-before'});
  expect(host.owner.get(host.owner.receipt(getAcceptedSessionInput(accepted.operation.operationId)!).childSessionId).session).toMatchObject({provider:'claude-code',lineage:{boundary:'message-before'}});
  expect(getSessionById(session.id)?.agent_session_uuid).toBe('original-claude');
});

test('explicit reconciliation retries a saved native delivery after callback acknowledgement loss without another model call',async()=>{
  const parent=bound(),id=`concierge:${parent.id}`,accepted=host.owner.submit(id,{clientActionId:randomUUID(),text:'once'}),claim=claimNextQueuedTurn('owner')!;
  const result={text:'',sessionUUID:'original-thread',toolsUsed:[]};
  markTurnDelivering(claim.turn_id,'',JSON.stringify({version:1,result}),0);
  await host.deliverResult({...result,inputId:accepted.operation.operationId,sessionId:parent.id,turnId:claim.turn_id});
  db.query('UPDATE turns SET owner_instance_id=NULL WHERE id=?').run(claim.turn_id);
  await host.owner.reconcile(id,{clientActionId:randomUUID(),operationId:accepted.operation.operationId});
  expect(host.owner.receipt(getAcceptedSessionInput(accepted.operation.operationId)!)).toMatchObject({state:'completed',result:''});
  expect(host.owner.events().filter(event=>event.kind==='result')).toHaveLength(1);expect(runs).toHaveLength(0);
});
