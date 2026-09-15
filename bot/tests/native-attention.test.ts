import {afterEach,beforeEach,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {db,claimNextQueuedTurn,getSessionById,finishTurn,markTurnProviderAdmissionIntended,registerProcessInstance} from '../src/state';
import {SessionExecutionHost} from '../src/session-execution-host';
import {ActiveTurnDispatchRegistry} from '../src/turn-dispatch-seams';
import {installSessionProjection,projectSessionProviderMessage} from '../src/session-projection';
import {reconcileRecoverableTurns} from '../src/turn-recovery';
import {ProviderDispatchError} from '../src/provider-failures';
import {getAcceptedSessionInput,recordSessionEvent,updateSessionMetadata} from '../src/session-inputs';
import {acquireDatabaseTestLock} from './db-lock';
import type {AgentProvider} from '../src/providers';

let unlock:()=>void,detach:()=>void,host:SessionExecutionHost,calls:number;
const clear=()=>{for(const table of ['session_owner_events','session_communication_events','session_communication_requests','session_inputs','session_attachments','turn_dependencies','routed_requests','routed_input_events','deployment_drain','comparison_requests','fork_requests','slack_thread_statuses','slack_user_input_claims','turn_steering_messages','turn_delivery_chunks','turns','sessions','channels','process_instances'])db.query(`DELETE FROM ${table}`).run();};
const provider=(terminalConfirmed:boolean):AgentProvider=>({id:'codex',fork:async()=>{throw new Error('not called');},run:async()=>{calls++;throw new ProviderDispatchError({message:'Retained native provider refusal',failureClass:'parked_terminal',terminalConfirmed});}});
beforeEach(async()=>{
  unlock=await acquireDatabaseTestLock();clear();calls=0;
  host=new SessionExecutionHost({instanceId:'attention-owner',registry:new ActiveTurnDispatchRegistry({onStarted:()=>{},onSettled:()=>{}}),providers:{codex:provider(true)},defaultCwd:'/tmp',wake:()=>{}});
  detach=installSessionProjection(host.owner);
});
afterEach(()=>{detach();clear();unlock();});
const create=()=>host.owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text:'An ordinary native request'}});
const view=(id:string)=>host.owner.get(id).session;
const action=(id:string,kind:string,generation?:number,value?:string)=>host.owner.action(id,{clientActionId:randomUUID(),action:{kind,...(generation===undefined?{}:{generation}),...(value===undefined?{}:{value})}});
const attention=(id:string,generation:number)=>expect(view(id)).toMatchObject({generation,needsAttention:true,unread:true});

test('native setup failure advances attention once and stale read/dismiss cannot hide a later failure',()=>{
  const first=create(),claim=claimNextQueuedTurn('attention-owner')!;
  action(first.session.id,'outcome',undefined,'shipped');
  expect(host.settleSetupFailure(claim,new Error('Private attachment setup failed'))).toBeTrue();
  attention(first.session.id,1);expect(view(first.session.id).outcome).toBe('shipped');
  action(first.session.id,'read',1);expect(view(first.session.id)).toMatchObject({needsAttention:true,unread:false});
  action(first.session.id,'dismiss',1);expect(view(first.session.id)).toMatchObject({needsAttention:false,unread:false,execution:'failed',outcome:'shipped'});
  finishTurn(claim.turn_id,'error','Private attachment setup failed');
  detach();detach=installSessionProjection(host.owner);
  expect(view(first.session.id)).toMatchObject({generation:1,needsAttention:false,unread:false});
  host.owner.submit(first.session.id,{clientActionId:randomUUID(),text:'Another authorized request'});
  const later=claimNextQueuedTurn('attention-owner')!;
  host.settleSetupFailure(later,new Error('A new setup failure'));
  action(first.session.id,'read',1);action(first.session.id,'dismiss',1);
  projectSessionProviderMessage(claim.turn_id,{id:'late',role:'assistant',content:'Late heartbeat',tool:null,phase:'commentary'});
  attention(first.session.id,2);expect(view(first.session.id).outcome).toBe('shipped');
  expect(calls).toBe(0);
});

for(const confirmed of [true,false])test(`native provider refusal or uncertainty is actionable once (${confirmed})`,async()=>{
  host.options.providers.codex=provider(confirmed);
  const first=create(),claim=claimNextQueuedTurn('attention-owner')!;
  await host.run(claim);
  attention(first.session.id,1);
  expect(view(first.session.id).execution).toBe(confirmed?'failed':'uncertain');
  const retained=db.query('SELECT * FROM turns WHERE id=?').get(claim.turn_id);
  detach();detach=installSessionProjection(host.owner);detach();detach=installSessionProjection(host.owner);
  attention(first.session.id,1);expect(db.query('SELECT * FROM turns WHERE id=?').get(claim.turn_id)).toEqual(retained);
  expect(calls).toBe(1);
});

