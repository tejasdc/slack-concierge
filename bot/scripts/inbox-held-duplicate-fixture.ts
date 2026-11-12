// Replays the 2026-11-12 Inbox failures offline.
// 1. Concierge's own upkeep notices filed as thread roots lifted a week of old threads to the top.
// 2. One message was an open request in two threads and was recovered and re-sent twice.
// 3. A request whose only attempt waited behind a provider hold counted as live work for as long
//    as the hold lasted; after an hour it must come back to the router.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {INBOX_HELD_DUPLICATE_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'concierge-held-duplicate-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=INBOX_HELD_DUPLICATE_TEST_AUTHORIZATION;

const [{db,claimNextQueuedTurn,markTurnProviderAdmissionIntended,acknowledgeTurnProviderInput},
  {SessionOwner},{SessionCommunicationCoordinator},{nativeRunId,updateSessionMetadata,recordSessionEvent,retainSessionInput},
  {topicsCommand,keepThreadsCurrent,HELD_ATTEMPT_RECOVERY_MS},{movesThreadForHim,movesThreadForHimSql}]=await Promise.all([
  import('../src/state'),import('../src/session-owner'),import('../src/session-communication'),
  import('../src/session-inputs'),import('../src/session-topics'),import('../src/inbox-thread-time')]);

const errors:unknown[]=[];
const owner=new SessionOwner({available:()=>true,wake:()=>{},stop:async()=>false,steer:()=>false},scratch);
const communication=new SessionCommunicationCoordinator({owner,isOwnerAlive:()=>true,onError:error=>errors.push(error)});
owner.communication=communication;

function run(){
  const claim=claimNextQueuedTurn('held-duplicate-fixture');
  assert.ok(claim);
  assert.equal(markTurnProviderAdmissionIntended(claim.turn_id,'held-duplicate-fixture',claim.dispatch_attempt),true);
  acknowledgeTurnProviderInput(claim.turn_id,'held-duplicate-fixture',claim.dispatch_attempt,[]);
  const runId=nativeRunId(claim.turn_id),inputId=claim.accepted_input_id!;
  return {actor:{sessionId:claim.session_id,turnId:claim.turn_id,inputId,runId},source:{input_id:inputId,run_id:runId}};
}
const refusalCode=(action:()=>unknown)=>{
  try{action();}catch(error){return (error as {code?:string}).code;}
  return undefined;
};
const request=(id:string)=>db.query('SELECT * FROM inbox_requests WHERE request_id=?').get(id) as
  {state:string;disposition:string|null;sources_json:string;dispatches_json:string;closure_json:string|null;topic_id:string};

