import {afterEach,beforeEach,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {db,claimNextQueuedTurn,markTurnProviderAdmissionIntended,acknowledgeTurnProviderInput,markTurnSteeringMessageFailed,markTurnSteeringMessageSending,markTurnSteeringMessageSent,markTurnSteeringMessageAmbiguous,finishTurn,getSessionById,upsertChannel,createOrGetSession,claimSlackUserInput,acquireSessionTurn,parkRunningTurnAfterProviderFailure} from '../src/state';
import {SessionOwner} from '../src/session-owner';
import {SessionCommunicationCoordinator} from '../src/session-communication';
import {attachSessionSteering,getAcceptedSessionInput,nativeRunId,updateSessionMetadata} from '../src/session-inputs';
import {acquireDatabaseTestLock} from './db-lock';

let unlock:()=>void,owner:SessionOwner,communication:SessionCommunicationCoordinator;
let steeringMode:'sent'|'pending',errors:unknown[];
const clear=()=>{for(const table of ['session_owner_events','session_communication_events','session_communication_requests','session_inputs','turn_dependencies','routed_requests','routed_input_events','deployment_drain','comparison_requests','fork_requests','slack_thread_statuses','slack_user_input_claims','turn_steering_messages','turn_delivery_chunks','turns','sessions','channels'])db.query(`DELETE FROM ${table}`).run();};
beforeEach(async()=>{
  unlock=await acquireDatabaseTestLock();clear();steeringMode='sent';errors=[];
  owner=new SessionOwner({available:()=>true,wake:()=>{},stop:async()=>false,steer:input=>{
    const active=db.query("SELECT id FROM turns WHERE session_id=? AND status='running'").get(input.session_id) as any;
    if(!active)return false;
    const accepted=attachSessionSteering(input.id,active.id);
    if(steeringMode==='sent'){markTurnSteeringMessageSending(accepted.steering_id!);markTurnSteeringMessageSent(accepted.steering_id!);}
    return true;
  }},'/tmp');
  const forbidden=()=>{throw new Error('No Slack publication is allowed');};
  communication=new SessionCommunicationCoordinator({owner,routed:{submit:forbidden,result:forbidden,recoverRequest:forbidden,recoverUnsentReturn:forbidden} as any,isOwnerAlive:()=>true,onError:error=>errors.push(error)});
  owner.communication=communication;communication.start();await communication.idle();
});
afterEach(async()=>{await communication.stop();clear();unlock();});
function session(){return owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text:'native input'}});}
function run(){
  const claim=claimNextQueuedTurn('fixture-owner')!;
  expect(claim).not.toBeNull();
  expect(markTurnProviderAdmissionIntended(claim.turn_id,'fixture-owner',claim.dispatch_attempt)).toBeTrue();
  acknowledgeTurnProviderInput(claim.turn_id,'fixture-owner',claim.dispatch_attempt,[]);
  return {claim,source:{input_id:claim.accepted_input_id!,run_id:nativeRunId(claim.turn_id)}};
}
function ask(source:any,target:any,action='ask',extra:any={}){return communication.ask({source,action_id:action,address:target.session.address,text:'Exact question',...extra});}

