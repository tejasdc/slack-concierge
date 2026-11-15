import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION} from '../src/test-authorizations';

const root=mkdtempSync(join(tmpdir(),'codex-custody-forward-'));
process.env.CONCIERGE_STATE_DIR=root;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(root,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION;
const {db}=await import('../src/state');
const {createNativeSession,retainSessionInput,enqueueSessionInput,attachSessionSteering,updateSessionMetadata}=await import('../src/session-inputs');
const {updateTurnSteeringReplayText,markTurnSteeringMessageSending}=await import('../src/state');
const {codexCustodyForwardGuard}=await import('../src/codex-custody-forward-guard');
const predecessor=createNativeSession('codex',{title:'Predecessor',summary:'Retain predecessor duties',purpose:'writing',origin:'native',cwd:'/tmp',model:'gpt-6-astra',reasoningEffort:'medium'});
const successor=createNativeSession('codex',{title:'Successor',summary:'Continue exact work',purpose:'writing',origin:'native',cwd:'/tmp',model:'gpt-6-astra',reasoningEffort:'medium',suspended:true});
const unrelated=createNativeSession('codex',{title:'Unrelated',summary:'Keep current work available',purpose:'writing',origin:'native',cwd:'/tmp',model:'gpt-6-astra',reasoningEffort:'medium'});
db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run('predecessor-thread',predecessor.id);
db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run('unrelated-thread',unrelated.id);
const canonical=retainSessionInput({id:'canonical-input',sessionId:predecessor.id,scope:'fixture',actionId:'canonical',kind:'input',origin:'human',payload:{text:'Exact retained request'}}).input;
const actor=retainSessionInput({id:'actor-input',sessionId:unrelated.id,scope:'fixture',actionId:'actor',kind:'input',origin:'agent',payload:{text:'Owner request'}}).input;
const placement=retainSessionInput({id:'placement-input',sessionId:successor.id,scope:'fixture',actionId:'placement',kind:'input',origin:'service',payload:{text:'Exact retained request'},requestId:'request-1'}).input;
db.query("INSERT INTO turns(session_id,slack_user_msg_ts,user_text,status,turn_kind,accepted_input_id,provider_model,reasoning_effort,dispatch_attempt,owner_instance_id) VALUES(?,?,?,'running','native',?,'gpt-6-astra','medium',1,'owner-1')")
  .run(successor.id,null,'Exact retained request',placement.id);
const placementTurn=Number((db.query('SELECT id FROM turns WHERE accepted_input_id=?').get(placement.id) as any).id);
const stopInput=retainSessionInput({id:'predecessor-stop',sessionId:predecessor.id,scope:'fixture',actionId:'stop',kind:'stop',origin:'human',payload:{runId:'predecessor-run'}}).input;
db.query(`INSERT INTO turns(session_id,slack_user_msg_ts,user_text,status,turn_kind,accepted_input_id,provider_model,reasoning_effort,
  native_run_id,provider_turn_id,stop_requested_at) VALUES(?,?,?,'running','native',?,'gpt-6-astra','medium','predecessor-run','predecessor-native-turn',CURRENT_TIMESTAMP)`)
  .run(predecessor.id,null,'Earlier execution',stopInput.id);
const handoffId='handoff-1';
db.query(`INSERT INTO session_handoffs(id,predecessor_session_id,successor_session_id,state,action_id,handoff_kind,canonical_input_id,
  caller_session_id,reason,requesting_input_id,requesting_run_id,inventory_json,inventory_digest)
  VALUES(?,?,?,'proposed','action-1','codex-custody-successor',?,?,?,?,'run-1','{}','digest')`)
  .run(handoffId,predecessor.id,successor.id,canonical.id,unrelated.id,'fixture',actor.id);
const scope=(method:string,params:any,ownerSessionId:number|null=null,senderId='native-client',generation=4)=>({senderId,generation,method,params,
  ownerSessionId,threadId:typeof params?.threadId==='string'?params.threadId:null,
  classification:params?.threadId?'known-thread':method==='thread/start'?'unkeyed-thread':'other'} as const);
const refused=(call:()=>unknown,pattern=/held|excluded|custody|protected|committed|attempt|retained|already attempted|unkeyed/i)=>assert.throws(call,pattern);

try{
  // A staged recovery cuts the predecessor off before any successor can run, but leaves native reads usable.
  assert.doesNotThrow(()=>codexCustodyForwardGuard(scope('thread/read',{threadId:'predecessor-thread'},predecessor.id)));
  assert.doesNotThrow(()=>codexCustodyForwardGuard(scope('turn/interrupt',{threadId:'predecessor-thread',turnId:'predecessor-native-turn'},predecessor.id)));
  refused(()=>codexCustodyForwardGuard(scope('turn/interrupt',{threadId:'predecessor-thread',turnId:'not-the-retained-turn'},predecessor.id)));
  refused(()=>codexCustodyForwardGuard(scope('turn/start',{threadId:'predecessor-thread'},predecessor.id)));
  refused(()=>codexCustodyForwardGuard(scope('thread/resume',{path:'/rollout.jsonl'},predecessor.id)));
  assert.doesNotThrow(()=>codexCustodyForwardGuard(scope('turn/start',{threadId:'unrelated-thread',input:[]},unrelated.id)));
  assert.doesNotThrow(()=>codexCustodyForwardGuard(scope('turn/start',{threadId:'unrelated-thread',input:[]},null)));

  const plan={operationId:handoffId,ownerSessionId:successor.id,model:'gpt-6-astra',provider:'openai',cwd:'/tmp',
    runtimeWorkspaceRoots:['/tmp'],environmentId:'local',config:{model_reasoning_effort:'medium'},approvalPolicy:'never',sandbox:'danger-full-access',
    custodyCommitted:true,predecessorExcluded:true,nativeConnection:{senderId:'native-client',generation:4}};
  db.query(`INSERT INTO codex_custody_successors(canonical_input_id,predecessor_session_id,successor_session_id,handoff_id,
    placement_input_id,placement_turn_id,request_id,source_input_id,source_run_id,state,plan_json,snapshot_json)
    VALUES(?,?,?,?,?,?,? ,? ,?,'staged',?,'{}')`).run(canonical.id,predecessor.id,successor.id,handoffId,placement.id,placementTurn,
      'request-1',actor.id,'run-1',JSON.stringify(plan));
  refused(()=>codexCustodyForwardGuard(scope('thread/start',{},successor.id)));
  db.query("UPDATE session_handoffs SET state='accepted',accepted_at=CURRENT_TIMESTAMP WHERE id=?").run(handoffId);
  db.query("UPDATE codex_custody_successors SET state='constructing',construction_intended_at=CURRENT_TIMESTAMP WHERE canonical_input_id=?").run(canonical.id);
  const construct={model:'gpt-6-astra',modelProvider:'openai',allowProviderModelFallback:false,cwd:'/tmp',runtimeWorkspaceRoots:['/tmp'],
    environments:[{environmentId:'local',cwd:'/tmp',runtimeWorkspaceRoots:['/tmp']}],config:{model_reasoning_effort:'medium'},approvalPolicy:'never',
    sandbox:'danger-full-access',ephemeral:false};
  assert.doesNotThrow(()=>codexCustodyForwardGuard(scope('thread/start',construct,successor.id)));
  refused(()=>codexCustodyForwardGuard(scope('thread/start',construct,successor.id)),/already attempted/);
  refused(()=>codexCustodyForwardGuard(scope('thread/start',construct,successor.id,'replacement-client',5)),/committed custody plan/);
  db.query("UPDATE codex_custody_successors SET state='admitting',native_thread_id='successor-thread',attempt_spent_at=CURRENT_TIMESTAMP,dispatch_attempt=1 WHERE canonical_input_id=?").run(canonical.id);
  db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run('successor-thread',successor.id);
  updateSessionMetadata(successor.id,{suspended:false});
  const admission={threadId:'successor-thread',input:[{type:'text',text:'Exact retained request',text_elements:[]}],clientUserMessageId:`slack-concierge:turn:${placementTurn}:attempt:1`,
    model:'gpt-6-astra',effort:'medium',cwd:'/tmp',runtimeWorkspaceRoots:['/tmp'],environments:[{environmentId:'local',cwd:'/tmp',runtimeWorkspaceRoots:['/tmp']}]};
  refused(()=>codexCustodyForwardGuard(scope('turn/start',{...admission,clientUserMessageId:'another-attempt'},successor.id)),/message identity/);
  assert.doesNotThrow(()=>codexCustodyForwardGuard(scope('turn/start',admission,successor.id)));
  refused(()=>codexCustodyForwardGuard(scope('turn/start',admission,successor.id)),/already attempted/);
  refused(()=>codexCustodyForwardGuard(scope('turn/start',admission,successor.id,'replacement-client',5)),/exact sender generation/);
  refused(()=>codexCustodyForwardGuard(scope('thread/fork',{threadId:'successor-thread'},successor.id)));
  refused(()=>codexCustodyForwardGuard(scope('thread/resume',{threadId:'successor-thread'},successor.id)));
  assert.doesNotThrow(()=>codexCustodyForwardGuard(scope('thread/read',{threadId:'successor-thread'},successor.id)));
  db.query("UPDATE codex_custody_successors SET state='admitted' WHERE canonical_input_id=?").run(canonical.id);
  const followup=retainSessionInput({id:'successor-followup',sessionId:successor.id,scope:'fixture',actionId:'followup',kind:'input',origin:'agent',payload:{text:'Distinct followup'}}).input;
  enqueueSessionInput(followup.id);
  const followupTurn=Number((db.query('SELECT id FROM turns WHERE accepted_input_id=?').get(followup.id) as any).id);
  db.query("UPDATE turns SET status='done',ended_at=CURRENT_TIMESTAMP WHERE id=?").run(placementTurn);
  db.query("UPDATE turns SET status='running',owner_instance_id='owner-1',dispatch_attempt=1,provider_turn_id='followup-native-turn' WHERE id=?").run(followupTurn);
  const later={...admission,input:[{type:'text',text:'Distinct followup',text_elements:[]}],clientUserMessageId:`slack-concierge:turn:${followupTurn}:attempt:1`};
  assert.doesNotThrow(()=>codexCustodyForwardGuard(scope('turn/start',later,successor.id)));
  const steeringInput=retainSessionInput({id:'successor-steering',sessionId:successor.id,scope:'fixture',actionId:'steering',kind:'input',origin:'agent',payload:{text:'Preserved in-flight steering'}}).input;
  const attached=attachSessionSteering(steeringInput.id,followupTurn);
  updateTurnSteeringReplayText(attached.steering_id!,'Owner-rendered exact steering words');
  markTurnSteeringMessageSending(attached.steering_id!);
  const steer={threadId:'successor-thread',expectedTurnId:'followup-native-turn',clientUserMessageId:steeringInput.id,
    input:[{type:'text',text:'Owner-rendered exact steering words',text_elements:[]}]};
  refused(()=>codexCustodyForwardGuard(scope('turn/steer',{...steer,threadId:'wrong-thread'},successor.id)));
  assert.doesNotThrow(()=>codexCustodyForwardGuard(scope('turn/steer',steer,successor.id)));
  refused(()=>codexCustodyForwardGuard(scope('turn/steer',steer,successor.id)),/already forwarded/);
  refused(()=>codexCustodyForwardGuard(scope('turn/steer',{...steer,expectedTurnId:'wrong-native-turn'},successor.id)));
  const stop={threadId:'successor-thread',turnId:'followup-native-turn'};
  updateSessionMetadata(successor.id,{suspended:true});
  refused(()=>codexCustodyForwardGuard(scope('turn/start',later,successor.id)),/suspended/);
  refused(()=>codexCustodyForwardGuard(scope('turn/steer',steer,successor.id)),/suspended/);
  refused(()=>codexCustodyForwardGuard(scope('turn/interrupt',stop,successor.id)),/owner-recorded Stop/);
  db.query('UPDATE turns SET stop_requested_at=CURRENT_TIMESTAMP WHERE id=?').run(followupTurn);
  refused(()=>codexCustodyForwardGuard(scope('turn/interrupt',stop,successor.id)),/retained Stop input/);
  const stopRun=(db.query('SELECT native_run_id FROM turns WHERE id=?').get(followupTurn) as any).native_run_id;
  retainSessionInput({id:'paused-successor-stop',sessionId:successor.id,scope:'fixture',actionId:'paused-stop',kind:'stop',origin:'human',payload:{runId:stopRun}});
  refused(()=>codexCustodyForwardGuard(scope('turn/interrupt',{...stop,turnId:'wrong-native-turn'},successor.id)),/exact retained turn/);
  refused(()=>codexCustodyForwardGuard(scope('turn/interrupt',stop,unrelated.id)),/owner-derived session identity/);
  assert.doesNotThrow(()=>codexCustodyForwardGuard(scope('turn/interrupt',stop,successor.id)),
    'an exact owner-recorded Stop must remain available while productive admission is paused');
  const metadata=JSON.parse((db.query('SELECT native_metadata_json FROM sessions WHERE id=?').get(successor.id) as any).native_metadata_json);
  assert.equal(metadata.suspended,true,'Stop forwarding must preserve Pause');
  refused(()=>codexCustodyForwardGuard(scope('turn/start',later,successor.id)),/suspended/);
  db.query("UPDATE turns SET status='done' WHERE id=?").run(followupTurn);
  refused(()=>codexCustodyForwardGuard(scope('turn/interrupt',stop,successor.id)),/exact retained turn/);
  console.log('Custody forward guard fixture passed: proposed predecessor cutoff, exact construction/admission, protected cold-resume/fork refusal, and exact paused Stop with productive writes and inexact controls held.');
}finally{
  rmSync(root,{recursive:true,force:true});
}
