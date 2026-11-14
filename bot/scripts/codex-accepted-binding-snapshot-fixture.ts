import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION} from '../src/test-authorizations';
const scratch=mkdtempSync(join(tmpdir(),'concierge-binding-snapshot-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION;
const [{db},{createNativeSession,retainSessionInput,enqueueSessionInput,nativeRunId,recordSessionEvent},
  {inspectAcceptedBindingContinuation}]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/codex-accepted-binding-snapshot')]);
try {
  // Exact legacy receipt shape used by codex-continuation-inspection-fixture:
  // no admission effort and null nativeBinding; current stable local runner null.
  const session=createNativeSession('codex',{title:'legacy retained writing',purpose:'continue accepted work',origin:'native',
    model:'gpt-6-astra',reasoningEffort:'medium',providerRunner:null} as any);
  db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run('same-thread',session.id);
  const save=(id:string,kind:any,origin:any,payload:any,extra:any={})=>retainSessionInput({id,sessionId:session.id,
    scope:'fixture',actionId:id,kind,origin,payload,...extra}).input;
  const create=save('request:create','create','agent',{provider:'codex',model:'gpt-6-astra',reasoningEffort:'medium',firstInput:{text:'original words'}});
  const createTurn=enqueueSessionInput(create.id).turn_id!;
  const source=save('request:work','request','agent',{text:'accepted work'},{requestId:'work'});
  const sourceTurn=enqueueSessionInput(source.id).turn_id!;
  const report=save('report-back:work','input','service',{text:'exact retained reminder'},
    {requestId:'work',sourceInputId:source.id,sourceRunId:nativeRunId(sourceTurn)});
  const reportTurn=enqueueSessionInput(report.id).turn_id!;
  const admission=(id:string,turnId:number)=>({provider:'codex',inputId:id,runId:nativeRunId(turnId),bindingGeneration:1,
    model:'gpt-6-astra',nativeBinding:null});
  for(const [id,turnId] of [[create.id,createTurn],[source.id,sourceTurn],[report.id,reportTurn]] as const){
    db.query("UPDATE turns SET status='done',dispatch_attempt=1 WHERE id=?").run(turnId);
    db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({admission:admission(id,turnId)}),id);
  }
  db.query('UPDATE turns SET provider_input_acknowledged_at=CURRENT_TIMESTAMP WHERE id IN (?,?)').run(createTurn,sourceTurn);
  recordSessionEvent({eventId:`prompt-cache-identity:${reportTurn}:1`,sessionId:session.id,turnId:reportTurn,
    kind:'prompt_cache_identity',payload:{effort:'medium'}});
  db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,
    source_root_ts,action_id,target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms,
    source_input_id,target_input_id,status,outcome) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('work','fixture','source',sourceTurn,session.id,'root','work',session.id,'fixture','root',
      JSON.stringify({requestedEffect:'work'}),'hash',0,0,source.id,source.id,'admitted',null);
  const inspect=()=>inspectAcceptedBindingContinuation({sessionId:session.id,inputId:report.id,requestId:'work'});
  const retained=()=>JSON.stringify({inputs:db.query('SELECT * FROM session_inputs ORDER BY rowid').all(),
    turns:db.query('SELECT * FROM turns ORDER BY id').all(),events:db.query('SELECT * FROM session_owner_events ORDER BY sequence').all(),
    requests:db.query('SELECT * FROM session_communication_requests').all()});
  const before=retained(),legacy=inspect();
  assert.equal(legacy.proven,false);
  assert.deepEqual(legacy.reasons.map(row=>row.code),['CREATION_NATIVE_BINDING_NOT_PROVEN','SELECTED_NATIVE_BINDING_NOT_PROVEN'],
    'legacy null native binding does not magically establish the native thread');
  assert.equal(retained(),before,'snapshot reads never mutate retained state');
  // Use the actual retained result format, rather than a fictional binding event.
  for(const [id,turnId] of [[create.id,createTurn],[report.id,reportTurn]] as const)
    recordSessionEvent({eventId:`result:${turnId}`,sessionId:session.id,inputId:id,turnId,kind:'result',
      payload:{runId:nativeRunId(turnId),sessionUUID:'same-thread',model:'gpt-6-astra',text:'',toolsUsed:[]}});
  const proven=inspect();assert.equal(proven.proven,true,JSON.stringify(proven.reasons));
  assert.equal(proven.authorizesProviderStart,false);
  const digest='snapshotDigest' in proven?proven.snapshotDigest:null;
  const held=save('action:held-pause','action','human',{action:'pause'});
  const heldInspection=inspect();assert.equal(heldInspection.proven,false);
  assert.ok(heldInspection.reasons.some(row=>row.code==='ACCEPTED_INPUT_CHANGES_CONTROL_CUSTODY_OR_ORDER'));
  assert.ok('interval' in heldInspection&&heldInspection.interval.acceptedWithoutTurnCount===1);
  assert.notEqual('snapshotDigest' in heldInspection?heldInspection.snapshotDigest:null,digest);
  assert.equal(db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(held.id).turn_id,null);
  console.log('Accepted binding owner snapshot: exact legacy rows, real result witnesses, read-only proof and never-admitted control refusal passed');
} finally {db.close();rmSync(scratch,{recursive:true,force:true});}
