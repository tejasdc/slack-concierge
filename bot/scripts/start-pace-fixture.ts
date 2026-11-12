// Offline replay of the 2026-11-12 release burst on a paced machine: held work released together starts
// three at a time, in the agent's order, each held turn knows its place, a human message and the
// Inbox router are never held, memory pressure holds starts, and an unpaced machine is untouched.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {START_PACE_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'concierge-start-pace-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=START_PACE_TEST_AUTHORIZATION;

const [{db,claimNextQueuedTurn,nextQueuedTurnAttemptMs},{createNativeSession,retainSessionInput,enqueueSessionInput},
  pace,{receiptStatusFromFacts}]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/start-pace'),import('../src/session-receipt-status')]);
const OWNER='start-pace-fixture';
function queued(name:string,origin:'human'|'agent'|'service'='agent'){
  const session=createNativeSession('codex',{title:name,summary:undefined,purpose:'develop',origin:'native'});
  const input=retainSessionInput({id:name,sessionId:session.id,scope:'fixture',actionId:name,kind:'input',origin,payload:{text:name}}).input;
  enqueueSessionInput(input.id);
  return (db.query('SELECT id FROM turns WHERE session_id=?').get(session.id) as {id:number}).id;
}
const row=(id:number)=>db.query('SELECT status,dispatch_hold,dispatch_next_attempt_ms AS at FROM turns WHERE id=?').get(id) as {status:string;dispatch_hold:string|null;at:number};

