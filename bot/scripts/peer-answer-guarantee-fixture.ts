import {strict as assert} from 'node:assert';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runFixtureChild} from './fixture-child';

const authorization='peer-answer-guarantee-2026-11-15';
export async function checkPeerAnswerGuarantee(){
 const state=await mkdtemp(join(tmpdir(),'concierge-peer-answer-guarantee-'));
 try{return await runFixtureChild({command:process.execPath,args:[import.meta.path,'--child'],env:{...process.env,
  CONCIERGE_TEST_MODE:'1',CONCIERGE_TEST_AUTHORIZATION:authorization,CONCIERGE_STATE_DIR:state,
  CONCIERGE_CAPTURE_STATE_DIR:join(state,'capture')},deadlineMs:30_000,fixture:'peer-answer-guarantee'});}
 finally{await rm(state,{recursive:true,force:true});}
}

async function child(){
 const [{db},{createNativeSession,retainSessionInput},{SessionOwner,sessionAddress},peerImplementation]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/session-owner'),
  import(process.env.PEER_GUARANTEE_FIXTURE_PEER_MODULE??'../src/session-peers')]);
 const {SessionPeers,PeerClient}=peerImplementation as typeof import('../src/session-peers');
 const source=createNativeSession('codex',{title:'Peer guarantee fixture source'});
 const target=createNativeSession('codex',{title:'Peer guarantee fixture target'});
 const sourceInput=retainSessionInput({sessionId:source.id,scope:'fixture',actionId:'peer-guarantee-source',kind:'input',origin:'human',payload:{text:'fixture'}}).input;
 const turn=db.query("INSERT INTO turns(session_id,slack_user_msg_ts,user_text,accepted_input_id,status) VALUES(?,?,'fixture','fixture','done') RETURNING id").get(source.id,`fixture-${sourceInput.id}`) as {id:number};
 const owner=new SessionOwner({wake(){},steer(){return false;},async stop(){return false;},available(){return true;}} as any,process.cwd());
 const requestId='peer-answer-guarantee-original-request';
 const requestPayload={peer:'mac',answerGuaranteeVersion:1,requestedEffect:'work',text:'Exact retained request'};
 const exactStatus=(id:string,changes:Record<string,unknown>={})=>({requestId:id,sessionId:`concierge:${target.id}`,address:sessionAddress(target),
  inputState:'queued',inputError:null,stillWorking:false,execution:null,replies:[],answerGuaranteeVersion:1,
  acceptedAnswerGuaranteeVersion:null,answerTaskReady:true,unresolvedChatGptObligations:0,...changes});
 const insertRequest=(id:string,status:string,remote:unknown,delivery:string|null=null,actionId=id)=>db.query(`INSERT INTO session_peer_requests
  (request_id,peer,source_session_id,source_turn_id,source_input_id,action_id,payload_json,payload_hash,remote_session_id,remote_address,
   remote_operation_id,remote_status_json,delivery_json,status,due_at_ms,created_at_ms)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,'mac',source.id,turn.id,sourceInput.id,actionId,JSON.stringify(requestPayload),`fixture-hash:${id}`,
   `concierge:${target.id}`,sessionAddress(target),`request:${id}`,remote===null?null:JSON.stringify(remote),delivery,status,Date.now()+60_000,Date.now());
 db.query(`INSERT INTO session_peer_requests(request_id,peer,source_session_id,source_turn_id,source_input_id,action_id,payload_json,payload_hash,
   remote_session_id,remote_address,remote_operation_id,remote_status_json,delivery_json,status,due_at_ms,created_at_ms)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,? ,NULL,'version_hold',?,?)`).run(requestId,'mac',source.id,turn.id,sourceInput.id,'peer-guarantee-action',JSON.stringify(requestPayload),'fixture-hash',
   `concierge:${target.id}`,sessionAddress(target),`request:${requestId}`,JSON.stringify({requestId,sessionId:`concierge:${target.id}`,address:sessionAddress(target),inputState:'queued',stillWorking:false,execution:null,replies:[],answerGuaranteeVersion:1,acceptedAnswerGuaranteeVersion:null,answerTaskReady:true,unresolvedChatGptObligations:0,observedAt:'before'}),Date.now()+60_000,Date.now());
 // These are the already-retained random event identities from the incident shape. Reconciliation
 // must reuse the typed health identity and preserve all three historical records.
 for(const id of ['old-random-reminder-a','old-random-reminder-b','old-random-reminder-c'])
  db.query('INSERT INTO session_peer_events(event_id,request_id,kind,payload_json,created_at_ms,status) VALUES(?,?,\'overdue\',?,?,\'received\')')
   .run(id,requestId,JSON.stringify({health:'peer answer guarantee unconfirmed',text:`historical ${id}`}),Date.now());
 let mode:'malformed'|'wrong-identity'|'contradictory'|'legacy'|'valid'='malformed';let active=0;let maximumActive=0;let calls=0;let requestPosts=0;let cancelPosts=0;let release!:()=>void;
 const responseOverrides=new Map<string,()=>Response>();
 const barrier=new Promise<void>(resolve=>{release=resolve;});
 let beginLate!:()=>void;let releaseLate!:()=>void;
 const lateStarted=new Promise<void>(resolve=>{beginLate=resolve;});const lateGate=new Promise<void>(resolve=>{releaseLate=resolve;});
 const oldFetch=globalThis.fetch;
 globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const match=String(input).match(/\/requests\/([^/?]+)/);const observedId=match?.[1];
  const isStatus=!!observedId;
  if(!isStatus)return Response.json({sessions:[]});
  if(init?.method==='POST'){if(String(input).endsWith('/cancel'))cancelPosts++;else requestPosts++;return Response.json({outcome:null});}
  const override=responseOverrides.get(observedId);if(override)return override();
  calls++;active++;maximumActive=Math.max(maximumActive,active);
  try{if(observedId==='peer-answer-guarantee-late-terminal'){beginLate();await lateGate;}else if(calls===1)await barrier;
   if(mode==='malformed')return new Response('{invalid',{status:200,headers:{'content-type':'application/json'}});
   if(mode==='legacy')return Response.json({requestId:observedId,sessionId:`concierge:${target.id}`,address:sessionAddress(target),inputState:'queued',stillWorking:false,execution:null,replies:[]});
   return Response.json({requestId:mode==='wrong-identity'?'another-request':observedId,sessionId:`concierge:${target.id}`,address:sessionAddress(target),inputState:'queued',stillWorking:false,execution:null,replies:[],
    answerGuaranteeVersion:1,acceptedAnswerGuaranteeVersion:null,answerTaskReady:true,unresolvedChatGptObligations:mode==='contradictory'?1:0});
  }finally{active--;}
 }) as typeof fetch;
 const peers=new SessionPeers({self:'cloud',clients:new Map([['mac',new PeerClient('mac','http://fixture.invalid','fixture')]]),owner,
  isOwnerAlive:()=>true,onError:error=>{throw error;}});
 (peers as any).stopped=false;(peers as any).peerReadController=new AbortController();
 try{
  const first=peers.notified(requestId);const second=peers.notified(requestId);
  await new Promise(resolve=>setTimeout(resolve,0));assert.equal(calls,1,'overlapping notify calls share the in-flight status request');
  release();await Promise.all([first,second]);
  let row=db.query('SELECT status,remote_status_json,delivery_json,outcome FROM session_peer_requests WHERE request_id=?').get(requestId) as any;
  assert.equal(row.status,'version_hold','a malformed 200 cannot release or alter the retained hold');
  assert.equal(row.delivery_json,null);assert.equal(row.outcome,null);
  let remote=JSON.parse(row.remote_status_json);
  assert.equal(remote.answerGuaranteeVersion,1,'last valid proof remains available for diagnosis');
  assert.equal(remote.originStatusReadFailure.reason,'status_json_invalid');
  assert.equal(remote.originStatusReadFailure.httpStatus,200);
  assert.equal(remote.originStatusReadFailure.contentType,'application/json');
  assert.equal(db.query("SELECT count(*) AS n FROM session_peer_events WHERE request_id=? AND json_extract(payload_json,'$.health')='peer answer guarantee unconfirmed'").get(requestId)?.n,3,
   'the malformed read creates no new version-hold notice');
  assert.equal(JSON.parse(row.remote_status_json).originStatusReadFailure.reason,'status_json_invalid');
  const staleRow=(peers as any).row(requestId);
  (peers as any).settle(staleRow,'failed','stale evidence must not close this request');
  assert.equal((peers as any).row(requestId).outcome,null,'preserved ready proof cannot authorize inferred settlement after a failed read');
  const legacyFinal={eventId:'legacy-final-after-failed-read',kind:'final',text:'Exact peer final',replyBody:'Exact peer final',workDisposition:'completed',
   responder:{peer:'mac',sessionId:`concierge:${target.id}`,inputId:'remote-input',runId:'remote-run'}};
  assert.equal((peers as any).recordReply(staleRow,legacyFinal).recorded,'refused',
   'a pre-upgrade final without proof cannot borrow preserved v1 readiness across a failed status read');
  const nestedExecutionId='peer-answer-guarantee-bad-settled-flag';
  insertRequest(nestedExecutionId,'version_hold',exactStatus(nestedExecutionId));
  responseOverrides.set(nestedExecutionId,()=>Response.json(exactStatus(nestedExecutionId,{execution:{turnId:41,runId:'run:41',status:'error',settled:'false',
    acknowledged:true,acknowledgedAt:'2026-11-15T00:00:00.000Z',stopped:false,stoppedByTejasAtMs:null,dedicated:true,answersWithTurn:true,
    steeringStatus:null,text:'not a trusted final',error:null,sha256:null}})));
  await peers.notified(nestedExecutionId);
  let malformedRow=db.query('SELECT status,remote_status_json,outcome FROM session_peer_requests WHERE request_id=?').get(nestedExecutionId) as any;
  assert.equal(malformedRow.status,'version_hold');assert.equal(malformedRow.outcome,null);
  assert.equal(JSON.parse(malformedRow.remote_status_json).execution,null,'malformed nested data cannot overwrite valid evidence');
  assert.equal(JSON.parse(malformedRow.remote_status_json).originStatusReadFailure.reason,'execution_shape_invalid');
  const nullReplyId='peer-answer-guarantee-null-reply';
  insertRequest(nullReplyId,'version_hold',exactStatus(nullReplyId));
  responseOverrides.set(nullReplyId,()=>Response.json(exactStatus(nullReplyId,{replies:[null]})));
  await peers.notified(nullReplyId);
  malformedRow=db.query('SELECT status,remote_status_json,outcome FROM session_peer_requests WHERE request_id=?').get(nullReplyId) as any;
  assert.equal(malformedRow.status,'version_hold');assert.equal(malformedRow.outcome,null);
  assert.equal(JSON.parse(malformedRow.remote_status_json).originStatusReadFailure.reason,'reply_summary_invalid');
  const malformedInputErrorId='peer-answer-guarantee-malformed-input-error';
  insertRequest(malformedInputErrorId,'version_hold',exactStatus(malformedInputErrorId));
  responseOverrides.set(malformedInputErrorId,()=>Response.json(exactStatus(malformedInputErrorId,{inputState:'failed',inputError:{message:{bad:true}}})));
  await peers.notified(malformedInputErrorId);
  malformedRow=db.query('SELECT status,remote_status_json,outcome FROM session_peer_requests WHERE request_id=?').get(malformedInputErrorId) as any;
  assert.equal(malformedRow.status,'version_hold');assert.equal(malformedRow.outcome,null);
  assert.equal(JSON.parse(malformedRow.remote_status_json).originStatusReadFailure.reason,'input_error_invalid',
   'a malformed failure carrier cannot authorize inferred failure settlement');
  const badReplySummaries:[string,Record<string,unknown>][]=[
   ['peer-answer-guarantee-incomplete-needs-you',{eventId:'turn_outcome:action:bad',kind:'progress',status:'forwarded',text:'',turnOutcome:'needs_you',files:0}],
   ['peer-answer-guarantee-bad-reply-boolean',{eventId:'bad-reply-boolean',kind:'progress',status:'forwarded',text:'progress',notify:'false'}],
   ['peer-answer-guarantee-bad-completion-id',{eventId:'bad-completion-id',kind:'progress',status:'forwarded',text:'progress',completionTurnId:'43'}],
  ];
  for(const [id,reply] of badReplySummaries){
   insertRequest(id,'version_hold',exactStatus(id));
   responseOverrides.set(id,()=>Response.json(exactStatus(id,{replies:[reply]})));
   await peers.notified(id);
   const row=db.query('SELECT status,remote_status_json,outcome FROM session_peer_requests WHERE request_id=?').get(id) as any;
   assert.equal(row.status,'version_hold');assert.equal(row.outcome,null);
   assert.equal(JSON.parse(row.remote_status_json).originStatusReadFailure.reason,'reply_summary_invalid');
   assert.deepEqual(JSON.parse(row.remote_status_json).replies,[],'invalid summary fields are rejected before status retention');
  }
  const emptyProgressId='peer-answer-guarantee-empty-progress-summary';
  insertRequest(emptyProgressId,'version_hold',exactStatus(emptyProgressId));
  responseOverrides.set(emptyProgressId,()=>Response.json(exactStatus(emptyProgressId,{replies:[{
   eventId:'empty-progress-summary',kind:'progress',status:'forwarded',text:'',files:0,sourceInputId:'remote-input',sourceRunId:'remote-run'}]})));
  let emptyProgressError:unknown=null;
  try{await peers.notified(emptyProgressId);}catch(error){emptyProgressError=error;}
  assert.equal(emptyProgressError,null,'a reply summary must be rejected as a failed status read before reply recording can throw');
  const emptyProgressRow=db.query('SELECT status,remote_status_json,outcome FROM session_peer_requests WHERE request_id=?').get(emptyProgressId) as any;
  assert.equal(emptyProgressRow.status,'version_hold');assert.equal(emptyProgressRow.outcome,null);
  assert.equal(JSON.parse(emptyProgressRow.remote_status_json).originStatusReadFailure.reason,'reply_summary_invalid');
  const unresolvedId='peer-answer-guarantee-unresolved-duty';
  insertRequest(unresolvedId,'version_hold',exactStatus(unresolvedId));
  const unresolvedExecution={turnId:42,runId:'run:42',status:'cancelled',settled:true,acknowledged:true,acknowledgedAt:'2026-11-15T00:00:00.000Z',
   stopped:true,stoppedByTejasAtMs:null,dedicated:true,answersWithTurn:true,steeringStatus:null,text:null,error:null,sha256:null};
  responseOverrides.set(unresolvedId,()=>Response.json(exactStatus(unresolvedId,{acceptedAnswerGuaranteeVersion:1,answerTaskReady:false,
   unresolvedChatGptObligations:1,execution:unresolvedExecution})));
  await peers.notified(unresolvedId);
  const unresolvedRow=db.query('SELECT status,remote_status_json,outcome FROM session_peer_requests WHERE request_id=?').get(unresolvedId) as any;
  const unresolvedRemote=JSON.parse(unresolvedRow.remote_status_json);
  assert.equal(unresolvedRow.status,'admitted','exact v1 status restores protocol compatibility even with an open answer duty');
  assert.equal(unresolvedRow.outcome,null,'an inferred remote cancellation cannot bypass the answer-task guard');
  assert.equal(unresolvedRemote.answerTaskReady,false);assert.equal(unresolvedRemote.unresolvedChatGptObligations,1);
  const malformed404Id='peer-answer-guarantee-malformed-404';
  insertRequest(malformed404Id,'recorded',exactStatus(malformed404Id));
  responseOverrides.set(malformed404Id,()=>new Response('{invalid',{status:404,headers:{'content-type':'application/json'}}));
  await peers.notified(malformed404Id);
  let failed404=db.query('SELECT status,remote_status_json,outcome FROM session_peer_requests WHERE request_id=?').get(malformed404Id) as any;
  assert.equal(failed404.status,'recorded');assert.equal(failed404.outcome,null);
  assert.equal(JSON.parse(failed404.remote_status_json).answerTaskReady,true,'malformed 404 preserves old proof only as diagnostic evidence');
  assert.equal(JSON.parse(failed404.remote_status_json).originStatusReadFailure.httpStatus,404);
  (peers as any).settle((peers as any).row(malformed404Id),'failed','cached readiness after malformed 404 cannot infer closure');
  assert.equal((peers as any).row(malformed404Id).outcome,null);
  const valid404Id='peer-answer-guarantee-valid-404';
  insertRequest(valid404Id,'recorded',exactStatus(valid404Id));
  responseOverrides.set(valid404Id,()=>Response.json({error:'not found'},{status:404}));
  await peers.notified(valid404Id);
  const valid404=db.query('SELECT status,remote_status_json,outcome FROM session_peer_requests WHERE request_id=?').get(valid404Id) as any;
  assert.equal(valid404.outcome,null,'a well-formed non-success status read is not inferred proof of failed execution');
  assert.equal(JSON.parse(valid404.remote_status_json).originStatusReadFailure.reason,'status_http_error');
  assert.equal(JSON.parse(valid404.remote_status_json).originStatusReadFailure.httpStatus,404);
  const unauthorizedId='peer-answer-guarantee-unauthorized-read';
  insertRequest(unauthorizedId,'version_hold',exactStatus(unauthorizedId));
  responseOverrides.set(unauthorizedId,()=>Response.json({error:'unauthorized'},{status:401}));
  await peers.notified(unauthorizedId);
  const unauthorized=db.query('SELECT status,remote_status_json,outcome FROM session_peer_requests WHERE request_id=?').get(unauthorizedId) as any;
  assert.equal(unauthorized.outcome,null);
  assert.equal(JSON.parse(unauthorized.remote_status_json).originStatusReadFailure.reason,'status_unauthorized');
  assert.equal(JSON.parse(unauthorized.remote_status_json).originStatusReadFailure.httpStatus,401);
  const timeoutId='peer-answer-guarantee-timeout-recovery';
  insertRequest(timeoutId,'version_hold',exactStatus(timeoutId));
  responseOverrides.set(timeoutId,()=>{throw new TypeError('fixture socket timeout');});
  await peers.notified(timeoutId);
  let timeoutRow=(peers as any).row(timeoutId);
  assert.equal(JSON.parse(timeoutRow.remote_status_json).originStatusReadFailure.reason,'status_unreachable');
  const timeoutFinal={eventId:'timeout-no-proof-final',kind:'final',text:'Exact peer final',replyBody:'Exact peer final',workDisposition:'completed',
   responder:{peer:'mac',sessionId:`concierge:${target.id}`,inputId:'remote-input',runId:'remote-run'}};
  assert.equal((peers as any).recordReply(timeoutRow,timeoutFinal).recorded,'refused',
   'a timeout also makes cached readiness unusable for a proofless legacy final');
  responseOverrides.delete(timeoutId);mode='valid';calls=0;
  await peers.notified(timeoutId);
  timeoutRow=(peers as any).row(timeoutId);
  assert.equal(JSON.parse(timeoutRow.remote_status_json).originStatusReadFailure,undefined);
  assert.equal((peers as any).recordReply(timeoutRow,timeoutFinal).recorded,'recorded',
   'a fresh exact ready status restores the existing legacy-final fallback');
  const validProofId='peer-answer-guarantee-independent-final-proof';
  const validProofStatus={...exactStatus(validProofId),originStatusReadFailure:{requestId:validProofId,peer:'mac',reason:'status_http_error',httpStatus:404,observedAt:'before'}};
  insertRequest(validProofId,'recorded',validProofStatus);
  const selfContainedFinal={eventId:'self-contained-final-proof',kind:'final',text:'Explicit exact final',replyBody:'Explicit exact final',workDisposition:'completed',
   settlementProof:{version:1,requestId:validProofId,recipientPeer:'mac',targetSessionId:`concierge:${target.id}`,unresolvedObligations:0},
   responder:{peer:'mac',sessionId:`concierge:${target.id}`,inputId:'remote-input',runId:'remote-run'}};
  assert.equal((peers as any).recordReply((peers as any).row(validProofId),selfContainedFinal).recorded,'recorded',
   'a self-contained exact final proof remains usable despite a separate status-read failure');
  const cancelActor={session:source.id,turn:turn.id,inputId:sourceInput.id};
  peers.cancel(cancelActor,malformed404Id,'fixture-authorized-cancel','stop this exact request');
  failed404=db.query('SELECT status,remote_status_json,outcome FROM session_peer_requests WHERE request_id=?').get(malformed404Id) as any;
  assert.equal(failed404.outcome,'canceled','the requester’s explicit cancellation remains effective after a failed status read');
  const missingTargetId='peer-answer-guarantee-missing-target';
  insertRequest(missingTargetId,'queued_offline',null,JSON.stringify({requestId:missingTargetId,text:'retained exact body'}));
  responseOverrides.set(missingTargetId,()=>Response.json({requestId:missingTargetId,inputState:'queued',stillWorking:false,execution:null,replies:[]}));
  const client=(peers as any).dependencies.clients.get('mac');
  const adopted=await (peers as any).adoptPeerHeldRequest(client,(peers as any).row(missingTargetId),'fixture idempotency conflict');
  const missingTargetRow=db.query('SELECT status,remote_session_id,remote_address,remote_status_json,outcome FROM session_peer_requests WHERE request_id=?').get(missingTargetId) as any;
  assert.equal(adopted,false);assert.equal(missingTargetRow.status,'queued_offline');assert.equal(missingTargetRow.outcome,null);
  assert.equal(missingTargetRow.remote_session_id,`concierge:${target.id}`,'request-only validation cannot adopt a status without its target fields');
  assert.equal(JSON.parse(missingTargetRow.remote_status_json).originStatusReadFailure.reason,'status_target_invalid');
  const documentedShapeId='peer-answer-guarantee-documented-shape';
  insertRequest(documentedShapeId,'version_hold',exactStatus(documentedShapeId));
  responseOverrides.set(documentedShapeId,()=>Response.json(exactStatus(documentedShapeId,{execution:{turnId:43,runId:'run:43',status:'running',settled:false,
   acknowledged:true,acknowledgedAt:'2026-11-15T00:00:00.000Z',stopped:false,dedicated:true,steeringStatus:null,text:null,error:null,sha256:null},
   replies:[{eventId:'legacy-summary-without-files',kind:'progress',status:'forwarded',text:'Documented older summary',workDisposition:null,createdAtMs:Date.now(),completion:null}]})));
  await peers.notified(documentedShapeId);
  const documentedRow=db.query('SELECT status,outcome FROM session_peer_requests WHERE request_id=?').get(documentedShapeId) as any;
  assert.equal(documentedRow.status,'admitted');assert.equal(documentedRow.outcome,null,
   'documented status remains valid when newer additive execution and file-count fields are omitted');
  assert.ok(db.query("SELECT 1 FROM session_peer_events WHERE event_id='legacy-summary-without-files'").get());
  assert.equal(requestPosts,0,'no status case replays the original peer request');
  mode='wrong-identity';calls=0;await peers.notified(requestId);
  row=db.query('SELECT status,remote_status_json,outcome FROM session_peer_requests WHERE request_id=?').get(requestId) as any;
  assert.equal(row.status,'version_hold');assert.equal(row.outcome,null);
  assert.equal(JSON.parse(row.remote_status_json).originStatusReadFailure.reason,'request_id_mismatch');
  mode='contradictory';calls=0;await peers.notified(requestId);
  row=db.query('SELECT status,remote_status_json,outcome FROM session_peer_requests WHERE request_id=?').get(requestId) as any;
  assert.equal(row.status,'version_hold');assert.equal(row.outcome,null);
  assert.equal(JSON.parse(row.remote_status_json).originStatusReadFailure.reason,'answer_guarantee_evidence_incomplete');
  const progressPayload={text:'Original retained progress',turnOutcome:'needs_you'};
  db.query("INSERT INTO session_peer_events(event_id,request_id,kind,payload_json,created_at_ms,status) VALUES('retained-progress',?,'progress',?,?, 'received')")
   .run(requestId,JSON.stringify(progressPayload),Date.now());
  mode='legacy';calls=0;await peers.notified(requestId);
  const restartedPeers=new SessionPeers({self:'cloud',clients:new Map([['mac',new PeerClient('mac','http://fixture.invalid','fixture')]]),owner,
   isOwnerAlive:()=>true,onError:error=>{throw error;}});
  (restartedPeers as any).stopped=false;(restartedPeers as any).peerReadController=new AbortController();
  await restartedPeers.notified(requestId);await restartedPeers.stop();
  assert.equal((peers as any).row(requestId).status,'version_hold','an exact legacy status stays held after restart');
  const legacyRemote=JSON.parse((peers as any).row(requestId).remote_status_json);
  assert.equal(legacyRemote.answerGuaranteeVersion,undefined,'the current exact legacy status replaces stale v1 proof');
  assert.equal(legacyRemote.originStatusReadFailure,undefined,'a valid exact legacy read clears the transport read failure');
  assert.equal(db.query("SELECT count(*) AS n FROM session_peer_events WHERE request_id=? AND json_extract(payload_json,'$.health')='peer answer guarantee unconfirmed'").get(requestId)?.n,3,
   'legacy polling reuses the historical typed notice identity');
  assert.deepEqual(JSON.parse((db.query("SELECT payload_json FROM session_peer_events WHERE event_id='retained-progress'").get() as any).payload_json),progressPayload,
   'progress remains unchanged while the same request is held');
  mode='valid';calls=0;
  await peers.notified(requestId);
  row=db.query('SELECT status,remote_status_json,delivery_json,outcome FROM session_peer_requests WHERE request_id=?').get(requestId) as any;
  remote=JSON.parse(row.remote_status_json);
  assert.equal(row.status,'recorded','an exact upgraded status releases the compatibility hold');
  assert.equal(row.delivery_json,null);assert.equal(row.outcome,null);
  assert.equal(remote.answerGuaranteeVersion,1);assert.equal(remote.answerTaskReady,true);assert.equal(remote.unresolvedChatGptObligations,0);
  assert.equal(remote.originStatusReadFailure,undefined);assert.equal(typeof remote.originStatusReadRecoveredAt,'string');
  assert.equal(calls,1,'hold recovery uses one status response, not a second GET');
  assert.equal(maximumActive,1,'same-request reconciliations never overlap');
  assert.equal(db.query("SELECT count(*) AS n FROM session_peer_events WHERE request_id=? AND json_extract(payload_json,'$.health')='peer answer guarantee unconfirmed'").get(requestId)?.n,3,
   'recovery preserves historical reminders without creating a fourth');
  assert.equal(db.query('SELECT count(*) AS n FROM session_peer_events WHERE request_id=?').get(requestId)?.n,5,
   'only the separate settlement guard event is added; progress and version-hold history stay intact');
  assert.equal(requestPosts,0,'status recovery never replays the accepted peer request');
  const secondId='peer-answer-guarantee-new-request';
  insertRequest(secondId,'recorded',null,null,'peer-guarantee-action-2');
  mode='legacy';calls=0;await peers.notified(secondId);await peers.notified(secondId);
  const newNotice=db.query("SELECT event_id FROM session_peer_events WHERE request_id=? AND json_extract(payload_json,'$.health')='peer answer guarantee unconfirmed'").all(secondId) as {event_id:string}[];
  assert.deepEqual(newNotice,[{event_id:`peer-answer-guarantee-hold:${secondId}`}],
    'a new held request gets one stable notice identity across repeated exact legacy status reads');
  const lateId='peer-answer-guarantee-late-terminal';
  insertRequest(lateId,'version_hold',exactStatus(lateId));
  const late=peers.notified(lateId);await lateStarted;
  db.query("UPDATE session_peer_requests SET status='settled',outcome='answered' WHERE request_id=?").run(lateId);
  releaseLate();await late;
  const lateRow=db.query('SELECT status,outcome FROM session_peer_requests WHERE request_id=?').get(lateId) as any;
  assert.deepEqual(lateRow,{status:'settled',outcome:'answered'},'a terminal completion during an in-flight read is never resurrected');
  assert.equal(requestPosts,0,'neither recovery path posts the request again');
  assert.equal((peers as any).recordReply((peers as any).row(requestId),legacyFinal).recorded,'recorded',
    'the same legacy final is accepted after a fresh exact upgraded ready status');
  await peers.stop();
  assert.equal(cancelPosts,1,'the exact explicit cancellation is also sent through the normal peer revoke path');
  console.log(JSON.stringify({fixture:'peer-answer-guarantee',malformedStatusPreservedProof:true,nestedExecutionAndReplyValidation:true,
   emptyProgressRejectedBeforeWrite:true,malformedInputErrorRejectedBeforeWrite:true,
   overlapSerialized:true,exactHoldRecoverySingleRead:true,historicalNoticeIdentitiesPreserved:true,progressPreserved:true,
   failedReadsBlockCachedInference:true,explicitCancelEffective:true,unresolvedDutyBlocksRemoteCancel:true,
   independentFinalProofUsable:true,noReplay:requestPosts===0}));
 }finally{globalThis.fetch=oldFetch;await peers.stop();}
}
if(import.meta.main){if(process.argv[2]==='--child')child().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});else console.log(JSON.stringify(await checkPeerAnswerGuarantee()));}
