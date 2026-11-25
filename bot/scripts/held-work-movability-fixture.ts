// A Codex input the owner claimed, prepared and then refused by its own cached-usage check never
// reached Codex. It must be movable to another provider; one Codex actually started must not be.
// Replays the Diwali handoff refusal of 2026-11-11 (turn 26398, concierge:7992 → concierge:9328).
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HELD_WORK_MOVABILITY_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'concierge-held-work-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=HELD_WORK_MOVABILITY_TEST_AUTHORIZATION;
// Inventory's Lab read must fail fast and locally; its omission does not affect custody.
process.env.THINKERING_AGENT_TEST_KEY_FILE=join(scratch,'no-lab-key');

const [{db,claimNextQueuedTurn,markTurnProviderAdmissionIntended,retryRunningTurnAfterProviderFailure},
  {SessionOwner},{createNativeSession,retainSessionInput,enqueueSessionInput,getAcceptedSessionInput,queueTurnContinuation},
  {safeTurn,transferSession},{queuedWorkMovable,proposeHandoff,acceptHandoff,withdrawHandoff,reconcileWithdrawnHandoffQueues},{admitChatGptObligation}]=await Promise.all([
  import('../src/state'),import('../src/session-owner'),import('../src/session-inputs'),
  import('../src/provider-exhaustion-recovery'),import('../src/session-handoff'),import('../src/chatgpt-obligations')]);
new SessionOwner({available:()=>true,wake:()=>{},stop:async()=>false,steer:()=>false},scratch);

const OWNER='held-work-fixture';
function heldInput(id:string,started:boolean,provider:'codex'|'claude-code'='codex',acknowledged=false,dependency=false,
  usageRefusal=!started,continuation=false){
  const session=createNativeSession(provider,{title:`held ${id}`,summary:undefined,purpose:'develop',origin:'native',automaticProviderChoice:true});
  let prerequisiteTurn:number|null=null;
  if(dependency){
    const prerequisite=retainSessionInput({id:`${id}-prerequisite`,sessionId:session.id,scope:'fixture',actionId:`${id}-prerequisite`,
      kind:'input',origin:'agent',payload:{text:'Earlier unresolved work'}}).input;
    prerequisiteTurn=enqueueSessionInput(prerequisite.id).turn_id!;
    db.query("UPDATE turns SET status='done' WHERE id=?").run(prerequisiteTurn);
  }
  const input=retainSessionInput({id,sessionId:session.id,scope:'fixture',actionId:id,kind:'input',origin:'agent',
    payload:{text:'Avi WhatsApp delta',...(continuation?{continuation:true}:{})}}).input;
  // A capture's input carries this marker from admission; it is not a provider fact.
  db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({admissionIntent:'live'}),input.id);
  const queued=enqueueSessionInput(input.id);
  const claim=claimNextQueuedTurn(OWNER)!;
  assert.equal(claim.turn_id,queued.turn_id);
  assert.equal(markTurnProviderAdmissionIntended(claim.turn_id,OWNER,claim.dispatch_attempt),true);
  // What the execution host writes just before handing the prompt to Codex.
  const saved=JSON.parse(getAcceptedSessionInput(input.id)!.receipt_json!);
  db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({...saved,
    admission:{provider,inputId:input.id,runId:'run',bindingGeneration:1}}),input.id);
  if(acknowledged)db.query('UPDATE turns SET provider_input_acknowledged_at=CURRENT_TIMESTAMP WHERE id=?').run(claim.turn_id);
  if(started)db.query('UPDATE turns SET provider_started_at=CURRENT_TIMESTAMP WHERE id=?').run(claim.turn_id);
  // The cached-usage refusal: replay safe, held for the account's reset.
  assert.equal(retryRunningTurnAfterProviderFailure({turnId:claim.turn_id,ownerInstanceId:OWNER,dispatchAttempt:claim.dispatch_attempt,
    error:'Usage for fixture is cached as exhausted. No request was sent.',nextAttemptMs:Date.now()+86_400_000,usageHold:usageRefusal}),true);
  if(dependency)db.query('INSERT INTO turn_dependencies(turn_id,prerequisite_turn_id) VALUES(?,?)').run(claim.turn_id,prerequisiteTurn);
  const turn=db.query(`SELECT id,session_id,accepted_input_id,status,dispatch_attempt,dispatch_hold,provider_admission_intended_at,
    provider_started_at,provider_turn_id,provider_input_acknowledged_at,saved_kind FROM turns WHERE id=?`).get(claim.turn_id) as any;
  return {session,turn,input:getAcceptedSessionInput(input.id)!};
}

