import {afterEach,beforeEach,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {db,claimNextQueuedTurn,observeExecutionChanges,getSessionById,acquireSessionTurn,createOrGetSession,upsertChannel,markTurnDelivering,markTurnResponseDelivered,finishDeliveredTurn,markTurnProviderAdmissionIntended,type QueuedTurnClaimRow} from '../src/state';
import {createNativeSession,enqueueSessionInput,retainSessionInput,getAcceptedSessionInput} from '../src/session-inputs';
import {SessionExecutionHost} from '../src/session-execution-host';
import {SessionTurnQueueCoordinator} from '../src/session-turn-queue';
import {ActiveTurnDispatchRegistry} from '../src/turn-dispatch-seams';
import {installSessionProjection} from '../src/session-projection';
import {acquireDatabaseTestLock} from './db-lock';
import type {AgentProvider} from '../src/providers';

let unlock:()=>void;
const clear=()=>{for(const table of ['session_owner_events','session_inputs','session_attachments','turn_dependencies','routed_requests','routed_input_events','deployment_drain','comparison_requests','fork_requests','slack_thread_statuses','slack_user_input_claims','turn_steering_messages','turn_delivery_chunks','turns','sessions','channels','process_instances'])db.query(`DELETE FROM ${table}`).run();};
beforeEach(async()=>{unlock=await acquireDatabaseTestLock();clear();});
afterEach(()=>{clear();unlock();});

for(const origin of ['human','service'] as const)test(`${origin} FIFO successors survive terminal observation before predecessor registry cleanup`,async()=>{
  const errors:unknown[]=[],calls:string[]=[],active=new Set<number>();let maximumActive=0,completed=0,finish!:()=>void;
  const finished=new Promise<void>(resolve=>finish=resolve);
  let queue:SessionTurnQueueCoordinator<QueuedTurnClaimRow>;
  const registry=new ActiveTurnDispatchRegistry({onStarted:()=>{},onSettled:()=>queue.wake()});
  const provider:AgentProvider={id:'codex',fork:async()=>{throw new Error('unused');},run:async input=>{
    const id=Number(input.environment?.CONCIERGE_TURN_ID);active.add(id);maximumActive=Math.max(maximumActive,active.size);
    calls.push(input.prompt);input.onProviderThreadStarted?.('same-provider-session');input.onProviderTurnStarted?.(`native-${id}`);input.onInputAcknowledged?.();
    try{return {text:`answer-${id}`,sessionUUID:'same-provider-session',toolsUsed:[]};}
    finally{active.delete(id);input.onProviderTerminal?.();}
  }};
  const host=new SessionExecutionHost({instanceId:'native-owner',registry,providers:{codex:provider},defaultCwd:'/tmp',wake:()=>queue.wake()});
  queue=new SessionTurnQueueCoordinator({claim:()=>claimNextQueuedTurn('native-owner',Date.now(),registry.activeSessions),shouldStop:()=>false,
    run:async claim=>{try{return await host.run(claim);}finally{if(++completed===2)finish();}},
    onError:(claim,error)=>{errors.push(error);host.settleSetupFailure(claim,error);}});
  const session=createNativeSession('codex',{});
  const inputs=['Partial return: first garden measurement.','Final return: remaining garden measurement.'].map(text=>enqueueSessionInput(retainSessionInput({sessionId:session.id,scope:'test-accepted-input',actionId:randomUUID(),kind:'input',origin,payload:{text}}).input.id));
  const detachProjection=installSessionProjection(host.owner),detach=observeExecutionChanges(()=>queue.wake());
  try {
    queue.wake();await finished;
    queue.stop();
    expect(errors).toEqual([]);
    expect(calls).toHaveLength(2);expect(maximumActive).toBe(1);
    expect(inputs.map(input=>(db.query('SELECT status,owner_instance_id,dispatch_attempt FROM turns WHERE id=?').get(input.turn_id!) as any))).toEqual([
      {status:'done',owner_instance_id:null,dispatch_attempt:1},{status:'done',owner_instance_id:null,dispatch_attempt:1}]);
    expect(getSessionById(session.id)?.status).toBe('idle');
    expect(inputs.map(input=>host.owner.receipt(getAcceptedSessionInput(input.id)!).state)).toEqual(['completed','completed']);
    expect(host.owner.events().filter(event=>event.kind==='result')).toHaveLength(2);
    expect(registry.requestSessionCancellation(session.id,inputs[0]!.turn_id!)).toEqual({matched:false});
  } finally {queue.stop();detach();detachProjection();await finished;}
});

test('registry cleanup keeps same-session FIFO and Slack admission queued while unrelated sessions can advance',async()=>{
  upsertChannel({slack_channel_id:'CHANDOFF',slack_channel_name:'handoff',group_name:null,name:'handoff',vault_path:'/tmp',code_path:'/tmp',provider_default:'codex'});
  const session=createOrGetSession('CHANDOFF','1700000000.100001','codex');
  const predecessor=acquireSessionTurn(session.id,'1700000000.100001','Original','owner');
  const native=enqueueSessionInput(retainSessionInput({sessionId:session.id,scope:'return',actionId:randomUUID(),kind:'input',origin:'service',payload:{text:'Final return'}}).input.id);
  const unrelated=createNativeSession('codex',{}),other=enqueueSessionInput(retainSessionInput({sessionId:unrelated.id,scope:'other',actionId:randomUUID(),kind:'input',origin:'human',payload:{text:'Independent session'}}).input.id);
  const registry=new ActiveTurnDispatchRegistry({onStarted:()=>{},onSettled:()=>{}});
  let release!:()=>void;const cleanup=new Promise<void>(resolve=>release=resolve);
  const running=registry.run({turnId:predecessor.id,sessionId:session.id,channelId:'CHANDOFF',threadTs:'1700000000.100001'},async(_controller,close)=>{
    close();markTurnDelivering(predecessor.id,'Delivered answer','Delivered answer',0);markTurnResponseDelivered(predecessor.id);finishDeliveredTurn(predecessor.id);await cleanup;
  });
  try {
    expect(registry.dispatchSessionSteering(session.id,()=>true)).toEqual({matched:false});
    expect(registry.activeSessions).toEqual([session.id]);
    const slack=acquireSessionTurn(session.id,'1700000000.100002','Next Slack input','owner',undefined,undefined,{deferProvider:registry.activeSessions.includes(session.id)});
    expect(slack).toMatchObject({acquired:false,queued:true});
    expect(claimNextQueuedTurn('owner',Date.now(),registry.activeSessions)?.turn_id).toBe(other.turn_id);
    expect(claimNextQueuedTurn('owner',Date.now(),registry.activeSessions)).toBeNull();
    expect(db.query('SELECT status,owner_instance_id,dispatch_attempt FROM turns WHERE id=?').get(native.turn_id!)).toEqual({status:'queued',owner_instance_id:null,dispatch_attempt:0});
    release();await running;
    expect(registry.activeSessions).toEqual([]);
    expect(claimNextQueuedTurn('owner',Date.now(),registry.activeSessions)?.turn_id).toBe(native.turn_id);
    expect(db.query('SELECT status,owner_instance_id FROM turns WHERE id=?').get(slack.id)).toEqual({status:'queued',owner_instance_id:null});
  } finally {release();await running;}
});

for(const admission of [false,true])test(`native setup failure settles only its owned attempt; admission intended=${admission}`,()=>{
  const registry=new ActiveTurnDispatchRegistry({onStarted:()=>{},onSettled:()=>{}});
  const host=new SessionExecutionHost({instanceId:'owner',registry,providers:{},defaultCwd:'/tmp',wake:()=>{}});
  const session=createNativeSession('codex',{});
  const accepted=enqueueSessionInput(retainSessionInput({sessionId:session.id,scope:'failure',actionId:randomUUID(),kind:'input',origin:'service',payload:{text:'Retained final return'}}).input.id);
  const claim=claimNextQueuedTurn('owner')!;
  if(admission){markTurnProviderAdmissionIntended(claim.turn_id,'owner',claim.dispatch_attempt);db.query('UPDATE turns SET stop_requested_at=CURRENT_TIMESTAMP WHERE id=?').run(claim.turn_id);}
  expect(host.settleSetupFailure({...claim,dispatch_attempt:claim.dispatch_attempt+1},new Error('Wrong attempt'))).toBe(false);
  expect(getSessionById(session.id)?.status).toBe('running');
  expect(host.settleSetupFailure(claim,new Error('Retained setup failure'))).toBe(true);
  const row=db.query('SELECT status,owner_instance_id,agent_text,stop_requested_at FROM turns WHERE id=?').get(claim.turn_id) as any;
  expect(row).toMatchObject({status:admission?'parked':'error',owner_instance_id:null,agent_text:'Retained setup failure'});
  expect(!!row.stop_requested_at).toBe(admission);expect(getSessionById(session.id)?.status).toBe(admission?'idle':'error');
  expect(host.owner.receipt(getAcceptedSessionInput(accepted.id)!)).toMatchObject({state:admission?'uncertain':'failed',error:{message:'Retained setup failure'}});
  const next=enqueueSessionInput(retainSessionInput({sessionId:session.id,scope:'next',actionId:randomUUID(),kind:'input',origin:'human',payload:{text:'Later input'}}).input.id);
  expect(claimNextQueuedTurn('owner')?.turn_id??null).toBe(admission?null:next.turn_id);
  const before=db.query('SELECT * FROM turns WHERE id=?').get(claim.turn_id);
  expect(host.settleSetupFailure(claim,new Error('Late duplicate failure'))).toBe(false);
  expect(db.query('SELECT * FROM turns WHERE id=?').get(claim.turn_id)).toEqual(before);
});