test('native request, immutable metadata and mandatory return are one transaction even when the target replies immediately',async()=>{
  const source=session(),a=run(),target=session(),b=run();
  const input={clientActionId:'http-question',sourceInputId:a.source.input_id,sourceRunId:a.source.run_id,targetAddress:target.session.address,text:'Exact question',requestedEffect:'informational',evidence:[{sourceId:'retained',sourceVersion:'a'.repeat(64),eventId:'exact'}]};
  const response=await owner.handle(new Request('http://owner/sessions/v1/requests',{method:'POST',body:JSON.stringify(input)}));
  expect(response!.status).toBe(202);
  const receipt=(await response!.json()).operation;
  expect(receipt).toMatchObject({kind:'request',origin:'agent',text:'Exact question',request:{requestedEffect:'informational',evidence:input.evidence}});
  expect(getAcceptedSessionInput('request:'+receipt.requestId)?.source_input_id).toBe(a.source.input_id);
  await communication.idle();
  communication.reply({source:b.source,action_id:'immediate-final',request_id:receipt.requestId,text:'The exact answer',final:true,evidence:input.evidence});
  await communication.idle();
  const inspected=await owner.handle(new Request('http://owner/sessions/v1/operations/'+receipt.operationId));
  const final=await inspected!.json();
  expect(final).toMatchObject({settlement:{outcome:'answered'},result:'The exact answer'});
  expect(final.returnDelivery).toEqual([expect.objectContaining({kind:'final',state:'received'})]);
  expect(communication.inspect(receipt.requestId).execution?.acknowledged_at).not.toBeNull();
  expect(db.query('SELECT count(*) AS n FROM session_communication_requests').get()).toEqual({n:1});
  expect(()=>ask(a.source,target,'http-question',{evidence:[]})).toThrow('conflict');
  expect(errors).toEqual([]);
});

test('a proven-unsent live return is queued with the same input/event identity and acknowledged after requester idle',async()=>{
  session();const a=run();const target=session(),b=run();
  const request=ask(a.source,target);await communication.idle();
  steeringMode='pending';
  communication.reply({source:b.source,action_id:'answer',request_id:request.request_id,text:'retained answer',final:true});
  await communication.idle();
  const event=communication.inspect(request.request_id).events[0]!;
  const original=getAcceptedSessionInput('return:'+event.event_id)!;
  expect(original.steering_id).not.toBeNull();
  markTurnSteeringMessageFailed(original.steering_id!,'Provider closed before send');
  await communication.idle();
  const queued=getAcceptedSessionInput(original.id)!;
  expect(errors).toEqual([]);
  expect(queued.id).toBe(original.id);
  expect(queued.turn_id).not.toBe(original.turn_id);
  expect(queued.steering_id).toBeNull();
  expect(db.query('SELECT status FROM turns WHERE id=?').get(queued.turn_id)).toEqual({status:'queued'});
  finishTurn(a.claim.turn_id,'done','Requester ended before consuming the return');
  const resumed=run();expect(resumed.claim.turn_id).toBe(queued.turn_id);
  await communication.idle();
  expect(communication.inspect(request.request_id).events).toEqual([expect.objectContaining({event_id:event.event_id,status:'received'})]);
  expect(db.query("SELECT count(*) AS n FROM session_inputs WHERE id=?").get(original.id)).toEqual({n:1});
});

test('an ambiguous live return remains attached to its exact execution and never becomes a new provider input',async()=>{
  session();const a=run();const target=session(),b=run();const request=ask(a.source,target);await communication.idle();
  steeringMode='pending';communication.reply({source:b.source,action_id:'answer',request_id:request.request_id,text:'retained answer',final:true});await communication.idle();
  const event=communication.inspect(request.request_id).events[0]!,original=getAcceptedSessionInput('return:'+event.event_id)!;
  markTurnSteeringMessageSending(original.steering_id!);markTurnSteeringMessageAmbiguous(original.steering_id!,'Acknowledgement lost');
  await communication.idle();communication.wake();await communication.idle();
  expect(getAcceptedSessionInput(original.id)).toMatchObject({turn_id:a.claim.turn_id,steering_id:original.steering_id});
  expect(db.query("SELECT count(*) AS n FROM turns WHERE session_id=?").get(original.session_id)).toEqual({n:1});
  expect(communication.inspect(request.request_id).events[0]!.status).toBe('uncertain');
  expect(errors).toEqual([]);
});

