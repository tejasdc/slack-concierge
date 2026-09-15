import {afterEach,beforeEach,expect,test} from 'bun:test';
import {db,upsertChannel,createOrGetSession,startTurn,createTurnSteeringMessage,markTurnSteeringMessageSending,markTurnSteeringMessageSent,markTurnProviderStarted,finishTurn,acquireSessionTurn,getSessionById} from '../src/state';
import {SessionOwner} from '../src/session-owner';
import {installSessionProjection,projectSessionProviderMessage} from '../src/session-projection';
import {acquireDatabaseTestLock} from './db-lock';

let unlock:()=>void,detach:()=>void,owner:SessionOwner;
function clear(){for(const table of ['session_owner_events','session_inputs','turn_dependencies','routed_requests','routed_input_events','comparison_requests','fork_requests','slack_thread_statuses','slack_user_input_claims','turn_steering_messages','turn_delivery_chunks','turns','sessions','channels'])db.query(`DELETE FROM ${table}`).run();}
beforeEach(async()=>{
  unlock=await acquireDatabaseTestLock();clear();
  owner=new SessionOwner({available:()=>true,wake:()=>{},steer:()=>false,stop:async()=>false},'/tmp');
  detach=installSessionProjection(owner);
  upsertChannel({slack_channel_id:'CPROJECTION',slack_channel_name:'projection',group_name:null,name:'projection',vault_path:'/tmp',code_path:'/tmp',provider_default:'codex'});
});
afterEach(()=>{detach();clear();unlock();});

test('Slack acceptance and acknowledged steering project into the sole owner without changing the original FIFO',()=>{
  const session=createOrGetSession('CPROJECTION','1700000000.100001','codex');
  const first=startTurn(session.id,'1700000000.100001','Original human request');
  const original=db.query('SELECT id,status,session_id FROM turns WHERE id=?').get(first.id);
  const steered=createTurnSteeringMessage(first.id,'1700000000.100002','The exact steering request','Prepared steering');
  markTurnSteeringMessageSending(steered.row!.id);markTurnSteeringMessageSent(steered.row!.id);
  const queued=acquireSessionTurn(session.id,'1700000000.100003','A later request','later-owner');
  expect(queued).toMatchObject({queued:true,acquired:false});
  expect(db.query('SELECT id,status,session_id FROM turns WHERE id=?').get(first.id)).toEqual(original);
  const view=owner.get(`concierge:${session.id}`);
  expect(view.operations.map(input=>input.text)).toEqual(['Original human request','The exact steering request','A later request']);
  expect(view.operations[0]!.runId).toBe(view.operations[1]!.runId);
  expect(view.operations[2]!.runId).not.toBe(view.operations[0]!.runId);
  expect(owner.events().filter(event=>event.kind==='accepted')).toHaveLength(3);
  expect(getSessionById(session.id)).toMatchObject({slack_channel_id:'CPROJECTION',slack_thread_ts:'1700000000.100001'});
});

test('later progress cannot overwrite the common terminal snapshot or dismiss new attention',()=>{
  const session=createOrGetSession('CPROJECTION','1700000000.200001','codex');
  const turn=startTurn(session.id,'1700000000.200001','Original');
  markTurnProviderStarted(turn.id);finishTurn(turn.id,'done','Retained answer');
  const terminal=owner.events().filter(event=>event.kind==='run').at(-1)!;
  expect(terminal.payload.run.state).toBe('completed');
  const generation=owner.get(`concierge:${session.id}`).session.generation;
  markTurnProviderStarted(turn.id);
  expect(owner.events().filter(event=>event.kind==='run').at(-1)).toEqual(terminal);
  expect(owner.get(`concierge:${session.id}`).session.generation).toBe(generation);
  expect(owner.events().filter(event=>event.kind==='result')).toHaveLength(1);
});

test('exact provider message updates retain IDs and details while replay and late updates cannot duplicate or change terminal state',()=>{
  const session=createOrGetSession('CPROJECTION','1700000000.300001','codex');
  const turn=startTurn(session.id,'1700000000.300001','Original');
  db.query('UPDATE turns SET provider_turn_id=? WHERE id=?').run('native-turn',turn.id);
  const running={id:'native-tool-id',turnId:'native-turn',role:'tool' as const,content:'',tool:'read',phase:'inProgress',detailKey:'exact-detail'};
  projectSessionProviderMessage(turn.id,running);projectSessionProviderMessage(turn.id,running);
  projectSessionProviderMessage(turn.id,{...running,phase:'completed'});
  projectSessionProviderMessage(turn.id,{id:'native-answer-id',turnId:'native-turn',role:'assistant',content:'Exact answer',tool:null,phase:'final'});
  expect(()=>projectSessionProviderMessage(turn.id,{...running,turnId:'unrelated-turn'})).toThrow('active native execution');
  const messages=owner.events().filter(event=>event.kind==='message');
  expect(messages.map(event=>event.payload.message.id)).toEqual(['native-tool-id','native-tool-id','native-answer-id']);
  expect(messages[1]!.payload.message).toMatchObject({phase:'completed',detailKey:'exact-detail'});
  finishTurn(turn.id,'done','Exact answer');projectSessionProviderMessage(turn.id,{...running,phase:'late'});
  expect(owner.events().filter(event=>event.kind==='message')).toEqual(messages);
  expect(owner.run(messages[0]!.runId!).state).toBe('completed');
});