try{
  // Unpaced: the claim is exactly today's, one start after another with no hold.
  const plain=Array.from({length:5},(_,i)=>queued(`plain-${i}`));
  const T0=Date.now();
  const unpaced=[1,2,3,4,5].map(()=>claimNextQueuedTurn(OWNER,T0)?.turn_id);
  assert.deepEqual(unpaced,plain,'an unpaced machine starts everything at once');
  assert.equal((db.query('SELECT count(*) AS n FROM start_pace_starts').get() as {n:number}).n,0);

  process.env.CONCIERGE_START_PACE_BUDGET='3';
  const config=pace.startPaceConfig()!;
  assert.deepEqual([config.budget,config.windowMs,config.jitterMs],[3,120_000,30_000]);
  const held=Array.from({length:8},(_,i)=>queued(`held-${i}`));
  const T=T0+1_000;
  const started=[1,2,3,4,5,6,7,8,9].map(()=>claimNextQueuedTurn(OWNER,T)?.turn_id??null);
  assert.deepEqual(started.slice(0,3),held.slice(0,3),'three start now, oldest first');
  assert.ok(started.slice(3).every(id=>id===null),'no fourth start in the window');
  const waiting=held.slice(3).map(row);
  assert.deepEqual(waiting.map(w=>w.dispatch_hold),['start_pace:1','start_pace:2','start_pace:3','start_pace:4','start_pace:5']);
  assert.equal(waiting[0]!.at,waiting[2]!.at,'a group shares one instant');
  assert.ok(waiting[0]!.at>=T+config.windowMs,'the first group waits for the window to free');
  assert.ok(waiting[3]!.at>=waiting[0]!.at+config.windowMs,'the next group follows by a full window');
  assert.ok(waiting[3]!.at-waiting[0]!.at<=config.windowMs+config.jitterMs,'jitter is bounded');
  assert.equal(nextQueuedTurnAttemptMs(T),waiting[0]!.at,'the existing wake clock is the scheduler');

  // The agent's order replaces the oldest-first fallback.
  const ids=pace.startsToOrder(db,config);
  assert.equal(ids.length,5);
  const reversed=[...ids].reverse().map(turnId=>({turnId,reason:'later work first'}));
  db.transaction(()=>{pace.storeOrder(db,ids,reversed,T);pace.slotWaitingStarts(db,T,config);})();
  assert.equal(pace.startsToOrder(db,config).length,0,'not asked again until new starts join');
  assert.equal(row(held[7]!).dispatch_hold,'start_pace:1');
  const at=row(held[7]!).at;
  assert.equal(claimNextQueuedTurn(OWNER,at-1),null,'nothing starts before its slot');
  const second=[1,2,3,4].map(()=>claimNextQueuedTurn(OWNER,at+1)?.turn_id??null);
  assert.deepEqual(second.slice(0,3),[held[7],held[6],held[5]],'the second group starts in the agent order');
  assert.equal(second[3],null);
  assert.deepEqual([held[4]!,held[3]!].map(id=>row(id).dispatch_hold),['start_pace:1','start_pace:2'],'those left move up in place');
  const status=receiptStatusFromFacts({id:'i',session_id:1,kind:'input',request_id:null,origin:'agent'},
    {turn:{id:held[4]!,status:'queued',agent_text:null,dispatch_failure_class:'backoff',dispatch_next_attempt_ms:Date.now()+60_000,dispatch_attempt:0,dispatch_hold:'start_pace:7'},steering:null,state:'queued'},{},
    {retry:()=>null,outage:()=>null,requestWait:()=>({after:false,held:null}),savedTurn:()=>null,continuationRefusal:()=>null,
      session:()=>({status:'idle',providerId:'codex',suspended:false,outside:false}),otherLiveTurn:()=>false,deploymentHold:()=>false,
      focusHold:()=>null,olderBlockingTurn:()=>null,dependencyPending:()=>false,now:()=>Date.now(),formatTime:()=>'3:12 PM'});
  assert.match(status!.message,/Waiting its turn: 7th, starts about 3:12 PM/);

  // A direct human message and the Inbox router are never held for the budget.
  const human=queued('human-message','human');
  assert.equal(claimNextQueuedTurn(OWNER,at+2)?.turn_id,human,'he is waiting; his message starts at once');

  // Memory pressure: warning holds paced starts a slot, critical holds everyone.
  const sample={turnId:1,exempt:false};
  assert.deepEqual(pace.decideStart(db,sample,at+10_000,config,1).admit,pace.decideStart(db,sample,at+10_000,config,1).admit);
  const warn=pace.decideStart(db,sample,Date.now()+10*60_000,config,2);
  assert.ok(!warn.admit&&warn.hold===pace.START_MEMORY_HOLD&&warn.nextMs>Date.now()+10*60_000);
  assert.equal(pace.decideStart(db,{turnId:1,exempt:true},Date.now()+10*60_000,config,2).admit,true,'warning does not hold his own message');
  assert.equal(pace.decideStart(db,{turnId:1,exempt:true},Date.now()+10*60_000,config,4).admit,false,'critical holds even his message');

  // The agent's answer is only trusted when it names each waiting turn exactly once.
  assert.equal(pace.parseOrder('[{"id":1,"reason":"a"},{"id":1,"reason":"b"}]',[1,2]),null);
  assert.equal(pace.parseOrder('[{"id":1}]',[1,2]),null);
  assert.deepEqual(pace.parseOrder('Sure:\n[{"id":2,"reason":"x"},{"id":1,"reason":"y"}]',[1,2]),[{turnId:2,reason:'x'},{turnId:1,reason:'y'}]);
  assert.equal(pace.startPaceConfig({CONCIERGE_START_PACE_BUDGET:'0'}),null);
  assert.equal(pace.ordinal(11),'11th');assert.equal(pace.ordinal(22),'22nd');
  const {claudeAgentSettings,claudeCodeArgs,CLAUDE_AGENT_HOOK_SETTINGS}=await import('../src/claude-code');
  assert.equal(claudeAgentSettings({}),CLAUDE_AGENT_HOOK_SETTINGS,'without the setting a session launches as before');
  const shared=claudeAgentSettings({CONCIERGE_SHARED_PLAYWRIGHT_URL:'http://127.0.0.1:8931/mcp'});
  assert.equal(JSON.parse(shared).enabledPlugins['playwright@claude-plugins-official'],false);
  assert.ok(JSON.parse(shared).hooks.Stop,'the existing hooks are kept');
  assert.ok(!claudeCodeArgs({prompt:'x',additionalDirs:[],sessionUUID:null}).includes('--mcp-config'));
  process.env.CONCIERGE_SHARED_PLAYWRIGHT_URL='http://127.0.0.1:8931/mcp';
  const withShared=claudeCodeArgs({prompt:'x',additionalDirs:['/a'],sessionUUID:null});
  assert.equal(JSON.parse(withShared[withShared.indexOf('--mcp-config')+1]!).mcpServers.playwright.url,'http://127.0.0.1:8931/mcp');
  assert.ok(withShared.indexOf('--mcp-config')<withShared.indexOf('--add-dir'),'variadic flags stay before the trailing ones');
  assert.ok(!claudeCodeArgs({prompt:'x',additionalDirs:[],sessionUUID:null,interactionPolicy:'consultation-only'}).join(' ').includes('8931'),'a restricted consultation never gets the browser');
  console.log('start-pace-fixture: paced starts, agent order, places, exemptions and memory gate hold.');
}finally{
  rmSync(scratch,{recursive:true,force:true});
}