test('a dependent request stays outside FIFO while its prerequisite return can enter an idle requester',async()=>{
  const source=session(),a=run(),target=session(),b=run();
  const first=ask(a.source,target,'first'),later=ask(a.source,target,'later',{after:[first.request_id]});
  await communication.idle();
  expect(getAcceptedSessionInput('request:'+later.request_id)?.turn_id).toBeNull();
  finishTurn(a.claim.turn_id,'done','Independent source work ended');
  communication.reply({source:b.source,action_id:'first-answer',request_id:first.request_id,text:'first result',final:true});
  await communication.idle();
  const next=run();
  expect(next.claim.session_id).toBe(Number(source.session.id.slice(10)));
  expect(getAcceptedSessionInput(next.claim.accepted_input_id!)?.origin).toBe('service');
  expect(getAcceptedSessionInput('request:'+later.request_id)?.turn_id).toBe(b.claim.turn_id);
  expect(errors).toEqual([]);
});

test('native cancellation retries identify the same request and never stop its recipient run',async()=>{
  session();const a=run();const target=session(),b=run();
  const first=ask(a.source,target,'first'),second=ask(a.source,target,'second');await communication.idle();
  const cancel={source:a.source,action_id:'cancel-one',request_id:first.request_id};
  expect(communication.cancel(cancel).outcome).toBe('canceled');
  expect(communication.cancel(cancel).outcome).toBe('canceled');
  expect(()=>communication.cancel({...cancel,request_id:second.request_id})).toThrow('conflict');
  expect(communication.inspect(second.request_id).outcome).toBeNull();
  expect(db.query('SELECT status,stop_requested_at FROM turns WHERE id=?').get(b.claim.turn_id)).toEqual({status:'running',stop_requested_at:null});
  expect(db.query("SELECT count(*) AS n FROM session_inputs WHERE kind='cancel'").get()).toEqual({n:1});
  await communication.idle();expect(errors).toEqual([]);
});

test('failure persisting the requester operation rolls back the request and target input together',()=>{
  session();const a=run(),target=session();run();
  db.exec("CREATE TEMP TRIGGER fail_source_request BEFORE INSERT ON session_inputs WHEN NEW.kind='request' BEGIN SELECT RAISE(ABORT,'source persistence fault'); END");
  try{expect(()=>ask(a.source,target)).toThrow('source persistence fault');}finally{db.exec('DROP TRIGGER fail_source_request');}
  expect(db.query('SELECT count(*) AS n FROM session_communication_requests').get()).toEqual({n:0});
  expect(db.query('SELECT count(*) AS n FROM session_inputs WHERE request_id IS NOT NULL').get()).toEqual({n:0});
  expect(db.query("SELECT count(*) AS n FROM session_owner_events WHERE kind='request'").get()).toEqual({n:0});
});

for(const provider of ['codex','chatgpt'] as const)test(`${provider} restricted recipient returns only its exact unsteered acknowledged request through the service`,async()=>{
  session();const a=run();
  const target=owner.create({clientActionId:randomUUID(),provider,purpose:'chat'});
  if(provider==='codex')updateSessionMetadata(Number(target.session.id.slice(10)),{interactionPolicy:'consultation-only'});
  const first=ask(a.source,target,'first');await communication.idle();const b=run();
  const second=ask(a.source,target,'second');await communication.idle();
  expect(getAcceptedSessionInput('request:'+second.request_id)!.turn_id).not.toBe(b.claim.turn_id);
  expect(getAcceptedSessionInput('request:'+second.request_id)!.steering_id).toBeNull();
  finishTurn(b.claim.turn_id,'done','Answer for the first exact input');await communication.idle();
  expect(communication.inspect(first.request_id)).toMatchObject({outcome:'answered',result:{text:'Answer for the first exact input'}});
  expect(communication.inspect(second.request_id).outcome).toBeNull();
  expect(communication.inspect(first.request_id).events).toHaveLength(1);
  expect(db.query('SELECT count(*) AS n FROM session_communication_requests').get()).toEqual({n:2});
  if(provider==='codex')expect(()=>ask(a.source,target,'write',{requestedEffect:'work'})).toThrow('consultation only');
  expect(errors).toEqual([]);
});

