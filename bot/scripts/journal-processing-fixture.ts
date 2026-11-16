import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const scratch=mkdtempSync(join(tmpdir(),'journal-processing-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION='journal-processing-a168df69';
const [{SessionOwner},{SessionCommunicationCoordinator},{db,claimNextQueuedTurn,markTurnProviderAdmissionIntended,acknowledgeTurnProviderInput},{retainSessionInput,nativeRunId,updateSessionMetadata},{validateJournalReview,pendingJournalProcessing}]=await Promise.all([
  import('../src/session-owner'),import('../src/session-communication'),import('../src/state'),import('../src/session-inputs'),import('../src/journal-processing')]);
const root='checkin:fixture12345';
const canonical={version:1,rootId:root,sourceRoot:{objectId:root,revision:'r1',actor:{id:'human',kind:'human'}},lines:[
  {objectId:root,parentId:null,at:'2026-11-14T21:47:53Z',text:'Please assess the reason for this block.',revision:'l1',actor:{id:'human',kind:'human'},evidence:{test:true}},
  {objectId:'line:second',parentId:root,at:'2026-11-14T21:48:00Z',text:'Also assess this other reason.',revision:'l2',actor:{id:'human',kind:'human'}}]};
const owner=new SessionOwner({available:()=>true,wake:()=>{},stop:async()=>false,steer:()=>false,readJournalEntry:async()=>structuredClone(canonical)},scratch);
const communication=new SessionCommunicationCoordinator({owner,isOwnerAlive:()=>true,onError:e=>{throw e;}});
owner.communication=communication;
const session=(await owner.create({clientActionId:'keeper-fixture',provider:'codex',purpose:'chat',title:'Journal fixture',firstInput:{text:'fixture'}} as any)).session;
const sessionId=Number(session.id.split(':')[1]);
updateSessionMetadata(sessionId,{inbox:true,inboxRole:'project-router',standingRole:'inbox'});
const first=claimNextQueuedTurn('journal-fixture');assert.ok(first);
markTurnProviderAdmissionIntended(first.turn_id,'journal-fixture',first.dispatch_attempt);
acknowledgeTurnProviderInput(first.turn_id,'journal-fixture',first.dispatch_attempt,[]);
const inputId=first.accepted_input_id!,runId=nativeRunId(first.turn_id);
db.query('UPDATE session_inputs SET payload_json=? WHERE id=?').run(JSON.stringify({text:'service filing',journalProcessing:{version:1,rootId:root}}),inputId);
communication.start();await communication.idle();
const source={input_id:inputId,run_id:runId};
const review={rootId:root,revision:'r1',disposition:'context-only' as const,reason:'Passive reflection only.',items:[] as any[]};
const count=()=>Number((db.query('SELECT count(*) AS n FROM inbox_requests').get() as any).n);
try {
  assert.ok(pendingJournalProcessing(inputId));
  const {parseRouterSessionsArgs}=await import('./router-sessions');
  writeFileSync(join(scratch,'review.json'),JSON.stringify(review));
  assert.equal(parseRouterSessionsArgs(['journal-review','--review-file',join(scratch,'review.json'),'--source-input',inputId,'--source-run',runId,'--action-id','cli']).operation,'journal-review');
  assert.throws(()=>communication.outcome({source,action_id:'tracker-only',outcome:'done'}),/journal-review/);
  const before=count();
  await owner.reviewJournal({source,action_id:'context',review});
  assert.equal(count(),before);assert.equal(pendingJournalProcessing(inputId),null);
  const actionable={...review,disposition:'actionable',items:canonical.lines.map(line=>({lineId:line.objectId,quote:line.text,classification:'actionable-reason',title:'Assess journal reason',reason:'This reason may require action.'}))};
  for(const bad of ['', 'not the source'])await assert.rejects(owner.reviewJournal({source,action_id:'bad-'+bad,review:{...actionable,items:[{...actionable.items[0],quote:bad}]}}));
  assert.throws(()=>validateJournalReview(actionable,{...canonical,sourceRoot:undefined}));
  assert.throws(()=>validateJournalReview({...actionable,items:[{...actionable.items[0],classification:'explicit-request'}]},
    {...canonical,lines:[{...canonical.lines[0],actor:{id:'agent',kind:'agent'}}]}));
  const accepted=await owner.reviewJournal({source,action_id:'actions',review:actionable});
  assert.equal(count(),before+2);assert.equal(accepted.reports.length,2);
  for(const report of accepted.reports){assert.ok(report.report.requestId);assert.equal((db.query('SELECT state FROM inbox_requests WHERE request_id=?').get(report.report.requestId) as any).state,'open');}
  assert.deepEqual(await owner.reviewJournal({source,action_id:'actions',review:actionable}),accepted);
  await assert.rejects(owner.reviewJournal({source,action_id:'actions',review:{...actionable,reason:'changed'}}),/conflict/);
  // Simulate a lost response after durable report acceptance and before processing receipt.
  db.query("UPDATE session_inputs SET receipt_json=NULL WHERE kind IN ('journal-review','journal-portion')").run();
  const restarted=new SessionOwner(owner.runtime,scratch);
  await restarted.reviewJournal({source,action_id:'restart',review:{...actionable,reason:'Another review of the same words'}});
  assert.equal(count(),before+2);
  const substring={...actionable,items:[{...actionable.items[0],quote:'the reason'}]};
  assert.equal(validateJournalReview(substring,canonical).length,1);
  assert.throws(()=>validateJournalReview(substring,{...canonical,lines:[{...canonical.lines[0],text:'the reason and the reason'}]}));
  assert.equal(validateJournalReview({...substring,items:[{...substring.items[0],offset:15}]},{...canonical,lines:[{...canonical.lines[0],text:'the reason and the reason'}]}).length,1);
  const linked={...actionable,items:[{...actionable.items[0],quote:'Please assess',existingRequestId:accepted.reports[0].report!.requestId}]};
  await restarted.reviewJournal({source,action_id:'existing-link',review:linked});assert.equal(count(),before+2);
  db.query("UPDATE turns SET status='canceled' WHERE status='queued'").run();
  await owner.create({clientActionId:'other-reviewer',provider:'codex',purpose:'chat',firstInput:{text:'Review same journal source'}});
  const next=claimNextQueuedTurn('other-reviewer');assert.ok(next);
  markTurnProviderAdmissionIntended(next.turn_id,'other-reviewer',next.dispatch_attempt);
  acknowledgeTurnProviderInput(next.turn_id,'other-reviewer',next.dispatch_attempt,[]);
  const nextSource={input_id:next.accepted_input_id!,run_id:nativeRunId(next.turn_id)};
  await restarted.reviewJournal({source:nextSource,action_id:'cross-run',review:actionable});assert.equal(count(),before+2);
  for(const report of accepted.reports){const row=db.query('SELECT source_input_id FROM session_inputs WHERE id=?').get(`journal-portion:${report.identity}`) as any;assert.equal(row.source_input_id,inputId);}
  let release!:()=>void;
  owner.runtime.readJournalEntry=async()=>{await new Promise<void>(resolve=>release=resolve);return canonical;};
  const pending=communication.journalReview({source:nextSource,action_id:'stopped-read',review:substring});
  db.query('UPDATE turns SET stop_requested_at=CURRENT_TIMESTAMP WHERE id=?').run(next.turn_id);release();
  await assert.rejects(pending);assert.equal(count(),before+2);
  retainSessionInput({id:'legacy',sessionId,scope:'fixture',actionId:'legacy',kind:'input',origin:'service',payload:{text:'old observation'}});
  assert.equal(pendingJournalProcessing('legacy'),null);
  updateSessionMetadata(next.session_id,{standingRole:'journal-keeper',providerRunner:'fixture',projectName:'journal-keeper',projectPath:''});
  const observation={clientActionId:'journal-tracker:'+'a'.repeat(64),objectId:root};
  owner.submitJournalObservation(observation);
  assert.equal(pendingJournalProcessing(observation.clientActionId),null);
  assert.throws(()=>owner.submitJournalObservation({...observation,objectId:'checkin:different-root'}),/conflict/);
  assert.throws(()=>owner.submitJournalObservation({...observation,processingVersion:1}),/conflict/);
  const versioned={...observation,clientActionId:'journal-tracker:'+'b'.repeat(64),processingVersion:1};
  owner.submitJournalObservation(versioned);assert.ok(pendingJournalProcessing(versioned.clientActionId));
  owner.submitJournalObservation(versioned);
  assert.throws(()=>owner.submitJournalObservation({...versioned,processingVersion:2}),/Unsupported/);
  console.log('Journal processing fixture passed: context, source proof, separate open requests, retries, response loss, restart, completion gate and legacy compatibility.');
} finally {await communication.stop();db.close();rmSync(scratch,{recursive:true,force:true});}
