// Codex session concierge:8245 finished every turn since 2026-11-13 without acknowledging its input,
// yet search still showed it as able to take messages. Checks the derived three-in-a-row state:
// the view says it cannot take messages, an agent's ask is refused, his own message is still accepted,
// and one acknowledged turn clears it.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {INPUT_REFUSAL_STREAK_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'concierge-input-refusal-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=INPUT_REFUSAL_STREAK_TEST_AUTHORIZATION;

const [{db,claimNextQueuedTurn,markTurnProviderAdmissionIntended,acknowledgeTurnProviderInput,getSessionById},
  {SessionOwner,sessionAddress},{SessionCommunicationCoordinator},{createNativeSession,nativeRunId},{inputRefusalStreak}]=await Promise.all([
  import('../src/state'),import('../src/session-owner'),import('../src/session-communication'),import('../src/session-inputs'),import('../src/request-standing')]);

const errors:unknown[]=[];
const owner=new SessionOwner({available:()=>true,wake:()=>{},stop:async()=>false,steer:()=>false},scratch);
const communication=new SessionCommunicationCoordinator({owner,isOwnerAlive:()=>true,onError:error=>errors.push(error)});
owner.communication=communication;

let tick=0;
function turn(sessionId:number,kind:'refused'|'acknowledged'|'historical'){
  const stamp=`2026-11-1${++tick%10} 10:00:00`;
  const refused=kind!=='acknowledged';
  const outbound=kind==='historical'?JSON.stringify({version:1,result:{text:'',toolsUsed:[]}}):null;
  return Number(db.query(`INSERT INTO turns(session_id,slack_user_msg_ts,user_text,agent_text,status,started_at,ended_at,
      provider_input_acknowledged_at,dispatch_failure_class,outbound_text) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(sessionId,`fixture-${sessionId}-${tick}`,'work',
      kind==='refused'?'CODEX_INPUT_NOT_ACKNOWLEDGED: Codex completed native turn t without acknowledging the input.':kind==='historical'?'':'done',
      kind==='refused'?'parked':'done',stamp,stamp,refused?null:stamp,kind==='refused'?'parked_terminal':null,outbound).lastInsertRowid);
}
const make=(title:string)=>createNativeSession('codex',{title,summary:undefined,purpose:'chat',origin:'native'});
const view=(id:number)=>owner.view(getSessionById(id)!) as any;
const planFor=(id:number)=>(db.query("EXPLAIN QUERY PLAN SELECT id FROM turns INDEXED BY turns_session_latest WHERE session_id=? AND status IN ('done','parked','error') ORDER BY id DESC LIMIT 200").all(id) as any[]).map(r=>r.detail).join(' | ');

try{
  communication.start();await communication.idle();

  const two=make('two refusals');turn(two.id,'refused');turn(two.id,'refused');
  assert.equal(inputRefusalStreak(db,two.id),null,'two in a row is not marked');
  assert.equal(view(two.id).capabilities.send,true);
  assert.equal(view(two.id).inputRefused,null);

  const three=make('three refusals');const first=turn(three.id,'refused');turn(three.id,'historical');const last=turn(three.id,'refused');
  const marked=view(three.id);
  assert.equal(marked.capabilities.send,false);assert.equal(marked.capabilities.steer,false);
  assert.match(marked.capabilities.reason,/Cannot take messages: its last 3 turns since 2026-11-\d\d ended without taking their input/);
  assert.match(marked.capabilities.reason,/codex-recover/);
  assert.deepEqual(marked.inputRefused&&{count:marked.inputRefused.count,lastTurnId:marked.inputRefused.lastTurnId},{count:3,lastTurnId:last});
  assert.ok(first<last&&typeof marked.inputRefused.since==='string');
  assert.match(planFor(three.id),/turns_session_latest/,'the streak reads the existing session index');

  const mixed=make('acknowledged in the middle');turn(mixed.id,'refused');turn(mixed.id,'acknowledged');turn(mixed.id,'refused');turn(mixed.id,'refused');
  assert.equal(inputRefusalStreak(db,mixed.id),null,'an acknowledged turn among the latest three breaks it');
  assert.equal(view(mixed.id).capabilities.send,true);

  // An agent's ask is refused before anything is admitted; a human message is still accepted.
  await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text:'Asker'}});
  const claim=claimNextQueuedTurn('refusal-fixture')!;
  assert.ok(claim);
  assert.equal(markTurnProviderAdmissionIntended(claim.turn_id,'refusal-fixture',claim.dispatch_attempt),true);
  acknowledgeTurnProviderInput(claim.turn_id,'refusal-fixture',claim.dispatch_attempt,[]);
  const source={input_id:claim.accepted_input_id!,run_id:nativeRunId(claim.turn_id)};
  const before=(db.query('SELECT count(*) AS n FROM session_communication_requests').get() as {n:number}).n;
  const address=sessionAddress(getSessionById(three.id)!);
  await assert.rejects(()=>communication.ask({source,action_id:'ask-refusing',address,text:'Do this work',summary:'Work',requestedEffect:'work'}) as Promise<unknown>,
    /Cannot take messages: its last 3 turns/);
  assert.equal((db.query('SELECT count(*) AS n FROM session_communication_requests').get() as {n:number}).n,before,'nothing was admitted');
  const okAddress=sessionAddress(getSessionById(two.id)!);
  assert.ok((await communication.ask({source,action_id:'ask-fine',address:okAddress,text:'Do this work',summary:'Work',requestedEffect:'work'}) as {request_id:string}).request_id,
    'an unmarked session still takes an ask');

  assert.equal(owner.canSend(getSessionById(three.id)!),true,'delivery, recovery and handoff still see a messageable session');
  const human=owner.submit(`concierge:${three.id}`,{clientActionId:randomUUID(),text:'Are you there?'}) as any;
  assert.ok(human.operation,'his own message is accepted');

  // The next turn that takes its input clears it by itself.
  turn(three.id,'acknowledged');
  assert.equal(inputRefusalStreak(db,three.id),null);
  assert.equal(view(three.id).capabilities.send,true);assert.equal(view(three.id).inputRefused,null);

  // A longer streak counts its full length.
  const long=make('thirteen refusals');for(let i=0;i<13;i++)turn(long.id,'refused');
  assert.equal(view(long.id).inputRefused.count,13);

  assert.deepEqual(errors,[]);
  console.log('input refusal streak fixture: three unacknowledged turns refuse agent asks and show why; his message and one acknowledged turn behave');
}finally{
  await communication.stop?.();
  rmSync(scratch,{recursive:true,force:true});
}