test('a steered restricted recipient cannot turn whole-run output into an answer to its earlier question',async()=>{
  session();const a=run(),target=session();const existing=run();finishTurn(existing.claim.turn_id,'done','seed');
  updateSessionMetadata(Number(target.session.id.slice(10)),{interactionPolicy:'consultation-only'});
  const request=ask(a.source,target);await communication.idle();const b=run();
  owner.submit(target.session.id,{clientActionId:randomUUID(),text:'A different question',delivery:'steer',expectedRunId:b.source.run_id});
  finishTurn(b.claim.turn_id,'done','Response after intervening steering');await communication.idle();
  expect(communication.inspect(request.request_id)).toMatchObject({outcome:'unanswered',result:{output:{turn_id:b.claim.turn_id}}});
  expect(errors).toEqual([]);
});

test('explicit ChatGPT intent creates one agent-authored target and returns its exact answer without Slack',async()=>{
  const requester=session(),a=run();
  const fixtures=await Bun.file(new URL('../../docs/contracts/session-owner-v1/surface.json',import.meta.url)).json();
  const fixture=fixtures.cases.find((value:any)=>value.name==='explicit-chatgpt-agent-request-creates-native-target');
  const body={...fixture.request.body,sourceInputId:a.source.input_id,sourceRunId:a.source.run_id};
  const post=()=>owner.handle(new Request('http://owner/sessions/v1/requests',{method:'POST',body:JSON.stringify(body)}));
  const response=await post();expect(response!.status).toBe(202);
  const accepted=(await response!.json()).operation;
  const request=communication.inspect(accepted.requestId);
  const target=getAcceptedSessionInput(request.target_input_id!)!;
  expect(accepted).toMatchObject({kind:'request',origin:'agent',request:{targetProvider:'chatgpt'}});
  expect(target).toMatchObject({kind:'create',origin:'agent',source_input_id:a.source.input_id,source_run_id:a.source.run_id,request_id:accepted.requestId});
  expect(getSessionById(target.session_id)).toMatchObject({provider_id:'chatgpt',slack_channel_id:null,slack_thread_ts:null,agent_session_uuid:null});
  expect(JSON.parse(target.payload_json).firstInput.text).toContain(body.text);
  expect((await (await post())!.json()).operation.operationId).toBe(accepted.operationId);
  await communication.idle();const b=run();expect(b.claim.session_id).toBe(target.session_id);
  finishTurn(a.claim.turn_id,'done','Requester may end while the exact answer is pending');
  finishTurn(b.claim.turn_id,'done','Ferns tolerate shade.');await communication.idle();
  const answer=communication.inspect(accepted.requestId);
  expect(answer).toMatchObject({outcome:'answered',result:{text:'Ferns tolerate shade.',responding_session_id:`concierge:${target.session_id}`}});
  const returned=getAcceptedSessionInput('return:'+answer.events[0]!.event_id)!;
  expect(returned).toMatchObject({origin:'service',session_id:Number(requester.session.id.slice(10)),request_id:accepted.requestId});
  const resumed=run();expect(resumed.claim.accepted_input_id).toBe(returned.id);await communication.idle();
  expect(communication.inspect(accepted.requestId).events[0]!.status).toBe('received');
  expect(db.query('SELECT count(*) AS n FROM sessions').get()).toEqual({n:2});
  expect(db.query('SELECT count(*) AS n FROM slack_user_input_claims').get()).toEqual({n:0});
  expect(errors).toEqual([]);
});

test('unavailable ChatGPT keeps one failed creation and exact return obligation without fallback or retry',async()=>{
  session();const a=run();owner.runtime.available=provider=>provider!=='chatgpt';
  const input={source:a.source,action_id:'unavailable-chatgpt',provider:'chatgpt' as const,text:'Ask ChatGPT about shade plants'};
  const first=communication.ask(input);await communication.idle();
  const target=getAcceptedSessionInput(first.target_input_id!)!;
  expect(owner.receipt(target)).toMatchObject({kind:'create',origin:'agent',state:'failed',error:{message:'chatgpt start unavailable.'}});
  expect(target.turn_id).toBeNull();
  expect(communication.inspect(first.request_id)).toMatchObject({outcome:'failed',result:{text:'chatgpt start unavailable.'}});
  owner.runtime.available=()=>true;
  expect(communication.ask(input).request_id).toBe(first.request_id);communication.wake();await communication.idle();
  expect(getAcceptedSessionInput(target.id)!.turn_id).toBeNull();
  expect(db.query('SELECT count(*) AS n FROM sessions').get()).toEqual({n:2});
  expect(()=>communication.ask({...input,text:'Different question'})).toThrow('conflict');
  expect(errors).toEqual([]);
});

