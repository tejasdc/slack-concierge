import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import {IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'concierge-edit-gate-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION;
const [{db,claimNextQueuedTurn},{createNativeSession,retainSessionInput,enqueueSessionInput,sessionMetadata,nativeRunId},{implementationEditDecision,recordImplementationEditReason},{SessionOwner},{SessionCommunicationCoordinator},{isCodeEditTool}]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/implementation-edit-gate'),import('../src/session-owner'),import('../src/session-communication'),import('../src/implementation-models')]);
try{
  assert.equal(isCodeEditTool('Bash',{command:"router-actions.sh report -- 'The apply_patch tool was refused'"}),false);
  assert.equal(isCodeEditTool('Bash',{command:"zsh -lc 'echo apply_patch in a note'"}),false);
  assert.equal(isCodeEditTool('Bash',{command:"zsh -lc 'apply_patch --help'"}),true);
  assert.equal(isCodeEditTool('Bash',{command:"sed -i.bak 's/a/b/' file.ts"}),true);
  assert.equal(isCodeEditTool('Bash',{command:"sed --in-place 's/a/b/' file.ts"}),true);
  const parent=createNativeSession('codex',{title:'parent',summary:undefined,purpose:'develop',origin:'native',model:'gpt-6.1-sol'});
  db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run('parent-thread',parent.id);
  const source=retainSessionInput({id:'source',sessionId:parent.id,scope:'fixture',actionId:'source',kind:'input',origin:'agent',payload:{text:'design'}}).input;
  enqueueSessionInput(source.id);
  const turn=claimNextQueuedTurn('fixture')!.turn_id;
  db.query('UPDATE turns SET provider_turn_id=? WHERE id=?').run('parent-turn',turn);
  const edit=(toolId:string,extra:Record<string,unknown>={})=>implementationEditDecision({providerSessionId:'parent-thread',ownerTurnId:turn,providerTurnId:'parent-turn',toolId,toolName:'apply_patch',...extra});
  for(let i=0;i<4;i++)assert.equal(edit(`parent-${i}`).hold,false);
  assert.equal(edit('fifth').hold,true);
  for(let i=0;i<5;i++)assert.equal(edit(`helper-${i}`,{providerTurnId:'helper-turn',providerModel:'gpt-6-luna'}).hold,false);
  assert.equal(edit('fifth').hold,true,'helper work cannot release or consume parent edits');
  const helpers=db.query("SELECT payload_json FROM session_owner_events WHERE kind='implementation_helper_edit'").all() as {payload_json:string}[];
  assert.equal(helpers.length,5);
  assert.deepEqual(JSON.parse(helpers[0]!.payload_json).model,'gpt-6-luna');
  assert.deepEqual(JSON.parse(helpers[0]!.payload_json).providerTurnId,'helper-turn');
  assert.equal(edit('missing-model',{providerTurnId:'other-turn'}).hold,true,'no model counts against the parent, already at four');
  assert.equal(edit('unbound',{providerTurnId:'other-turn',providerModel:'gpt-6-luna',ownerTurnId:999999}).hold,true);

  // Shared-daemon hooks carry no owner turn ID: the reported model decides, the single running turn is the parent.
  const daemon=createNativeSession('codex',{title:'daemon parent',summary:undefined,purpose:'develop',origin:'native',model:'gpt-6.1-sol'});
  db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run('daemon-thread',daemon.id);
  const daemonSource=retainSessionInput({id:'daemon-source',sessionId:daemon.id,scope:'fixture',actionId:'daemon-source',kind:'input',origin:'agent',payload:{text:'design'}}).input;
  enqueueSessionInput(daemonSource.id);
  const daemonTurn=claimNextQueuedTurn('fixture')!.turn_id;
  const daemonEdit=(toolId:string,extra:Record<string,unknown>={},childTurn='unbound-helper-turn')=>implementationEditDecision({providerSessionId:'daemon-thread',providerTurnId:childTurn,toolId,toolName:'apply_patch',...extra});
  for(let i=0;i<7;i++)assert.equal(daemonEdit(`luna-${i}`,{providerModel:'gpt-6-luna'}).exempt,'codex-helper');
  assert.equal((db.query("SELECT COUNT(*) AS count FROM session_owner_events WHERE turn_id=? AND kind='implementation_helper_edit'").get(daemonTurn) as any).count,7);
  for(let i=0;i<4;i++)assert.equal(daemonEdit(`sol-${i}`,{providerModel:'gpt-6-sol'},'unbound-sol-turn').hold,false);
  assert.equal(daemonEdit('sol-fifth',{providerModel:'gpt-6-sol'},'unbound-sol-turn').hold,true,'a top-model edit with a different turn ID is counted and held');
  assert.equal(daemonEdit('luna-after',{providerModel:'gpt-6-luna'}).exempt,'codex-helper');
  assert.equal((db.query("SELECT COUNT(*) AS count FROM session_owner_events WHERE turn_id=? AND kind='implementation_edit'").get(daemonTurn) as any).count,4);
  db.query("UPDATE turns SET status='done' WHERE id=?").run(daemonTurn);
  assert.equal(daemonEdit('sol-fifth',{providerModel:'gpt-6-sol'},'unbound-sol-turn').hold,true,'completion cannot release a Sol hold without an existing original-turn reason');
  assert.equal(daemonEdit('none-running',{providerModel:'gpt-6-luna'},'never-bound-child').hold,true,'unbound child with no running turn holds');
  for(const id of ['daemon-two-a','daemon-two-b']){
    enqueueSessionInput(retainSessionInput({id,sessionId:daemon.id,scope:'fixture',actionId:id,kind:'input',origin:'agent',payload:{text:'x'}}).input.id);
  }
  db.query("UPDATE turns SET status='running' WHERE id IN (SELECT turn_id FROM session_inputs WHERE id IN ('daemon-two-a','daemon-two-b'))").run();
  assert.equal(daemonEdit('two-running',{providerModel:'gpt-6-luna'},'ambiguous-child').hold,true,'two running turns without an owner turn ID hold');
  db.query("UPDATE turns SET status='done' WHERE id IN (SELECT turn_id FROM session_inputs WHERE id IN ('daemon-two-a','daemon-two-b'))").run();

  // A helper's first mismatched edit binds its exact child turn to the unique running parent.
  const lifecycle=createNativeSession('codex',{title:'helper lifecycle',summary:undefined,purpose:'develop',origin:'native',model:'gpt-6.1-sol'});
  db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run('lifecycle-thread',lifecycle.id);
  const lifecycleInput=retainSessionInput({id:'lifecycle-input',sessionId:lifecycle.id,scope:'fixture',actionId:'lifecycle',kind:'input',origin:'agent',payload:{text:'design'}}).input;
  enqueueSessionInput(lifecycleInput.id);
  const lifecycleTurn=claimNextQueuedTurn('fixture')!.turn_id;
  db.query('UPDATE turns SET provider_turn_id=? WHERE id=?').run('lifecycle-parent-turn',lifecycleTurn);
  const codexEdit=(childTurn:string,toolId:string,model:string,ownerTurnId?:number)=>implementationEditDecision({providerSessionId:'lifecycle-thread',
    ownerTurnId,providerTurnId:childTurn,providerModel:model,toolId,toolName:'apply_patch'});
  db.query("UPDATE turns SET stop_requested_at=CURRENT_TIMESTAMP WHERE id=?").run(lifecycleTurn);
  assert.equal(codexEdit('stopped-before-bind','early-stop','gpt-6-luna').hold,true,'Stop before first edit cannot create a binding');
  db.query("UPDATE turns SET stop_requested_at=NULL WHERE id=?").run(lifecycleTurn);
  db.query("UPDATE sessions SET status='archived' WHERE id=?").run(lifecycle.id);
  assert.equal(codexEdit('archived-before-bind','early-archive','gpt-6-luna').hold,true,'archive before first edit cannot create a binding');
  db.query("UPDATE sessions SET status='idle',native_metadata_json=json_set(native_metadata_json,'$.suspended',1) WHERE id=?").run(lifecycle.id);
  assert.equal(codexEdit('paused-before-bind','early-pause','gpt-6-luna').hold,true,'pause before first edit cannot create a binding');
  db.query("UPDATE sessions SET native_metadata_json=json_remove(native_metadata_json,'$.suspended') WHERE id=?").run(lifecycle.id);
  assert.equal(codexEdit('native-luna-child','luna-first','gpt-6-luna').exempt,'codex-helper');
  for(let i=0;i<4;i++)assert.equal(codexEdit('native-sol-child',`sol-${i}`,'gpt-6.1-sol').hold,false);
  assert.equal(codexEdit('native-sol-child','sol-fifth','gpt-6.1-sol').hold,true,'Sol helper fifth edit uses parent turn budget');
  const bindingCount=(db.query("SELECT COUNT(*) AS count FROM session_owner_events WHERE session_id=? AND kind='implementation_codex_helper_binding'").get(lifecycle.id) as any).count;
  assert.equal(bindingCount,2,'both Luna and Sol child turns retain exact parent bindings');
  assert.equal((db.query("SELECT COUNT(*) AS count FROM session_owner_events WHERE session_id=? AND kind='implementation_helper_edit' AND input_id=?").get(lifecycle.id,lifecycleInput.id) as any).count,1,
    'lower-tier helper receipt preserves the parent accepted input');
  assert.equal((db.query('EXPLAIN QUERY PLAN SELECT turn_id FROM session_owner_events WHERE event_id=?').get('implementation-codex-helper-binding:fixture') as any).detail.includes('event_id'),true,
    'binding identity resolves by the existing unique event ID index');
  recordImplementationEditReason(lifecycleTurn,lifecycle.id,lifecycleInput.id,'This exact turn needs its thinking model to finish the fixed design.','fixture-reason');
  db.query("UPDATE turns SET status='done' WHERE id=?").run(lifecycleTurn);
  for(let i=0;i<4;i++)assert.equal(codexEdit('native-sol-child',`sol-${i}`,'gpt-6.1-sol').exempt,'already-counted','duplicate retries retain original receipt after completion');
  assert.equal(codexEdit('native-sol-child','sol-fifth','gpt-6.1-sol').hold,false,'reason recorded while the parent was running permits its retained child edit');
  assert.equal(codexEdit('native-sol-child','sol-fifth','gpt-6-luna').hold,true,'a changed child model cannot inherit the binding');
  assert.equal(codexEdit('unseen-child','no-parent','gpt-6-luna').hold,true,'unknown child without a running parent remains refused');
  assert.equal(codexEdit('unseen-child','missing-model','').hold,true,'missing model evidence remains refused');
  assert.equal(codexEdit('unseen-child','conflicting-hint','gpt-6-luna',999999).hold,true,'refused owner hint cannot create a binding');
  assert.equal((db.query("SELECT COUNT(*) AS count FROM session_owner_events WHERE session_id=? AND kind='implementation_codex_helper_binding'").get(lifecycle.id) as any).count,2,
    'refused unknown or conflicting identities do not acquire a binding');
  for(const status of ['error','cancelled','uncertain','queued']){
    db.query('UPDATE turns SET status=? WHERE id=?').run(status,lifecycleTurn);
    assert.equal(codexEdit('native-luna-child',`late-${status}`,'gpt-6-luna').hold,true,`${status} parent refuses retained child`);
    db.query("UPDATE turns SET status='done' WHERE id=?").run(lifecycleTurn);
  }
  db.query("UPDATE turns SET stop_requested_at=CURRENT_TIMESTAMP WHERE id=?").run(lifecycleTurn);
  assert.equal(codexEdit('native-luna-child','late-stop','gpt-6-luna').hold,true,'human Stop refuses even after normal completion');
  db.query("UPDATE turns SET stop_requested_at=NULL WHERE id=?").run(lifecycleTurn);
  db.query("UPDATE sessions SET status='archived' WHERE id=?").run(lifecycle.id);
  assert.equal(codexEdit('native-luna-child','late-archive','gpt-6-luna').hold,true,'archived parent session refuses retained child');
  db.query("UPDATE sessions SET status='idle',native_metadata_json=json_set(native_metadata_json,'$.suspended',1) WHERE id=?").run(lifecycle.id);
  assert.equal(codexEdit('native-luna-child','late-pause','gpt-6-luna').hold,true,'paused parent session refuses retained child');
  db.query("UPDATE sessions SET native_metadata_json=json_remove(native_metadata_json,'$.suspended') WHERE id=?").run(lifecycle.id);
  const newerInput=retainSessionInput({id:'lifecycle-new-input',sessionId:lifecycle.id,scope:'fixture',actionId:'new-turn',kind:'input',origin:'agent',payload:{text:'new'}}).input;
  enqueueSessionInput(newerInput.id);
  const newerTurn=claimNextQueuedTurn('fixture')!.turn_id;
  assert.equal(codexEdit('native-sol-child','old-child-stays-old','gpt-6.1-sol').hold,false,'new parent does not reassign known child');
  assert.equal((db.query("SELECT COUNT(*) AS count FROM session_owner_events WHERE turn_id=? AND kind='implementation_edit'").get(lifecycleTurn) as any).count,6);
  assert.equal((db.query("SELECT COUNT(*) AS count FROM session_owner_events WHERE turn_id=? AND kind='implementation_edit'").get(newerTurn) as any).count,0);

  const child=createNativeSession('codex',{title:'worker',summary:undefined,purpose:'develop',origin:'native',model:'gpt-6-luna'});
  const target=retainSessionInput({id:'request:fixture',sessionId:child.id,scope:'fixture',actionId:'target',kind:'input',origin:'agent',payload:{text:'implement'}}).input;
  enqueueSessionInput(target.id);
  const insert=db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,source_root_ts,action_id,target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms,source_input_id,target_input_id,status,outcome) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run('handoff','channel','message',turn,parent.id,'root','handoff',child.id,'target','root',JSON.stringify({implementation:false}),'hash',0,0,source.id,target.id,'admitted',null);
  assert.equal(edit('fifth').hold,true,'ordinary requests do not release the gate');
  db.query("UPDATE session_communication_requests SET payload_json=?,status='failed' WHERE request_id='handoff'").run(JSON.stringify({implementation:true}));
  assert.equal(edit('fifth').hold,true,'failed requests do not release the gate');
  db.query("UPDATE session_communication_requests SET status='admitted' WHERE request_id='handoff'").run();
  db.query("UPDATE turns SET status='cancelled' WHERE id=(SELECT turn_id FROM session_inputs WHERE id='request:fixture')").run();
  assert.equal(edit('fifth').hold,true,'canceled target execution does not release the gate');
  db.query("UPDATE turns SET status='queued' WHERE id=(SELECT turn_id FROM session_inputs WHERE id='request:fixture')").run();
  db.query("UPDATE session_communication_requests SET source_turn_id=? WHERE request_id='handoff'").run((db.query("SELECT turn_id FROM session_inputs WHERE id='request:fixture'").get() as any).turn_id);
  assert.equal(edit('fifth').hold,true,'a different originating turn does not release the gate');
  db.query("UPDATE session_communication_requests SET source_turn_id=? WHERE request_id='handoff'").run(turn);
  assert.equal(edit('fifth').hold,false,'accepted handoff releases the same held tool');
  assert.equal(edit('fifth').exempt,'already-counted');
  db.query("UPDATE session_communication_requests SET status='failed' WHERE request_id='handoff'").run();
  assert.equal(edit('sixth').hold,true,'a failed worker causes a new hold after the released edit');
  assert.equal(edit('sixth').hold,true,'the new hold is idempotent');
  db.query("UPDATE session_communication_requests SET status='admitted' WHERE request_id='handoff'").run();
  assert.equal(edit('sixth').hold,false,'a valid handoff releases the new held edit');
  db.query("UPDATE session_communication_requests SET status='canceled' WHERE request_id='handoff'").run();
  assert.equal(edit('seventh').hold,true,'cancellation after release also returns a hold');
  db.query("UPDATE turns SET status='cancelled' WHERE id=(SELECT turn_id FROM session_inputs WHERE id='request:fixture')").run();

  const claude=createNativeSession('claude-code',{title:'claude parent',summary:undefined,purpose:'develop',origin:'native',model:'claude-opus-5-5'});
  db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run('claude-parent',claude.id);
  const claudeSource=retainSessionInput({id:'claude-source',sessionId:claude.id,scope:'fixture',actionId:'claude-source',kind:'input',origin:'agent',payload:{text:'design'}}).input;
  enqueueSessionInput(claudeSource.id);
  const claudeTurn=claimNextQueuedTurn('fixture')!.turn_id;
  const claudeEdit=(toolId:string,providerAgentId?:string,ownerTurnId=claudeTurn)=>implementationEditDecision({providerSessionId:'claude-parent',ownerTurnId,providerAgentId,toolId,toolName:'Edit',toolInput:{file_path:'example.ts'}});
  for(let i=0;i<4;i++)assert.equal(claudeEdit(`parent-${i}`).hold,false);
  assert.equal(claudeEdit('parent-fifth').hold,true);
  for(let i=0;i<5;i++)assert.equal(claudeEdit(`child-${i}`,'helper-one').exempt,'claude-helper');
  assert.equal(claudeEdit('child-0','helper-one').exempt,'claude-helper');
  assert.equal(claudeEdit('other','helper-one',999999).hold,true);
  assert.equal(claudeEdit('parent-fifth').hold,true,'Claude helper edits do not consume or release the parent gate');
  assert.equal((db.query("SELECT COUNT(*) AS count FROM session_owner_events WHERE turn_id=? AND kind='implementation_helper_edit'").get(claudeTurn) as any).count,5);
  assert.equal((db.query("SELECT COUNT(*) AS count FROM session_owner_events WHERE turn_id=? AND kind='implementation_edit'").get(claudeTurn) as any).count,4);
  const owner=new SessionOwner({available:()=>true,wake:()=>{},stop:async()=>false,steer:()=>false,
    capabilities:()=>({models:['gpt-6-astra','gpt-6-sol']})} as any,scratch);
  const human=await owner.create({clientActionId:'human-astra',provider:'codex',purpose:'chat',model:'gpt-6-astra'});
  const humanId=Number(human.session.id.replace('concierge:',''));
  db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run('human-astra-thread',humanId);
  const communication=new SessionCommunicationCoordinator({owner,isOwnerAlive:()=>true,onError:()=>{}});
  const humanInput=retainSessionInput({id:'human-astra-continuation',sessionId:humanId,scope:'fixture',actionId:'human-continuation',kind:'input',origin:'human',payload:{text:'Continue this conversation.'}}).input;
  enqueueSessionInput(humanInput.id);
  const humanTurn=claimNextQueuedTurn('fixture')!.turn_id;
  db.query('UPDATE turns SET provider_turn_id=? WHERE id=?').run('human-turn',humanTurn);
  const humanPrompt={providerSessionId:'human-astra-thread',model:'gpt-6-astra',providerTurnId:'human-turn'};
  assert.equal(sessionMetadata((db.query('SELECT * FROM sessions WHERE id=?').get(humanId) as any)).explicitThinkingModelChoice,'gpt-6-astra');
  assert.equal((db.query("SELECT json_extract(payload_json,'$.reason') AS reason FROM session_owner_events WHERE session_id=? AND kind='model_escalation'").get(humanId) as any).reason,'explicit human model choice');
  assert.equal(communication.modelStartGate(humanPrompt).allowed,true);
  assert.equal(communication.modelStartGate({...humanPrompt,providerTurnId:'astra-helper-turn',providerAgentId:'helper-one'}).allowed,true);
  assert.equal((db.query("SELECT COUNT(*) AS count FROM session_owner_events WHERE kind='model_escalation' AND turn_id=?").get(humanTurn) as any).count,1);
  owner.action(human.session.id,{clientActionId:'human-sol',action:{kind:'model',value:'gpt-6-sol'}});
  assert.equal(sessionMetadata((db.query('SELECT * FROM sessions WHERE id=?').get(humanId) as any)).explicitThinkingModelChoice,'gpt-6-sol');
  assert.equal(communication.modelStartGate(humanPrompt).allowed,false);
  owner.action(human.session.id,{clientActionId:'human-astra-again',action:{kind:'model',value:'gpt-6-astra'}});
  assert.equal((db.query("SELECT COUNT(*) AS count FROM session_owner_events WHERE session_id=? AND kind='model_escalation'").get(humanId) as any).count,3);
  assert.equal(communication.modelStartGate(humanPrompt).allowed,true);
  db.query("UPDATE turns SET status='done' WHERE id=?").run(humanTurn);
  const agentInput=retainSessionInput({id:'agent-astra-continuation',sessionId:humanId,scope:'fixture',actionId:'agent-continuation',kind:'input',origin:'agent',payload:{text:'Continue this conversation.'}}).input;
  enqueueSessionInput(agentInput.id);
  const agentTurn=claimNextQueuedTurn('fixture')!.turn_id;
  db.query('UPDATE turns SET provider_turn_id=? WHERE id=?').run('agent-turn',agentTurn);
  const agentPrompt={providerSessionId:'human-astra-thread',model:'gpt-6-astra',providerTurnId:'agent-turn'};
  assert.equal(communication.modelStartGate(agentPrompt).allowed,false,'agent turn does not inherit the human continuation');
  db.query("UPDATE turns SET status='done' WHERE id=?").run(agentTurn);
  const serviceInput=retainSessionInput({id:'service-astra-continuation',sessionId:humanId,scope:'fixture',actionId:'service-continuation',
    kind:'input',origin:'service',requestId:'handoff',sourceInputId:humanInput.id,sourceRunId:nativeRunId(humanTurn),
    payload:{text:'Continue the same admitted work.'}}).input;
  db.query("UPDATE session_communication_requests SET target_session_id=?,target_input_id=?,payload_json=?,status='admitted',outcome=NULL WHERE request_id='handoff'")
    .run(humanId,serviceInput.id,JSON.stringify({requestedEffect:'work'}));
  enqueueSessionInput(serviceInput.id);
  const serviceTurn=claimNextQueuedTurn('fixture')!.turn_id;
  db.query('UPDATE turns SET provider_turn_id=? WHERE id=?').run('service-turn',serviceTurn);
  assert.equal(communication.modelStartGate({providerSessionId:'human-astra-thread',model:'gpt-6-astra',providerTurnId:'service-turn'}).allowed,true,
    'same-session service continuation inherits only the retained work request and verified session model choice');
  db.query("UPDATE turns SET status='done' WHERE id=?").run(serviceTurn);
  const qualified='Third failed fix of the same issue; ChatGPT Pro answer failed to hold.';
  const reasonInput=retainSessionInput({id:'agent-astra-with-reason',sessionId:humanId,scope:'fixture',actionId:'agent-with-reason',kind:'input',origin:'agent',payload:{text:'Continue this conversation.',escalationReason:qualified}}).input;
  enqueueSessionInput(reasonInput.id);
  const reasonTurn=claimNextQueuedTurn('fixture')!.turn_id;
  db.query('UPDATE turns SET provider_turn_id=? WHERE id=?').run('reason-turn',reasonTurn);
  assert.equal(communication.modelStartGate({providerSessionId:'human-astra-thread',model:'gpt-6-astra',providerTurnId:'reason-turn'}).allowed,true);
  assert.equal((db.query("SELECT json_extract(payload_json,'$.reason') AS reason FROM session_owner_events WHERE turn_id=? AND kind='model_escalation'").get(reasonTurn) as any).reason,qualified);
  const outside=createNativeSession('codex',{title:'outside',summary:undefined,purpose:'develop',origin:'native',model:'gpt-6.1-sol',outside:true});
  const outsideInput=retainSessionInput({id:'outside-input',sessionId:outside.id,scope:'fixture',actionId:'outside-input',kind:'input',origin:'agent',payload:{text:'Write a separate note'}}).input;
  enqueueSessionInput(outsideInput.id);
  const outsideTurn=claimNextQueuedTurn('fixture')!.turn_id;
  const outsidePrompt={providerSessionId:'outside-thread',model:'gpt-6.1-sol',providerTurnId:'outside-provider-turn',ownerTurnId:outsideTurn,sourceRunId:nativeRunId(outsideTurn)};
  assert.notEqual(communication.modelStartGate({...outsidePrompt,ownerTurnId:999999}).allowed,true);
  assert.equal(communication.modelStartGate(outsidePrompt).allowed,true);
  assert.equal(communication.modelStartGate({...outsidePrompt,model:'gpt-6-luna',providerTurnId:'outside-helper-turn',providerAgentId:'helper-one'}).allowed,true);
  assert.equal((db.query('SELECT agent_session_uuid FROM sessions WHERE id=?').get(outside.id) as any).agent_session_uuid,'outside-thread');
  assert.equal((db.query('SELECT provider_turn_id FROM turns WHERE id=?').get(outsideTurn) as any).provider_turn_id,'outside-provider-turn');
  for(let i=0;i<4;i++)assert.equal(implementationEditDecision({providerSessionId:'outside-thread',ownerTurnId:outsideTurn,providerTurnId:'outside-provider-turn',providerModel:'gpt-6.1-sol',toolId:`outside-${i}`,toolName:'apply_patch'}).hold,false);
  assert.equal(implementationEditDecision({providerSessionId:'outside-thread',ownerTurnId:outsideTurn,providerTurnId:'outside-provider-turn',providerModel:'gpt-6.1-sol',toolId:'outside-fifth',toolName:'apply_patch'}).hold,true);
  const gatePath=new URL('../src/implementation-edit-gate.ts',import.meta.url).pathname;
  const statePath=new URL('../src/state.ts',import.meta.url).pathname;
  const reopened=Bun.spawnSync(['bun','-e',`const [{implementationEditDecision},{db}]=await Promise.all([import(${JSON.stringify(gatePath)}),import(${JSON.stringify(statePath)})]);
    const result=implementationEditDecision({providerSessionId:'lifecycle-thread',providerTurnId:'native-luna-child',providerModel:'gpt-6-luna',toolId:'luna-first',toolName:'apply_patch'});
    const next=implementationEditDecision({providerSessionId:'lifecycle-thread',providerTurnId:'native-luna-child',providerModel:'gpt-6-luna',toolId:'luna-after-reopen',toolName:'apply_patch'});
    if(result.hold||result.exempt!=='codex-helper'||next.hold||next.exempt!=='codex-helper')process.exitCode=1;db.close();`],{env:{...process.env,CONCIERGE_STATE_DIR:scratch}});
  assert.equal(reopened.exitCode,0,'a fresh owner process preserves the duplicate receipt and admits a new edit from the same retained child');
  const observer=new Database(join(scratch,'state.db'),{readonly:true});
  try{
    assert.equal((observer.query("SELECT COUNT(*) AS count FROM session_owner_events WHERE turn_id=? AND input_id=? AND kind='implementation_helper_edit'").get(lifecycleTurn,lifecycleInput.id) as any).count,2,'a fresh reader sees reopened continuation retain its original parent and input');
  }finally{observer.close();}
  console.log('implementation edit gate: exact handoff, helper separation, retained Codex child identity and human model-picker custody passed');
}finally{db.close();rmSync(scratch,{recursive:true,force:true});}
