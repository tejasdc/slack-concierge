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
 db.query(`INSERT INTO session_peer_requests(request_id,peer,source_session_id,source_turn_id,source_input_id,action_id,payload_json,payload_hash,
   remote_session_id,remote_address,remote_operation_id,remote_status_json,delivery_json,status,due_at_ms,created_at_ms)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,? ,NULL,'version_hold',?,?)`).run(requestId,'mac',source.id,turn.id,sourceInput.id,'peer-guarantee-action',JSON.stringify(requestPayload),'fixture-hash',
   `concierge:${target.id}`,sessionAddress(target),`request:${requestId}`,JSON.stringify({requestId,sessionId:`concierge:${target.id}`,address:sessionAddress(target),inputState:'queued',stillWorking:false,execution:null,replies:[],answerGuaranteeVersion:1,acceptedAnswerGuaranteeVersion:null,answerTaskReady:true,unresolvedChatGptObligations:0,observedAt:'before'}),Date.now()+60_000,Date.now());
 // These are the already-retained random event identities from the incident shape. Reconciliation
 // must reuse the typed health identity and preserve all three historical records.
 for(const id of ['old-random-reminder-a','old-random-reminder-b','old-random-reminder-c'])
  db.query('INSERT INTO session_peer_events(event_id,request_id,kind,payload_json,created_at_ms,status) VALUES(?,?,\'overdue\',?,?,\'received\')')
   .run(id,requestId,JSON.stringify({health:'peer answer guarantee unconfirmed',text:`historical ${id}`}),Date.now());
 let mode:'malformed'|'wrong-identity'|'contradictory'|'legacy'|'valid'='malformed';let active=0;let maximumActive=0;let calls=0;let posts=0;let release!:()=>void;
 const barrier=new Promise<void>(resolve=>{release=resolve;});
 let beginLate!:()=>void;let releaseLate!:()=>void;
 const lateStarted=new Promise<void>(resolve=>{beginLate=resolve;});const lateGate=new Promise<void>(resolve=>{releaseLate=resolve;});
 const oldFetch=globalThis.fetch;
 globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const match=String(input).match(/\/requests\/([^/?]+)/);const observedId=match?.[1];
  const isStatus=!!observedId;
  if(!isStatus)return Response.json({sessions:[]});
  if(init?.method==='POST'){posts++;return Response.json({outcome:null});}
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
  assert.equal(posts,0,'status recovery never replays the accepted peer request');
  const secondId='peer-answer-guarantee-new-request';
  db.query(`INSERT INTO session_peer_requests(request_id,peer,source_session_id,source_turn_id,source_input_id,action_id,payload_json,payload_hash,
    remote_session_id,remote_address,remote_operation_id,delivery_json,status,due_at_ms,created_at_ms)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,'recorded',?,?)`).run(secondId,'mac',source.id,turn.id,sourceInput.id,'peer-guarantee-action-2',JSON.stringify(requestPayload),'fixture-hash-2',
      `concierge:${target.id}`,sessionAddress(target),`request:${secondId}`,Date.now()+60_000,Date.now());
  mode='legacy';calls=0;await peers.notified(secondId);await peers.notified(secondId);
  const newNotice=db.query("SELECT event_id FROM session_peer_events WHERE request_id=? AND json_extract(payload_json,'$.health')='peer answer guarantee unconfirmed'").all(secondId) as {event_id:string}[];
  assert.deepEqual(newNotice,[{event_id:`peer-answer-guarantee-hold:${secondId}`}],
    'a new held request gets one stable notice identity across repeated exact legacy status reads');
  const lateId='peer-answer-guarantee-late-terminal';
  db.query(`INSERT INTO session_peer_requests(request_id,peer,source_session_id,source_turn_id,source_input_id,action_id,payload_json,payload_hash,
    remote_session_id,remote_address,remote_operation_id,remote_status_json,delivery_json,status,due_at_ms,created_at_ms)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,'version_hold',?,?)`).run(lateId,'mac',source.id,turn.id,sourceInput.id,'peer-guarantee-late',JSON.stringify(requestPayload),'fixture-hash-late',
      `concierge:${target.id}`,sessionAddress(target),`request:${lateId}`,JSON.stringify({requestId:lateId,sessionId:`concierge:${target.id}`,address:sessionAddress(target),inputState:'queued',stillWorking:false,execution:null,replies:[],answerGuaranteeVersion:1,acceptedAnswerGuaranteeVersion:1,answerTaskReady:true,unresolvedChatGptObligations:0}),Date.now()+60_000,Date.now());
  const late=peers.notified(lateId);await lateStarted;
  db.query("UPDATE session_peer_requests SET status='settled',outcome='answered' WHERE request_id=?").run(lateId);
  releaseLate();await late;
  const lateRow=db.query('SELECT status,outcome FROM session_peer_requests WHERE request_id=?').get(lateId) as any;
  assert.deepEqual(lateRow,{status:'settled',outcome:'answered'},'a terminal completion during an in-flight read is never resurrected');
  assert.equal(posts,0,'neither recovery path posts the request again');
  assert.equal((peers as any).recordReply((peers as any).row(requestId),legacyFinal).recorded,'recorded',
    'the same legacy final is accepted after a fresh exact upgraded ready status');
  console.log(JSON.stringify({fixture:'peer-answer-guarantee',malformedStatusPreservedProof:true,overlapSerialized:true,
   exactHoldRecoverySingleRead:true,historicalNoticeIdentitiesPreserved:true,progressPreserved:true,noReplay:posts===0}));
 }finally{globalThis.fetch=oldFetch;await peers.stop();}
}
if(import.meta.main){if(process.argv[2]==='--child')child().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});else console.log(JSON.stringify(await checkPeerAnswerGuarantee()));}
