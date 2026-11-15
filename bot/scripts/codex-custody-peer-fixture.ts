import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'codex-custody-peer-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION;
const {db}=await import('../src/state');
const {createNativeSession,retainSessionInput,enqueueSessionInput,nativeRunId,updateSessionMetadata}=await import('../src/session-inputs');
const {SessionPeers}=await import('../src/session-peers');
const session=()=>createNativeSession('codex',{cwd:scratch,purpose:'chat',title:'Peer preservation fixture',summary:undefined});
const accepted=(sessionId:number,text:string)=>enqueueSessionInput(retainSessionInput({sessionId,scope:'fixture',actionId:randomUUID(),kind:'input',origin:'agent',payload:{text}}).input.id);
const source=session(),sourceInput=accepted(source.id,'ask');
db.query("UPDATE turns SET status='done' WHERE id=?").run(sourceInput.turn_id);
let origin:any,recipient:any;
const owner={executionState:()=> 'idle',view:()=>({execution:'idle'}),canSend:()=>false,attachments:()=>[],admit:()=>{},dispatch:()=>{throw new Error('unexpected dispatch');}};
const targetClient={request:async(method:string,path:string)=>{
  const id=decodeURIComponent(path.split('/')[5]!);
  if(method==='POST'&&path.endsWith('/cancel'))return recipient.canceledByOrigin(id);
  assert.equal(method,'GET');
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
function request(target:any,placement:any,remoteId:number,effect:'work'|'informational'='work'){
  const id=randomUUID();
  db.query(`INSERT INTO session_peer_deliveries(request_id,peer,origin_session_id,origin_input_id,origin_run_id,target_session_id,target_input_id,requested_effect,origin_provenance_json,created_at_ms)
    VALUES(?,'origin',?,?,?,?,?,?,'{"answerGuaranteeVersion":1}',?)`).run(id,`concierge:${source.id}`,sourceInput.id,nativeRunId(sourceInput.turn_id!),target.id,placement.id,effect,Date.now());
  db.query(`INSERT INTO session_peer_requests(request_id,peer,source_session_id,source_turn_id,source_input_id,action_id,payload_json,payload_hash,remote_session_id,remote_address,remote_operation_id,status,due_at_ms,created_at_ms)
    VALUES(?,'target',?,?,?,?,?,'fixture',?,?,?,'admitted',?,?)`).run(id,source.id,sourceInput.turn_id,sourceInput.id,id,JSON.stringify({answerGuaranteeVersion:1,requestedEffect:effect}),`concierge:${remoteId}`,'session:fixture',`request:${id}`,Date.now()+60_000,Date.now());
  return id;
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
  console.log('custody peer fixture passed: actual status/reply/notification consumers; informational/work error, human Stop and success; push-first/poll-first exact finals; original acceptance provenance; late child return held for successor without resend');
}finally{db.close();rmSync(scratch,{recursive:true,force:true});}
