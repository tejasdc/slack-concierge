// A capture delivered to an Inbox session that then lost the router role must reach the new
// router: its end-of-turn filing check, its turn context, and a wake when it is overdue.
// Replays Nov 5 2026: eight captures sat on concierge:8785 unfiled until Nov 11 after failovers.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {INBOX_UNFILED_ACROSS_ROUTERS_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'concierge-unfiled-routers-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=INBOX_UNFILED_ACROSS_ROUTERS_TEST_AUTHORIZATION;

const [{db},{createNativeSession,recordSessionEvent,retainSessionInput,updateSessionMetadata},topics]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/session-topics')]);

try {
  const former=createNativeSession('codex',{title:'Inbox',summary:'Former router',inbox:true,inboxRole:'project-router',standingRole:'inbox'});
  const capture=(sessionId:number,id:string,text:string,at:string)=>{
    retainSessionInput({id,sessionId,scope:'surface:thinkering',actionId:id,kind:'inbox-capture',origin:'human',payload:{text}});
    db.query('UPDATE session_inputs SET created_at=? WHERE id=?').run(at,id);
    recordSessionEvent({eventId:`accepted:${id}`,sessionId,inputId:id,kind:'accepted',payload:{text}});
  };
  capture(former.id,'capture:left-behind','Book the dentist','2026-11-05 17:59:00');
  // The role moves (failover or stand-in bind); the former router keeps its Inbox marker.
  const current=createNativeSession('claude-code',{title:'Inbox',summary:'Current router',inbox:true,inboxRole:'project-router'});
  updateSessionMetadata(former.id,{standingRole:undefined});
  updateSessionMetadata(current.id,{standingRole:'inbox'});

  const pile=topics.unfiledInboxRoots();
  assert.deepEqual(pile.map(item=>[item.root,item.sessionId]),[['capture:left-behind',former.id]]);

  // End-of-turn check: the current router is held to it; the former one is not asked twice.
  const held=topics.unfiledReceivedInputs(current.id,0);
  assert.equal(held.length,1);
  assert.equal(held[0]!.root_id,'capture:left-behind');
  assert.equal((held[0] as any).received_by,`concierge:${former.id}`);
  assert.deepEqual(topics.unfiledReceivedInputs(former.id,0),[]);

  // Turn context: any input the current router receives lists it.
  assert.match(topics.topicPromptContext(current.id,'capture:other',{}),/unfiled-from-earlier-routers[\s\S]*capture:left-behind/);
  assert.equal(topics.topicPromptContext(former.id,'capture:other',{}).includes('unfiled-from-earlier-routers'),false);

  // Overdue: one wake for this set, then an alarm to the repair agent past the alarm age.
  const admitted:any[]=[];
  const admit=(input:any)=>{admitted.push(input);retainSessionInput({id:input.inputId,sessionId:input.sessionId,scope:'fixture',actionId:input.inputId,kind:'input',origin:'service',payload:{text:input.text}});};
  const at=Date.parse('2026-11-05T17:59:00Z');
  assert.deepEqual(topics.wakeRouterForUnfiled(current,admit,at+5*60_000),{woken:false,alarmed:0});
  assert.deepEqual(topics.wakeRouterForUnfiled(current,admit,at+topics.UNFILED_WAKE_MS),{woken:true,alarmed:0});
  assert.equal(admitted[0].sessionId,current.id);
  assert.match(admitted[0].text,/capture:left-behind/);
  assert.deepEqual(topics.wakeRouterForUnfiled(current,admit,at+topics.UNFILED_WAKE_MS+60_000),{woken:false,alarmed:0});
  assert.deepEqual(topics.wakeRouterForUnfiled(current,admit,at+topics.UNFILED_ALARM_MS),{woken:false,alarmed:1});
  assert.equal((db.query("SELECT kind FROM repair_notices WHERE key='inbox-unfiled:capture:left-behind'").get() as {kind:string}).kind,'stuck_work');
  console.log('inbox-unfiled-across-routers-fixture: a former router\'s unfiled capture reaches the current router, wakes it and alarms.');
} finally {
  rmSync(scratch,{recursive:true,force:true});
}
