// A reply he typed inside a thread, carried to the working agent as a request, stays in that
// thread after the Inbox router hands off to a new session, and the thread the Nov 5
// conversion made from such a request is merged back once. Replays 2026-11-05: twelve forwarded
// replies became threads titled "No, no, no, no." and the like
// (docs/incidents/2026-11-16-forwarded-replies-became-threads.md).
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {THREAD_SURVIVES_ROUTER_HANDOFF_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'concierge-thread-handoff-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=THREAD_SURVIVES_ROUTER_HANDOFF_TEST_AUTHORIZATION;

const [{db},{createNativeSession,recordSessionEvent,retainSessionInput},topics,inbox,{inboxRootResolver}]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/session-topics'),import('../src/session-inbox'),import('../src/presentation-message-source')]);

try {
  const router=createNativeSession('codex',{title:'Inbox',summary:'Router before the handoff',inbox:true,inboxRole:'project-router',standingRole:'inbox'});
  const worker=createNativeSession('claude-code',{title:'Why the server slowed today',summary:'Worker on the thread'});
  const turn=(db.query("INSERT INTO turns(session_id,saved_kind,status,user_text) VALUES(?,NULL,'completed','') RETURNING id").get(router.id) as {id:number}).id;
  const accepted=(id:string,kind:string,payload:any)=>{
    retainSessionInput({id,sessionId:router.id,scope:'surface:thinkering',actionId:id,kind,origin:'human',payload});
    recordSessionEvent({eventId:`accepted:${id}`,sessionId:router.id,inputId:id,kind:'accepted',payload:{text:payload.text}});
  };
  // His thread and his reply inside it.
  const capture='capture:server-stays-responsive';
  accepted(capture,'inbox-capture',{text:'Why does the server slow down while agents work?'});
  const at=new Date().toISOString(),by={kind:'owner',sessionId:`concierge:${router.id}`};
  const placed=(root:string,title:string,recovered:boolean)=>{
    const topicId=`topic:${randomUUID()}`;
    const topic={topicId,sessionId:router.id,title,summary:'',state:'open',setAside:null,aliases:[],revision:1,recovered,
      readSequence:0,closure:null,createdBy:by,createdAt:at,updatedAt:at};
    const request={requestId:`req:${randomUUID()}`,topicId,title,brief:'',state:'open',disposition:null,revision:1,
      sources:[{inputId:root}],dispatches:[],closure:null,createdAt:at,updatedAt:at};
    const payload={change:'created',topicId,topic,roots:[{rootInputId:root,topicId,placedAt:at,placedBy:by,reason:recovered?'migration':'fixture'}],
      request,questions:[],by,reason:'fixture',revision:1,recovered};
    recordSessionEvent({eventId:`topic-fixture:${root}`,sessionId:router.id,kind:'topic',payload});
    topics.applyTopicChange('topic',payload);
    return topicId;
  };
  const thread=placed(capture,'A server that stays responsive while agents work',false);
  const reply='reply-no-no-no';
  accepted(reply,'input',{text:'No, no, no, no. This is where you are hooked up again.',replyToMessage:{kind:'message',messageId:capture}});
  assert.equal(inbox.inboxThreadRoot(router.id,reply),capture);

  // The forward exactly as the communication layer records it: a request row naming the
  // thread, the send in the router's transcript and the worker's own input.
  const requestId=randomUUID(),sent=`request:${requestId}`;
  const payload=JSON.stringify({address:'fixture',text:'No, no, no, no.',requestedEffect:'work',thread:capture,forwardedReply:{inboxInputId:reply,topicId:thread}});
  db.query(`INSERT INTO session_communication_requests(request_id,source_turn_id,source_session_id,action_id,target_session_id,payload_json,payload_hash,
    due_at_ms,created_at_ms,source_input_id,target_input_id,thread_root_input_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(requestId,turn,router.id,`forward:${reply}`,worker.id,payload,'fixture',Date.now(),Date.now(),reply,sent,capture);
  retainSessionInput({id:sent,sessionId:worker.id,scope:`session:${reply}`,actionId:sent,kind:'input',origin:'agent',
    payload:{text:'Session request: a reply Tejas wrote inside the thnkr.ing Inbox thread you are working on.\n\nNo, no, no, no.'},sourceInputId:reply,requestId});
  const operation=retainSessionInput({sessionId:router.id,scope:`communication:${reply}`,actionId:`forward:${reply}`,kind:'request',origin:'human',
    payload:{text:'No, no, no, no.',sourceInputId:reply,forwardedReply:true},sourceInputId:reply,requestId});
  recordSessionEvent({eventId:sent,sessionId:router.id,inputId:operation.input.id,kind:'request',payload:{requestId,targetSessionId:`concierge:${worker.id}`}});
  assert.equal(inbox.inboxThreadRoot(router.id,sent),capture,'the forward belongs to the thread it was sent from');

  // The router hands off while the forward is still open: custody of the open request moves.
  const successor=createNativeSession('claude-code',{title:'Inbox',summary:'Router after the handoff',inbox:true,inboxRole:'project-router',standingRole:'inbox'});
  db.query(`INSERT INTO session_handoffs(id,predecessor_session_id,successor_session_id,state,action_id,
    caller_session_id,reason,requesting_input_id,requesting_run_id,inventory_json,inventory_digest)
    VALUES(?,?,?,'accepted','fixture-action',?,'provider-change','fixture-request','fixture-run','{}','fixture-digest')`)
    .run('fixture-router-handoff',router.id,successor.id,router.id);
  db.query('UPDATE session_communication_requests SET source_session_id=? WHERE request_id=?').run(successor.id,requestId);
  topics.invalidateTopicRoots();
  for(const sessionId of [router.id,successor.id])
    assert.equal(inbox.inboxThreadRoot(sessionId,sent),capture,'custody moved; the thread did not');
  // The Inbox page's prepared read resolves threads with its own copy of the rule.
  for(const sessionId of [router.id,successor.id])
    assert.equal(inboxRootResolver(db)(sessionId,sent),capture,'the prepared Inbox view keeps it in its thread');
  assert.equal(inbox.requestThreadSource(successor.id,requestId),capture,'its returns file under the same thread');
  assert.equal(inbox.requestThreadSource(router.id,requestId),capture);

  // The Nov 5 conversion had already given the forward a thread of its own. It goes back once,
  // and his thread keeps its name without the first words of his reply as another name.
  // A conversion thread someone has since re-placed into is left alone: it may be kept on purpose.
  const kept=placed(`request:${randomUUID()}`,'Kept on purpose',true);
  const keptRoot=(db.query('SELECT root_input_id FROM inbox_topic_roots WHERE topic_id=?').get(kept) as {root_input_id:string}).root_input_id;
  db.query("UPDATE inbox_topic_roots SET reason='placed by the router' WHERE topic_id=?").run(kept);
  db.query(`INSERT INTO session_communication_requests(request_id,source_turn_id,source_session_id,action_id,target_session_id,payload_json,payload_hash,
    due_at_ms,created_at_ms,source_input_id,target_input_id,thread_root_input_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(keptRoot.slice('request:'.length),turn,successor.id,'kept-action',worker.id,'{}','fixture',Date.now(),Date.now(),reply,keptRoot,capture);
  const split=placed(sent,'No, no, no, no.',true);
  assert.deepEqual(topics.rejoinThreadsSplitAtHandoff(),{merged:1,unclear:0});
  const closed=db.query('SELECT state,closure_json FROM inbox_topics WHERE topic_id=?').get(split) as {state:string;closure_json:string};
  assert.equal(closed.state,'closed');
  assert.equal((db.query('SELECT state FROM inbox_topics WHERE topic_id=?').get(kept) as {state:string}).state,'open','a touched thread stays');
  assert.equal(JSON.parse(closed.closure_json).into,thread);
  assert.equal((db.query('SELECT topic_id FROM inbox_topic_roots WHERE root_input_id=?').get(sent) as {topic_id:string}).topic_id,thread);
  assert.deepEqual(JSON.parse((db.query('SELECT aliases_json FROM inbox_topics WHERE topic_id=?').get(thread) as {aliases_json:string}).aliases_json),[]);
  assert.deepEqual(topics.rejoinThreadsSplitAtHandoff(),{merged:0,unclear:0},'the repair runs once');
  console.log('thread-survives-router-handoff-fixture: a forwarded reply stays in its thread across a router handoff, and the split thread is merged back once.');
} finally {
  rmSync(scratch,{recursive:true,force:true});
}
