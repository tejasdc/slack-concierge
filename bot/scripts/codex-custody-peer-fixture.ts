import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,truncateSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'codex-custody-peer-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION;
// The real handoff transaction inventories Lab and worktrees; give it disposable stand-ins.
const workspace=join(scratch,'workspace');mkdirSync(workspace);spawnSync('git',['init',workspace],{stdio:'ignore'});
spawnSync('git',['-C',workspace,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','fixture'],{stdio:'ignore'});
const codexHome=join(scratch,'codex'),rolloutDir=join(codexHome,'sessions','2026','11','14');mkdirSync(rolloutDir,{recursive:true});process.env.CODEX_HOME=codexHome;
const keyFile=join(scratch,'lab.key');writeFileSync(keyFile,'fixture-key');
const lab=Bun.serve({port:0,fetch:()=>Response.json({threads:[]})});
process.env.THINKERING_AGENT_TEST_KEY_FILE=keyFile;process.env.THINKERING_ORIGIN_URL=`http://127.0.0.1:${lab.port}`;
const {db}=await import('../src/state');
const {createNativeSession,retainSessionInput,enqueueSessionInput,nativeRunId,updateSessionMetadata}=await import('../src/session-inputs');
const {SessionPeers}=await import('../src/session-peers');
const {stageRecoveryHandoff,commitRecoveryHandoff}=await import('../src/session-handoff');
const session=()=>createNativeSession('codex',{cwd:scratch,purpose:'chat',title:'Peer preservation fixture',summary:undefined});
const accepted=(sessionId:number,text:string)=>enqueueSessionInput(retainSessionInput({sessionId,scope:'fixture',actionId:randomUUID(),kind:'input',origin:'agent',payload:{text}}).input.id);
const source=session(),sourceInput=accepted(source.id,'ask');
db.query("UPDATE turns SET status='done' WHERE id=?").run(sourceInput.turn_id);
let origin:any,recipient:any;
const owner={executionState:()=> 'idle',view:()=>({execution:'idle'}),canSend:()=>false,attachments:(ids:string[])=>ids.map(()=>({name:'note.txt',contentType:'text/plain',base64:Buffer.from('retained file bytes').toString('base64'),id:'x'})),
  upload:(file:{clientActionId:string})=>({attachment:{id:`att:${file.clientActionId}`}}),admit:()=>{},dispatch:()=>{throw new Error('unexpected dispatch');}};
const failFullFetch=new Set<string>();
const targetClient={request:async(method:string,path:string)=>{
  const id=decodeURIComponent(path.split('/')[5]!);
  if(method==='POST'&&path.endsWith('/cancel'))return recipient.canceledByOrigin(id);
  assert.equal(method,'GET');
  if(path.includes('/replies/')){
    if(failFullFetch.has(id)){failFullFetch.delete(id);throw new Error('fixture: full reply fetch failed once');}
    return recipient.fullReply(id,decodeURIComponent(path.split('/')[7]!));
  }
  return recipient.status(id);
}};
const originClient={request:async(method:string,path:string,body:any)=>{
  assert.equal(method,'POST');
  const id=decodeURIComponent(path.split('/')[5]!);
  if(path.endsWith('/replies'))return origin.receiveReply(id,body);
  if(path.endsWith('/notify'))return origin.notified(id);
  throw new Error(`unexpected origin request ${path}`);
}};
origin=new SessionPeers({self:'origin',clients:new Map([['target',targetClient]]),owner,onError:(error:unknown)=>{throw error;},isOwnerAlive:()=>true} as any);
recipient=new SessionPeers({self:'target',clients:new Map([['origin',originClient]]),owner,onError:(error:unknown)=>{throw error;},isOwnerAlive:()=>true} as any);
// Exercise reconciliation methods directly, without starting unrelated catalogue/timer tasks.
for(const peer of [origin,recipient]){peer.stopped=false;peer.wake=()=>{};peer.refreshCatalogue=async()=>{};}
const originRow=(id:string)=>db.query('SELECT * FROM session_peer_requests WHERE request_id=?').get(id) as any;
const deliveryRow=(id:string)=>db.query('SELECT * FROM session_peer_deliveries WHERE request_id=?').get(id) as any;
function request(target:any,placement:any,remoteId:number,effect:'work'|'informational'='work',remoteOperation?:string){
  const id=randomUUID();
  db.query(`INSERT INTO session_peer_deliveries(request_id,peer,origin_session_id,origin_input_id,origin_run_id,target_session_id,target_input_id,requested_effect,origin_provenance_json,created_at_ms)
    VALUES(?,'origin',?,?,?,?,?,?,'{"answerGuaranteeVersion":1}',?)`).run(id,`concierge:${source.id}`,sourceInput.id,nativeRunId(sourceInput.turn_id!),target.id,placement.id,effect,Date.now());
  db.query(`INSERT INTO session_peer_requests(request_id,peer,source_session_id,source_turn_id,source_input_id,action_id,payload_json,payload_hash,remote_session_id,remote_address,remote_operation_id,status,due_at_ms,created_at_ms)
    VALUES(?,'target',?,?,?,?,?,'fixture',?,?,?,'admitted',?,?)`).run(id,source.id,sourceInput.turn_id,sourceInput.id,id,JSON.stringify({answerGuaranteeVersion:1,requestedEffect:effect}),`concierge:${remoteId}`,'session:fixture',remoteOperation??`request:${id}`,Date.now()+60_000,Date.now());
  return id;
}
async function retainedPredecessorFinalSurvivesHandoff(){
  // The predecessor's real recovery setup: a retained native thread, a selected reminder and an
  // actor input, exactly as the handoff fixture builds them, so the real transaction commits.
  const predecessor=createNativeSession('codex',{title:'Astra owner',summary:undefined,purpose:'develop',origin:'native',cwd:workspace,model:'gpt-6-astra',reasoningEffort:'medium'});
  db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run('peer-native-thread',predecessor.id);
  const rollout=join(rolloutDir,'rollout-fixture-peer-native-thread.jsonl');writeFileSync(rollout,workspace);truncateSync(rollout,64*1024*1024+1);
  const preservedSource=join(scratch,'peer-native-thread-source.jsonl');writeFileSync(preservedSource,'native conversation source');
  const actor=retainSessionInput({id:'peer-handoff-actor',sessionId:predecessor.id,scope:'fixture',actionId:'actor',kind:'input',origin:'agent',payload:{text:'recover'}}).input;enqueueSessionInput(actor.id);
  const actorTurn=Number((db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(actor.id) as any).turn_id);
  db.query("UPDATE turns SET status='done' WHERE id=?").run(actorTurn);
  const reminder=retainSessionInput({id:'report-back:peer-handoff-request',sessionId:predecessor.id,scope:'fixture',actionId:'reminder',kind:'request',origin:'service',payload:{text:'exact reminder'},requestId:'peer-handoff-request'}).input;enqueueSessionInput(reminder.id);
  const reminderTurn=Number((db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(reminder.id) as any).turn_id);
  db.query("UPDATE turns SET status='done',dispatch_attempt=1,native_run_id=?,provider_admission_intended_at=CURRENT_TIMESTAMP,provider_started_at=CURRENT_TIMESTAMP,provider_turn_id='native-empty',provider_input_acknowledged_at=NULL WHERE id=?").run(nativeRunId(reminderTurn),reminderTurn);
  db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,source_root_ts,action_id,target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms,source_input_id,target_input_id,status,outcome)
    VALUES('peer-handoff-request','fixture','message',?,?,?,?,?,'fixture','root','{"requestedEffect":"work"}','hash',0,0,?,?,'admitted',NULL)`).run(actorTurn,predecessor.id,'root','request-action',predecessor.id,actor.id,reminder.id);
  // Incoming peer duties held by the predecessor. Each has its own accepted input that has already run.
  const duties=['pulled','pushed','outsider','former-new'].map(name=>{
    const input=accepted(predecessor.id,`peer duty ${name}`);
    db.query("UPDATE turns SET status='done',provider_input_acknowledged_at=CURRENT_TIMESTAMP WHERE id=?").run(input.turn_id);
    return {name,input,id:request(predecessor,input,predecessor.id,'work',input.id)};
  });
  const duty=(name:string)=>duties.find(item=>item.name===name)!;
  const asPredecessor=(item:{input:any}) => ({session:predecessor.id,turn:item.input.turn_id,inputId:item.input.id});
  const retainFinal=(name:string)=>{
    const item=duty(name);
    recipient.reply(asPredecessor(item),{request_id:item.id,action_id:`predecessor-final:${name}`,text:`Predecessor answer for ${name}`,final:true,
      workDisposition:'completed',attachments:['predecessor-attachment']});
    const retained=db.query("SELECT * FROM session_peer_replies WHERE request_id=? AND kind='final'").get(item.id) as any;
    assert.equal(retained.status,'pending','the origin has not confirmed the predecessor final');
    return {eventId:retained.event_id as string,payload:JSON.parse(retained.payload_json)};
  };
  const before={pulled:retainFinal('pulled'),pushed:retainFinal('pushed')};
  const staged=await stageRecoveryHandoff({actorSession:predecessor.id,inputId:actor.id,runId:nativeRunId(actorTurn),predecessorId:predecessor.id,actionId:'peer-recovery',reason:'fixture',selectedInputId:reminder.id,preservedSourcePath:preservedSource});
  const successorId=Number(staged.successor.split(':')[1]);
  assert.ok(staged.inventory.items.filter((item:any)=>item.kind==='owed'&&item.source==='peer').length>=4,'the handoff inventories every peer duty, including those with a retained final');
  const placement=retainSessionInput({id:'peer-placement',sessionId:successorId,scope:`custody:${reminder.id}`,actionId:'placement',kind:'input',origin:'service',payload:{text:'exact reminder'}}).input;
  const placementTurn=Number((db.query(`INSERT INTO turns(session_id,user_text,status,turn_kind,accepted_input_id,provider_model,reasoning_effort) VALUES(?,'exact reminder','queued','native',?,'gpt-6-astra','medium') RETURNING id`).get(successorId,placement.id) as any).id);
  db.query('UPDATE session_inputs SET turn_id=? WHERE id=?').run(placementTurn,placement.id);
  db.query(`INSERT INTO codex_custody_successors(canonical_input_id,predecessor_session_id,successor_session_id,handoff_id,placement_input_id,placement_turn_id,request_id,source_input_id,source_run_id,state,plan_json,snapshot_json)
    VALUES(?,?,?,?,?,?,?,?,?,'staged','{}',?)`).run(reminder.id,predecessor.id,successorId,staged.handoffId,placement.id,placementTurn,'peer-handoff-request',actor.id,nativeRunId(actorTurn),JSON.stringify({path:preservedSource}));
  const committed=await commitRecoveryHandoff({actorSession:predecessor.id,inputId:actor.id,runId:nativeRunId(actorTurn),handoffId:staged.handoffId,digest:staged.digest,
    placementInputId:placement.id,placementTurnId:placementTurn,validateAuthority:()=>{}});
  assert.equal(committed.accepted,true,'the actual handoff transaction committed');
  for(const item of duties)assert.equal(deliveryRow(item.id).target_session_id,successorId,'custody of every peer duty moved to the successor');
  db.query("UPDATE turns SET status='error',provider_input_acknowledged_at=CURRENT_TIMESTAMP,agent_text='selected attempt ended' WHERE id=?").run(placementTurn);
  const successor={id:successorId};
  const countsBefore={requests:(db.query('SELECT COUNT(*) n FROM session_peer_requests').get() as any).n,
    local:(db.query('SELECT COUNT(*) n FROM session_communication_requests').get() as any).n};
  const authored=(name:string)=>({responder:`concierge:${predecessor.id}`,proof:{version:1,requestId:duty(name).id,recipientPeer:'target',targetSessionId:`concierge:${predecessor.id}`,unresolvedObligations:0}});

  // The status the recipient now reports names the successor as holder and the predecessor as author.
  const status=recipient.status(duty('pulled').id);
  assert.equal(status.sessionId,`concierge:${successorId}`);
  const reported=status.replies.find((reply:any)=>reply.eventId===before.pulled.eventId);
  assert.equal(reported.responderSessionId,`concierge:${predecessor.id}`,'status carries the original author, not the current holder');
  assert.deepEqual(reported.settlementProof,before.pulled.payload.settlementProof,'the retained proof is unchanged');
  assert.equal(recipient.fullReply(duty('pulled').id,before.pulled.eventId).responder.sessionId,`concierge:${predecessor.id}`,'the pulled body carries the original author');

  // Pull first: the origin reconciles custody, then pulls the retained final; a later push is a duplicate.
  await origin.dispatch(originRow(duty('pulled').id));
  assert.equal(origin.inspect(duty('pulled').id).target_session_id,`target:${successorId}`,'the origin resolves the successor as current holder');
  assert.equal(originRow(duty('pulled').id).outcome,'answered','the retained predecessor final settles after the handoff (pull)');
  await recipient.report(deliveryRow(duty('pulled').id));
  // Push after reconciliation, when the first full fetch failed: the same event arrives by push.
  failFullFetch.add(duty('pushed').id);
  await origin.dispatch(originRow(duty('pushed').id));
  assert.equal(originRow(duty('pushed').id).outcome,null,'a failed full fetch leaves the event with its sender');
  await recipient.report(deliveryRow(duty('pushed').id));
  assert.equal(originRow(duty('pushed').id).outcome,'answered','the retained predecessor final settles after the handoff (push)');
  await recipient.report(deliveryRow(duty('pushed').id));
  await origin.dispatch(originRow(duty('pushed').id));
  for(const name of ['pulled','pushed'] as const){
    const item=duty(name);
    const finals=db.query("SELECT * FROM session_peer_events WHERE request_id=? AND kind='final'").all(item.id) as any[];
    assert.equal(finals.length,1,`${name}: settles exactly once`);
    const declared=JSON.parse(finals[0].payload_json);
    assert.equal(finals[0].event_id,before[name].eventId,`${name}: the same retained event`);
    assert.equal(declared.text,`Predecessor answer for ${name}`);
    assert.equal(declared.responding_session_id,`target:${predecessor.id}`,`${name}: original author is preserved`);
    assert.deepEqual(declared.settlementProof,before[name].payload.settlementProof,`${name}: proof is unrewritten`);
    assert.equal(declared.attachments?.length,1,`${name}: files are preserved`);
    assert.equal(db.query("SELECT COUNT(*) n FROM session_peer_replies WHERE request_id=? AND kind='final'").get(item.id).n,1,`${name}: no replacement final on the recipient`);
    assert.notEqual(deliveryRow(item.id).closed_at_ms,null,`${name}: the recipient delivery closes after origin confirmation`);
  }
  assert.equal((db.query('SELECT COUNT(*) n FROM session_peer_requests').get() as any).n,countsBefore.requests,'no replacement child request');
  assert.equal((db.query('SELECT COUNT(*) n FROM session_communication_requests').get() as any).n,countsBefore.local);

  // Negative controls. A session that never held the request, and an event the current holder's
  // status does not list, both stay unrecorded.
  const outsider=session(),outsiderItem=duty('outsider');
  const forged=origin.receiveReply(outsiderItem.id,{eventId:randomUUID(),kind:'final',text:'never held',workDisposition:'completed',
    responder:{peer:'target',sessionId:`concierge:${outsider.id}`,inputId:'x',runId:'y'},
    settlementProof:{...authored('outsider').proof,targetSessionId:`concierge:${outsider.id}`}});
  assert.equal(forged.recorded,'pending','a final authored by a session that never held the request is not accepted');
  await origin.dispatch(originRow(outsiderItem.id));
  const unattested=origin.receiveReply(outsiderItem.id,{eventId:randomUUID(),kind:'final',text:'former holder, unretained',workDisposition:'completed',
    responder:{peer:'target',sessionId:authored('outsider').responder,inputId:'x',runId:'y'},settlementProof:authored('outsider').proof});
  assert.equal(unattested.recorded,'pending','a former holder cannot assert a new final the current holder never retained');
  await Promise.all([...origin.tasks.values()]);
  assert.equal(originRow(outsiderItem.id).outcome,null);
  assert.equal(db.query('SELECT COUNT(*) n FROM session_peer_events WHERE request_id=?').get(outsiderItem.id).n,0);
  // Current custody alone governs new replies.
  const former=duty('former-new');
  assert.throws(()=>recipient.reply(asPredecessor(former),{request_id:former.id,action_id:'late-former-final',text:'late',final:true,workDisposition:'completed'}),/exact recipient/,
    'the predecessor can no longer create a new reply');
  // The committed successor stays passive until acknowledged, so its answering turn is placed directly.
  const later=retainSessionInput({sessionId:successorId,scope:'fixture',actionId:randomUUID(),kind:'input',origin:'agent',payload:{text:'successor answers'}}).input;
  const laterTurn=Number((db.query(`INSERT INTO turns(session_id,user_text,status,turn_kind,accepted_input_id,provider_input_acknowledged_at) VALUES(?,'successor answers','done','native',?,CURRENT_TIMESTAMP) RETURNING id`).get(successorId,later.id) as any).id);
  db.query('UPDATE session_inputs SET turn_id=? WHERE id=?').run(laterTurn,later.id);
  recipient.reply({session:successor.id,turn:laterTurn,inputId:later.id},{request_id:former.id,action_id:'successor-final',text:'Successor answer',final:true,workDisposition:'completed'});
  await origin.dispatch(originRow(former.id));
  assert.equal(originRow(former.id).outcome,'answered','positive control: a new successor final still settles');
  const successorFinal=JSON.parse((db.query("SELECT payload_json FROM session_peer_events WHERE request_id=? AND kind='final'").get(former.id) as any).payload_json);
  assert.equal(successorFinal.responding_session_id,`target:${successorId}`);
}
try{
  for(const terminal of ['error','cancelled','done'] as const)for(const effect of ['work','informational'] as const){
    const predecessor=session(),successor=session(),canonical=accepted(predecessor.id,'canonical reminder'),placement=accepted(successor.id,'selected placement');
    if(terminal==='done')updateSessionMetadata(successor.id,{interactionPolicy:'consultation-only'});
    const handoff=randomUUID();
    db.query(`INSERT INTO session_handoffs(id,predecessor_session_id,successor_session_id,state,action_id,handoff_kind,canonical_input_id,caller_session_id,reason,requesting_input_id,requesting_run_id,inventory_json,inventory_digest)
      VALUES(?,?,?,'accepted',?,'codex-custody-successor',?,?,'fixture',?,?,'{}','fixture')`).run(handoff,predecessor.id,successor.id,handoff,canonical.id,source.id,sourceInput.id,nativeRunId(sourceInput.turn_id!));
    db.query(`INSERT INTO codex_custody_successors(canonical_input_id,predecessor_session_id,successor_session_id,handoff_id,placement_input_id,placement_turn_id,request_id,source_input_id,source_run_id,state,plan_json,snapshot_json)
      VALUES(?,?,?,?,?,?,?,?,?,'acknowledged','{}','{}')`).run(canonical.id,predecessor.id,successor.id,handoff,placement.id,placement.turn_id,randomUUID(),sourceInput.id,nativeRunId(sourceInput.turn_id!));
    db.query("UPDATE turns SET status=?,provider_input_acknowledged_at=CURRENT_TIMESTAMP,agent_text='selected attempt ended' WHERE id=?").run(terminal,placement.turn_id);
    if(terminal==='cancelled')retainSessionInput({sessionId:successor.id,scope:'surface:thinkering',actionId:`stop-selected:${successor.id}`,kind:'stop',origin:'human',
      payload:{runId:nativeRunId(placement.turn_id!)}});
    const ids=[request(successor,placement,predecessor.id,effect),request(successor,placement,predecessor.id,effect),request(successor,placement,predecessor.id,effect)];
    for(const id of ids)db.query("INSERT INTO session_handoff_items(handoff_id,kind,ref,from_session_id,to_session_id) VALUES(?,'owed',?,?,?)")
      .run(handoff,id,predecessor.id,successor.id);
    db.query('UPDATE session_handoffs SET inventory_json=? WHERE id=?').run(JSON.stringify({items:ids.map(id=>({kind:'owed',source:'peer',ref:id,targetInputId:`request:${id}`}))}),handoff);
    const status=recipient.status(ids[0]);
    assert.equal(status.execution.status,terminal,'terminal execution facts remain truthful');
    assert.equal(status.execution.settled,true);
    if(terminal==='cancelled')assert.equal(typeof status.execution.stoppedByTejasAtMs,'number','the canceled branch includes an actual retained human Stop');
    await origin.dispatch(originRow(ids[0]));
    assert.equal(originRow(ids[0]).outcome,null,'selected placement terminal must not settle independent peer work');
    assert.equal(status.custodyPlacement?.placementTurnId,placement.turn_id,'the recipient derives the exact placement marker from accepted custody');
    await recipient.report(deliveryRow(ids[0]));
    assert.equal(deliveryRow(ids[0]).closed_at_ms,null,'origin notification keeps the recipient duty open');
    assert.equal(db.query("SELECT COUNT(*) n FROM session_peer_events WHERE request_id=? AND kind='final'").get(ids[0]).n,0,'no inferred final is emitted');

    const later=accepted(successor.id,'complete a distinct retained duty');
    db.query("UPDATE turns SET status='done',provider_input_acknowledged_at=CURRENT_TIMESTAMP WHERE id=?").run(later.turn_id);
    recipient.reply({session:successor.id,turn:later.turn_id,inputId:later.id},{request_id:ids[0],action_id:'final',text:'Independent duty completed',final:true,workDisposition:effect==='work'?'completed':undefined});
    await origin.dispatch(originRow(ids[0]));
    assert.equal(originRow(ids[0]).outcome,'answered','an exact successor final reply still settles the independent duty');
    await recipient.report(deliveryRow(ids[0]));
    assert.notEqual(deliveryRow(ids[0]).closed_at_ms,null,'the explicit final closes the recipient delivery after origin confirmation');

    recipient.reply({session:successor.id,turn:later.turn_id,inputId:later.id},{request_id:ids[2],action_id:'final-before-origin-poll',text:'Independent duty answered before origin saw handoff',final:true,workDisposition:effect==='work'?'completed':undefined});
    await recipient.report(deliveryRow(ids[2]));
    assert.equal(originRow(ids[2]).outcome,'answered','origin pulls the exact retained final when it first learns of the handoff during notification');
    assert.notEqual(deliveryRow(ids[2]).closed_at_ms,null);
    await recipient.report(deliveryRow(ids[2]));
    assert.equal(db.query("SELECT COUNT(*) n FROM session_peer_events WHERE request_id=? AND kind='final'").get(ids[2]).n,1,'push-first retries record the exact final once');
    for(const id of [ids[0],ids[2]]){
      assert.equal(originRow(id).remote_session_id,`concierge:${predecessor.id}`,'original accepted recipient remains provenance');
      assert.equal(originRow(id).remote_operation_id,`request:${id}`,'original accepted input remains provenance');
      assert.equal(origin.inspect(id).target_session_id,`target:${successor.id}`,'receipt resolves the current custodian');
      const final=db.query("SELECT payload_json FROM session_peer_events WHERE request_id=? AND kind='final'").get(id) as any;
      assert.equal(JSON.parse(final.payload_json).responding_session_id,`target:${successor.id}`,'answer attribution uses authenticated current custody');
    }

    await origin.dispatch(originRow(ids[1]));
    assert.equal(originRow(ids[1]).outcome,null);
    origin.cancel({session:source.id,turn:sourceInput.turn_id,inputId:sourceInput.id},ids[1],`cancel:${terminal}:${effect}`);
    assert.equal(originRow(ids[1]).outcome,'canceled','requester cancellation remains effective');
    await recipient.report(deliveryRow(ids[1]));
    assert.notEqual(deliveryRow(ids[1]).closed_at_ms,null,'explicit requester cancellation closes its exact delivery');

    const ordinary=accepted(successor.id,'ordinary later turn');
    db.query("UPDATE turns SET status=?,agent_text='ordinary attempt ended' WHERE id=?").run(terminal,ordinary.turn_id);
    const ordinaryId=request(successor,ordinary,successor.id,effect);
    assert.equal(recipient.status(ordinaryId).custodyPlacement,undefined,'a successor session alone is not a terminal exemption');
    await origin.dispatch(originRow(ordinaryId));
    assert.equal(originRow(ordinaryId).outcome,terminal==='done'?null:terminal==='error'?'failed':'canceled','ordinary terminal failure keeps existing settlement behavior');
  }
  await retainedPredecessorFinalSurvivesHandoff();
  const custodian=session(),child=session(),childInput=accepted(child.id,'original child request');
  db.query("UPDATE turns SET status='done',provider_input_acknowledged_at=CURRENT_TIMESTAMP WHERE id=?").run(childInput.turn_id);
  const childRequest=request(child,childInput,child.id);
  db.query('UPDATE session_peer_requests SET source_session_id=? WHERE request_id=?').run(custodian.id,childRequest);
  recipient.reply({session:child.id,turn:childInput.turn_id,inputId:childInput.id},{request_id:childRequest,action_id:'late-child-final',text:'Original child finished after custody transfer',final:true,workDisposition:'completed'});
  await recipient.report(deliveryRow(childRequest));
  const childEvent=db.query("SELECT * FROM session_peer_events WHERE request_id=? AND kind='final'").get(childRequest) as any;
  await origin.deliver(childEvent);
  const held=db.query('SELECT * FROM session_peer_events WHERE event_id=?').get(childEvent.event_id) as any;
  assert.equal(held.status,'held','late exact child return is retained when the successor cannot receive it');
  assert.equal(originRow(childRequest).source_session_id,custodian.id,'return resolves the transferred request holder');
  assert.equal(originRow(childRequest).source_input_id,sourceInput.id,'original child request provenance is unchanged');
  assert.equal(db.query("SELECT COUNT(*) n FROM session_peer_events WHERE request_id=? AND kind='final'").get(childRequest).n,1);
  assert.equal(originRow(childRequest).delivery_json,null,'settled child was never placed back into the request send queue');
  const spoofedRequest=request(child,childInput,child.id),spoofedSession=session();
  const spoofed=origin.receiveReply(spoofedRequest,{eventId:randomUUID(),kind:'final',text:'unconfirmed responder',
    responder:{peer:'target',sessionId:`concierge:${spoofedSession.id}`,inputId:childInput.id,runId:nativeRunId(childInput.turn_id!)},
    workDisposition:'completed',settlementProof:{version:1,requestId:spoofedRequest,recipientPeer:'target',targetSessionId:`concierge:${spoofedSession.id}`,unresolvedObligations:0}});
  assert.equal(spoofed.recorded,'pending','an unconfirmed responder assertion is not authority or an irreversible refusal');
  await Promise.all([...origin.tasks.values()]);
  assert.equal(originRow(spoofedRequest).outcome,null);
  assert.equal(db.query('SELECT COUNT(*) n FROM session_peer_events WHERE request_id=?').get(spoofedRequest).n,0,'the unconfirmed assertion records no answer');
  assert.equal(origin.inspect(spoofedRequest).target_session_id,`target:${child.id}`,'exact status leaves the authentic current recipient unchanged');
  console.log('custody peer fixture passed: actual status/reply/notification consumers; retained predecessor final delivered once by pull and by push after the actual recovery handoff, with outsider and former-holder negative controls; informational/work error, human Stop and success; push-first/poll-first exact finals; original acceptance provenance; late child return held for successor without resend');
}finally{lab.stop();db.close();rmSync(scratch,{recursive:true,force:true});}