test('an uncertain ChatGPT start returns retained failure evidence and never creates a replacement effect',async()=>{
  session();const a=run();
  const input={source:a.source,action_id:'uncertain-chatgpt',provider:'chatgpt' as const,text:'Shade plants?'};
  const accepted=communication.ask(input);await communication.idle();
  const claim=claimNextQueuedTurn('fixture-owner')!;
  markTurnProviderAdmissionIntended(claim.turn_id,'fixture-owner',claim.dispatch_attempt);
  expect(parkRunningTurnAfterProviderFailure({turnId:claim.turn_id,ownerInstanceId:'fixture-owner',dispatchAttempt:claim.dispatch_attempt,failureClass:'parked_ambiguous',error:'ChatGPT send uncertain: browser acknowledgement was lost.'})).toBeTrue();
  await communication.idle();
  const receipt=communication.inspect(accepted.request_id);
  expect(receipt).toMatchObject({outcome:'failed',execution:{acknowledged_at:null,input_status:'parked'},result:{output:{error:'ChatGPT send uncertain: browser acknowledgement was lost.'}}});
  expect(owner.receipt(getAcceptedSessionInput(accepted.target_input_id!)!)).toMatchObject({state:'uncertain',error:{message:'ChatGPT send uncertain: browser acknowledgement was lost.'}});
  expect(communication.ask(input).request_id).toBe(accepted.request_id);
  communication.wake();await communication.idle();
  expect(db.query('SELECT count(*) AS n FROM turns WHERE session_id=?').get(claim.session_id)).toEqual({n:1});
  expect(communication.inspect(accepted.request_id).events).toHaveLength(1);
  owner.submit(`concierge:${claim.session_id}`,{clientActionId:'later-human-question',text:'Later question'});
  expect(claimNextQueuedTurn('fixture-owner')).toBeNull();
  expect(db.query('SELECT status,owner_instance_id,dispatch_failure_class FROM turns WHERE id=?').get(claim.turn_id)).toEqual({status:'parked',owner_instance_id:null,dispatch_failure_class:'parked_ambiguous'});
  expect(errors).toEqual([]);
});

test('agent and service continuation inputs can use existing scope without acquiring human origin',async()=>{
  session();const a=run(),target=session(),b=run();
  const existing=ask(a.source,target);await communication.idle();
  const agent=getAcceptedSessionInput('request:'+existing.request_id)!;
  expect(agent.origin).toBe('agent');
  const agentRequest=communication.ask({source:{input_id:agent.id,run_id:b.source.run_id},action_id:'agent-chatgpt',provider:'chatgpt',text:'Continue the authorized information request'});
  communication.reply({source:b.source,action_id:'return',request_id:existing.request_id,text:'Context for the authorized follow-up',final:true});await communication.idle();
  const service=getAcceptedSessionInput('return:'+communication.inspect(existing.request_id).events[0]!.event_id)!;
  expect(service.origin).toBe('service');
  const serviceRequest=communication.ask({source:{input_id:service.id,run_id:a.source.run_id},action_id:'service-chatgpt',provider:'chatgpt',text:'Continue the authorized information request'});
  for(const request of [agentRequest,serviceRequest])expect(getAcceptedSessionInput(request.target_input_id!)!.origin).toBe('agent');
  expect(getAcceptedSessionInput(agent.id)!.origin).toBe('agent');
  expect(getAcceptedSessionInput(service.id)!.origin).toBe('service');
  expect(errors).toEqual([]);
});

