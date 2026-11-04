import {afterEach,beforeEach,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {db} from '../src/state';
import {createNativeSession,enqueueSessionInput,nativeRunId,retainSessionInput} from '../src/session-inputs';
import {forwardedHumanWorkInput} from '../src/session-peers';
import '../src/watches';
import {acquireDatabaseTestLock} from './db-lock';

let release:()=>void;
let sessionId:number;
let watchId:string;
let peerRequestId:string;
let peerEventId:string;
let localRequestId:string;
let localEventId:string;

beforeEach(async()=>{
  release=await acquireDatabaseTestLock();
  sessionId=createNativeSession('codex',{cwd:'/tmp',purpose:'chat',summary:'Authorization fixture'}).id;
  watchId=randomUUID();
  peerRequestId=randomUUID();
  peerEventId=randomUUID();
  localRequestId=randomUUID();
  localEventId=randomUUID();
});
afterEach(()=>{
  db.query('DELETE FROM session_communication_events WHERE event_id=?').run(localEventId);
  db.query('DELETE FROM session_communication_requests WHERE request_id=?').run(localRequestId);
  db.query('DELETE FROM session_peer_events WHERE event_id=?').run(peerEventId);
  db.query('DELETE FROM session_peer_requests WHERE request_id=?').run(peerRequestId);
  db.query('DELETE FROM watches WHERE watch_id=?').run(watchId);
  db.query('DELETE FROM session_owner_events WHERE session_id=?').run(sessionId);
  db.query('DELETE FROM session_inputs WHERE session_id=?').run(sessionId);
  db.query('DELETE FROM turns WHERE session_id=?').run(sessionId);
  db.query('DELETE FROM sessions WHERE id=?').run(sessionId);
  release();
});

test('only owner-recorded watch and work-return continuations carry a forwarded human work input',()=>{
  const root=enqueueSessionInput(retainSessionInput({sessionId,scope:'surface:thinkering',actionId:randomUUID(),kind:'input',origin:'agent',payload:{text:'Forwarded human reply'}}).input.id);
  const rootRun=nativeRunId(root.turn_id!);
  const watchInput=enqueueSessionInput(retainSessionInput({id:`watch:${watchId}:fired`,sessionId,scope:'service:watch',actionId:randomUUID(),kind:'watch',origin:'service',
    sourceInputId:root.id,sourceRunId:rootRun,requestId:`watch:${watchId}:fired`,payload:{text:'Release changed'}}).input.id);
  db.query(`INSERT INTO watches (watch_id,session_id,origin_input_id,origin_run_id,action_id,request_hash,kind,condition_json,baseline_json,baseline_mode,deadline_ms,state,delivery_input_id,created_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(watchId,sessionId,root.id,rootRun,'fixture','fixture','file','{}','{}','exists',Date.now()+60_000,'fired',watchInput.id,Date.now());
  const actor={session:sessionId} as Parameters<typeof forwardedHumanWorkInput>[0];
  expect(forwardedHumanWorkInput(actor,watchInput)?.id).toBe(root.id);

  const watchRun=nativeRunId(watchInput.turn_id!);
  const returned=retainSessionInput({id:`return:${peerEventId}`,sessionId,scope:'service:peer-return',actionId:randomUUID(),kind:'return',origin:'service',
    sourceInputId:watchInput.id,sourceRunId:watchRun,requestId:peerRequestId,payload:{text:'Mac result'}}).input;
  db.query(`INSERT INTO session_peer_requests (request_id,peer,source_session_id,source_turn_id,source_input_id,action_id,payload_json,payload_hash,remote_session_id,remote_address,remote_operation_id,due_at_ms,created_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(peerRequestId,'mac',sessionId,watchInput.turn_id,watchInput.id,'fixture',JSON.stringify({requestedEffect:'work'}),'fixture','mac:274','mac/session:fixture','fixture',Date.now()+60_000,Date.now());
  db.query(`INSERT INTO session_peer_events (event_id,request_id,kind,payload_json,accepted_input_id,created_at_ms)
    VALUES (?,?,?,?,?,?)`).run(peerEventId,peerRequestId,'final','{}',returned.id,Date.now());
  expect(forwardedHumanWorkInput(actor,returned)?.id).toBe(root.id);

  db.query(`UPDATE session_peer_requests SET payload_json=? WHERE request_id=?`).run(JSON.stringify({requestedEffect:'informational'}),peerRequestId);
  expect(forwardedHumanWorkInput(actor,returned)).toBeNull();
  db.query(`UPDATE session_peer_requests SET payload_json=? WHERE request_id=?`).run(JSON.stringify({requestedEffect:'work'}),peerRequestId);
  db.query('UPDATE watches SET origin_run_id=? WHERE watch_id=?').run('wrong-run',watchId);
  expect(forwardedHumanWorkInput(actor,returned)).toBeNull();
  db.query('UPDATE watches SET origin_run_id=? WHERE watch_id=?').run(rootRun,watchId);

  const unrelated=retainSessionInput({id:`return:${randomUUID()}`,sessionId,scope:'service:peer-return',actionId:randomUUID(),kind:'return',origin:'service',
    sourceInputId:watchInput.id,sourceRunId:watchRun,requestId:peerRequestId,payload:{text:'Unrecorded result'}}).input;
  expect(forwardedHumanWorkInput(actor,unrelated)).toBeNull();

  const localReturn=retainSessionInput({id:`return:${localEventId}`,sessionId,scope:'service:local-return',actionId:randomUUID(),kind:'return',origin:'service',
    sourceInputId:root.id,sourceRunId:rootRun,requestId:localRequestId,payload:{text:'Local agent result'}}).input;
  db.query(`INSERT INTO session_communication_requests
    (request_id,source_channel,source_message_ts,source_turn_id,source_session_id,source_root_ts,source_input_id,action_id,
      target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(localRequestId,'fixture',randomUUID(),root.turn_id,sessionId,'fixture',root.id,
      'fixture',sessionId,'fixture','fixture',JSON.stringify({requestedEffect:'work'}),'fixture',Date.now()+60_000,Date.now());
  db.query(`INSERT INTO session_communication_events (event_id,request_id,kind,payload_json,accepted_input_id,created_at_ms)
    VALUES (?,?,?,?,?,?)`).run(localEventId,localRequestId,'final','{}',localReturn.id,Date.now());
  expect(forwardedHumanWorkInput(actor,localReturn)?.id).toBe(root.id);
  db.query(`UPDATE session_communication_requests SET payload_json=? WHERE request_id=?`).run(JSON.stringify({requestedEffect:'informational'}),localRequestId);
  expect(forwardedHumanWorkInput(actor,localReturn)).toBeNull();
  db.query(`UPDATE session_communication_requests SET payload_json=? WHERE request_id=?`).run(JSON.stringify({requestedEffect:'work'}),localRequestId);
  db.query(`UPDATE session_communication_events SET accepted_input_id=? WHERE event_id=?`).run(unrelated.id,localEventId);
  expect(forwardedHumanWorkInput(actor,localReturn)).toBeNull();
});
