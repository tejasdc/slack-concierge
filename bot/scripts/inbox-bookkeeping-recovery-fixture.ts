import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {INBOX_BOOKKEEPING_RECOVERY_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'concierge-inbox-bookkeeping-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=INBOX_BOOKKEEPING_RECOVERY_TEST_AUTHORIZATION;

const [{db},{createNativeSession,recordSessionEvent,retainSessionInput},topics]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/session-topics')]);

try {
  const inbox=createNativeSession('codex',{title:'Inbox recovery fixture',summary:'Inbox recovery fixture',inbox:true});
  const accepted=(origin:'human'|'agent'|'service',id:string,text:string,sourceInputId?:string,requestId?:string)=>{
    retainSessionInput({id,sessionId:inbox.id,scope:origin==='human'?'surface:thinkering':`session:${sourceInputId??id}`,
      actionId:randomUUID(),kind:'input',origin,payload:{text},sourceInputId,requestId});
    recordSessionEvent({eventId:`accepted:${id}`,sessionId:inbox.id,inputId:id,kind:'accepted',payload:{text}});
  };
  const human=`human-${randomUUID()}`;
  accepted('human',human,'Please keep this work open.');
  const agentWork=`request:${randomUUID()}`;
  accepted('agent',agentWork,'I am doing the work you requested.',human,agentWork.slice('request:'.length));
  const returned=`return:${randomUUID()}`;
  accepted('service',returned,'The agent answered the earlier request.',agentWork,agentWork.slice('request:'.length));
  const upkeep=`thread-upkeep:${randomUUID()}`;
  accepted('service',upkeep,'The original work still needs attention.',agentWork,agentWork.slice('request:'.length));
  const groupedUpkeep=`thread-upkeep:${randomUUID()}`;
  accepted('service',groupedUpkeep,'The returned result needs no new request.',agentWork,agentWork.slice('request:'.length));
  assert.equal(topics.migrateInboxTopics().migrated,true);
  assert.deepEqual((db.query('SELECT count(*) AS n FROM inbox_requests').get() as {n:number}).n,1);
  for(const root of [agentWork,returned,upkeep,groupedUpkeep])
    assert.equal(db.query('SELECT 1 FROM inbox_topic_roots WHERE root_input_id=?').get(root),null);

  // Older versions already recovered these service and agent roots. Recreate their
  // retained migration events and projections, including work assigned later.
  const at=new Date().toISOString(),by={kind:'owner',sessionId:`concierge:${inbox.id}`};
  const recovered=(root:string,roots:string[]=[],laterDispatch:boolean|string=false)=>{
    const topicId=`topic:${randomUUID()}`,requestId=`req:${randomUUID()}`;
    const topic={topicId,sessionId:inbox.id,title:'Recovered thread',summary:'',state:'open',setAside:null,
      aliases:[],revision:1,recovered:true,readSequence:0,closure:null,createdBy:by,createdAt:at,updatedAt:at};
    const request={requestId,topicId,title:topic.title,brief:'',state:'open',disposition:null,revision:1,
      sources:[{inputId:root}],dispatches:[],closure:null,createdAt:at,updatedAt:at};
    const payload={change:'created',topicId,topic,roots:[root,...roots].map(rootInputId=>({rootInputId,topicId,placedAt:at,placedBy:by,reason:'old migration'})),
      request,questions:[],by,reason:'old migration',revision:1,recovered:true};
    recordSessionEvent({eventId:`topic-migration:${root}`,sessionId:inbox.id,kind:'topic',payload});
    topics.applyTopicChange('topic',payload);
    if(laterDispatch){
      const updatedAt=new Date().toISOString();
      const dispatchId=typeof laterDispatch==='string'?laterDispatch:randomUUID();
      const assigned={...request,dispatches:[{requestId:dispatchId}],revision:2,updatedAt};
      const next={...topic,revision:2,updatedAt};
      const assignment={change:'linked',topicId,topic:next,request:assigned,by,reason:'later agent work',revision:2};
      recordSessionEvent({eventId:`assigned:${root}`,sessionId:inbox.id,kind:'topic_request',payload:assignment});
      topics.applyTopicChange('topic_request',assignment);
    }
    return requestId;
  };
  const serviceReturn=recovered(returned,[groupedUpkeep]);
  const serviceUpkeep=recovered(upkeep);
  const laterUpkeep=`thread-upkeep:${randomUUID()}`;
  accepted('service',laterUpkeep,'A later assignment is still working.',agentWork,agentWork.slice('request:'.length));
  const assignedUpkeep=recovered(laterUpkeep,[],true);
  const agentRequest=recovered(agentWork);
  const mixedReturn=`return:${randomUUID()}`,laterHuman=`human-${randomUUID()}`;
  accepted('service',mixedReturn,'A return beside a human message.',agentWork,agentWork.slice('request:'.length));
  accepted('human',laterHuman,'I still need an answer.');
  const mixedRoot=recovered(mixedReturn,[laterHuman]);
  const questionedReturn=`return:${randomUUID()}`;
  accepted('service',questionedReturn,'A return with an unresolved question.',agentWork,agentWork.slice('request:'.length));
  const questionedRequest=recovered(questionedReturn);
  const questionedTopic=(db.query('SELECT topic_id FROM inbox_requests WHERE request_id=?').get(questionedRequest) as {topic_id:string}).topic_id;
  db.query('INSERT INTO inbox_questions (question_id,topic_id) VALUES (?,?)').run(`question:${randomUUID()}`,questionedTopic);
  // Other service notices (budget, area suggestion, cut-off turn) are not his requests either.
  const budgetNotice=`budget-room-v1:${randomUUID()}`;
  accepted('service',budgetNotice,'Claude allowance is almost used.');
  const serviceBudget=recovered(budgetNotice);
  // A return whose thread later got a link to work whose home thread's request lists it: that request keeps it.
  const ownedWork=`request:${randomUUID()}`,ownedWorkId=ownedWork.slice('request:'.length);
  accepted('agent',ownedWork,'Other delegated work, tracked in its own thread.',human,ownedWorkId);
  const ownedRequest=recovered(ownedWork,[],ownedWorkId);
  const linkedReturn=`return:${randomUUID()}`;
  accepted('service',linkedReturn,'The agent answered; the router linked other work.',agentWork,agentWork.slice('request:'.length));
  const linkedElsewhere=recovered(linkedReturn,[],ownedWorkId);
  // Work homed in another thread whose request never listed it: closing here would hide it, so it stays open.
  const untrackedWork=`request:${randomUUID()}`,untrackedWorkId=untrackedWork.slice('request:'.length);
  accepted('agent',untrackedWork,'Delegated work placed but never linked.',human,untrackedWorkId);
  const untrackedRequest=recovered(untrackedWork);
  const untrackedReturn=`return:${randomUUID()}`;
  accepted('service',untrackedReturn,'A return linked to untracked work.',agentWork,agentWork.slice('request:'.length));
  const linkedUntracked=recovered(untrackedReturn,[],untrackedWorkId);
  // Work whose home request already closed is tracked nowhere open, so the linking thread stays open too.
  const closedWork=`request:${randomUUID()}`,closedWorkId=closedWork.slice('request:'.length);
  accepted('agent',closedWork,'Delegated work whose own request closed.',human,closedWorkId);
  const closedHome=recovered(closedWork,[],closedWorkId);
  db.query("UPDATE inbox_requests SET state='closed' WHERE request_id=?").run(closedHome);
  const closedHomeReturn=`return:${randomUUID()}`;
  accepted('service',closedHomeReturn,'A return linked to work whose own request closed.',agentWork,agentWork.slice('request:'.length));
  const linkedClosedHome=recovered(closedHomeReturn,[],closedWorkId);
  // A settled reading item does not hold the thread open.
  const readReturn=`return:${randomUUID()}`;
  accepted('service',readReturn,'A return he already read.',agentWork,agentWork.slice('request:'.length));
  const readRequest=recovered(readReturn);
  const readTopic=(db.query('SELECT topic_id FROM inbox_requests WHERE request_id=?').get(readRequest) as {topic_id:string}).topic_id;
  db.query("INSERT INTO inbox_questions (question_id,topic_id,state) VALUES (?,?,'read')").run(`question:${randomUUID()}`,readTopic);
  assert.deepEqual(topics.retireRecoveredBookkeepingRequests(),{retired:5});
  assert.deepEqual(topics.retireRecoveredBookkeepingRequests(),{retired:0});
  for(const requestId of [serviceBudget,linkedElsewhere,readRequest])
    assert.equal((db.query('SELECT state FROM inbox_requests WHERE request_id=?').get(requestId) as {state:string}).state,'closed');
  const linkedEvidence=JSON.parse((db.query('SELECT closure_json FROM inbox_requests WHERE request_id=?').get(linkedElsewhere) as {closure_json:string}).closure_json).evidence as string[];
  assert.ok(linkedEvidence.includes(`topic-migration:${linkedReturn}`));
  assert.ok(linkedEvidence.includes(ownedWork));
  for(const requestId of [ownedRequest,untrackedRequest,linkedUntracked,linkedClosedHome])
    assert.equal((db.query('SELECT state FROM inbox_requests WHERE request_id=?').get(requestId) as {state:string}).state,'open');
  for(const requestId of [serviceReturn,serviceUpkeep]){
    const row=db.query('SELECT state,closure_json FROM inbox_requests WHERE request_id=?').get(requestId) as {state:string;closure_json:string};
    assert.equal(row.state,'closed');
    const evidence=JSON.parse(row.closure_json).evidence as string[];
    assert.ok(evidence.includes('topic-migration:'+([serviceReturn,serviceUpkeep].indexOf(requestId)===0?returned:upkeep)));
    assert.ok(evidence.includes(`request:${agentWork.slice('request:'.length)}`));
    assert.ok(evidence.includes(agentWork));
  }
  for(const requestId of [assignedUpkeep,agentRequest,mixedRoot,questionedRequest])
    assert.equal((db.query('SELECT state FROM inbox_requests WHERE request_id=?').get(requestId) as {state:string}).state,'open');
  assert.equal((db.query('SELECT count(*) AS n FROM inbox_requests WHERE state=?').get('open') as {n:number}).n,9);
  // A provider/folder cutover makes a new Inbox session. The one-time conversion already ran
  // for the Inbox, so neither migration may rebuild history or reopen recovered requests.
  topics.migrateInboxAttention();
  const topicsBefore=(db.query('SELECT count(*) AS n FROM inbox_topics').get() as {n:number}).n;
  createNativeSession('codex',{title:'Inbox successor fixture',summary:'Inbox successor fixture',inbox:true});
  assert.deepEqual(topics.migrateInboxTopics(),{migrated:false,reason:'already_migrated'});
  assert.equal(topics.migrateInboxAttention().migrated,false);
  assert.equal((db.query('SELECT count(*) AS n FROM inbox_topics').get() as {n:number}).n,topicsBefore);
  console.log('Inbox bookkeeping recovery fixture passed: recovered service notices retired; human, agent, questioned and thread-owned later work stayed open.');
} finally {
  rmSync(scratch,{recursive:true,force:true});
}