test('unavailable native creation has attention without a turn and retries do not notify again',()=>{
  const body={clientActionId:randomUUID(),provider:'chatgpt',purpose:'chat'};
  const first=host.owner.create(body);attention(first.session.id,1);
  expect(first.operation).toMatchObject({state:'failed',runId:null});
  action(first.session.id,'dismiss',1);host.owner.create(body);
  detach();detach=installSessionProjection(host.owner);
  expect(view(first.session.id)).toMatchObject({generation:1,needsAttention:false,unread:true});
  expect(db.query('SELECT count(*) AS n FROM turns').get()).toEqual({n:0});
});

test('known-dead native recovery exposes uncertainty once while preserving exact effect and no replay',async()=>{
  const first=create();registerProcessInstance('dead-attention-owner',4321,'old-boot','1234');
  const claim=claimNextQueuedTurn('dead-attention-owner')!;
  markTurnProviderAdmissionIntended(claim.turn_id,'dead-attention-owner',claim.dispatch_attempt);
  const forbidden=()=>{throw new Error('No Slack delivery or provider call is permitted');};
  const recover=()=>reconcileRecoverableTurns({client:null,instanceId:'attention-owner',nativeOnly:true,isOwnerAlive:()=>false,
    services:{deliverOutcome:forbidden,projectTurnStatus:forbidden,projectThreadSummary:forbidden}});
  await recover();attention(first.session.id,1);
  expect(view(first.session.id).execution).toBe('uncertain');
  const preserved=db.query('SELECT * FROM turns WHERE id=?').get(claim.turn_id);
  action(first.session.id,'read',1);action(first.session.id,'dismiss',1);
  await recover();detach();detach=installSessionProjection(host.owner);
  expect(view(first.session.id)).toMatchObject({generation:1,needsAttention:false,unread:false});
  expect(db.query('SELECT * FROM turns WHERE id=?').get(claim.turn_id)).toEqual(preserved);
  expect(getAcceptedSessionInput(first.operation.inputId!)!.turn_id).toBe(claim.turn_id);
  expect(calls).toBe(0);
});

test('startup catches an already-retained failed input without rewriting provider evidence',()=>{
  detach();const first=create(),claim=claimNextQueuedTurn('attention-owner')!;
  host.settleSetupFailure(claim,new Error('ChatGPT HTTP 404 refusal'));
  expect(view(first.session.id)).toMatchObject({generation:0,needsAttention:false,unread:false});
  const preserved=db.query('SELECT * FROM turns WHERE id=?').get(claim.turn_id);
  detach=installSessionProjection(host.owner);attention(first.session.id,1);
  expect(db.query('SELECT * FROM turns WHERE id=?').get(claim.turn_id)).toEqual(preserved);
  expect(calls).toBe(0);
});

test('failure state and its first attention generation commit together',()=>{
  const first=create(),claim=claimNextQueuedTurn('attention-owner')!;
  db.exec("CREATE TEMP TRIGGER reject_native_attention BEFORE INSERT ON session_owner_events WHEN NEW.kind='attention' BEGIN SELECT RAISE(ABORT,'attention write failed'); END");
  try{expect(()=>host.settleSetupFailure(claim,new Error('Setup failed'))).toThrow('attention write failed');}
  finally{db.exec('DROP TRIGGER reject_native_attention');}
  expect(view(first.session.id)).toMatchObject({execution:'running',generation:0});
  expect(host.settleSetupFailure(claim,new Error('Setup failed'))).toBeTrue();
  attention(first.session.id,1);
});

test('historical result-backed failure and native result recovery retain their existing attention',async()=>{
  detach();const first=create(),claim=claimNextQueuedTurn('attention-owner')!;
  recordSessionEvent({eventId:`result:${claim.turn_id}`,sessionId:claim.session_id,inputId:claim.accepted_input_id,turnId:claim.turn_id,kind:'result',payload:{text:'retained failed result'}});
  updateSessionMetadata(claim.session_id,{generation:1,readGeneration:1,dismissedGeneration:1});
  host.settleSetupFailure(claim,new Error('Retained failure'));
  detach=installSessionProjection(host.owner);
  expect(view(first.session.id)).toMatchObject({generation:1,needsAttention:false,unread:false});
  const next=create(),another=claimNextQueuedTurn('attention-owner')!;
  const result={turnId:another.turn_id,sessionId:another.session_id,inputId:another.accepted_input_id!,text:'',sessionUUID:null,toolsUsed:[]};
  await host.deliverResult(result);await host.deliverResult(result);
  finishTurn(another.turn_id,'error','Retained failed result');
  attention(next.session.id,1);
});
