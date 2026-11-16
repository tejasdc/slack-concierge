import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {INBOX_QUIET_SERVICE_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'concierge-quiet-service-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=INBOX_QUIET_SERVICE_TEST_AUTHORIZATION;
const [{db,claimNextQueuedTurn,finishTurn,getSessionById,markTurnProviderAdmissionIntended,acknowledgeTurnProviderInput},
  {SessionOwner},{SessionCommunicationCoordinator},{nativeRunId,updateSessionMetadata,retainSessionInput,enqueueSessionInput},
  {topicsCommand},{threadOwedByTurn,relayUnpostedAnswer,inboxThreadRoot}]=await Promise.all([
  import('../src/state'),import('../src/session-owner'),import('../src/session-communication'),
  import('../src/session-inputs'),import('../src/session-topics'),import('../src/session-inbox')]);
const owner=new SessionOwner({available:()=>true,wake:()=>{},stop:async()=>false,steer:()=>false},scratch);
const communication=new SessionCommunicationCoordinator({owner,isOwnerAlive:()=>true,onError:error=>{throw error;}});
owner.communication=communication;
const run=()=>{
  const claim=claimNextQueuedTurn('quiet-service-fixture');assert.ok(claim);
  assert.ok(markTurnProviderAdmissionIntended(claim.turn_id,'quiet-service-fixture',claim.dispatch_attempt));
  acknowledgeTurnProviderInput(claim.turn_id,'quiet-service-fixture',claim.dispatch_attempt,[]);
  return {claim,source:{input_id:claim.accepted_input_id!,run_id:nativeRunId(claim.turn_id)}};
};
try{
  communication.start();await communication.idle();
  const created=await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text:'Keep the work thread focused.'}});
  const sessionId=Number(created.session.id.slice(10));updateSessionMetadata(sessionId,{inbox:true});
  const first=run(),root=first.source.input_id;
  const actor={sessionId,turnId:first.claim.turn_id,inputId:root,runId:first.source.run_id};
  const area=topicsCommand(actor,{verb:'area.create',action_id:'area',name:'Quiet service fixture'}).area;
  topicsCommand(actor,{verb:'create',action_id:'topic',title:'Work thread',roots:[root],area_ids:[area.id]});
  assert.throws(()=>communication.outcome({source:first.source,action_id:'human-silent',outcome:'done'}),/why he need not read/);
  db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,
    source_root_ts,action_id,target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms)
    VALUES('local-request','native','fixture',?,?,?,'fixture',?,'native','fixture','{}','fixture',0,0)`)
    .run(first.claim.turn_id,sessionId,root,sessionId);
  db.query(`INSERT INTO session_peer_requests(request_id,peer,source_session_id,source_turn_id,source_input_id,action_id,
    payload_json,payload_hash,remote_session_id,remote_address,remote_operation_id,due_at_ms,created_at_ms)
    VALUES('peer-request','mac',?,?,?,'fixture','{}','fixture','remote','remote','remote',0,0)`)
    .run(sessionId,first.claim.turn_id,root);
  for(const table of ['session_communication','session_peer'])for(const kind of ['overdue','final']){
    const id=`${table}-${kind}`;
    db.query(`INSERT INTO ${table}_events(event_id,request_id,kind,payload_json,status,created_at_ms) VALUES(?,?,?,'{}','received',0)`)
      .run(id,table==='session_peer'?'peer-request':'local-request',kind);
  }
  finishTurn(first.claim.turn_id,'done','Initial human turn.');
  const session=getSessionById(sessionId)!;
  const cases=[
    ...['thread-upkeep:','unfiled-wake:','request-reminder:','question-reminder:','question-todo-done:',
      'direct-todo-done:','question-returned:','handoff-notice:','background-job:','update-wait:','area-theme:']
      .map(prefix=>({id:prefix+randomUUID(),quiet:true,marked:false})),
    {id:'marked-service:'+randomUUID(),quiet:true,marked:true},
    {id:'ordinary-service:'+randomUUID(),quiet:false,marked:false},
    {id:'agent-question:'+randomUUID(),quiet:false,marked:true,agent:true},
    ...['session_communication','session_peer'].flatMap(table=>['overdue','final'].map(kind=>({
      id:`return:${table}-${kind}`,quiet:kind==='overdue',marked:false,
      requestId:table==='session_peer'?'peer-request':'local-request',
    }))),
  ];
  const handoffOriginal=cases.find(item=>item.id.startsWith('request-reminder:'))!;
  cases.push({id:`handoff-input:fixture:${handoffOriginal.id}`,quiet:true,marked:false});
  for(const item of cases){
    const handoff=item.id.startsWith('handoff-input:');
    retainSessionInput({id:item.id,sessionId,scope:handoff?'handoff:fixture':`session:${root}`,
      actionId:handoff?handoffOriginal.id:item.id,kind:'input',
      origin:item.agent?'agent':'service',sourceInputId:root,sourceRunId:first.source.run_id,
      ...('requestId' in item?{requestId:item.requestId}:{}),
      payload:{text:'You do not need to reply to this.',...(item.marked?{threadReplyNotRequired:true}:{})}});
    enqueueSessionInput(item.id);
    const current=run();
    assert.equal(current.source.input_id,item.id);
    const owed=inboxThreadRoot(sessionId,item.id);
    assert.ok(owed,'the notice has an actual thread destination');
    assert.equal(threadOwedByTurn(session,item.id),item.quiet?null:owed,item.id);
    if(item.quiet){
      communication.outcome({source:current.source,action_id:'quiet-close',outcome:'done'});
      assert.equal(relayUnpostedAnswer({sessionId,turnId:current.claim.turn_id,inputId:item.id,text:'Maintenance finished.'}),null);
      assert.equal(db.query("SELECT count(*) AS n FROM session_owner_events WHERE turn_id=? AND kind='post'").get(current.claim.turn_id)?.n,0);
    }else{
      assert.throws(()=>communication.outcome({source:current.source,action_id:'must-post',outcome:'done'}),/Post the answer first/);
      assert.equal(relayUnpostedAnswer({sessionId,turnId:current.claim.turn_id,inputId:item.id,text:'Substantive answer.'}),owed);
    }
    finishTurn(current.claim.turn_id,'done','Finished.');
  }
  assert.throws(()=>owner.admit({sessionId,inputId:'untrusted-waiver',origin:'agent',sourceInputId:root,
    sourceRunId:first.source.run_id,requestId:'untrusted',text:'Question',threadReplyNotRequired:true}),/Only a service input/);
  console.log('Quiet service notices close without posts or relay; human silence, agent questions and genuine service returns retain their guards.');
}finally{
  await communication.stop();db.close();rmSync(scratch,{recursive:true,force:true});
}
