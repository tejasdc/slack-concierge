import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {QUESTION_EXPIRY_SCOPE_TEST_AUTHORIZATION} from '../src/test-authorizations';

const root=await mkdtemp(join(tmpdir(),'concierge-question-expiry-'));
process.env.CONCIERGE_STATE_DIR=root;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(root,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=QUESTION_EXPIRY_SCOPE_TEST_AUTHORIZATION;
try {
  const [{db},{createNativeSession,recordSessionEvent,sessionMetadata,retainSessionInput},topics,{questionDisplay}]=await Promise.all([
    import('../src/state'),import('../src/session-inputs'),import('../src/session-topics'),import('../src/topic-display-rules')]);
  const inbox=createNativeSession('codex',{title:'Question expiry fixture Inbox',inbox:true,inboxRole:'project-router'});
  const worker=createNativeSession('codex',{title:'Question expiry fixture worker'});
  const topicId='topic:question-expiry-fixture';
  const by={kind:'owner' as const,sessionId:`concierge:${inbox.id}`};
  const now='2026-11-13T12:00:00.000Z';
  const humanSource=(requestId:string)=>{
    const id=`human:${requestId}`;
    retainSessionInput({id,sessionId:inbox.id,scope:'surface:thinkering',actionId:`source:${requestId}`,kind:'input',
      origin:'human',payload:{text:`Human request ${requestId}`}});
    recordSessionEvent({eventId:`accepted:${id}`,sessionId:inbox.id,inputId:id,kind:'accepted',payload:{text:`Human request ${requestId}`}});
  };
  for(const requestId of ['req:first','req:second','req:legacy-open','req:legacy-closed'])humanSource(requestId);
  const topic={topicId,sessionId:inbox.id,title:'Question expiry fixture',summary:'',state:'open' as const,
    setAside:null,aliases:[],revision:1,recovered:false,readSequence:0,closure:null,createdBy:by,createdAt:now,updatedAt:now};
  const dispatch=(requestId:string)=>({requestId,targetSessionId:`concierge:${worker.id}`,targetTitle:'fixture worker',outcome:null,state:'recorded'});
  const request=(requestId:string,dispatchId:string)=>({requestId,topicId,title:requestId,brief:'fixture work',state:'open' as const,
    disposition:null,revision:1,sources:[{inputId:`human:${requestId}`}],dispatches:[dispatch(dispatchId)],closure:null,createdAt:now,updatedAt:now});
  const first=request('req:first','dispatch:first'),second=request('req:second','dispatch:second');
  const topicPayload={change:'created',topicId,topic,request:first,requests:[second],questions:[],by,reason:'isolated fixture',revision:1};
  recordSessionEvent({eventId:'fixture-topic-created',sessionId:inbox.id,kind:'topic',payload:topicPayload});
  topics.applyTopicChange('topic',topicPayload);
  const question=(questionId:string,owner:any,kind:'asked'|'decision',context:'ready'|'agent_checking')=>({
    questionId,topicId,revision:1,state:'open' as const,blocking:true,optional:false,context,
    brief:{decision:`Fixture ${questionId}?`,why:{text:'The fixture needs this answer.'},answerable:'Choose the fixture result.'},
    owner,sources:[`human:${questionId}`],replaces:null,replacedBy:null,answer:null,recovered:false,
    legacyNeedEventId:null,kind,origin:'declared' as const,generation:42,createdAt:now,updatedAt:now});
  const linked=(requestId:string,dispatchId:string)=>({sessionId:`concierge:${worker.id}`,runId:'fixture-run',requestId,dispatchRequestId:dispatchId});
  const firstAsked=question('q:first-asked',linked(first.requestId,'dispatch:first'),'asked','agent_checking');
  const firstDecision=question('q:first-decision',linked(first.requestId,'dispatch:first'),'decision','ready');
  const siblingAsked=question('q:sibling-asked',linked(second.requestId,'dispatch:second'),'asked','ready');
  const siblingDecision=question('q:sibling-decision',linked(second.requestId,'dispatch:second'),'decision','agent_checking');
  const unscoped=question('q:unscoped',{sessionId:`concierge:${worker.id}`,runId:'fixture-run'},'decision','ready');
  const declared={change:'reconciled',topicId,topic:{...topic,revision:2},questions:[firstAsked,firstDecision,siblingAsked,siblingDecision,unscoped],by,reason:'fixture declarations',revision:2};
  recordSessionEvent({eventId:'fixture-question-declaration',sessionId:worker.id,kind:'topic_question',payload:declared});
  topics.applyTopicChange('topic_question',declared);
  // The topic and question live across Inbox takeover; reply expiry is recorded by the successor.
  const activeInbox=createNativeSession('codex',{title:'Question expiry fixture Inbox successor',inbox:true,inboxRole:'project-router'});

  assert.equal(topics.expireQuestionsForFinalReply({workerSessionId:worker.id,requestId:'dispatch:first',disposition:'completed',reason:'first request closed.'}),2);
  assert.equal(topics.expireQuestionsForFinalReply({workerSessionId:worker.id,requestId:'dispatch:second',disposition:'needs_decision',reason:'still needs him.'}),0);
  const states=()=>Object.fromEntries((db.query('SELECT question_id,state FROM inbox_questions ORDER BY question_id').all() as any[]).map(row=>[row.question_id,row.state]));
  assert.deepEqual(states(),{'q:first-asked':'expired','q:first-decision':'expired','q:sibling-asked':'open',
    'q:sibling-decision':'open','q:unscoped':'open'},'only questions explicitly linked to the completed dispatch expire');
  assert.equal(topics.expireQuestionsForFinalReply({workerSessionId:worker.id,requestId:'dispatch:first',disposition:'needs_decision',reason:'question remains.'}),0);

  // Replay an old, wrongly session-scoped expiry from another topic. Its declaration, expiry
  // and topic creation were written by three different native sessions, as they are after takeover.
  const oldTopicId='topic:question-expiry-legacy-fixture';
  const oldTopic={...topic,topicId:oldTopicId,title:'Legacy expiry fixture'};
  const oldRequest={...second,topicId:oldTopicId,requestId:'req:legacy-open',dispatches:[dispatch('dispatch:legacy-question')]};
  const closedRequest={...oldRequest,requestId:'req:legacy-closed',state:'closed' as const,disposition:'completed',
    closure:{by,at:now,reason:'fixture closure',evidence:[]},dispatches:[dispatch('dispatch:closed-question')]};
  const oldTopicEvent={change:'created',topicId:oldTopicId,topic:oldTopic,request:oldRequest,requests:[closedRequest],questions:[],by,reason:'legacy fixture',revision:1};
  recordSessionEvent({eventId:'fixture-legacy-topic-created',sessionId:inbox.id,kind:'topic',payload:oldTopicEvent});
  topics.applyTopicChange('topic',oldTopicEvent);
  const legacyQuestion=question('q:legacy-restorable',{...linked(oldRequest.requestId,'dispatch:legacy-question')},'asked','agent_checking');
  legacyQuestion.topicId=oldTopicId;
  const legacyDecision=question('q:legacy-decision',{...linked(oldRequest.requestId,'dispatch:legacy-question')},'decision','ready');
  legacyDecision.topicId=oldTopicId;
  const closedRequestQuestion=question('q:closed-request',{...linked(closedRequest.requestId,'dispatch:closed-question')},'decision','ready');
  closedRequestQuestion.topicId=oldTopicId;
  const answeredQuestion=question('q:answered-while-expired',{...linked(oldRequest.requestId,'dispatch:legacy-question')},'decision','ready');
  answeredQuestion.topicId=oldTopicId;
  const replacedQuestion=question('q:replaced-while-expired',{...linked(oldRequest.requestId,'dispatch:legacy-question')},'decision','ready');
  replacedQuestion.topicId=oldTopicId;
  const declaration={change:'reconciled',topicId:oldTopicId,topic:{...oldTopic,revision:2},
    questions:[legacyQuestion,legacyDecision,closedRequestQuestion,answeredQuestion,replacedQuestion],by,reason:'legacy declaration',revision:2};
  recordSessionEvent({eventId:'fixture-legacy-declaration',sessionId:worker.id,kind:'topic_question',payload:declaration});
  topics.applyTopicChange('topic_question',declaration);
  const legacyExpired={...legacyQuestion,state:'expired' as const,updatedAt:'2026-11-13T12:01:00.000Z',
    brief:{...legacyQuestion.brief,endedBecause:'The agent finished the work it was for (completed): wrong sibling dispatch.'}};
  const legacyDecisionExpired={...legacyDecision,state:'expired' as const,updatedAt:legacyExpired.updatedAt,
    brief:{...legacyDecision.brief,endedBecause:legacyExpired.brief.endedBecause}};
  const closedRequestExpired={...closedRequestQuestion,state:'expired' as const,updatedAt:legacyExpired.updatedAt,
    brief:{...closedRequestQuestion.brief,endedBecause:legacyExpired.brief.endedBecause}};
  const answeredExpired={...answeredQuestion,state:'expired' as const,updatedAt:legacyExpired.updatedAt,
    brief:{...answeredQuestion.brief,endedBecause:legacyExpired.brief.endedBecause}};
  const replacedExpired={...replacedQuestion,state:'expired' as const,updatedAt:legacyExpired.updatedAt,
    brief:{...replacedQuestion.brief,endedBecause:legacyExpired.brief.endedBecause}};
  const expiryPayload={change:'settled',topicId:oldTopicId,topic:{...oldTopic,revision:3},questions:[legacyExpired,legacyDecisionExpired,
    closedRequestExpired,answeredExpired,replacedExpired],
    by:{kind:'owner',sessionId:`concierge:${activeInbox.id}`},reason:'legacy final-reply expiry',revision:3};
  recordSessionEvent({eventId:'topic-expire:reply:dispatch:legacy-error:topic:question-expiry-legacy-fixture',
    sessionId:activeInbox.id,kind:'topic_question',payload:expiryPayload});
  topics.applyTopicChange('topic_question',expiryPayload);
  const answeredNow={...answeredExpired,answer:{inputId:'human:answered',at:now,passage:null,interpretation:'answered',answeredRevision:1}};
  const replacedNow={...replacedExpired,replacedBy:'q:replacement'};
  const postExpiry={change:'settled',topicId:oldTopicId,topic:{...oldTopic,revision:4},questions:[answeredNow,replacedNow],
    by,reason:'fixture answer and replacement after expiry',revision:4};
  recordSessionEvent({eventId:'fixture-post-expiry-answer',sessionId:activeInbox.id,kind:'topic_question',payload:postExpiry});
  topics.applyTopicChange('topic_question',postExpiry);

  const actorFor=(inputId:string)=>{
    retainSessionInput({id:inputId,sessionId:activeInbox.id,scope:`fixture:${inputId}`,actionId:'accepted-source',kind:'input',
      origin:'human',payload:{text:'Please restore this question.'}});
    return {sessionId:activeInbox.id,turnId:null as any,inputId,runId:'fixture-restore-run'};
  };
  const beforeNeeds=(db.query("SELECT count(*) AS n FROM session_owner_events WHERE kind='needs_you'").get() as any).n;
  const beforeGeneration=sessionMetadata(activeInbox).generation;
  const restoreBody={verb:'question.restore',question_id:'q:legacy-restorable',dispatch:'dispatch:legacy-error',
    expected_revision:1,reason:'Restore only the exact question wrongly ended by the sibling dispatch.',action_id:'restore-legacy-question'};
  const wrongEvent={...restoreBody,dispatch:'dispatch:no-retained-event',action_id:'restore-no-event'};
  assert.throws(()=>topics.topicsCommand(actorFor('fixture-no-event-input'),wrongEvent),/event/i);
  const correctExpiry={...restoreBody,question_id:'q:first-asked',dispatch:'dispatch:first',action_id:'restore-correct-expiry'};
  assert.throws(()=>topics.topicsCommand(actorFor('fixture-correct-expiry-input'),correctExpiry),/different explicit dispatch/i);
  for(const [questionId,needle] of [['q:closed-request','still-open'],['q:answered-while-expired','unanswered'],['q:replaced-while-expired','unanswered']] as const){
    const refusal={...restoreBody,question_id:questionId,action_id:`restore-refuse-${questionId}`};
    assert.throws(()=>topics.topicsCommand(actorFor(`fixture-refuse-${questionId}`),refusal),new RegExp(needle,'i'));
  }
  const actor=actorFor('fixture-restore-input');
  const restored=topics.topicsCommand(actor,restoreBody) as any;
  assert.equal(restored.question.state,'open');assert.equal(restored.question.kind,'asked');
  assert.equal(restored.question.createdAt,legacyQuestion.createdAt);assert.equal(restored.question.generation,legacyQuestion.generation);
  assert.equal(restored.question.revision,legacyQuestion.revision,'recovery preserves question revision and exposure identity');
  assert.equal(restored.question.updatedAt,legacyQuestion.updatedAt,'recovery keeps the reply cutoff');
  assert.deepEqual(restored.question.owner,legacyQuestion.owner);assert.deepEqual(restored.question.sources,legacyQuestion.sources);
  const pendingReply=questionDisplay(restored.question,[{inputId:'human:reply-during-expiry',at:'2026-11-13T12:00:30.000Z',
    reviews:[legacyQuestion.questionId],replyTo:null}],[],[]).pendingReply;
  assert.equal(pendingReply.inputId,'human:reply-during-expiry','restoration does not hide a reply sent while the question was expired');
  const decisionBody={...restoreBody,question_id:'q:legacy-decision',action_id:'restore-legacy-decision'};
  const restoredDecision=topics.topicsCommand(actorFor('fixture-restore-decision-input'),decisionBody) as any;
  assert.equal(restoredDecision.question.state,'open');assert.equal(restoredDecision.question.kind,'decision');
  assert.equal(restoredDecision.question.context,legacyDecision.context);
  assert.equal((topics.topicsCommand(actor,restoreBody) as any).duplicate,true,'the same action returns its retained receipt');
  const afterNeeds=(db.query("SELECT count(*) AS n FROM session_owner_events WHERE kind='needs_you'").get() as any).n;
  const afterGeneration=sessionMetadata(activeInbox).generation;
  assert.equal(afterNeeds,beforeNeeds);assert.equal(afterGeneration,beforeGeneration);
  assert.deepEqual((db.query('SELECT request_id,state FROM inbox_requests ORDER BY request_id').all() as any[])
    .map(row=>[row.request_id,row.state]),[['req:first','open'],['req:legacy-closed','closed'],['req:legacy-open','open'],['req:second','open']],
    'restoration leaves the original and sibling human requests untouched');

  const stale={...restoreBody,action_id:'restore-stale',expected_revision:0};
  assert.throws(()=>topics.topicsCommand(actorFor('fixture-stale-input'),stale),/changed|stale/i);
  const wrongDispatch={...restoreBody,action_id:'restore-wrong-event',dispatch:'dispatch:first'};
  assert.throws(()=>topics.topicsCommand(actorFor('fixture-wrong-input'),wrongDispatch),/event|snapshot|expired/i);
  const unscopedBody={...restoreBody,question_id:'q:unscoped',action_id:'restore-unscoped'};
  assert.throws(()=>topics.topicsCommand(actorFor('fixture-unscoped-input'),unscopedBody),/expired/i);

  topics.rebuildTopicProjections();
  assert.equal((db.query('SELECT state FROM inbox_questions WHERE question_id=?').get('q:legacy-restorable') as any).state,'open',
    'replaying the retained restored event preserves the same question');
  assert.deepEqual(states(),{'q:first-asked':'expired','q:first-decision':'expired','q:sibling-asked':'open',
    'q:sibling-decision':'open','q:unscoped':'open','q:legacy-restorable':'open','q:legacy-decision':'open',
    'q:closed-request':'expired','q:answered-while-expired':'expired','q:replaced-while-expired':'expired'},
    'replay leaves sibling and unscoped questions intact and preserves refused historical questions');
  console.log(JSON.stringify({fixture:'question-expiry-scope',exactDispatch:true,wrongDispatchRemains:true,
    unscopedRetained:true,legacyRestore:true,silent:true,idempotent:true,replay:true}));
} finally {await rm(root,{recursive:true,force:true});}
