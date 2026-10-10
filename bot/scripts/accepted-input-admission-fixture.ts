import {strict as assert} from 'node:assert';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runFixtureChild} from './fixture-child';

/** Private composed ledger check; never imports the owner before the guarded child has a scratch directory. */
export async function checkAcceptedInputAdmission() {
 const state=await mkdtemp(join(tmpdir(),'concierge-accepted-input-'));
 try{return await runFixtureChild({command:process.execPath,args:[import.meta.path,'--child'],env:{...process.env,
  CONCIERGE_TEST_MODE:'1',CONCIERGE_TEST_AUTHORIZATION:'native-attribution-5eaa0768',
  CONCIERGE_STATE_DIR:state,CONCIERGE_CAPTURE_STATE_DIR:join(state,'capture')},deadlineMs:30_000,fixture:'accepted-input-admission'});
 }finally{await rm(state,{recursive:true,force:true});}
}

async function child() {
 const phase=(name:string)=>console.error(JSON.stringify({phase:name}));
 phase('starting');
 const [{db},{createNativeSession,retainSessionInput,enqueueSessionInput},{SessionOwner,sessionAddress},{SessionCommunicationCoordinator},{recordForwardedThreadReply},{SessionPeers,PeerClient},{claimQueuedTurnWithSavedWork}]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/session-owner'),import('../src/session-communication'),import('../src/session-inbox'),import('../src/session-peers'),import('../src/saved-work')]);
 phase('owner-loaded');
 const {requestApiHandler}=await import('../src/routed-request-api');
 const writes:string[]=[];
 const originalWrite=process.stderr.write;
 let attempts=0;
 process.stderr.write=((chunk:unknown)=>{writes.push(String(chunk));return true;}) as typeof process.stderr.write;
 try {
  const handler=requestApiHandler(null,null,{post(){attempts++;throw Object.assign(new Error('database is locked'),{code:'SQLITE_BUSY'});}} as any);
  const response=await handler(new Request('http://fixture/session-communication/post',{method:'POST',body:JSON.stringify({text:'private fixture words'})}));
  assert.equal(response.status,503);
  assert.equal(attempts,1,'the error boundary must not replay a command');
  const record=writes.map(line=>JSON.parse(line)).find(row=>row.event==='native_command_database_failed');
  assert.equal(record?.operation,'post');assert.equal(record?.code,'SQLITE_BUSY');
  assert.ok(!writes.join('').includes('private fixture words'));
 } finally {process.stderr.write=originalWrite;}
 const session=createNativeSession('codex',{title:'Private accepted input fixture'});
 let runtimeWakes=0;
 const owner=new SessionOwner({wake(){runtimeWakes++;},steer(){return false;},async stop(){return false;},available(){return true;}} as any,process.cwd());
 const first={clientActionId:'fixture-accepted',text:'An exact accepted request'};
 db.exec("CREATE TRIGGER fixture_refuse_turn BEFORE INSERT ON turns BEGIN SELECT RAISE(ABORT,'fixture turn insertion failed'); END");
 assert.throws(()=>owner.submit(`concierge:${session.id}`,first),/fixture turn insertion failed/);
 assert.equal((db.query("SELECT count(*) AS n FROM session_inputs WHERE action_id='fixture-accepted'").get() as {n:number}).n,0,
  'failed turn insertion must roll back acceptance');
 db.exec('DROP TRIGGER fixture_refuse_turn');
 const accepted=owner.submit(`concierge:${session.id}`,first).operation as {operationId:string};
 assert.equal((db.query('SELECT count(*) AS n FROM turns WHERE accepted_input_id=?').get(accepted.operationId) as {n:number}).n,1);
 assert.ok(runtimeWakes>0,'atomic admission must wake the execution queue after commit');
 const claim=claimQueuedTurnWithSavedWork('accepted-input-fixture-provider',[]);
 assert.equal(claim?.accepted_input_id,accepted.operationId,'the awakened queue must admit the exact accepted input');
 assert.equal(claimQueuedTurnWithSavedWork('accepted-input-fixture-provider',[]),null,'the provider must not receive the same turn twice');
 owner.submit(`concierge:${session.id}`,first);
 assert.equal((db.query('SELECT count(*) AS n FROM turns WHERE accepted_input_id=?').get(accepted.operationId) as {n:number}).n,1);
 assert.throws(()=>owner.submit(`concierge:${session.id}`,{...first,text:'A different request'}),/Idempotency conflict/);
 // A pre-repair orphan has no proof that provider custody is absent; leave it untouched.
 const orphan=retainSessionInput({sessionId:session.id,scope:'surface:thinkering',actionId:'fixture-legacy-orphan',kind:'input',origin:'human',
  payload:{clientActionId:'fixture-legacy-orphan',text:'A retained input from before atomic admission'}}).input;
 const restarted=new SessionOwner({wake(){},steer(){return false;},async stop(){return false;},available(){return true;}} as any,process.cwd());
 restarted.submit(`concierge:${session.id}`,{clientActionId:'fixture-legacy-orphan',text:'A retained input from before atomic admission'});
 assert.equal((db.query('SELECT count(*) AS n FROM turns WHERE accepted_input_id=?').get(orphan.id) as {n:number}).n,0);
 assert.equal(JSON.parse((db.query('SELECT receipt_json FROM session_inputs WHERE id=?').get(orphan.id) as {receipt_json:string}).receipt_json).state,'uncertain');
 // A new admission path records the queue intent while the destination is unavailable.
 const pending=retainSessionInput({sessionId:session.id,scope:'surface:thinkering',actionId:'fixture-pending',kind:'input',origin:'human',
  payload:{clientActionId:'fixture-pending',text:'A retained explicit queue intent'}}).input;
 db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({admissionIntent:'queue'}),pending.id);
 restarted.recoverAcceptedInput((await import('../src/session-inputs')).getAcceptedSessionInput(pending.id)!);
 restarted.recoverAcceptedInput((await import('../src/session-inputs')).getAcceptedSessionInput(pending.id)!);
 assert.equal((db.query('SELECT count(*) AS n FROM turns WHERE accepted_input_id=?').get(pending.id) as {n:number}).n,1);
 phase('queue-verified');
 const inbox=createNativeSession('codex',{title:'Private Inbox forwarding fixture'});
 const target=createNativeSession('codex',{title:'Private recipient fixture'});
 const standIn=retainSessionInput({sessionId:inbox.id,scope:'fixture-stand-in',actionId:'stand-in',kind:'input',origin:'human',payload:{text:'Root'}}).input;
 enqueueSessionInput(standIn.id);
 const route={sessionId:`concierge:${target.id}`,local:target.id,peer:null,title:'Private recipient fixture',topicId:'fixture-topic',root:standIn.id};
 const coordinator=new SessionCommunicationCoordinator({owner:restarted,isOwnerAlive:()=>true,onError:error=>{throw error;}});
 restarted.communication=coordinator;
 // Keep this fixture at the admission boundary; the scheduled reconciler would add
 // unrelated background work here.
 (coordinator as any).stopped=false;
 const forwarded=retainSessionInput({sessionId:inbox.id,scope:'surface:thinkering',actionId:'fixture-forward',kind:'input',origin:'human',
  payload:{clientActionId:'fixture-forward',text:'Exact forwarded words'}}).input;
 try{
  db.exec("CREATE TRIGGER fixture_refuse_request BEFORE INSERT ON session_communication_requests BEGIN SELECT RAISE(ABORT,'fixture request insertion failed'); END");
  assert.throws(()=>db.transaction(()=>{
   recordForwardedThreadReply(inbox,forwarded,route);
   coordinator.forwardReply({inbox,inputId:forwarded.id,target:route,text:'Exact forwarded words'});
  })(),/fixture request insertion failed/);
  assert.equal((db.query('SELECT receipt_json FROM session_inputs WHERE id=?').get(forwarded.id) as {receipt_json:string|null}).receipt_json,null,
   'failed local request insertion must roll back waiting receipt');
  db.exec('DROP TRIGGER fixture_refuse_request');
  // An older accepted waiting receipt is a durable intent for the original destination.
  recordForwardedThreadReply(inbox,forwarded,route);
  restarted.recoverAcceptedInput((await import('../src/session-inputs')).getAcceptedSessionInput(forwarded.id)!);
  restarted.recoverAcceptedInput((await import('../src/session-inputs')).getAcceptedSessionInput(forwarded.id)!);
  assert.equal((db.query('SELECT count(*) AS n FROM session_communication_requests WHERE source_input_id=?').get(forwarded.id) as {n:number}).n,1);
  assert.equal((db.query('SELECT count(*) AS n FROM session_inputs WHERE scope=?').get(`session:${forwarded.id}`) as {n:number}).n,1);
 }finally{(coordinator as any).stopped=true;}
 phase('local-forward-verified');
 const peers=new SessionPeers({self:'mac',clients:new Map([['cloud',new PeerClient('cloud','http://127.0.0.1','fixture')]]),owner:restarted,
  isOwnerAlive:()=>true,onError:error=>{throw error;}});
 const peerBody={requestId:crypto.randomUUID(),origin:{peer:'cloud',sessionId:'concierge:11',inputId:'fixture-source',runId:'run:11'},
  address:sessionAddress(target),text:'Exact peer forwarded reply',requestedEffect:'work',
  forwardedReply:{inboxInputId:'fixture-source',topicId:'fixture-topic'}};
 db.exec("CREATE TRIGGER fixture_refuse_peer_turn BEFORE INSERT ON turns BEGIN SELECT RAISE(ABORT,'fixture peer turn insertion failed'); END");
 assert.throws(()=>peers.accept(peerBody),/fixture peer turn insertion failed/);
 assert.equal((db.query('SELECT count(*) AS n FROM session_peer_deliveries WHERE request_id=?').get(peerBody.requestId) as {n:number}).n,0);
 db.exec('DROP TRIGGER fixture_refuse_peer_turn');
 peers.accept(peerBody);
 peers.accept(peerBody);
 assert.throws(()=>peers.accept({...peerBody,text:'Changed words under the same peer ID'}),/Idempotency conflict/);
 phase('peer-forward-verified');
 assert.equal((db.query('SELECT count(*) AS n FROM session_peer_deliveries WHERE request_id=?').get(peerBody.requestId) as {n:number}).n,1);
 assert.equal((db.query('SELECT count(*) AS n FROM turns WHERE accepted_input_id=?').get(`request:${peerBody.requestId}`) as {n:number}).n,1);
 console.log(JSON.stringify({fixture:'accepted-input-admission',rollback:true,duplicateOneTurn:true,payloadConflict:true,unprovenOrphanHeld:true,recoveredOneTurn:true,
  forwardingRollback:true,forwardingRecoveryOneRequest:true,peerForwardingAtomic:true,peerPayloadConflict:true}));
}

if(import.meta.main){
 if(process.argv[2]==='--child')child().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
 else console.log(JSON.stringify(await checkAcceptedInputAdmission()));
}