try{
  // Withdrawn Mac successors 248/249/250 retained queued retries, one a continuation.
  // Reproduce the historical rows and the ordinary withdrawal transition in private state.
  for(const historical of [true,false]){
    const predecessor=createNativeSession('codex',{title:'withdrawal source',purpose:'develop',origin:'native'});
    const successor=createNativeSession('codex',{title:'withdrawal successor',purpose:'develop',origin:'native'});
    const handoffId=`withdrawal-fixture-${historical}`;
    db.query(`INSERT INTO session_handoffs(id,predecessor_session_id,successor_session_id,state,action_id,caller_session_id,reason,
      requesting_input_id,requesting_run_id,inventory_json,inventory_digest)
      VALUES(?,?,?,?,?,?,?,?,?,'{}','fixture')`).run(handoffId,predecessor.id,successor.id,historical?'withdrawn':'proposed',
        handoffId,predecessor.id,'fixture','source','run');
    const retained=[];
    for(const [index,mode] of ['continuation','untouched','acknowledged','running'].entries()){
      const input=retainSessionInput({id:`${handoffId}:${index}`,sessionId:successor.id,scope:mode==='continuation'?'turn-continuation':`handoff:${handoffId}`,
        actionId:`${handoffId}:${index}`,kind:'input',origin:'service',payload:{text:'exact retained words',...(mode==='continuation'?{continuation:{sourceTurnId:1127}}:{})}}).input;
      const turnId=enqueueSessionInput(input.id).turn_id!;
      db.query(`UPDATE turns SET dispatch_hold='backoff',dispatch_next_attempt_ms=0 WHERE id=?`).run(turnId);
      if(mode==='acknowledged'){
        db.query(`UPDATE turns SET provider_input_acknowledged_at='2026-11-15 00:00:00',provider_turn_id='retained-provider-turn' WHERE id=?`).run(turnId);
        db.query(`UPDATE session_inputs SET receipt_json='{"admission":{"inputId":"original"}}' WHERE id=?`).run(input.id);
      }
      if(mode==='running')db.query("UPDATE turns SET status='running',owner_instance_id='existing-run' WHERE id=?").run(turnId);
      retained.push({input:getAcceptedSessionInput(input.id)!,turnId,mode});
    }
    if(historical)assert.equal(reconcileWithdrawnHandoffQueues(),3);
    else assert.equal(withdrawHandoff({actorSession:predecessor.id,handoffId}).withdrawn,true);
    for(const {input,turnId,mode} of retained){
      const turn=db.query('SELECT * FROM turns WHERE id=?').get(turnId) as any;
      const after=getAcceptedSessionInput(input.id)!;
      assert.equal(after.payload_json,input.payload_json,'accepted words and lineage stay exact');
      assert.equal(after.turn_id,turnId,'no replacement execution');
      if(mode==='running'){assert.equal(turn.status,'running');assert.equal(turn.owner_instance_id,'existing-run');continue;}
      assert.equal(turn.status,'cancelled');
      assert.match(turn.agent_text,/handoff was withdrawn/);
      assert.equal(turn.dispatch_hold,null);
      assert.equal(turn.dispatch_next_attempt_ms,null);
      const receipt=JSON.parse(after.receipt_json!);
      assert.equal(receipt.reason,'handoff_withdrawn');
      assert.equal(receipt.state,mode==='acknowledged'?'uncertain':'canceled');
      if(mode==='acknowledged'){
        assert.equal(turn.provider_turn_id,'retained-provider-turn');
        assert.equal(turn.provider_input_acknowledged_at,'2026-11-15 00:00:00');
        assert.deepEqual(receipt.admission,{inputId:'original'});
      }
      assert.equal(queueTurnContinuation(turnId,{kind:'interrupted',detail:'fixture'}),null,'withdrawal cannot spawn another continuation');
    }
    const before=db.query('SELECT count(*) AS n FROM session_owner_events').get() as any;
    assert.equal(reconcileWithdrawnHandoffQueues(),0,'existing-state repair is idempotent');
    assert.deepEqual(db.query('SELECT count(*) AS n FROM session_owner_events').get(),before);
    db.query("UPDATE turns SET status='done',ended_at=CURRENT_TIMESTAMP WHERE session_id=? AND status='running'").run(successor.id);
    assert.equal(queueTurnContinuation(retained.find(item=>item.mode==='running')!.turnId,
      {kind:'boundary',detail:'existing run finished'}),null,'a surviving run cannot create new work after withdrawal');
  }
  console.log('withdrawn handoffs: historical and new queues terminalize, uncertainty and exact evidence survive, running work stays, continuation and repeat repair do nothing');
  const held=heldInput('fixture-held',false);
  assert.equal(held.turn.dispatch_hold,'usage');
  assert.ok(held.turn.provider_admission_intended_at,'the refusal came after admission intent');
  assert.equal(safeTurn(held.turn,held.input),true,'a Codex input refused before sending moves');
  assert.deepEqual(queuedWorkMovable(held.session.id),{queued:1,movable:true});

  const started=heldInput('fixture-started',true);
  assert.equal(safeTurn(started.turn,started.input),false,'an input Codex may have started stays');
  assert.deepEqual(queuedWorkMovable(started.session.id),{queued:1,movable:false});

  // An admission recorded for a different provider than the session's own is not this session's.
  const foreign={...held.input,receipt_json:JSON.stringify({admission:{provider:'claude-code',inputId:held.input.id}})};
  assert.equal(safeTurn(held.turn,foreign),false);

  const acknowledged=heldInput('fixture-claude-acknowledged',true,'claude-code',true,false,true);
  assert.equal(acknowledged.turn.dispatch_hold,'usage');
  assert.ok(acknowledged.turn.provider_input_acknowledged_at,'the earlier provider acknowledgement remains recorded');
  assert.equal(safeTurn(acknowledged.turn,acknowledged.input),true,'the exact terminal zero-work usage hold supersedes historical acknowledgement and start evidence');
  assert.deepEqual(queuedWorkMovable(acknowledged.session.id),{queued:1,movable:true});

  const uncertain=heldInput('fixture-uncertain-ack',false,'claude-code',true);
  const uncertainTurn={...uncertain.turn,dispatch_hold:null};
  assert.equal(safeTurn(uncertainTurn,uncertain.input),false,'an acknowledgement without terminal usage refusal stays ambiguous');

  const dependent=heldInput('fixture-dependent',false,'claude-code',false,true);
  assert.equal(safeTurn(dependent.turn,dependent.input),false,'an unresolved dependency still blocks movement');

  const continued=heldInput('fixture-continued',false,'claude-code',false,false,true,true);
  assert.equal(continued.turn.dispatch_hold,'usage');
  assert.equal(safeTurn(continued.turn,continued.input),false,'an alternate usage-held continuation remains blocked');

  const proposed=heldInput('fixture-same-proposal',false,'claude-code',true);
  const handoffSuccessor=createNativeSession('codex',{title:'SAME proposed successor',summary:undefined,purpose:'develop',origin:'native'});
  db.query(`INSERT INTO session_handoffs(id,predecessor_session_id,successor_session_id,state,action_id,
    caller_session_id,reason,requesting_input_id,requesting_run_id,inventory_json,inventory_digest)
    VALUES(?,?,?,'proposed','fixture-action',?,'provider-change','fixture-request','fixture-run','{}','fixture-digest')`)
    .run('fixture-same-handoff',proposed.session.id,handoffSuccessor.id,proposed.session.id);
  assert.equal(transferSession(proposed.session.id),0,'automatic recovery leaves a source in the proposed SAME handoff');
  assert.equal(db.query('SELECT 1 FROM provider_recovery_sessions WHERE source_session_id=?').get(proposed.session.id),null);

  const unproposed=heldInput('fixture-no-proposal',false,'claude-code',true);
  const firstInput={text:'Summarize the retained dialogue.'};
  const preparedPrompt='Verified Gemini dialogue: synthetic historical evidence.\n\nCurrent request: '+firstInput.text;
  db.query("UPDATE session_inputs SET kind='create',payload_json=? WHERE id=?")
    .run(JSON.stringify({firstInput,preparedPrompt}),unproposed.input.id);
  assert.equal(transferSession(unproposed.session.id),1,'without a proposed SAME handoff, automatic transfer still works');
  assert.ok(db.query('SELECT 1 FROM provider_recovery_sessions WHERE source_session_id=?').get(unproposed.session.id));
  const recovered=JSON.parse(getAcceptedSessionInput(`recovery:${unproposed.input.id}`)!.payload_json);
  assert.equal(recovered.text,firstInput.text);
  assert.ok(recovered.preparedPrompt.endsWith(preparedPrompt),'automatic transfer keeps the complete prepared source context');

  // concierge:9767 → 9847, 2026-11-16: a predecessor holding an unanswered ChatGPT question has both its
  // answer duty and its sent request in the inventory. Moving the answer moved the request first, and the
  // sent step then refused "changed during handoff", so no such handoff could be accepted.
  // It also holds a standing role: the journal keeper's role stayed on concierge:4571 after its
  // 2026-11-15 handoff, so saved check-ins kept going to a session that never ran again.
  const asker=createNativeSession('codex',{title:'asker with open ChatGPT question',summary:undefined,purpose:'develop',origin:'native',standingRole:'journal-keeper',repairAgent:true});
  const chatgpt=createNativeSession('chatgpt',{title:'ChatGPT review',summary:undefined,purpose:'chat',origin:'native'});
  const askerInput=retainSessionInput({id:'fixture-asker-input',sessionId:asker.id,scope:'fixture',actionId:'asker',kind:'input',origin:'agent',
    payload:{text:'Ask ChatGPT and hand off'}}).input;
  const askerTurn=enqueueSessionInput(askerInput.id).turn_id!;
  db.query("UPDATE turns SET status='done' WHERE id=?").run(askerTurn);
  db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,
    source_root_ts,action_id,target_session_id,target_channel,target_root_ts,payload_json,payload_hash,source_input_id,target_input_id,due_at_ms,created_at_ms)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('fixture-chatgpt-question','fixture','fixture-1',askerTurn,asker.id,'fixture-root','ask-chatgpt',
      chatgpt.id,'fixture','fixture-root',JSON.stringify({text:'Review this',after:[],requestedEffect:'work'}),'fixture-hash',askerInput.id,null,Date.now()+60_000,Date.now());
  admitChatGptObligation({requestId:'fixture-chatgpt-question',task:{kind:'direct_input',id:askerInput.id},askerSessionId:asker.id,
    question:'Review this',targetSessionId:`concierge:${chatgpt.id}`,now:Date.now(),legacyCustodyVerified:true});
  const proposal=await proposeHandoff({actorSession:asker.id,inputId:askerInput.id,runId:'fixture-run',predecessorId:asker.id,
    provider:'cc-sonnet',reason:'Codex allowance exhausted',actionId:'fixture-handoff'});
  assert.deepEqual(proposal.inventory.items.map((item:any)=>item.id),['answer:fixture-chatgpt-question','sent:fixture-chatgpt-question']);
  const successorId=Number(proposal.successor.slice('concierge:'.length));
  const accepted=await acceptHandoff({actorSession:successorId,inputId:`handoff:${proposal.handoffId}`,runId:'fixture-successor-run',
    handoffId:proposal.handoffId,digest:proposal.digest});
  assert.equal(accepted.accepted,true,'a handoff holding a ChatGPT answer duty and its sent request is accepted');
  assert.equal((db.query('SELECT source_session_id FROM session_communication_requests WHERE request_id=?').get('fixture-chatgpt-question') as any).source_session_id,successorId);
  assert.equal((db.query('SELECT asker_session_id FROM session_chatgpt_obligations WHERE obligation_id=?').get('fixture-chatgpt-question') as any).asker_session_id,successorId);
  const role=(id:number)=>(db.query("SELECT json_extract(native_metadata_json,'$.standingRole') AS role FROM sessions WHERE id=?").get(id) as any).role;
  assert.equal(role(successorId),'journal-keeper','the standing role follows the accepted handoff');
  assert.equal(role(asker.id),null,'the superseded predecessor no longer holds the role');
  assert.equal((db.query("SELECT json_extract(native_metadata_json,'$.repairAgent') AS flag FROM sessions WHERE id=?").get(successorId) as any).flag,1,'the repair agent marker follows the role');
  // concierge:9772 → 9874, 2026-11-16: ChatGPT answered, its return waited in the Codex asker's queue,
  // and Codex's allowance was gone. Acceptance demanded that the asker acknowledge the return first,
  // which it never could. The never-started return now moves with the duty; the successor acknowledges it.
  const stuck=createNativeSession('codex',{title:'asker whose answer return is queued',summary:undefined,purpose:'develop',origin:'native'});
  const stuckInput=retainSessionInput({id:'fixture-stuck-input',sessionId:stuck.id,scope:'fixture',actionId:'stuck',kind:'input',origin:'agent',
    payload:{text:'Ask ChatGPT for a final review'}}).input;
  const stuckTurn=enqueueSessionInput(stuckInput.id).turn_id!;
  db.query("UPDATE turns SET status='done' WHERE id=?").run(stuckTurn);
  db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,
    source_root_ts,action_id,target_session_id,target_channel,target_root_ts,payload_json,payload_hash,source_input_id,target_input_id,due_at_ms,created_at_ms)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('fixture-answered-question','fixture','fixture-2',stuckTurn,stuck.id,'fixture-root','ask-review',
      chatgpt.id,'fixture','fixture-root',JSON.stringify({text:'Final review',after:[],requestedEffect:'informational'}),'fixture-hash-2',stuckInput.id,null,Date.now()+60_000,Date.now());
  admitChatGptObligation({requestId:'fixture-answered-question',task:{kind:'direct_input',id:stuckInput.id},askerSessionId:stuck.id,
    question:'Final review',targetSessionId:`concierge:${chatgpt.id}`,now:Date.now(),legacyCustodyVerified:true});
  const returnInput=retainSessionInput({id:'return:fixture-answer-event',sessionId:stuck.id,scope:'fixture',actionId:'return',kind:'input',origin:'service',
    payload:{text:'ChatGPT answered your final review'}}).input;
  assert.ok(enqueueSessionInput(returnInput.id).turn_id,'the return waits in a queued turn');
  const reconstructed=retainSessionInput({id:'fixture-queued-reconstruction',sessionId:stuck.id,scope:'fixture',
    actionId:'reconstruct',kind:'create',origin:'human',payload:{firstInput,preparedPrompt}}).input;
  assert.ok(enqueueSessionInput(reconstructed.id).turn_id);
  db.query("UPDATE session_communication_requests SET outcome='answered',status='answered' WHERE request_id=?").run('fixture-answered-question');
  db.query(`INSERT INTO session_communication_events(event_id,request_id,kind,payload_json,status,created_at_ms,accepted_input_id)
    VALUES(?,?,'final',?,'admitted',?,?)`).run('fixture-answer-event','fixture-answered-question',JSON.stringify({text:'Ship it'}),Date.now(),returnInput.id);
  db.query("UPDATE session_chatgpt_obligations SET state='return_pending',answer_event_id=? WHERE obligation_id=?")
    .run('fixture-answer-event','fixture-answered-question');
  const stuckProposal=await proposeHandoff({actorSession:stuck.id,inputId:stuckInput.id,runId:'fixture-run-2',predecessorId:stuck.id,
    provider:'cc-opus',reason:'Codex allowance exhausted',actionId:'fixture-handoff-2'});
  const stuckSuccessor=Number(stuckProposal.successor.slice('concierge:'.length));
  const stuckAccepted=await acceptHandoff({actorSession:stuckSuccessor,inputId:`handoff:${stuckProposal.handoffId}`,runId:'fixture-successor-run-2',
    handoffId:stuckProposal.handoffId,digest:stuckProposal.digest});
  assert.equal(stuckAccepted.accepted,true,`a queued, never-started answer return moves with its duty: ${(stuckAccepted as any).reason??''}`);
  const movedReconstruction=getAcceptedSessionInput(`handoff-input:${stuckProposal.handoffId}:${reconstructed.id}`)!;
  assert.equal(movedReconstruction.session_id,stuckSuccessor);
  const movedPayload=JSON.parse(movedReconstruction.payload_json);
  assert.equal(movedPayload.text,firstInput.text);
  assert.equal(movedPayload.preparedPrompt,preparedPrompt);
  const obligation=db.query('SELECT asker_session_id,state,answer_return_input_id FROM session_chatgpt_obligations WHERE obligation_id=?')
    .get('fixture-answered-question') as any;
  assert.equal(obligation.asker_session_id,stuckSuccessor);
  assert.equal(obligation.state,'return_pending','the receipt still waits for the successor to acknowledge the return');
  const carried=(db.query('SELECT accepted_input_id FROM session_communication_events WHERE event_id=?').get('fixture-answer-event') as any).accepted_input_id;
  assert.equal(getAcceptedSessionInput(carried)!.session_id,stuckSuccessor,'the answer event now follows the successor’s copy of the return');
  assert.equal((db.query('SELECT status FROM turns t JOIN session_inputs i ON i.turn_id=t.id WHERE i.id=?').get(carried) as any).status,'queued');
  console.log('held-work-movability-fixture: terminal usage refusals move with acknowledgement and start history intact; unclassified starts, uncertain acknowledgements, foreign receipts, dependencies, continuations, and competing proposals stay blocked; unproposed automatic transfer still works; a handoff holding an open ChatGPT question moves both its sent request and answer duty; a standing role moves to the successor; a queued, never-started ChatGPT answer return moves with its duty.');
}finally{
  rmSync(scratch,{recursive:true,force:true});
}
