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

const [{db},{createNativeSession,recordSessionEvent,retainSessionInput,updateSessionMetadata},topics,repairNotices]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/session-topics'),import('../src/repair-notices')]);

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
  db.query("UPDATE sessions SET native_metadata_json=json_remove(native_metadata_json,'$.standingRole') WHERE id=?").run(former.id);
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
  assert.deepEqual(topics.wakeRouterForUnfiled(current,admit,at+topics.UNFILED_ALARM_MS),{woken:true,alarmed:1});
  assert.match(admitted[1].text,/at least 30 minutes/);
  assert.notEqual(admitted[1].inputId,admitted[0].inputId);
  assert.deepEqual(topics.wakeRouterForUnfiled(current,admit,at+topics.UNFILED_ALARM_MS+60_000),{woken:false,alarmed:0});
  assert.equal((db.query("SELECT kind FROM repair_notices WHERE key='inbox-unfiled:capture:left-behind'").get() as {kind:string}).kind,'stuck_work');
  const alertKey = 'inbox-unfiled:capture:left-behind';
  const recoveryKey = alertKey + ':filed';
  repairNotices.markRepairNoticesDelivered(db,[alertKey],'fixture:repair-alert');
  // A busy router is still notified at thirty minutes. Retaining a reminder does not
  // replace its running turn or resubmit the original capture.
  db.query("INSERT INTO inbox_topic_roots(root_input_id,topic_id) VALUES(?,?)").run('capture:left-behind','topic:filed');
  capture(former.id,'capture:arrived-during-work','Inspect this new capture','2026-11-05 17:59:00');
  const turn=db.query("INSERT INTO turns(session_id,slack_user_msg_ts,user_text,status) VALUES(?,?,?,'running') RETURNING id")
    .get(current.id,'fixture:busy','Existing unrelated work') as {id:number};
  const before=admitted.length;
  assert.deepEqual(topics.wakeRouterForUnfiled(current,admit,at+topics.UNFILED_WAKE_MS),{woken:false,alarmed:0});
  assert.deepEqual(topics.wakeRouterForUnfiled(current,admit,at+topics.UNFILED_ALARM_MS-1),{woken:false,alarmed:0});
  assert.deepEqual(topics.wakeRouterForUnfiled(current,admit,at+topics.UNFILED_ALARM_MS),{woken:true,alarmed:0});
  assert.equal(admitted.length,before+1);
  assert.equal(admitted.at(-1).origin,'service');
  assert.match(admitted.at(-1).text,/capture:arrived-during-work/);
  assert.doesNotMatch(admitted.at(-1).text,/capture:left-behind/);
  assert.equal((db.query('SELECT status FROM turns WHERE id=?').get(turn.id) as {status:string}).status,'running');
  assert.deepEqual(topics.wakeRouterForUnfiled(current,admit,at+60*60_000),{woken:false,alarmed:0});
  // Restart/queue state reuses the retained reminder identity; a new router must receive
  // its own reminder for the same backlog rather than inheriting the old router's silence.
  db.query("UPDATE turns SET status='queued' WHERE id=?").run(turn.id);
  assert.deepEqual(topics.wakeRouterForUnfiled(current,admit,at+61*60_000),{woken:false,alarmed:1});
  const successor=createNativeSession('codex',{title:'Inbox successor',summary:'Next router',inbox:true,inboxRole:'project-router'});
  db.query("UPDATE sessions SET native_metadata_json=json_remove(native_metadata_json,'$.standingRole') WHERE id=?").run(current.id);
  updateSessionMetadata(successor.id,{standingRole:'inbox'});
  assert.deepEqual(topics.wakeRouterForUnfiled(successor,admit,at+62*60_000),{woken:true,alarmed:0});
  assert.equal(admitted.at(-1).sessionId,successor.id);
  assert.notEqual(admitted.at(-1).inputId,admitted.at(-2).inputId);
  db.query("INSERT INTO inbox_topic_roots(root_input_id,topic_id) VALUES(?,?)").run('capture:arrived-during-work','topic:filed');
  assert.deepEqual(topics.wakeRouterForUnfiled(successor,admit,at+63*60_000),{woken:false,alarmed:0});
  assert.equal((db.query("SELECT resolved_at_ms FROM repair_notices WHERE key='inbox-unfiled:capture:arrived-during-work'").get() as {resolved_at_ms:number|null}).resolved_at_ms!==null,true);
  // An old duplicate awaiting delivery must be skipped even before the next upkeep pass.
  const legacyRecoveryKey = recoveryKey + ':filed';
  repairNotices.recordRepairNotice(db,{key:legacyRecoveryKey,kind:'stuck_work',text:'Legacy duplicate recovery'});
  assert.deepEqual(repairNotices.pendingRepairNotices(db).map(notice=>notice.key),[recoveryKey]);
  repairNotices.markRepairNoticesDelivered(db,[recoveryKey],'fixture:repair-recovery');
  // A duplicate previously delivered by the old release must also be terminal.
  repairNotices.markRepairNoticesDelivered(db,[legacyRecoveryKey],'fixture:legacy-recovery');
  for (const minute of [64,65]) {
    assert.deepEqual(topics.wakeRouterForUnfiled(successor,admit,at+minute*60_000),{woken:false,alarmed:0});
    assert.deepEqual(repairNotices.pendingRepairNotices(db),[]);
  }
  console.log('inbox-unfiled-across-routers-fixture: predecessor filing custody, idle wake, busy/queued thirty-minute reminder, deduplication, role change and filed cleanup pass.');
} finally {
  rmSync(scratch,{recursive:true,force:true});
}
