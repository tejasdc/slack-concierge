// A run freezes an ask (source, action, payload), then ends before it knows the outcome. A later
// run of the same session resumes it under the original pair: the one admitted request comes back,
// an unadmitted one is admitted once, and a changed payload or a foreign or live source is refused.
// Requested by the Lab Night (request 3040f085, 2026-11-12).
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FROZEN_ASK_RESUME_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'concierge-frozen-ask-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=FROZEN_ASK_RESUME_TEST_AUTHORIZATION;

const [{db,claimNextQueuedTurn,markTurnProviderAdmissionIntended,acknowledgeTurnProviderInput},
  {SessionOwner,sessionAddress},{SessionCommunicationCoordinator},{nativeRunId,retainSessionInput,enqueueSessionInput},{getSessionById}]=await Promise.all([
  import('../src/state'),import('../src/session-owner'),import('../src/session-communication'),import('../src/session-inputs'),import('../src/state')]);

const errors:unknown[]=[];
const owner=new SessionOwner({available:()=>true,wake:()=>{},stop:async()=>false,steer:()=>false},scratch);
const communication=new SessionCommunicationCoordinator({owner,isOwnerAlive:()=>true,onError:error=>errors.push(error)});
owner.communication=communication;

function claimFor(sessionId:number){
  for(;;){
    const claim=claimNextQueuedTurn('frozen-ask-fixture');
    assert.ok(claim,'a queued turn for the session');
    assert.equal(markTurnProviderAdmissionIntended(claim.turn_id,'frozen-ask-fixture',claim.dispatch_attempt),true);
    acknowledgeTurnProviderInput(claim.turn_id,'frozen-ask-fixture',claim.dispatch_attempt,[]);
    if(claim.session_id===sessionId)return {turnId:claim.turn_id,source:{input_id:claim.accepted_input_id!,run_id:nativeRunId(claim.turn_id)}};
  }
}
const refused=async(action:()=>Promise<unknown>,pattern:RegExp,label:string)=>{
  await assert.rejects(action,pattern,label);
};
const count=()=>(db.query('SELECT count(*) AS n FROM session_communication_requests').get() as {n:number}).n;

try{
  communication.start();await communication.idle();
  const asker=await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text:'Lab night'}});
  const askerId=Number(asker.session.id.slice(10));
  const run1=claimFor(askerId);
  const target=await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text:'Folder worker'}});
  const address=sessionAddress(getSessionById(Number(target.session.id.slice(10)))!);
  const ask=(source:{input_id:string;run_id:string},action_id:string,text:string,resume?:{input_id:string;run_id:string})=>
    communication.ask({source,action_id,address,text,summary:'Review one folder',requestedEffect:'work',...(resume?{resume_source:resume}:{})}) as Promise<{request_id:string}>;

  // Run 1 freezes and sends ask A, freezes ask B but ends before sending it.
  const first=await ask(run1.source,'folder-a','Packet A');
  assert.ok(first.request_id);
  db.query("UPDATE turns SET status='done',owner_instance_id=NULL WHERE id=?").run(run1.turnId);

  // Run 2 of the same session.
  const next=retainSessionInput({id:`resume-${randomUUID()}`,sessionId:askerId,scope:'fixture',actionId:randomUUID(),kind:'input',origin:'agent',payload:{text:'resume'}}).input;
  enqueueSessionInput(next.id);
  const run2=claimFor(askerId);

  await refused(()=>ask(run1.source,'folder-a','Packet A'),/exact live run/,'the ended pair alone is still refused');
  const again=await ask(run2.source,'folder-a','Packet A',run1.source);
  assert.equal(again.request_id,first.request_id,'resuming an admitted ask returns its one receipt');
  assert.equal(count(),1);
  await refused(()=>ask(run2.source,'folder-a','Packet A changed',run1.source),/Idempotency conflict/,'a changed payload is refused');

  const admitted=await ask(run2.source,'folder-b','Packet B',run1.source);
  assert.notEqual(admitted.request_id,first.request_id);
  assert.equal(count(),2,'an unadmitted ask is admitted once');
  const row=db.query('SELECT source_input_id,source_session_id FROM session_communication_requests WHERE request_id=?').get(admitted.request_id) as {source_input_id:string;source_session_id:number};
  assert.equal(row.source_input_id,run1.source.input_id,'it keeps the original source identity');
  assert.equal(row.source_session_id,askerId);
  assert.equal((await ask(run2.source,'folder-b','Packet B',run1.source)).request_id,admitted.request_id,'a repeat returns the same request');
  assert.equal(count(),2);

  await refused(()=>ask(run2.source,'folder-c','Packet C',run2.source),/still live/,'a live run cannot cite itself as frozen');
  await refused(()=>ask(run2.source,'folder-c','Packet C',{input_id:run1.source.input_id,run_id:nativeRunId(run2.turnId)}),/exact run/,'a mismatched run is refused');
  await refused(()=>ask(run2.source,'folder-c','Packet C',{input_id:target.session.id,run_id:run1.source.run_id}),/same session/,'another session\'s input is refused');
  await refused(()=>ask(run2.source,'folder-c','Packet C',{input_id:run1.source.input_id} as any),/resume-source/,'a half pair is refused');
  assert.equal(count(),2);
  assert.deepEqual(errors,[]);
  console.log('frozen ask resume fixture: one receipt for an admitted ask, one admission for an unadmitted one, mismatches refused');
}finally{
  await communication.stop?.();
  rmSync(scratch,{recursive:true,force:true});
}