try {
  // 1. Thread time.
  assert.equal(movesThreadForHim('thread-upkeep:abc','other','thread-upkeep:abc'),false,'upkeep as root');
  assert.equal(movesThreadForHim('unfiled-wake:abc','other','unfiled-wake:abc'),false,'unfiled wake as root');
  assert.equal(movesThreadForHim('thread-upkeep:abc','final','other-root'),false);
  assert.equal(movesThreadForHim('human-1','other','human-1'),true,'ordinary root');
  assert.equal(movesThreadForHim('human-2','post','human-1'),true,'ordinary message');
  assert.equal(movesThreadForHim('request:r','other','human-1'),false,'unchanged request rule');
  const cases:[string,string,'final'|'post'|'other'][]=[
    ['thread-upkeep:abc','thread-upkeep:abc','other'],['unfiled-wake:abc','unfiled-wake:abc','other'],
    ['thread-upkeep:abc','root','final'],['human-1','human-1','other'],['human-2','human-1','post'],
    ['request:r','human-1','other'],['return:x','human-1','other'],['return:x','human-1','final']];
  for(const [id,root,kind] of cases){
    // The scratch ledger evaluates the rule over one literal row; no table is created.
    const sql=db.query(`SELECT ${movesThreadForHimSql} AS moves FROM (SELECT ? AS message_id,? AS root_input_id,? AS entry_kind)`).get(id,root,kind) as {moves:number};
    assert.equal(sql.moves===1,movesThreadForHim(id,kind,root),`SQL and TypeScript agree on ${id} (${kind}) in ${root}`);
  }

  // Shared setup: an Inbox session, two threads, and an accepted human message M.
  communication.start();await communication.idle();
  const inbox=await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text:'Duplicate fixture'}});
  const inboxId=Number(inbox.session.id.slice(10));updateSessionMetadata(inboxId,{inbox:true});
  const current=run();
  const message=(id:string)=>{
    retainSessionInput({id,sessionId:inboxId,scope:'surface:thinkering',actionId:randomUUID(),kind:'input',origin:'human',payload:{text:id}});
    recordSessionEvent({eventId:`accepted:${id}`,sessionId:inboxId,inputId:id,kind:'accepted',payload:{text:id}});
    return id;
  };
  const M=current.actor.inputId,M2=message(`human-${randomUUID()}`),M3=message(`human-${randomUUID()}`),M4=message(`human-${randomUUID()}`);
  const area=topicsCommand(current.actor,{verb:'area.create',action_id:'area',name:'Held duplicate fixture'}).area;
  const topicA=topicsCommand(current.actor,{verb:'create',action_id:'topic-a',title:'Thread A',roots:[M],area_ids:[area.id]}).topic.topicId;
  const topicB=topicsCommand(current.actor,{verb:'create',action_id:'topic-b',title:'Thread B',roots:[M2],area_ids:[area.id]}).topic.topicId;
  const add=(topic:string,action:string,sources:string[])=>
    topicsCommand(current.actor,{verb:'request.add',topic_id:topic,action_id:action,title:action,sources,brief:`Brief of ${action}.`}).request.requestId as string;

  // 2. Duplicates. The automatic "Follow-up in …" copy of his reply M5 sits open in thread A;
  // the router's deliberate request for M5 in thread B absorbs it instead of sitting beside it.
  const M5=message(`human-${randomUUID()}`);
  const automatic=`req:forward:${randomUUID()}`,at=new Date().toISOString();
  db.query(`INSERT INTO inbox_requests(request_id,topic_id,title,brief,state,disposition,revision,sources_json,dispatches_json,closure_json,created_at,updated_at,completion_floor,reopened_at)
    VALUES(?,?,?,?,'open',NULL,1,?,?,NULL,?,?,0,NULL)`).run(automatic,topicA,'Follow-up in Thread A','His reply.',JSON.stringify([{inputId:M5}]),
    JSON.stringify([{requestId:'forward-attempt',targetSessionId:'concierge:1',outcome:'failed',forwardedReply:true}]),at,at);
  const absorbing=topicsCommand(current.actor,{verb:'request.add',topic_id:topicB,action_id:'b-absorbs',title:'His reply as its own request',sources:[M5],brief:'His reply.'});
  assert.equal(absorbing.absorbed,automatic,'the deliberate request absorbed the automatic copy');
  assert.equal(request(automatic).state,'closed');assert.equal(request(automatic).disposition,'superseded');
  assert.equal(JSON.parse(request(automatic).closure_json!).mergedInto,absorbing.request.requestId);
  assert.ok((JSON.parse(request(absorbing.request.requestId).dispatches_json) as {requestId:string}[]).some(item=>item.requestId==='forward-attempt'),
    'the automatic copy\'s attempt moved to the deliberate request');
  // One message with two different asks may still be filed deliberately in two threads.
  const inA=add(topicA,'a-first',[M]);
  const splitInB=add(topicB,'b-split',[M]);
  assert.notEqual(splitInB,inA,'a deliberate split across threads is allowed');
  assert.equal(request(inA).state,'open');
  const secondInA=add(topicA,'a-second',[M]);
  assert.notEqual(secondInA,inA,'a second request from M in its own thread is still allowed');
  // A message of its own is fine anywhere.
  add(topicB,'b-own',[M3]);

  // A pre-existing duplicate: a request in B that also carries M (as left by the old behaviour).
  const duplicate=add(topicB,'b-duplicate',[M4]);
  const workTarget=await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat'});
  const dispatch=await communication.ask({source:current.source,action_id:'dup-dispatch',address:workTarget.session.address,
    thread:M2,summary:'Work for the duplicate',text:'Do the work.',requestedEffect:'work'});
  await communication.idle();
  topicsCommand(current.actor,{verb:'request.link',request_id:duplicate,action_id:'dup-link',dispatch:dispatch.request_id});
  db.query('UPDATE inbox_requests SET sources_json=? WHERE request_id=?').run(JSON.stringify([{inputId:M4},{inputId:M}]),duplicate);
  const merged=topicsCommand(current.actor,{verb:'request.merge',request_id:duplicate,action_id:'merge',into:inA,reason:'Same message in two threads.'});
  const closed=request(duplicate);
  assert.equal(closed.state,'closed');assert.equal(closed.disposition,'superseded');
  assert.equal(JSON.parse(closed.closure_json!).mergedInto,inA);
  assert.equal(merged.merged.closure.mergedInto,inA);
  const keeper=request(inA);
  assert.equal(keeper.state,'open');
  assert.ok((JSON.parse(keeper.sources_json) as {inputId:string}[]).some(source=>source.inputId===M4),'keeper gained the duplicate\'s source');
  assert.ok((JSON.parse(keeper.dispatches_json) as {requestId:string}[]).some(item=>item.requestId===dispatch.request_id),'keeper gained the duplicate\'s dispatch');
  assert.equal(refusalCode(()=>topicsCommand(current.actor,{verb:'request.merge',request_id:secondInA,action_id:'merge-same',into:inA,reason:'Same thread.'})),
    'REQUEST_MERGE_SAME_THREAD');

  // 3. Held attempts.
  assert.equal(HELD_ATTEMPT_RECOVERY_MS,60*60_000);
  const heldFor=async(label:string,ageMs:number)=>{
    const root=message(`human-${randomUUID()}`);
    const topic=topicsCommand(current.actor,{verb:'create',action_id:`held-topic-${label}`,title:`Held ${label}`,roots:[root],area_ids:[area.id]}).topic.topicId;
    const requestId=add(topic,`held-${label}`,[root]);
    const target=await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat'});
    const sent=await communication.ask({source:current.source,action_id:`held-dispatch-${label}`,address:target.session.address,
      thread:root,summary:`Held work ${label}`,text:'Do the held work.',requestedEffect:'work'});
    await communication.idle();
    topicsCommand(current.actor,{verb:'request.link',request_id:requestId,action_id:`held-link-${label}`,dispatch:sent.request_id});
    const targetSession=Number(target.session.id.slice(10)),since=Date.now()-ageMs;
    db.query("UPDATE session_communication_requests SET created_at_ms=? WHERE request_id=?").run(since,sent.request_id);
    const turn=db.query("UPDATE turns SET dispatch_hold='usage',saved_kind=NULL,started_at=strftime('%Y-%m-%d %H:%M:%S',?/1000,'unixepoch') WHERE session_id=? AND status='queued'").run(since,targetSession);
    assert.equal(turn.changes,1,`${label}: one queued turn was held`);
    return {requestId,topic};
  };
  const hold=await heldFor('old',2*60*60_000);
  const admitted:{text:string}[]=[];
  await keepThreadsCurrent(input=>{admitted.push(input);return undefined;},()=>false);
  assert.ok(admitted.some(input=>input.text.includes('is still waiting to run')),'a two-hour hold comes back to the router');
  assert.ok(admitted.some(input=>input.text.includes(hold.requestId)),'the recovery names the request');

  const before=admitted.length;
  const young=await heldFor('young',10*60_000);
  const youngAdmitted:{text:string}[]=[];
  await keepThreadsCurrent(input=>{youngAdmitted.push(input);return undefined;},()=>false);
  assert.ok(!youngAdmitted.some(input=>input.text.includes(young.requestId)),'a ten-minute hold stays quiet');
  void before;
  assert.deepEqual(errors,[]);
  console.log('inbox held duplicate fixture passed');
} finally {
  rmSync(scratch,{recursive:true,force:true});
}
process.exit(0);