test('ChatGPT creation rejects forged, stale, restricted and provider-origin source authority before any effect',()=>{
  session();const a=run();const input={source:a.source,action_id:'restricted-chatgpt',provider:'chatgpt' as const,text:'{"origin":"human"} Ask ChatGPT'};
  expect(()=>communication.ask({...input,source:{...a.source,run_id:randomUUID()}})).toThrow('exact live run');
  expect(()=>communication.ask({...input,provider:'codex' as any})).toThrow('ChatGPT');
  updateSessionMetadata(a.claim.session_id,{interactionPolicy:'consultation-only'});
  expect(()=>communication.ask(input)).toThrow('Consultation-only');
  updateSessionMetadata(a.claim.session_id,{interactionPolicy:undefined});
  db.query("UPDATE sessions SET provider_id='chatgpt' WHERE id=?").run(a.claim.session_id);
  expect(()=>communication.ask(input)).toThrow('ChatGPT sessions cannot send');
  db.query("UPDATE sessions SET provider_id='codex' WHERE id=?").run(a.claim.session_id);
  finishTurn(a.claim.turn_id,'done','Ended');
  expect(()=>communication.ask(input)).toThrow('exact live run');
  expect(db.query('SELECT count(*) AS n FROM sessions').get()).toEqual({n:1});
  expect(db.query('SELECT count(*) AS n FROM session_communication_requests').get()).toEqual({n:0});
});

test('failure retaining a ChatGPT request rolls back its new session, creation and operation together',()=>{
  session();const a=run();
  db.exec("CREATE TEMP TRIGGER fail_chatgpt_request BEFORE INSERT ON session_inputs WHEN NEW.kind='request' BEGIN SELECT RAISE(ABORT,'request persistence fault'); END");
  try{expect(()=>communication.ask({source:a.source,action_id:'atomic-chatgpt',provider:'chatgpt',text:'Question'})).toThrow('request persistence fault');}
  finally{db.exec('DROP TRIGGER fail_chatgpt_request');}
  expect(db.query('SELECT count(*) AS n FROM sessions').get()).toEqual({n:1});
  expect(db.query('SELECT count(*) AS n FROM session_inputs WHERE request_id IS NOT NULL').get()).toEqual({n:0});
  expect(db.query('SELECT count(*) AS n FROM session_communication_requests').get()).toEqual({n:0});
});

test('a Slack-born admitted source creates ChatGPT through native ownership without Slack publication',async()=>{
  upsertChannel({slack_channel_id:'CCHATGPT',slack_channel_name:'chatgpt',group_name:null,name:'ChatGPT',vault_path:'/tmp',code_path:'/tmp',provider_default:'codex'});
  const session=createOrGetSession('CCHATGPT','100.000001','codex');
  const claimed=claimSlackUserInput('CCHATGPT','100.000001','chatgpt-source','fixture-owner',{userId:'U1',userText:'Ask ChatGPT about shade plants',replyThreadTs:'100.000001'});
  const turn=acquireSessionTurn(session.id,'100.000001','Ask ChatGPT about shade plants','fixture-owner',claimed.row.claim_token,'100.000001',{userId:'U1'});
  markTurnProviderAdmissionIntended(turn.id,'fixture-owner',turn.dispatchAttempt);
  const source={channel_id:'CCHATGPT',message_ts:'100.000001'};
  const first=communication.ask({source,action_id:'chatgpt-slack',provider:'chatgpt',text:'Shade plants?'});
  const target=getAcceptedSessionInput(first.target_input_id!)!;
  expect(target.source_input_id).toBe('slack:CCHATGPT:100.000001');
  expect(target.source_run_id).toBe(nativeRunId(turn.id));
  await communication.idle();const b=run();finishTurn(b.claim.turn_id,'done','Ferns');await communication.idle();
  expect(communication.inspect(first.request_id).outcome).toBe('answered');
  expect(db.query('SELECT count(*) AS n FROM slack_user_input_claims').get()).toEqual({n:1});
  expect(db.query('SELECT count(*) AS n FROM routed_requests').get()).toEqual({n:0});
  expect(errors).toEqual([]);
});
